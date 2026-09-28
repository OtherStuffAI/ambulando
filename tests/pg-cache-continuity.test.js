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

  it('publishes a snapshot when the empty handover reuses the terminal snapshot cursor', async () => {
    const read = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(delta([], 'snapshot-end'));
    await observe(() => syncTowerPgWorkspace(store, {}, ports(read)));
    expect(await db.pg_record_rows.count()).toBe(17);
  });

  it('rolls back the whole replacement if the final publication fails', async () => {
    await resetPgRecordAuthority(store, { preserveViews: true });
    await applyPgRecordChanges(store, snapshot(), { stageSnapshot: true });
    const before = await counts();
    await expect(applyPgRecordChanges(store, delta(), { beforeCommit: () => { throw new Error('commit failed'); } })).rejects.toThrow('commit failed');
    expect(await counts()).toEqual(before);
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ staging: true, cursor: 'snapshot-end' });
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
