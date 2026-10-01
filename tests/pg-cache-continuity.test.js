import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb, deleteWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, recordDeltaCursorKey, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import { hydrateTowerPgScopes, hydrateTowerPgChannels, hydrateTowerPgChannelMessages, hydrateTowerPgSyncBundle, syncTowerPgWorkspace } from '../src/pg-read-hydrator.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = { session: { npub: 'npub1viewer' }, backendUrl: 'http://localhost:3100',
  currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner', appNpub: 'flightdeck_pg', pgBackendMode: true } };
const delta = (changes = [], cursor = 'handover') => ({ ...fixture.one_message_delta, changes, next_cursor: cursor, has_more: false });
const snapshot = (changes = fixture.canonical_upserts.changes, cursor = 'snapshot-end') => ({ ...fixture.canonical_upserts, changes, next_cursor: cursor, has_more: true });
const reset = () => Object.assign(new Error('reset_required'), { status: 409 });
const failure = status => Object.assign(new Error('retryable'), { status });
const ports = read => ({ getTowerPgRecordSync: read, getTowerPgResourceViewStates: async () => ({ states: [] }) });
let db;
async function counts() { return Promise.all([db.scopes.count(), db.channels.count(), db.chat_messages.count()]); }
async function seed() { await applyPgRecordChanges(store, delta(fixture.canonical_upserts.changes, 'cached')); }
beforeEach(async () => {
  db = openWorkspaceDb('cache-continuity'); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  await seed();
});
afterEach(async () => { await deleteWorkspaceDb('cache-continuity'); });

async function observe(run) {
  const emissions = [];
  const subscription = liveQuery(counts).subscribe(rows => emissions.push(rows));
  try {
    await vi.waitFor(() => expect(emissions.length).toBeGreaterThan(0));
    await run();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(emissions, JSON.stringify(emissions)).toSatisfy(values => values.every(rows => rows.every(n => n > 0)));
  } finally { subscription.unsubscribe(); }
}

