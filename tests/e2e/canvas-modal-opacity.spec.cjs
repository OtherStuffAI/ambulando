const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function assertPanel(panel, expected, width) {
  await expect(panel).toBeVisible();
  const result = await panel.evaluate(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { background: style.backgroundColor, opacity: style.opacity, left: rect.left, right: rect.right, height: rect.height, viewport: innerHeight };
  });
  expect(result.background).toBe(expected);
  expect(result.opacity).toBe('1');
  expect(result.left).toBeGreaterThanOrEqual(0);
  expect(result.right).toBeLessThanOrEqual(width);
  expect(result.height).toBeLessThanOrEqual(result.viewport);
}

for (const width of [1440, 390]) {
  for (const mode of ['light', 'dark', 'system-light', 'system-dark']) {
    test(`Canvas modal panels are opaque: ${mode}, ${width}px`, async ({ page, baseURL }) => {
      test.setTimeout(45_000);
      const dark = mode.endsWith('dark');
      const expected = dark ? 'rgb(24, 39, 53)' : 'rgb(255, 255, 255)';
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.addInitScript(mode => localStorage.setItem('ambulando:theme', mode.startsWith('system') ? 'system' : mode), mode);
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (process.env.SOL_RUNTIME_ASSETS === '1' && url.origin === new URL(baseURL).origin && !url.pathname.startsWith('/api/')) return route.continue();
        return serveBuiltFlightDeck(route);
      });
      await page.goto('/canvas.html');
      await page.waitForFunction(() => window.Alpine?.store('canvas')?.status === 'error');
      await page.evaluate(() => {
        const store = window.Alpine.store('canvas');
        store.status = 'ready'; store.error = '';
        store.canvas = { title: 'Busy Canvas', can_manage: true };
        store.elements = Array.from({ length: 24 }, (_, i) => ({ id: `shape-${i}`, kind: 'rectangle', data: {}, layout: { x: (i % 6) * 180, y: Math.floor(i / 6) * 150, width: 160, height: 130, z: i } }));
        store.comments = [{ id: 'root', body: 'Please review this area. '.repeat(160), author: { label: 'Reviewer' }, can_resolve: true, anchor: { type: 'canvas', x: 100, y: 100 }, created_at: '2026-10-21', resolved_at: null }];
        store.loadSourceOptions = async () => {};
      });
      await page.getByRole('button', { name: 'Add naplet', exact: true }).click();
      const add = page.locator('.canvas-add-dialog');
      await assertPanel(add, expected, width);
      for (const type of ['document', 'task_list', 'chat_thread', 'html']) {
        await add.locator('select').selectOption(type);
        await assertPanel(add, expected, width);
      }
      await add.getByRole('button', { name: 'Cancel' }).click();
      await expect(add).not.toBeVisible();
      await page.evaluate(() => window.Alpine.store('canvas').openCommentDialog({ type: 'canvas', x: 100, y: 100 }));
      const editor = page.locator('.canvas-comment-dialog');
      await assertPanel(editor, expected, width);
      await editor.getByLabel('Comment', { exact: true }).fill('Draft stays editable');
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
      const thread = page.locator('.canvas-comment-panel');
      await assertPanel(thread, expected, width);
      const backdrop = await thread.evaluate(node => getComputedStyle(node, '::backdrop').backgroundColor);
      expect(backdrop).toBe('rgba(0, 0, 0, 0)');
      expect(await thread.evaluate(node => node.matches(':modal'))).toBe(false);
      if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/canvas-thread-${mode}-${width}.png` });
      await expect.poll(() => thread.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await thread.getByRole('button', { name: 'Reply', exact: true }).click();
      await assertPanel(editor, expected, width);
      await expect(editor.getByRole('heading')).toHaveText('Reply');
      if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/canvas-reply-${mode}-${width}.png` });
      await editor.getByLabel('Comment', { exact: true }).fill('Nested reply');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await editor.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await assertPanel(thread, expected, width);
      await thread.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(thread).not.toBeVisible();

      // Naplet windows can also enter the native modal top layer.
      for (const type of ['document', 'task_list', 'chat_thread', 'html', 'denied']) {
        await page.evaluate(type => {
          window.Alpine.store('canvas').naplets = [{ id: 'modal-window', title: 'Window', access: type === 'denied' ? 'denied' : 'ready', source: { type, id: 'source' }, content: { body: 'Document text', html: '<p>Interactive package</p>', tasks: [], messages: [] }, layout: { x: 0, y: 0, width: 300, height: 250, z: 1 } }];
        }, type);
        const naplet = page.locator('.canvas-naplet');
        await naplet.getByRole('button', { name: 'Open full screen', exact: true }).click();
        await assertPanel(naplet, expected, width);
        await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
        await assertPanel(naplet.getByRole('menu'), expected, width);
        await page.keyboard.press('Escape');
        await naplet.getByRole('button', { name: 'Restore from full screen', exact: true }).click();
      }

      // The Deck manager uses one shared surface for create/settings, with a
      // nested principal picker rather than another modal or confirmation.
      await openFixture(page, true);
      await page.evaluate(() => window.Alpine.store('chat').openCanvasCreateDialog());
      const settings = page.locator('.canvas-settings-surface');
      await assertPanel(settings, expected, width);
      await page.getByRole('button', { name: 'Close canvas settings' }).click();
      await page.evaluate(() => window.Alpine.store('chat').openCanvasSettingsDialog({ id: 'fixture', title: 'Canvas settings', can_manage: true, row_version: 1, visibility: { mode: 'workspace', actor_ids: [], group_ids: [] } }));
      await assertPanel(settings, expected, width);
      await page.keyboard.press('Escape');
      await expect(settings).not.toBeVisible();
      console.log('CANVAS_MODAL_OPACITY', JSON.stringify({ mode, width, runtimeAssets: process.env.SOL_RUNTIME_ASSETS === '1', panelColor: expected, panels: ['add (all four source types)', 'comment', 'thread', 'nested reply', 'create', 'settings', 'expanded naplets (five variants)', 'window options'], backdrop }));
    });
  }
}
