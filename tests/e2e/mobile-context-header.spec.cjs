const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');

test.setTimeout(30000);
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', trace: 'off', screenshot: 'off' });
async function seed(page, baseURL) {
  const live = process.env.SOL_HEADER_LIVE === '1';
  if (live) await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin || url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  await openFixture(page, live);
  await page.evaluate(() => {
    const s = Alpine.store('chat');
    s.closeThread({ syncRoute: false });
    s.isTowerPgMode = true; s.pgBackendMode = true;
    s.selectedWorkspaceKey = 'header-fixture';
    s.knownWorkspaces = [{ workspaceKey: 'header-fixture', workspaceId: 'header-fixture', name: 'Synthetic review workspace',
      pgBackendMode: true, pgMe: { actor: { actor_id: 'reader', npub: 'npub1solfixture' } },
      directHttpsUrl: 'http://127.0.0.1:3100', workspaceOwnerNpub: 'synthetic-owner' }];
    s.scopesLoaded = true;
    s.scopes = [{ record_id: 'header-scope', title: 'Product planning', level: 'l1', record_state: 'active' },
      { record_id: 'header-dms', title: 'DMs', pg_kind: 'dm', level: 'l1', record_state: 'active' }];
    s.channels = [{ record_id: 'header-channel', title: 'Implementation', name: 'Implementation', scope_id: 'header-scope', record_state: 'active' },
      { record_id: 'header-dm', title: 'Review partner', name: 'Review partner', scope_id: 'header-dms', channel_type: 'dm', record_state: 'active' }];
    s.selectedBoardId = '__pg_channel__:header-channel';
    s.navSection = 'status';
    s.canCreateChannelInScope = () => true;
  });
}
async function capture(page, name) {
  const dir = process.env.SOL_EVIDENCE_DIR;
  if (!dir) return;
  execFileSync('git', ['check-ignore', `${dir}/${name}.png`]);
  expect(execFileSync('git', ['ls-files', dir], { encoding: 'utf8' }).trim()).toBe('');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}
