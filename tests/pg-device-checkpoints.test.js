import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import boundedFixture from './fixtures/flightdeck-bounded-snapshot-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle, resolveTowerPgWorkspaceContext, syncTowerPgWorkspace } from '../src/pg-read-hydrator.js';
import { applyPgRecordChanges, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { discoverRecordProtocol, discoverRecordCapabilities, syncDeviceRecords, withDeviceCacheLock, deviceCheckpointScope, DEVICE_CACHE_OWNER_KEY } from '../src/pg-device-checkpoints.js';
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

async function largeHarness({ actorLabel = false } = {}) {
  const h = harness(), read = h.ports.readPage, client = h.ports.client;
  const change = { ...fixture.one_message_delta.changes[0], row: { ...fixture.one_message_delta.changes[0].row,
    body: actorLabel ? 'small record' : '🙂é'.repeat(210000) } };
  const actors = actorLabel ? [{ actor_id: change.row.created_by_actor_id, npub: 'viewer', kind: 'human', display_name: 'x'.repeat(1100000) }] : [];
  const bytes = new TextEncoder().encode(JSON.stringify({ change, actors }));
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const manifest = { manifest_id: crypto.randomUUID(), family: change.family, id: change.id, version: change.version,
    sha256, total_bytes: bytes.length, chunk_bytes: 262144, chunk_count: Math.ceil(bytes.length / 262144) };
  const manifestPages = new Set();
  h.ports.readPage = async (...args) => {
    expect(args[1].largeRecords).toBe('chunked_v1');
    const page = await read(...args);
    if (page.mode === 'snapshot') manifestPages.add(page.next_cursor);
    return { ...page, changes: [], actors: [], large_records: page.mode === 'snapshot' ? [manifest] : [],
      handover: { target_position: '2', through_position: page.has_more ? '1' : '2', complete: !page.has_more,
        authority_epoch: 'epoch', access_revision: '1' } };
  };
  h.ports.readChunk = vi.fn(async (_, clientId, cursor, manifestId, index) => {
    expect(manifestPages.has(cursor)).toBe(true); expect(manifestId).toBe(manifest.manifest_id);
    expect(clientId).toBe((await state()).device.clientId);
    return bytes.slice(index * 262144, (index + 1) * 262144);
  });
  h.ports.client = async (...args) => {
    if (args[2].operation === 'ack' && manifestPages.has(args[2].cursor)) {
      expect(args[2].largeRecordReceipts).toEqual([{ manifest_id: manifest.manifest_id, sha256 }]);
      expect((await db.chat_messages.get(change.id)).body).toBe(change.row.body);
      if (actorLabel) expect((await db.pg_actors.get(actors[0].actor_id)).display_name).toBe(actors[0].display_name);
    }
    return client(...args);
  };
  return { ...h, manifest, bytes, change, options: { extension: 'bounded_snapshot_v1', largeRecords: 'chunked_v1' } };
}

it.each([false, true])('verifies bounded byte chunks and commits the row/sidecars before receipt ack (large actor=%s)', async actorLabel => {
  const h = await largeHarness({ actorLabel }); await h.run(h.options);
  expect(h.ports.readChunk).toHaveBeenCalledTimes(h.manifest.chunk_count);
  expect((await state()).converged).toBe(true); expect((await state()).device.pendingAck).toBeNull();
  expect(await db.sync_state.get('record-large-assembly')).toBeUndefined();
  expect(await db.sync_state.where('key').startsWith('record-large-assembly:chunk:').count()).toBe(0);
});

it('counts a manifest once in the wire budget even when decoded actors accompany 199 access entries', async () => {
  const h = await largeHarness({ actorLabel: true }), read = h.ports.readPage;
  h.ports.readPage = async (...args) => {
    const page = await read(...args);
    return { ...page, access_revision: '1', retention_policy: 'retain_downloaded',
      access_changes: page.large_records.length ? Array.from({ length: 199 }, (_, i) => ({
        family: 'message', resource_type: 'channel', resource_id: `channel-${i}`, status: 'granted',
      })) : [] };
  };
  await h.run(h.options); expect((await state()).converged).toBe(true);
});

it.each(['interrupt', 'digest', 'quota', 'generation', 'access loss', 'expiry', 'cache loss', 'reordered'])('leaves the durable cursor unadvanced after large assembly %s and discards chunks', async scenario => {
  const h = await largeHarness(), read = h.ports.readChunk, materialize = h.ports.materialize;
  if (scenario === 'quota') h.manifest.total_bytes = 64 * 1024 * 1024 + 1;
  if (scenario === 'quota') h.manifest.chunk_count = Math.ceil(h.manifest.total_bytes / 262144);
  h.ports.readChunk = async (...args) => {
    if (scenario === 'interrupt' && args[4] === 1) throw new Error('interrupted chunk');
    const bytes = await read(...args);
    if (scenario === 'digest' && args[4] === 0) bytes[bytes.length - 1] ^= 1;
    if (scenario === 'generation' && args[4] === 0) {
      const prior = await state(); await db.sync_state.put({ key, value: { ...prior, localGeneration: prior.localGeneration + 1 } });
    }
    if (scenario === 'access loss' && args[4] === 0) {
      const prior = await state(); await db.sync_state.put({ key, value: { ...prior, accessLost: true } });
    }
    return bytes;
  };
  if (['expiry', 'cache loss', 'reordered'].includes(scenario)) h.ports.materialize = async bundle => {
    if (bundle.large_record_action?.type === 'finish') {
      if (scenario === 'expiry') {
        const row = await db.sync_state.get('record-large-assembly'); await db.sync_state.put({ ...row, value: { ...row.value, expiresAt: 0 } });
      }
      if (scenario === 'cache loss') await db.sync_state.delete('record-large-assembly:chunk:1');
    }
    if (scenario === 'reordered' && bundle.large_record_action?.type === 'chunk') return materialize({ ...bundle,
      large_record_action: { ...bundle.large_record_action, index: 1 } });
    return materialize(bundle);
  };
  await expect(h.run(h.options)).rejects.toThrow();
  expect(await db.pg_record_rows.count()).toBe(0); expect((await state()).cursor).toMatch(/^initial:/);
  expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.some(c => c[2].operation === 'ack')).toBe(false);
  expect(await db.sync_state.where('key').startsWith('record-large-assembly').count()).toBe(0);
  if (scenario === 'interrupt') { h.ports.readChunk = read; await h.run(h.options); expect((await state()).converged).toBe(true); }
});