describe('authorized cache continuity', () => {
  it('keeps cached and pending navigation rows when typed lists omit them', async () => {
    const before = await counts();
    await db.scopes.put({ record_id: 'local-scope', owner_npub: 'npub1owner', title: 'Local', sync_status: 'pending' });
    await db.channels.put({ record_id: 'local-channel', owner_npub: 'npub1owner', scope_id: 'local-scope', title: 'Local', sync_status: 'pending' });
    await db.pending_writes.add({ record_id: 'local-scope', envelope: {} });
    await db.pending_writes.add({ record_id: 'local-channel', envelope: {} });
    const response = { scopes: [], identity: { workspace_id: workspaceId }, next_cursor: null };
    await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => response });
    await hydrateTowerPgChannels(store, { getTowerPgWorkspaceScopes: async () => response,
      getTowerPgScopeChannels: async () => { throw new Error('no scope reads expected'); } });
    expect(await counts()).toEqual(before.map((count, index) => count + (index < 2 ? 1 : 0)));
    expect(await db.pending_writes.count()).toBe(2);
    expect((await db.scopes.get('local-scope')).sync_status).toBe('pending');
    expect((await db.channels.get('local-channel')).sync_status).toBe('pending');
    await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => ({
      scopes: [{ id: 'local-scope', name: 'Stale server title' }], identity: { workspace_id: workspaceId },
    }) });
    await hydrateTowerPgChannels(store, { getTowerPgWorkspaceScopes: async () => ({
      scopes: [{ id: 'local-scope', name: 'Stale server title' }], identity: { workspace_id: workspaceId },
    }), getTowerPgScopeChannels: async () => ({ channels: [
      { id: 'local-channel', scope_id: 'local-scope', name: 'Stale server title' },
    ] }) });
    expect((await db.scopes.get('local-scope')).title).toBe('Local');
    expect((await db.channels.get('local-channel')).title).toBe('Local');
  });

  it.each(['startup', 'SSE reconnect', 'poll recovery', 'refresh'])('keeps all three live projections populated during %s snapshot replacement', async transition => {
    if (transition === 'startup') await db.sync_state.delete(recordDeltaCursorKey(store));
    const read = vi.fn();
    if (transition !== 'startup') read.mockRejectedValueOnce(reset());
    read.mockResolvedValueOnce({ ...snapshot(fixture.canonical_upserts.changes.slice(0, 5), 'first'), snapshot_complete: false })
      .mockImplementationOnce(async () => {
        expect((await counts()).every(n => n > 0)).toBe(true);
        expect((await db.scopes.toArray())[0].title).toBe('example');
        return snapshot(fixture.canonical_upserts.changes.slice(5), 'last');
      }).mockResolvedValueOnce(delta());
    const sync = () => syncTowerPgWorkspace(store, {}, ports(read));
    const service = new TowerSyncService({ workspaceKey: 'cache-continuity', ports: { hydrateInitial: sync, recoverCursor: sync, runFallbackPoll: sync } });
    await observe(async () => {
      if (transition === 'startup') await service.hydrateInitial();
      else if (transition === 'SSE reconnect') { service.start(); await service.recoverCursor({ reason: 'reconnect' }); }
      else if (transition === 'poll recovery') {
        const done = new Promise((resolve, reject) => { service.ports.runFallbackPoll = () => sync().then(resolve, reject); });
        service.scheduleFallback(1); await done;
      } else await sync();
    });
    service.dispose();
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ converged: true, resetting: false });
  });

  it('does not retire typed-hydrated canonical views after an ordinary multi-page delta', async () => {
    await resetPgRecordAuthority(store, { preserveViews: true });
    await applyPgRecordChanges(store, snapshot(), { stageSnapshot: true });
    await applyPgRecordChanges(store, delta());
    const before = await counts();
    const scope = fixture.canonical_upserts.changes.find(c => c.family === 'scope').row;
    const channel = fixture.canonical_upserts.changes.find(c => c.family === 'channel').row;
    await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => ({ scopes: [scope] }) });
    await hydrateTowerPgChannels(store, { getTowerPgWorkspaceScopes: async () => ({ scopes: [scope] }),
      getTowerPgScopeChannels: async () => ({ channels: [channel] }) });
    // Targeted message reads replace presentation rows without journal generation metadata.
    const { replacePgMessagesForChannel } = await import('../src/db.js');
    const messages = await db.chat_messages.toArray();
    await replacePgMessagesForChannel(channel.id, messages.map(({ pg_delta_generation, pg_delta_family, ...row }) => row));
    const read = vi.fn().mockResolvedValueOnce({ ...delta([], 'catchup'), has_more: true })
      .mockImplementationOnce(async () => {
        expect(await counts()).toEqual(before);
        return delta([], 'caught-up');
      });
    await observe(() => syncTowerPgWorkspace(store, {}, ports(read)));
    expect(await counts()).toEqual(before);
    expect(await db.pg_record_rows.count()).toBe(17);
  });

  it.each([false, true])('recovers pre-fix authority once, including erased views=%s, without clearing surviving cache', async erased => {
    await resetPgRecordAuthority(store, { preserveViews: true });
    await applyPgRecordChanges(store, snapshot(), { stageSnapshot: true });
    await applyPgRecordChanges(store, delta());
    const key = recordDeltaCursorKey(store);
    const authority = (await db.sync_state.get(key)).value;
    delete authority.snapshotReconciliationPending;
    authority.converged = false; // interrupted ordinary catch-up in build 2116
    await db.sync_state.put({ key, value: authority });
    if (erased) await Promise.all([db.scopes.clear(), db.channels.clear(), db.chat_messages.clear()]);
    const before = await counts();
    const interrupted = vi.fn().mockImplementationOnce(async (_id, options) => {
      expect(options.cursor).toBeNull();
      expect(await counts()).toEqual(before);
      return { ...snapshot([], 'repair-partial'), snapshot_complete: false };
    }).mockRejectedValueOnce(failure(503));
    await expect(syncTowerPgWorkspace(store, {}, ports(interrupted))).rejects.toMatchObject({ status: 503 });
    expect(await counts()).toEqual(before);
    db.close(); db = openWorkspaceDb('cache-continuity'); await db.open();
    const resume = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(delta());
    await syncTowerPgWorkspace(store, {}, ports(resume));
    expect(resume.mock.calls[0][1].cursor).toBe('repair-partial');
    expect((await counts()).every(n => n > 0)).toBe(true);
    const ordinary = vi.fn().mockResolvedValueOnce(delta([], 'next-delta'));
    await syncTowerPgWorkspace(store, {}, ports(ordinary));
    expect(ordinary.mock.calls[0][1].cursor).toBe('handover');
    expect((await db.sync_state.get(key)).value.snapshotReconciliationPending).toBe(false);
  });

  it('does not downgrade upgrade recovery to legacy replacement when v1 disappears', async () => {
    const key = recordDeltaCursorKey(store);
    await db.sync_state.put({ key, value: { cursor: 'pre-fix', snapshotComplete: true, converged: true } });
    const before = await counts();
    await expect(syncTowerPgWorkspace(store, {}, ports(async () => { throw failure(404); }))).rejects.toMatchObject({ status: 404 });
    expect(await counts()).toEqual(before);
    expect((await db.sync_state.get(key)).value.resetting).toBe(true);
  });

  it('publishes a snapshot when the empty handover reuses the terminal snapshot cursor', async () => {
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(delta([], 'snapshot-end'));
    await observe(() => syncTowerPgWorkspace(store, {}, ports(read)));
    expect(await db.pg_record_rows.count()).toBe(17);
  });

  it('rolls back terminal changes and retains applied pages if the handover commit fails', async () => {
    await resetPgRecordAuthority(store, { preserveViews: true });
    await applyPgRecordChanges(store, snapshot(), { stageSnapshot: true });
    const before = await counts();
    await expect(applyPgRecordChanges(store, delta(), { beforeCommit: () => { throw new Error('commit failed'); } })).rejects.toThrow('commit failed');
    expect(await counts()).toEqual(before);
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ snapshotReconciliationPending: true, incrementalSnapshot: true, cursor: 'snapshot-end' });
    await observe(() => applyPgRecordChanges(store, delta()));
  });

  it('retains cache on 409 then snapshot failure and resumes staged download after reload', async () => {
    const before = await counts();
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce({ ...snapshot([], 'partial'), snapshot_complete: false })
      .mockRejectedValueOnce(failure(503));
    await observe(async () => { await expect(syncTowerPgWorkspace(store, {}, ports(read))).rejects.toMatchObject({ status: 503 }); });
    expect(await counts()).toEqual(before);
    db.close(); db = openWorkspaceDb('cache-continuity'); await db.open();
    const resume = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(delta());
    await observe(() => syncTowerPgWorkspace(store, {}, ports(resume)));
    expect(resume.mock.calls[0][1].cursor).toBe('partial');
    expect(await db.sync_state.where('key').startsWith(`${recordDeltaCursorKey(store)}:staged:`).count()).toBe(0);
  });

  it.each([401, 403, 503])('preserves authorized rows on transient status %s', async status => {
    const before = await counts();
    await expect(syncTowerPgWorkspace(store, {}, ports(async () => { throw failure(status); }))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('purges definitive membership revocation, preserving commands outside visible tables', async () => {
    await db.chat_messages.put({ record_id: 'draft', sync_status: 'pending', pg_backend: true });
    await db.pending_writes.add({ record_id: 'draft', envelope: {} });
    const error = Object.assign(failure(403), { responseText: JSON.stringify({ code: 'workspace_membership_required', error: 'Actor is not a member', identity: { workspace_id: workspaceId } }) });
    await expect(syncTowerPgWorkspace(store, {}, ports(async () => { throw error; }))).rejects.toThrow();
    expect(await counts()).toEqual([0, 0, 0]);
    expect(await db.pending_writes.count()).toBe(1);
    expect(await db.pg_record_conflicts.get('reset:chat_messages:draft')).toBeTruthy();
  });

  it('rejects a revocation response for another workspace without clearing this partition', async () => {
    const before = await counts();
    const error = Object.assign(failure(403), { responseText: JSON.stringify({ code: 'workspace_membership_required', identity: { workspace_id: 'other' } }) });
    await expect(syncTowerPgWorkspace(store, {}, ports(async () => { throw error; }))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('retires revoked collections only at the complete authorized empty handover', async () => {
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(snapshot([], 'empty'))
      .mockImplementationOnce(async () => { expect((await counts()).every(n => n > 0)).toBe(true); return delta(); });
    await syncTowerPgWorkspace(store, {}, ports(read));
    expect(await counts()).toEqual([0, 0, 0]);
    expect(await db.pg_resource_attention.count()).toBe(0);
    expect(await db.pg_attention_counts.count()).toBe(0);
  });

  it('hides an omitted authorized pending edit while preserving recovery and its outbox', async () => {
    const id = fixture.one_message_delta.changes[0].id;
    await db.chat_messages.update(id, { sync_status: 'pending', body: 'draft' });
    await db.pending_writes.add({ record_id: id, envelope: {} });
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(snapshot([])).mockResolvedValueOnce(delta());
    await syncTowerPgWorkspace(store, {}, ports(read));
    expect(await db.chat_messages.get(id)).toBeUndefined();
    expect(await db.pending_writes.count()).toBe(1);
    expect((await db.pg_record_conflicts.get(`reset:chat_messages:${id}`)).local.body).toBe('draft');
  });

  it('applies explicit message deletion immediately without a replacement cycle', async () => {
    const id = fixture.explicit_delete.changes[0].id;
    await syncTowerPgWorkspace(store, {}, ports(async () => delta(fixture.explicit_delete.changes)));
    expect(await db.chat_messages.get(id)).toBeUndefined();
    expect(await db.scopes.count()).toBe(1); expect(await db.channels.count()).toBe(1);
  });

  it.each([{ changes: null }, { snapshot_id: null }, { partitions_complete: [] }, { has_more: false },
    { changes: [{ ...fixture.one_message_delta.changes[0], workspace_id: 'other' }] }])('never publishes malformed replacement %j', async patch => {
    const before = await counts();
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce({ ...snapshot(), ...patch });
    await expect(syncTowerPgWorkspace(store, {}, ports(read))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it.each(['actor', 'workspace', 'authority'])('rejects stale response after %s changes', async changed => {
    const target = { ...store, session: { ...store.session }, currentWorkspace: { ...store.currentWorkspace } };
    const before = await counts();
    const read = async () => {
      if (changed === 'actor') target.session.npub = 'npub1other';
      else if (changed === 'workspace') target.currentWorkspace.workspaceId = 'other';
      else await resetPgRecordAuthority(target, { preserveViews: true });
      return snapshot();
    };
    await expect(syncTowerPgWorkspace(target, {}, ports(read))).rejects.toThrow(/changed/);
    expect(await counts()).toEqual(before);
  });

  it.each([{}, { scopes: null }, { scopes: [{}] }, { scopes: [], has_more: true }, { scopes: [] },
    { scopes: [{ id: 'wrong', workspace_id: 'other' }] }])('retains scopes and channels on incomplete scope response %j', async response => {
    const before = await counts();
    await expect(hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => response })).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('rejects late scope and message reads after newer authority arrives', async () => {
    const before = await counts();
    await expect(hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => {
      await applyPgRecordChanges(store, delta([], 'newer'));
      return { scopes: [{ id: 'stale' }] };
    } })).rejects.toThrow(/authority changed/);
    await expect(hydrateTowerPgChannelMessages(store, fixture.one_message_delta.changes[0].channel_id, {
      getTowerPgChannelThreads: async () => ({ threads: [] }),
      getTowerPgChannelMessages: async () => { await applyPgRecordChanges(store, delta([], 'newest')); return { messages: [] }; },
    })).rejects.toThrow(/authority changed/);
    expect(await counts()).toEqual(before);
  });

  it('rejects list omission after a newer service command acknowledges', async () => {
    const target = { ...store, _towerSyncService: { instrumentation: { commandsStarted: 0, commandsAcknowledged: 0, commandsFailed: 0 } } };
    const before = await counts();
    await expect(hydrateTowerPgScopes(target, { getTowerPgWorkspaceScopes: async () => {
      target._towerSyncService.instrumentation.commandsAcknowledged++;
      return { scopes: [], identity: { workspace_id: workspaceId } };
    } })).rejects.toThrow(/authority changed/);
    expect(await counts()).toEqual(before);
  });

  it.each([{}, { scopes: [], channels: [], channel_bundles: [] }])('rejects incomplete or unverified legacy replacements %j', async fields => {
    const before = await counts();
    await expect(hydrateTowerPgSyncBundle(store, { mode: 'snapshot', ...fields })).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('rejects malformed channels and messages without dropping cached collections', async () => {
    const before = await counts();
    await expect(hydrateTowerPgChannels(store, {
      getTowerPgWorkspaceScopes: async () => ({ scopes: [{ id: 'scope' }] }),
      getTowerPgScopeChannels: async () => ({ channels: [{}] }),
    })).rejects.toThrow();
    await expect(hydrateTowerPgChannelMessages(store, 'channel', {
      getTowerPgChannelThreads: async () => ({ threads: [] }),
      getTowerPgChannelMessages: async () => ({}),
    })).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });
});

it('allows a targeted authorized scope read during private staging without discarding cache', async () => {
  const before = await counts();
  await db.sync_state.put({ key: recordDeltaCursorKey(store), value: { cursor: 'partial', staging: true } });
  const read = vi.fn(async () => ({ scopes: [], identity: { workspace_id: workspaceId } }));
  await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: read });
  expect(read).toHaveBeenCalled();
  expect(await counts()).toEqual(before);
});

it('rejects an old scope commit when staging begins without changing the cursor', async () => {
  const before = await counts();
  await expect(hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => {
    const state = await db.sync_state.get(recordDeltaCursorKey(store));
    await db.sync_state.put({ ...state, value: { ...state.value, staging: true } });
    return { scopes: [], identity: { workspace_id: workspaceId } };
  } })).rejects.toMatchObject({ code: 'pg_read_authority_changed' });
  expect(await counts()).toEqual(before);
});

it('makes a fresh snapshot progressively visible and rolls back only a failed page, then replays safely', async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  const message = fixture.one_message_delta.changes[0];
  const first = { ...snapshot([message], 'first'), snapshot_complete: false };
  await applyPgRecordChanges(store, first, { expectedCursor: null, expectedGeneration: 0 });
  expect(await db.chat_messages.get(message.id)).toBeTruthy();
  const next = snapshot(fixture.canonical_upserts.changes, 'last');
  await expect(applyPgRecordChanges(store, next, { expectedCursor: 'first', beforeCommit: () => { throw Error('interrupted'); } })).rejects.toThrow('interrupted');
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('first');
  expect(await db.scopes.count()).toBe(0);
  expect(await db.chat_messages.get(message.id)).toBeTruthy();
  await applyPgRecordChanges(store, next, { expectedCursor: 'first' });
  expect((await applyPgRecordChanges(store, next, { expectedCursor: 'first' })).replay).toBe(true);
  await applyPgRecordChanges(store, delta(), { expectedCursor: 'last' });
  expect((await counts()).every(n => n > 0)).toBe(true);
});

it('resumes interrupted bounded omission retirement without advancing the terminal cursor early', async () => {
  for (let n = 0; n < 240; n++) await db.scopes.put({ record_id: `obsolete-${n}`, pg_backend: true, pg_delta_family: 'scope', sync_status: 'synced' });
  await resetPgRecordAuthority(store, { preserveViews: true });
  await applyPgRecordChanges(store, snapshot([]));
  let batches = 0;
  await expect(applyPgRecordChanges(store, delta(), { onRetirementProgress: () => { if (++batches === 2) throw Error('interrupted retirement'); } })).rejects.toThrow('interrupted retirement');
  const state = (await db.sync_state.get(recordDeltaCursorKey(store))).value;
  expect(state.cursor).toBe('snapshot-end');
  expect(state.snapshotReconciliationPending).toBe(true);
  expect(state.snapshotRetirement.after).toBeTruthy();
  expect(await db.scopes.count()).toBeLessThan(241);
  await applyPgRecordChanges(store, delta(), { expectedCursor: 'snapshot-end' });
  expect(await counts()).toEqual([0, 0, 0]);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: 'handover', snapshotReconciliationPending: false, snapshotRetirement: null });
});

