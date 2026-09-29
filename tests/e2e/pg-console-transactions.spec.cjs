const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Execute the real materialization worker and IndexedDB at a loopback origin.
// All probe URLs are fulfilled in memory; this never contacts a Tower or
// starts a second app runtime.
test('publishes eight staged PG pages in the real worker without losing transaction authority', async ({ page, baseURL }) => {
  const workerBundle = await build({
    entryPoints: [path.resolve(__dirname, '../../src/worker/tower-pg-materialization-worker.js')],
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
  });
  const origin = new URL(baseURL).origin;
  await page.route(`${origin}/__pg-console-probe`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PG transaction probe</title>' }));
  await page.route(`${origin}/__pg-console-worker.js`, route => route.fulfill({ contentType: 'text/javascript', body: workerBundle.outputFiles[0].text }));
  await page.goto(`${origin}/__pg-console-probe`);
  const result = await page.evaluate(async ({ fixture, origin }) => {
    const worker = new Worker(`${origin}/__pg-console-worker.js`, { type: 'module' });
    let id = 0;
    const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
    const store = { session: { npub: 'npub1viewer' }, backendUrl: 'http://127.0.0.1:3100',
      currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner', appNpub: 'npub1test', pgBackendMode: true } };
    const workspaceKey = `transaction-probe-${crypto.randomUUID()}`;
    const send = bundle => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.ok ? resolve(data.value) : reject(new Error(JSON.stringify(data.error)));
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ type: 'tower-pg-materializer:request', id: ++id, workspaceKey,
        workspaceDbKey: workspaceKey, store, bundle });
    });
    try {
      let cursor = null;
      for (let index = 0; index < 8; index++) {
        const changes = Array.from({ length: 200 }, (_, offset) => {
          const change = fixture.one_message_delta.changes[0];
          const messageId = `message-${index}-${offset}`;
          return { ...change, id: messageId, row: { ...change.row, id: messageId } };
        });
        const page = await send({ ...fixture.canonical_upserts, actors: [], changes,
          next_cursor: `snapshot-${index}`, has_more: true, snapshot_complete: index === 7,
          local_apply_options: { stageSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
        if (!page.staged || page.applied !== 0) throw new Error('Snapshot published before handover');
        cursor = page.cursor;
      }
      const published = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { stageSnapshot: true, expectedCursor: cursor, expectedGeneration: 0 } });
      const replay = await send({ ...fixture.one_message_delta, changes: [], next_cursor: 'handover', has_more: false,
        local_apply_options: { expectedCursor: 'handover', expectedGeneration: 0 } });
      return { published, replay };
    } finally {
      worker.terminate();
      indexedDB.deleteDatabase(`wingman-fd-ws-${workspaceKey}`);
    }
  }, { fixture, origin });
  expect(result.published).toMatchObject({ applied: 1600, cursor: 'handover', hasMore: false });
  expect(result.replay).toMatchObject({ applied: 0, cursor: 'handover' });
});
