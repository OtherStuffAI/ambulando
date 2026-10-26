import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { synchronizeNotificationInbox, hydrateArchivedNotifications } from '../src/notification-inbox-sync.js';
import {
  applyNotificationInboxOperation, notificationInboxContext, projectNotificationInbox, queueNotificationBulk,
  queueNotificationPatch, unreadCount,
} from '../src/notification-inbox-store.js';
import { notificationTargetRoute } from '../src/notification-inbox-manager.js';
import { normalizeNotificationItem } from '../src/notification-inbox-wire.js';

// Explicit simulated Tower: per-actor commit-ordered sequence, CAS row_version,
// durable mutation receipts. It mirrors the design's wire shapes; no shortcut
// shares state between the independent Dexie/service pairs below.
class FakeTower {
  constructor(workspace = 'ws') { this.workspace = workspace; this.actors = new Map(); this.receipts = new Map(); this.offline = new Set(); this.unsupported = false; this.floor = 0; this.calls = []; }
  actor(id) { if (!this.actors.has(id)) this.actors.set(id, { seq: 0, items: new Map(), tombstones: [] }); return this.actors.get(id); }
  wire(actorId, item) {
    return { schema: 'org.wingman.notification.item', version: 1, id: item.id, workspace_id: this.workspace, recipient_actor_id: actorId, change_seq: item.change_seq, row_version: item.row_version,
      source: { app_id: 'flightdeck.core', label: 'Flight Deck', kind: 'tower_rule' }, category: item.category || 'mention', reasons: ['mention'], severity: 'normal', status: item.status || 'active', origin: 'live',
      group: { key: `thread:${item.id}`, event_count: item.event_count || 1 }, subject: { kind: 'thread', activity_version: item.activity_version || 1 },
      presentation: { title: item.title || `Mention ${item.id}`, body: item.body || '' }, action: { type: 'open', target: item.target || { kind: 'thread', channel_id: 'c1', thread_id: item.id } },
      occurred_at: new Date(1_700_000_000_000 + item.created_seq * 1000).toISOString(), access: item.access || 'ok',
      state: { read: Boolean(item.read), read_at: null, read_reason: item.read ? 'user' : null, dismissed: Boolean(item.dismissed), archived: Boolean(item.archived) } };
  }
  emit(actorId, id, attrs = {}) {
    const a = this.actor(actorId); const prior = a.items.get(id);
    const item = { ...(prior || { id, row_version: 0, event_count: 0, created_seq: a.seq + 1 }), ...attrs }; item.row_version += 1; item.change_seq = ++a.seq;
    if (attrs.fold) { item.event_count = (prior?.event_count || 0) + 1; item.read = false; item.activity_version = (prior?.activity_version || 0) + 1; }
    a.items.set(id, item); return item;
  }
  remove(actorId, id) { const a = this.actor(actorId); a.items.delete(id); a.tombstones.push({ id, change_seq: ++a.seq }); }
  unread(a) { return [...a.items.values()].filter(i => !i.read && !i.dismissed && !i.archived && (i.status || 'active') === 'active').length; }
  handle(actorId, route, { method = 'GET', query = {}, body } = {}) {
    this.calls.push({ route, method, query, body });
    if (this.offline.has(actorId)) throw new Error('offline');
    if (this.unsupported) throw Object.assign(new Error('not found'), { status: 404 });
    const a = this.actor(actorId); const identity = { workspace_id: this.workspace };
    if (route === 'items' && method === 'GET') {
      const view = query.view || 'inbox';
      const all = [...a.items.values()].filter(i => view === 'archived' ? i.archived && !i.dismissed : !i.archived && !i.dismissed).sort((x, y) => y.change_seq - x.change_seq);
      const start = Number(query.cursor || 0), size = Number(query.limit || 50);
      return { identity, items: all.slice(start, start + size).map(i => this.wire(actorId, i)), next_cursor: start + size < all.length ? String(start + size) : null, head_seq: a.seq, inbox_started_at: '2026-10-26T00:00:00Z' };
    }
    if (route === 'changes') {
      const after = Number(query.after_seq); if (after < this.floor) throw Object.assign(new Error('reset'), { status: 410, payload: { error: 'Cursor reset required', code: 'reset_required' } });
      const limit = Number(query.limit || 200);
      const changes = [...[...a.items.values()].map(i => this.wire(actorId, i)), ...a.tombstones.map(t => ({ schema: 'org.wingman.notification.tombstone', version: 1, id: t.id, workspace_id: this.workspace, change_seq: t.change_seq, change_type: 'remove', removal_reason: 'access_lost' }))]
        .filter(c => c.change_seq > after).sort((x, y) => x.change_seq - y.change_seq);
      const page = changes.slice(0, limit);
      return { identity, changes: page, through_seq: page.length ? page.at(-1).change_seq : after, head_seq: a.seq, has_more: changes.length > limit };
    }
    if (route === 'counts') return { identity, unread_total: this.unread(a), by_category: {}, by_source_app: {}, badge: this.unread(a), capped_at: 999, head_seq: a.seq };
    const receiptKey = `${actorId}:${body?.mutation_id}`;
    if (method === 'PATCH') {
      const id = route.split('/')[1]; const item = a.items.get(id);
      if (!item) throw Object.assign(new Error('missing'), { status: 404 });
      if (this.receipts.has(receiptKey)) { if (JSON.stringify(this.receipts.get(receiptKey).body) !== JSON.stringify(body)) throw Object.assign(new Error('reused'), { status: 409, payload: { error: 'mutation id reused', code: 'mutation_id_reused' } }); return this.receipts.get(receiptKey).result; }
      if (item.row_version !== body.expected_row_version || (body.observed_change_seq !== undefined && body.observed_change_seq < item.change_seq)) throw Object.assign(new Error('conflict'), { status: 409, payload: { error: 'state conflict', code: 'state_conflict', item: this.wire(actorId, item) } });
      const patch = body.patch; const next = { ...item };
      if ('read' in patch) next.read = patch.read; if ('dismissed' in patch) { next.dismissed = patch.dismissed; if (patch.dismissed) next.read = true; } if ('archived' in patch) { next.archived = patch.archived; if (patch.archived) next.read = true; }
      next.row_version += 1; next.change_seq = ++a.seq; a.items.set(id, next);
      const result = { item: this.wire(actorId, next) }; this.receipts.set(receiptKey, { body, result }); return result;
    }
    if (route === 'bulk') {
      if (this.receipts.has(receiptKey)) return this.receipts.get(receiptKey).result;
      let affected = 0;
      for (const item of a.items.values()) if (item.change_seq <= body.selector.up_to_seq && (!body.selector.category || item.category === body.selector.category) && body.op === 'mark_read' && !item.read) { Object.assign(item, { read: true, row_version: item.row_version + 1, change_seq: ++a.seq }); affected += 1; }
      const result = { affected, through_seq: a.seq }; this.receipts.set(receiptKey, { body, result }); return result;
    }
    throw Object.assign(new Error('unknown route'), { status: 404 });
  }
}

