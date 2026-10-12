const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', screenshot: 'off' });
async function capture(page, name) {
  const dir = process.env.SOL_EVIDENCE_DIR;
  if (!dir) return;
  execFileSync('git', ['check-ignore', `${dir}/${name}.png`]);
  expect(execFileSync('git', ['ls-files', dir], { encoding: 'utf8' }).trim()).toBe('');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}
async function seed(page, baseURL) {
  const live = process.env.SOL_PAGE_SPACE_LIVE === '1';
  if (live) await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL).origin || url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  await openFixture(page, live);
  await page.evaluate(() => {
    const s = Alpine.store('chat');
    s.closeThread({ syncRoute: false });
    s.workspaceDbKey = 'page-space'; s.selectedWorkspaceKey = 'page-space';
    s.knownWorkspaces = [{ workspaceKey: 'page-space', workspaceId: 'page-space', pgBackendMode: true,
      pgMe: { actor: { actor_id: 'reader', npub: 'npub1solfixture' } },
      directHttpsUrl: 'http://127.0.0.1:3100', workspaceOwnerNpub: 'synthetic-owner' }];
    s.wapps = [{ record_id: 'space-app', title: 'A useful app with a long descriptive title',
      launch_url: 'https://example.invalid/apps/a-long-address', pg_backend: true,
      pg_record_type: 'personal_wapp', owner_actor_id: 'reader', record_state: 'active' }];
    s.__spaceActions = [];
    // Instrument transport-facing commands; production handlers and editor remain mounted.
    s.__spaceShown = true;
    s.isAppPlaced = app => app.record_id === 'space-app' ? s.__spaceShown : true;
    s.setAppPlacement = async (app, shown) => { s.__spaceActions.push(['shown', app.title, shown]); s.__spaceShown = shown; };
    s.moveToolboxApp = async (app, direction) => { s.__spaceActions.push(['move', app.title, direction]); };
    s.archivePersonalWapp = async app => { s.__spaceActions.push(['archive', app.title]); };
    s.navSection = 'toolbox';
  });
}
for (const width of [320, 390, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`page space controls and complete content ${width}px ${theme}`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 844 });
      await seed(page, baseURL);
      await page.evaluate(theme => Alpine.store('appearance').setTheme(theme), theme);
      const mobile = width < 769;
      const panel = page.getByTestId('toolbox-page');
      const row = panel.locator('.personal-wapp-settings-row').filter({ hasText: 'A useful app' });
      await expect(row).toBeVisible();
      const heading = await panel.locator('.settings-panel-header').boundingBox();
      const napplet = panel.locator('.personal-wapp-settings-row').filter({ hasText: 'Message activity' });
      const rowBounds = await napplet.boundingBox();
      if (mobile) {
        expect(heading.height).toBeLessThan(100);
        expect(rowBounds.height).toBeLessThanOrEqual(110);
        const controls = await row.locator('button:visible, label').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
        for (const r of controls) {
          expect(r.height).toBeGreaterThanOrEqual(44);
          expect(r.width).toBeGreaterThanOrEqual(44);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.right).toBeLessThanOrEqual(width);
        }
      } else expect(rowBounds.height).toBeLessThan(70);
      await row.getByRole('checkbox').uncheck();
      await row.getByRole('button', { name: /Move .* down/ }).click();
      await row.getByRole('button', { name: 'Archive', exact: true }).click();
      expect(await page.evaluate(() => Alpine.store('chat').__spaceActions)).toEqual([
        ['shown', 'A useful app with a long descriptive title', false],
        ['move', 'A useful app with a long descriptive title', 'down'],
        ['archive', 'A useful app with a long descriptive title'],
      ]);
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.locator('.personal-wapp-editor-modal')).toBeVisible();
      await expect(page.locator('.personal-wapp-editor-modal input').first()).toHaveValue('A useful app with a long descriptive title');
      await page.keyboard.press('Escape');
      await expect(page.locator('.personal-wapp-editor-modal')).toBeHidden();
      await capture(page, `space-${width}-${theme}-toolbox`);
      await panel.getByRole('button', { name: 'Add WApp', exact: true }).click();
      await expect(page.locator('.personal-wapp-editor-modal')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.evaluate(() => { const s = Alpine.store('chat'); s.knownWorkspaces = []; s.selectedWorkspaceKey = null; s.workspaceDbKey = null; s.navSection = 'chat'; });
      const title = page.locator('.channel-thread-card-heading h3').first();
      await expect(title).toContainText('Keep existing conversations');
      await expect(title).toHaveAttribute('title', await title.textContent());
      const titleHeight = await title.evaluate(n => ({ height: n.getBoundingClientRect().height, line: parseFloat(getComputedStyle(n).lineHeight) }));
      if (mobile) expect(titleHeight.height).toBeLessThanOrEqual(titleHeight.line * 2 + 1);
      await capture(page, `space-${width}-${theme}-chat`);
      await page.locator('.chat-post-content').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.chat-thread-panel')).toBeVisible();
      await expect(page.locator('.thread-msg-text').first()).toContainText('Keep existing conversations, tasks and documents working.');
      await page.evaluate(() => { const s = Alpine.store('chat'); s.closeThread({ syncRoute: false }); s.navSection = 'files'; });
      if (mobile) {
        const tabs = page.locator('.files-mobile-switcher');
        const geometry = await tabs.locator('button:visible').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
        expect(geometry).toHaveLength(4);
        // Large counts retain both labels inside the tabs instead of spilling
        // into adjacent search/add targets.
        const largeCounts = await tabs.getByRole('tab').evaluateAll(nodes => nodes.map(n => {
          const count = n.querySelector('small'); const prior = count.textContent;
          count.textContent = '9999';
          const parent = n.getBoundingClientRect();
          const children = [...n.children].map(c => c.getBoundingClientRect().toJSON());
          count.textContent = prior;
          return { left: parent.left, right: parent.right, children };
        }));
        for (const tab of largeCounts) for (const child of tab.children) {
          expect(child.left).toBeGreaterThanOrEqual(tab.left);
          expect(child.right).toBeLessThanOrEqual(tab.right);
        }
        for (const r of geometry) { expect(r.height).toBe(44); expect(r.width).toBeGreaterThanOrEqual(44); expect(r.right).toBeLessThanOrEqual(width); }
        await tabs.getByRole('button', { name: 'Search and filter files', exact: true }).click();
        await page.locator('.files-search-input').fill('Mobile layout');
        await expect(page.locator('.files-list')).toContainText('Mobile layout review.pdf');
        await tabs.getByRole('button', { name: 'Search and filter files', exact: true }).click();
        await tabs.getByRole('tab', { name: /FIPS Drive/ }).click();
        await expect(page.locator('#files-main-pane')).toBeHidden();
        await tabs.getByRole('tab', { name: /Tower files/ }).click();
        await expect(page.locator('#files-main-pane')).toBeVisible();
        await tabs.getByRole('button', { name: 'Add files or folders', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Upload file', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeVisible();
        await tabs.getByRole('button', { name: 'Add files or folders', exact: true }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture(page, `space-${width}-${theme}-files`);
      console.log('PAGE_SPACE', JSON.stringify({ width, theme, heading: heading.height, napplet: rowBounds.height, chatTitle: titleHeight.height }));
    });
  }
}
