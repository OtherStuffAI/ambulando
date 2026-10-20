const { test, expect } = require('playwright/test');
const { nip19 } = require('nostr-tools');

const towerNpub = nip19.npubEncode('11'.repeat(32));
const workspaceServiceNpub = nip19.npubEncode('22'.repeat(32));
const ownerNpub = nip19.npubEncode('33'.repeat(32));

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL).origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
});

test('late NBrowser discovery imports a selected real descriptor and revocation preserves it', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(({ towerNpub, workspaceServiceNpub, ownerNpub }) => {
    const store = window.Alpine.store('chat');
    store.session = { npub: ownerNpub };
    store.showConnectModal = true;
    store.connectStep = 1;
    window.__nstackConsentRequests = [];
    window.__nstackChange = null;
    window.NStack = Object.freeze({
      version: 1,
      isAvailable: async () => ({ available: true, version: 1 }),
      requestDiscovery: async (options) => {
        window.__nstackConsentRequests.push(options);
        return { disclosed: 1, workspaces: true };
      },
      listNStacks: async () => [{
        id: 'opaque-stack', name: 'Home NStack', url: 'https://tower.example',
        serviceNpub: towerNpub, available: true,
      }],
      listWorkspaces: async () => [1, 2].map((number) => ({
        id: `opaque-workspace-${number}`,
        name: `Workspace ${number}`,
        workspaceId: `real-workspace-${number}`,
        workspaceOwnerNpub: ownerNpub,
        workspaceServiceNpub,
        directHttpsUrl: 'https://tower.example',
        serviceNpub: towerNpub,
      })),
      getConnection: async ({ stackId, workspaceId }) => {
        window.__nstackConnectionRequest = { stackId, workspaceId };
        const number = Number(workspaceId.split('-').at(-1));
        return {
          id: workspaceId,
          name: `Workspace ${number}`,
          workspaceId: `real-workspace-${number}`,
          workspaceOwnerNpub: ownerNpub,
          workspaceServiceNpub,
          directHttpsUrl: 'https://tower.example',
          serviceNpub: towerNpub,
          nstack: { id: stackId, name: 'Home NStack', url: 'https://tower.example' },
        };
      },
      revoke: async () => true,
      on: (_name, handler) => { window.__nstackChange = handler; return () => {}; },
    });
    store.connectWithPgDescriptor = async (descriptor) => {
      window.__importedNStackDescriptor = descriptor;
      store.knownWorkspaces = [{
        workspaceKey: `verified:${descriptor.identity.workspace_id}`,
        workspaceId: descriptor.identity.workspace_id,
        name: descriptor.label,
        pgBackendMode: true,
      }];
      store.showConnectModal = false;
    };
    store.initializeNStackConnection({ timeoutMs: 500, pollIntervalMs: 10 });
  }, { towerNpub, workspaceServiceNpub, ownerNpub });

  const card = page.getByTestId('connect-nstack-card');
  await expect(card).toBeVisible();
  await card.getByTestId('connect-nstack-discover').click();
  const rows = card.getByTestId('connect-nstack-workspace');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Workspace 2');
  await rows.nth(1).click();

  await expect(page.locator('.connect-modal')).toBeHidden();
  const result = await page.evaluate(() => ({
    descriptor: window.__importedNStackDescriptor,
    consent: window.__nstackConsentRequests,
    resolved: window.__nstackConnectionRequest,
    saved: window.Alpine.store('chat').knownWorkspaces,
  }));
  expect(result.consent).toEqual([{ workspaces: true }]);
  expect(result.resolved).toEqual({ stackId: 'opaque-stack', workspaceId: 'opaque-workspace-2' });
  expect(result.descriptor.identity.workspace_id).toBe('real-workspace-2');
  expect(JSON.stringify(result.descriptor)).not.toContain('opaque-workspace-2');
  expect(result.saved[0].workspaceId).toBe('real-workspace-2');

  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.showConnectModal = true;
    window.__nstackChange({ reason: 'revoked' });
  });
  await expect(card).toContainText('verified saved workspace was not changed');
  expect(await page.evaluate(() => window.Alpine.store('chat').knownWorkspaces[0].workspaceId))
    .toBe('real-workspace-2');
});

test('ordinary manual Tower setup stays usable without NBrowser', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.session = { npub: 'npub1manual' };
    store.showConnectModal = true;
    store.connectStep = 1;
    store.nstackProviderState = 'unavailable';
  });

  await expect(page.getByTestId('connect-nstack-card')).toBeHidden();
  const manual = page.getByLabel('Tower URL or workspace descriptor');
  await expect(manual).toBeVisible();
  await manual.fill('https://tower.example');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
});