let server, devices, opened;

function device(name, { actor = 'alice', workspace = 'ws' } = {}) {
  const db = new Dexie(`notifications-${name}-${Math.random()}`);
  db.version(1).stores({ notification_items: '&key, context, [context+occurred_ms]', notification_inbox: '&key, context' });
  const store = { session: { npub: actor }, currentWorkspace: { workspaceId: workspace, directHttpsUrl: 'http://localhost:3100', pgMe: { actor: { actor_id: actor, npub: actor } } }, _workspaceSelectionGeneration: 0, workspaceDbKey: name, buildTowerPgMaterializationStoreSnapshot: () => ({}) };
  const service = new TowerSyncService({ workspaceKey: name, ports: { materialize: (_f, bundle) => applyNotificationInboxOperation(structuredClone(bundle.notification_inbox_operation), db) } });
  store.getTowerSyncService = () => service;
  const context = notificationInboxContext(store);
  const transport = async (_w, route, options) => server.handle(actor, route, options);
  const sync = () => synchronizeNotificationInbox(store, { db, transport, now: () => d.clock });
  const d = { db, store, service, context, sync, clock: 1_000_000, transport, actor };
  opened.push(d); return d;
}
const state = d => d.db.notification_inbox.get(d.context.key);
const rows = d => d.db.notification_items.where('context').equals(d.context.key).toArray();
const view = async (d, options) => projectNotificationInbox(await rows(d), await state(d), options);

