const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// Built-client smoke with local fixtures. No remote Tower or WApp authentication.
async function seed(page, workspace = 'toolbox-workspace-a') {
  await page.waitForFunction(() => !!window.Alpine?.store('chat'));
  await page.evaluate(workspace => {
    const s = window.Alpine.store('chat');
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'synthetic-toolbox-reader' };
    s.workspaceDbKey = workspace; s.selectedWorkspaceKey = workspace;
    s.knownWorkspaces = [{ workspaceKey: workspace, workspaceId: workspace,
      workspaceOwnerNpub: 'synthetic-owner', towerServiceNpub: 'synthetic-tower',
      workspaceServiceNpub: 'synthetic-service', pgBackendMode: true,
      directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'synthetic-app',
      pgMe: { actor: { actor_id: 'reader', npub: 'synthetic-toolbox-reader' } } }];
    s.wapps = [
      { record_id: 'artifacts', title: "Sample Artifacts", launch_url: 'http://127.0.0.1:3100/synthetic-wapp',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'reader' },
      { record_id: 'other-owner', title: 'Private app', launch_url: 'http://127.0.0.1:3100/private',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'other' },
      { record_id: 'archived', title: 'Archived app', launch_url: 'http://127.0.0.1:3100/archive',
        pg_backend: true, pg_record_type: 'personal_wapp', owner_actor_id: 'reader', record_state: 'archived' },
    ];
    s.startWorkspaceLiveQueries = () => {};
    s.ensureBackgroundSync = () => {};
    s.refreshStatusRecentChanges = () => {};
    s.startSharedLiveQueries();
    s.navSection = 'status';
  }, workspace);
}
async function openToolbox(page, mobile) {
  if (mobile) await page.evaluate(() => { window.Alpine.store('chat').mobileNavOpen = true; });
  const nav = page.locator('.sidebar').getByRole('button', { name: 'Toolbox', exact: true });
  await nav.focus(); await nav.press('Enter');
  await expect(page.getByTestId('toolbox-page')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toolbox', exact: true })).toHaveAttribute('aria-current', 'page');
}
for (const width of [1280, 390]) {
  test('Toolbox placement, reload, workspace isolation and both Apps launches at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto('/'); await seed(page);
    if (width === 390) await page.getByRole('button', { name: 'Show Hello and Links', exact: true }).evaluate(button => button.click());
    await expect(page.getByTestId('apps-stack')).toBeVisible();
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    await expect(page.getByTestId('message-activity-launch')).toBeVisible();
    await expect(page.getByTestId('app-launch')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Toolbox', exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-label="My Agents"]')).toBeVisible();
    await page.evaluate(() => { window.Alpine.store('chat').closePersonalWappsOverlay(); });
    await openToolbox(page, width === 390);
    const napplet = page.getByRole('checkbox', { name: 'Show Message activity in Apps', exact: true });
    const wapp = page.getByRole('checkbox', { name: "Show Sample Artifacts in Apps", exact: true });
    await expect(napplet).toBeChecked(); await expect(wapp).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Show (Private|Archived) app in Apps/ })).toHaveCount(0);
    await napplet.uncheck(); await expect(page.getByText('Placement saved.', { exact: true })).toBeVisible();
    await wapp.uncheck();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').visibleApps.length)).toBe(0);
    await page.reload(); await seed(page); await openToolbox(page, width === 390);
    await expect(napplet).not.toBeChecked(); await expect(wapp).not.toBeChecked();
    await seed(page, 'toolbox-workspace-b'); await openToolbox(page, width === 390);
    await expect(napplet).toBeChecked(); await expect(wapp).toBeChecked();
    await seed(page, 'toolbox-workspace-a'); await openToolbox(page, width === 390);
    await expect(napplet).not.toBeChecked(); await expect(wapp).not.toBeChecked();
    await napplet.check(); await expect(napplet).toBeEnabled();
    await wapp.check(); await expect(wapp).toBeEnabled();
    await page.screenshot({ path: 'tmp/docs/handoffs/toolbox-' + width + '.png' });
    await page.evaluate(() => window.Alpine.store('chat').navigateTo('status'));
    if (width === 390) await page.getByRole('button', { name: 'Show Hello and Links', exact: true }).evaluate(button => button.click());
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    await page.getByTestId('message-activity-launch').click();
    await expect(page.getByRole('dialog', { name: 'Message activity', exact: true })).toBeVisible();
    await expect(page.locator('#message-activity-modal iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    // Fixture has no authorized aggregate backend: actual sandbox shows its useful error.
    await expect(page.frameLocator('#message-activity-modal iframe').getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Close Message activity', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Apps stack', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Open Apps stack', exact: true }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: "Open Sample Artifacts", exact: true }).click();
    const appPage = await popup; await expect(appPage).toHaveURL('http://127.0.0.1:3100/synthetic-wapp');
    expect(await appPage.evaluate(() => window.opener)).toBeNull(); await appPage.close();
    // Existing hidden WApp-management x-models dereference null drafts at boot.
    // Report that baseline separately; no new Toolbox/launcher errors are accepted.
    const knownBootError = /^Cannot read properties of null \(reading '(delegate_actor_id|expires_at|app_ids|installation_ids|scope_ids|channel_ids|open_origins|autopilot_origins|activity_publish|app_version|wapp_installation_id|launch_url)'\)$/;
    const fixtureAuthError = message => message === 'No Nostr session available for NIP-98 auth.';
    expect(errors.filter(message => !knownBootError.test(message) && !fixtureAuthError(message))).toEqual([]);
    console.log('TOOLBOX_SMOKE', JSON.stringify({ width,
      knownBootErrors: errors.filter(message => knownBootError.test(message)).length,
      fixtureAuthErrors: errors.filter(fixtureAuthError).length,
      reload: true, workspaceIsolation: true, launches: ['Napplet', 'WApp'] }));
  });
}