it('discards old private staging once while retaining views and restoring equal-version records', async () => {
  const key = recordDeltaCursorKey(store), before = await counts();
  await db.sync_state.put({ key, value: { cursor: 'old-staged', staging: true, stagedPages: 1, localGeneration: 3 } });
  await db.sync_state.put({ key: `${key}:staged:0`, value: { page: snapshot(), order: 0 } });
  const read = vi.fn().mockImplementationOnce(async (_id, options) => {
    expect(options.cursor).toBeNull(); expect(await counts()).toEqual(before);
    return snapshot();
  }).mockResolvedValueOnce(delta());
  await syncTowerPgWorkspace(store, {}, ports(read));
  expect(await counts()).toEqual(before);
  expect(await db.sync_state.where('key').startsWith(`${key}:staged:`).count()).toBe(0);
  expect((await db.sync_state.get(key)).value.localGeneration).toBe(4);
});

it('allows targeted navigation across snapshot page commits but rejects tombstones and changed generation', async () => {
  await resetPgRecordAuthority(store, { preserveViews: true });
  const scope = fixture.canonical_upserts.changes.find(c => c.family === 'scope');
  await applyPgRecordChanges(store, { ...snapshot([scope], 'one'), snapshot_complete: false });
  await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => {
    await applyPgRecordChanges(store, { ...snapshot([], 'two'), snapshot_complete: false });
    return { scopes: [scope.row] };
  } });
  expect(await db.scopes.get(scope.id)).toBeTruthy();
  await hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => {
    await applyPgRecordChanges(store, { ...snapshot([{ ...scope, operation: 'delete', row: null, version: '999' }], 'three'), snapshot_complete: false });
    return { scopes: [scope.row] };
  } });
  expect(await db.scopes.get(scope.id)).toBeUndefined();
  await expect(hydrateTowerPgScopes(store, { getTowerPgWorkspaceScopes: async () => {
    await resetPgRecordAuthority(store, { preserveViews: true });
    return { scopes: [scope.row] };
  } })).rejects.toMatchObject({ code: 'pg_read_authority_changed' });
});