it('verifies large records in native HTTP contexts without SubtleCrypto', async () => {
  const h = await largeHarness(), original = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
  try { await h.run(h.options); expect((await state()).converged).toBe(true); }
  finally { vi.stubGlobal('crypto', original); }
});

it('retries lost large-record acknowledgement with the durable exact receipts', async () => {
  const h = await largeHarness(), client = h.ports.client; let lost = true;
  h.ports.client = async (...args) => {
    const result = await client(...args);
    if (args[2].largeRecordReceipts && lost) { lost = false; throw new Error('lost large ack'); }
    return result;
  };
  await expect(h.run(h.options)).rejects.toThrow('lost large ack');
  const committed = await state(); expect(committed.device.pendingAck.largeRecordReceipts).toBeTruthy();
  await h.run(h.options);
  expect(h.ports.readChunk).toHaveBeenCalledTimes(h.manifest.chunk_count);
  expect(h.remote.client.mock.calls.filter(c => c[2].largeRecordReceipts)).toHaveLength(2);
  expect((await state()).device.pendingAck).toBeNull();
});

it.each(['commit', 'revocation', 'source', 'conflict'])('preserves downloads and never skips a large record during %s recovery', async scenario => {
  const h = await largeHarness(), read = h.ports.readChunk, materialize = h.ports.materialize, client = h.ports.client;
  await db.chat_messages.put({ record_id: 'retained', body: 'download', sync_status: 'synced', pg_backend: true });
  let fail = true;
  h.ports.readChunk = async (...args) => {
    if (fail && args[4] === 1 && ['revocation', 'source'].includes(scenario)) {
      fail = false; throw failure(scenario === 'revocation' ? 'record_access_required' : 'large_record_changed', scenario === 'revocation' ? 403 : 409);
    }
    return read(...args);
  };
  h.ports.materialize = async bundle => materialize(scenario === 'commit' && bundle.large_record_action?.type === 'finish'
    ? { ...bundle, local_apply_options: { ...bundle.local_apply_options, beforeCommit: () => { throw new Error('large local commit failed'); } } } : bundle);
  h.ports.client = async (...args) => {
    if (scenario === 'conflict' && fail && args[2].largeRecordReceipts) { fail = false; throw failure('checkpoint_conflict'); }
    return client(...args);
  };
  if (['commit', 'revocation'].includes(scenario)) {
    await expect(h.run(h.options)).rejects.toThrow();
    expect(h.remote.client.mock.calls.some(c => c[2].operation === 'ack')).toBe(false);
    expect((await state()).device.pendingAck).toBeNull();
  } else {
    await h.run(h.options); expect((await state()).converged).toBe(true);
    expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(2);
  }
  expect((await db.chat_messages.get('retained')).body).toBe('download');
  expect(await db.sync_state.where('key').startsWith('record-large-assembly').count()).toBe(0);
});

