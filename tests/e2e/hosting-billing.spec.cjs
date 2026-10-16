const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
async function seed(page, workspaceId = 'usage-workspace-a') {
  // Let initial settings/auth recovery finish before selecting the synthetic workspace.
  await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')) && window.Alpine.store('chat').routeSyncPaused === false);
  await page.evaluate(async workspaceId => {
    const s = window.Alpine.store('chat');
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.stopBackgroundSync(); s.scheduleBackgroundSync = () => {}; s.syncRoute = () => {};
    s.startWorkspaceLiveQueries = () => {}; s.ensureBackgroundSync = () => {}; s.refreshStatusRecentChanges = () => {};
    s.scheduleStorageImageHydration = () => {};
    // Keep unrelated section hydration out of this command-read fixture.
    s.requestTowerSyncFamily = async () => [];
    s.ensureWorkspaceSessionKey = async () => {};
    s.updateWorkspaceBootstrapPrompt = () => false;
    s.ensurePgWorkspaceAvailable = async workspace => workspace;
    s.loadLocalWorkspaceCoreData = async () => {};
    s.refreshWorkspaceSettings = async () => {};
    s.refreshLegacyWorkspaceRecovery = async () => {};
    s.persistWorkspaceSettings = async () => {};
    s.session = { npub: 'synthetic-usage-viewer' }; s.workspaceDbKey = workspaceId; s.selectedWorkspaceKey = workspaceId;
    s.knownWorkspaces = [{ workspaceKey: workspaceId, workspaceId, name: workspaceId, label: workspaceId,
      workspaceOwnerNpub: 'synthetic-owner', towerServiceNpub: 'synthetic-tower', workspaceServiceNpub: workspaceId,
      pgBackendMode: true, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'synthetic-usage-app',
      pgMe: { actor: { actor_id: 'usage-viewer', npub: 'synthetic-usage-viewer' } } }];
    // Use the production selection path to open the synthetic partition in Dexie.
    // Remote verification/sync is stubbed above; the selected usage read is exercised below.
    await s.selectWorkspace(workspaceId, { skipPgVerification: true, refresh: false });
    s.scopes = [{ record_id: 'usage-scope', title: 'Usage scope' }];
    s.navSection = 'status'; s.navCollapsed = true; s.mobileNavOpen = false;
    // Synthetic extension credentials sign the exact production request URL. The narrow
    // intercepted route owns responses; this is not evidence of live authentication.
    const pubkey = '1'.repeat(64);
    localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'extension', pubkey, createdAt: Date.now(), expiresAt: Date.now() + 600_000 }));
    window.nostr = { getPublicKey: async () => pubkey, signEvent: async event => ({ ...event, pubkey, id: '2'.repeat(64), sig: '3'.repeat(128) }) };
  }, workspaceId);
}

for (const width of [1280, 390]) {
  test(`hosting balance materialization, errors and test Checkout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let configured = false, denied = false; const checkoutBodies = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.includes('/api/v4/hosting-billing/workspaces/')) {
        const op = url.pathname.split('/').at(-1), workspace = url.pathname.split('/').at(-2);
        const headers = request.headers(); expect(headers.authorization).toMatch(/^Nostr /);
        if (op === 'checkout') {
          checkoutBodies.push(JSON.parse(request.postData()));
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'stripe_unconfigured', code: 'stripe_unconfigured' }) });
        }
        if (denied) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Billing permission revoked' }) });
        const status = { version: 1, workspace_id: workspace, account_id: 'fixture-account', billing_mode: 'usd_prepaid', currency: 'USD',
          balance_usd: '5.000000000000', promo_usd: '5', paid_usd: '0', promo_expires_at: '2026-11-01T00:00:00Z', billing_state: 'active',
          hourly_burn_usd: '0.006944444444', estimated_runout_at: null, can_top_up: true, stripe: { configured, mode: 'test', live_rollout_blocked: true } };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(op === 'status' ? status : { workspace_id: workspace, account_id: 'fixture-account', entries: [] }) });
      }
      if (url.pathname.endsWith('/storage-usage')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/'); await seed(page);
    await page.evaluate(() => window.Alpine.store('chat').openTowerUsage());
    const panel = page.getByTestId('hosting-billing');
    await expect(panel.getByText('Shared customer balance:')).toContainText('$5.00 USD');
    await expect(panel.getByText('Welcome credit:')).toContainText('expires');
    await expect(panel.getByText('Hourly burn:')).toContainText('$0.00694444 USD');
    await expect(panel.getByRole('button', { name: 'Stripe top-up (test mode)' })).toBeDisabled();
    await expect(panel.getByText('Stripe is not configured on this Tower. No payment has been taken.')).toBeVisible();
    configured = true; await panel.getByRole('button', { name: 'Refresh billing' }).click();
    const topup = panel.getByRole('button', { name: 'Stripe top-up (test mode)' }); await expect(topup).toBeEnabled();
    await topup.click(); await expect(panel.getByRole('alert')).toContainText('stripe_unconfigured');
    await topup.click(); await expect.poll(() => checkoutBodies.length).toBe(2);
    expect(checkoutBodies[0].amount_cents).toBe(1000); expect(checkoutBodies[0].idempotency_key).toBe(checkoutBodies[1].idempotency_key);
    expect(checkoutBodies[0].return_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    denied = true; await panel.getByRole('button', { name: 'Refresh billing' }).click();
    await expect(panel.getByRole('alert')).toContainText('Billing permission revoked');
    await expect(panel.getByText('Shared customer balance:')).toHaveCount(0);
    // Same narrow pre-existing hidden WApp-editor null errors as the Tower Usage fixture.
    const unrelated = /^Cannot read properties of null \(reading '(delegate_actor_id|expires_at|app_ids|installation_ids|scope_ids|channel_ids|open_origins|autopilot_origins|activity_publish|app_version|wapp_installation_id|launch_url)'\)$/;
    console.log('HOSTING_BROWSER_SMOKE', JSON.stringify({ width, checkoutRetries: checkoutBodies.length, knownUnrelatedWappErrors: errors.filter(e => unrelated.test(e)).length }));
    expect(errors.filter(e => !unrelated.test(e))).toEqual([]);
  });
}
