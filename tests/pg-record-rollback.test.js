import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, recordDeltaCursorKey, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import { syncTowerPgWorkspace, towerPgSyncCursorKey } from '../src/pg-read-hydrator.js';

const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = { workspaceId, workspaceOwnerNpub: 'npub1owner', backendUrl: 'http://localhost:3000',
  session: { npub: 'npub1viewer' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner', pgBackendMode: true } };
const delta = (cursor = 'v1-next') => ({ ...fixture.one_message_delta, changes: [], next_cursor: cursor, has_more: false });
const unsupported = status => Object.assign(new Error('endpoint unavailable'), { status });
let db;
beforeEach(async () => {
  db = openWorkspaceDb('record-rollback-tests');
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  await db.sync_state.put({ key: towerPgSyncCursorKey(store), value: 'legacy-old' });
});
const ports = read => ({
  getTowerPgRecordSync: read,
  getTowerPgWorkspaceSync: vi.fn(async () => ({ mode: 'delta', next_cursor: 'legacy-next', has_more: false })),
  getTowerPgResourceViewStates: vi.fn(async () => ({ states: [] })),
});
async function seed(mode) {
  if (mode !== 'first snapshot') {
    await applyPgRecordChanges(store, mode === 'partial snapshot'
      ? { ...fixture.canonical_upserts, snapshot_complete: false, has_more: true, next_cursor: 'v1-partial' }
      : { ...fixture.one_message_delta, next_cursor: 'v1-delta', has_more: false });
    const saved = await db.sync_state.get(recordDeltaCursorKey(store));
    await db.sync_state.put({ ...saved, value: { ...saved.value, localGeneration: 7 } });
  }
  await db.chat_messages.put({ record_id: 'pending', channel_id: 'channel', body: 'local edit', sync_status: 'pending' });
  await db.pending_writes.add({ record_id: 'pending', envelope: { body: 'local edit' } });
}
async function retained() {
  return { state: await db.sync_state.get(recordDeltaCursorKey(store)), canonical: await db.pg_record_rows.toArray(),
    local: await db.chat_messages.toArray(), pending: await db.pending_writes.toArray() };
}
function withLegacyFallbackActive(snapshot) {
  return { ...snapshot, state: { key: recordDeltaCursorKey(store), value: {
    ...(snapshot.state?.value || {}), cursor: snapshot.state?.value?.cursor || null, legacyFallbackActive: true,
  } } };
}

describe('record protocol rollback', () => {
  for (const mode of ['first snapshot', 'partial snapshot', 'delta']) {
    it.each([404, 406, 501])(`preserves ${mode} and resumes independent cursors on %i`, async status => {
      await seed(mode);
      const before = await retained();
      const read = vi.fn().mockRejectedValue(unsupported(status));
      const deps = ports(read);
      await syncTowerPgWorkspace(store, { forceSnapshot: true, cursor: 'must-not-reach-legacy' }, deps);
      expect(read.mock.calls[0][1].cursor).toBe(before.state?.value.cursor || null);
      expect(deps.getTowerPgWorkspaceSync.mock.calls[0][1].cursor).toBe('legacy-old');
      expect(await retained()).toEqual(withLegacyFallbackActive(before));
      const resumePage = mode === 'partial snapshot'
        ? { ...fixture.canonical_upserts, next_cursor: 'v1-snapshot-end', has_more: true }
        : delta('v1-restored');
      read.mockResolvedValueOnce(resumePage).mockResolvedValue(delta('v1-restored'));
      await syncTowerPgWorkspace(store, {}, deps);
      expect(read.mock.calls[1][1].cursor).toBe(before.state?.value.cursor || null);
      expect(deps.getTowerPgWorkspaceSync).toHaveBeenCalledTimes(1);
      expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('v1-restored');
      expect((await db.sync_state.get(towerPgSyncCursorKey(store))).value).toBe('legacy-next');
      expect(await db.pending_writes.toArray()).toEqual(before.pending);
    });
  }

  it('preserves a snapshot page committed before endpoint disappearance, then resumes it', async () => {
    await seed('first snapshot');
    const partial = { ...fixture.canonical_upserts, snapshot_complete: false, has_more: true, next_cursor: 'v1-partial' };
    let before;
    const read = vi.fn().mockResolvedValueOnce(partial).mockImplementationOnce(async () => {
      before = await retained();
      throw unsupported(404);
    });
    const deps = ports(read);
    await syncTowerPgWorkspace(store, {}, deps);
    expect(await retained()).toEqual(withLegacyFallbackActive(before));
    expect(read.mock.calls.map(([, options]) => options.cursor)).toEqual([null, 'v1-partial']);
    expect(deps.getTowerPgWorkspaceSync.mock.calls[0][1].cursor).toBe('legacy-old');
    read.mockResolvedValueOnce({ ...fixture.canonical_upserts, next_cursor: 'snapshot-end', has_more: true }).mockResolvedValue(delta());
    await syncTowerPgWorkspace(store, {}, deps);
    expect(read.mock.calls[2][1].cursor).toBe('v1-partial');
  });

  it('purges revoked authority on 403 and never requests legacy, including on the next run', async () => {
    await seed('delta');
    const read = vi.fn().mockRejectedValue(Object.assign(unsupported(403), { responseText: JSON.stringify({ code: 'workspace_membership_required', error: 'Actor is not a member' }) }));
    const deps = ports(read);
    await expect(syncTowerPgWorkspace(store, { forceSnapshot: true }, deps)).rejects.toMatchObject({ status: 403 });
    expect(await db.pg_record_rows.count()).toBe(0);
    expect(await db.chat_messages.count()).toBe(0);
    expect(await db.pending_writes.count()).toBe(1);
    expect(await db.pg_record_conflicts.count()).toBeGreaterThan(0);
    read.mockRejectedValue(unsupported(404));
    await expect(syncTowerPgWorkspace(store, {}, deps)).rejects.toMatchObject({ status: 404 });
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
  });

  it('recovers an expired restored cursor through explicit reset and snapshot without legacy', async () => {
    await seed('delta');
    const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error('reset_required'), { status: 409 }))
      .mockResolvedValueOnce({ ...fixture.canonical_upserts, next_cursor: 'reset-snapshot', has_more: true }).mockResolvedValue(delta());
    const deps = ports(read);
    await syncTowerPgWorkspace(store, {}, deps);
    expect(read.mock.calls.map(([, options]) => options.cursor)).toEqual(['v1-delta', null, 'reset-snapshot']);
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.localGeneration).toBe(8);
    expect(await db.pending_writes.count()).toBe(1);
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
  });

  it('does not downgrade if the endpoint disappears during reset recovery', async () => {
    await seed('delta');
    const deps = ports(vi.fn().mockRejectedValueOnce(Object.assign(new Error('reset_required'), { status: 409 }))
      .mockRejectedValueOnce(unsupported(404)));
    await expect(syncTowerPgWorkspace(store, {}, deps)).rejects.toMatchObject({ status: 404 });
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.resetting).toBe(true);
  });

  it.each([400, 409, 500, undefined])('does not downgrade or clear cache on generic/transient %s', async status => {
    await seed('delta');
    const before = await retained();
    const deps = ports(vi.fn().mockRejectedValue(unsupported(status)));
    await expect(syncTowerPgWorkspace(store, { forceSnapshot: true }, deps)).rejects.toThrow();
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
    expect(await retained()).toEqual(before);
  });

  it.each([
    { protocol_version: 0 }, { changes: null }, { next_cursor: '' }, { actors: [{}] },
    { changes: [{ ...fixture.one_message_delta.changes[0], version: 'invalid' }] },
  ])('does not downgrade or mutate persisted cache on malformed page %j', async patch => {
    await seed('delta');
    const before = await retained();
    const deps = ports(vi.fn().mockResolvedValue({ ...delta(), ...patch }));
    await expect(syncTowerPgWorkspace(store, { forceSnapshot: true }, deps)).rejects.toThrow();
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
    expect(await retained()).toEqual(before);
  });

  it('starts legacy without a cursor when only a v1 cursor exists', async () => {
    await seed('delta');
    await db.sync_state.delete(towerPgSyncCursorKey(store));
    const before = await retained();
    const deps = ports(vi.fn().mockRejectedValue(unsupported(404)));
    await syncTowerPgWorkspace(store, { cursor: 'v1-delta' }, deps);
    expect(deps.getTowerPgWorkspaceSync.mock.calls[0][1].cursor).toBeNull();
    expect(await retained()).toEqual(withLegacyFallbackActive(before));
  });

  it.each(['reset', 'advance'])('rejects delayed legacy fallback after a concurrent v1 %s', async action => {
    await seed('delta');
    const deps = ports(vi.fn().mockRejectedValue(unsupported(404)));
    deps.getTowerPgWorkspaceSync.mockImplementation(async () => {
      if (action === 'reset') await resetPgRecordAuthority(store);
      else await applyPgRecordChanges(store, delta('concurrent-v1'), { expectedCursor: 'v1-delta', expectedGeneration: 7 });
      return { mode: 'delta', next_cursor: 'stale-legacy', has_more: false,
        channel_bundles: [{ channel_id: 'channel', messages: [{ id: 'stale', channel_id: 'channel', body: 'revoked' }] }] };
    });
    await expect(syncTowerPgWorkspace(store, {}, deps)).rejects.toThrow('authority changed before legacy fallback commit');
    expect(await db.chat_messages.get('stale')).toBeUndefined();
    expect((await db.sync_state.get(towerPgSyncCursorKey(store))).value).toBe('legacy-old');
    expect(await db.pending_writes.count()).toBe(1);
  });

  it('keeps the generation CAS when force refresh races an authority reset', async () => {
    await seed('delta');
    const deps = ports(vi.fn(async () => {
      await resetPgRecordAuthority(store);
      return delta();
    }));
    await expect(syncTowerPgWorkspace(store, { forceSnapshot: true }, deps)).rejects.toThrow('generation changed');
    expect(deps.getTowerPgWorkspaceSync).not.toHaveBeenCalled();
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: null, localGeneration: 8 });
  });
});