beforeEach(async () => { server = new FakeTower(); opened = []; devices = [device('one'), device('two')]; for (const d of devices) await d.db.open(); });
afterEach(async () => { for (const d of opened) { d.service.dispose(); await d.db.close(); } });

describe('snapshot and replay', () => {
  it('cold starts from a paged snapshot, then converges through changes', async () => {
    const [one] = devices;
    for (let i = 1; i <= 130; i += 1) server.emit('alice', `n${i}`);
    await one.sync();
    expect((await rows(one)).length).toBe(130);
    expect((await state(one)).local_seq).toBe(130);
    expect(server.calls.filter(c => c.route === 'items').length).toBe(2); // 100-item pages
    server.emit('alice', 'n131'); server.emit('alice', 'n3', { fold: true });
    await one.sync();
    expect((await view(one))[0].id).toBe('n131');
    expect((await rows(one)).find(r => r.id === 'n3').row_version).toBe(2);
    expect(unreadCount(await rows(one), await state(one))).toBe(131);
  });

  it('resumes a larger-than-budget snapshot from its original origin and is ready only after the last page', async () => {
    const [one] = devices;
    for (let i = 1; i <= 7; i += 1) server.emit('alice', `n${i}`);
    const observations = [];
    // Two-item pages and a one-page budget: the snapshot needs four jobs.
    const transport = async (_w, route, options) => {
      if (route === 'items') {
        const st = await state(one);
        observations.push({ ready: Boolean(st?.ready), cursor: st?.snapshot?.cursor ?? null, seq: st?.snapshot?.seq ?? null, rows: (await rows(one)).length });
        if (observations.length === 3) server.emit('alice', 'mid'); // arrives while older pages are still unread
        return server.handle('alice', route, { ...options, query: { ...options.query, limit: 2 } });
      }
      return server.handle('alice', route, options);
    };
    await synchronizeNotificationInbox(one.store, { db: one.db, transport, now: () => one.clock, snapshotPageBudget: 1 });
    expect(observations.length).toBe(4);
    expect(observations.every(o => o.ready === false)).toBe(true); // never ready mid-snapshot
    expect(observations[0].cursor).toBeNull();
    expect(observations.slice(1).every(o => o.cursor !== null)).toBe(true); // continuation persisted between jobs
    expect(new Set(observations.slice(1).map(o => o.seq))).toEqual(new Set([7])); // original first-page origin kept
    const final = await state(one);
    expect(final.ready).toBe(true);
    expect(final.snapshot).toBeNull();
    expect(final.local_seq).toBe(8); // replay from origin 7 picked up the mid-snapshot arrival
    expect((await rows(one)).map(r => r.id).sort()).toEqual(['mid', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    expect(unreadCount(await rows(one), final)).toBe(8);
  });

  it('restarts a continuation whose saved cursor the server no longer accepts', async () => {
    const [one] = devices;
    for (let i = 1; i <= 5; i += 1) server.emit('alice', `n${i}`);
    let rejectOnce = true;
    const transport = async (_w, route, options) => {
      if (route === 'items' && options.query.cursor && rejectOnce) { rejectOnce = false; throw Object.assign(new Error('bad cursor'), { status: 400, payload: { code: 'invalid_cursor', error: 'invalid cursor' } }); }
      return server.handle('alice', route, route === 'items' ? { ...options, query: { ...options.query, limit: 2 } } : options);
    };
    await synchronizeNotificationInbox(one.store, { db: one.db, transport, now: () => one.clock, snapshotPageBudget: 1 });
    const final = await state(one);
    expect(final.ready).toBe(true);
    expect((await rows(one)).length).toBe(5);
  });

  it('shows a future item version as a safe generic card instead of failing the sync', async () => {
    const [one] = devices;
    server.emit('alice', 'a');
    const wire = server.wire.bind(server);
    server.wire = (actor, item) => item.id === 'a' ? { ...wire(actor, item), schema: 'org.wingman.notification.item', version: 2, presentation: { title: 'secret future text' }, action: { type: 'open', target: { kind: 'thread', channel_id: 'c1' } } } : wire(actor, item);
    server.emit('alice', 'b');
    await one.sync();
    const all = await view(one);
    const future = all.find(r => r.id === 'a');
    expect(future.unsupported).toBe(true);
    expect(future.title).toMatch(/update Ambulando/);
    expect(JSON.stringify(future)).not.toContain('secret future text');
    expect(notificationTargetRoute(future)).toBeNull();
    expect(future.change_seq).toBe(1);
    expect((await state(one)).local_seq).toBe(2);
  });

  it('removes rows the authoritative list no longer holds and applies tombstones and unavailable stubs', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); server.emit('alice', 'b'); server.emit('alice', 'c');
    await one.sync();
    server.actor('alice').items.delete('a'); // vanished without a client-visible change (e.g. before a restore)
    server.emit('alice', 'd');
    server.floor = server.actor('alice').seq; // older cursors now get 410 reset_required
    await one.sync();
    expect((await rows(one)).map(r => r.id).sort()).toEqual(['b', 'c', 'd']);
    server.floor = 0;
    server.remove('alice', 'b');
    server.emit('alice', 'c', { access: 'unavailable' });
    await one.sync();
    const visible = await view(one);
    expect(visible.map(r => r.id).sort()).toEqual(['c', 'd']);
    const stub = visible.find(r => r.id === 'c');
    expect(stub.unavailable).toBe(true);
    expect(stub.title).toBe('Item no longer available');
    expect(notificationTargetRoute(stub)).toBeNull();
    expect(unreadCount(await rows(one), await state(one))).toBe(1);
  });

  it('keeps dismissed items out and ignores unknown archived items until that partition is hydrated', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); await one.sync();
    server.emit('alice', 'x', { archived: true, read: true }); server.emit('alice', 'y', { dismissed: true, read: true }); server.emit('alice', 'a', { archived: true });
    await one.sync();
    expect((await rows(one)).map(r => r.id)).toEqual(['a']); // known item moves partition; x and y never hydrate
    expect(await view(one)).toEqual([]);
    await hydrateArchivedNotifications(one.store, { db: one.db, transport: one.transport });
    expect((await view(one, { view: 'archived' })).map(r => r.id).sort()).toEqual(['a', 'x']);
    server.emit('alice', 'z', { archived: true, read: true });
    await one.sync();
    expect((await view(one, { view: 'archived' })).map(r => r.id).sort()).toEqual(['a', 'x', 'z']);
  });

  it('self-heals once when local and server unread counts disagree at the same sequence', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); server.emit('alice', 'b'); await one.sync();
    await one.db.notification_items.where('context').equals(one.context.key).modify({ read: true }); // corrupt local truth
    await one.sync(); // detects mismatch and schedules a rebuild
    expect(unreadCount(await rows(one), await state(one))).toBe(2);
    await one.db.notification_items.where('context').equals(one.context.key).modify({ read: true });
    await one.sync(); // cooldown: no repeated rebuild loop
    expect(unreadCount(await rows(one), await state(one))).toBe(0);
  });
});