it('finishes a persisted retirement before requesting a newer live delta', async () => {
  await resetPgRecordAuthority(store, { preserveViews: true });
  await applyPgRecordChanges(store, snapshot([]));
  await expect(applyPgRecordChanges(store, delta(), { onRetirementProgress: () => { throw Error('reload'); } })).rejects.toThrow('reload');
  const read = vi.fn(async (_id, options) => {
    expect(options.cursor).toBe('handover');
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.snapshotReconciliationPending).toBe(false);
    return delta([], 'new-live-delta');
  });
  await syncTowerPgWorkspace(store, {}, ports(read));
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('new-live-delta');
});

it('replays a partially committed subpage after interruption and never skips the unfinished suffix', async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  const base = fixture.one_message_delta.changes[0];
  const changes = Array.from({ length: 70 }, (_, n) => ({ ...base, id: `bounded-${n}`, row: { ...base.row, id: `bounded-${n}` } }));
  const input = snapshot(changes, 'bounded-end');
  await expect(applyPgRecordChanges(store, input, { expectedCursor: null, beforeCommit: () => { throw Error('last chunk failed'); } })).rejects.toThrow('last chunk failed');
  expect(await db.pg_record_rows.count()).toBe(64);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: null, applyingPage: { nextCursor: 'bounded-end', through: 64 } });
  await applyPgRecordChanges(store, input, { expectedCursor: null });
  expect(await db.pg_record_rows.count()).toBe(70);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: 'bounded-end', applyingPage: null });
});

