const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 320]) {
  test(`own profile dismisses and reopens at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      const npub = s.session.npub;
      s.chatProfiles[npub] = { name: 'Sample Reviewer', about: 'Profile interaction regression' };
      s.messages = [...s.messages, { ...s.messages[0], record_id: 'other-thread', thread_id: 'other-thread', pg_thread_id: 'other-thread', body: 'Another conversation' }];
      // Keep clipboard deterministic while exercising the production Copy handler.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedProfile = value; } } });
    });
    const card = page.locator('.identity-card-popover');
    const ownAvatar = page.locator('.chat-thread-panel .identity-avatar-button').first();
    const openOwn = async () => {
      await ownAvatar.click();
      await expect(card).toBeVisible();
      expect(await page.evaluate(() => Alpine.store('chat').identityCard.npub)).toBe(await page.evaluate(() => Alpine.store('chat').session.npub));
      await expect(card).toContainText('Profile interaction regression');
    };
    await openOwn();
    await card.locator('.identity-card-bio').click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.copiedProfile)).toBe('npub1solfixture');
    await card.getByRole('button', { name: 'Close profile card' }).click();
    await expect(card).toHaveCount(0);
    // The production copied-state timer used to resurrect the hidden card.
    await page.waitForTimeout(1600);
    await expect(card).toHaveCount(0);
    await openOwn();
    // This click bubbles only as far as the thread panel's @click.stop.
    await page.locator('[data-chat-composer="thread"]').click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.chat-thread-panel')).toBeVisible();
    await openOwn();
    // Navigation must dismiss independently of any document click listener.
    await page.evaluate(() => Alpine.store('chat').openThread('other-thread', { scrollToLatest: false, syncRoute: false }));
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => Alpine.store('chat').activeThreadId)).toBe('other-thread');
    await openOwn();
    await page.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.chat-thread-panel')).toBeHidden();
    await page.evaluate(() => Alpine.store('chat').openThread('sol-thread', { scrollToLatest: false, syncRoute: false }));
    await openOwn();
    await card.getByRole('button', { name: 'Close profile card' }).click();
    await expect(card).toHaveCount(0);
  });
}