describe('state commands', () => {
  it('applies optimistic read immediately, sends CAS once and converges across devices', async () => {
    const [one, two] = devices;
    server.emit('alice', 'a'); await one.sync(); await two.sync();
    await queueNotificationPatch(one.db, one.context, 'a', { read: true });
    expect((await view(one))[0].read).toBe(true);
    expect((await rows(one))[0].read).toBe(false); // server truth untouched until acknowledged
    await one.sync(); await two.sync();
    expect((await state(one)).pending).toEqual([]);
    expect((await view(two))[0].read).toBe(true);
    expect(server.calls.filter(c => c.method === 'PATCH').length).toBe(1);
    expect(server.calls.find(c => c.method === 'PATCH').body.expected_row_version).toBe(1);
  });

  it('never lets read, dismiss or archive clear activity the user did not see; only undo intents are re-applied', async () => {
    const [one, two] = devices;
    for (const id of ['r', 'd', 'x', 'u']) server.emit('alice', id);
    server.emit('alice', 'u', { read: true }); // already read elsewhere, so "mark unread" is an undo intent
    await one.sync(); await two.sync();
    const rendered = Object.fromEntries((await rows(one)).map(row => [row.id, row]));
    await queueNotificationPatch(one.db, one.context, 'r', { read: true }, rendered.r);
    await queueNotificationPatch(one.db, one.context, 'd', { dismissed: true }, rendered.d);
    await queueNotificationPatch(one.db, one.context, 'x', { archived: true }, rendered.x);
    await queueNotificationPatch(one.db, one.context, 'u', { read: false }, rendered.u);
    for (const id of ['r', 'd', 'x', 'u']) server.emit('alice', id, { fold: true }); // all fold before device one syncs
    server.actor('alice').items.get('u').read = true; // the folded undo target is read again on the server
    await one.sync();
    const items = server.actor('alice').items;
    expect(items.get('r').read).toBeFalsy();
    expect(items.get('d').dismissed).toBeFalsy();
    expect(items.get('x').archived).toBeFalsy();
    expect(items.get('u').read).toBe(false); // un-do re-applied under a new identity
    expect((await state(one)).pending).toEqual([]);
    expect((await state(one)).notice).toMatch(/not applied/);
    expect((await view(one)).filter(r => !r.read).map(r => r.id).sort()).toEqual(['d', 'r', 'u', 'x']);
  });

  it('uses the version the user saw even when a later sync stored a newer row', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); await one.sync();
    const seen = (await rows(one))[0];
    server.emit('alice', 'a', { fold: true }); await one.sync(); // newer row now stored locally
    await queueNotificationPatch(one.db, one.context, 'a', { read: true }, seen);
    await one.sync();
    expect(server.actor('alice').items.get('a').read).toBeFalsy();
    expect(server.calls.find(c => c.method === 'PATCH').body).toMatchObject({ expected_row_version: 1, observed_change_seq: 1 });
  });

  it('rejects a mutation_id reused with a different body instead of treating it as success', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); await one.sync();
    await queueNotificationPatch(one.db, one.context, 'a', { read: true });
    const pending = (await state(one)).pending[0];
    // Another request already used this id with a different body.
    server.handle('alice', 'items/a', { method: 'PATCH', body: { mutation_id: pending.mutation_id, expected_row_version: 1, patch: { archived: true } } });
    await one.sync();
    expect((await state(one)).pending).toEqual([]);
    expect((await state(one)).notice).toMatch(/could not be confirmed/);
  });

  it('treats an intent the server already satisfies as complete', async () => {
    const [one, two] = devices;
    server.emit('alice', 'a'); await one.sync(); await two.sync();
    await queueNotificationPatch(two.db, two.context, 'a', { read: true }); await two.sync();
    await queueNotificationPatch(one.db, one.context, 'a', { read: true }); await one.sync();
    expect((await state(one)).pending).toEqual([]);
    expect((await state(one)).notice).toBe('');
  });

  it('bulk marks only the observed sequence boundary; newer concurrent items stay unread', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); server.emit('alice', 'b'); await one.sync();
    const observed = await queueNotificationBulk(one.db, one.context, 'mark_read', {});
    expect(observed).toBe(2);
    server.emit('alice', 'late'); // arrives after the user looked
    await one.sync();
    expect(server.actor('alice').items.get('late').read).toBeFalsy();
    expect(server.calls.find(c => c.route === 'bulk').body.selector.up_to_seq).toBe(2);
    expect((await view(one, { view: 'unread' })).map(r => r.id)).toEqual(['late']);
  });

  it('retains immutable offline intent, replays the same mutation id, and survives a lost response', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); await one.sync();
    server.offline.add('alice');
    await queueNotificationPatch(one.db, one.context, 'a', { read: true });
    const before = (await state(one)).pending;
    await expect(one.sync()).rejects.toThrow('offline');
    expect((await state(one)).pending.map(p => p.mutation_id)).toEqual(before.map(p => p.mutation_id));
    expect((await view(one))[0].read).toBe(true); // still shown as read while offline
    server.offline.delete('alice');
    // The server accepted the first attempt but the response was lost: replay is a receipt hit, not a second write.
    const first = { mutation_id: before[0].mutation_id, expected_row_version: 1, patch: { read: true } };
    server.handle('alice', 'items/a', { method: 'PATCH', body: first });
    const versionAfterLostResponse = server.actor('alice').items.get('a').row_version;
    await one.sync();
    expect(server.actor('alice').items.get('a').row_version).toBe(versionAfterLostResponse);
    expect((await state(one)).pending).toEqual([]);
    expect((await rows(one))[0].read).toBe(true);
  });

  it('keeps unsent intents across a snapshot reset', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); server.emit('alice', 'b'); await one.sync();
    server.offline.add('alice');
    await queueNotificationPatch(one.db, one.context, 'b', { archived: true });
    server.offline.delete('alice');
    server.actor('alice').seq = 10; server.floor = 10;
    await one.sync();
    expect((await state(one)).pending).toEqual([]);
    expect(server.actor('alice').items.get('b').archived).toBe(true);
  });

  it('refuses to queue before the first authoritative load', async () => {
    const [one] = devices;
    await expect(queueNotificationPatch(one.db, one.context, 'a', { read: true })).rejects.toThrow('Connect to Tower');
  });
});

