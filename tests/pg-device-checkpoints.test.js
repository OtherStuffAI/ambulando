import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle, resolveTowerPgWorkspaceContext, syncTowerPgWorkspace } from '../src/pg-read-hydrator.js';
import { applyPgRecordChanges, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { discoverRecordProtocol, syncDeviceRecords, withDeviceCacheLock, deviceCheckpointScope, DEVICE_CACHE_OWNER_KEY } from '../src/pg-device-checkpoints.js';
const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = { workspaceDbKey: 'device-test', backendUrl: 'http://localhost:3100', session: { npub: 'viewer' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner', pgBackendMode: true } };
let db, context, key;
beforeEach(async () => {
  store.session.npub = 'viewer'; store.backendUrl = 'http://localhost:3100'; store.currentWorkspace.workspaceId = workspaceId;
  db = openWorkspaceDb('device-test'); await db.open(); await Promise.all(db.tables.map(t => t.clear()));
  context = resolveTowerPgWorkspaceContext(store); key = recordDeltaCursorKey(store);
});
const failure = (code, status = 409) => Object.assign(new Error(code), { code, status, payload: { error: code } });
function server() {
  const clients = new Map(), tokens = new Map(); let sequence = 0;
  const checkpoint = id => ({ protocol_version: 2, client_id: id, authority_epoch: 'epoch', initial_cursor: `initial:${id}`,
    checkpoint_cursor: clients.get(id).cursor, checkpoint_revision: String(clients.get(id).revision) });
  const client = vi.fn(async (_, id, request) => {
    if (request.operation === 'retire') { clients.delete(id); return {}; }
    if (request.operation === 'register' && !clients.has(id)) {
      clients.set(id, { cursor: null, revision: 0, position: 0 }); tokens.set(`initial:${id}`, { id, position: 0 });
    }
    if (!clients.has(id)) throw failure('client_not_registered');
    const state = clients.get(id);
    if (request.operation === 'ack') {
      // Every attempted acknowledgement must refer to an already committed
      // cursor/intent, including retries after a lost response.
      const local = (await db.sync_state.get(key))?.value;
      expect(local.cursor).toBe(request.cursor); expect(local.device.pendingAck.cursor).toBe(request.cursor);
      if (state.cursor === request.cursor) return checkpoint(id);
      const token = tokens.get(request.cursor);
      if (!token || token.id !== id) throw failure('page_token_invalid');
      if (request.expectedRevision !== String(state.revision) || token.revision !== state.revision) throw failure('checkpoint_conflict');
      if (token.position < state.position) throw failure('checkpoint_regression');
      state.cursor = request.cursor; state.position = token.position; state.revision++;
    }
    return checkpoint(id);
  });
  const page = vi.fn(async (_, request) => {
    const token = tokens.get(request.cursor), state = clients.get(request.clientId);
    if (!token || token.id !== request.clientId) throw failure('page_token_invalid');
    const position = token.position + 1;
    const next = `token:${++sequence}`;
    tokens.set(next, { id: request.clientId, position, revision: state.revision });
    return { ...(token.position === 0 ? fixture.canonical_upserts : fixture.one_message_delta),
      protocol_version: 2, client_id: request.clientId, checkpoint_revision: String(state.revision),
      mode: token.position === 0 ? 'snapshot' : 'delta', changes: token.position === 0 ? fixture.canonical_upserts.changes : [],
      snapshot_id: token.position === 0 ? `snapshot:${request.clientId}` : null, snapshot_complete: token.position === 0,
      partitions_complete: fixture.canonical_upserts.families, has_more: token.position === 0, next_cursor: next };
  });
  return { client, page, clients, tokens };
}
function harness(remote = server()) {
  const materialize = vi.fn(bundle => hydrateTowerPgSyncBundle(store, bundle, { migrateLegacyAutopilotLaunchers: async () => {} }));
  const ports = { context, cursorKey: key, options: {}, readState: async k => (await db.sync_state.get(k))?.value,
    materialize, readPage: remote.page, client: remote.client, assertCurrent: () => {} };
  return { remote, ports, run: options => syncDeviceRecords({ ...ports, options: options || ports.options }) };
}
const state = async () => (await db.sync_state.get(key))?.value;

describe('capability negotiation', () => {
  it.each([undefined, { protocol_versions: [1], device_checkpoints: false }, { protocol_versions: [1, 2], device_checkpoints: true }])('discovers %j once', async record_sync => {
    const ctx = { ...context, sessionNpub: crypto.randomUUID() }, read = vi.fn(async () => ({ record_sync }));
    const expected = record_sync?.device_checkpoints ? 2 : 1;
    expect(await discoverRecordProtocol(ctx, read)).toBe(expected); expect(await discoverRecordProtocol(ctx, read)).toBe(expected);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('caches an absent old service but retries auth/transport discovery failures', async () => {
    const old = vi.fn(async () => { throw failure('missing', 404); }); const ctx = { ...context, sessionNpub: crypto.randomUUID() };
    expect(await discoverRecordProtocol(ctx, old)).toBe(1); expect(await discoverRecordProtocol(ctx, old)).toBe(1); expect(old).toHaveBeenCalledTimes(1);
    const denied = vi.fn(async () => { throw failure('auth', 401); }); const ctx2 = { ...context, sessionNpub: crypto.randomUUID() };
    await expect(discoverRecordProtocol(ctx2, denied)).rejects.toThrow('auth'); await expect(discoverRecordProtocol(ctx2, denied)).rejects.toThrow('auth'); expect(denied).toHaveBeenCalledTimes(2);
  });
});

it('adopts a populated v1 cache through a new snapshot, preserving pending writes and handover', async () => {
  await applyPgRecordChanges(store, fixture.canonical_upserts);
  await db.chat_messages.put({ record_id: 'draft', body: 'local user write', sync_status: 'pending' });
  await db.pending_writes.add({ record_id: 'draft' });
  const h = harness(); await h.run();
  expect(h.remote.page.mock.calls[0][1].cursor).toMatch(/^initial:/);
  expect((await state()).device.clientId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await db.pending_writes.count()).toBe(1); expect((await db.chat_messages.get('draft')).body).toBe('local user write');
  expect((await state()).converged).toBe(true); expect((await state()).device.pendingAck).toBeNull();
  await h.run(); expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(1);
  expect(h.remote.page.mock.calls.filter(c => c[1].cursor.startsWith('initial:'))).toHaveLength(1);
});

it('rolls back a failed page transaction and sends no acknowledgement; reload resumes bootstrap', async () => {
  const h = harness(), original = h.ports.materialize;
  h.ports.materialize = async bundle => original(bundle.changes ? { ...bundle, local_apply_options: { ...bundle.local_apply_options, beforeCommit: () => { throw new Error('crash before commit'); } } } : bundle);
  await expect(h.run()).rejects.toThrow('crash before commit');
  expect(await db.pg_record_rows.count()).toBe(0); expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.some(c => c[2].operation === 'ack')).toBe(false);
  h.ports.materialize = original; await h.run(); expect((await state()).converged).toBe(true);
});

it('recovers a crash after local commit and before ack', async () => {
  const h = harness(), original = h.ports.materialize; let crash = true;
  h.ports.materialize = async bundle => { const result = await original(bundle); if (bundle.changes && crash) { crash = false; throw new Error('after commit'); } return result; };
  await expect(h.run()).rejects.toThrow('after commit'); const committed = await state();
  expect(committed.device.pendingAck.cursor).toBe(committed.cursor);
  await h.run(); expect(h.remote.client.mock.calls.find(c => c[2].operation === 'ack')[2].cursor).toBe(committed.cursor);
  expect((await state()).device.pendingAck).toBeNull();
});

it('retries a lost ack response idempotently after reconnect without undoing local rows', async () => {
  const h = harness(), original = h.ports.client; let lost = true;
  h.ports.client = async (...args) => { const result = await original(...args); if (args[2].operation === 'ack' && lost) { lost = false; throw new Error('response lost'); } return result; };
  await expect(h.run()).rejects.toThrow('response lost'); const committed = await state();
  expect(h.remote.clients.get(committed.device.clientId).revision).toBe(1);
  await h.run(); expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'ack' && c[2].cursor === committed.cursor)).toHaveLength(2);
});

it('obtains a fresh issuance revision by paging local state after CAS conflict', async () => {
  const h = harness(), original = h.ports.client; let conflict = true;
  h.ports.client = async (...args) => {
    if (args[2].operation === 'ack' && conflict) { conflict = false; h.remote.clients.get(args[1]).revision++; throw failure('checkpoint_conflict'); }
    return original(...args);
  };
  await h.run();
  expect(h.remote.client.mock.calls.some(c => c[2].operation === 'read')).toBe(true);
  const firstAck = h.remote.tokens.get(h.remote.page.mock.results[0].value ? (await h.remote.page.mock.results[0].value).next_cursor : '');
  expect(firstAck.position).toBe(1); expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.page.mock.calls[1][1].cursor).toBe((await h.remote.page.mock.results[0].value).next_cursor);
});

it.each(['reset_required', 'history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid'])('replaces only this owned cache after %s', async code => {
  const h = harness(); await h.run(); const old = (await state()).device.clientId;
  await db.pending_writes.add({ record_id: 'pending' });
  h.remote.page.mockRejectedValueOnce(failure(code)); await h.run();
  expect((await state()).device.clientId).not.toBe(old); expect(await db.pending_writes.count()).toBe(1);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'retire').map(c => c[1])).toEqual([old]);
});