describe('capability negotiation', () => {
  it('negotiates only the advertised finite-boundary extension, independently of chunk support', async () => {
    const ctx = { ...context, sessionNpub: crypto.randomUUID() };
    expect(await discoverRecordCapabilities(ctx, async () => ({ record_sync: {
      device_checkpoints: true, protocol_versions: [1, 2], extensions: ['bounded_snapshot_v1', 'chunked_v1'],
      priority_feed: true, context_closure: true, repair_manifest: true, selective_repair: true,
      cache_adoption: { version: 1 },
    } }))).toEqual({ protocolVersion: 2, extension: 'bounded_snapshot_v1', largeRecords: 'chunked_v1',
      priorityFeed: true, contextClosure: true, repairManifest: true, selectiveRepair: true, cacheAdoption: true });
  });
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

it('commits a finite handover certificate and repeats negotiation on every dependent page', async () => {
  const h = harness(), read = h.ports.readPage;
  h.ports.readPage = async (...args) => {
    expect(args[1].extension).toBe('bounded_snapshot_v1');
    const page = await read(...args);
    return { ...page, handover: page.has_more ? boundedFixture.pending : boundedFixture.complete };
  };
  await h.run({ extension: 'bounded_snapshot_v1' });
  expect((await state()).handover).toEqual(boundedFixture.complete);
  expect((await state()).converged).toBe(true);
  expect((await state()).device.pendingAck).toBeNull();
});

it('persists negotiated intent before downloading and refuses downgrade across restart and reset', async () => {
  const h = harness();
  h.remote.page.mockRejectedValueOnce(new Error('interrupted before first page'));
  await expect(h.run({ extension: boundedFixture.extension })).rejects.toThrow('interrupted');
  const committed = await state();
  expect(committed.device.extension).toBe(boundedFixture.extension);
  await expect(h.run()).rejects.toThrow('extension is unavailable');
  expect(h.remote.page).toHaveBeenCalledTimes(1);
  await h.ports.materialize({ protocol_version: 2, reset_authority: true, local_apply_options: {
    preserveViews: true, retainDownloads: true, deviceScope: committed.device.scope,
    expectedCursor: committed.cursor, expectedGeneration: committed.localGeneration,
  } });
  expect((await state()).device.extension).toBe(boundedFixture.extension);
  await expect(h.run()).rejects.toThrow('extension is unavailable');
});

it('traverses empty pages and grant catchup, repairing a concurrent delete without stale resurrection', async () => {
  const h = harness(), read = h.ports.readPage; let index = 0;
  h.ports.readPage = async (...args) => {
    const page = await read(...args); index++;
    return { ...page, changes: index === 1 ? [] : index === 2 ? fixture.one_message_delta.changes
      : [...fixture.explicit_delete.changes, ...fixture.one_message_delta.changes],
      has_more: index < 3, access_revision: '3', retention_policy: 'retain_downloaded',
      access_changes: index === 2 ? [{ family: 'message', resource_type: 'channel',
        resource_id: fixture.one_message_delta.changes[0].row.channel_id, status: 'granted' }] : [],
      handover: index < 3 ? boundedFixture.pending : boundedFixture.complete };
  };
  const progress = vi.fn();
  await h.run({ extension: boundedFixture.extension, onProgress: progress });
  expect(h.remote.page).toHaveBeenCalledTimes(3);
  expect(progress.mock.calls.filter(([event]) => event.stage === 'complete')).toHaveLength(1);
  const change = fixture.explicit_delete.changes[0];
  expect((await db.pg_record_rows.get(`${change.family}:${change.id}`)).operation).toBe('delete');
  expect(await db.chat_messages.get(change.id)).toBeUndefined();
  expect((await state()).handover).toEqual(boundedFixture.complete);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'ack')).toHaveLength(3);
});

