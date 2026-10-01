import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const sign = vi.hoisted(() => vi.fn(async (url, method, body) => `reader ${method} ${url} ${body ? JSON.stringify(body) : ''}`));
const workspaceSign = vi.hoisted(() => vi.fn(() => 'must-not-use-workspace-key'));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: sign, createNip98AuthHeaderForSecret: workspaceSign }));
vi.mock('../src/crypto/workspace-keys.js', () => ({ getActiveWorkspaceKey: () => null, getActiveWorkspaceKeySecretForAuth: () => new Uint8Array(32), getActiveWorkspaceKeyNpub: () => 'workspace' }));
import { towerPgFeedRequest } from '../src/api.js';
import { openWorkspaceDb } from '../src/db.js';
import { prepareFeedCommand } from '../src/feed/tower.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { feedContextKey, feedRowKey } from '../src/feed/store.js';
let db;
beforeEach(async () => { db = await openWorkspaceDb(`feed-api-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); await db.delete(); });
// Tower 0a9aff9: routes/feed-reader.ts serializes FeedReaderError.message === code.
const conflict = code => Response.json({ error: { code, message: code, retryable: false } }, { status: 409 });
const workspaceId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-000000000002';
const mutationId = '00000000-0000-4000-8000-000000000003';
const store = () => ({ backendUrl: 'https://tower.example', currentWorkspaceActorId: 'reader', session: { npub: 'npub-reader' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner' } });
const subscription = { schema_version: 1, id: subscriptionId, workspace_id: workspaceId, reader_actor_id: 'reader', source: { kind: 'public', url: 'https://feeds.example/feed', format: 'jsonfeed-1.1' }, status: 'active', row_version: 1 };
const state = version => ({ schema_version: 1, id: '00000000-0000-4000-8000-000000000004', workspace_id: workspaceId, reader_actor_id: 'reader', subscription_id: subscriptionId, item_id: 'edition:example', row_version: version, read: true, saved: true, dismissed: true });
const input = () => ({ subscriptionId, body: { mutation_id: mutationId, expected_row_version: 1, item_id: 'edition:example', patch: { read: false } } });
const service = () => new TowerSyncService({ workspaceKey: 'feed-api', ports: { prepareCommand: (name, value) => prepareFeedCommand(store(), name, value, { db }) } });
describe('T1 real browser API adapter', () => {
  it('signs actual-reader exact routes and serializes CAS mutations without actor parameters', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ subscriptions: [], next_cursor: null })); vi.stubGlobal('fetch', fetchImpl);
    const opts = { baseUrl: 'https://tower.example', appNpub: 'app' };
    await towerPgFeedRequest('workspace', '', { ...opts, cursor: 'opaque/+=' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/feed-subscriptions?limit=200&cursor=opaque%2F%2B%3D');
    const body = { mutation_id: 'mutation', expected_row_version: 2, item_id: 'item', patch: { read: false } };
    await towerPgFeedRequest('workspace', '/subscription/item-states', { ...opts, method: 'PUT', body });
    expect(sign.mock.calls[1].slice(0, 3)).toEqual(['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/feed-subscriptions/subscription/item-states', 'PUT', body]);
    expect(workspaceSign).not.toHaveBeenCalled(); expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual(body); expect(fetchImpl.mock.calls[1][1].headers['x-flightdeck-pg-app-npub']).toBe('app');
  });
  it.each(['mutation_id_reused', 'state_conflict', 'subscription_inactive'])('preserves the exact T1 %s envelope', async code => {
    vi.stubGlobal('fetch', async () => conflict(code));
    await expect(towerPgFeedRequest(workspaceId, `/${subscriptionId}/item-states`, { baseUrl: 'https://tower.example', method: 'PUT', body: input().body })).rejects.toMatchObject({ status: 409, code, message: code, retryable: false, payload: { error: { code, message: code, retryable: false } } });
  });
  it.each([
    [{ error: 'Concurrent edit', code: 'state_conflict' }, { code: 'state_conflict', reason: 'Concurrent edit' }],
    [{ reason: 'locked', required_permission: 'write', holder_actor_npub: 'holder' }, { reason: 'locked', requiredPermission: 'write', holder_actor_npub: 'holder' }],
    [{ details: { reason: 'legacy detail' } }, { reason: 'legacy detail' }],
  ])('preserves legacy parser fields for %j', async (payload, fields) => {
    vi.stubGlobal('fetch', async () => Response.json(payload, { status: 409 }));
    const error = await towerPgFeedRequest(workspaceId, '', { baseUrl: 'https://tower.example' }).catch(e => e);
    expect(error).toMatchObject({ ...fields, status: 409, payload, method: 'GET' });
    expect(error.message).toContain(`: ${JSON.stringify(payload)}`);
  });
  it('preserves raw non-JSON errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('Gateway unavailable', { status: 502 }));
    await expect(towerPgFeedRequest(workspaceId, '', { baseUrl: 'https://tower.example' })).rejects.toMatchObject({ status: 502, responseText: 'Gateway unavailable' });
  });
  it.each(['mutation_id_reused', 'subscription_inactive', 'unknown_conflict', null])('fails %s after one write without hydration or new mutation IDs', async code => {
    const fetchImpl = vi.fn(async () => code ? conflict(code) : Response.json({ error: 'Unknown conflict' }, { status: 409 }));
    vi.stubGlobal('fetch', fetchImpl);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const command = input(), original = structuredClone(command), sync = service();
    try {
      await expect(sync.command('feed-state.patch', command)).rejects.toMatchObject({ status: 409, code });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1].method).toBe('PUT');
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(original.body);
      expect(uuid).not.toHaveBeenCalled();
      expect(command).toEqual(original);
      expect(await db.feed_commands.count()).toBe(0);
    } finally { await sync.dispose(); }
  });
  it('rejects a changed request reusing an acknowledged mutation through a fresh client', async () => {
    let acknowledged;
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (acknowledged && JSON.stringify(body) !== JSON.stringify(acknowledged)) return conflict('mutation_id_reused');
      acknowledged = body;
      return Response.json({ item_state: state(2) });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const one = service(), two = service();
    try {
      const first = input(); first.body.patch = { read: true };
      await one.command('feed-state.patch', first);
      fetchImpl.mockClear(); sign.mockClear();
      const uuid = vi.spyOn(crypto, 'randomUUID');
      await expect(two.command('feed-state.patch', input())).rejects.toMatchObject({ code: 'mutation_id_reused', message: 'mutation_id_reused' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(input().body);
      expect(uuid).not.toHaveBeenCalled();
    } finally { await one.dispose(); await two.dispose(); }
  });
  it('does not apply item-state reconciliation to subscription conflicts', async () => {
    const fetchImpl = vi.fn(async () => conflict('state_conflict'));
    vi.stubGlobal('fetch', fetchImpl);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const descriptor = prepareFeedCommand(store(), 'feed-subscription.patch', { subscriptionId, body: { mutation_id: mutationId, expected_row_version: 1, patch: { status: 'active' } } }, { db });
    await expect(descriptor.execute()).rejects.toMatchObject({ status: 409, code: 'state_conflict' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(uuid).not.toHaveBeenCalled();
  });
  it.each([false, true])('reconciles only explicit unread fields; exhausted=%s bounds writes and UUIDs', async exhausted => {
    let writes = 0;
    const fetchImpl = vi.fn(async (_url, options) => {
      if (options.method === 'PUT') {
        writes++;
        return writes === 1 || exhausted ? conflict('state_conflict') : Response.json({ item_state: { ...state(3), read: false } });
      }
      return Response.json(_url.includes('/item-states?') ? { item_states: [state(writes + 1)], next_cursor: null } : { subscriptions: [subscription], next_cursor: null });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const command = input(), sync = service();
    try {
      const result = sync.command('feed-state.patch', command);
      if (exhausted) await expect(result).rejects.toMatchObject({ status: 409, code: 'state_conflict' });
      else await expect(result).resolves.toMatchObject({ item_state: { read: false, saved: true, dismissed: true, row_version: 3 } });
      const bodies = fetchImpl.mock.calls.filter(([, options]) => options.method === 'PUT').map(([, options]) => JSON.parse(options.body));
      expect(bodies).toHaveLength(exhausted ? 3 : 2);
      expect(bodies.map(b => b.expected_row_version)).toEqual(exhausted ? [1, 2, 3] : [1, 2]);
      expect(new Set(bodies.map(b => b.mutation_id)).size).toBe(bodies.length);
      for (const body of bodies) expect(body).toEqual({ mutation_id: expect.any(String), expected_row_version: expect.any(Number), item_id: 'edition:example', patch: { read: false } });
      expect(uuid).toHaveBeenCalledTimes(bodies.length - 1);
      expect(fetchImpl.mock.calls.filter(([, options]) => options.method === 'GET')).toHaveLength((bodies.length - 1) * 2);
      expect(await db.feed_commands.count()).toBe(0);
      if (!exhausted) {
        const context = feedContextKey({ baseUrl: 'https://tower.example', workspaceId, readerActorId: 'reader' });
        expect(await db.feed_item_states.get(feedRowKey(context, subscriptionId, 'edition:example'))).toMatchObject({ read: false, saved: true, dismissed: true, row_version: 3 });
      }
    } finally { await sync.dispose(); }
  });
});