it('hides revoked authority immediately and keeps pending commands for recovery', async () => {
  const h = harness(); await h.run(); await db.pending_writes.add({ record_id: 'pending' });
  h.remote.page.mockRejectedValueOnce(failure('workspace_membership_required', 403));
  await expect(h.run()).rejects.toThrow('workspace_membership_required');
  expect(await db.pg_record_rows.count()).toBe(0); expect(await db.chat_messages.count()).toBe(0); expect(await db.pending_writes.count()).toBe(1);
});

it('does not downgrade or endlessly register on capacity and authentication errors', async () => {
  const h = harness(); h.remote.client.mockRejectedValue(failure('client_capacity'));
  await expect(h.run()).rejects.toThrow('client_capacity'); const id = (await state()).device.clientId;
  await expect(h.run()).rejects.toThrow('client_capacity'); expect((await state()).device.clientId).toBe(id);
  h.remote.client.mockRejectedValue(failure('unauthorized', 401)); await expect(h.run()).rejects.toThrow('unauthorized'); expect(h.remote.page).not.toHaveBeenCalled();
});

it('rejects a late page when its cache generation was replaced while requesting', async () => {
  const h = harness(), original = h.ports.readPage;
  h.ports.readPage = async (...args) => { const page = await original(...args); const s = await state(); await db.sync_state.put({ key, value: { ...s, localGeneration: s.localGeneration + 1 } }); return page; };
  await expect(h.run()).rejects.toThrow('Stale device page'); expect(await db.pg_record_rows.count()).toBe(0);
  expect(h.remote.client.mock.calls.some(c => c[2].operation === 'ack')).toBe(false);
});