describe('identity and capability', () => {
  it('never mixes workspaces or recipients, locally or on the wire', async () => {
    const [one] = devices;
    const bob = device('bob', { actor: 'bob' }); const other = device('other', { workspace: 'other' });
    await bob.db.open(); await other.db.open();
    server.emit('alice', 'a'); server.emit('bob', 'b');
    await one.sync(); await bob.sync();
    expect((await rows(one)).map(r => r.id)).toEqual(['a']);
    expect((await rows(bob)).map(r => r.id)).toEqual(['b']);
    expect(one.context.key).not.toBe(bob.context.key);
    expect(one.context.key).not.toBe(other.context.key);
    const foreign = server.wire('alice', { id: 'f', change_seq: 5, row_version: 1, created_seq: 5 });
    expect(() => normalizeNotificationItem({ ...foreign, workspace_id: 'other' }, one.context)).toThrow(/another workspace/);
    expect(() => normalizeNotificationItem({ ...foreign, recipient_actor_id: 'bob' }, one.context)).toThrow(/another workspace or recipient/);
    expect((await view(other))).toEqual([]); // a different workspace context starts with an empty local inbox
  });

  it('exposes an unsupported backend without calling it again inside the retry window', async () => {
    const [one] = devices;
    server.unsupported = true;
    await one.sync();
    expect((await state(one)).status).toBe('unsupported');
    const calls = server.calls.length;
    one.clock += 60_000; await one.sync();
    expect(server.calls.length).toBe(calls);
    server.unsupported = false; server.emit('alice', 'a');
    one.clock += 11 * 60_000; await one.sync();
    expect((await state(one)).status).toBe('ok');
    expect((await rows(one)).length).toBe(1);
  });

  it('opening never writes resource view state: only the notification PATCH is sent', async () => {
    const [one] = devices;
    server.emit('alice', 'a'); await one.sync();
    await queueNotificationPatch(one.db, one.context, 'a', { read: true }); await one.sync();
    expect(server.calls.filter(c => c.method !== 'GET').every(c => c.route.startsWith('items/'))).toBe(true);
  });
});

