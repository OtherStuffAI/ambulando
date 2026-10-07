import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb, closeWorkspaceDb } from '../src/db.js';
import { fileBlossomMixin } from '../src/file-blossom.js';
import { getTowerPgFileBlossom, getTowerPgAttachmentBlossom } from '../src/api.js';
import { setTowerPgFileBlossom, setTowerPgAttachmentBlossom } from '../src/tower-command-intents.js';
vi.mock('../src/api.js', () => ({ getTowerPgFileBlossom: vi.fn(), getTowerPgAttachmentBlossom: vi.fn() }));
vi.mock('../src/tower-command-intents.js', () => ({ setTowerPgFileBlossom: vi.fn(), setTowerPgAttachmentBlossom: vi.fn() }));
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

describe('message attachment publication panel', () => {
  const attachmentRow = { source_type: 'chat', source_record_id: 'message', object_id: 'object', name: 'Image', workspace_id: 'workspace' };
  const attachment = { storage_object_id: 'object', link_id: 'source-link', sha256_hex: 'a'.repeat(64), available: true, public: false, published_by_you: false };
  it('supports chat-sourced Files rows and sends exact observed link and hash consent', async () => {
    getTowerPgAttachmentBlossom.mockResolvedValue({ can_publish: true, attachment });
    expect(store.canPublishFileBrowserRow(attachmentRow)).toBe(true);
    await store.openFileBlossom(attachmentRow); await vi.waitFor(() => expect(store.fileBlossomCanPublish).toBe(true));
    expect((await db.file_blossom_status.get('workspace:message:message:object')).versions[0].link_id).toBe('source-link');
    await store.changeFileBlossom(true);
    expect(setTowerPgFileBlossom).not.toHaveBeenCalled();
    expect(setTowerPgAttachmentBlossom).toHaveBeenCalledWith(store, 'workspace', 'message', 'object', true, { link_id: 'source-link', sha256_hex: 'a'.repeat(64) }, { baseUrl: 'https://tower.test', appNpub: 'npub1app' });
  });
  it('discovers inline images and attachment-only files without duplicate buttons', () => {
    const message = { record_id: 'message', body: '![Image](storage://object)', attachments: [{ kind: 'image', storage_object_id: 'object' }, { kind: 'file', storage_object_id: 'other' }] };
    expect(store.publishableMessageAttachments(message).map(a => a.storage_object_id)).toEqual(['object', 'other']);
    store.isTowerPgMode=false; expect(store.publishableMessageAttachments(message)).toEqual([]);
  });
  it('does not enable stale cached authority when a fresh read fails', async () => {
    await db.file_blossom_status.put({ key: 'workspace:message:message:object', can_publish: true, versions: [attachment] });
    getTowerPgAttachmentBlossom.mockRejectedValue(new Error('source removed'));
    await store.openFileBlossom(attachmentRow); await store.changeFileBlossom(true);
    expect(store.fileBlossomCanPublish).toBe(false);expect(setTowerPgAttachmentBlossom).not.toHaveBeenCalled();
  });
  it('rechecks identity after public consent and refuses mutation on an identity change', async () => {
    getTowerPgAttachmentBlossom.mockResolvedValue({ can_publish: true, attachment });
    await store.openFileBlossom(attachmentRow);await vi.waitFor(() => expect(store.fileBlossomCanPublish).toBe(true));
    window.confirm.mockImplementation(() => { store.context={...store.context,sessionNpub:'changed'};return true; });
    await store.changeFileBlossom(true);expect(setTowerPgAttachmentBlossom).not.toHaveBeenCalled();expect(store.fileBlossomOpen).toBe(false);
  });
});