it.each(['rows', 'identity', 'all'])('creates a new ID after cache loss: %s', async what => {
  const h = harness(); await h.run(); const old = (await state()).device.clientId;
  if (what === 'rows') await db.pg_record_rows.clear();
  if (what === 'identity') await db.sync_state.delete(DEVICE_CACHE_OWNER_KEY);
  if (what === 'all') await Promise.all(db.tables.map(t => t.clear()));
  await h.run(); expect((await state()).device.clientId).not.toBe(old);
  expect(h.remote.page.mock.calls.at(-2)[1].cursor).toMatch(/^initial:/);
});

it.each(['actor', 'backend', 'workspace'])('does not reuse an ID or cursor after a %s switch', async dimension => {
  const h = harness(); await h.run(); const old = (await state()).device.clientId;
  if (dimension === 'actor') store.session.npub = 'other';
  if (dimension === 'backend') store.backendUrl = 'http://localhost:3101';
  if (dimension === 'workspace') store.currentWorkspace.workspaceId = 'other-workspace';
  const next = resolveTowerPgWorkspaceContext(store);
  expect(deviceCheckpointScope(next)).not.toBe(deviceCheckpointScope(context));
  // For actor/backend, canonical fixture workspace remains identical. A workspace
  // switch uses an empty valid snapshot from the new workspace.
  key = recordDeltaCursorKey(store); h.ports.cursorKey = key; h.ports.context = next;
  if (dimension === 'workspace') { const original = h.ports.readPage; h.ports.readPage = async (...args) => ({ ...await original(...args), changes: [] }); }
  await h.run(); expect((await state()).device.clientId).not.toBe(old);
  expect(h.remote.page.mock.calls.at(-2)[1].cursor).toMatch(/^initial:/);
});

it('gives independent caches different IDs and serializes tabs sharing the same cache', async () => {
  const h = harness(); let tail = Promise.resolve();
  const locks = { request: vi.fn((_name, _options, callback) => { const run = tail.then(callback); tail = run.catch(() => {}); return run; }) };
  const [a, b] = await Promise.all([withDeviceCacheLock('same', h.run, locks), withDeviceCacheLock('same', h.run, locks)]);
  expect(a.clientId).toBe(b.clientId); expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(1);
  db = openWorkspaceDb('independent-device-test'); await db.open(); await Promise.all(db.tables.map(t => t.clear()));
  const c = await h.run(); expect(c.clientId).not.toBe(a.clientId);
});

