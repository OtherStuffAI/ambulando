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

vi.mock('../src/api.js', async importOriginal => ({ ...await importOriginal(), getTowerPgFile: vi.fn(), getTowerPgFileVersions: vi.fn(), getTowerPgFileVersionObjectBytes: vi.fn(), prepareTowerPgStorageObject: vi.fn(), uploadStorageObject: vi.fn(), completeStorageObject: vi.fn(), createTowerPgFileVersion: vi.fn() }));
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
