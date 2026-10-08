const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { mkdirSync } = require('node:fs');

function snapshot(workspaceId, bytes = 1024) {
  return { workspace_id: workspaceId, collected_at: '2026-10-07T08:00:00Z', total_bytes: bytes + 512,
    cache_ttl_seconds: 60, coverage: 'partial', total_description: 'Incomplete coverage: graph and external stores excluded. Includes logical estimates.', categories: [
      { id: 'objects', label: 'S3 / object storage', bytes, status: 'partial', measurement: 'registered_bytes', reason: 'Completed linked object bytes; unlinked uploads excluded.' },
      { id: 'database', label: 'Database', bytes: 512, status: 'partial', measurement: 'logical_estimate', reason: 'Direct workspace row estimate; disk overhead excluded.' },
      ...[['graph', 'Graph'], ['git', 'Git / Forgejo'], ['grasp', 'GRASP'], ['other', 'Other stores']].map(([id, label]) => ({ id, label, bytes: null, status: 'unavailable', measurement: 'unavailable', reason: 'No supported workspace byte provider.' })),
    ] };
}
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
  test('Apps stack usage launcher, states, refresh and workspace switching at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let status = 200, requests = [], release;
    let blockNext = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/storage-usage')) {
        const id = url.pathname.split('/').at(-2); requests.push(id);
        if (blockNext) { blockNext = false; await new Promise(resolve => { release = resolve; setTimeout(resolve, 5000); }); }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? snapshot(id, id.endsWith('b') ? 8192 : 1024) : {}) });
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/'); await seed(page);
    const launch = page.getByTestId('tower-usage-launch');
    for (const section of ['toolbox', 'tasks', 'docs', 'chat', 'files', 'agents', 'context', 'settings', 'status']) {
      await page.evaluate(section => { window.Alpine.store('chat').navSection = section; }, section);
      await expect(page.getByRole('navigation', { name: 'Global toolbox' })).toHaveCount(0);
      await expect(page.getByTestId('global-toolbox')).toHaveCount(0);
    }
    // Synthetic credentials bypass onboarding; boot recovery may finish after seeding.
    await page.evaluate(() => { window.Alpine.store('chat').showConnectModal = false; });
    if (width === 390) await page.getByRole('button', { name: 'Show Hello and Links', exact: true }).evaluate(button => button.click());
    const stack = page.getByRole('button', { name: 'Open Apps stack', exact: true });
    await expect(stack).toBeVisible();
    await stack.click({ timeout: 10000 });
    await expect(launch).toBeVisible();
    expect(requests).toHaveLength(0);
    // Opening loads once; rendering/idle does not recursively collect.
    blockNext = true; await launch.click();
    const dialog = page.getByTestId('tower-usage-dialog');
    await expect(dialog).toBeVisible(); await expect(dialog.getByText('Collecting workspace usage…')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh usage' })).toBeDisabled();
    await expect.poll(() => typeof release).toBe('function'); release();
    await expect(dialog.getByText('1 KiB', { exact: true })).toBeVisible();
    await expect(dialog.getByText('1.5 KiB', { exact: true })).toBeVisible();
    await expect(dialog.locator('dd span:visible')).toHaveText(' · Logical estimate');
    for (const label of ['S3 / object storage', 'Database', 'Graph', 'Git / Forgejo', 'GRASP', 'Other stores']) await expect(dialog.locator('dt').getByText(label, { exact: true })).toBeVisible();
    await expect(dialog.locator('time')).not.toHaveText('Not collected');
    await page.waitForTimeout(250); expect(requests).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Refresh usage' }).click(); await expect.poll(() => requests.length).toBe(2);
    // Native modality and shared controls, including no fabricated history.
    expect(await dialog.evaluate(el => el.tagName === 'DIALOG' && el.matches(':modal'))).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Back in napplet history' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Forward in napplet history' })).toBeDisabled();
    const modalWidth = await dialog.evaluate(el => el.getBoundingClientRect().width);
    const beforeExpand = requests.length;
    await dialog.getByRole('button', { name: 'Expand Tower Usage', exact: true }).click(); await expect(dialog).toHaveClass(/thread-full/);
    await page.waitForTimeout(250);
    await expect.poll(() => dialog.evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(width - 24, 0);
    if (width === 1280) expect(modalWidth).toBeCloseTo(width * 2 / 3, 0);
    expect(requests.length).toBe(beforeExpand);
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click(); await expect(dialog.getByRole('menuitem', { name: 'Refresh', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('menu')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Tower Usage menu', exact: true })).toBeFocused();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click(); await dialog.getByRole('menuitem', { name: 'Collapse to modal' }).click();
    await expect(dialog).not.toHaveClass(/thread-full/);
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click(); await dialog.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => requests.length).toBe(beforeExpand + 1);
    await expect(dialog.getByRole('menu')).toBeHidden();
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close Tower Usage', exact: true }).focus();
    await expect(dialog.getByRole('menu')).toBeHidden();
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click();
    await dialog.locator('.tower-usage-total').click();
    await expect(dialog.getByRole('menu')).toBeHidden();
    // A delayed old-workspace reply must never become visible after switching.
    blockNext = true; release = null; await dialog.getByRole('button', { name: 'Refresh usage' }).click();
    await expect.poll(() => typeof release).toBe('function');
    await seed(page, 'usage-workspace-b'); release();
    await expect(dialog.getByText('8 KiB', { exact: true })).toBeVisible();
    await expect(dialog.getByText('1 KiB', { exact: true })).toHaveCount(0);
    status = 403; await dialog.getByRole('button', { name: 'Refresh usage' }).click();
    await expect(dialog.getByRole('alert')).toContainText('management permission');
    await expect(dialog.locator('dd > strong').filter({ hasText: 'Unavailable' })).toHaveCount(6);
    status = 503; await dialog.getByRole('button', { name: 'Refresh usage' }).click();
    await expect(dialog.getByRole('alert')).toContainText('unavailable');
    // Focus is trapped, Escape closes and focus returns to the Apps stack.
    await dialog.getByRole('button', { name: 'Refresh usage' }).focus(); await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Tower Usage menu', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(stack).toBeFocused();
    mkdirSync('tmp/docs/handoffs/tower-usage-popup', { recursive: true });
    status = 200; await stack.click(); await launch.click(); await expect(dialog.getByText('8 KiB', { exact: true })).toBeVisible();
    await dialog.locator('.tower-usage-content').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `tmp/docs/handoffs/tower-usage-popup/usage-${width}.png` });
    await dialog.getByRole('button', { name: 'Expand Tower Usage', exact: true }).click(); await page.waitForTimeout(250);
    await page.screenshot({ path: `tmp/docs/handoffs/tower-usage-popup/usage-full-${width}.png` });
    await dialog.getByRole('button', { name: 'Tower Usage menu', exact: true }).click(); await dialog.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden(); await expect(stack).toBeFocused();
    await stack.click(); await launch.click();
    await expect(dialog).not.toHaveClass(/thread-full/);
    await dialog.getByRole('button', { name: 'Close Tower Usage', exact: true }).click();
    await expect(stack).toBeFocused();
    await stack.click(); await launch.click();
    await dialog.evaluate(el => el.close());
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').towerUsageOpen)).toBe(false);
    await expect(stack).toBeFocused();
    await stack.click(); await launch.click();
    await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden(); await expect(stack).toBeFocused();
    await stack.click(); await launch.click();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').towerUsageSnapshot)).toBeNull();
    const unexpected = errors.filter(message => !/^Cannot read properties of null \(reading '(delegate_actor_id|expires_at|app_ids|installation_ids|scope_ids|channel_ids|open_origins|autopilot_origins|activity_publish|app_version|wapp_installation_id|launch_url)'\)$/.test(message)
      && message !== 'No Nostr session available for NIP-98 auth.');
    expect(unexpected).toEqual([]);
    console.log('TOWER_USAGE_SMOKE', JSON.stringify({ width, requests, sectionsWithoutGlobalBar: 9, switching: true, focus: true }));
  });
}
