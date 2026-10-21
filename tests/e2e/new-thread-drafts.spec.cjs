const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
for (const width of [390, 1120]) {
  test(`new-thread drafts survive dismissal and sends at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      s.channels[0].scope_id = 'scope-a';
      s.channels.push({ ...s.channels[0], record_id: 'other-channel', scope_id: 'scope-b' });
      s.prepareDeckComposerChannel = async id => { s.selectedChannelId = id; return true; };
      s.resolvePgWriteContext = () => ({ scopeId: 'scope-a', channelId: s.selectedChannelId });
      s.openDeckThread = async () => {};
      s.sendMessage = async () => false;
    });
    await page.evaluate(() => Alpine.store('chat').openDeckThreadComposer());
    const dialog = page.getByRole('dialog', { name: 'Create thread', exact: true });
    const editor = dialog.locator('[data-chat-composer="thread"]');
    const body = 'Unsent @[Helper](mention:agent:npub1helper) with attachment';
    await editor.fill(body);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.editDeckThreadCreateTitle('Keep this title');
      // Hydrate through the production mention composer; attachment upload has
      // already completed in this synthetic fixture.
      s.commitMentionComposerDraft('thread');
      s.syncMentionComposerFromModel(document.querySelector('[data-chat-composer="thread"]'), 'thread', s.threadInput);
      s.threadFileDrafts = [{ draft_id: 'prepared', status: 'ready', filename: 'draft.txt', storage_object_id: 'prepared-object', kind: 'file' }];
      window.draftRequestId = s.deckThreadCreateRequestId;
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.evaluate(() => Alpine.store('chat').openDeckThreadComposer());
    await expect(editor).toContainText('Unsent');
    await expect(editor.locator('[data-mention-token]')).toHaveCount(1);
    expect(await page.evaluate(() => {
      const s = Alpine.store('chat');
      return { title: s.threadTitleDraft, file: s.threadFileDrafts[0]?.storage_object_id, request: s.deckThreadCreateRequestId === window.draftRequestId };
    })).toEqual({ title: 'Keep this title', file: 'prepared-object', request: true });
    await page.locator('.chat-thread-modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeHidden();
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.selectedChannelId = 'other-channel';
      await s.openDeckThreadComposer();
    });
    await expect(editor).toBeEmpty();
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.selectedChannelId = 'sol-channel';
      await s.openDeckThreadComposer();
      await s.sendDeckThread();
    });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => Alpine.store('chat').openDeckThreadComposer());
    await expect(editor).toContainText('Unsent');
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.sendMessage = async () => ({ record_id: 'accepted', pg_thread_id: 'accepted-thread' });
      await s.sendDeckThread();
      await s.openDeckThreadComposer();
    });
    await expect(editor).toBeEmpty();
    expect(await page.evaluate(() => Alpine.store('chat').threadFileDrafts)).toEqual([]);
  });
}