it('rejects a malformed completion boundary before publishing any subpage', async () => {
  const base = fixture.one_message_delta.changes[0], before = await db.pg_record_rows.count();
  const changes = Array.from({ length: 70 }, (_, n) => ({ ...base, id: `malformed-${n}`, row: { ...base.row, id: `malformed-${n}` } }));
  await expect(applyPgRecordChanges(store, { ...snapshot(changes), partitions_complete: [] })).rejects.toThrow('completion boundary');
  expect(await db.pg_record_rows.count()).toBe(before);
});

it('replays an interrupted delta when the live terminal cursor moves forward', async () => {
  await Promise.all(db.tables.map(t => t.clear()));
  const base = fixture.one_message_delta.changes[0];
  const changes = Array.from({ length: 70 }, (_, n) => ({ ...base, id: `delta-${n}`, row: { ...base.row, id: `delta-${n}` } }));
  await expect(applyPgRecordChanges(store, delta(changes, 'old-edge'), { expectedCursor: null, beforeCommit: () => { throw Error('interrupted'); } })).rejects.toThrow('interrupted');
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBeNull();
  await applyPgRecordChanges(store, delta(changes, 'new-edge'), { expectedCursor: null });
  expect(await db.pg_record_rows.count()).toBe(70);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('new-edge');
});

