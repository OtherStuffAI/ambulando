import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteWorkspaceDb, getChannelsByOwner, openWorkspaceDb, upsertChannel, setSyncState, replaceChannelsForOwner } from '../src/db.js';
import { hydrateTowerPgChannels } from '../src/pg-read-hydrator.js';
import { recordDeltaCursorKey, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import { liveQuery } from 'dexie';
import { buildSidebarScopeChannelGroups } from '../src/sidebar-navigation.js';

const keys = new Set();
const owner = 'npub1owner';
const scope = { record_id: 'scope-1', level: 'l1', title: 'Scope', record_state: 'active' };
const channel = { record_id: 'channel-1', scope_id: 'scope-1', owner_npub: owner, title: 'Known channel', record_state: 'active' };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function workspace(id) {
  const workspaceKey = `channel-startup:${id}`;
  keys.add(workspaceKey);
  return { workspaceKey, workspaceId: id, workspaceOwnerNpub: owner, pgBackendMode: true,
    directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg' };
}
async function setup(scopes = []) {
  const currentWorkspace = workspace('alpha');
  openWorkspaceDb(currentWorkspace.workspaceKey);
  await upsertChannel(channel);
  return { currentWorkspace, session: { npub: 'npub1viewer' }, scopes, pgWorkspaceMembers: [],
    // TowerSyncService returns this when scopes were just fetched but liveQuery
    // has not yet delivered them to Alpine.
    refreshScopes: vi.fn(async () => ({ fresh: true, family: 'scopes', id: '' })),
    _workspaceSelectionGeneration: 1 };
}
function deps(overrides = {}) {
  return { getTowerPgWorkspaceScopes: vi.fn(async () => ({ scopes: [{ id: 'scope-1', level: 'l1', name: 'Scope' }] })),
    getTowerPgScopeChannels: vi.fn(async () => ({ channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Known channel' }] })),
    ...overrides };
}
afterEach(async () => { for (const key of keys) await deleteWorkspaceDb(key); keys.clear(); });

describe('channel startup hydration', () => {
  it.each([[], [scope], [{ ...scope, record_id: 'stale-scope' }]])('keeps known channels during delayed hydration with rendered scopes %j', async scopes => {
    const store = await setup(scopes);
    const gate = deferred();
    const reads = deps({ getTowerPgWorkspaceScopes: vi.fn(() => gate.promise) });
    const loading = hydrateTowerPgChannels(store, reads);
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
    gate.resolve({ scopes: [{ id: 'scope-1', level: 'l1', name: 'Scope' }] });
    await loading;
    const rows = await getChannelsByOwner(owner);
    expect(rows.map(row => row.record_id)).toEqual(['channel-1']);
    expect(buildSidebarScopeChannelGroups([scope], rows)[0].channels).toHaveLength(1);
    expect(reads.getTowerPgScopeChannels).toHaveBeenCalledWith('alpha', 'scope-1', expect.anything());
    // Directory and actor arrival does not determine channel visibility.
    store.pgWorkspaceMembers = [{ actor_id: 'actor-viewer', npub: 'npub1viewer' }];
    store.currentWorkspace.pgMe = { actor: store.pgWorkspaceMembers[0] };
    await hydrateTowerPgChannels(store, deps());
    expect((await getChannelsByOwner(owner)).map(row => row.record_id)).toEqual(['channel-1']);
    openWorkspaceDb(store.currentWorkspace.workspaceKey);
    expect((await getChannelsByOwner(owner)).map(row => row.record_id)).toEqual(['channel-1']);
  });

  it.each(['scopes', 'channels'])('preserves cached channels on an incomplete %s response', async family => {
    const store = await setup([scope]);
    const reads = deps(family === 'scopes'
      ? { getTowerPgWorkspaceScopes: async () => ({}) }
      : { getTowerPgScopeChannels: async () => ({}) });
    await expect(hydrateTowerPgChannels(store, reads)).rejects.toThrow(/response/i);
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
  });

  it.each(['scopes', 'channels'])('keeps cached channels on an empty typed %s list until record authority reconciles', async family => {
    const store = await setup([scope]);
    await hydrateTowerPgChannels(store, deps(family === 'scopes'
      ? { getTowerPgWorkspaceScopes: async () => ({ scopes: [], identity: { workspace_id: 'alpha' } }) }
      : { getTowerPgScopeChannels: async () => ({ channels: [], identity: { workspace_id: 'alpha' } }) }));
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
  });

  it('preserves cache on network failure and recovers automatically on retry', async () => {
    const store = await setup();
    await expect(hydrateTowerPgChannels(store, deps({ getTowerPgScopeChannels: async () => { throw new Error('offline'); } }))).rejects.toThrow('offline');
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
    await hydrateTowerPgChannels(store, deps());
    expect((await getChannelsByOwner(owner)).map(row => row.record_id)).toEqual(['channel-1']);
  });

  it.each(['reset', 'tombstone'])('does not resurrect a channel after a concurrent authority %s', async reason => {
    const store = await setup([scope]);
    const gate = deferred();
    const reads = deps({ getTowerPgScopeChannels: vi.fn(() => gate.promise) });
    const loading = hydrateTowerPgChannels(store, reads);
    const rejected = expect(loading).rejects.toThrow('Channel authority changed');
    await vi.waitFor(() => expect(reads.getTowerPgScopeChannels).toHaveBeenCalled());
    if (reason === 'reset') await resetPgRecordAuthority(store);
    else {
      await replaceChannelsForOwner(owner, []);
      await setSyncState(recordDeltaCursorKey(store), { cursor: 'revocation-cursor' });
    }
    gate.resolve({ channels: [{ id: 'channel-1', scope_id: 'scope-1' }] });
    await rejected;
    expect(await getChannelsByOwner(owner)).toEqual([]);
  });

  it.each(['scopes', 'channels'])('does not reconcile omissions from a capped %s list', async family => {
    const store = await setup([scope]);
    const response = { [family]: Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` })) };
    await expect(hydrateTowerPgChannels(store, deps(family === 'scopes'
      ? { getTowerPgWorkspaceScopes: async () => response }
      : { getTowerPgScopeChannels: async () => response }))).rejects.toThrow('Incomplete');
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
  });

  it('never emits an empty live channel projection while later scopes are still loading', async () => {
    const store = await setup();
    await upsertChannel({ ...channel, record_id: 'channel-2', scope_id: 'scope-2' });
    const emissions = [];
    const subscription = liveQuery(() => getChannelsByOwner(owner)).subscribe(rows => emissions.push(rows.map(row => row.record_id).sort()));
    try {
      await vi.waitFor(() => expect(emissions).toHaveLength(1));
      const gate = deferred();
      const reads = deps({
        getTowerPgWorkspaceScopes: async () => ({ scopes: [{ id: 'scope-1' }, { id: 'scope-2' }] }),
        getTowerPgScopeChannels: vi.fn(async (_workspace, scopeId) => scopeId === 'scope-2' ? gate.promise
          : { channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Updated name' }] }),
      });
      const loading = hydrateTowerPgChannels(store, reads);
      await vi.waitFor(() => expect(reads.getTowerPgScopeChannels).toHaveBeenCalledTimes(2));
      expect((await getChannelsByOwner(owner)).map(row => row.record_id).sort()).toEqual(['channel-1', 'channel-2']);
      gate.resolve({ channels: [{ id: 'channel-2', scope_id: 'scope-2' }] });
      await loading;
      await vi.waitFor(() => expect(emissions.length).toBeGreaterThan(1));
      expect(emissions.every(ids => ids.join(',') === 'channel-1,channel-2')).toBe(true);
    } finally { subscription.unsubscribe(); }
  });

  it.each([false, true])('rejects delayed hydration after a workspace switch (returning: %s)', async returning => {
    const store = await setup([scope]);
    const alpha = store.currentWorkspace;
    const gate = deferred();
    const reads = deps({ getTowerPgScopeChannels: vi.fn(() => gate.promise) });
    const loading = hydrateTowerPgChannels(store, reads);
    const rejected = expect(loading).rejects.toThrow('Workspace changed');
    await vi.waitFor(() => expect(reads.getTowerPgScopeChannels).toHaveBeenCalled());
    store.currentWorkspace = workspace('beta');
    store._workspaceSelectionGeneration++;
    openWorkspaceDb(store.currentWorkspace.workspaceKey);
    expect(await getChannelsByOwner(owner)).toEqual([]);
    if (returning) {
      store.currentWorkspace = alpha;
      store._workspaceSelectionGeneration++;
      openWorkspaceDb(alpha.workspaceKey);
    }
    gate.resolve({ channels: [{ id: 'late-channel', scope_id: 'scope-1' }] });
    await rejected;
    expect((await getChannelsByOwner(owner)).map(row => row.record_id)).toEqual(returning ? ['channel-1'] : []);
    openWorkspaceDb(alpha.workspaceKey);
    expect(await getChannelsByOwner(owner)).toEqual([channel]);
  });
});