it('keeps v1 fallback on an old server without making a device registration', async () => {
  const remote = server(); const read = vi.fn(async () => ({ ...fixture.one_message_delta, changes: [], has_more: false, next_cursor: 'v1-cursor' }));
  const oldContextStore = { ...store, session: { npub: crypto.randomUUID() } };
  const result = await syncTowerPgWorkspace(oldContextStore, {}, { getTowerPgService: async () => ({}), getTowerPgRecordSync: read,
    getTowerPgResourceViewStates: async () => ({}), getTowerPgWorkspaceMembers: async () => ({ members: [] }), getTowerPgWorkspaceGroups: async () => ({ groups: [] }),
    migrateLegacyAutopilotLaunchers: async () => {}, towerPgRecordClient: remote.client });
  expect(result.protocolVersion).toBe(1); expect(remote.client).not.toHaveBeenCalled(); expect(read.mock.calls[0][1].cursor).toBeNull();
});

it('replays a local position behind Tower until caught up without jumping to Tower cursor', async () => {
  const h = harness(), original = h.ports.client; let advanced = false;
  h.ports.client = async (...args) => {
    if (args[2].operation === 'ack' && !advanced) {
      advanced = true; const remote = h.remote.clients.get(args[1]);
      remote.cursor = 'server-ahead-with-unmaterialized-records'; remote.position = 4; remote.revision = 5;
      throw failure('checkpoint_conflict');
    }
    return original(...args);
  };
  await h.run();
  expect(h.remote.page.mock.calls.length).toBe(4);
  expect(h.remote.page.mock.calls.some(c => c[1].cursor === 'server-ahead-with-unmaterialized-records')).toBe(false);
  expect((await state()).device.pendingAck).toBeNull(); expect((await state()).device.revision).toBe('6');
});

it('replays a local position ahead of Tower with a fresh revision after a stale ack', async () => {
  const h = harness(), original = h.ports.client; let stopped = false;
  h.ports.client = async (...args) => { if (args[2].operation === 'ack' && !stopped) { stopped = true; throw new Error('offline before ack'); } return original(...args); };
  await expect(h.run()).rejects.toThrow('offline'); const local = await state();
  expect(h.remote.clients.get(local.device.clientId).cursor).toBeNull();
  // A sibling branch changed the revision at an older position, so the old
  // token cannot ack even though its local materialisation is ahead.
  h.remote.clients.get(local.device.clientId).revision = 7;
  await h.run();
  expect(h.remote.page.mock.calls[1][1].cursor).toBe(local.cursor);
  expect((await state()).device.revision).toBe('8');
});

it('resumes snapshot retirement after interruption and acknowledges only its final committed cursor', async () => {
  const h = harness(), original = h.ports.materialize; let interrupted = false;
  await db.chat_messages.put({ record_id: 'obsolete', pg_backend: true, channel_id: 'old', sync_status: 'synced' });
  h.ports.materialize = async bundle => original(bundle.changes && bundle.mode === 'delta' ? { ...bundle, local_apply_options: {
    ...bundle.local_apply_options, onRetirementProgress: () => { if (!interrupted) { interrupted = true; throw new Error('retirement interrupted'); } },
  } } : bundle);
  await expect(h.run()).rejects.toThrow('retirement interrupted');
  const interruptedState = await state();
  expect(interruptedState.snapshotRetirement.pendingAck).toBeTruthy(); expect(interruptedState.device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'ack')).toHaveLength(1);
  await h.run(); expect(await db.chat_messages.get('obsolete')).toBeUndefined();
  expect((await state()).snapshotRetirement).toBeNull(); expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'ack')[1][2].cursor).toBe(interruptedState.snapshotRetirement.nextCursor);
});

it('atomically saves actor sidecars and rejects another client or out-of-order page', async () => {
  const h = harness(); await h.run(); const committed = await state();
  const options = { expectedCursor: committed.cursor, expectedGeneration: committed.localGeneration,
    deviceScope: committed.device.scope, authorityEpoch: committed.device.authorityEpoch };
  const next = await h.remote.page(workspaceId, { cursor: committed.cursor, clientId: committed.device.clientId });
  next.actors = [{ actor_id: 'test-actor', npub: 'actor-npub', kind: 'human', display_name: 'Actor' }];
  await expect(applyPgRecordChanges(store, next, { ...options, beforeCommit: () => { throw new Error('rollback'); } })).rejects.toThrow('rollback');
  expect(await db.pg_actors.get('test-actor')).toBeUndefined(); expect((await state()).cursor).toBe(committed.cursor);
  await applyPgRecordChanges(store, next, options);
  expect(await db.pg_actors.get('test-actor')).toBeTruthy(); expect((await state()).device.pendingAck.cursor).toBe(next.next_cursor);
  await expect(applyPgRecordChanges(store, { ...next, next_cursor: 'out-of-order' }, options)).rejects.toThrow('cursor changed');
  await expect(applyPgRecordChanges(store, { ...next, client_id: crypto.randomUUID() }, { ...options, expectedCursor: next.next_cursor })).rejects.toThrow('identity changed');
});