describe('presentation safety', () => {
  it('strips control and bidi characters, bounds text and ignores non-string targets', async () => {
    const [one] = devices;
    const raw = server.wire('alice', { id: 'x', change_seq: 1, row_version: 1, created_seq: 1, title: `Hi\u202Eevil\u0007${'a'.repeat(400)}`, body: '<img src=x onerror=alert(1)>', target: { kind: 'thread', channel_id: 'c1', thread_id: { nested: true } } });
    const row = normalizeNotificationItem(raw, one.context);
    expect(row.title.startsWith('Hievil')).toBe(true);
    expect(row.title.length).toBe(120);
    expect(row.body).toBe('<img src=x onerror=alert(1)>'); // stored as inert text; rendered only via x-text
    expect(row.target.thread_id).toBeUndefined();
  });
});

describe('routing', () => {
  const item = target => ({ target, unavailable: false });
  it('maps typed targets to sections and refuses unknown kinds', () => {
    expect(notificationTargetRoute(item({ kind: 'thread', channel_id: 'c1', thread_id: 't1' }))).toMatchObject({ section: 'chat', params: { channelid: 'c1', threadid: 't1' } });
    expect(notificationTargetRoute(item({ kind: 'task_comment', task_id: 'k1', comment_id: 'm1' }))).toMatchObject({ section: 'tasks', params: { taskid: 'k1', commentid: 'm1' } });
    expect(notificationTargetRoute(item({ kind: 'doc', doc_id: 'd1' }))).toMatchObject({ section: 'docs', params: { docid: 'd1' } });
    expect(notificationTargetRoute(item({ kind: 'app_object', app_id: 'blinkers' }))).toBeNull();
    expect(notificationTargetRoute(item({ kind: 'thread' }))).toBeNull();
    expect(notificationTargetRoute({ target: { kind: 'task' }, subject: { task_id: 'k9', scope_id: 's1' } })).toMatchObject({ section: 'tasks', scopeid: 's1', params: { taskid: 'k9' } });
    expect(notificationTargetRoute({ target: { kind: 'thread', channel_id: 'c1' }, unavailable: true })).toBeNull();
  });
});

