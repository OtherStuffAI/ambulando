import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTowerPgFileFromLocal, updateTowerPgFileFromLocal } from '../src/pg-write-adapter.js';
import { mapPgFileToLocalDocument } from '../src/pg-read-hydrator.js';
import { createTowerPgChannelFile, updateTowerPgFile } from '../src/api.js';

vi.mock('../src/api.js', async importOriginal => ({
  ...await importOriginal(),
  createTowerPgChannelFile: vi.fn(),
  updateTowerPgFile: vi.fn(),
}));

const association = { version: 1, goal_file_id: '44444444-4444-4444-8444-444444444444', future: { preserved: true } };
const metadata = { ambulando_goal: association, artefact: { schema_version: 1, type: 'whiteboard' }, future: { nested: ['retained'] } };
const raw = {
  id: 'file-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
  storage_object_id: 'storage-1', display_name: 'Vision board', metadata, row_version: 2,
};
const hydrated = () => mapPgFileToLocalDocument(raw, { workspaceOwnerNpub: 'npub1owner' });
const store = () => ({
  backendUrl: 'https://tower.example', workspaceOwnerNpub: 'npub1owner', selectedChannelId: 'channel-1',
  currentWorkspace: { workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1owner', directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg', pgBackendMode: true },
  channels: [
    { record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' },
    { record_id: 'channel-2', scope_id: 'scope-2', scope_l1_id: 'scope-2', record_state: 'active' },
  ],
});

describe('File metadata preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTowerPgFile.mockImplementation(async (_workspace, _id, body) => ({ file: { ...raw, ...body, row_version: 3 } }));
    createTowerPgChannelFile.mockImplementation(async (_workspace, _channel, body) => ({ file: { ...raw, ...body } }));
  });

  it.each([
    ['rename', { title: 'Renamed vision board' }],
    ['move', { scope_id: 'scope-2', scope_l1_id: 'scope-2', pg_channel_id: 'channel-2', pg_thread_id: null }],
  ])('preserves hydrated Goal and unknown metadata on %s', async (_label, patch) => {
    const original = hydrated();
    const accepted = await updateTowerPgFileFromLocal(store(), { ...original, ...patch }, original);
    expect(updateTowerPgFile.mock.calls[0][2].metadata).toEqual(metadata);
    expect(accepted.pg_file_metadata).toEqual(metadata);
    expect(original.pg_file_metadata).toEqual(metadata);
  });

  it('merges explicit metadata changes without erasing unrelated hydrated keys', async () => {
    const original = hydrated();
    await updateTowerPgFileFromLocal(store(), { ...original, metadata: { edited: true }, pg_metadata: { edited: false, cleared: null } }, original);
    expect(updateTowerPgFile.mock.calls[0][2].metadata).toEqual({ ...metadata, edited: false, cleared: null });
    await updateTowerPgFileFromLocal(store(), { ...original, metadata: {}, pg_metadata: {} }, original);
    expect(updateTowerPgFile.mock.calls[1][2].metadata).toEqual(metadata);
  });

  it('preserves the previous same-record snapshot when a sparse edit omits it', async () => {
    const original = hydrated();
    const sparse = { ...original }; delete sparse.pg_file_metadata;
    await updateTowerPgFileFromLocal(store(), sparse, original);
    expect(updateTowerPgFile.mock.calls[0][2].metadata).toEqual(metadata);
  });

  it('omits unknown metadata rather than replacing it with an empty object', async () => {
    const sparse = { ...hydrated() }; delete sparse.pg_file_metadata;
    await updateTowerPgFileFromLocal(store(), sparse, { ...hydrated(), record_id: 'another-file' });
    expect(updateTowerPgFile.mock.calls[0][2]).not.toHaveProperty('metadata');
  });

  it('still clears the known thread membership when it was the only metadata', async () => {
    const original = { ...hydrated(), pg_file_metadata: { thread_id: 'old-thread' }, pg_thread_id: 'old-thread' };
    await updateTowerPgFileFromLocal(store(), { ...original, pg_thread_id: null, thread_id: null }, original);
    expect(updateTowerPgFile.mock.calls[0][2].metadata).toEqual({});
  });

  it('ignores malformed metadata and never imports a different workspace snapshot', async () => {
    const sparse = { ...hydrated(), pg_file_metadata: [], metadata: 'bad', pg_metadata: null };
    await updateTowerPgFileFromLocal(store(), sparse, { ...hydrated(), pg_workspace_id: 'another-workspace' });
    expect(updateTowerPgFile.mock.calls[0][2]).not.toHaveProperty('metadata');
    await updateTowerPgFileFromLocal(store(), { ...hydrated(), metadata: [], pg_metadata: 12 }, hydrated());
    expect(updateTowerPgFile.mock.calls[1][2].metadata).toEqual(metadata);
  });

  it('does not resurrect keys deleted from a newer canonical snapshot', async () => {
    await updateTowerPgFileFromLocal(store(), { ...hydrated(), pg_file_metadata: {} }, hydrated());
    expect(updateTowerPgFile.mock.calls[0][2]).not.toHaveProperty('metadata');
  });

  it('uses the canonical File metadata field on create too', async () => {
    await createTowerPgFileFromLocal(store(), hydrated());
    expect(createTowerPgChannelFile.mock.calls[0][2].metadata).toEqual(metadata);
  });
});
