import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { hydrateMessageActivity } from '../src/message-activity/hydrate.js';
import { messageActivityContext, messageActivityPartition, messageActivityRowKey, normalizeMessageActivity, projectMessageActivity } from '../src/message-activity/projection.js';
import { validMessageActivityRequest, messageActivityError } from '../src/message-activity/bridge.js';

const makeStore = () => ({ session: { npub: 'reader' }, signingNpub: 'reader', workspaceDbKey: 'activity-tests', selectedBoardId: 'scope',
  currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'http://localhost:3100', appNpub: 'app', towerServiceNpub: 'tower', workspaceServiceNpub: 'service' } });
beforeEach(async () => { await openWorkspaceDb(`activity-tests-${crypto.randomUUID()}`).open(); });
const snapshot = (range = '7d') => ({ identity: { workspace_id: 'workspace', workspace_owner_npub: 'owner', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' },
  workspace_id: 'workspace', range, from: range === 'all' ? null : range === '7d' ? '2026-09-30T12:00:00.000Z' : '2026-09-07T12:00:00.000Z',
  as_of: '2026-10-07T12:00:00.000Z', to: '2026-10-07T12:00:00.000Z', complete: true,
  channels: [{ channel_id: 'a', scope_id: 's', count: 3 }, { channel_id: 'b', scope_id: 's', count: 1 }, { channel_id: 'empty', scope_id: null, count: 0 }] });
afterEach(async () => { try { await getWorkspaceDb().delete(); } catch {} });

describe('authoritative message activity projections', () => {
  it.each(['7d', '30d', 'all'])('persists complete %s aggregate without copying authority or bodies to the frame', async range => {
    const store = makeStore(), c = messageActivityContext(store), db = getWorkspaceDb();
    const payload = snapshot(range);
    payload.signer = 'never-copy'; payload.channels[0].body = 'private';
    const read = vi.fn(async () => payload);
    await hydrateMessageActivity(store, range, { requestId: 'fresh-read' }, { read });
    expect(read).toHaveBeenCalledWith('workspace', range, expect.objectContaining({ baseUrl: 'http://localhost:3100', appNpub: 'app', signal: expect.any(AbortSignal) }));
    const row = await db.message_activity.get(messageActivityRowKey(c, range));
    expect(row.request_id).toBe('fresh-read');
    const p = projectMessageActivity(row, [{ record_id: 'a', title: '<script>literal</script>' }, { record_id: 'denied', title: 'private' }], [{ record_id: 's', title: 'Scope' }]);
    expect(p.total).toBe(4); expect(p.channel_count).toBe(3);
    expect(p.scopes.map(s => s.count)).toEqual([4, 0]);
    expect(p.scopes[0].channels[0].label).toBe('<script>literal</script>');
    expect(JSON.stringify(p)).not.toMatch(/private|never-copy|identity|reader|owner/);
    expect(row.channels[0]).toEqual({ channel_id: 'a', scope_id: 's', count: 3 });
  });

  it('uses the aggregate rather than partial messages, denied metadata or inherited reply cache', async () => {
    const store = makeStore(), db = getWorkspaceDb();
    // Canonical fixture: two roots and one reply in A; one root in B.
    // The server fixture deliberately omits denied/deleted channels and messages.
    await db.chat_messages.bulkPut([{ record_id: 'root', channel_id: 'a' }, { record_id: 'root-inherited-copy', channel_id: 'b', parent_message_id: 'root' }, { record_id: 'deleted-local', channel_id: 'a', record_state: 'deleted' }]);
    await hydrateMessageActivity(store, '7d', { requestId: 'canonical' }, { read: async () => snapshot() });
    const row = await db.message_activity.get(messageActivityRowKey(messageActivityContext(store), '7d'));
    expect(row.channels).toEqual(snapshot().channels);
    expect(projectMessageActivity(row, [{ record_id: 'denied' }, { record_id: 'deleted-channel', record_state: 'deleted' }], []).total).toBe(4);
    expect(await db.chat_messages.count()).toBe(3);
  });

  it.each([
    p => { p.complete = false; }, p => { delete p.complete; },
    p => { p.workspace_id = 'other'; }, p => { p.identity.workspace_id = 'other'; },
    p => { p.identity.tower_service_npub = 'other'; }, p => { p.identity.app_npub = 'other'; },
    p => { p.identity.workspace_owner_npub = 'other'; }, p => { p.identity.workspace_service_npub = 'other'; },
    p => { p.range = '30d'; }, p => { p.from = '2026-09-30T12:00:00.001Z'; },
    p => { p.as_of = 'invalid'; }, p => { p.to = '2026-10-07T12:00:00.001Z'; },
    p => { p.from = '2026-09-30T12:00:00+00:00'; }, p => { p.channels.push(p.channels[0]); },
    p => { p.channels[0].count = -1; }, p => { p.channels[0].count = 1.1; },
    p => { p.channels[0].count = '3'; }, p => { p.channels[0].scope_id = {}; },
    p => { p.channels[0].channel_id = ''; }, p => { p.channels[0].count = Number.MAX_SAFE_INTEGER; p.channels[1].count = 1; },
  ])('rejects malformed, partial, duplicate or cross-authority aggregates', mutate => {
    const payload = snapshot(); mutate(payload);
    expect(() => normalizeMessageActivity(payload, messageActivityContext(makeStore()), '7d', 'read')).toThrow();
  });

  it('separates identity, workspace, endpoint and range partitions', () => {
    const store = makeStore(), original = messageActivityContext(store), key = messageActivityPartition(original);
    for (const field of ['viewer', 'sessionNpub', 'workspaceId', 'appNpub', 'tower', 'service', 'baseUrl', 'dbKey']) {
      expect(messageActivityPartition({ ...original, [field]: 'different' })).not.toBe(key);
    }
    expect(messageActivityRowKey(original, '7d')).not.toBe(messageActivityRowKey(original, 'all'));
  });

  it('requires a request generation and a null all-time lower bound', () => {
    const c = messageActivityContext(makeStore());
    expect(() => normalizeMessageActivity(snapshot(), c, '7d', '')).toThrow();
    expect(() => normalizeMessageActivity({ ...snapshot('all'), from: snapshot().from }, c, 'all', 'read')).toThrow();
  });

  it.each(['workspace', 'identity', 'scope', 'close', 'service'])('rejects a late %s response before persistence', async change => {
    const store = makeStore(), db = getWorkspaceDb(), controller = new AbortController();
    store._towerSyncService = new TowerSyncService({ workspaceKey: 'activity-tests' });
    let release;
    const read = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const loading = hydrateMessageActivity(store, '7d', { signal: controller.signal, requestId: 'old' }, { read });
    if (change === 'workspace') store.currentWorkspace.workspaceId = 'other';
    if (change === 'identity') store.session.npub = 'other';
    if (change === 'scope') store.selectedBoardId = 'other';
    if (change === 'close') controller.abort();
    if (change === 'service') store._towerSyncService.dispose();
    release(snapshot());
    await expect(loading).rejects.toThrow();
    expect(await db.message_activity.count()).toBe(0);
    if (['close', 'service'].includes(change)) expect(read.mock.calls[0][2].signal.aborted).toBe(true);
  });

  it('preserves the prior snapshot when access fails; it is not a new complete response', async () => {
    const store = makeStore(), db = getWorkspaceDb();
    await hydrateMessageActivity(store, '7d', { requestId: 'previous' }, { read: async () => snapshot() });
    await expect(hydrateMessageActivity(store, '7d', { requestId: 'denied' }, { read: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } })).rejects.toThrow('denied');
    const row = await db.message_activity.get(messageActivityRowKey(messageActivityContext(store), '7d'));
    expect(row.request_id).toBe('previous');
    expect(messageActivityError({ status: 403 })).toMatch(/denied/);
  });
});

