const { expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./serve-built-flightdeck.cjs');
async function openFixture(page, routeInstalled = false) {
  if (!routeInstalled) await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'stopTaskCommentsLiveQuery', 'startTaskCommentsLiveQuery', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead', 'scheduleDocAutosave', 'clearInactiveSectionData']) s[key] = () => {};
    s.openConnectModal = () => {};
    s.showConnectModal = false;
    s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'npub1solfixture' };
    s.backendUrl = 'http://127.0.0.1:3100';
    s.pgBackendMode = false;
    s.isTowerPgMode = false;
    s.error = null;
    s.getSenderName = npub => npub === 'npub1solfixture' ? 'Design reviewer' : 'Implementation agent';
    const now = '2026-10-09T01:00:00.000Z';
    const row = { record_state: 'active', sync_status: 'synced', created_at: now, updated_at: now, version: 1 };
    s.channels = [{ ...row, record_id: 'sol-channel', title: 'Design implementation', name: 'Design implementation', metadata: {} }];
    s.selectedChannelId = 'sol-channel';
    s.pgContextSelectedChannelId = 'sol-channel';
    s.messages = [
      { ...row, record_id: 'sol-thread', thread_id: 'sol-thread', pg_thread_id: 'sol-thread', parent_message_id: null, channel_id: 'sol-channel', sender_npub: 'npub1solfixture', metadata: {}, body: 'Review the connected Ambulando interface. Keep existing conversations, tasks and documents working.' },
      { ...row, record_id: 'sol-reply', thread_id: 'sol-thread', pg_thread_id: 'sol-thread', parent_message_id: 'sol-thread', channel_id: 'sol-channel', sender_npub: 'npub1solagent', metadata: {}, body: 'The proposed design preserves local drafts. This fixture does not claim live delivery or backend authorization.' },
    ];
    s.tasks = [{ ...row, record_id: 'sol-task', title: 'Review connected frontend', description: '## Expected outcome\n\nPreserve existing behavior while applying semantic light and dark surfaces.\n\n- Review keyboard focus\n- Verify narrow reflow\n\n' + 'Long content remains readable. '.repeat(35), state: 'in_progress', assigned_to_npubs: [], predecessor_task_ids: [], tags: '', pg_channel_id: 'sol-channel' }];
    s.documents = [{ ...row, record_id: 'sol-doc', owner_npub: 'npub1solfixture', title: 'Connected design review', content: '# Connected design review\n\nThe browser remains the working application.\n\n' + 'A long paragraph exercises readable document width and scrolling. '.repeat(25), shares: [], group_ids: [] }];
    s.documents.push({ ...row, record_id:'sol-file', owner_npub:'npub1solfixture', title:'Mobile layout review.pdf', content:'[Mobile layout review.pdf](storage://sol-file-object)', pg_record_type:'file', pg_storage_object_id:'sol-file-object', content_storage_content_type:'application/pdf', shares:[], group_ids:[] });
    s.directories = [];
    s.loadTaskComments = async () => s.applyTaskComments([{ ...row, record_id: 'sol-comment', sender_npub: 'npub1solfixture', body: 'Review the fixture before approving the redesign.' }]);
    s.navSection = 'chat';
    s.openThread('sol-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
  });
  await expect(page.locator('div.chat-thread-panel')).toBeVisible();
}

module.exports = { openFixture };
