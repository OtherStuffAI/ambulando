import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, closeWorkspaceDb } from '../src/db.js';
import { fileBlossomMixin } from '../src/file-blossom.js';
import { getTowerPgFileBlossom } from '../src/api.js';
import { setTowerPgFileBlossom } from '../src/tower-command-intents.js';
vi.mock('../src/api.js', () => ({ getTowerPgFileBlossom: vi.fn() }));
vi.mock('../src/tower-command-intents.js', () => ({ setTowerPgFileBlossom: vi.fn() }));
vi.mock('../src/pg-workspace-context.js', () => ({ resolveTowerPgWorkspaceContext: store => store.context }));
let db, store;
const row = { pg_record_type: 'file', source_record_id: 'file', name: 'Podcast', workspace_id: 'workspace' };
const status = { can_publish: true, versions: [{ version_id: 'v2', version_number: 2, available: true, public: false, published_by_you: false }, { version_id: 'v1', version_number: 1, available: true, public: true, published_by_you: true, blossom_url: 'https://tower.test/hash' }] };
beforeEach(() => {
  vi.clearAllMocks(); db = openWorkspaceDb(`blossom-test-${crypto.randomUUID()}`);
  store = Object.assign(Object.create(fileBlossomMixin), { isTowerPgMode: true, context: { workspaceId: 'workspace', baseUrl: 'https://tower.test', appNpub: 'npub1app' } });
  getTowerPgFileBlossom.mockResolvedValue(status);
  vi.stubGlobal('window', { confirm: vi.fn(() => true) });
});
afterEach(async () => { store.closeFileBlossom(); closeWorkspaceDb(); await db.delete(); vi.unstubAllGlobals(); });
describe('Files publication panel', () => {
  it('persists server versions in Dexie before rendering and selects newest version', async () => {
    await store.openFileBlossom(row);
    expect((await db.file_blossom_status.get('workspace:file')).versions).toEqual(status.versions);
    await vi.waitFor(() => expect(store.fileBlossomVersionId).toBe('v2'));
    expect(store.selectedFileBlossomVersion.public).toBe(false);
    store.fileBlossomVersionId = 'v1';
    expect(store.selectedFileBlossomVersion.blossom_url).toBe('https://tower.test/hash');
  });
  it('requires consent, write permission, and sends the exact selected version', async () => {
    await store.openFileBlossom(row); await vi.waitFor(() => expect(store.fileBlossomCanPublish).toBe(true));
    store.fileBlossomVersionId = 'v1';
    window.confirm.mockReturnValue(false); await store.changeFileBlossom(false); expect(setTowerPgFileBlossom).not.toHaveBeenCalled();
    window.confirm.mockReturnValue(true); await store.changeFileBlossom(false);
    expect(setTowerPgFileBlossom).toHaveBeenCalledWith(store, 'workspace', 'file', 'v1', false, { baseUrl: 'https://tower.test', appNpub: 'npub1app' });
    store.fileBlossomCanPublish = false; await store.changeFileBlossom(true); expect(setTowerPgFileBlossom).toHaveBeenCalledTimes(1);
  });
  it('refuses cross-workspace files and surfaces server errors without inventing public status', async () => {
    await store.openFileBlossom({ ...row, workspace_id: 'foreign' }); expect(getTowerPgFileBlossom).not.toHaveBeenCalled(); expect(store.fileBlossomError).toContain('owning workspace');
    getTowerPgFileBlossom.mockRejectedValue(new Error('permission_denied')); await store.openFileBlossom(row);
    expect(store.fileBlossomError).toBe('permission_denied'); expect(store.fileBlossomVersions).toEqual([]);
  });
  it('ignores a delayed response after closing or workspace switch', async () => {
    let resolve; getTowerPgFileBlossom.mockImplementation(() => new Promise(done => { resolve = done; }));
    const opening = store.openFileBlossom(row); store.closeFileBlossom(); resolve(status); await opening;
    expect(await db.file_blossom_status.get('workspace:file')).toBeUndefined(); expect(store.fileBlossomVersions).toEqual([]);
  });
  it('rejects a changed signer or backend even within the same workspace', async () => {
    await store.openFileBlossom(row); await vi.waitFor(() => expect(store.fileBlossomCanPublish).toBe(true));
    store.context = { ...store.context, sessionNpub: 'another-signer' };
    await store.changeFileBlossom(true);
    expect(setTowerPgFileBlossom).not.toHaveBeenCalled(); expect(store.fileBlossomOpen).toBe(false);
  });
  it('keeps a newly opened panel busy when an older request finishes', async () => {
    const pending = [];
    getTowerPgFileBlossom.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const first = store.openFileBlossom(row);
    const second = store.openFileBlossom({ ...row, source_record_id: 'second' });
    pending[0](status); await first;
    expect(store.fileBlossomBusy).toBe(true);
    pending[1](status); await second;
    expect(store.fileBlossomBusy).toBe(false);
  });
});