describe('aggregate-only host bridge', () => {
  const frame = {}, session = 'random-session';
  const event = data => ({ source: frame, origin: 'null', data: { version: 1, session, ...data } });
  it('accepts only session-bound ready, refresh, close and fixed ranges', () => {
    for (const type of ['ready', 'refresh', 'close']) expect(validMessageActivityRequest(event({ type }), frame, session)).toBe(true);
    for (const range of ['7d', '30d', 'all']) expect(validMessageActivityRequest(event({ type: 'range', range }), frame, session)).toBe(true);
  });
  it('rejects hostile requests without invoking any transport or signer', () => {
    const cases = [event({ type: 'fetch', url: 'http://evil' }), event({ type: 'sign' }), event({ type: 'refresh', workspace_id: 'other' }),
      event({ type: 'range', range: '1d' }), event({ type: 'range', range: 'all', token: 'x' }), event({ type: 'ready', version: 2 }),
      event({ type: 'ready', session: 'old-session' }), { ...event({ type: 'ready' }), source: {} },
      { ...event({ type: 'ready' }), origin: 'https://untrusted' }, { source: frame, origin: 'null', data: null },
      { source: frame, origin: 'null', data: [] }];
    for (const e of cases) expect(validMessageActivityRequest(e, frame, session)).toBe(false);
  });
});
