import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, deleteWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { notificationInboxMixin } from '../src/notification-inbox-manager.js';
import { applyNotificationInboxOperation, notificationInboxContext, queueNotificationPatch } from '../src/notification-inbox-store.js';
import { normalizeNotificationItem } from '../src/notification-inbox-wire.js';

const loadTask = vi.fn();

const key = 'notification-inbox-manager-test';
const actorId = 'actor-a';
const rawItem = (id, seq, extra = {}) => ({
  schema: 'org.wingman.notification.item', version: 1, id, workspace_id: 'workspace-a', recipient_actor_id: actorId, change_seq: seq, row_version: 1,
  source: { app_id: 'flightdeck.core', label: 'Flight Deck', kind: 'tower_rule' }, category: extra.category || 'mention', severity: 'normal', status: 'active',
  presentation: { title: `Title ${id}`, body: '' }, action: { type: 'open', target: { kind: 'thread', channel_id: 'channel-a', thread_id: id } },
  occurred_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), state: { read: Boolean(extra.read), dismissed: false, archived: Boolean(extra.archived) }, access: 'ok',
});

function store() {
  const s = Object.defineProperties({}, Object.getOwnPropertyDescriptors(notificationInboxMixin));
  Object.assign(s, {
    session: { npub: 'npub-a' }, currentWorkspace: { workspaceId: 'workspace-a', directHttpsUrl: 'http://localhost:3100', pgMe: { actor: { actor_id: actorId, npub: 'npub-a' } } },
    _workspaceSelectionGeneration: 0, workspaceDbKey: key, requestTowerSyncFamily: vi.fn(async family => {
      if (family === 'task') { const task = await loadTask(); if (task?.record_id) await getWorkspaceDb().tasks.put(task); return task; }
    }), getTowerSyncService: () => null,
    applyRouteFromLocation: vi.fn(async () => {}), currentWorkspaceSlug: 'acme',
  });
  return s;
}
async function seed(s, items, state = {}) {
  const context = notificationInboxContext(s); const db = getWorkspaceDb();
  await db.notification_items.bulkPut(items.map(raw => ({ ...normalizeNotificationItem(raw, context), partition: raw.state.archived ? 'archived' : 'inbox', snapshot_gen: 'g' })));
  await db.notification_inbox.put({ key: context.key, context: context.key, ready: true, status: 'ok', local_seq: 9, head_seq: 9, counts: null, pending: [], error: '', notice: '', archived_hydrated: false, activated_at: '2026-10-26T00:00:00Z', ...state });
  return context;
}

beforeEach(() => { openWorkspaceDb(key); });
afterEach(async () => { await deleteWorkspaceDb(key); });

