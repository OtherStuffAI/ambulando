const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
async function seed(page) {
  await page.evaluate(() => {
    const s = Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'clearInactiveSectionData']) s[key] = () => {};
    s.openConnectModal = () => {};
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'fixture' }; s.knownWorkspaces = ['collapse-a', 'collapse-b'].map(id => ({ workspaceId: id, workspaceKey: id })); s.selectedWorkspaceKey = 'collapse-a';
    s.scopes = ['one', 'two'].map(id => ({ record_id: id, title: id, level: 'l1', record_state: 'active' }));
    s.channels = ['one', 'two'].map(id => ({ record_id: `channel-${id}`, scope_id: id, name: `Channel ${id}`, record_state: 'active' }));
    s.selectedChannelId = 'channel-one'; s.selectedBoardId = '__pg_channel__:channel-one';
    s.navSection = 'status'; s.navCollapsed = false; s.mobileNavOpen = window.innerWidth <= 768;
  });
  // Let drawer focus restoration and Alpine projections finish before input.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
for (const width of [1440, 390]) test(`scope disclosure persists, isolates and preserves selection at ${width}px`, async ({ page, browser }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
  await seed(page);
  const toggle = page.locator('.sidebar-scope-collapse').first();
  const list = page.locator('#sidebar-scope-channels-one');
  await expect(list).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle.locator('path')).toHaveAttribute('d', 'm6 9 6 6 6-6');
  if (width === 390) { const box = await toggle.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
  await toggle.focus(); await toggle.press('Enter');
  const closed = page.locator('.sidebar-scope-collapse').first();
  await expect(closed).toHaveAttribute('aria-label', 'Expand one channels'); expect(await closed.evaluate(el => el === document.activeElement)).toBe(true); await expect(closed).toHaveAttribute('aria-expanded', 'false');
  await expect(closed.locator('path')).toHaveAttribute('d', 'm9 6 6 6-6 6');
  await expect(list).toBeHidden(); await expect(page.locator('#sidebar-scope-channels-two')).toBeVisible();
  expect(await page.evaluate(() => [Alpine.store('chat').selectedChannelId, Alpine.store('chat').pgContextSelectedChannelId, Alpine.store('chat').navSection])).toEqual(['channel-one', 'channel-one', 'status']);
  await expect(page.locator('.sidebar-scope-heading-control').filter({ hasText: /^one$/ })).toBeVisible();
  await page.reload(); await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false); await seed(page);
  await expect(list).toBeHidden();
  await page.evaluate(() => { Alpine.store('chat').selectedWorkspaceKey = 'collapse-b'; });
  await expect(list).toBeVisible();
  await page.evaluate(() => { Alpine.store('chat').selectedWorkspaceKey = 'collapse-a'; });
  await expect(list).toBeHidden();
  await closed.focus(); await closed.press('Space'); await expect(list).toBeVisible();
  await page.locator('.sidebar-scope-collapse').first().click(); await expect(list).toBeHidden();
  const independent = await browser.newContext(); const other = await independent.newPage();
  await other.route('**/*', route => serveBuiltFlightDeck(route)); await other.goto('/');
  await other.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false); await seed(other);
  await expect(other.locator('#sidebar-scope-channels-one')).toBeVisible(); await independent.close();
});
