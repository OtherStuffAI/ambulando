import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertChannel: vi.fn(),
  upsertScope: vi.fn(),
  createTowerPgScopeChannel: vi.fn(),
  createTowerPgWorkspaceScope: vi.fn(),
  deleteTowerPgChannel: vi.fn(),
  mapPgChannelToLocal: vi.fn((row = {}, { workspaceOwnerNpub } = {}) => ({
    record_id: row.id || row.record_id,
    owner_npub: workspaceOwnerNpub,
    title: row.name || row.title,
    scope_id: row.scope_id,
    record_state: row.record_state || 'active',
  })),
  mapPgScopeToLocal: vi.fn((row = {}, { workspaceOwnerNpub } = {}) => ({
    record_id: row.id || row.record_id,
    owner_npub: workspaceOwnerNpub,
    title: row.name || row.title,
    record_state: row.record_state || 'active',
  })),
}));

vi.mock('../src/db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  upsertChannel: mocks.upsertChannel,
  upsertScope: mocks.upsertScope,
}));
vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createTowerPgScopeChannel: mocks.createTowerPgScopeChannel,
  createTowerPgWorkspaceScope: mocks.createTowerPgWorkspaceScope,
  deleteTowerPgChannel: mocks.deleteTowerPgChannel,
}));
vi.mock('../src/pg-read-hydrator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  mapPgChannelToLocal: mocks.mapPgChannelToLocal,
  mapPgScopeToLocal: mocks.mapPgScopeToLocal,
}));

import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { openWorkspaceDb } from '../src/db.js';
import { TowerSyncService } from '../src/tower-sync-service.js';

describe('channel and scope command descriptors', () => {
  beforeEach(async () => { vi.clearAllMocks(); const db = openWorkspaceDb('channel-scope-command'); await db.open(); await db.pg_archived_targets.clear(); });

  it('materialises an optimistic scope and replaces its local id on acknowledgement', async () => {
    const descriptor = prepareTowerWorkspaceCommand({ workspaceOwnerNpub: 'owner' }, 'scope.create', {
      args: ['workspace', { client_record_id: 'scope-local', name: 'Local' }, {}],
      entityId: 'scope-local',
    });
    await descriptor.optimistic();
    await descriptor.reconcile({ scope: { id: 'scope-server', name: 'Server' } });
    expect(mocks.upsertScope).toHaveBeenNthCalledWith(1, expect.objectContaining({ record_id: 'scope-local', title: 'Local' }));
    expect(mocks.upsertScope).toHaveBeenNthCalledWith(2, expect.objectContaining({ record_id: 'scope-local', record_state: 'deleted' }));
    expect(mocks.upsertScope).toHaveBeenNthCalledWith(3, expect.objectContaining({ record_id: 'scope-server', title: 'Server' }));
  });

  it('rolls a failed channel delete back to the previous Dexie row', async () => {
    const previous = { record_id: 'channel-1', title: 'Keep me', record_state: 'active' };
    const descriptor = prepareTowerWorkspaceCommand({ workspaceOwnerNpub: 'owner', channels: [previous] }, 'channel.delete', {
      args: ['workspace', 'channel-1', {}], entityId: 'channel-1',
    });
    await descriptor.optimistic();
    await descriptor.fail(new Error('denied'));
    expect(mocks.upsertChannel).toHaveBeenNthCalledWith(1, expect.objectContaining({ record_state: 'deleted', sync_status: 'pending' }));
    expect(mocks.upsertChannel).toHaveBeenNthCalledWith(2, previous);
  });

  it('writes cloneable plain rows for proxied scope delete state', async () => {
    const previous = {
      record_id: 'scope-1',
      title: 'Delete me',
      record_state: 'active',
      group_ids: new Proxy(['group-a'], {}),
      metadata: new Proxy({ color: 'blue' }, {}),
    };
    expect(() => structuredClone(previous.group_ids)).toThrow();
    mocks.upsertScope.mockImplementation(async (row) => {
      structuredClone(row);
    });

    const descriptor = prepareTowerWorkspaceCommand({ workspaceOwnerNpub: 'owner', scopes: [previous] }, 'scope.delete', {
      args: ['workspace', 'scope-1', {}], entityId: 'scope-1',
    });
    await expect(descriptor.optimistic()).resolves.toBeUndefined();
    await expect(descriptor.reconcile({ ok: true })).resolves.toBeUndefined();
    await expect(descriptor.fail(new Error('denied'))).resolves.toBeUndefined();

    expect(mocks.upsertScope).toHaveBeenNthCalledWith(1, expect.objectContaining({ record_state: 'deleted', sync_status: 'pending' }));
    expect(mocks.upsertScope).toHaveBeenNthCalledWith(2, expect.objectContaining({ record_state: 'deleted', sync_status: 'synced' }));
    expect(mocks.upsertScope).toHaveBeenNthCalledWith(3, expect.objectContaining({ record_state: 'active', group_ids: ['group-a'], metadata: { color: 'blue' } }));
  });

  it('coalesces the same channel create intent and ignores its late acknowledgement after disposal', async () => {
    let resolve;
    const reconcile = vi.fn();
    const execute = vi.fn(() => new Promise((done) => { resolve = done; }));
    const service = new TowerSyncService({
      workspaceKey: 'workspace',
      ports: { prepareCommand: () => ({ entityKey: 'channel:local', execute, reconcile }) },
    });
    const first = service.command('channel.create', {}, { clientMutationId: 'same' });
    const duplicate = service.command('channel.create', {}, { clientMutationId: 'same' });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    service.dispose();
    resolve({ channel: { id: 'server' } });
    await expect(first).rejects.toThrow(/disposed/i);
    await expect(duplicate).rejects.toThrow(/disposed/i);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