it('recovers an omitted pending typed view even when its journal tags were replaced', async () => {
  const change = fixture.one_message_delta.changes[0];
  const row = await db.chat_messages.get(change.id);
  const { pg_delta_family, pg_delta_generation, ...typed } = row;
  await db.chat_messages.put({ ...typed, body: 'typed local draft', sync_status: 'pending' });
  await db.pending_writes.add({ record_id: change.id, envelope: { body: 'typed local draft' } });
  await resetPgRecordAuthority(store, { preserveViews: true });
  await applyPgRecordChanges(store, snapshot([]));
  await applyPgRecordChanges(store, delta());
  expect(await db.chat_messages.get(change.id)).toBeUndefined();
  expect((await db.pg_record_conflicts.get(`reset:chat_messages:${change.id}`)).local.body).toBe('typed local draft');
  expect(await db.pending_writes.where('record_id').equals(change.id).count()).toBe(1);
});

it('reconciles acknowledged cached conflicts during an incomplete replacement without declaring handover', async () => {
  const change = fixture.one_message_delta.changes[0];
  const local = await db.chat_messages.get(change.id);
  await db.pg_record_conflicts.put({ key: `message:${change.id}`, family: 'message', record_id: change.id,
    local, reason: 'unresolved_local_command' });
  await resetPgRecordAuthority(store, { preserveViews: true });
  const partial = { ...snapshot([], 'partial'), snapshot_complete: false };
  await hydrateTowerPgSyncBundle(store, partial);
  const state = (await db.sync_state.get(recordDeltaCursorKey(store))).value;
  expect(state).toMatchObject({ cursor: 'partial', snapshotComplete: false, snapshotReconciliationPending: true });
  expect(await db.pg_record_conflicts.count()).toBe(1);
  expect(await counts()).toEqual([1, 1, 2]);
  // Reopen the canonical cache at the committed cursor as an earlier failed
  // post-page reconciliation did; no clearing storage or restarting snapshot.
  db.close(); db = openWorkspaceDb('cache-continuity'); await db.open();
  const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(delta());
  await syncTowerPgWorkspace(store, {}, ports(read));
  expect(read.mock.calls[0][1].cursor).toBe('partial');
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: 'handover', converged: true, snapshotReconciliationPending: false });
});