it('accepts an authority-gain repair target only with a newer access revision', async () => {
  const h = harness(), read = h.ports.readPage;
  h.ports.readPage = async (...args) => {
    const page = await read(...args);
    return { ...page, handover: { target_position: page.has_more ? '10' : '11',
      through_position: page.has_more ? '9' : '11', complete: !page.has_more,
      authority_epoch: 'epoch', access_revision: page.has_more ? '1' : '2' } };
  };
  await h.run({ extension: boundedFixture.extension });
  expect((await state()).handover.target_position).toBe('11');
  expect((await state()).converged).toBe(true);
});

it.each(['missing', 'premature', 'epoch', 'target', 'target-null', 'target-regression', 'target-newer-regression', 'manifest', 'entries'])('fails closed on invalid negotiated %s without ack or fallback', async scenario => {
  const h = harness(), read = h.ports.readPage;
  h.ports.readPage = async (...args) => {
    const page = await read(...args);
    const handover = { target_position: '10', through_position: page.has_more ? '9' : '10',
      complete: !page.has_more, authority_epoch: 'epoch', access_revision: '1' };
    if (scenario === 'missing') return page;
    if (scenario === 'premature') handover.complete = true;
    if (scenario === 'epoch') handover.authority_epoch = 'other';
    if (scenario === 'target' && !page.has_more) handover.target_position = '11';
    if (scenario === 'target-null' && !page.has_more) { handover.target_position = null; handover.complete = false; page.has_more = true; }
    if (scenario.startsWith('target-') && scenario.includes('regression') && !page.has_more) {
      handover.target_position = '8';
      if (scenario === 'target-newer-regression') handover.access_revision = '2';
    }
    return { ...page, handover, ...(scenario === 'manifest' ? { large_records: [{ manifest_id: 'unsupported' }] } : {}),
      ...(scenario === 'entries' ? { access_changes: Array.from({ length: 200 }, () => ({})) } : {}) };
  };
  await expect(h.run({ extension: 'bounded_snapshot_v1' })).rejects.toThrow();
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'ack')).toHaveLength(scenario.startsWith('target') ? 1 : 0);
  expect((await state()).converged).not.toBe(true);
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

it('atomically adopts an already-issued snapshot and requests only delta from the adopted checkpoint', async () => {
  await applyPgRecordChanges(store, fixture.canonical_upserts);
  await db.chat_messages.put({ record_id: 'draft', body: 'local user write', sync_status: 'pending' });
  await db.pending_writes.add({ record_id: 'draft' });
  const h = harness();
  await expect(h.run({ maxPages: 1 })).rejects.toThrow('maximum page count');
  const incomplete = await state();
  expect(incomplete.snapshotReconciliationPending).toBe(true);
  expect(h.remote.page.mock.calls[0][1].cursor).toMatch(/^initial:/);
  const adoptionStateKey = 'record-sync-aux:device-test:adoption';
  await db.sync_state.put({ key: adoptionStateKey, value: { status: 'pending', response: { status: 'adopted' } } });
  const adopt = vi.fn(async ({ clientId, expectedCheckpointRevision }) => {
    const serverClient = h.remote.clients.get(clientId);
    expect(expectedCheckpointRevision).toBe(String(serverClient.revision));
    serverClient.cursor = 'adopted:cursor'; serverClient.position = 1; serverClient.revision += 1;
    h.remote.tokens.set('adopted:cursor', { id: clientId, position: 1, revision: serverClient.revision });
    return { stateKey: adoptionStateKey, checkpoint: {
      protocol_version: 2, client_id: clientId, authority_epoch: 'epoch', initial_cursor: 'adopted:cursor',
      checkpoint_cursor: 'adopted:cursor', checkpoint_revision: String(serverClient.revision),
    } };
  });
  h.remote.page.mockClear();
  await h.run({ cacheAdoption: true, adopt });
  const adopted = await state();
  expect(adopt).toHaveBeenCalledTimes(1);
  expect(h.remote.page.mock.calls.map(call => call[1].cursor)).toEqual(['adopted:cursor']);
  await expect(h.remote.page.mock.results[0].value).resolves.toMatchObject({ mode: 'delta' });
  expect(adopted).toMatchObject({ resetting: false, snapshotReconciliationPending: false,
    snapshotRetirement: null, snapshotId: null, converged: true });
  expect(await db.sync_state.get(adoptionStateKey)).toBeUndefined();
  expect(await db.pending_writes.count()).toBe(1);
  expect((await db.chat_messages.get('draft')).body).toBe('local user write');
});

