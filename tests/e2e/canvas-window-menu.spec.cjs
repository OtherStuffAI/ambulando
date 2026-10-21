const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
for (const width of [1440, 390, 320]) {
  for (const mode of ['light', 'dark', 'system-light', 'system-dark']) {
    test(`Canvas options stay content sized: ${mode}, ${width}px`, async ({ page, baseURL }) => {
      const dark = mode.endsWith('dark');
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
        const store = Alpine.store('canvas');
        store.status = 'ready'; store.error = ''; store.canvas = { title: 'Menu geometry', can_manage: true };
      });
      for (const type of ['document', 'task_list', 'chat_thread', 'html', 'denied']) {
        await page.evaluate(type => {
          Alpine.store('canvas').naplets = [{ id: 'window', title: 'Window', access: type === 'denied' ? 'denied' : 'ready', source: { type, id: 'source' }, content: { body: 'Document text', html: '<p>Package</p>', tasks: [], messages: [] }, layout: { x: 0, y: 0, width: 300, height: 250, z: 1 } }];
        }, type);
        const naplet = page.locator('.canvas-naplet');
        for (const expanded of [false, true]) {
          if (expanded) await naplet.getByRole('button', { name: 'Open full screen', exact: true }).click();
          await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
          const menu = naplet.getByRole('menu');
          const geometry = await menu.evaluate(node => {
            const rows = [...node.children].filter(row => row.getClientRects().length).map(row => row.getBoundingClientRect());
            const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
              background: style.backgroundColor, opacity: style.opacity, overflow: node.scrollHeight - node.clientHeight,
              heights: rows.map(row => row.height), gaps: rows.slice(1).map((row, i) => row.top - rows[i].bottom) };
          });
          expect(geometry.background).toBe(dark ? 'rgb(24, 39, 53)' : 'rgb(255, 255, 255)');
          expect(geometry.opacity).toBe('1');
          expect(geometry.height).toBeLessThan(450);
          expect(geometry.left).toBeGreaterThanOrEqual(8);
          expect(geometry.right).toBeLessThanOrEqual(width - 8);
          expect(geometry.top).toBeGreaterThanOrEqual(8);
          expect(geometry.bottom).toBeLessThanOrEqual(712);
          expect(geometry.overflow).toBeLessThanOrEqual(1);
          for (const height of geometry.heights) { expect(height).toBeGreaterThanOrEqual(width <= 700 ? 44 : 36); expect(height).toBeLessThan(64); }
          for (const gap of geometry.gaps) expect(gap).toBeCloseTo(2, 0);
          await page.keyboard.press('End');
          await expect(menu.getByRole('menuitem', { name: 'Remove from Canvas' })).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(naplet.getByRole('button', { name: 'Window options', exact: true })).toBeFocused();
        }
        await naplet.getByRole('button', { name: 'Restore from full screen', exact: true }).click();
      }
      await page.setViewportSize({ width, height: 180 });
      const naplet = page.locator('.canvas-naplet'), menu = naplet.getByRole('menu');
      await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
      expect(await menu.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      expect((await menu.boundingBox()).height).toBeLessThanOrEqual(164);
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: 'Remove from Canvas' })).toBeInViewport();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(() => Alpine.store('canvas').canvas.can_manage = false);
      await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
      await expect(menu.locator('[role=menuitem]:visible')).toHaveCount(2);
      expect((await menu.boundingBox()).height).toBeLessThan(115);
      console.log('CANVAS_MENU_GEOMETRY', JSON.stringify({ width, mode, variants: 5, modes: 2, rowGap: 2, shortViewportScroll: true, runtimeAssets: process.env.SOL_RUNTIME_ASSETS === '1' }));
    });
  }
}
