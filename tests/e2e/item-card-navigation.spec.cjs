const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

// Production templates/navigation with isolated synthetic local records.
// No authenticated backend delivery or shared mutations are claimed.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
for (const width of [375, 1440]) for (const deck of [true, false]) {
  test(`item cards preserve mouse and keyboard navigation at ${width}px, Deck=${deck}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(deck => {
      const s = window.Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.fileMessages = s.messages.filter(m => !m.parent_message_id);
      s.selectedBoardId = '__all__';
      s.deckInboxEnabled = deck;
      s.navSection = 'status';
    }, deck);
    const root = page.locator(deck ? '[data-deck-column="inbox"]' : '.flightdeck-summary-grid');
    for (const kind of ['chat', 'task']) for (const activation of ['click', 'Enter', 'Space']) {
      await page.evaluate(() => { const s = window.Alpine.store('chat'); s.closeThread({ syncRoute: false }); s.showTaskDetail = false; s.navSection = 'status'; });
      if (deck && width < 769) await page.getByRole('button', { name: 'Show Inbox', exact: true }).click();
      const card = root.locator(`.flightdeck-summary-card-${kind}`).first();
      await expect(card).toBeVisible();
      await expect(card.locator('.attention-card-action')).toHaveCount(0);
      if (activation === 'click') await card.locator('.attention-card-title').click();
      else { await card.focus(); await card.press(activation); }
      if (kind === 'chat') await expect(page.locator('div.chat-thread-panel')).toBeVisible();
      else await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').editingTask?.record_id)).toBe('sol-task');
    }
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navSection = 'status'; s.showTaskDetail = false; });
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s._unreadTaskItems = { 'sol-task': true };
      s.isTowerPgMode = true;
      s._unreadThreadItems = { 'sol-thread': true };
      s._unreadChannels = { 'sol-channel': true };
      window.cardReceipts = [];
      s.markTaskRead = async id => { window.cardReceipts.push(id); return true; };
      s.markThreadRead = async id => { window.cardReceipts.push(id); return true; };
      s.applyTaskPatch = async (id, patch) => {
        s.tasks = s.tasks.map(row => row.record_id === id ? { ...row, ...patch } : row);
        return s.tasks.find(row => row.record_id === id);
      };
      s.tasks = s.tasks.map(row => ({ ...row, state: 'review' }));
    });
    if (deck && width < 769) await page.getByRole('button', { name: 'Show Inbox', exact: true }).click();
    for (const kind of ['chat', 'task']) {
      const read = root.locator(`.flightdeck-summary-card-${kind}`).first().getByRole('button', { name: 'Mark read', exact: true });
      await read.focus();
      await read.click();
      await expect.poll(() => page.evaluate(() => window.cardReceipts.length)).toBe(kind === 'chat' ? 1 : 2);
      expect(await page.evaluate(() => Boolean(window.Alpine.store('chat').activeThreadId || window.Alpine.store('chat').showTaskDetail))).toBe(false);
    }
    if (deck) {
      await root.getByRole('button', { name: 'Mark done', exact: true }).press('Space');
      await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').tasks[0].state)).toBe('done');
      expect(await page.evaluate(() => window.Alpine.store('chat').showTaskDetail)).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    console.log('ITEM_CARD_EVIDENCE', JSON.stringify({ width, deck, mouse: true, enter: true, space: true, noOverflow: true, markRead: true, markDone: deck }));
  });
}
