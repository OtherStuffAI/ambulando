import { beforeEach, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb, getOwnerActivityWindow, getRecentChannelActivity, getActivityThreadAttention, upsertResourceViewState } from '../src/db.js';
import { applyPgRecordChanges, getPgAttentionProjection, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { unreadStoreMixin } from '../src/unread-store.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { queryInboxSource, sectionLiveQueryMixin } from '../src/section-live-queries.js';
import { buildAutopilotOverviewThreads, autopilotOverviewManagerMixin } from '../src/autopilot-overview-manager.js';

const owner = 'npub1owner';
const workspaceId = fixture.canonical_upserts.changes[0].workspace_id;
const transport = { workspaceId, workspaceOwnerNpub: owner, currentWorkspace: { workspaceId }, session: { npub: 'npub1viewer' } };
let db;
beforeEach(async () => {
  db = openWorkspaceDb('inbox-recovery'); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  await applyPgRecordChanges(transport, fixture.canonical_upserts, { expectedCursor: null });
});
const input = (type = 'all', scopeId = 'all') => ({ workspaceOwnerNpub: owner, deckInboxType: type,
  autopilotOverviewContext: { scopeId, channelId: 'all' }, inboxActivityVisibleCount: 100 });

it.each(['all', 'chat'])('shows canonical numeric thread attention in %s Inbox without a selected Chat window', async (type) => {
  const thread = fixture.canonical_upserts.changes.find(change => change.family === 'thread');
  const source = fixture.canonical_upserts.changes.find(change => change.family === 'message');
  await applyPgRecordChanges(transport, { ...fixture.one_message_delta, next_cursor: 'unread', changes: [
    { ...thread, version: '100', row: { ...thread.row, source_message_id: source.id, activity_version: 1, row_version: 2 } },
    { ...source, version: '101', row: { ...source.row, thread_id: thread.id, row_version: 2 } },
  ] });
  const attention = await db.pg_resource_attention.get(`thread:${thread.id}`);
  expect(attention.unread).toBe(1);
  const page = await queryInboxSource(input(type), owner, 'chat_messages');
  const store = Object.defineProperties({}, Object.getOwnPropertyDescriptors(autopilotOverviewManagerMixin));
  Object.assign(store, { navSection: 'status', isTowerPgMode: true, channels: await db.channels.toArray(),
    fileMessages: page.rows, messages: [], inboxUnreadThreads: page.unreadThreads,
    _unreadThreadItems: { [thread.id]: true } });
  expect(store.autopilotOverviewThreads.find(row => row.id === thread.id)?.isUnread).toBe(true);
});

it('uses fresh Tower view-state authority after record-delta rollback instead of an empty stale attention map', async () => {
  const thread = fixture.canonical_upserts.changes.find(change => change.family === 'thread');
  await db.pg_resource_attention.clear();
  const authorityKey = recordDeltaCursorKey(transport);
  const authority = (await db.sync_state.get(authorityKey)).value;
  await db.sync_state.put({ key: authorityKey, value: { ...authority, legacyFallbackActive: true } });
  expect(await getPgAttentionProjection(transport)).toBeNull();

  const towerStates = [{ resource_type: 'thread', resource_id: thread.id, channel_id: thread.row.channel_id,
    activity_version: 2, viewed_activity_version: 1 }];
  const store = { ...transport, isTowerPgMode: true, _recordDeltaAttentionActive: true,
    _unreadThreadItems: {}, _unreadTaskItems: {}, _unreadDocItems: {}, _unreadChannels: {},
    applyPgAttentionProjection: unreadStoreMixin.applyPgAttentionProjection,
    applyTowerPgResourceViewStates: unreadStoreMixin.applyTowerPgResourceViewStates };
  store.applyPgAttentionProjection(await getPgAttentionProjection(store));
  expect(store._recordDeltaAttentionActive).toBe(false);
  store.applyTowerPgResourceViewStates(towerStates);
  expect(store._unreadThreadItems).toEqual({ [thread.id]: true });

  const page = await queryInboxSource(input('chat'), owner, 'chat_messages');
  const cards = buildAutopilotOverviewThreads({ channels: await db.channels.toArray(), messages: page.rows,
    resourceViewStateMode: true, unreadThreadMap: store._unreadThreadItems });
  expect(cards.find(row => row.id === thread.id)?.isUnread).toBe(true);
});

it('keeps root/reply attention live through reading, later activity, partial refresh, reload and scoped paging', async () => {
  const thread = fixture.canonical_upserts.changes.find(change => change.family === 'thread');
  const source = fixture.canonical_upserts.changes.find(change => change.family === 'message');
  const receipt = fixture.canonical_upserts.changes.find(change => change.family === 'resource_view_state');
  const viewerActorId = '20000000-0000-4000-8000-000000000002';
  let version = 100;
  const change = (original, patch, id = original.id) => ({ ...original, id, version: String(++version),
    row: { ...original.row, ...patch, id, row_version: version } });
  const apply = changes => applyPgRecordChanges({ ...transport, currentPgActorId: viewerActorId }, {
    ...fixture.one_message_delta, changes, next_cursor: `attention-${version}`,
    actors: [...fixture.one_message_delta.actors, { actor_id: viewerActorId, npub: transport.session.npub,
      kind: 'human', display_name: 'Reader' }],
  });
  const threadChange = activity_version => change(thread, { source_message_id: source.id, activity_version });
  const receiptChange = viewed_activity_version => change(receipt, {
    resource_type: 'thread', resource_id: thread.id, viewed_activity_version, viewer_actor_id: viewerActorId,
  }, `${viewerActorId}:thread:${thread.id}`);
  const assertInbox = async expected => {
    for (const type of ['all', 'chat']) {
      const page = await queryInboxSource(input(type, thread.scope_id), owner, 'chat_messages');
      const cards = buildAutopilotOverviewThreads({ channels: await db.channels.toArray(), messages: page.rows,
        resourceViewStateMode: true, unreadThreadMap: page.unreadThreads });
      expect(cards.find(row => row.id === thread.id)?.isUnread, type).toBe(expected);
    }
  };
  await apply([threadChange(1), change(source, { thread_id: thread.id }), receiptChange(0)]);
  await assertInbox(true);
  // Both canonical thread metadata and the source-message presentation resolve
  // the same attention key, as does a reply with a source-message parent ID.
  expect(await getActivityThreadAttention([{ record_id: thread.id, pg_record_type: 'thread' }]))
    .toEqual({ [thread.id]: true });
  const root = await db.chat_messages.get(source.id);
  const observations = [];
  const queryStore = { ...sectionLiveQueryMixin, ...input('chat'), currentWorkspaceKey: 'inbox-recovery',
    navSection: 'status', applyFileMessages() {},
    createLiveSubscription(query, onNext) {
      if (!query.toString().includes("'chat_messages'")) return { unsubscribe() {} };
      return liveQuery(query).subscribe(page => { onNext(page); observations.push(this.inboxUnreadThreads[thread.id]); });
    },
    stopLiveSubscription(subscription) { subscription.unsubscribe(); },
  };
  queryStore.startWorkspaceLiveQueries();
  await vi.waitFor(() => expect(observations.at(-1)).toBe(true));
  let read;
  const store = { messages: [root], navSection: 'status', deckThreadChannelId: thread.channel_id,
    deckThreadTowerId: thread.id, THREAD_REPLY_PAGE_SIZE: 6,
    loadDeckThreadHistoryPage() {}, scheduleThreadRepliesScrollToBottom() {}, syncRoute() {},
    markTowerPgResourceViewed(type, id, activityVersion) {
      expect([type, id]).toEqual(['thread', thread.id]);
      read = upsertResourceViewState({ resource_type: type, resource_id: id,
        viewed_activity_version: activityVersion, sync_status: 'pending' });
    } };
  chatMessageManagerMixin.openThread.call(store, source.id);
  await read;
  try { await vi.waitFor(() => expect(observations.at(-1)).toBe(false)); }
  finally { queryStore.stopWorkspaceLiveQueries(); queryStore.stopSharedLiveQueries(); }
  await assertInbox(false);
  await upsertResourceViewState({ resource_type: 'thread', resource_id: thread.id,
    viewed_activity_version: 1, sync_status: 'synced' }); // Read-command acknowledgement.
  await apply([receiptChange(1)]); // Confirm the viewer's read with a canonical receipt.
  await apply([threadChange(2), change(source, { thread_id: thread.id, body: 'Incoming reply',
    created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z' }, 'incoming-reply')]);
  expect(await getActivityThreadAttention([await db.chat_messages.get('incoming-reply')])).toEqual({ [thread.id]: true });
  await assertInbox(true);
  // A metadata-only refresh and an older receipt cannot erase later activity.
  await apply([threadChange(2), receiptChange(0)]);
  db.close(); await db.open();
  await assertInbox(true);
  // Tower advances the author's own receipt alongside their message activity.
  await apply([threadChange(3), receiptChange(3), change(source, { thread_id: thread.id,
    body: 'Own reply', created_by_actor_id: viewerActorId, updated_by_actor_id: viewerActorId }, 'own-reply')]);
  await assertInbox(false);
  await apply([threadChange(4), change(source, { thread_id: thread.id, body: 'Later incoming reply' }, 'later-reply')]);
  // Unrelated newer rows must not conceal this scope's unread thread.
  await db.channels.put({ ...(await db.channels.get(thread.channel_id)), record_id: 'unrelated-channel', scope_id: 'elsewhere' });
  await db.chat_messages.bulkPut(Array.from({ length: 110 }, (_, i) => ({ ...root, record_id: `unrelated-${i}`,
    pg_thread_id: `unrelated-thread-${i}`, channel_id: 'unrelated-channel', updated_at: '2099-01-01T00:00:00Z' })));
  await assertInbox(true);
  for (const limit of [1, 50, 150]) {
    const page = await queryInboxSource({ ...input('chat', thread.scope_id), inboxActivityVisibleCount: limit,
      deckInboxSearchQuery: 'Incoming' }, owner, 'chat_messages');
    expect(page.unreadThreads[thread.id]).toBe(true);
  }
  await apply([{ ...thread, operation: 'delete', row: null, version: String(++version) }]);
  expect(await getActivityThreadAttention([{ record_id: thread.id }])).toEqual({ [thread.id]: false });
  expect(await getActivityThreadAttention([{ record_id: 'unavailable-thread' }])).toEqual({});
});

it('materializes canonical chats into owner activity, and recovers rows from previous installed builds without writes', async () => {
  const mapped = await db.chat_messages.toArray();
  expect(mapped.length).toBeGreaterThan(0);
  expect(mapped.every(row => row.owner_npub === owner)).toBe(true);
  const page = await getOwnerActivityWindow('chat_messages', owner);
  expect(page.rows.length).toBeGreaterThan(0);
  // Exact old mapped shape: remove only the field absent before this repair.
  await db.chat_messages.toCollection().modify(row => { delete row.owner_npub; });
  await db.pending_writes.add({ record_id: 'local-command', envelope: { body: 'pending' } });
  const before = await db.chat_messages.toArray();
  const cursors = await db.sync_state.toArray();
  expect((await getOwnerActivityWindow('chat_messages', owner)).rows.map(row => row.record_id))
    .toEqual(page.rows.map(row => row.record_id));
  const activity = await getRecentChannelActivity(owner);
  expect(activity.length).toBeGreaterThan(0);
  expect(activity.every(row => row.pg_record_type === 'message')).toBe(true);
  expect(await db.chat_messages.toArray()).toEqual(before);
  expect(await db.sync_state.toArray()).toEqual(cursors);
  expect(await db.pending_writes.count()).toBe(1);
});

it('finds old scoped Chat, Task, Docs and Files before unrelated newer candidates and filters exhaust honestly', async () => {
  const channel = await db.channels.toCollection().first();
  const scope = channel.scope_id;
  const task = await db.tasks.toCollection().first();
  const doc = (await db.documents.toArray()).find(row => row.pg_record_type === 'doc');
  await db.tasks.bulkPut(Array.from({ length: 160 }, (_, i) => ({ ...task, record_id: `other-${i}`, scope_id: 'elsewhere', scope_l1_id: 'elsewhere', updated_at: '2099-01-01T00:00:00Z' })));
  await db.documents.bulkPut(Array.from({ length: 160 }, (_, i) => ({ ...doc, record_id: `other-doc-${i}`, scope_id: 'elsewhere', scope_l1_id: 'elsewhere', updated_at: '2099-01-01T00:00:00Z' })));
  for (const [type, family] of [['chat', 'chat_messages'], ['task', 'tasks'], ['document', 'documents'], ['file', 'documents']]) {
    const page = await queryInboxSource(input(type, scope), owner, family);
    expect(page.rows.length, type).toBeGreaterThan(0);
    expect(page.hasMore, type).toBe(false);
  }
  expect(await queryInboxSource(input('chat', scope), owner, 'tasks')).toEqual({ rows: [], hasMore: false });
  expect(await queryInboxSource({ ...input('task', scope), deckInboxSearchQuery: 'no such match' }, owner, 'tasks')).toEqual({ rows: [], hasMore: false });
});

it('pages distinct chat threads despite a busy thread and keeps Recent Channels independent and live after edits/deletes', async () => {
  const template = fixture.canonical_upserts.changes.find(change => change.family === 'message');
  const changes = Array.from({ length: 125 }, (_, i) => ({ ...template, id: `message-${i}`, version: String(1000 + i),
    row: { ...template.row, id: `message-${i}`, thread_id: `thread-${i}`, updated_at: new Date(Date.UTC(2027, 8, 5) - i * 1000).toISOString() } }));
  await applyPgRecordChanges(transport, { ...fixture.one_message_delta, changes, next_cursor: 'many' });
  let page = await queryInboxSource(input('chat'), owner, 'chat_messages');
  const channels = await db.channels.toArray();
  expect(buildAutopilotOverviewThreads({ channels, messages: page.rows }).length).toBe(100);
  expect(page.hasMore).toBe(true);
  page = await queryInboxSource({ ...input('chat'), inboxActivityVisibleCount: 150 }, owner, 'chat_messages');
  expect(buildAutopilotOverviewThreads({ channels, messages: page.rows }).length).toBeGreaterThan(125);
  expect(page.hasMore).toBe(false);
  const recent = await getRecentChannelActivity(owner);
  const latest = recent.find(row => row.record_id === 'message-0');
  expect(latest).toBeTruthy();
  await db.chat_messages.update(latest.record_id, { body: 'edited preview' });
  expect((await getRecentChannelActivity(owner)).find(row => row.record_id === latest.record_id).body).toBe('edited preview');
  await db.chat_messages.delete(latest.record_id);
  expect((await getRecentChannelActivity(owner)).some(row => row.record_id === 'message-1')).toBe(true);
  await db.chat_messages.where('channel_id').equals(latest.channel_id).delete();
  expect((await getRecentChannelActivity(owner)).some(row => row.channel_id === latest.channel_id)).toBe(false);
});

it('retains the live Feed subscription through Inbox type, page and scope transitions and delivers add/edit/remove', async () => {
  const received = [];
  const subscriptions = [];
  const store = Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(autopilotOverviewManagerMixin)), sectionLiveQueryMixin, {
    currentWorkspaceKey: 'inbox-recovery', workspaceOwnerNpub: owner, navSection: 'status',
    createLiveSubscription(query, onNext) { const sub = liveQuery(query).subscribe({ next: onNext }); subscriptions.push({ query, sub }); return sub; },
    stopLiveSubscription(sub) { sub.unsubscribe(); },
    applyAddressBookPeople() {}, applyWapps() {}, applyScopes() {}, applyChannels() {}, applyDailyNotes() {},
    applyTasks() {}, applyDocuments() {}, applyFileMessages() {}, applyFileComments() {}, applyDirectories() {},
    applyWappActivityProjection(projection) { received.push(projection); },
  });
  store.startWorkspaceLiveQueries();
  const feed = subscriptions.find(entry => entry.query.toString().includes('getWappActivityProjection'));
  const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); expect(predicate()).toBe(true); };
  try {
    await waitFor(() => received.length > 0);
    store.setDeckInboxType('chat'); store.inboxActivityVisibleCount = 150; store.startWorkspaceLiveQueries();
    store.syncDeckInboxContext('scope:another', 'another');
    expect(subscriptions.filter(entry => entry.query.toString().includes('getWappActivityProjection'))).toEqual([feed]);
    await db.wapp_activity_items.put({ record_id: 'feed-test', title: 'new', occurred_at: '2026-09-05T00:00:00Z' });
    await waitFor(() => received.at(-1).items.some(row => row.title === 'new'));
    await db.wapp_activity_items.update('feed-test', { title: 'changed' });
    await waitFor(() => received.at(-1).items.some(row => row.title === 'changed'));
    await db.wapp_activity_items.delete('feed-test');
    await waitFor(() => received.at(-1).items.length === 0);
  } finally { store.stopWorkspaceLiveQueries(); store.stopSharedLiveQueries(); }
});

it('keeps comment-driven task search while hiding parent attachments from Deck file cards', async () => {
  const task = await db.tasks.toCollection().first();
  const original = fixture.canonical_upserts.changes.find(change => change.family === 'task_comment');
  await applyPgRecordChanges(transport, { ...fixture.one_message_delta, next_cursor: 'comment-search', changes: [{
    ...original, version: '80000', row: { ...original.row, row_version: 2, task_id: task.record_id,
      scope_id: task.scope_id, channel_id: task.pg_channel_id,
      body: 'Distinctive review phrase [Evidence](storage://comment-evidence)', updated_at: '2031-01-01T00:00:00Z' },
  }] });
  const comment = await db.comments.get(original.id);
  const search = { ...input('task', task.scope_id), deckInboxSearchQuery: 'Distinctive review phrase' };
  expect((await queryInboxSource(search, owner, 'tasks')).rows.some(row => row.record_id === task.record_id)).toBe(true);
  const files = await queryInboxSource(input('file', task.scope_id), owner, 'comments');
  expect(files.rows.some(row => row.record_id === comment.record_id)).toBe(false);
  const message = (await db.chat_messages.toArray()).find(row => row.pg_record_type === 'message');
  await db.chat_messages.update(message.record_id, { body: '[Chat evidence](storage://chat-evidence)' });
  expect((await queryInboxSource(input('file', task.scope_id), owner, 'chat_messages')).rows.some(row => row.record_id === message.record_id)).toBe(false);
});


it('supports every independent family combination in bounded source recovery', async () => {
  const types = ['chat', 'task', 'document', 'file'];
  const sources = ['chat_messages', 'tasks', 'documents', 'comments'];
  for (let mask = 0; mask < 16; mask++) {
    const shown = types.filter((_, i) => mask & (1 << i));
    for (const source of sources) {
      const page = await queryInboxSource(input(shown), owner, source);
      expect(Array.isArray(page.rows)).toBe(true);
      const supported = { chat_messages: ['chat', 'file'], tasks: ['task', 'file'], documents: ['document', 'file'], comments: ['task', 'document', 'file'] };
      if (!supported[source].some(type => shown.includes(type))) expect(page).toEqual({ rows: [], hasMore: false });
      if (shown.includes('chat') && source === 'chat_messages' || shown.includes('task') && source === 'tasks' || shown.includes('document') && source === 'documents') expect(page.rows.length).toBeGreaterThan(0);
    }
  }
});