it('retains the incomplete snapshot and cache when adoption pauses', async () => {
  await applyPgRecordChanges(store, fixture.canonical_upserts);
  const h = harness();
  await expect(h.run({ maxPages: 1 })).rejects.toThrow('maximum page count');
  const incomplete = await state();
  const adopt = vi.fn(async () => { throw Object.assign(new Error('offline'), { status: 503 }); });
  h.remote.page.mockClear();
  await expect(h.run({ cacheAdoption: true, adopt })).rejects.toThrow('offline');
  expect(await state()).toEqual(incomplete);
  expect(await db.pg_record_rows.count()).toBeGreaterThan(0);
  expect(h.remote.page).not.toHaveBeenCalled();
  expect(h.remote.client.mock.calls.filter(call => call[2].operation === 'retire')).toHaveLength(0);
});

const auxiliaryMessage = id => {
  const base = fixture.one_message_delta.changes[0];
  return { ...base, id, version: '40', row: { ...base.row, id, body: `Auxiliary ${id}` } };
};
const applyAuxiliary = changes => hydrateTowerPgSyncBundle(store, { protocol_version: 1, mode: 'delta',
  families: fixture.canonical_upserts.families, changes, actors: [], next_cursor: `auxiliary-${changes[0].id}`,
  has_more: false, snapshot_id: null, local_apply_options: { reconcileOnly: true } },
{ migrateLegacyAutopilotLaunchers: async () => {} });

it('keeps the committed checkpoint after priority/context/repair rows grow the cache', async () => {
  const h = harness(); await h.run();
  const committed = await state();
  await applyAuxiliary([auxiliaryMessage('50000000-0000-4000-8000-000000000101')]);
  expect((await db.sync_state.get(DEVICE_CACHE_OWNER_KEY)).value.canonicalCount).toBeLessThan(await db.pg_record_rows.count());
  h.remote.page.mockClear();
  await h.run();
  expect((await state()).device.clientId).toBe(committed.device.clientId);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(1);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'retire')).toHaveLength(0);
  expect((await db.sync_state.get(DEVICE_CACHE_OWNER_KEY)).value.canonicalCount).toBe(await db.pg_record_rows.count());
  // A second ordinary launch requests one bounded delta from the durable cursor.
  expect(h.remote.page.mock.calls.map(c => c[1].cursor)).toEqual([committed.cursor]);
});

