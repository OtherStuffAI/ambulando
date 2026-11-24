const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.setTimeout(30000);
test.use({ serviceWorkers: 'block', hasTouch: true, trace: 'off', screenshot: 'off' });
for (const width of [320, 390, 720]) {
  test(`whole navigation strip geometry and navigation ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.isTowerPgMode = true; s.pgBackendMode = true;
      s.refreshStatusRecentChanges = () => {}; s.ensureBackgroundSync = () => {};
      s.navSection = 'status';
      s.selectedBoardId = '__all__';
    });
    const strip = page.getByRole('navigation', { name: 'Scope section navigation' });
    const home = strip.getByRole('button', { name: 'Workspace home', exact: true });
    await expect(home).toHaveAttribute('aria-current', 'page');
    await expect(strip.locator('[aria-current=page]')).toHaveCount(1);
    const geometry = await strip.evaluate(n => ({ width: n.clientWidth, scrollWidth: n.scrollWidth,
      itemWidth: n.firstElementChild.getBoundingClientRect().width }));
    expect(geometry.itemWidth).toBeCloseTo(Math.min(96, width / 4.5), 0);
    if (width < 500) expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
    await strip.evaluate(n => { n.scrollLeft = 160; });
    const scrolled = await strip.evaluate(n => n.scrollLeft);
    if (width < 500) {
      expect(scrolled).toBeGreaterThan(0);
      expect(await home.evaluate(n => n.getBoundingClientRect().right)).toBeLessThan(1);
    }
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.tasks = [...s.tasks, { record_id: 'live-task', title: 'Live update', record_state: 'active' }];
    });
    await page.waitForTimeout(100);
    expect(await strip.evaluate(n => n.scrollLeft)).toBe(scrolled);
    await page.evaluate(() => { Alpine.store('chat').navSection = 'chat'; });
    await expect.poll(() => strip.evaluate(n => n.scrollLeft)).toBe(0);
    await expect(home).not.toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.lockedView = 'chat';
      s.selectedBoardId = '__unscoped__';
      s.selectedChannelId = 'sol-channel';
    });
    await home.click();
    await expect.poll(() => page.evaluate(() => {
      const s = Alpine.store('chat');
      return [s.navSection, s.selectedBoardId, s.selectedChannelId, s.activeThreadId];
    })).toEqual(['status', '__all__', null, null]);
    await expect(home).toHaveAttribute('aria-current', 'page');
    await expect(strip.locator('[aria-current=page]')).toHaveCount(1);
    if (width === 390) {
      const client = await page.context().newCDPSession(page);
      const box = await strip.boundingBox();
      const y = box.y + box.height / 2;
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y }] });
      for (const x of [250, 210, 170, 130, 90]) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => strip.evaluate(n => n.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => Alpine.store('chat').navSection)).toBe('status');
      await client.detach();
      await strip.evaluate(n => { n.scrollLeft = 0; });
    }
    await strip.getByRole('button', { name: 'Chat', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').navSection)).toBe('chat');
    await expect.poll(() => strip.evaluate(n => n.scrollLeft)).toBe(0);
    if (width === 390) {
      await strip.evaluate(n => { n.scrollLeft = 140; });
      await page.reload();
      await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
      // The synthetic session is deliberately not persisted by the fixture.
      await page.evaluate(() => {
        const s = Alpine.store('chat');
        s.session = { npub: 'npub1solfixture' };
        s.showConnectModal = false;
        s.showWorkspaceBootstrapModal = false;
      });
      await expect.poll(() => strip.evaluate(n => n.scrollLeft)).toBe(0);
    }
  });
}

test('desktop navigation remains available', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openFixture(page);
  await expect(page.locator('.mobile-section-switcher')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeVisible();
});