for (const width of [320, 390, 720, 1280]) for (const theme of ['light', 'dark']) {
  test(`context header geometry and labels ${width} ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    await seed(page, baseURL);
    await page.evaluate(theme => Alpine.store('appearance').setTheme(theme), theme);
    const row = page.locator('.mobile-scope-switcher');
    if (width > 768) {
      await expect(row).toBeHidden();
      await expect(page.locator('.page-header .brand-lockup')).toBeVisible();
      await expect(page.locator('.global-pg-channel-bar > .chat-channel-header')).toBeVisible();
      await expect(page.locator('.global-pg-channel-bar .chat-channel-tab-add')).toBeVisible();
      await capture(page, `header-${width}-${theme}`);
      return;
    }
    await expect(row).toBeVisible();
    await expect(row.locator('.mobile-context-name').first()).toHaveText('Product planning');
    await expect(row.locator('.mobile-context-name').last()).toHaveText('Implementation');
    await expect(page.locator('.page-header .brand-lockup')).toBeVisible();
    await expect(page.locator('.page-header .avatar-chip')).toBeVisible();
    await expect(page.locator('.mobile-context-menu')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(1);
    await expect(page.locator('.global-pg-channel-bar > .chat-channel-header')).toBeHidden();
    const geometry = await row.boundingBox();
    expect(geometry.height).toBe(45);
    const buttons = await row.locator('button:visible').evaluateAll(ns => ns.map(n => n.getBoundingClientRect().toJSON()));
    expect(buttons).toHaveLength(2);
    for (const b of buttons) { expect(b.height).toBe(44); expect(b.width).toBe(44); }
    await capture(page, `header-${width}-${theme}`);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.scopes = [{ ...s.scopes[0], title: 'A very long scope name with complete accessible context '.repeat(4) }];
      s.channels = [{ ...s.channels[0], title: 'A very long channel name with complete accessible context '.repeat(4), name: 'A very long channel name with complete accessible context '.repeat(4) }];
    });
    for (const label of await row.locator('.mobile-context-name').all()) {
      const text = await label.textContent();
      await expect(label).toHaveAttribute('title', text);
      await expect(label).toHaveAttribute('aria-label', new RegExp(text.trim()));
      expect(await label.evaluate(n => n.scrollWidth > n.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `header-long-${width}-${theme}`);
    await page.locator('.mobile-context-fullscreen').click();
    await expect(page.locator('.page-header')).toBeHidden();
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle navigation', exact: true })).toHaveCount(1);
    const focusedButtons = await row.locator('button:visible').evaluateAll(ns => ns.map(n => n.getBoundingClientRect().toJSON()));
    expect(focusedButtons).toHaveLength(3);
    for (const b of focusedButtons) { expect(b.height).toBe(44); expect(b.width).toBe(44); }
    expect(focusedButtons[0].x + 44).toBeLessThanOrEqual(focusedButtons[1].x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `header-focused-${width}-${theme}`);
    await page.locator('.mobile-context-fullscreen').click();
    await page.evaluate(() => { const s = Alpine.store('chat'); s.selectedBoardId = '__all__'; });
    await expect(row.locator('.mobile-context-name').first()).toHaveText('All');
    await expect(row.locator('.mobile-context-name').last()).toHaveText('No channel selected');
    console.log('HEADER_GEOMETRY', JSON.stringify({ width, theme, row: geometry, buttons }));
  });
}

for (const theme of ['light', 'dark']) for (const focused of [false, true]) test(`sidebar Home and scope/channel navigation ${theme} focus=${focused}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, baseURL);
  await page.evaluate(theme => Alpine.store('appearance').setTheme(theme), theme);
  if (focused) await page.locator('.mobile-context-fullscreen').click();
  const opener = page.locator(focused ? '.mobile-context-menu' : '.page-header .mobile-menu-btn');
  const nav = page.locator('#sol-primary-navigation');
  await opener.click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Create channel in Product planning', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Channel settings for Implementation', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Open Product planning home', exact: true }).click();
  await expect(page.locator('.mobile-context-name').first()).toHaveText('Product planning');
  await expect(page.locator('.mobile-context-name').last()).toHaveText('No channel selected');
  await opener.click();
  await nav.locator('.sidebar-scope-channel').filter({ hasText: 'Implementation' }).click();
  await expect(page.locator('.mobile-context-name').last()).toHaveText('Implementation');
  await opener.click();
  await expect(nav.getByRole('button', { name: 'Open DMs home', exact: true })).toBeVisible();
  await nav.locator('.sidebar-scope-channel').filter({ hasText: 'Review partner' }).click();
  await expect(page.locator('.mobile-context-name').first()).toHaveText('DMs');
  await expect(page.locator('.mobile-context-name').last()).toHaveText('Review partner');
  await opener.click();
  await expect(nav.locator('.mobile-navigation-tools')).toHaveCount(0);
  for (const name of ['Close navigation', 'Change color theme', 'Profile and sync', 'Open command palette', 'Settings']) {
    await expect(nav.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const home = nav.getByRole('button', { name: 'All workspace activity', exact: true });
  await expect(home).toBeVisible();
  await expect.poll(async () => (await nav.boundingBox()).x).toBe(0);
  const homeBox = await home.boundingBox();
  const navBox = await nav.boundingBox();
  expect(homeBox.y - navBox.y).toBeLessThanOrEqual(16);
  expect(await nav.locator('button:visible').first().getAttribute('aria-label')).toBe('All workspace activity');
  await expect(nav.locator('.sidebar-workspace-trigger')).toBeVisible();
  await nav.locator('.sidebar-workspace-trigger').click();
  await expect(nav.locator('.sidebar-workspace-trigger')).toHaveAttribute('aria-expanded', 'true');
  await nav.locator('.sidebar-workspace-trigger').click();
  await capture(page, `drawer-${theme}-${focused ? 'fullscreen' : 'normal'}`);
  console.log('DRAWER_HOME_POSITION', JSON.stringify({ theme, focused, home: homeBox, nav: navBox }));
  await home.click();
  await expect(nav).not.toHaveClass(/sidebar-mobile-open/);
  expect(await page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('__all__');
  await expect(page.locator('.mobile-context-name').first()).toHaveText('All');
});

for (const theme of ['light', 'dark']) for (const focused of [false, true]) test(`drawer Escape and backdrop close restore focus ${theme} focus=${focused}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, baseURL);
  await page.evaluate(theme => Alpine.store('appearance').setTheme(theme), theme);
  if (focused) await page.locator('.mobile-context-fullscreen').click();
  const opener = page.locator(focused ? '.mobile-context-menu' : '.page-header .mobile-menu-btn');
  const nav = page.locator('#sol-primary-navigation');
  for (const method of ['Escape', 'backdrop']) {
    await opener.click();
    await expect(nav).toHaveClass(/sidebar-mobile-open/);
    await expect(nav).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(nav.locator('.sidebar-workspace-overview')).toBeFocused();
    if (method === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 200 } });
    await expect(nav).not.toHaveClass(/sidebar-mobile-open/);
    await expect(opener).toBeFocused();
    await expect(opener).toBeVisible();
  }
});

test('fullscreen restores header and keyboard focus in every mobile section', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await seed(page, baseURL);
  for (const section of ['status', 'chat', 'tasks', 'docs', 'files', 'toolbox', 'settings']) {
    await page.evaluate(section => { Alpine.store('chat').navSection = section; }, section);
    const enter = page.locator('.mobile-context-fullscreen');
    const exit = page.locator('.mobile-context-fullscreen');
    await enter.click();
    await expect(page.locator('.mobile-scope-switcher')).toBeVisible();
    await expect(page.locator('.page-header')).toBeHidden();
    await expect(page.locator('.mobile-context-menu')).toBeVisible();
    await expect(exit).toHaveAccessibleName('Show header');
    const menu = await page.locator('.mobile-context-menu').boundingBox();
    const home = await page.locator('.mobile-context-home').boundingBox();
    expect(menu.x + menu.width).toBeLessThanOrEqual(home.x);
    await expect(exit).toBeVisible();
    await expect(exit).toBeFocused();
    const r = await exit.boundingBox();
    expect(r.width).toBe(44); expect(r.height).toBe(44);
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-header')).toBeVisible();
    await expect(page.locator('.mobile-context-menu')).toBeHidden();
    await expect(exit).toHaveAccessibleName('Full screen');
    await expect(enter).toBeVisible();
    await expect(enter).toBeFocused();
  }
});

test('safe areas and reduced keyboard viewport keep mobile header reachable', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, baseURL);
  // Chromium cannot emulate iOS env() values. Substitute only the safe-area
  // expressions in the production stylesheet, retaining its actual selectors.
  await page.evaluate(async () => {
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = [...sheet.cssRules]; } catch { continue; }
      const css = rules.map(r => r.cssText).join('\n');
      if (!css.includes('.mobile-context-fullscreen')) continue;
      const style = document.createElement('style');
      style.textContent = css.replaceAll('env(safe-area-inset-top)', '24px').replaceAll('env(safe-area-inset-bottom)', '34px').replaceAll('env(safe-area-inset-left)', '12px').replaceAll('env(safe-area-inset-right)', '12px');
      document.head.append(style);
    }

  });
  await page.setViewportSize({ width: 390, height: 360 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    shell.style.setProperty('--sol-visual-top', '37px');
    shell.style.setProperty('--sol-visual-height', '320px');
  });
  const row = await page.locator('.mobile-scope-switcher').boundingBox();
  expect(row.height).toBe(45);
  await page.locator('.mobile-context-fullscreen').click();
  const exit = page.locator('.mobile-context-fullscreen');
  await expect(exit).toHaveAccessibleName('Show header');
  await expect(page.locator('.page-header')).toBeHidden();
  await expect(page.locator('.mobile-scope-switcher')).toHaveClass(/mobile-context-focused/);
  await expect.poll(async () => (await page.locator('.mobile-scope-switcher').boundingBox()).height).toBe(69);
  const r = await exit.boundingBox();
  expect(r.y).toBe(24); expect(r.y + r.height).toBeLessThanOrEqual(320); expect(r.x + r.width).toBeLessThanOrEqual(378);
  await capture(page, 'header-keyboard-fullscreen-safe-area');
  await exit.click();
  await page.locator('.page-header .mobile-menu-btn').click();
  await expect(page.locator('#sol-primary-navigation')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.page-header .mobile-menu-btn')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  console.log('HEADER_KEYBOARD_SAFE_AREA', JSON.stringify({ row, restore: r, visualHeight: 320, visualTop: 37 }));
});

for (const focused of [false, true]) test(`hamburger and workspace home have distinct effects focus=${focused}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, baseURL);
  if (focused) await page.locator('.mobile-context-fullscreen').click();
  const opener = page.locator(focused ? '.mobile-context-menu' : '.page-header .mobile-menu-btn');
  await opener.click();
  await expect(page.locator('#sol-primary-navigation')).toHaveClass(/sidebar-mobile-open/);
  expect(await page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('__pg_channel__:header-channel');
  await expect(page.locator('#sol-primary-navigation')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.locator('.mobile-context-home').click();
  await expect(page.locator('#sol-primary-navigation')).not.toHaveClass(/sidebar-mobile-open/);
  expect(await page.evaluate(() => Alpine.store('chat').selectedBoardId)).toBe('__all__');
  await expect(page.locator('.mobile-context-name').first()).toHaveText('All');
  console.log('HEADER_HOME_STATE', JSON.stringify({ focused, board: await page.evaluate(() => Alpine.store('chat').selectedBoardId), drawerOpen: await page.evaluate(() => Alpine.store('chat').mobileNavOpen) }));
  await capture(page, `header-home-focus-${focused}`);
});

test('normal branding row exposes theme and profile', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await seed(page, baseURL);
  await page.locator('.page-header .sol-theme-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.page-header .avatar-chip').click();
  await expect(page.locator('#profile-avatar-menu')).toBeVisible();
});
