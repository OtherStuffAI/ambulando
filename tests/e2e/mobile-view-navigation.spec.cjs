const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
test.use({ serviceWorkers: 'block' });

for (const width of [320, 390, 768, 1440]) {
  test(`external view navigation and drawer ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navigateTo('status', { syncRoute: false });
      s.navCollapsed = false;
      s.agentsEnabled = false;
      s.contextEnabled = false;
    });
    const mobile = width <= 768;
    const bottom = page.locator('.mobile-section-switcher');
    const desktop = page.locator('.sol-horizontal-navigation');
    const nav = mobile ? bottom : desktop;
    await expect(nav).toBeVisible();
    await expect(mobile ? desktop : bottom).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Agents', exact: true })).toBeHidden();
    await expect(nav.getByRole('button', { name: 'Context', exact: true })).toBeHidden();
    for (const name of ['Deck', 'Chat', 'Tasks', 'Docs', 'Files', 'Toolbox']) {
      const button = nav.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(button).toHaveAttribute('aria-current', 'page');
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await page.evaluate(() => { const s = Alpine.store('chat'); s.agentsEnabled = true; s.contextEnabled = true; });
    for (const name of ['Agents', 'Context']) {
      const button = nav.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(button).toHaveAttribute('aria-current', 'page');
    }
    await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
    const lock = nav.getByRole('button', { name: 'Lock Tasks view', exact: true });
    await lock.scrollIntoViewIfNeeded();
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
    if (mobile) {
      const reserved = await page.locator('.content-scroll-area').evaluate(n => parseFloat(getComputedStyle(n).paddingBottom));
      expect(reserved).toBeGreaterThanOrEqual(68);
      const drawer = page.locator('#sol-primary-navigation');
      await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
      await expect(drawer).toHaveClass(/sidebar-mobile-open/);
      await expect(bottom).toBeHidden();
      await expect(drawer.locator('.expanded-sidebar-section-switcher')).toHaveCount(0);
      await expect(drawer.locator('.sidebar-nav')).toBeHidden();
      await expect(drawer.locator('.sidebar-scope-navigation')).toBeVisible();
      await expect(drawer.locator('.sidebar-workspace-trigger')).toBeVisible();
      await drawer.locator('.sidebar-workspace-trigger').click();
      await expect(drawer.locator('.sidebar-workspace-popover')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer.locator('.sidebar-workspace-popover')).toBeHidden();
      await drawer.focus();
      await page.keyboard.press('Escape');
      await expect(drawer).not.toHaveClass(/sidebar-mobile-open/);
      await expect(bottom).toBeVisible();
      await page.evaluate(() => { const s = Alpine.store('chat'); s.mobileNavOpen = true; s.navigateTo('chat', { syncRoute: false }); });
      await expect(drawer).not.toHaveClass(/sidebar-mobile-open/);
      await expect(bottom.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}
