const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');

test('real browser retries signed reads against controlled local transport without replaying writes', async ({ page, baseURL }) => {
  const bundle = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
      export { openWorkspaceDb, upsertResourceViewState, getResourceViewStates } from './src/db.js';
      export { unreadStoreMixin } from './src/unread-store.js';
      export { storeCredentials } from './src/auth/secure-store.js';
      export { setMemorySecret } from './src/auth/nostr.js';
      export { generateSecretKey, getPublicKey } from 'nostr-tools';` } });
  const origin = new URL(baseURL).origin;
  const requests = [];
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: request.method(), authorization: request.headers().authorization });
      return route.fulfill({ status: requests.length === 1 ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify({ states: [], has_more: false }) });
    }
    return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html',
      body: url.pathname.endsWith('.js') ? bundle.outputFiles[0].text : '<title>Local connection recovery probe</title>' });
  });
  await page.goto(`${origin}/__connection-probe`);
  const result = await page.evaluate(async () => {
    const m = await import('/__connection-probe.js');
    const secret = m.generateSecretKey();
    await m.storeCredentials({ method: 'ephemeral', pubkey: m.getPublicKey(secret) });
    m.setMemorySecret(secret);
    const db = m.openWorkspaceDb('connection-probe'); await db.open();
    await m.upsertResourceViewState({ record_id: 'thread:cached', resource_type: 'thread', resource_id: 'cached',
      activity_version: 2, viewed_activity_version: 1, sync_status: 'pending' });
    const store = { ...m.unreadStoreMixin, session: { npub: 'synthetic-viewer' },
      currentWorkspace: { workspaceId: 'synthetic-workspace', directHttpsUrl: location.origin },
      towerViewStateConnectionFailed: true };
    const first = store.refreshTowerPgResourceViewStates({ readOnly: true });
    const coalesced = first === store.refreshTowerPgResourceViewStates({ readOnly: true });
    await first;
    const rows = await m.getResourceViewStates();
    await db.delete();
    return { coalesced, failed: store.towerViewStateConnectionFailed, rows };
  });
  expect(result.coalesced).toBe(true);
  expect(result.failed).toBe(false);
  expect(result.rows).toEqual([expect.objectContaining({ resource_id: 'cached', sync_status: 'pending' })]);
  expect(requests).toHaveLength(2);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  const events = requests.map(request => JSON.parse(Buffer.from(request.authorization.slice(6), 'base64').toString()));
  expect(events[0].id).not.toBe(events[1].id);
});
