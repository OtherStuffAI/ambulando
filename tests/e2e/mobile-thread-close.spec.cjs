const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function prepare(page, width) {
  await page.setViewportSize({ width, height: 844 });
  const live = process.env.SOL_THREAD_CLOSE_LIVE === '1';
  if (live) await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(process.env.PLAYWRIGHT_BASE_URL).origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await openFixture(page, live, true);
}

for (const width of [390, 1120]) {
  test(`Deck X closes an unowned modal history entry at ${width}px`, async ({ page }) => {
    await prepare(page, width);
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navSection = 'status';
      s.fileMessages = [...s.messages];
      await s.openDeckThread('sol-channel', 'sol-thread', { syncRoute: false, scrollToLatest: false });
      // Route hydration historically marked a replaced/direct entry as modal,
      // despite never pushing a return entry. Back is a no-op in a new tab.
      history.replaceState({ section: 'status', deckThreadModal: true }, '', s.buildRouteUrl());
      window.closeRowsBefore = JSON.stringify(s.messages);
    });
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/threadid=/);
    expect(await page.evaluate(() => {
      const s = Alpine.store('chat');
      return { active: s.activeThreadId, channel: s.deckThreadChannelId, rows: JSON.stringify(s.messages) === window.closeRowsBefore };
    })).toEqual({ active: null, channel: '', rows: true });
  });

  test(`Deck cards, replacement navigation and close preserve drafts at ${width}px`, async ({ page }) => {
    await prepare(page, width);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navSection = 'status';
      s.deckInboxEnabled = false;
      s.summaryPanelCollapsed = {};
      s.startThreadLiveActivity = async () => {};
      s.loadDeckThreadHistoryPage = async () => {};
      s.fileMessages = [...s.messages, { ...s.messages[0], record_id: 'older-thread', pg_thread_id: 'older-thread', body: 'Older conversation' }];
      const rows = [
        { id: 'sol-thread', rootRecordId: 'sol-thread', channelId: 'sol-channel', title: 'Review connected chat', latestMessageUpdatedAt: '2026-10-09T01:00:00Z' },
        { id: 'older-thread', rootRecordId: 'older-thread', channelId: 'sol-channel', title: 'Older conversation', latestMessageUpdatedAt: '2026-10-08T01:00:00Z' },
      ];
      Object.defineProperty(s, 'autopilotOverviewThreads', { get: () => rows });
      Object.defineProperty(s, 'pagedAutopilotOverviewThreads', { get: () => rows });
      Object.defineProperty(s, 'visibleAutopilotOverviewInbox', { get: () => [] });
      s.startWorkspaceLiveQueries = () => {
        if (s.activeThreadId) s.applyMessages(s.fileMessages.filter(row => row.pg_thread_id === s.activeThreadId));
      };
      s.syncRoute(true);
      window.closeFileRowsBefore = JSON.stringify(s.fileMessages);
    });
    const cards = page.locator('[data-testid="flightdeck-summary-threads"] [aria-label="Open selected chat"]');
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await cards.first().click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => Boolean(history.state.deckThreadModalOrigin))).toBe(true);
    const editor = dialog.locator('[data-chat-composer="thread"]');
    await editor.fill('Retain this unsent reply');
    await dialog.getByRole('button', { name: 'Open older visible chat', exact: true }).click();
    await expect(page).toHaveURL(/threadid=older-thread/);
    await dialog.getByRole('button', { name: 'Open newer visible chat', exact: true }).click();
    await expect(editor).toHaveText('Retain this unsent reply');
    if (width < 769) {
      await dialog.locator('.thread-replies').evaluate(node => {
        getSelection().removeAllRanges();
        node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: 240, clientY: 250 })] }));
        node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: node, clientX: 120, clientY: 255 })] }));
      });
      await expect(page).toHaveURL(/threadid=older-thread/);
      await dialog.getByRole('button', { name: 'Open newer visible chat', exact: true }).click();
    }
    await dialog.getByRole('button', { name: 'Full screen', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/threadid=/);
    await page.goForward();
    await expect(dialog).toBeVisible();
    await expect(editor).toHaveText('Retain this unsent reply');
    await page.goBack();
    await expect(dialog).toBeHidden();
    await cards.first().click();
    await expect(dialog).toBeVisible();
    await expect(editor).toHaveText('Retain this unsent reply');
    // The margin around the bounded phone sheet belongs to the backdrop.
    await page.locator('.chat-thread-modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify(Alpine.store('chat').fileMessages) === window.closeFileRowsBefore)).toBe(true);
  });

  test(`route replacement never invents a return entry at ${width}px`, async ({ page }) => {
    await prepare(page, width);
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navSection = 'status';
      await s.openDeckThread('sol-channel', 'sol-thread', { syncRoute: false, scrollToLatest: false });
      history.replaceState(null, '', '/be-free/flight-deck?threadid=sol-thread');
      s.syncRoute(true);
    });
    expect(await page.evaluate(() => history.state.deckThreadModalOrigin)).toBeUndefined();
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/threadid=/);
  });

  test(`one X closes after a linked thread pushes another modal entry at ${width}px`, async ({ page }) => {
    await prepare(page, width);
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.navSection = 'status';
      s.syncRoute(true);
      await s.openDeckThread('sol-channel', 'sol-thread', { scrollToLatest: false });
      await s.openDeckThread('sol-channel', 'linked-thread', { scrollToLatest: false, captureReturnContext: false });
    });
    expect(await page.evaluate(() => history.state.deckThreadModalOrigin)).toBeUndefined();
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/threadid=/);
  });
}
