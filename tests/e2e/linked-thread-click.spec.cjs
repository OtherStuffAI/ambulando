const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

for (const width of [1120, 390]) for (const kind of ['message', 'thread']) {
  test(`linked message opens another scope in the modal with ${kind} ID and Back/Forward at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => {
      if (process.env.FLIGHTDECK_LINKED_RUNTIME === '1') {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
    await page.evaluate(async kind => {
      const s = window.Alpine.store('chat');
      s.session = { npub: 'npub1linkedthreadtest' };
      s.showConnectModal = false;
      s.navSection = 'status';
      s.selectedBoardId = 'all';
      s.selectedChannelId = 'source-channel';
      s.channels = [
        { record_id: 'source-channel', title: 'Source channel', scope_id: 'source-scope', record_state: 'active' },
        { record_id: 'target-channel', title: 'Target channel', scope_id: 'target-scope', record_state: 'active' },
      ];
      const message = (id, channel, thread, body) => ({ record_id: id, channel_id: channel, pg_thread_id: thread,
        sender_npub: 'npub1linkedthreadtest', parent_message_id: null, body, record_state: 'active',
        created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', sync_status: 'synced' });
      s.fileMessages = [
        message('source-message', 'source-channel', 'source-thread', `Follow @[Linked design thread](mention:${kind}:target-${kind}) and @[Missing thread](mention:message:missing-message)`),
        message('target-message', 'target-channel', 'target-thread', 'The referenced conversation is loaded.'),
      ];
      s.fileMessages.push({ ...message('target-thread', 'target-channel', 'target-thread', 'Target title'), pg_record_type: 'thread', pg_source_message_id: 'target-message', pg_effective_message_ids: ['target-message'] });
      s.messages = [s.fileMessages[0]];
      s.requestTowerSyncFamily = async () => { throw new Error('This linked thread is unavailable.'); };
      s.startWorkspaceLiveQueries = () => {
        // Replace only content delivery; exercise real click dispatch, modal opening and routes.
        s.applyMessages(s.fileMessages.filter(row => row.channel_id === s.deckThreadChannelId));
      };
      s.startThreadLiveActivity = async () => {};
      s.markTowerPgResourceViewed = async () => {};
      s.loadDeckThreadHistoryPage = async () => {};
      s.scheduleStorageImageHydration = () => {};
      s.syncRoute(true);
      await s.openDeckThread('source-channel', 'source-message', { towerThreadId: 'source-thread', scrollToLatest: false });
      s.threadInput = 'Keep the source draft';
    }, kind);
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('link', { name: 'chat Missing thread', exact: true }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Could not open linked thread' })).toBeVisible();
    await expect(dialog).toContainText('Linked design thread');
    await expect(dialog.getByRole('link', { name: 'chat Linked design thread', exact: true })).toHaveAttribute('data-mention-id', `target-${kind}`);
    await dialog.getByRole('link', { name: 'chat Linked design thread', exact: true }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Could not open linked thread' })).toBeHidden();
    await expect(dialog).toContainText('The referenced conversation is loaded.');
    // Message projection normalizes ordinary thread identities to their source row.
    await expect(page).toHaveURL(/channelid=target-channel.*threadid=target-message/);
    expect(await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      return { section: s.navSection, channel: s.selectedChannelId, board: s.selectedBoardId, scroll: s.pendingThreadScrollToLatest };
    })).toEqual({ section: 'status', channel: 'source-channel', board: 'all', scroll: false });
    expect(await page.evaluate(() => window.Alpine.store('chat').threadInput)).toBe('');
    await page.evaluate(() => { window.Alpine.store('chat').threadInput = 'Keep the target draft'; });
    await page.goBack();
    await expect(dialog).toContainText('Linked design thread');
    expect(await page.evaluate(() => window.Alpine.store('chat').threadInput)).toBe('Keep the source draft');
    await page.goForward();
    await expect(dialog).toContainText('The referenced conversation is loaded.');
    expect(await page.evaluate(() => window.Alpine.store('chat').threadInput)).toBe('Keep the target draft');
    await page.goBack(); await page.goBack();
    await expect(dialog).toHaveCount(0);
  });
}
