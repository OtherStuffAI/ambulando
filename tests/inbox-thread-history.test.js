import { threadHistoryLineage } from '../src/thread-history-coverage.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
import { openWorkspaceDb, deleteWorkspaceDb, getWorkspaceDb, getThreadMessagePresentationWindow } from '../src/db.js';
import { mapPgThreadToLocal, mapPgMessageToLocal, readTowerPgThreadHistoryPage, hydrateTowerPgSyncBundle, towerPgSyncCursorKey } from '../src/pg-read-hydrator.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { buildAutopilotOverviewThreads, autopilotOverviewManagerMixin } from '../src/autopilot-overview-manager.js';
import { sectionLiveQueryMixin } from '../src/section-live-queries.js';
import { instrumentIndexedDb } from './helpers/indexeddb-metrics.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

const key = 'inbox-thread-history-test';
const rawThread = id => ({ id, channel_id: 'channel-a', workspace_id: 'workspace-a', source_message_id: `${id}-source`, title: id, created_at: '2026-01-01T00:00:00Z', row_version: 1 });
const rawMessage = (id, n) => ({ id: n === 0 ? `${id}-source` : `${id}-${n}`, thread_id: id, channel_id: 'channel-a', workspace_id: 'workspace-a', body: `${id} reply ${n}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), row_version: 1 });
async function seed(id, count) {
  const thread = rawThread(id);
  const options = { threadById: new Map([[id, thread]]) }; // ownerless installed-cache compatibility
  await getWorkspaceDb().chat_messages.bulkPut([mapPgThreadToLocal(thread), ...Array.from({ length: count }, (_, n) => mapPgMessageToLocal(rawMessage(id, n), options))]);
}
const subscriptions = [];
afterEach(async () => { subscriptions.splice(0).forEach(sub => sub.unsubscribe()); await deleteWorkspaceDb(key); });
function store() {
  const s = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(chatMessageManagerMixin), ...Object.getOwnPropertyDescriptors(autopilotOverviewManagerMixin), ...Object.getOwnPropertyDescriptors(sectionLiveQueryMixin) });
  Object.assign(s, {
    currentWorkspaceKey: key, workspaceOwnerNpub: 'owner', currentWorkspace: { workspaceId: 'workspace-a' },
    navSection: 'status', selectedChannelId: 'unrelated-channel', selectedBoardId: 'all',
    messages: [], channels: [], audioNotes: [], fileMessages: [], fileComments: [], scopes: [], tasks: [], documents: [],
    THREAD_REPLY_PAGE_SIZE: 6, mainFeedVisibleCount: 21, threadVisibleReplyCount: 6,
    summaryPanelPages: {}, summaryCollapsedPanels: {},
    saveChatComposerDraft() {}, restoreChatComposerDraft() {}, syncRoute() {},
    captureScrollAnchor() {}, restoreScrollAnchor() {}, syncChatPreviewState() {}, scheduleChatPreviewMeasurement() {},
    scheduleStorageImageHydration() {}, scheduleThreadRepliesScrollToBottom() {}, updateResponseActivityTimer() {},
    applyAgentActivities() {}, applyAddressBookPeople() {}, applyFileMessages() {}, applyFileComments() {},
    applyDocuments() {}, applyTasks() {}, applyScopes() {}, applyChannels() {}, applyDailyNotes() {}, applyWapps() {},
    applyDirectories() {},
    createLiveSubscription(query, onNext) { const sub = liveQuery(query).subscribe({ next: onNext }); subscriptions.push(sub); return sub; },
    stopLiveSubscription(sub) { sub.unsubscribe(); },
  });
  return s;
}

describe('real Inbox thread history path', () => {
  it('counts and renders content once for metadata/source navigation, rename and identical bodies', async () => {
    openWorkspaceDb(key); await seed('thread-a', 1);
    const db = getWorkspaceDb();
    await db.chat_messages.update('thread-a', { pg_effective_message_ids: ['thread-a-source'], title: 'Metadata title' });
    const s = store();
    for (const rootRecordId of ['thread-a', 'thread-a-source']) {
      await s.openAutopilotOverviewThread({ id: 'thread-a', rootRecordId, channelId: 'channel-a' });
      await vi.waitFor(() => expect(s.threadHasLocalContent).toBe(true));
      const parent = s.getThreadParentMessage();
      const bubbles = [...(parent?.pg_record_type !== 'thread' && parent ? [parent] : []), ...s.visibleThreadMessages];
      expect(bubbles.map(row => row.record_id)).toEqual(['thread-a-source']);
      expect(s.getThreadMessageCount(rootRecordId)).toBe(1);
      expect(s.getActiveThreadTitle()).toBe('Metadata title');
    }
    await db.chat_messages.update('thread-a', { title: 'Renamed', body: 'Renamed', version: 2 });
    await vi.waitFor(() => expect(s.getActiveThreadTitle()).toBe('Renamed'));
    const rows = await db.chat_messages.toArray();
    const build = messages => buildAutopilotOverviewThreads({ channels: [{ record_id: 'channel-a' }], messages });
    for (const messages of [rows, [...rows].reverse()]) {
      expect(build(messages)[0]).toMatchObject({ messageCount: 1, rootRecordId: 'thread-a-source', title: 'Renamed', latestMessage: 'thread-a reply 0' });
    }
    await db.chat_messages.put({ ...rows.find(row => row.pg_record_type === 'message'), record_id: 'same-body', parent_message_id: 'thread-a-source' });
    expect(build(await db.chat_messages.toArray())[0].messageCount).toBe(2);
  });

  it('renders source-less inherited branches without a title bubble and honors revocation', async () => {
    openWorkspaceDb(key); await seed('ancestor', 3);
    const db = getWorkspaceDb(); const s = store();
    const thread = { ...rawThread('branch'), source_message_id: null, parent_thread_id: 'ancestor', branch_point_message_id: 'ancestor-2' };
    await hydrateTowerPgSyncBundle(s, { thread_history_page: { channelId: 'channel-a', thread,
      messages: [1, 2].map(n => ({ ...rawMessage('ancestor', n), inherited: true, read_only: true, effective_thread_id: 'branch' })), nextCursor: null } });
    await s.openAutopilotOverviewThread({ id: 'branch', rootRecordId: 'branch', channelId: 'channel-a' });
    await vi.waitFor(() => expect(s.visibleThreadMessages).toHaveLength(2));
    expect(s.visibleThreadMessages.every(row => row.pg_record_type === 'message' && row.read_only)).toBe(true);
    expect(s.getThreadMessageCount('branch')).toBe(2);
    await db.pg_record_rows.put({ key: 'message:ancestor-2', family: 'message', id: 'ancestor-2', operation: 'delete' });
    await vi.waitFor(() => expect(s.visibleThreadMessages.map(row => row.record_id)).toEqual(['ancestor-1']));
    await db.pg_record_rows.put({ key: 'thread:branch', family: 'thread', id: 'branch', operation: 'delete' });
    await vi.waitFor(() => expect(s.messages).toEqual([]));
    expect(s.threadHasLocalContent).toBe(false);
  });

  it('publishes the latest local rows with stalled/offline refresh and retains matching content only', async () => {
    openWorkspaceDb(key); await seed('thread-a', 12); await seed('thread-b', 2);
    const s = store();
    s.requestTowerSyncFamily = vi.fn(() => new Promise(() => {}));
    await s.openAutopilotOverviewThread({ id: 'thread-a', rootRecordId: 'thread-a', channelId: 'channel-a' });
    await vi.waitFor(() => expect(s.visibleThreadMessages.at(-1)?.body).toBe('thread-a reply 11'));
    expect(s.threadHistoryLoading).toBe(true);
    expect(s.threadHasLocalContent).toBe(true);
    await getWorkspaceDb().chat_messages.update('thread-a-11', { body: 'Latest local inbox content', version: 2 });
    await vi.waitFor(() => expect(s.visibleThreadMessages.at(-1)?.body).toBe('Latest local inbox content'));
    s.openThread('thread-a', { scrollToLatest: false });
    expect(s.visibleThreadMessages.at(-1)?.body).toBe('Latest local inbox content');
    s.requestTowerSyncFamily = vi.fn(async () => { throw new Error('offline'); });
    await s.openAutopilotOverviewThread({ id: 'thread-b', rootRecordId: 'thread-b', channelId: 'channel-a' });
    expect(s.messages.some(row => row.pg_thread_id === 'thread-a')).toBe(false);
    await vi.waitFor(() => expect(s.visibleThreadMessages.at(-1)?.body).toBe('thread-b reply 1'));
    await vi.waitFor(() => expect(s.threadHistoryError).toBe('offline'));
    expect(s.threadHasLocalContent).toBe(true);
  });

  it('restores fresh continuation and invalidates it on version/activity/authority or lineage changes', async () => {
    openWorkspaceDb(key); await seed('thread-a', 3);
    const s = store(); const db = getWorkspaceDb();
    await hydrateTowerPgSyncBundle(s, { thread_history_page: { channelId: 'channel-a', thread: rawThread('thread-a'), messages: [rawMessage('thread-a', 0)], nextCursor: 'next' } });
    const historyRead = vi.fn(async () => ({ nextCursor: 'next' }));
    s.requestTowerSyncFamily = (family, ...args) => family === 'thread-history-page' ? historyRead(...args) : Promise.resolve();
    const open = async () => {
      await s.openAutopilotOverviewThread({ id: 'thread-a', rootRecordId: 'thread-a', channelId: 'channel-a' });
      await vi.waitFor(() => expect(s.threadHistoryLoading).toBe(false));
    };
    await open();
    expect(s.threadHistoryCursor).toBe('next');
    expect(historyRead).not.toHaveBeenCalled();
    await db.chat_messages.update('thread-a', { activity_version: 2 });
    await open(); expect(historyRead).toHaveBeenCalledTimes(1);
    expect(historyRead.mock.calls[0][1].cursor).toBeNull();
    await db.chat_messages.update('thread-a', { activity_version: 0, version: 2 });
    await open(); expect(historyRead).toHaveBeenCalledTimes(2);
    await db.chat_messages.update('thread-a', { version: 1, pg_parent_thread_id: 'ancestor' });
    await open(); expect(historyRead).toHaveBeenCalledTimes(3);
    await db.chat_messages.update('thread-a', { pg_parent_thread_id: null });
    await db.sync_state.put({ key: `${towerPgSyncCursorKey(s)}:record-delta-v1`, value: { cursor: 'new-authority' } });
    await open(); expect(historyRead).toHaveBeenCalledTimes(4);
  });

  it('opens canonical ownerless history beyond Inbox sources and selected-channel windows, pages and follows edits/deletes', async () => {
    openWorkspaceDb(key); await seed('thread-a', 241); await seed('thread-b', 131);
    const s = store();
    s.markTowerPgResourceViewed = vi.fn();
    await s.openAutopilotOverviewThread({ id: 'thread-a', rootRecordId: 'thread-a-source', channelId: 'channel-a' });
    await vi.waitFor(() => expect(s.visibleThreadMessages.map(row => row.body)).toEqual(Array.from({ length: 6 }, (_, i) => `thread-a reply ${235 + i}`)));
    expect(s.selectedChannelId).toBe('unrelated-channel');
    expect(s.markTowerPgResourceViewed).toHaveBeenCalledWith('thread', 'thread-a', undefined);
    expect(s.fileMessages).toEqual([]);
    expect(s.messages.length).toBeLessThanOrEqual(9);
    await s.showMoreThreadMessages();
    await vi.waitFor(() => expect(s.visibleThreadMessages).toHaveLength(240));
    await vi.waitFor(() => expect(s.visibleThreadMessages.some(row => row.body === 'thread-a reply 1')).toBe(true));
    await getWorkspaceDb().chat_messages.update('thread-a-240', { body: 'edited reply', version: 2 });
    await vi.waitFor(() => expect(s.visibleThreadMessages.some(row => row.body === 'edited reply')).toBe(true));
    await getWorkspaceDb().chat_messages.delete('thread-a-240');
    await vi.waitFor(() => expect(s.visibleThreadMessages.some(row => row.body === 'edited reply')).toBe(false));
    await s.openAutopilotOverviewThread({ id: 'thread-b', rootRecordId: 'thread-b', channelId: 'channel-a' });
    await s.openAutopilotOverviewThread({ id: 'thread-a', rootRecordId: 'thread-a-source', channelId: 'channel-a' });
    await vi.waitFor(() => expect(s.visibleThreadMessages.at(-1)?.body).toBe('thread-a reply 239'));
    expect(s.messages.every(row => row.pg_thread_id === 'thread-a')).toBe(true);
    await s.reconcileDeckThreadMessages([{ record_id: 'preview', channel_id: 'channel-a', parent_message_id: s.activeThreadId }]);
    expect(s.messages.some(row => row.record_id === 'preview')).toBe(false);
  });

  it('loads overlapping inherited pages in one click with ordered, unique persisted replies', async () => {
    openWorkspaceDb(key);
    await seed('branch-all', 1);
    const s = store();
    s.activeThreadId = 'branch-all-source';
    s.deckThreadTowerId = 'branch-all';
    s.deckThreadChannelId = 'channel-a';
    s.captureScrollAnchor = vi.fn(() => ({ id: 'visible-message', offset: 40 }));
    s.restoreScrollAnchor = vi.fn();
    s.requestTowerSyncFamily = vi.fn(async (_family, _key, options) => {
      const numbers = options.cursor ? [2, 3, 4] : [1, 2];
      return hydrateTowerPgSyncBundle(s, { thread_history_page: {
        channelId: 'channel-a', thread: rawThread('branch-all'), cursor: options.cursor,
        nextCursor: options.cursor ? null : 'page-2',
        messages: numbers.map(n => ({ ...rawMessage('ancestor', n), inherited: true, effective_thread_id: 'branch-all' })),
      } });
    });
    await s.showMoreThreadMessages();
    expect(s.requestTowerSyncFamily).toHaveBeenCalledTimes(2);
    expect(s.visibleThreadMessages.map(row => row.record_id)).toEqual(['ancestor-1', 'ancestor-2', 'ancestor-3', 'ancestor-4']);
    expect(s.visibleThreadMessages.every(row => row.pg_inherited && row.read_only)).toBe(true);
    expect(s.threadHistoryCursor).toBeNull();
    expect(s.threadHistoryError).toBe('');
    expect(s.restoreScrollAnchor).toHaveBeenCalledWith({ id: 'visible-message', offset: 40, atBottom: false });
  });

  it('invalidates a previously read derived window after an incremental collection revision', async () => {
    openWorkspaceDb(key); await seed('edited', 8);
    const s = store(); s.activeThreadId = 'edited';
    s.messages = await getThreadMessagePresentationWindow('channel-a', 'edited');
    expect(s.visibleThreadMessages.at(-1).body).toBe('edited reply 7');
    const index = s.messages.findIndex(row => row.record_id === 'edited-7');
    s.messages.splice(index, 1, { ...s.messages[index], body: 'Updated body', version: 2 });
    s.messageCollectionRevision = 1;
    expect(s.visibleThreadMessages.at(-1).body).toBe('Updated body');
  });

  it('retains inherited transcript coverage after a canonical thread metadata update', async () => {
    openWorkspaceDb(key); await seed('ancestor', 3); await seed('branch', 2);
    const db = getWorkspaceDb();
    await db.sync_state.put({ key: 'thread-history-page:branch', value: { lineage: threadHistoryLineage(rawThread('branch')), messageIds: ['ancestor-1', 'branch-1'], nextCursor: null } });
    await db.chat_messages.update('ancestor-1', { read_only: true, pg_inherited: true });
    await db.chat_messages.put({ ...mapPgThreadToLocal(rawThread('branch')), title: 'Updated branch', version: 2 });
    const rows = await getThreadMessagePresentationWindow('channel-a', 'branch');
    expect(rows.find(row => row.record_id === 'ancestor-1')).toMatchObject({ parent_message_id: 'branch', read_only: true, pg_inherited: true });
  });

  it('preserves a complete inherited transcript across first partial page and reopen', async () => {
    openWorkspaceDb(key); await seed('ancestor', 241); await seed('branch', 1);
    const db = getWorkspaceDb();
    const ids = Array.from({ length: 240 }, (_, n) => `ancestor-${n + 1}`);
    await db.chat_messages.update('branch', { pg_effective_message_ids: ids });
    const s = store();
    const page = { channelId: 'channel-a', thread: rawThread('branch'), cursor: null,
      nextCursor: '100', messages: Array.from({ length: 100 }, (_, n) => ({ ...rawMessage('ancestor', n + 1), inherited: true, effective_thread_id: 'branch' })) };
    expect((await getThreadMessagePresentationWindow('channel-a', 'branch')).at(-1).record_id).toBe('ancestor-240');
    await hydrateTowerPgSyncBundle(s, { thread_history_page: page });
    for (const root of ['branch', 'branch-source']) {
      const metrics = instrumentIndexedDb();
      try {
        expect((await getThreadMessagePresentationWindow('channel-a', root, { threadId: 'branch' })).at(-1).record_id).toBe('ancestor-240');
        expect(metrics.snapshot().valueRowsRead).toBeLessThanOrEqual(20);
      } finally { metrics.restore(); }
    }
    await hydrateTowerPgSyncBundle(s, { thread_history_page: page });
    expect((await db.chat_messages.get('branch')).pg_effective_message_ids).toEqual(ids);
  });

  it('clamps broad branch-history pages to the selected branch point', async () => {
    openWorkspaceDb(key); await seed('ancestor', 4); await seed('branch', 1);
    const db = getWorkspaceDb(); const s = store();
    const branchThread = { ...rawThread('branch'), parent_thread_id: 'ancestor', branch_point_message_id: 'ancestor-2' };
    await db.chat_messages.put(mapPgThreadToLocal(branchThread));
    await hydrateTowerPgSyncBundle(s, { thread_history_page: {
      channelId: 'channel-a',
      thread: branchThread,
      messages: [
        { ...rawMessage('ancestor', 1), inherited: true, effective_thread_id: 'branch' },
        { ...rawMessage('ancestor', 2), inherited: true, effective_thread_id: 'branch' },
        { ...rawMessage('ancestor', 3), inherited: true, effective_thread_id: 'branch' },
        rawMessage('branch', 1),
      ],
      nextCursor: null,
    } });

    expect((await db.chat_messages.get('branch')).pg_effective_message_ids).toEqual(['ancestor-1', 'ancestor-2', 'branch-1']);
    const rows = await getThreadMessagePresentationWindow('channel-a', 'branch');
    expect(rows.map(row => row.record_id)).toEqual(expect.arrayContaining(['ancestor-1', 'ancestor-2', 'branch-1']));
    expect(rows.some(row => row.record_id === 'ancestor-3')).toBe(false);
  });

  it('does not regress continuation on replay or reordered pages and rejects stale authority', async () => {
    openWorkspaceDb(key); const db = getWorkspaceDb(); const s = store();
    const page = (cursor, nextCursor, numbers, version = 1) => ({ thread_history_page: {
      channelId: 'channel-a', thread: { ...rawThread('ordered'), row_version: version }, cursor, nextCursor,
      messages: numbers.map(n => rawMessage('ordered', n)),
    } });
    await hydrateTowerPgSyncBundle(s, page(null, 'two', [0, 1]));
    await hydrateTowerPgSyncBundle(s, page('two', 'three', [2, 3]));
    await hydrateTowerPgSyncBundle(s, page(null, 'two', [0, 1]));
    expect((await db.sync_state.get('thread-history-page:ordered')).value.nextCursor).toBe('three');
    await hydrateTowerPgSyncBundle(s, page('three', null, [4, 5], 2));
    await expect(hydrateTowerPgSyncBundle(s, page(null, 'two', [0, 1]))).rejects.toThrow('older than current authority');
    await hydrateTowerPgSyncBundle(s, page('two', 'three', [2, 3], 2));
    expect((await db.sync_state.get('thread-history-page:ordered')).value).toMatchObject({ nextCursor: null,
      messageIds: ['ordered-source', 'ordered-1', 'ordered-2', 'ordered-3', 'ordered-4', 'ordered-5'] });
    await db.pg_record_rows.put({ key: 'thread:ordered', family: 'thread', id: 'ordered', operation: 'upsert', row: { ...rawThread('ordered'), row_version: 3 } });
    await expect(hydrateTowerPgSyncBundle(s, page(null, 'two', [0], 2))).rejects.toThrow('older than current authority');
    expect((await db.sync_state.get('thread-history-page:ordered')).value.nextCursor).toBeNull();
  });

  it('drops old inherited membership for changed lineage while retaining live own-thread replies', async () => {
    openWorkspaceDb(key); await seed('ancestor', 10); await seed('branch', 3);
    const db = getWorkspaceDb(); const s = store();
    await db.chat_messages.update('branch', { pg_effective_message_ids: ['ancestor-9'] });
    await hydrateTowerPgSyncBundle(s, { thread_history_page: { channelId: 'channel-a', thread: rawThread('branch'), messages: [], nextCursor: 'two' } });
    const changed = { ...rawThread('branch'), parent_thread_id: 'different', branch_point_message_id: 'different-1', row_version: 2 };
    // Canonical thread updates may precede any new targeted history page.
    await db.chat_messages.put(mapPgThreadToLocal(changed));
    expect((await getThreadMessagePresentationWindow('channel-a', 'branch')).some(row => row.record_id === 'ancestor-9')).toBe(false);
    await expect(hydrateTowerPgSyncBundle(s, { thread_history_page: { channelId: 'channel-a', thread: rawThread('branch'), messages: [rawMessage('ancestor', 9)] } })).rejects.toThrow('older than current authority');
    await hydrateTowerPgSyncBundle(s, { thread_history_page: { channelId: 'channel-a', thread: changed, messages: [rawMessage('branch', 1)], nextCursor: null } });
    await db.chat_messages.put(mapPgMessageToLocal(rawMessage('branch', 20)));
    const rows = await getThreadMessagePresentationWindow('channel-a', 'branch-source', { threadId: 'branch' });
    expect(rows.some(row => row.record_id === 'ancestor-9')).toBe(false);
    expect(rows.at(-1).record_id).toBe('branch-20');
  });

  it('honors tombstones, pending deletes and authority reset racing a history read', async () => {
    openWorkspaceDb(key); await seed('ancestor', 5); await seed('branch', 1);
    const db = getWorkspaceDb(); const s = { workspaceOwnerNpub: 'owner', backendUrl: 'http://localhost:1', currentWorkspace: { workspaceId: 'workspace-a', directHttpsUrl: 'http://localhost:1' } };
    await db.chat_messages.update('branch', { pg_effective_message_ids: ['ancestor-1', 'ancestor-2'] });
    await db.pg_record_rows.put({ key: 'message:ancestor-1', family: 'message', id: 'ancestor-1', operation: 'delete' });
    await db.chat_messages.update('ancestor-2', { record_state: 'deleted', sync_status: 'pending' });
    await db.pending_writes.add({ record_id: 'ancestor-2', envelope: {} });
    const bundle = await readTowerPgThreadHistoryPage(s, 'channel-a', 'branch', {
      getTowerPgThread: async () => rawThread('branch'),
      getTowerPgChannelMessages: async () => ({ messages: [rawMessage('ancestor', 1), rawMessage('ancestor', 2)], next_cursor: null }),
    });
    await hydrateTowerPgSyncBundle(s, bundle);
    expect((await getThreadMessagePresentationWindow('channel-a', 'branch')).some(row => row.record_id.startsWith('ancestor'))).toBe(false);
    expect((await db.chat_messages.get('ancestor-2')).sync_status).toBe('pending');
    const { resetPgRecordAuthority } = await import('../src/pg-record-delta.js');
    await resetPgRecordAuthority(s);
    expect(await db.sync_state.get('thread-history-page:branch')).toBeUndefined();
    await expect(hydrateTowerPgSyncBundle(s, bundle)).rejects.toThrow('authority changed');
    expect(await db.chat_messages.get('branch')).toBeUndefined();
  });

  it('retains actual persisted identity when a source message is not cached yet', async () => {
    openWorkspaceDb(key);
    await getWorkspaceDb().chat_messages.put(mapPgThreadToLocal(rawThread('partial')));
    const rows = await getThreadMessagePresentationWindow('channel-a', 'partial-source', { threadId: 'partial' });
    expect(rows.map(row => row.record_id)).toEqual(['partial']);
    const s = store(); s.activeThreadId = 'partial-source'; s.messages = rows;
    expect(s.getThreadParentMessage().record_id).toBe('partial');
  });

  it('keeps indexed detail reads bounded independently of busy unrelated threads', async () => {
    openWorkspaceDb(key); await seed('wanted', 400); await seed('other', 1000);
    const metrics = instrumentIndexedDb();
    try {
      const page = await getThreadMessagePresentationWindow('channel-a', 'wanted-source', { replyLimit: 6 });
      expect(page).toHaveLength(9);
      expect(metrics.snapshot().valueRowsRead).toBeLessThanOrEqual(18);
    } finally { metrics.restore(); }
  });

  it('ignores late remote pagination state after switching away and back', async () => {
    openWorkspaceDb(key); await seed('thread-a', 10); await seed('thread-b', 10);
    const s = store();
    const pending = [];
    s.requestTowerSyncFamily = vi.fn((family) => family === 'thread-history-page' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve());
    const row = id => ({ id, rootRecordId: id, channelId: 'channel-a' });
    await s.openAutopilotOverviewThread(row('thread-a'));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await s.openAutopilotOverviewThread(row('thread-b'));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await s.openAutopilotOverviewThread(row('thread-a'));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[0]({ nextCursor: 'stale-a' }); pending[1]({ nextCursor: 'stale-b' });
    await Promise.resolve();
    expect(s.threadHistoryCursor).toBeNull();
    pending[2]({ nextCursor: 'current-a' });
    await vi.waitFor(() => expect(s.threadHistoryCursor).toBe('current-a'));
    await vi.waitFor(() => expect(s.visibleThreadMessages.at(-1)?.body).toBe('thread-a reply 9'));
  });

  it('loads one cold page through service/materialization and protects pending rows and workspace cursors', async () => {
    openWorkspaceDb(key);
    const s = { backendUrl: 'http://localhost:1', workspaceOwnerNpub: 'owner', currentWorkspace: { workspaceId: 'workspace-a', directHttpsUrl: 'http://localhost:1' } };
    const db = getWorkspaceDb();
    await db.sync_state.put({ key: 'workspace-cursor', value: 'keep' });
    const read = vi.fn().mockResolvedValue({ messages: [rawMessage('cold', 0), rawMessage('cold', 1)], next_cursor: 'page-2' });
    const service = new TowerSyncService({ workspaceKey: key, families: { 'thread-history-page': {
      load: (_, options) => readTowerPgThreadHistoryPage(s, 'channel-a', 'cold', { ...options, getTowerPgThread: async () => rawThread('cold'), getTowerPgChannelMessages: read }),
      materialize: bundle => hydrateTowerPgSyncBundle(s, bundle),
    } } });
    const result = await service.ensureLoaded('thread-history-page', 'cold:first');
    expect(result).toEqual({ nextCursor: 'page-2', count: 2 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][2]).toMatchObject({ limit: 100, cursor: null, effectiveTranscript: true });
    expect((await getThreadMessagePresentationWindow('channel-a', 'cold')).some(row => row.body === 'cold reply 1')).toBe(true);
    await db.pending_writes.add({ record_id: 'cold-1', envelope: {} });
    await db.chat_messages.update('cold-1', { body: 'pending edit', sync_status: 'pending', version: 2 });
    await db.pg_record_rows.put({ key: 'message:cold-2', family: 'message', id: 'cold-2', operation: 'delete' });
    read.mockResolvedValue({ messages: [rawMessage('cold', 1), rawMessage('cold', 2)], next_cursor: null });
    await service.ensureLoaded('thread-history-page', 'cold:page-2', { cursor: 'page-2' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await db.chat_messages.get('cold-2')).toBeUndefined();
    expect((await db.chat_messages.get('cold-1')).body).toBe('pending edit');
    expect(await db.pending_writes.count()).toBe(1);
    expect((await db.sync_state.get('workspace-cursor')).value).toBe('keep');
    service.dispose();
  });
});
