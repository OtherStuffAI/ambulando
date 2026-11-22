import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { artefactType, ARTEFACT_TYPES } from '../src/artefact-registry.js';
import { openWorkspaceDb } from '../src/db.js';
import { queueThreadPin, readThreadPinProjection, threadPinContext } from '../src/thread-pin-store.js';
import { mapPgFileToLocalDocument } from '../src/pg-read-hydrator.js';

it('classifies legacy rich Files while keeping ordinary documents and excluding unrelated attachments', () => {
  expect(artefactType({ title: 'Notes' })).toBe('document');
  expect(artefactType({ pg_record_type: 'file', title: 'Plan.excalidraw' })).toBe('excalidraw');
  expect(artefactType({ pg_record_type: 'file', pg_file_metadata: { html_artifact: true } })).toBe('html');
  expect(artefactType({ pg_record_type: 'file', title: 'photo.png' })).toBe(null);
  expect(ARTEFACT_TYPES.map(type => type.id)).toEqual(['document', 'excalidraw', 'html']);
});

it('retains type metadata and MIME on channel File materialization', () => {
  const row = mapPgFileToLocalDocument({ id: 'file', workspace_id: 'workspace', content_type: 'application/vnd.excalidraw+json', metadata: { kind: 'excalidraw_board' }, display_name: 'Renamed board', can_write: false });
  expect(artefactType(row)).toBe('excalidraw');
  expect(row.can_write).toBe(false);
});

it('persists a File pin through the existing CAS outbox and renders revocation neutrally', async () => {
  const db = openWorkspaceDb('channel-artefact-pin-test'); await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  const store = { session: { npub: 'alice' }, currentWorkspace: { workspaceId: 'workspace', directHttpsUrl: 'http://localhost:3100', pgMe: { actor: { actor_id: 'actor', npub: 'alice' } } } };
  const context = threadPinContext(store);
  await db.channels.put({ record_id: 'channel', title: 'Ideas' });
  await db.documents.put({ record_id: 'file', pg_record_type: 'file', pg_channel_id: 'channel', title: 'Shared board' });
  await queueThreadPin(db, context, { id: 'file', channelId: 'channel' }, true, 'file');
  expect((await db.thread_pin_outbox.toArray())[0]).toMatchObject({ resourceType: 'file', body: { expected_row_version: 0 } });
  expect((await readThreadPinProjection(db, context, 'test')).rows[0]).toMatchObject({ type: 'file', title: 'Shared board', unavailable: false });
  await db.documents.update('file', { pg_access_status: 'access-lost' });
  expect((await readThreadPinProjection(db, context, 'test')).rows[0].unavailable).toBe(true);
});

vi.mock('../src/api.js', async importOriginal => ({ ...await importOriginal(), getTowerPgChannel: vi.fn(), getTowerPgChannelFiles: vi.fn(), createTowerPgChannelFile: vi.fn(), getTowerPgFile: vi.fn(), getTowerPgFileVersions: vi.fn(), getTowerPgFileVersionObjectBytes: vi.fn(), prepareTowerPgStorageObject: vi.fn(), uploadStorageObject: vi.fn(), completeStorageObject: vi.fn(), createTowerPgFileVersion: vi.fn() }));
import * as api from '../src/api.js';
import { artefactsMixin } from '../src/artefacts.js';
const workspace = '20000000-0000-4000-8000-000000000071', file = '60000000-0000-4000-8000-000000000001', version = '60000000-0000-4000-8000-000000000002';
let store;
beforeEach(() => {
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('window', { confirm: () => true });
  store = { ...artefactsMixin, $nextTick: () => {}, session: { npub: 'alice' }, currentViewerNpub: 'alice', currentWorkspaceKey: 'channel-artefact-pin-test', currentWorkspace: { workspaceId: workspace, directHttpsUrl: 'http://localhost:3100' } };
});
afterEach(async () => { await store.closeArtefact({ force: true }); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openHtml(canWrite = true) {
  const bytes = new TextEncoder().encode('<h1>Shared</h1>');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  api.getTowerPgFile.mockResolvedValue({ file: { id: file, workspace_id: workspace, display_name: 'Shared', can_write: canWrite } });
  api.getTowerPgFileVersions.mockResolvedValue({ current_version_id: version, versions: [{ id: version, file_id: file, version_number: 1, content_type: 'text/html', size_bytes: bytes.length, sha256_hex: sha }] });
  api.getTowerPgFileVersionObjectBytes.mockResolvedValue({ bytes });
  await store.openArtefact({ record_id: file, pg_record_type: 'file', title: 'Shared.html' });
}
it('opens canonical HTML source with digest verification and prevents read-only saves', async () => {
  await openHtml(false);
  expect(store.artefact.source).toBe('<h1>Shared</h1>');
  store.artefact.dirty = true;
  await store.saveArtefactHtml();
  expect(api.createTowerPgFileVersion).not.toHaveBeenCalled();
});
it('retains HTML source and captured base after a stale save', async () => {
  await openHtml(); store.artefact.source = '<h1>My edit</h1>'; store.artefact.dirty = true;
  api.prepareTowerPgStorageObject.mockResolvedValue({ object_id: 'upload' });
  api.createTowerPgFileVersion.mockRejectedValue(Object.assign(new Error('stale'), { status: 409 }));
  await store.saveArtefactHtml();
  expect(api.createTowerPgFileVersion).toHaveBeenCalledWith(workspace, file, expect.objectContaining({ base_version_id: version }), expect.anything());
  expect(store.artefact).toMatchObject({ source: '<h1>My edit</h1>', dirty: true, base: version });
  expect(store.artefact.error).toContain('newer version');
});

it('creates an empty tracker under the current verified self channel with separate code/data Files', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<h1>Reviewed bundle</h1>' })));
  store.ensureTowerPgDmChannel = vi.fn(async () => ({ record_id: 'self-channel' }));
  api.getTowerPgChannel.mockResolvedValue({ channel: { id: 'self-channel', workspace_id: workspace, kind: 'dm', participant_npubs: ['alice'] } });
  api.prepareTowerPgStorageObject.mockResolvedValue({ object_id: 'private-upload', is_public: false });
  api.createTowerPgChannelFile.mockResolvedValueOnce({ file: { id: file } }).mockResolvedValueOnce({ file: { id: version, workspace_id: workspace, display_name: 'Daily tracker.html', content_type: 'text/html' } });
  store.openArtefact = vi.fn(async () => true);
  await store.createDailyTracker();
  expect(store.ensureTowerPgDmChannel).toHaveBeenCalledWith('alice');
  const uploaded = api.uploadStorageObject.mock.calls[0][1];
  expect(JSON.parse(new TextDecoder().decode(uploaded))).toEqual({ format: 'daily-tracker-v1', metrics: [], days: {} });
  expect(api.createTowerPgChannelFile.mock.calls[1][2].metadata.napplet.bindings.tracker.file_id).toBe(file);
  expect(api.createTowerPgChannelFile.mock.calls.every(call => call[1] === 'self-channel')).toBe(true);
  expect(store.openArtefact).toHaveBeenCalled();
});
it('does not upload tracker data when the self channel belongs to another viewer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<h1>Reviewed bundle</h1>' })));
  store.ensureTowerPgDmChannel = vi.fn(async () => ({ record_id: 'self-channel' }));
  api.getTowerPgChannel.mockResolvedValue({ channel: { id: 'self-channel', workspace_id: workspace, kind: 'dm', participant_npubs: ['someone-else'] } });
  await store.createDailyTracker();
  expect(api.uploadStorageObject).not.toHaveBeenCalled();
  expect(store.error).toContain('verified private self');
});


