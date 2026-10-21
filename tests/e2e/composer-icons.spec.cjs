const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
for (const width of [320, 390, 768, 1440]) for (const theme of ['light', 'dark']) {
  test(`stacked composer icons ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(theme => {
      Alpine.store('appearance').setTheme(theme);
      const s = Alpine.store('chat');
      window.composerCalls = [];
      s.sendThreadReply = () => window.composerCalls.push('reply');
      s.sendDeckThread = () => window.composerCalls.push('start');
      s.openAudioRecorder = () => window.composerCalls.push('audio');
    }, theme);
    const panel = page.locator('div.chat-thread-panel');
    const actions = panel.locator('.thread-input-actions');
    const menu = actions.getByRole('button', { name: 'Menu', exact: true });
    const send = actions.locator('.thread-reply-btn');
    const input = panel.locator('[data-chat-composer="thread"]');
    await input.fill('A draft that survives menu interactions');
    for (const mode of ['reply', 'start']) {
      await page.evaluate(mode => {
        const s = Alpine.store('chat');
        s.deckThreadComposerOpen = mode === 'start';
        if (mode === 'start') {
          s.deckThreadChannelState = 'ready';
          s.deckThreadChannelId = 'sol-channel';
        }
      }, mode);
      await expect(send).toHaveAttribute('aria-label', mode === 'start' ? 'Start thread' : 'Reply');
      await expect(send).toBeEnabled();
      await expect(menu).toHaveAttribute('title', 'Menu');
      for (const button of [menu, send]) {
        await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
        expect((await button.innerText()).trim()).toBe('');
      }
      const m = await menu.boundingBox(), b = await send.boundingBox();
      expect(Math.abs(m.x - b.x)).toBeLessThan(1);
      expect(b.y).toBeGreaterThanOrEqual(m.y + m.height);
      expect(b.width).toBe(width <= 768 ? 44 : 36);
      expect(b.height).toBeGreaterThanOrEqual(width <= 768 ? 44 : 36);
      expect(b.x + b.width).toBeLessThanOrEqual(width);
      await menu.focus(); await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await panel.getByRole('menuitem', { name: 'Record Audio', exact: true }).click();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(input).toHaveText('A draft that survives menu interactions');
      await send.focus(); await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.composerCalls)).toContain(mode);
      await page.evaluate(() => { Alpine.store('chat').composerSendPending.thread = true; });
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute('aria-busy', 'true');
      await expect(send).toHaveAttribute('title', mode === 'start' ? 'Starting…' : 'Sending…');
      await page.evaluate(() => { Alpine.store('chat').composerSendPending.thread = false; });
    }
    await page.evaluate(() => {
      const s = Alpine.store('chat'); s.deckThreadComposerOpen = false;
      s.isEditingMessage = () => true;
    });
    await expect(send).toHaveAttribute('aria-label', 'Save');
    await page.evaluate(() => { Alpine.store('chat').messageEdit.submitting = true; });
    await expect(send).toHaveAttribute('aria-label', 'Saving…');
    await expect(send).toBeDisabled();
    console.log('COMPOSER_ICONS', JSON.stringify({ width, theme, menu: await menu.boundingBox(), send: await send.boundingBox() }));
  });
}
