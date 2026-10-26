import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, deleteWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { notificationInboxMixin } from '../src/notification-inbox-manager.js';
import { notificationInboxContext, queueNotificationPatch } from '../src/notification-inbox-store.js';
import { normalizeNotificationItem } from '../src/notification-inbox-wire.js';

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
    _workspaceSelectionGeneration: 0, workspaceDbKey: key, requestTowerSyncFamily: vi.fn(async () => {}), getTowerSyncService: () => null,
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