it('never sends a v2 cursor to an older server after a rollback', async () => {
  const h = harness(); await h.run();
  const oldRead = vi.fn(async () => ({ ...fixture.one_message_delta, changes: [], mode: 'delta', snapshot_id: null, has_more: false, next_cursor: 'old-server-cursor' }));
  await syncTowerPgWorkspace(store, {}, { getTowerPgRecordSync: oldRead, getTowerPgResourceViewStates: async () => ({}),
    getTowerPgWorkspaceMembers: async () => ({ members: [] }), getTowerPgWorkspaceGroups: async () => ({ groups: [] }), migrateLegacyAutopilotLaunchers: async () => {} });
  expect(oldRead.mock.calls[0][1].cursor).toBeNull(); expect((await state()).device).toBeUndefined();
});

it('uses a worker-owned lease when Web Locks are unavailable and fences an expired owner', async () => {
  const { commitDeviceLease, withWorkerDeviceLease } = await import('../src/pg-device-checkpoints.js');
  const h = harness();
  await withWorkerDeviceLease(h.ports.materialize, () => {}, async lease => {
    const run = bundle => h.ports.materialize({ ...bundle, local_apply_options: { ...bundle.local_apply_options, deviceLease: lease.token } });
    await syncDeviceRecords({ ...h.ports, materialize: run, assertHeld: lease.assertHeld });
    expect((await state()).device.pendingAck).toBeNull();
    // Expiration/reclamation simulates a suspended tab without waiting two minutes.
    await db.sync_state.put({ key: 'record-device-cache-lease', value: { token: lease.token, expiresAt: 0 } });
    const replacement = crypto.randomUUID(); expect(await commitDeviceLease({ type: 'acquire', token: replacement })).toBe(true);
    const s = await state(); const page = await h.remote.page(workspaceId, { cursor: s.cursor, clientId: s.device.clientId });
    await expect(run({ ...page, local_apply_options: { expectedCursor: s.cursor, expectedGeneration: s.localGeneration,
      deviceScope: s.device.scope, authorityEpoch: s.device.authorityEpoch } })).rejects.toThrow('lease lost');
    expect((await state()).cursor).toBe(s.cursor);
  });
});

it('coordinates fallback leases between tabs and does not release someone else’s lease', async () => {
  const { commitDeviceLease } = await import('../src/pg-device-checkpoints.js'); const a = crypto.randomUUID(), b = crypto.randomUUID();
  expect(await commitDeviceLease({ type: 'acquire', token: a })).toBe(true);
  expect(await commitDeviceLease({ type: 'acquire', token: b })).toBe(false);
  await expect(commitDeviceLease({ type: 'release', token: b })).rejects.toThrow('lease lost');
  await commitDeviceLease({ type: 'release', token: a }); expect(await commitDeviceLease({ type: 'acquire', token: b })).toBe(true);
});

it('keeps a revoked replacement ID stable across repeated denied reconnects', async () => {
  const h = harness(); await h.run(); h.remote.page.mockRejectedValue(failure('workspace_membership_required', 403));
  await expect(h.run()).rejects.toThrow('workspace_membership_required'); const replacement = (await state()).device.clientId;
  h.ports.client = async () => { throw failure('workspace_membership_required', 403); };
  await expect(h.run()).rejects.toThrow('workspace_membership_required'); await expect(h.run()).rejects.toThrow('workspace_membership_required');
  expect((await state()).device.clientId).toBe(replacement);
});

it('generates a random canonical nonzero v4 cache UUID without secure-origin randomUUID', async () => {
  const { createDeviceCacheId, canonicalClientId } = await import('../src/pg-device-checkpoints.js');
  const random = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const first = createDeviceCacheId(random), second = createDeviceCacheId(random);
  expect(canonicalClientId(first)).toBe(true); expect(first).not.toBe(second);
  expect(first[14]).toBe('4'); expect('89ab').toContain(first[19]);
});