async function discover(files = []) {
  store.isTowerPgMode = true;
  store.ensureTowerPgDmChannel = vi.fn(async () => ({ record_id: 'self' }));
  api.getTowerPgChannel.mockResolvedValue({ channel: { id: 'self', workspace_id: workspace, kind: 'dm', participant_npubs: ['alice'] } });
  api.getTowerPgChannelFiles.mockResolvedValue({ files });
  store.openArtefact = vi.fn(async () => true);
  await store.openDailyMetrics();
}
it('discovers a renamed existing tracker by metadata and reuses its File without provisioning', async () => {
  const existing = { id: file, workspace_id: workspace, display_name: 'Renamed.html', metadata: { napplet: { app_id: 'daily-tracker' } } };
  await discover([existing]);
  expect(store.openArtefact).toHaveBeenCalledWith(expect.objectContaining({ record_id: file }), { appMode: true });
  expect(api.createTowerPgChannelFile).not.toHaveBeenCalled();
  await store.openDailyMetrics();
  expect(store.openArtefact).toHaveBeenCalledTimes(2);
});
it('offers setup only for a successful empty list and rechecks before creating', async () => {
  await discover([]);
  expect(store.dailyMetrics.status).toBe('setup');
  store.createDailyTracker = vi.fn();
  api.getTowerPgChannelFiles.mockResolvedValue({ files: [{ id: file, metadata: { napplet: { app_id: 'daily-tracker' } } }] });
  await store.setupDailyMetrics();
  expect(store.createDailyTracker).not.toHaveBeenCalled();
  expect(store.openArtefact).toHaveBeenCalledTimes(1);
});
it('requires a chooser for multiple instances without silently picking or provisioning', async () => {
  await discover([file, version].map(id => ({ id, metadata: { napplet: { app_id: 'daily-tracker' } } })));
  expect(store.dailyMetrics.status).toBe('choose');
  expect(store.openArtefact).not.toHaveBeenCalled();
  await store.openDailyMetricsFile(store.dailyMetrics.candidates[1]);
  expect(store.openArtefact).toHaveBeenCalledWith(expect.objectContaining({ record_id: version }), { appMode: true });
});
it('fails closed for wrong viewer, denied discovery and incomplete lists', async () => {
  await discover([]);
  for (const payload of [{ files: Array.from({ length: 200 }, () => ({})) }, { files: [], has_more: true }, { files: [], partial: true }, {}]) {
    api.getTowerPgChannelFiles.mockResolvedValue(payload);
    await store.openDailyMetrics();
    expect(store.dailyMetrics.status).toBe('error');
  }
  api.getTowerPgChannelFiles.mockRejectedValue(Object.assign(Error('Denied'), { status: 403 }));
  await store.openDailyMetrics();
  expect(store.dailyMetrics.status).toBe('error');
  api.getTowerPgChannel.mockResolvedValue({ channel: { id: 'self', workspace_id: workspace, kind: 'dm', participant_npubs: ['other'] } });
  await store.openDailyMetrics();
  expect(store.dailyMetrics.status).toBe('error');
  expect(store.openArtefact).not.toHaveBeenCalled();
  expect(api.createTowerPgChannelFile).not.toHaveBeenCalled();
});
it('does not reopen setup when discovery finishes after close', async () => {
  await discover([]);
  let resolve;
  api.getTowerPgChannelFiles.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = store.openDailyMetrics();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  store.closeDailyMetrics();
  resolve({ files: [] });
  await pending;
  expect(store.dailyMetrics.status).toBe('closed');
});
