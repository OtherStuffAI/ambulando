import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { deleteWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, markPgRecordAccessLost, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import {
  auxiliarySyncKey,
  hydratePriorityContext,
  materializeAuxiliaryChanges,
  runCacheAdoption,
  runManifestRepair,
  runPriorityLane,
} from '../src/pg-priority-sync.js';

const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = { workspaceDbKey: 'priority-test', workspaceOwnerNpub: 'npub1owner', backendUrl: 'http://localhost:3100',
  session: { npub: 'npub1viewer' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner', appNpub: 'app' } };
const context = { workspaceId, baseUrl: store.backendUrl, appNpub: 'app' };

function memoryPorts(initial = {}) {
  const state = new Map(Object.entries(initial));
  const pages = [];
  return {
    state, pages,
    readState: async key => state.get(key) || null,
    materialize: vi.fn(async bundle => {
      if (bundle.auxiliary_sync_action) {
        state.set(bundle.auxiliary_sync_action.key, bundle.auxiliary_sync_action.value);
        return bundle.auxiliary_sync_action.value;
      }
      pages.push(bundle);
      return { applied: bundle.changes?.length || 0 };
    }),
  };
}

describe('priority-first auxiliary sync lanes', () => {
  it('keeps the priority continuation independent from the durable v2 checkpoint and resumes newest-first paging', async () => {
    const durableKey = `${workspaceId}:record-delta-v1`;
    const ports = memoryPorts({ [durableKey]: { cursor: 'durable-gap-cursor' } });
    const changes = fixture.canonical_upserts.changes.slice(0, 2).map((change, index) => ({ ...change, version: String(20 - index) }));
    const readPriority = vi.fn()
      .mockResolvedValueOnce({ captured_head: '20', changes: [changes[0]], next_cursor: 'priority-page-2', has_more: true, coverage: 'partial', retention_policy: 'retain_downloaded' })
      .mockResolvedValueOnce({ captured_head: '20', changes: [changes[1]], next_cursor: 'priority-done', has_more: false, coverage: 'partial', retention_policy: 'retain_downloaded' });
    await runPriorityLane(store, { resume: false }, { ...ports, context, readPriority });
    expect(readPriority.mock.calls[0][1]).toMatchObject({ cursor: null, limit: 32 });
    expect(ports.state.get(auxiliarySyncKey(store, 'priority')).cursor).toBe('priority-page-2');
    expect(ports.state.get(durableKey).cursor).toBe('durable-gap-cursor');
    await runPriorityLane(store, { resume: true }, { ...ports, context, readPriority });
    expect(readPriority.mock.calls[1][1].cursor).toBe('priority-page-2');
    expect(ports.pages.flatMap(page => page.changes).map(change => change.version)).toEqual(['20', '19']);
    expect(ports.pages.every(page => page.local_apply_options.reconcileOnly && page.local_apply_options.batchSize === 32)).toBe(true);
    expect(ports.state.get(durableKey).cursor).toBe('durable-gap-cursor');
  });

  it('prioritises only the requested context closure and persists its freshness separately', async () => {
    const ports = memoryPorts();
    const closure = fixture.canonical_upserts.changes.filter(change => ['scope', 'channel', 'task'].includes(change.family));
    const readContext = vi.fn(async () => ({ captured_head: '44', changes: closure,
      dependencies: closure.slice(0, 2).map(({ family, id }) => ({ family, id })) }));
    await hydratePriorityContext(store, 'task', closure.at(-1).id, {}, { ...ports, context, readContext });
    expect(readContext).toHaveBeenCalledWith(workspaceId, 'task', closure.at(-1).id, expect.any(Object));
    expect(ports.pages).toHaveLength(1);
    expect(ports.pages[0].changes.map(change => change.family)).toEqual(['scope', 'channel', 'task']);
    expect(ports.pages[0].changes.some(change => change.family === 'message')).toBe(false);
    expect(ports.state.get(auxiliarySyncKey(store, `context:task:${closure.at(-1).id}`))).toMatchObject({ status: 'complete', capturedHead: '44' });
  });

  it('selectively repairs only missing or stale manifest bodies and never deletes by omission', async () => {
    const ports = memoryPorts();
    const entries = [
      { family: 'task', id: 'current', version: '5', state: 'active' },
      { family: 'doc', id: 'stale', version: '7', state: 'active' },
      { family: 'message', id: 'missing', version: '9', state: 'active' },
    ];
    const local = new Map([
      ['task:current', { version: '5', operation: 'upsert' }],
      ['doc:stale', { version: '6', operation: 'upsert' }],
      ['message:cached-but-omitted', { version: '12', operation: 'upsert' }],
    ]);
    const repair = vi.fn(async (_workspaceId, records) => ({ changes: records.map((record, index) => ({
      family: record.family, id: record.id, version: record.version, operation: 'upsert', workspace_id: workspaceId,
      row: { id: record.id, workspace_id: workspaceId, row_version: Number(record.version), title: `repair-${index}` },
    })) }));
    const result = await runManifestRepair(store, {}, { ...ports, context,
      readManifest: async () => ({ captured_head: '10', entries, next_cursor: 'done', has_more: false }),
      readCanonicalRows: async keys => keys.map(key => local.get(key)), repair });
    expect(repair.mock.calls[0][1].map(record => record.id)).toEqual(['stale', 'missing']);
    expect(repair.mock.calls[0][1].some(record => record.id === 'cached-but-omitted')).toBe(false);
    expect(result).toMatchObject({ status: 'complete', checked: 3, repaired: 2 });
  });

  it('persists a paused continuation and queue across network interruption without cache reset', async () => {
    const ports = memoryPorts();
    const first = vi.fn(async () => ({ captured_head: '8', changes: [], next_cursor: 'resume-me', has_more: true, coverage: 'partial', retention_policy: 'retain_downloaded' }));
    await runPriorityLane(store, {}, { ...ports, context, readPriority: first });
    const failure = Object.assign(new Error('offline'), { status: 503 });
    await expect(runPriorityLane(store, { resume: true }, { ...ports, context, readPriority: async () => { throw failure; } })).rejects.toThrow('offline');
    expect(ports.state.get(auxiliarySyncKey(store, 'priority'))).toMatchObject({ status: 'paused', cursor: 'resume-me' });
    expect(ports.state.get(auxiliarySyncKey(store, 'queue')).items).toEqual([
      { lane: 'priority', cursor: 'resume-me' }, { lane: 'completeness', durable: true },
    ]);
    expect(ports.materialize.mock.calls.some(([bundle]) => bundle.reset_authority)).toBe(false);
    const resumed = vi.fn(async (_id, options) => ({ captured_head: '8', changes: [], next_cursor: 'done', has_more: false, coverage: 'partial', retention_policy: 'retain_downloaded', requested: options.cursor }));
    await runPriorityLane(store, { resume: true }, { ...ports, context, readPriority: resumed });
    expect(resumed.mock.calls[0][1].cursor).toBe('resume-me');
  });

  it('refreshes the newest short band without dropping a continuation restored after reload', async () => {
    const priorityKey = auxiliarySyncKey(store, 'priority');
    const ports = memoryPorts({ [priorityKey]: { status: 'pending', cursor: 'older-head', capturedHead: '40' } });
    const fresh = vi.fn(async () => ({ captured_head: '50', changes: [], next_cursor: 'newer-page-2', has_more: true,
      coverage: 'partial', retention_policy: 'retain_downloaded' }));
    await runPriorityLane(store, { resume: false }, { ...ports, context, readPriority: fresh });
    expect(fresh.mock.calls[0][1].cursor).toBeNull();
    expect(ports.state.get(priorityKey)).toMatchObject({ status: 'pending', cursor: 'older-head', capturedHead: '50' });
  });

  it('adopts matching cache identities, repairs only mismatches, and returns the durable checkpoint for atomic commit', async () => {
    const ports = memoryPorts();
    const clientId = '10000000-0000-4000-8000-000000000001';
    const current = { family: 'task', id: 'current', version: '5', state: 'active', relationships: {} };
    const stale = { family: 'doc', id: 'stale', version: '7', state: 'active', relationships: {} };
    const local = new Map([
      ['task:current', { family: 'task', id: 'current', version: '5', operation: 'upsert' }],
      ['doc:stale', { family: 'doc', id: 'stale', version: '6', operation: 'upsert' }],
    ]);
    const checkpoint = { protocol_version: 2, client_id: clientId, authority_epoch: 'epoch',
      initial_cursor: 'adopted', checkpoint_cursor: 'adopted', checkpoint_revision: '8' };
    const base = { protocol_version: 2, adoption_id: 'adoption', captured_head: '70', authority_epoch: 'epoch',
      access_revision: '3', checkpoint_revision: '7', bounds: { max_rows: 200, max_bytes: 1048576 }, retention_policy: 'retain_downloaded' };
    const adopt = vi.fn(async (_workspaceId, _clientId, body) => {
      if (body.request_id) return { ...base, status: 'inventory_required', cursor: 'inventory', challenge: [current, stale], has_more: false };
      if (body.inventory) {
        expect(body.inventory).toEqual([
          { family: 'task', id: 'current', state: 'active', version: '5' },
          { family: 'doc', id: 'stale', state: 'active', version: '6' },
        ]);
        return { ...base, status: 'repair_required', cursor: 'repair', records: [stale], repair_route: '/repair' };
      }
      expect(body.repaired).toEqual([{ family: 'doc', id: 'stale', state: 'active', version: '7' }]);
      return { ...base, status: 'adopted', checkpoint };
    });
    const repair = vi.fn(async (_workspaceId, records) => ({ changes: records.map(record => ({
      ...record, operation: 'upsert', workspace_id: workspaceId,
      row: { id: record.id, workspace_id: workspaceId, row_version: Number(record.version), title: 'repaired' },
    })) }));
    const materialize = vi.fn(async bundle => {
      if (bundle.auxiliary_sync_action) {
        ports.state.set(bundle.auxiliary_sync_action.key, bundle.auxiliary_sync_action.value);
        return bundle.auxiliary_sync_action.value;
      }
      for (const change of bundle.changes || []) local.set(`${change.family}:${change.id}`, change);
      return { applied: bundle.changes?.length || 0 };
    });
    const deps = { context, readState: ports.readState, materialize, adopt, repair,
      readManifest: async () => ({ coverage: 'authorized_manifest', next_cursor: 'manifest' }),
      readCanonicalRows: async keys => keys.map(key => local.get(key)),
    };
    const result = await runCacheAdoption(store, { clientId, expectedCheckpointRevision: '7', requestId: '20000000-0000-4000-8000-000000000002' }, deps);
    expect(result).toMatchObject({ status: 'complete', checkpoint });
    expect(repair).toHaveBeenCalledWith(workspaceId, [{ family: 'doc', id: 'stale', version: '7' }], expect.any(Object));
    expect(adopt).toHaveBeenCalledTimes(3);
    expect(result.stateKey).toBe(auxiliarySyncKey(store, 'adoption'));
    expect(ports.state.get(auxiliarySyncKey(store, 'adoption'))).toMatchObject({ status: 'pending', response: { status: 'adopted' } });

    await runCacheAdoption(store, { clientId, expectedCheckpointRevision: '7' }, deps);
    expect(adopt).toHaveBeenCalledTimes(3);
  });

  it('adopts an exact cache without transferring bodies and resumes a lost start with the same idempotency key', async () => {
    const ports = memoryPorts();
    const clientId = '10000000-0000-4000-8000-000000000011';
    const entry = { family: 'task', id: 'current', version: '5', state: 'active', relationships: {} };
    const checkpoint = { protocol_version: 2, client_id: clientId, authority_epoch: 'epoch',
      initial_cursor: 'adopted', checkpoint_cursor: 'adopted', checkpoint_revision: '2' };
    const base = { protocol_version: 2, adoption_id: 'adoption', captured_head: '70', authority_epoch: 'epoch',
      access_revision: '3', checkpoint_revision: '1', bounds: { max_rows: 200, max_bytes: 1048576 }, retention_policy: 'retain_downloaded' };
    let loseStart = true;
    const starts = [];
    const adopt = vi.fn(async (_workspaceId, _clientId, body) => {
      if (body.request_id) {
        starts.push(body);
        if (loseStart) { loseStart = false; throw new Error('response lost'); }
        return { ...base, status: 'inventory_required', cursor: 'inventory', challenge: [entry], has_more: false };
      }
      expect(body.inventory).toEqual([{ family: 'task', id: 'current', state: 'active', version: '5' }]);
      return { ...base, status: 'adopted', checkpoint };
    });
    const repair = vi.fn();
    const deps = { ...ports, context, adopt, repair,
      readManifest: vi.fn(async () => ({ coverage: 'authorized_manifest', next_cursor: 'manifest' })),
      readCanonicalRows: async () => [{ family: 'task', id: 'current', version: '5', operation: 'upsert' }],
    };
    await expect(runCacheAdoption(store, { clientId, expectedCheckpointRevision: '1' }, deps)).rejects.toThrow('response lost');
    const saved = ports.state.get(auxiliarySyncKey(store, 'adoption'));
    expect(saved).toMatchObject({ requestId: expect.any(String), manifestCursor: 'manifest', response: null, status: 'paused' });
    const result = await runCacheAdoption(store, { clientId, expectedCheckpointRevision: '1' }, deps);
    expect(result.checkpoint).toEqual(checkpoint);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toEqual(starts[0]);
    expect(repair).not.toHaveBeenCalled();
    expect(deps.readManifest).toHaveBeenCalledTimes(1);
  });
});

describe('auxiliary materialisation retention', () => {
  let db;
  beforeEach(async () => {
    db = openWorkspaceDb('priority-materialisation'); await db.open();
    await Promise.all(db.tables.map(table => table.clear()));
    await applyPgRecordChanges(store, { ...fixture.canonical_upserts, next_cursor: 'durable' });
  });
  afterEach(async () => deleteWorkspaceDb('priority-materialisation'));

  it('retains omitted cached rows, applies explicit tombstones, and treats access loss separately', async () => {
    const durableBefore = (await db.sync_state.get(recordDeltaCursorKey(store))).value;
    const message = fixture.canonical_upserts.changes.find(change => change.family === 'message');
    const unrelated = fixture.canonical_upserts.changes.find(change => change.family === 'task');
    await materializeAuxiliaryChanges(store, [{ ...message, version: String(BigInt(message.version) + 1n), row: { ...message.row, body: 'priority update' } }], { context });
    expect(await db.tasks.get(unrelated.id)).toBeTruthy();
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toEqual(durableBefore);
    await materializeAuxiliaryChanges(store, [{ ...message, version: String(BigInt(message.version) + 2n), operation: 'delete', row: null }], { context });
    expect(await db.chat_messages.get(message.id)).toBeUndefined();
    await markPgRecordAccessLost(store, { expectedCursor: 'durable', expectedGeneration: Number(durableBefore.localGeneration || 0) });
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.accessLost).toBe(true);
    expect(await db.tasks.get(unrelated.id)).toBeTruthy();
  });
});

describe('cache adoption repair materialisation', () => {
  let db;
  const adoptionStore = { ...store, workspaceDbKey: 'priority-adoption-repair' };

  beforeEach(async () => {
    db = openWorkspaceDb('priority-adoption-repair'); await db.open();
    await Promise.all(db.tables.map(table => table.clear()));
  });
  afterEach(async () => deleteWorkspaceDb('priority-adoption-repair'));

  it('commits mixed upsert and equal-version tombstone repairs before acknowledging adoption', async () => {
    const clientId = '10000000-0000-4000-8000-000000000021';
    const current = { family: 'task', id: 'current', version: '5', state: 'active', relationships: {} };
    const stale = { family: 'audio_note', id: 'stale', version: '7', state: 'active', relationships: {} };
    const tombstone = { family: 'doc', id: 'deleted', version: '9', state: 'deleted', relationships: {} };
    await db.pg_record_rows.bulkPut([
      { key: 'task:current', family: 'task', id: 'current', version: '5', operation: 'upsert', generation: 'delta', row: {} },
      { key: 'audio_note:stale', family: 'audio_note', id: 'stale', version: '6', operation: 'upsert', generation: 'delta', row: {} },
      // A prior cache can retain the old operation at the canonical version.
      // Selective repair must replace it with Tower's explicit tombstone.
      { key: 'doc:deleted', family: 'doc', id: 'deleted', version: '9', operation: 'upsert', generation: 'delta', row: {} },
    ]);
    const snapshotState = { cursor: 'snapshot-page', snapshotId: 'existing-snapshot',
      snapshotReconciliationPending: true, snapshotComplete: false };
    await db.sync_state.put({ key: recordDeltaCursorKey(adoptionStore), value: snapshotState });
    await db.pending_writes.add({ record_id: 'pending-local-edit', envelope: { title: 'keep me' } });
    await db.document_drafts.put({ draft_key: 'workspace:doc', workspace_id: workspaceId,
      document_id: 'doc', body: 'unfinished draft' });
    const checkpoint = { protocol_version: 2, client_id: clientId, authority_epoch: 'epoch',
      initial_cursor: 'adopted', checkpoint_cursor: 'adopted', checkpoint_revision: '1' };
    const base = { protocol_version: 2, adoption_id: 'adoption', captured_head: '70', authority_epoch: 'epoch',
      access_revision: '3', checkpoint_revision: '0', bounds: { max_rows: 200, max_bytes: 1048576 }, retention_policy: 'retain_downloaded' };
    let repairReceipts = 0;
    const adopt = vi.fn(async (_workspaceId, _clientId, body) => {
      if (body.request_id) return { ...base, status: 'inventory_required', cursor: 'inventory',
        challenge: [current, stale, tombstone], has_more: false };
      if (body.inventory) return { ...base, status: 'repair_required', cursor: 'repair',
        records: [stale, tombstone], repair_route: '/repair' };
      expect(body.repaired).toEqual([
        { family: 'audio_note', id: 'stale', state: 'active', version: '7' },
        { family: 'doc', id: 'deleted', state: 'deleted', version: '9' },
      ]);
      if (repairReceipts++ === 0) throw Object.assign(new Error('Tower PG record cache adoption 409: adoption_repair_incomplete'), {
        status: 409, code: 'adoption_repair_incomplete',
      });
      return { ...base, status: 'adopted', checkpoint };
    });
    const repair = vi.fn(async () => ({ changes: [
      { family: 'audio_note', id: 'stale', version: '7', operation: 'upsert', workspace_id: workspaceId,
        row: { id: 'stale', workspace_id: workspaceId, row_version: 2 } },
      { family: 'doc', id: 'deleted', version: '9', operation: 'delete', workspace_id: workspaceId, row: null },
    ] }));

    const options = {
      clientId, expectedCheckpointRevision: '0', requestId: '20000000-0000-4000-8000-000000000021',
    };
    const deps = { context, adopt, repair,
      readManifest: async () => ({ coverage: 'authorized_manifest', next_cursor: 'manifest' }) };
    await expect(runCacheAdoption(adoptionStore, options, deps)).rejects.toMatchObject({
      status: 409, code: 'adoption_repair_incomplete',
    });

    expect((await db.sync_state.get(recordDeltaCursorKey(adoptionStore))).value).toEqual(snapshotState);
    expect(await db.pending_writes.where('record_id').equals('pending-local-edit').count()).toBe(1);
    expect(await db.document_drafts.get('workspace:doc')).toMatchObject({ body: 'unfinished draft' });
    expect((await db.sync_state.get(auxiliarySyncKey(adoptionStore, 'adoption'))).value).toMatchObject({
      status: 'paused', response: { status: 'repair_required', cursor: 'repair' },
      pauseReason: 'adoption_repair_incomplete',
    });

    const result = await runCacheAdoption(adoptionStore, options, deps);

    expect(result.checkpoint).toEqual(checkpoint);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(await db.pg_record_rows.get('audio_note:stale')).toMatchObject({ operation: 'upsert', version: '7' });
    expect(await db.pg_record_rows.get('doc:deleted')).toMatchObject({ operation: 'delete', version: '9' });
  });
});