describe('notification inbox manager', () => {
  it('projects the live inbox with unread badge, filters, optimistic actions and no cross-context rows', async () => {
    const s = store();
    await seed(s, [rawItem('a', 1), rawItem('b', 2, { category: 'task_assignment' }), rawItem('c', 3, { read: true }), rawItem('z', 4, { archived: true })]);
    s.activateNotificationInbox();
    await vi.waitFor(() => expect(s.notificationInboxItems.map(i => i.id)).toEqual(['c', 'b', 'a']));
    expect(s.notificationInboxUnread).toBe(2);
    expect(s.notificationInboxBadge).toBe('2');
    expect(s.notificationInboxCategories).toEqual(['mention', 'task_assignment']);
    s.setNotificationInboxCategory('task_assignment');
    expect(s.notificationInboxItems.map(i => i.id)).toEqual(['b']);
    s.setNotificationInboxCategory('');
    await s.setNotificationInboxView('unread');
    expect(s.notificationInboxItems.map(i => i.id)).toEqual(['b', 'a']);
    // Optimistic overlay: read at once, server rows untouched, a sync is requested.
    await s.markNotificationRead(s.notificationInboxItems[0]);
    await vi.waitFor(() => expect(s.notificationInboxUnread).toBe(1));
    expect(s.notificationInboxItems.map(i => i.id)).toEqual(['a']);
    expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('notification-inbox');
    expect(s.notificationInboxPending).toBe(1);
    // Another actor's context never shares local rows.
    const other = store(); other.currentWorkspace = { ...other.currentWorkspace, pgMe: { actor: { actor_id: 'actor-b', npub: 'npub-a' } } };
    other.activateNotificationInbox();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(other.notificationInboxItems).toEqual([]);
    other.disposeNotificationInbox(); s.disposeNotificationInbox();
    expect(s.notificationInboxItems).toEqual([]);
    expect(s.notificationInboxUnread).toBe(0);
  });

  it('opens a notification by marking only the notification and routing within the current workspace', async () => {
    const s = store(); await seed(s, [rawItem('t1', 1)]);
    s.activateNotificationInbox();
    await vi.waitFor(() => expect(s.notificationInboxItems).toHaveLength(1));
    const push = vi.fn(); vi.stubGlobal('window', { history: { pushState: push } });
    await s.openNotification(s.notificationInboxItems[0]);
    expect(push).toHaveBeenCalledWith({ source: 'notification-inbox' }, '', '/acme/chat?channelid=channel-a&threadid=t1');
    expect(s.applyRouteFromLocation).toHaveBeenCalled();
    expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('channel-messages', 'channel-a', { force: true });
    const pending = (await getWorkspaceDb().notification_inbox.toArray())[0].pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'item', item_id: 't1', patch: { read: true }, expected_row_version: 1, observed_change_seq: 1 });
    expect(s.notificationInboxOpen).toBe(false);
    vi.unstubAllGlobals(); s.disposeNotificationInbox();
  });

  it('navigates before marking read, uses the rendered version, and leaves the item unread when loading fails', async () => {
    const s = store(); await seed(s, [rawItem('t1', 1), rawItem('t2', 2)]);
    s.activateNotificationInbox();
    await vi.waitFor(() => expect(s.notificationInboxItems).toHaveLength(2));
    const events = [];
    vi.stubGlobal('window', { history: { pushState: () => events.push('navigate') } });
    const db = getWorkspaceDb();
    const originalPut = db.notification_inbox.put.bind(db.notification_inbox);
    db.notification_inbox.put = async (...args) => { if (args[0]?.pending?.length) events.push('queue-read'); return originalPut(...args); };
    const rendered = s.notificationInboxItems.find(item => item.id === 't1');
    // A newer fold lands locally after the user rendered the card: the CAS must still use the rendered version.
    await db.notification_items.update(`${notificationInboxContext(s).key}|t1`, { row_version: 2, change_seq: 5 });
    await s.openNotification(rendered);
    expect(events).toEqual(['navigate', 'queue-read']);
    expect((await db.notification_inbox.toArray())[0].pending[0]).toMatchObject({ item_id: 't1', expected_row_version: 1, observed_change_seq: 1 });
    // Failed load: still opens from saved data, but nothing is cleared.
    s.requestTowerSyncFamily = vi.fn(async () => { throw new Error('offline'); });
    events.length = 0;
    await s.openNotification(s.notificationInboxItems.find(item => item.id === 't2'));
    expect(events).toEqual(['navigate']);
    expect(s.notificationInboxMessage).toMatch(/stays unread/);
    expect((await db.notification_inbox.toArray())[0].pending.map(op => op.item_id)).toEqual(['t1']);
    db.notification_inbox.put = originalPut;
    vi.unstubAllGlobals(); s.disposeNotificationInbox();
  });

  it('invalidates the local inbox after a preference change so the list is rebuilt from Tower', async () => {
    const s = store(); const context = await seed(s, [rawItem('a', 1)]);
    const db = getWorkspaceDb();
    s.getTowerSyncService = () => ({ materialize: async (_family, bundle) => applyNotificationInboxOperation(structuredClone(bundle.notification_inbox_operation), db) });
    s.buildTowerPgMaterializationStoreSnapshot = () => ({});
    const registry = { sources: [{ app_id: 'flightdeck.core', label: 'Flight Deck', categories: [{ category: 'mention', label: 'Mentions', default_inbox: 'on' }] }] };
    s.adoptNotificationPreferences(registry, [], 1);
    const row = s.notificationPrefsRows[0];
    const sent = [];
    const written = { source_app_id: 'flightdeck.core', category: 'mention', client_app_id: 'ambulando', channel: 'inbox', mode: 'off', row_version: 1 };
    const transport = async (_w, route, options) => { sent.push([route, options.method, options.body?.rules?.[0]?.expected_row_version]); return { identity: { workspace_id: 'workspace-a' }, rules: [written], rules_revision: 2 }; };
    await s.setNotificationInboxRule(row, false, { transport });
    expect(sent).toEqual([['rules', 'PUT', 0]]);
    expect(s.notificationPrefsRevision).toBe(2);
    expect(s.notificationPrefsRows[0].expected_row_version).toBe(1);
    expect(s.notificationPrefsRows[0].inboxOn).toBe(false);
    expect((await db.notification_inbox.get(context.key)).needs_snapshot).toBe(true);
    expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('notification-inbox');
    // Another device wrote first: nothing is written, every current rule and the revision are adopted, and the user retries.
    const other = { ...written, mode: 'on', row_version: 3 };
    await s.setNotificationInboxRule(s.notificationPrefsRows[0], true, { transport: async () => { throw Object.assign(new Error('conflict'), { status: 409, payload: { code: 'rules_conflict', rules: [other], rules_revision: 9 } }); } });
    expect(s.notificationPrefsRevision).toBe(9);
    expect(s.notificationPrefsRows[0]).toMatchObject({ inboxOn: true, expected_row_version: 3 });
    expect(s.notificationPrefsError).toMatch(/changed on another device/);
    // A rules_changed reset marks the loaded list stale so the settings panel refetches it.
    s.notificationPrefsLoaded = true;
    s.projectNotificationInbox({ rows: [], state: { prefs_stale: true, pending: [] } });
    expect(s.notificationPrefsLoaded).toBe(false);
    // A rejected save reloads the server's truth rather than leaving a fabricated state.
    s.loadNotificationInboxPreferences = vi.fn(async () => {});
    await s.setNotificationInboxRule(row, true, { transport: async () => { throw Object.assign(new Error('Tower said no'), { status: 403 }); } });
    expect(s.notificationPrefsError).toBe('Tower said no');
    expect(s.loadNotificationInboxPreferences).toHaveBeenCalled();
  });

  it('shows honest unsupported and not-ready states and refuses writes before the first load', async () => {
    const s = store();
    const context = notificationInboxContext(s);
    await getWorkspaceDb().notification_inbox.put({ key: context.key, context: context.key, ready: false, status: 'unsupported', local_seq: 0, head_seq: 0, pending: [], error: 'x', notice: '', retry_after: 1 });
    s.activateNotificationInbox();
    await vi.waitFor(() => expect(s.notificationInboxStatus).toBe('unsupported'));
    expect(s.notificationInboxMessage).toMatch(/does not provide the shared notification inbox/);
    expect(s.notificationInboxEmptyText).toMatch(/does not provide/);
    await expect(queueNotificationPatch(getWorkspaceDb(), context, 'a', { read: true })).rejects.toThrow('Connect to Tower');
    s.disposeNotificationInbox();
  });

  it('caps the badge text', () => {
    const s = store(); s.notificationInboxUnread = 250;
    expect(s.notificationInboxBadge).toBe('99+');
  });
});