it('keeps a completed multi-page catch-up completed across ordinary launches whose priority band adds rows', async () => {
  store.backendUrl = 'http://localhost:3197'; context = resolveTowerPgWorkspaceContext(store); key = recordDeltaCursorKey(store);
  const remote = server();
  let launch = 0;
  const readPriority = vi.fn(async (_workspaceId, options) => ({
    changes: [auxiliaryMessage(`50000000-0000-4000-8000-00000000020${launch}`)],
    has_more: true, next_cursor: `historical-${launch}`, captured_head: String(10 + launch),
    coverage: {}, retention_policy: 'retain_downloaded', requested_cursor: options.cursor,
  }));
  const deps = {
    getTowerPgService: async () => ({ record_sync: { device_checkpoints: true, protocol_versions: [1, 2], priority_feed: true } }),
    getTowerPgRecordSync: remote.page, towerPgRecordClient: remote.client,
    // Web Locks always passes the granted Lock (or null when ifAvailable finds
    // it held); an always-free lock grants immediately.
    deviceLocks: { request: (name, options, run) => run({ name, mode: options?.mode || 'exclusive' }) },
    prioritySync: { readPriority },
    getTowerPgResourceViewStates: async () => ({}), getTowerPgWorkspaceMembers: async () => ({ members: [] }),
    getTowerPgWorkspaceGroups: async () => ({ groups: [] }), migrateLegacyAutopilotLaunchers: async () => {},
  };
  const launchProgress = [];
  const relaunch = async () => {
    launch += 1;
    remote.page.mockClear();
    const progress = [];
    await syncTowerPgWorkspace(store, { onProgress: update => progress.push(update) }, deps);
    launchProgress.push(progress);
  };
  await relaunch();
  const completed = await state();
  expect(completed.converged).toBe(true);
  expect(remote.page.mock.calls.length).toBeGreaterThan(1);
  for (let i = 0; i < 3; i++) {
    const before = await state();
    await relaunch();
    // Only one bounded delta from the durable head: no registration, no snapshot.
    expect(remote.page.mock.calls.map(c => c[1].cursor)).toEqual([before.cursor]);
    expect((await state()).device.clientId).toBe(completed.device.clientId);
    expect((await state()).converged).toBe(true);
  }
  expect(readPriority).toHaveBeenCalledTimes(4);
  expect(readPriority.mock.calls.every(([, options]) => options.cursor === null && options.limit === 32)).toBe(true);
  expect(remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(1);
  expect(remote.client.mock.calls.filter(c => c[2].operation === 'retire')).toHaveLength(0);
  expect(launchProgress.every(progress => progress.filter(event => event.stage === 'complete').length === 1)).toBe(true);
  expect(launchProgress.flat().filter(event => event.stage === 'recovery')).toHaveLength(0);
  expect(launchProgress.slice(1).flat().some(event => event.fullSnapshot === true)).toBe(false);
  expect((await db.sync_state.get('record-sync-aux:device-test:priority')).value).toMatchObject({
    status: 'pending', cursor: 'historical-1',
  });
  expect((await db.sync_state.get('record-sync-aux:device-test:queue')).value).toMatchObject({
    status: 'ready', items: [{ lane: 'priority', cursor: 'historical-1' }, { lane: 'completeness', durable: true }],
  });
});

it('resumes a build-2460 cache whose owner count drifted below auxiliary growth without re-adoption', async () => {
  const h = harness(); await h.run();
  const committed = await state();
  // Builds 2457–2460 committed auxiliary rows without refreshing the owner count.
  const owner = (await db.sync_state.get(DEVICE_CACHE_OWNER_KEY)).value;
  await applyAuxiliary([auxiliaryMessage('50000000-0000-4000-8000-000000000102')]);
  await db.sync_state.put({ key: DEVICE_CACHE_OWNER_KEY, value: owner });
  h.remote.page.mockClear();
  await h.run();
  expect((await state()).device.clientId).toBe(committed.device.clientId);
  expect(h.remote.page.mock.calls.map(c => c[1].cursor)).toEqual([committed.cursor]);
  expect(h.remote.page.mock.calls.some(c => String(c[1].cursor).startsWith('initial:'))).toBe(false);
  expect((await db.sync_state.get(DEVICE_CACHE_OWNER_KEY)).value.canonicalCount).toBe(await db.pg_record_rows.count());
});

it('repairs canonical rows lost below the committed owner count before considering a replacement snapshot', async () => {
  const h = harness(); await h.run();
  const committed = await state();
  await db.pg_record_rows.delete('message:50000000-0000-4000-8000-000000000004');
  const repair = vi.fn(async () => ({ repaired: 1 }));
  h.remote.page.mockClear();
  await h.run({ repair });
  expect(repair).toHaveBeenCalledWith({ reason: 'cache_count_regressed', cursor: committed.cursor });
  expect((await state()).device.clientId).toBe(committed.device.clientId);
  expect(h.remote.page.mock.calls.map(c => c[1].cursor)).toEqual([committed.cursor]);
});

it('replaces a cache that lost canonical rows when selective repair is unavailable', async () => {
  const h = harness(); await h.run();
  const old = (await state()).device.clientId;
  await db.pg_record_rows.delete('message:50000000-0000-4000-8000-000000000004');
  await h.run();
  expect((await state()).device.clientId).not.toBe(old);
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

it('runs selective repair before snapshot replacement and retries the same durable cursor', async () => {
  const h = harness(); await h.run();
  const committed = await state();
  const repair = vi.fn(async () => ({ repaired: 1 }));
  h.remote.page.mockRejectedValueOnce(failure('reset_required'));
  await h.run({ repair });
  expect(repair).toHaveBeenCalledWith({ reason: 'reset_required', cursor: committed.cursor });
  expect(h.remote.page.mock.calls.at(-1)[1].cursor).toBe(committed.cursor);
  expect((await state()).device.clientId).toBe(committed.device.clientId);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'retire')).toHaveLength(0);
});

it('retains revoked downloads and keeps pending commands for recovery', async () => {
  const h = harness(); await h.run(); await db.pending_writes.add({ record_id: 'pending' });
  await db.chat_messages.put({ record_id: 'pending', body: 'draft', sync_status: 'pending' });
  const downloads = await db.chat_messages.toArray();
  const old = await state();
  h.remote.page.mockRejectedValueOnce(failure('workspace_membership_required', 403));
  await expect(h.run()).rejects.toThrow('workspace_membership_required');
  expect(await db.pg_record_rows.count()).toBe(17); expect(await db.chat_messages.count()).toBeGreaterThan(0); expect(await db.pending_writes.count()).toBe(1); expect((await state()).accessLost).toBe(true);
  expect(await db.chat_messages.toArray()).toEqual(downloads);
  expect((await state()).cursor).toBe(old.cursor);
  expect((await state()).device.clientId).toBe(old.device.clientId);
  // Repeated denial preserves cache identity and canonical downloads, but marks
  // future network authority lost. A new authorised page clears that status.
  h.remote.page.mockRejectedValueOnce(failure('record_access_required', 403));
  await expect(h.run()).rejects.toThrow('record_access_required');
  expect(await db.pg_record_rows.count()).toBe(17);
  expect((await state()).device.clientId).toBe(old.device.clientId);
  await h.run();
  expect((await state()).accessLost).toBe(false);
  expect(await db.pg_record_rows.count()).toBe(17);
  expect(await db.pending_writes.count()).toBe(1);
});

it.each(['actors', 'access'])('rejects byte overflow from %s sidecars before any local commit or ack', async sidecar => {
  const h = harness(), read = h.ports.readPage;
  h.ports.readPage = async (...args) => {
    const page = await read(...args);
    return sidecar === 'actors'
      ? { ...page, actors: [{ actor_id: 'huge', npub: 'viewer', kind: 'human', display_name: 'x'.repeat(1048576) }] }
      : { ...page, access: { details: 'x'.repeat(1048576) } };
  };
  await expect(h.run()).rejects.toThrow('byte bound');
  expect(await db.pg_record_rows.count()).toBe(0);
  expect((await state()).device.pendingAck).toBeNull();
  expect(h.remote.client.mock.calls.some(c => c[2].operation === 'ack')).toBe(false);
});

it.each(['record_too_large', 'body interrupted'])('keeps durable progress and reports %s without fallback or completion', async code => {
  const h = harness(); await h.run(); const committed = await state();
  const progress = vi.fn();
  h.remote.page.mockRejectedValueOnce(code === 'record_too_large' ? failure(code, 413) : new Error(code));
  await expect(h.run({ onProgress: progress })).rejects.toThrow(code);
  expect(await state()).toEqual(committed);
  expect(progress.mock.calls.some(([event]) => event.stage === 'complete')).toBe(false);
  expect(h.remote.client.mock.calls.filter(c => c[2].operation === 'register')).toHaveLength(1);
  await h.run(); expect(h.remote.page.mock.calls.at(-1)[1].cursor).toBe(committed.cursor);
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
  const h = harness();
  // Exclusive Web Locks grant a Lock, or null for a busy ifAvailable request.
  // Callback return values must never become the next request's lock argument.
  let held = false;
  const queue = [];
  const grants = [];
  const locks = { request: vi.fn((name, options, callback) => {
    if (held && options.ifAvailable) {
      grants.push(null);
      return Promise.resolve(callback(null));
    }
    return new Promise((resolve, reject) => {
      const acquire = async () => {
        held = true;
        const lock = { name, mode: options.mode };
        grants.push(lock);
        try { resolve(await callback(lock)); }
        catch (error) { reject(error); }
        finally { held = false; queue.shift()?.(); }
      };
      if (held) queue.push(acquire);
      else acquire();
    });
  }) };
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const waiting = vi.fn();
  const firstRun = vi.fn(async () => { await firstGate; return h.run(); });
  const secondRun = vi.fn(h.run);
  const first = withDeviceCacheLock('same', firstRun, locks, { storage: null });
  const second = withDeviceCacheLock('same', secondRun, locks, { storage: null, onWaiting: waiting });
  await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
  expect(firstRun).toHaveBeenCalledOnce();
  expect(secondRun).not.toHaveBeenCalled();
  expect(grants).toEqual([{ name: 'flightdeck-record-cache:same', mode: 'exclusive' }, null]);
  expect(locks.request.mock.calls[2][1]).toMatchObject({ mode: 'exclusive', signal: expect.any(AbortSignal) });
  releaseFirst();
  const [a, b] = await Promise.all([first, second]);
  expect(secondRun).toHaveBeenCalledOnce();
  expect(grants[2]).toEqual({ name: 'flightdeck-record-cache:same', mode: 'exclusive' });
  expect(held).toBe(false);
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
  await h.run(); expect(await db.chat_messages.get('obsolete')).toMatchObject({ pg_access_status: 'stale' });
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

it.each([false, true])('repairs an interrupted bounded delta prefix, including old poisoned certificates (%s)', async legacy => {
  const h = harness(), read = h.ports.readPage;
  let target = '10';
  h.ports.readPage = async (...args) => {
    const page = await read(...args);
    return { ...page, handover: { target_position: target, through_position: page.has_more ? '9' : target,
      complete: !page.has_more, authority_epoch: 'epoch', access_revision: '1' } };
  };
  await h.run({ extension: boundedFixture.extension });
  const before = await state();
  target = '11';
  const original = fixture.one_message_delta.changes[0];
  const changes = Array.from({ length: 40 }, () => {
    const id = crypto.randomUUID();
    return { ...original, id, row: { ...original.row, id } };
  });
  await expect(applyPgRecordChanges(store, { ...fixture.one_message_delta, protocol_version: 2,
    client_id: before.device.clientId, checkpoint_revision: before.device.revision,
    changes, has_more: true, next_cursor: 'uncommitted-page', handover: { target_position: target, through_position: target,
      complete: false, authority_epoch: 'epoch', access_revision: '1' } }, {
    expectedCursor: before.cursor, expectedGeneration: before.localGeneration,
    deviceScope: before.device.scope, authorityEpoch: 'epoch', boundedExtension: boundedFixture.extension,
    beforeCommit: () => { throw new Error('interrupted final chunk'); },
  })).rejects.toThrow('interrupted final chunk');
  const interrupted = await state();
  expect(interrupted.cursor).toBe(before.cursor);
  expect(interrupted.handover).toEqual(before.handover);
  expect(interrupted.applyingPage).toBeTruthy();
  expect(await db.chat_messages.get(changes[0].id)).toBeTruthy();
  if (legacy) await db.sync_state.put({ key, value: { ...interrupted,
    handover: { ...interrupted.handover, target_position: '11', complete: false } } });
  await db.chat_messages.put({ record_id: 'draft', body: 'keep local intent', sync_status: 'pending' });
  await db.pending_writes.add({ record_id: 'draft' });
  target = '12';
  if (legacy) {
    // Ordinary retry from the preceding cursor fails closed on the poisoned
    // target. Recovery must replace authority, never accept this drift.
    await expect(applyPgRecordChanges(store, { ...fixture.one_message_delta, protocol_version: 2,
      client_id: before.device.clientId, checkpoint_revision: before.device.revision,
      changes: [], has_more: false, next_cursor: 'unsafe-retry', handover: {
        target_position: target, through_position: target, complete: true,
        authority_epoch: 'epoch', access_revision: '1',
      } }, { expectedCursor: before.cursor, deviceScope: before.device.scope,
        authorityEpoch: 'epoch', boundedExtension: boundedFixture.extension,
      })).rejects.toThrow('Bounded snapshot target changed');
    expect((await state()).cursor).toBe(before.cursor);
  }
  await h.run({ extension: boundedFixture.extension });
  const repaired = await state();
  expect(repaired.device.clientId).not.toBe(before.device.clientId);
  expect(repaired.localGeneration).toBe(before.localGeneration + 1);
  expect(repaired.handover.target_position).toBe('12');
  expect(repaired.converged).toBe(true);
  expect(repaired.applyingPage).toBeNull();
  expect((await db.chat_messages.get('draft')).body).toBe('keep local intent');
  expect(await db.pending_writes.where('record_id').equals('draft').count()).toBe(1);
  expect(await db.chat_messages.get(changes[0].id)).toBeTruthy();
});
