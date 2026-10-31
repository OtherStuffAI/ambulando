const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
const modalStart = source.indexOf('  <div class="modal-overlay" x-show="$store.chat.showAgentConnectModal"');
const modal = source.slice(modalStart, source.indexOf('  <!-- @mention', modalStart));
const { test, expect } = require('playwright/test');
const { generateSecretKey, getPublicKey, finalizeEvent, nip19 } = require('nostr-tools');
const { createHash } = require('node:crypto');

for (const mode of ['available', 'no-agents', 'missing-app', 'offline', 'declined']) {
  test(`nStack agent setup UI: ${mode}`, async ({ page, baseURL }) => {
    test.setTimeout(60000);

    const secret = generateSecretKey(), pubkey = getPublicKey(secret), npub = nip19.npubEncode(pubkey);
    const installation = `autopilot_${createHash('sha256').update(pubkey).digest('hex').slice(0, 32)}`;
    const bundle = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
      define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(npub) }, stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
        import Alpine from 'alpinejs';
        import { agentSpaceManagerMixin } from './src/agent-space-manager.js';
        import { storeCredentials } from './src/auth/secure-store.js';
        import { setMemorySecret } from './src/auth/nostr.js';
        import { getPublicKey, nip19 } from 'nostr-tools';
        window.setupFixture = async bytes => {
          const secret = new Uint8Array(bytes), pubkey = getPublicKey(secret), npub = nip19.npubEncode(pubkey);
          await storeCredentials({ method: 'ephemeral', pubkey }); setMemorySecret(secret);
          const store = { ...agentSpaceManagerMixin, session: { npub }, backendUrl: 'https://stack.fixture', showAgentConnectModal: false,
            openAgentSpace(id) { window.fixtureInstalledAgent = id; },
            currentWorkspace: { workspaceId: '10000000-0000-4000-8000-000000000001', appNpub: npub, workspaceOwnerNpub: npub, directHttpsUrl: 'https://stack.fixture' } };
          Alpine.store('chat', store); window.Alpine = Alpine; Alpine.start(); Alpine.store('chat').openAgentConnectModal();
        };` } });
    const origin = new URL(baseURL).origin;
    const requests = [];
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html', body: url.pathname.endsWith('.js') ? bundle.outputFiles[0].text : `<style>[x-cloak]{display:none!important}</style><main x-data>${modal}</main><script type="module" src="/setup-fixture.js"></script>` });
      if (!['stack.fixture', 'agents.fixture'].includes(url.hostname)) return route.abort();
      requests.push({ url: url.href, method: request.method(), authorization: request.headers().authorization });
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'POST' && url.pathname.endsWith('/autopilot-connections')) return json({ autopilot_connection: { id: '50000000-0000-4000-8000-000000000001', ...request.postDataJSON() } });
      if (request.method() === 'POST' && url.pathname.endsWith('/workspace-agents')) return json({ workspace_agent: { id: '50000000-0000-4000-8000-000000000002', ...request.postDataJSON() } });
      if (url.pathname === '/.well-known/nstack.json') return json({ schema: 'org.wingman.nstack.services', schema_version: 1, services: [
        { kind: 'tower', endpoint: 'https://stack.fixture' }, { kind: 'autopilot', endpoint: 'https://agents.fixture' },
      ] });
      if (url.pathname.endsWith('/app-registration')) {
        return json({ identity: { workspace_id: '10000000-0000-4000-8000-000000000001', workspace_owner_npub: npub, app_npub: npub }, registration: { installed: mode !== 'missing-app', enabled: mode !== 'missing-app', app_npub: npub } });
      }
      if (mode === 'offline') return route.fulfill({ status: 503, body: '{}' });
      if (mode === 'declined') return route.fulfill({ status: 403, body: '{}' });
      if (url.pathname.endsWith('/health')) return json({ ok: true, api_version: 1, installation_id: installation, installation_npub: npub });
      if (url.pathname.endsWith('/agents')) return json({ installation_id: installation, agents: mode === 'no-agents' ? [] : [{ agent_id: 'local-fixture-agent', bot_npub: npub,
        name: 'Fixture Agent', description: 'Synthetic local agent', can_instruct: true,
        paths: Object.fromEntries(['overview', 'pipelines', 'schedules', 'triggers'].map(key => [key, `/api/owners/${npub}/control-plane/v1/agents/local-fixture-agent/${key}`])) }] });
      return route.abort();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.setupFixture));
    await page.evaluate(bytes => window.setupFixture(bytes), [...secret]);
    await expect(page.getByLabel('Agent nStack HTTPS address')).toHaveValue('https://stack.fixture');
    await page.getByRole('button', { name: 'Discover available agents', exact: true }).click();
    if (mode === 'available') {
      await expect(page.locator('.agent-connect-selection')).toContainText('Fixture Agent');
      await expect(page.getByRole('button', { name: 'Add selected agents over HTTPS' })).toBeDisabled();
      await page.locator('.agent-connect-selection input').check();
      await expect(page.getByRole('button', { name: 'Add selected agents over HTTPS' })).toBeEnabled();
      await page.getByRole('button', { name: 'Add selected agents over HTTPS' }).click();
      await expect(page.getByTestId('agent-connect-modal')).toBeHidden();
      expect(await page.evaluate(() => window.fixtureInstalledAgent)).toBe('50000000-0000-4000-8000-000000000002');
    } else {
      const message = { 'no-agents': 'No available agents', 'missing-app': 'not registered and enabled', offline: 'unavailable (HTTP 503)', declined: 'cannot access this workspace or service' }[mode];
      await expect(page.getByTestId('agent-connect-modal')).toContainText(message);
    }
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(mode === 'available' ? 2 : 0);
    expect(requests.some(request => /messages|instructions/.test(request.url))).toBe(false);
    expect(requests.filter(request => !request.url.endsWith('/nstack.json')).every(request => request.authorization?.startsWith('Nostr '))).toBe(true);
  });
}

test('full app opens only the agent setup dialog', async ({ page }) => {
  const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.backendUrl = 'https://stack.fixture';
    store.openAgentConnectModal();
  });
  await expect(page.getByTestId('agent-connect-modal')).toBeVisible();
  await expect(page.getByLabel('Agent nStack HTTPS address')).toBeVisible();
  expect(await page.evaluate(() => window.Alpine.store('chat').showAgentConfigModal)).toBe(false);
  await page.getByTestId('agent-connect-modal').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('agent-connect-modal')).toBeHidden();
});
