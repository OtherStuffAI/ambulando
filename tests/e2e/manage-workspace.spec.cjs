const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Isolated production UI with synthetic identity and loopback-only intercepted
// transport. This proves navigation/layout, never live backend authorization.
test.use({ serviceWorkers: 'block' });
for (const width of [1280, 390, 320]) {
  test(`Manage Workspace preserves sections and compact recovery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto('/');
    await seedGroupsAccess(page, buildGroupsAccessFixture());
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const context = page.getByTestId('settings-workspace-context');
    await expect(context.getByRole('heading', { name: 'Manage Workspace' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Scopes & Channels' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeHidden();
    await expect(page.getByTestId('groups-members-access')).toBeVisible();
    if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/manage-workspace-${width}.png` });
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.workspaceProfileNameInput = 'Unsaved workspace draft'; });
    await nav.getByRole('button', { name: 'Deck', exact: true }).click();
    await expect(page.getByLabel('Theme', { exact: true })).toBeVisible();
    await expect(page.getByTestId('agents-enabled')).toBeVisible();
    await expect(context.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await nav.getByRole('button', { name: 'Connection & Diagnostics', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
    await nav.getByRole('button', { name: 'Workspace', exact: true }).click();
    expect(await page.evaluate(() => window.Alpine.store('chat').workspaceProfileNameInput)).toBe('Unsaved workspace draft');
    await page.evaluate(() => { window.Alpine.store('chat').towerReachabilityState = 'offline'; });
    await expect(context.getByRole('button', { name: /Connection lost.*open Connection/ })).toBeVisible();
    await context.getByRole('button', { name: /Connection lost.*open Connection/ }).click();
    await expect(nav.getByRole('button', { name: 'Connection & Diagnostics', exact: true })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('button', { name: 'Scopes & Channels' }).click();
    await expect(nav.getByRole('button', { name: 'Scopes & Channels' })).toHaveAttribute('aria-current', 'page');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    // Authority loss retains personal settings and scope ordering, while admin
    // controls disappear through the same production capability getter.
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.knownWorkspaces = s.knownWorkspaces.map(w => ({ ...w, creatorNpub: '', pgMe: { ...w.pgMe, permissions: [] } }));
      s.groups = []; s.pgWorkspaceMembers = [];
      s.currentWorkspaceCreatorNpub = '';
    });
    await expect(nav.getByRole('button', { name: 'Workspace', exact: true })).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Groups & Members', exact: true })).toBeHidden();
    // Keyboard switching remains native button behaviour.
    await nav.getByRole('button', { name: 'Deck', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Theme', { exact: true })).toBeVisible();
  });
}