describe('channel notification controls', () => {
  it('writes the captured channel version, rebuilds from server truth, and prevents editing DMs', async () => {
    const s = store(); await seed(s, []);
    Object.assign(s, { isTowerPgMode: true, channels: [{ record_id: 'channel-a' }], channelSettingsChannelId: 'channel-a', channelNotificationSupported: true,
      channelNotificationPreferences: [{ channel_id: 'channel-a', mode: 'all', row_version: 4 }], buildTowerPgMaterializationStoreSnapshot: () => ({}) });
    const materialize = vi.fn(async (_f, bundle) => applyNotificationInboxOperation(bundle.notification_inbox_operation));
    s.getTowerSyncService = () => ({ materialize });
    const transport = vi.fn(async () => ({ identity: { workspace_id: 'workspace-a' }, channel_preferences: [{ channel_id: 'channel-a', mode: 'mentions_only', row_version: 5 }] }));
    await s.setChannelMentionsOnly(true, { transport });
    expect(transport.mock.calls[0][1]).toBe('channel-preferences/channel-a');
    expect(transport.mock.calls[0][2].body).toEqual({ mode: 'mentions_only', expected_row_version: 4 });
    const saved = await getWorkspaceDb().notification_inbox.get(notificationInboxContext(s).key);
    expect(saved.needs_snapshot).toBe(true); expect(saved.channel_preferences[0].mode).toBe('mentions_only');
    s.projectNotificationInbox({ rows: [], state: saved });
    expect(s.isChannelMentionsOnly('channel-a')).toBe(true);
    s.channels[0].channel_type = 'dm';
    await s.setChannelMentionsOnly(false, { transport });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('never silently retries a conflicting preference and ignores a response after workspace switching', async () => {
    const s = store();
    Object.assign(s, { isTowerPgMode: true, channels: [{ record_id: 'channel-a' }], channelSettingsChannelId: 'channel-a', channelNotificationSupported: true });
    const conflict = vi.fn(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    await s.setChannelMentionsOnly(true, { transport: conflict });
    expect(conflict).toHaveBeenCalledTimes(1); expect(s.channelNotificationError).toContain('another device');
    const materialize = vi.fn(); s.getTowerSyncService = () => ({ materialize });
    await s.setChannelMentionsOnly(true, { transport: async () => { s.currentWorkspace = { ...s.currentWorkspace, workspaceId: 'other-workspace' }; s.disposeNotificationInbox(); return { channel_preferences: [] }; } });
    expect(materialize).not.toHaveBeenCalled();
    expect(s.channelNotificationPreferences).toEqual([]);
  });
});

it('refreshes unread attention for live saved preference changes on two clients, isolated from another actor', async () => {
  const a=store(), b=store(), other=store();
  other.currentWorkspace={...other.currentWorkspace,pgMe:{actor:{actor_id:'other',npub:'npub-a'}}};
  for (const s of [a,b,other]) s.scheduleTowerPgUnreadProjectionRefresh=vi.fn(async()=>{});
  const context=await seed(a,[],{channel_preferences:[],channel_preferences_supported:true});
  for (const s of [a,b,other]) s.activateNotificationInbox();
  await vi.waitFor(()=>expect(a.notificationInboxReady).toBe(true));
  for (const s of [a,b,other]) s.scheduleTowerPgUnreadProjectionRefresh.mockClear();
  await getWorkspaceDb().notification_inbox.update(context.key,{channel_preferences:[{channel_id:'research',mode:'mentions_only'}]});
  await vi.waitFor(()=>expect(b.isChannelMentionsOnly('research')).toBe(true));
  expect(a.isChannelMentionsOnly('research')).toBe(true);
  expect(a.scheduleTowerPgUnreadProjectionRefresh).toHaveBeenCalledTimes(1);
  expect(b.scheduleTowerPgUnreadProjectionRefresh).toHaveBeenCalledTimes(1);
  expect(other.isChannelMentionsOnly('research')).toBe(false);
  expect(other.scheduleTowerPgUnreadProjectionRefresh).not.toHaveBeenCalled();
  await getWorkspaceDb().notification_inbox.update(context.key,{channel_preferences:[]});
  await vi.waitFor(()=>expect(b.isChannelMentionsOnly('research')).toBe(false));
  expect(b.scheduleTowerPgUnreadProjectionRefresh).toHaveBeenCalledTimes(2);
  for(const s of [a,b,other]) s.disposeNotificationInbox();
});

describe('notification task completion', () => {
  const item = { id: 'notice', target: { kind: 'task_comment', task_id: 'task-a' } };
  it('completes the actual task through the existing patch path without dismissing or archiving', async () => {
    const s = store();
    s.tasks = [{ record_id: 'other-channel-task', state: 'new' }];
    loadTask.mockResolvedValue({ record_id: 'task-a', state: 'review' });
    s.applyTaskPatch = vi.fn(async () => ({ record_id: 'task-a', state: 'done' }));
    s.mutateNotification = vi.fn();
    expect(await s.completeNotificationTask(item)).toBe(true);
    expect(s.applyTaskPatch).toHaveBeenCalledWith('task-a', { state: 'done', assigned_to_npubs: [] }, expect.objectContaining({ rollbackOnFailure: true }));
    expect(s.tasks.map(task => task.record_id)).toEqual(['other-channel-task']);
    expect(s.mutateNotification).not.toHaveBeenCalled();
    expect(s.notificationInboxAnnouncement).toBe('Task marked Done');
  });
  it('projects completed task state from Dexie even outside the selected task collection', async () => {
    const s = store(); s.tasks = [];
    const raw = rawItem('notice', 1);
    raw.action.target = { kind: 'task', task_id: 'task-a' };
    await seed(s, [raw]);
    s.activateNotificationInbox();
    await vi.waitFor(() => expect(s.notificationInboxItems).toHaveLength(1));
    expect(s.canCompleteNotificationTask(s.notificationInboxItems[0])).toBe(true);
    await getWorkspaceDb().tasks.put({ record_id: 'task-a', state: 'done' });
    await vi.waitFor(() => expect(s.notificationInboxItems[0].taskState).toBe('done'));
    expect(s.canCompleteNotificationTask(s.notificationInboxItems[0])).toBe(false);
    expect(s.notificationInboxItems[0].archived).toBe(false);
    expect(s.tasks).toEqual([]);
    s.disposeNotificationInbox();
  });
  it('preserves a pending task save instead of hydrating over it or sending another completion', async () => {
    const s = store(); s.tasks = []; s.applyTaskPatch = vi.fn();
    await getWorkspaceDb().tasks.put({ record_id: 'task-a', state: 'review', sync_status: 'pending' });
    expect(await s.completeNotificationTask(item)).toBe(false);
    expect(s.requestTowerSyncFamily).not.toHaveBeenCalled();
    expect(s.applyTaskPatch).not.toHaveBeenCalled();
    expect(s.notificationInboxMessage).toContain('pending save');
  });
  it('rejects skipped, denied or deleted hydration results even when a cached task exists', async () => {
    for (const loaded of [null, { archived: true }, { record_id: 'task-a', record_state: 'deleted' }]) {
      const s = store(); s.tasks = []; s.applyTaskPatch = vi.fn();
      await getWorkspaceDb().tasks.put({ record_id: 'task-a', state: 'review' });
      loadTask.mockResolvedValueOnce(loaded);
      expect(await s.completeNotificationTask(item)).toBe(false);
      expect(s.applyTaskPatch).not.toHaveBeenCalled();
    }
  });
  it('only offers completion for available writable nonterminal task targets', () => {
    const s = store();
    expect(s.canCompleteNotificationTask(item)).toBe(true);
    for (const target of [{ kind: 'thread', channel_id: 'c' }, { kind: 'doc', doc_id: 'd' }, null]) {
      expect(s.canCompleteNotificationTask({ target })).toBe(false);
    }
    expect(s.canCompleteNotificationTask({ ...item, unavailable: true })).toBe(false);
    for (const fields of [{ state: 'done' }, { state: 'archive' }, { read_only: true }]) {
      s.tasks = [{ record_id: 'task-a', ...fields }];
      expect(s.canCompleteNotificationTask(item)).toBe(false);
    }
  });
  it('blocks duplicate taps across notifications for the same task and reports failures without changing notification state', async () => {
    const s = store(); s.tasks = [];
    let finish;
    loadTask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    s.applyTaskPatch = vi.fn(async () => null);
    s.error = 'Permission denied';
    const first = s.completeNotificationTask(item);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await s.completeNotificationTask({ ...item, id: 'second' })).toBe(false);
    finish({ record_id: 'task-a', state: 'review' });
    expect(await first).toBe(false);
    expect(s.notificationInboxMessage).toBe('Permission denied');
    expect(s.notificationTaskBusyIds).toEqual([]);
    expect(s.notificationInboxAnnouncement).toBe('');
  });
  it('does not reopen terminal tasks or write after workspace changes during loading', async () => {
    const s = store(); s.tasks = []; s.applyTaskPatch = vi.fn();
    loadTask.mockResolvedValueOnce({ record_id: 'task-a', state: 'done' });
    expect(await s.completeNotificationTask(item)).toBe(false);
    loadTask.mockImplementationOnce(async () => { s.currentWorkspace = null; return { record_id: 'task-a', state: 'new' }; });
    expect(await s.completeNotificationTask(item)).toBe(false);
    expect(s.applyTaskPatch).not.toHaveBeenCalled();
  });
});