describe('inbox preferences', () => {
  const registry = { sources: [{ app_id: 'flightdeck.core', label: 'Flight Deck', categories: [
    { category: 'mention', label: 'Mentions', default_inbox: 'on', mandatory: false },
    { category: 'chat_thread', label: 'Channel threads', default_inbox: 'on', mandatory: false },
    { category: 'security', label: 'Security', default_inbox: 'on', mandatory: true }] }] };
  it('resolves effective inbox mode from rules and locks mandatory categories', async () => {
    const { buildCategoryRows } = await import('../src/notification-rules.js');
    const rows = buildCategoryRows(registry, [
      { source_app_id: 'flightdeck.core', category: 'chat_thread', client_app_id: '*', channel: 'inbox', mode: 'off' },
      { source_app_id: 'flightdeck.core', category: 'security', client_app_id: '*', channel: 'inbox', mode: 'off' },
      { source_app_id: 'flightdeck.core', category: 'mention', client_app_id: '*', channel: 'alert', mode: 'off' }]);
    expect(rows.map(r => [r.category, r.inboxOn, r.mandatory])).toEqual([['mention', true, false], ['chat_thread', false, false], ['security', true, true]]);
  });
  it('writes whole-key rules with a mutation id, refuses mandatory edits and foreign workspaces', async () => {
    const { saveInboxRule, fetchNotificationPreferences, buildCategoryRows } = await import('../src/notification-rules.js');
    const [one] = devices; const sent = [];
    const transport = async (_w, route, options) => { sent.push({ route, ...options }); return { identity: { workspace_id: 'ws' }, rules: [] }; };
    await saveInboxRule(one.store, { source_app_id: 'flightdeck.core', category: 'mention' }, false, { transport });
    expect(sent[0]).toMatchObject({ route: 'rules', method: 'PUT', body: { rules: [{ source_app_id: 'flightdeck.core', category: 'mention', client_app_id: '*', channel: 'inbox', mode: 'off' }] } });
    expect(sent[0].body.mutation_id).toMatch(/[0-9a-f-]{36}/);
    await expect(saveInboxRule(one.store, buildCategoryRows(registry, [])[2], false, { transport })).rejects.toThrow('always on');
    await expect(fetchNotificationPreferences(one.store, { transport: async () => ({ identity: { workspace_id: 'other' }, sources: [], rules: [] }) })).rejects.toThrow('another workspace');
  });
});
