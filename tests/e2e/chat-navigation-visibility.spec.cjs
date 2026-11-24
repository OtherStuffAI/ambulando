const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'off' });
for (const width of [390, 1440]) {
  test(`Chat visibility preserves conversation access at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    const chat = page.locator('button[aria-label="Chat"]:visible');
    expect(await page.evaluate(() => Alpine.store('chat').chatNavigationEnabled)).toBe(false);
    await expect(chat).toHaveCount(0);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.threadInput = 'Retain this unsent reply';
      s.inputText = 'Retain channel draft';
      s.navSection = 'settings'; s.settingsTab = 'deck';
    });
    const toggle = page.getByTestId('chat-navigation-enabled');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').chatNavigationEnabled)).toBe(true);
    await page.evaluate(() => { Alpine.store('chat').navSection = 'chat'; });
    const navigation = page.locator(width < 800 ? '.mobile-section-switcher' : '.sidebar-nav');
    await expect(navigation.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(1);
    const labels = await page.locator(width < 800 ? '.mobile-section-switcher button.mobile-section-switcher-btn:visible' : '.sidebar-nav button:visible').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
    expect(labels.indexOf('Chat')).toBe(labels.indexOf('Deck') + 1);
    await page.evaluate(() => { const s = Alpine.store('chat'); s.navSection = 'settings'; });
    await toggle.uncheck();
    await page.evaluate(() => { Alpine.store('chat').navSection = 'chat'; });
    await expect(chat).toHaveCount(0);
    expect(await page.evaluate(() => {
      const s = Alpine.store('chat'); return [s.activeThreadId, s.threadInput, s.inputText];
    })).toEqual(['sol-thread', 'Retain this unsent reply', 'Retain channel draft']);
    // Changing the preference itself must not navigate or clear an active thread.
    await page.evaluate(async () => {
      const s = Alpine.store('chat'); await s.setChatNavigationEnabled(true); await s.setChatNavigationEnabled(false);
    });
    await expect(page.locator('div.chat-thread-panel')).toBeVisible();
    expect(await page.evaluate(() => Alpine.store('chat').navSection)).toBe('chat');
    await page.evaluate(() => {
      const s = Alpine.store('chat'); s.closeThread({ syncRoute: false });
      s.navSection = 'status';
      s.openThread('sol-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
    });
    await expect(page.locator('div.chat-thread-panel')).toBeVisible();
    await expect(chat).toHaveCount(0);
    await page.evaluate(async () => Alpine.store('chat').setChatNavigationEnabled(true));
    await page.reload();
    await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
    expect(await page.evaluate(() => Alpine.store('chat').chatNavigationEnabled)).toBe(true);
    await openFixture(page);
    await page.evaluate(async () => Alpine.store('chat').setChatNavigationEnabled(false));
    await page.reload();
    await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
    expect(await page.evaluate(() => Alpine.store('chat').chatNavigationEnabled)).toBe(false);
  });
}
