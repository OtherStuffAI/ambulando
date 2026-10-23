const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.setTimeout(45_000);
test.use({ trace: 'off', serviceWorkers: 'allow', reducedMotion: 'reduce' });

for (const width of [1440, 390, 320]) {
  test(`Canvas windows retain content and options through minimise and modal at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 800 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (process.env.SOL_RUNTIME_ASSETS === '1' && url.origin === new URL(baseURL).origin && !url.pathname.startsWith('/api/')) return route.continue();
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/canvas.html');
    await page.waitForFunction(() => window.Alpine?.store('canvas')?.status === 'error');
    await page.evaluate(() => {
      const store = Alpine.store('canvas');
      store.status = 'ready'; store.error = '';
      store.canvas = { title: 'Windows', can_manage: true };
      store.viewport = { x: 0, y: 0, scale: .8 };
      store.naplets = [{ id: 'html', title: 'Bush Bash Nostr', access: 'ready', source: { type: 'html', id: 'package' }, layout: { x: 12, y: 12, width: 360, height: 300, z: 1 }, content: { html: '<button id="counter">Count 0</button><input aria-label="Draft"><script>let count=0;document.querySelector("button").onclick=()=>document.querySelector("button").textContent=`Count ${++count}`;<\/script>' } }];
      // Trace existing action dispatch without needing a live authority/mutation.
      window.windowActions = [];
      store.orderSelected = async delta => window.windowActions.push({ action: 'order', delta, selected: { ...store.selected } });
      store.duplicateSelected = async () => window.windowActions.push({ action: 'duplicate', selected: { ...store.selected } });
    });
    const naplet = page.locator('.canvas-naplet');
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button').click();
    await frame.getByLabel('Draft').fill('Keep my draft');
    await naplet.getByRole('button', { name: 'Minimise window', exact: true }).click();
    await expect(naplet.locator('.canvas-window-content')).not.toBeVisible();
    await naplet.getByRole('button', { name: 'Restore window', exact: true }).click();
    await expect(frame.getByRole('button')).toHaveText('Count 1');
    await expect(frame.getByLabel('Draft')).toHaveValue('Keep my draft');
    const before = await page.evaluate(() => ({ viewport: { ...Alpine.store('canvas').viewport }, layout: { ...Alpine.store('canvas').naplets[0].layout } }));
    await naplet.getByRole('button', { name: 'Open full screen', exact: true }).click();
    await expect(naplet).toHaveJSProperty('open', true);
    const box = await naplet.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width, height: 800 });
    await expect(frame.getByRole('button')).toHaveText('Count 1');
    await expect(frame.getByLabel('Draft')).toHaveValue('Keep my draft');
    await frame.getByRole('button').click();
    await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
    const menu = naplet.getByRole('menu');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(800);
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Remove from Canvas' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(naplet).toHaveJSProperty('open', true);
    await expect(naplet.getByRole('button', { name: 'Window options', exact: true })).toBeFocused();
    await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'Bring forward' }).click();
    expect(await page.evaluate(() => window.windowActions)).toEqual([{ action: 'order', delta: 1, selected: { type: 'naplet', id: 'html' } }]);
    await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'Comment…' }).click();
    await expect(page.locator('.canvas-comment-dialog')).toBeVisible();
    await page.getByLabel('Comment', { exact: true }).fill('Nested modal draft');
    await page.keyboard.press('Escape');
    await expect(page.locator('.canvas-comment-dialog')).not.toBeVisible();
    await expect(naplet).toHaveJSProperty('open', true);
    // Native modal traps tab navigation; wheel over its header cannot pan Canvas.
    await naplet.getByRole('button', { name: 'Restore from full screen', exact: true }).focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const focused = await naplet.evaluate(el => ({ contained: el.contains(document.activeElement), tag: document.activeElement.tagName }));
      expect(focused.contained || focused.tag === 'BODY').toBe(true);
    }
    await naplet.locator('.canvas-naplet-header strong').hover();
    await page.mouse.wheel(0, 120);
    await naplet.getByRole('button', { name: 'Restore from full screen', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(naplet).toHaveJSProperty('open', false);
    await expect(naplet.getByRole('button', { name: 'Open full screen', exact: true })).toBeFocused();
    await expect(frame.getByRole('button')).toHaveText('Count 2');
    await expect(frame.getByLabel('Draft')).toHaveValue('Keep my draft');
    expect(await page.evaluate(() => ({ viewport: { ...Alpine.store('canvas').viewport }, layout: { ...Alpine.store('canvas').naplets[0].layout } }))).toEqual(before);
    await naplet.getByRole('button', { name: 'Window options', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    expect(await page.evaluate(() => window.windowActions.at(-1))).toEqual({ action: 'duplicate', selected: { type: 'naplet', id: 'html' } });
    await naplet.getByRole('button', { name: 'Open full screen', exact: true }).click();
    await naplet.getByRole('button', { name: 'Minimise window', exact: true }).click();
    await expect(naplet).toHaveJSProperty('open', false);
    await naplet.getByRole('button', { name: 'Restore window', exact: true }).click();
    await expect(frame.getByRole('button')).toHaveText('Count 2');
    expect(errors).toEqual([]);
    console.log('CANVAS_WINDOW_EVIDENCE', JSON.stringify({ width, iframeStateRetained: true, modalFit: box, sameOptionsDispatch: true, nestedCommentModal: true, focusRestore: true, layoutAndViewportUnchanged: true }));
    if (process.env.CANVAS_WINDOW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.CANVAS_WINDOW_SCREENSHOT_DIR}/window-${width}.png` });
  });
}
