import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  completeStorageObject: vi.fn(),
  createTowerPgChannelFile: vi.fn(),
  createTowerPgFileVersion: vi.fn(),
  getTowerPgFileVersionObjectBytes: vi.fn(),
  getTowerPgFileVersions: vi.fn(),
  prepareTowerPgStorageObject: vi.fn(),
  uploadStorageObject: vi.fn(),
  updateTowerPgFile: vi.fn(),
}));
vi.mock('../src/api.js', () => api);

import { getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import {
  BOARD_CONTENT_TYPE,
  boardSceneFingerprint,
  exportPublicBoardScene,
  isBoardFileRow,
  parseBoardScene,
  rebaseBoardScene,
  restoreBoardScene,
  serializeBoardScene,
} from '../src/canvas/board-scene.js';
import { BoardStaleError, CanvasBoardRuntime } from '../src/canvas/board-sync.js';
import { BoardController } from '../src/canvas/board-controller.js';
import { canvasBoardStore } from '../src/canvas/board-page.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const context = { baseUrl: 'https://tower.example', tower: 'tower', service: 'service', workspaceId: 'workspace', appNpub: 'app', viewer: 'npub1viewer', actorId: 'actor', dbKey: 'boards-db' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const rect = (id, version = 1, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version * 7, isDeleted: false, ...extra });
const text = (id, value, version = 1) => ({ id, type: 'text', text: value, originalText: value, x: 0, y: 0, width: 40, height: 20, version, versionNonce: version * 11, isDeleted: false });
const image = (id, fileId, version = 1) => ({ id, type: 'image', fileId, status: 'saved', x: 0, y: 0, width: 1, height: 1, version, versionNonce: version * 13, isDeleted: false });
const scene = (elements, files = {}) => ({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff', zoom: { value: 2 } }, files });

/** In-memory Tower: Files with immutable versions and base_version_id CAS. */
function fakeTower() {
  const objects = new Map(), files = new Map();
  let counter = 100;
  const readable = { value: true };
  const deny = () => Object.assign(new Error('not found'), { status: 404 });
  api.prepareTowerPgStorageObject.mockImplementation(async (_ws, body) => ({ object_id: uuid(++counter), is_public: false, content_type: body.content_type }));
  api.uploadStorageObject.mockImplementation(async (prepared, bytes) => { objects.set(prepared.object_id, new Uint8Array(bytes)); return { object_id: prepared.object_id }; });
  api.completeStorageObject.mockImplementation(async (objectId, body) => { expect(body.sha256_hex).toBe(sha(objects.get(objectId))); return {}; });
  const addVersion = (file, objectId, author, summary) => {
    const version = { id: uuid(++counter), version_number: file.versions.length + 1, storage_object_id: objectId, created_by_actor_npub: author, summary, created_at: new Date(2026, 9, 21, 10, file.versions.length).toISOString(), sha256_hex: sha(objects.get(objectId)), size_bytes: objects.get(objectId).byteLength, content_type: BOARD_CONTENT_TYPE };
    file.versions.push(version); file.current_version_id = version.id;
    return version;
  };
  api.createTowerPgChannelFile.mockImplementation(async (_ws, channelId, body) => {
    const file = { id: uuid(++counter), channel_id: channelId, display_name: body.display_name, versions: [], current_version_id: null };
    files.set(file.id, file);
    addVersion(file, body.storage_object_id, context.viewer, body.summary || '');
    return { file: { id: file.id, current_version_id: file.current_version_id } };
  });
  api.createTowerPgFileVersion.mockImplementation(async (_ws, fileId, body) => {
    const file = files.get(fileId);
    if (!file || !readable.value) throw deny();
    if (file.current_version_id !== body.base_version_id) {
      const current = file.versions.at(-1);
      throw Object.assign(new Error('File base_version_id is stale'), { status: 409, code: 'stale_base_version', payload: { current_version: current } });
    }
    return { version: addVersion(file, body.storage_object_id, tower.author, body.summary || '') };
  });
  api.getTowerPgFileVersions.mockImplementation(async (_ws, fileId) => {
    const file = files.get(fileId);
    if (!file || !readable.value) throw deny();
    return { file_id: fileId, current_version_id: file.current_version_id, versions: [...file.versions].reverse() };
  });
  api.getTowerPgFileVersionObjectBytes.mockImplementation(async (_ws, fileId, versionId) => {
    const file = files.get(fileId);
    const version = file?.versions.find(row => row.id === versionId);
    if (!version || !readable.value) throw deny();
    const bytes = objects.get(version.storage_object_id);
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), contentType: BOARD_CONTENT_TYPE };
  });
  const tower = {
    files, readable, author: context.viewer,
    meta(fileId, overrides = {}) {
      const file = files.get(fileId), current = file.versions.at(-1);
      return { file_id: fileId, current_version_id: current.id, current_version_number: current.version_number, sha256: current.sha256_hex, can_write: true, ...overrides };
    },
    /** Another actor (agent or person) publishes against a base version. */
    async publishAs(author, fileId, nextScene, baseVersionId) {
      const previous = tower.author; tower.author = author;
      try { return await new CanvasBoardRuntime({ ...context, viewer: author }).saveVersion({ fileId, baseVersionId, scene: nextScene, summary: `${author} edit` }); }
      finally { tower.author = previous; }
    },
  };
  return tower;
}

async function settle() { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); }

beforeEach(async () => { await openWorkspaceDb(context.dbKey).open(); });
afterEach(async () => {
  vi.clearAllMocks();
  try { await getWorkspaceDb().delete(); } catch {}
});

describe('canonical board scenes', () => {
  it('keeps tombstones, element metadata, unknown fields and referenced images; drops viewer state', () => {
    const input = scene([rect('a', 3, { customData: { owner: 'agent' } }), image('img', 'file-1', 2), rect('gone', 5, { isDeleted: true })], {
      'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: PNG, created: 1 },
      orphan: { id: 'orphan', mimeType: 'image/png', dataURL: PNG },
    });
    const { scene: canonical, bytes } = serializeBoardScene(input, { summary: 'first', baseVersionId: uuid(1) });
    expect(canonical.elements.map(row => [row.id, row.version, row.isDeleted])).toEqual([['a', 3, false], ['img', 2, false], ['gone', 5, true]]);
    expect(canonical.elements[0].customData).toEqual({ owner: 'agent' });
    expect(Object.keys(canonical.files)).toEqual(['file-1']);
    expect(canonical.appState).toEqual({});
    expect(serializeBoardScene({ ...input, appState: { viewBackgroundColor: '#fdf6e3', gridStep: 5, name: 'Untitled-2026' } }).scene.appState).toEqual({ viewBackgroundColor: '#fdf6e3' });
    expect(canonical.wingman).toEqual({ summary: 'first', base_version_id: uuid(1) });
    expect(parseBoardScene(bytes).elements).toHaveLength(3);
  });

  it('accepts the Artifact-style {scene} wrapper used by the Wingman Suite architecture board', () => {
    const parsed = parseBoardScene(JSON.stringify({ title: 'arch', scene: { elements: [text('t', 'Tower')], appState: {}, files: {} } }));
    expect(parsed.elements[0].text).toBe('Tower');
  });

  it('rejects malformed, duplicate, remote-image and oversize scenes', () => {
    expect(() => parseBoardScene('{')).toThrow(/valid JSON/);
    expect(() => parseBoardScene({ elements: [rect('a'), rect('a')] })).toThrow(/Duplicate/);
    expect(() => parseBoardScene({ elements: [{ id: 'x', type: 'rectangle', version: 0 }] })).toThrow(/version/);
    expect(() => parseBoardScene({ elements: [], files: { f: { id: 'f', mimeType: 'image/png', dataURL: 'https://evil.example/a.png' } } })).toThrow(/embedded/);
    expect(() => parseBoardScene({ elements: [], files: { f: { id: 'f', mimeType: 'text/html', dataURL: 'data:text/html,<script>' } } })).toThrow(/unsupported/);
    expect(() => serializeBoardScene({ elements: [image('i', 'big')], files: { big: { id: 'big', mimeType: 'image/png', dataURL: `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}` } } })).toThrow(/too large/);
  });

  it('fingerprints content changes only, so selection and zoom never make a board dirty', () => {
    const a = scene([rect('a', 1)]);
    expect(boardSceneFingerprint({ ...a, appState: { ...a.appState, zoom: { value: 1 }, selectedElementIds: { a: true } } })).toBe(boardSceneFingerprint(a));
    expect(boardSceneFingerprint(scene([rect('a', 2)]))).not.toBe(boardSceneFingerprint(a));
    expect(boardSceneFingerprint(scene([rect('a', 1, { isDeleted: true })]))).not.toBe(boardSceneFingerprint(a));
  });

  it('rebases a draft onto a newer version by element id and reports concurrent edits', () => {
    const base = scene([rect('mine', 1), rect('theirs', 1), rect('both', 1)]);
    const draft = scene([rect('mine', 2), rect('theirs', 1), rect('both', 3), rect('new-mine', 1)]);
    const latest = scene([rect('mine', 1), rect('theirs', 4), rect('both', 2), rect('new-theirs', 1)]);
    const { scene: merged, conflicts } = rebaseBoardScene({ base, draft, latest });
    expect(Object.fromEntries(merged.elements.map(row => [row.id, row.version]))).toEqual({ mine: 2, theirs: 4, both: 3, 'new-theirs': 1, 'new-mine': 1 });
    expect(conflicts).toEqual(['both']);
  });

  it('restores an older version above the latest element versions with tombstones for newer elements', () => {
    const restored = restoreBoardScene({ target: scene([rect('a', 1)]), latest: scene([rect('a', 4), rect('b', 2)]) });
    const byId = Object.fromEntries(restored.elements.map(row => [row.id, row]));
    expect(byId.a.version).toBe(5);
    expect(byId.b).toMatchObject({ isDeleted: true, version: 3 });
  });

  it('exports a public scene separately without mutating the canonical one', () => {
    const canonical = scene([rect('a'), rect('gone', 2, { isDeleted: true })]);
    expect(exportPublicBoardScene(canonical).elements.map(row => row.id)).toEqual(['a']);
    expect(canonical.elements).toHaveLength(2);
  });

  it('recognises board Files for the Link existing board picker', () => {
    expect(isBoardFileRow({ pg_record_type: 'file', content_storage_content_type: BOARD_CONTENT_TYPE, title: 'Plan' })).toBe(true);
    expect(isBoardFileRow({ pg_record_type: 'file', title: 'Plan.excalidraw' })).toBe(true);
    expect(isBoardFileRow({ pg_record_type: 'file', title: 'Plan.html', content_type: 'text/html' })).toBe(false);
  });
});

describe('board runtime: Files and immutable versions through signed typed routes', () => {
  it('creates a private board File and saves immutable versions against a base', async () => {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context);
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'Roadmap' });
    expect(api.prepareTowerPgStorageObject).toHaveBeenCalledWith('workspace', expect.objectContaining({ content_type: BOARD_CONTENT_TYPE, owner_npub: context.viewer, file_name: 'Roadmap.excalidraw' }), expect.objectContaining({ baseUrl: 'https://tower.example', appNpub: 'app' }));
    expect(api.prepareTowerPgStorageObject.mock.calls[0][1].is_public).toBeUndefined();
    expect(api.createTowerPgChannelFile).toHaveBeenCalledWith('workspace', uuid(50), expect.objectContaining({ display_name: 'Roadmap.excalidraw', metadata: { kind: 'excalidraw_board', title: 'Roadmap' } }), expect.anything());
    const first = tower.meta(board.file_id);
    const { version } = await runtime.saveVersion({ fileId: board.file_id, baseVersionId: first.current_version_id, scene: scene([rect('a')]), summary: 'add box' });
    expect(version.version_number).toBe(2);
    expect(api.createTowerPgFileVersion).toHaveBeenCalledWith('workspace', board.file_id, expect.objectContaining({ base_version_id: first.current_version_id, summary: 'add box' }), expect.anything());
    const loaded = await runtime.readVersion(board.file_id, first.current_version_id, { sha256: first.sha256 });
    expect(loaded.scene.elements).toEqual([]);
    const { versions } = await runtime.listVersions(board.file_id);
    expect(versions.map(row => [row.version_number, row.summary])).toEqual([[2, 'add box'], [1, '']]);
  });

  it('rejects a stale base with a typed error carrying the current version', async () => {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context);
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'Race' });
    const base = tower.meta(board.file_id).current_version_id;
    await tower.publishAs('npub1agent', board.file_id, scene([rect('agent')]), base);
    const error = await runtime.saveVersion({ fileId: board.file_id, baseVersionId: base, scene: scene([rect('me')]) }).catch(caught => caught);
    expect(error).toBeInstanceOf(BoardStaleError);
    expect(error.currentVersion.version_number).toBe(2);
  });

  it('refuses digest mismatches and keeps scene bytes out of Dexie', async () => {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context);
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'Integrity' });
    const meta = tower.meta(board.file_id);
    await expect(runtime.readVersion(board.file_id, meta.current_version_id, { sha256: 'f'.repeat(64) })).rejects.toThrow(/integrity/);
    expect(await getWorkspaceDb().canvas_board_drafts.count()).toBe(0);
  });
});

describe('board controller: shared draft, explicit save, refresh and history', () => {
  async function setup({ initial = scene([rect('a')]) } = {}) {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context);
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'Plan', scene: initial });
    const states = [];
    const confirm = vi.fn(() => true);
    const controller = new BoardController(runtime, board.file_id, { onState: (_id, state) => states.push(state), confirmDiscard: confirm, writerId: 'page-1' });
    const inline = [], fullscreen = [];
    // Editors answer Save's flush request like the real iframe does.
    const editor = (id, sink) => message => { sink.push(message); if (message.type === 'flush') queueMicrotask(() => controller.editorFlushed(id, message.token)); };
    controller.attach('naplet-1', editor('naplet-1', inline));
    controller.attach('naplet-2', editor('naplet-2', fullscreen));
    await controller.sync(tower.meta(board.file_id));
    await settle();
    return { tower, runtime, board, controller, states, inline, fullscreen, confirm, state: () => controller.state };
  }

  it('loads the latest version into every attached editor and starts clean', async () => {
    const { inline, fullscreen, state } = await setup();
    expect(state()).toMatchObject({ status: 'ready', dirty: false, save_state: 'saved', base_version_number: 1 });
    expect(inline.at(-1)).toMatchObject({ type: 'load', readOnly: false });
    expect(inline.at(-1).scene.elements[0].id).toBe('a');
    expect(fullscreen.at(-1).key).toBe(inline.at(-1).key);
  });

  it('keeps one draft for inline and full-screen editors, persists it locally and never autosaves', async () => {
    const { controller, inline, fullscreen, state, board } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    expect(state()).toMatchObject({ dirty: true, save_state: 'unsaved' });
    expect(fullscreen.at(-1)).toMatchObject({ type: 'patch' });
    expect(fullscreen.at(-1).scene.elements[0].version).toBe(2);
    expect(inline.filter(row => row.type === 'patch')).toHaveLength(0);
    const draft = await controller.runtime.getDraft(board.file_id);
    expect(draft).toMatchObject({ base_version_id: state().base_version_id, file_id: board.file_id });
    expect(api.createTowerPgFileVersion).not.toHaveBeenCalled();
  });

  it('Save creates an immutable version, advances latest and clears the draft', async () => {
    const { controller, tower, board, state } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 2), text('t', 'hello')]));
    expect(await controller.save({ summary: 'add text' })).toBe(true);
    expect(state()).toMatchObject({ dirty: false, save_state: 'saved', base_version_number: 2, latest_version_number: 2 });
    expect(tower.files.get(board.file_id).versions).toHaveLength(2);
    expect(tower.files.get(board.file_id).versions[0].sha256_hex).not.toBe(tower.files.get(board.file_id).versions[1].sha256_hex);
    expect(await controller.runtime.getDraft(board.file_id)).toBeUndefined();
    expect(await controller.save()).toBe(false);
    expect(state().notice).toBe('No unsaved changes.');
  });

  it('a stale save is rejected without losing the draft; merge rebases it for review', async () => {
    const { controller, tower, board, state } = await setup();
    const base = state().base_version_id;
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    await tower.publishAs('npub1agent', board.file_id, scene([rect('a', 1), rect('agent', 1)]), base);
    expect(await controller.save()).toBe(false);
    expect(state()).toMatchObject({ save_state: 'stale', dirty: true, latest_version_number: 2, newer_available: true });
    expect((await controller.runtime.getDraft(board.file_id)).scene.elements[0].version).toBe(2);
    await controller.mergeLatest();
    expect(state()).toMatchObject({ dirty: true, save_state: 'unsaved', base_version_number: 2, conflicts: 0 });
    expect(controller.working.elements.map(row => row.id).sort()).toEqual(['a', 'agent']);
    expect(await controller.save()).toBe(true);
    expect(tower.files.get(board.file_id).versions).toHaveLength(3);
  });

  it('refresh loads a newer saved version when clean but never replaces a dirty draft silently', async () => {
    const { controller, tower, board, state, inline, confirm } = await setup();
    await tower.publishAs('npub1agent', board.file_id, scene([rect('a', 1), rect('b', 1)]), state().base_version_id);
    await controller.sync(tower.meta(board.file_id));
    expect(state()).toMatchObject({ base_version_number: 2, dirty: false });
    expect(inline.at(-1).scene.elements.map(row => row.id)).toEqual(['a', 'b']);
    await controller.editorChanged('naplet-1', scene([rect('a', 9)]));
    await tower.publishAs('npub1agent', board.file_id, scene([rect('c', 1)]), tower.meta(board.file_id).current_version_id);
    await controller.sync(tower.meta(board.file_id));
    expect(state()).toMatchObject({ base_version_number: 2, latest_version_number: 3, dirty: true, newer_available: true });
    confirm.mockReturnValueOnce(false);
    expect(await controller.loadLatest()).toBe(false);
    expect(state().dirty).toBe(true);
    expect(await controller.loadLatest()).toBe(true);
    expect(state()).toMatchObject({ dirty: false, base_version_number: 3 });
  });

  it('restores an unsaved draft after reload and keeps the original base', async () => {
    const { controller, runtime, board, tower } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 4)]));
    controller.stop();
    const reopened = new BoardController(runtime, board.file_id, { writerId: 'page-2' });
    const editor = [];
    reopened.attach('naplet-9', message => editor.push(message));
    await reopened.sync(tower.meta(board.file_id));
    expect(reopened.state).toMatchObject({ dirty: true, save_state: 'unsaved', notice: expect.stringMatching(/restored/) });
    expect(editor.at(-1).scene.elements[0].version).toBe(4);
  });

  it('preserves embedded images across save and reload', async () => {
    const { controller, board, tower, runtime } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a'), image('img', 'file-1')], { 'file-1': { id: 'file-1', mimeType: 'image/png', dataURL: PNG } }));
    await controller.save();
    runtime.scenes.clear();
    const fresh = new BoardController(runtime, board.file_id, { writerId: 'page-3' });
    const editor = [];
    fresh.attach('n', message => editor.push(message));
    await fresh.sync(tower.meta(board.file_id));
    expect(editor.at(-1).scene.files['file-1'].dataURL).toBe(PNG);
  });

  it('browses history read-only, returns to latest and restores an old version as a draft', async () => {
    const { controller, inline, state } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 2), rect('b', 1)]));
    await controller.save();
    await controller.loadVersions();
    expect(state().versions.map(row => row.version_number)).toEqual([2, 1]);
    await controller.stepVersion(-1);
    expect(state()).toMatchObject({ viewing_version_number: 1 });
    expect(inline.at(-1)).toMatchObject({ type: 'load', readOnly: true });
    await controller.editorChanged('naplet-1', scene([rect('zzz', 1)]));
    expect(state().dirty).toBe(false);
    expect(await controller.save()).toBe(false);
    controller.returnToLatest();
    expect(inline.at(-1)).toMatchObject({ type: 'load', readOnly: false });
    await controller.stepVersion(-1);
    await controller.restoreViewedVersion();
    expect(state()).toMatchObject({ dirty: true, save_state: 'unsaved', viewing_version_id: '' });
    expect(controller.working.elements.find(row => row.id === 'b')).toMatchObject({ isDeleted: true });
  });

  it('explicit refresh loads Tower head even when canvas metadata is stale', async () => {
    const { controller, tower, board, state } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    await tower.publishAs('npub1agent', board.file_id, scene([rect('agent', 1)]), state().base_version_id);
    expect(await controller.save()).toBe(false);
    await tower.publishAs('npub1agent', board.file_id, scene([rect('agent', 2)]), tower.meta(board.file_id).current_version_id);
    // The snapshot metadata the controller holds still says v1; Tower is at v3.
    expect(controller.meta.current_version_number).toBe(1);
    expect(await controller.loadLatest()).toBe(true);
    expect(state()).toMatchObject({ dirty: false, base_version_number: 3, latest_version_number: 3 });
    expect(controller.working.elements[0]).toMatchObject({ id: 'agent', version: 2 });
  });

  it('history reports the real head; returning keeps a dirty draft and loads a newer head when clean', async () => {
    const { controller, tower, board, state, inline } = await setup();
    await tower.publishAs('npub1agent', board.file_id, scene([rect('agent', 1)]), state().base_version_id);
    await controller.loadVersions();
    expect(state()).toMatchObject({ latest_version_number: 2, base_version_number: 1 });
    await controller.viewVersion(state().versions.find(row => row.version_number === 1).id);
    await controller.returnToLatest();
    expect(state()).toMatchObject({ base_version_number: 2, dirty: false });
    expect(inline.at(-1).scene.elements[0].id).toBe('agent');
    await controller.editorChanged('naplet-1', scene([rect('agent', 5)]));
    await tower.publishAs('npub1other', board.file_id, scene([rect('other', 1)]), tower.meta(board.file_id).current_version_id);
    await controller.loadVersions();
    await controller.viewVersion(state().versions.find(row => row.version_number === 1).id);
    await controller.returnToLatest();
    expect(state()).toMatchObject({ dirty: true, base_version_number: 2, latest_version_number: 3, newer_available: true });
    expect(inline.at(-1).scene.elements[0]).toMatchObject({ id: 'agent', version: 5 });
  });

  it('Save first flushes the editor debounce so the last stroke is included', async () => {
    const { controller, tower, board } = await setup();
    controller.detach('naplet-1');
    controller.attach('naplet-1', message => {
      if (message.type !== 'flush') return;
      // The iframe sends its pending change, then acknowledges, on one ordered port.
      void controller.editorChanged('naplet-1', scene([rect('a', 2), rect('last-stroke', 1)]));
      controller.editorFlushed('naplet-1', message.token);
    });
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    expect(await controller.save()).toBe(true);
    const saved = await controller.runtime.readVersion(board.file_id, tower.meta(board.file_id).current_version_id);
    expect(saved.scene.elements.map(row => row.id)).toEqual(['a', 'last-stroke']);
  });

  it('an unresponsive editor blocks Save: no version POST, draft kept, retry works', async () => {
    const { controller, tower, board, runtime } = await setup();
    controller.flushTimeoutMs = 20;
    controller.detach('naplet-1');
    controller.attach('naplet-1', () => {}); // never acknowledges flush
    await controller.editorChanged('naplet-2', scene([rect('a', 2)]));
    const posts = api.createTowerPgFileVersion.mock.calls.length;
    expect(await controller.save()).toBe(false);
    expect(api.createTowerPgFileVersion.mock.calls.length).toBe(posts);
    expect(controller.state).toMatchObject({ dirty: true, save_state: 'error', base_version_number: 1 });
    expect(controller.state.error).toMatch(/try Save again/);
    expect((await runtime.getDraft(board.file_id)).scene.elements[0].version).toBe(2);
    // Detaching mid-flush settles the wait instead of hanging or publishing.
    controller.flushTimeoutMs = 60_000;
    const pending = controller.save();
    await settle();
    controller.detach('naplet-1');
    expect(await pending).toBe(false);
    expect(api.createTowerPgFileVersion.mock.calls.length).toBe(posts);
    expect(controller.state.save_state).toBe('error');
    // With only responsive editors left, the same draft saves.
    expect(await controller.save()).toBe(true);
    expect(tower.meta(board.file_id).current_version_number).toBe(2);
  });

  it('a delayed acknowledgement waits for the applied change before capturing the scene', async () => {
    const { controller, tower, board, runtime } = await setup();
    controller.detach('naplet-1');
    const putDraft = runtime.putDraft.bind(runtime);
    runtime.putDraft = async (...args) => { await new Promise(resolve => setTimeout(resolve, 15)); return putDraft(...args); };
    controller.attach('naplet-1', message => {
      if (message.type !== 'flush') return;
      setTimeout(() => {
        void controller.editorChanged('naplet-1', scene([rect('a', 3), rect('late', 1)]));
        controller.editorFlushed('naplet-1', message.token);
      }, 30);
    });
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    const posts = api.createTowerPgFileVersion.mock.calls.length;
    const saving = controller.save();
    expect(await controller.save()).toBe(false); // duplicate Save is ignored
    expect(await saving).toBe(true);
    expect(api.createTowerPgFileVersion.mock.calls.length).toBe(posts + 1);
    const saved = await runtime.readVersion(board.file_id, tower.meta(board.file_id).current_version_id);
    expect(saved.scene.elements.map(row => [row.id, row.version])).toEqual([['a', 3], ['late', 1]]);
    expect(controller.state).toMatchObject({ dirty: false, save_state: 'saved' });
  });

  it('bounds the in-memory scene cache by bytes', async () => {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context, { maxCacheBytes: 400 });
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'Cache', scene: scene([text('t', 'x'.repeat(300))]) });
    const first = tower.meta(board.file_id).current_version_id;
    const { version } = await runtime.saveVersion({ fileId: board.file_id, baseVersionId: first, scene: scene([text('t', 'y'.repeat(300), 2)]) });
    await runtime.readVersion(board.file_id, first);
    await runtime.readVersion(board.file_id, version.id);
    expect(runtime.scenes.size).toBe(1);
    expect([...runtime.scenes.keys()]).toEqual([`${board.file_id}:${version.id}`]);
    expect(runtime.cacheBytes).toBeLessThanOrEqual(runtime.scenes.get(`${board.file_id}:${version.id}`).bytes);
  });

  it('revoked access purges the local draft and cached bytes and clears editors', async () => {
    const { controller, tower, board, inline } = await setup();
    await controller.editorChanged('naplet-1', scene([rect('a', 2)]));
    tower.readable.value = false;
    expect(await controller.save()).toBe(false);
    expect(controller.state).toMatchObject({ status: 'denied', dirty: false });
    expect(await controller.runtime.getDraft(board.file_id)).toBeUndefined();
    expect(controller.runtime.scenes.size).toBe(0);
    expect(inline.at(-1)).toEqual({ type: 'clear' });
  });

  it('read-only viewers can look but cannot create a draft or save', async () => {
    const tower = fakeTower();
    const runtime = new CanvasBoardRuntime(context);
    const board = await runtime.createBoard({ channelId: uuid(50), title: 'View only', scene: scene([rect('a')]) });
    const controller = new BoardController(runtime, board.file_id, { writerId: 'p' });
    const editor = [];
    controller.attach('n', message => editor.push(message));
    await controller.sync(tower.meta(board.file_id, { can_write: false }));
    expect(editor.at(-1)).toMatchObject({ readOnly: true });
    await controller.editorChanged('n', scene([rect('a', 2)]));
    expect(controller.state.dirty).toBe(false);
  });
});

describe('canvas page board store', () => {
  it('creates a board then links the naplet; maps revoked naplets to a purge', async () => {
    const tower = fakeTower();
    const store = Object.assign({ naplets: [], error: '' }, canvasBoardStore());
    store.startBoards(context, { confirm: () => true });
    store.boardCreate = { title: 'Sprint', channelId: uuid(50), mode: 'create' };
    const addNaplet = vi.fn(async body => { store.naplets = [{ id: 'n1', access: 'ready', source: body.source, title: body.title, content: tower.meta(body.source.id), layout: body.layout }]; return true; });
    expect(await store.createBoardNaplet({ x: 1, y: 2, width: 600, height: 420, z: 1 }, addNaplet)).toBe(true);
    const fileId = addNaplet.mock.calls[0][0].source.id;
    expect(addNaplet.mock.calls[0][0]).toMatchObject({ source: { type: 'excalidraw', id: fileId }, title: 'Sprint' });
    store.syncBoards(store.naplets);
    await settle();
    expect(store.boards[fileId]).toMatchObject({ status: 'ready', base_version_number: 1 });
    expect(store.boardStatusLabel(store.naplets[0])).toBe('Saved');
    expect(store.boardVersionLabel(store.naplets[0])).toBe('Latest · v1');
    // Two naplets (or canvases) referencing one board share one controller.
    expect(store.boardController(fileId)).toBe(store.boardController(fileId));
    await store.boardController(fileId).editorChanged('x', scene([rect('q', 2)]));
    store.syncBoards([{ id: 'n1', access: 'denied', layout: {} }]);
    await settle();
    expect(await store.boardRuntime().getDraft(fileId)).toBeUndefined();
    store.stopBoards();
  });

  it('reports a saved-but-unlinked board when Tower rejects the naplet source', async () => {
    fakeTower();
    const store = Object.assign({ naplets: [], error: '' }, canvasBoardStore());
    store.startBoards(context, { confirm: () => true });
    store.boardCreate = { title: 'Orphan', channelId: uuid(50), mode: 'create' };
    const addNaplet = vi.fn(async () => { store.error = 'source_type is invalid'; return false; });
    expect(await store.createBoardNaplet({ x: 0, y: 0, width: 600, height: 420, z: 1 }, addNaplet)).toBe(false);
    expect(store.error).toMatch(/source_type is invalid.*“Orphan” was saved/);
    store.stopBoards();
  });
});


describe('board metadata rename', () => {
  it('patches only display_name, rejects blanks and reports failed or unconfirmed saves', async () => {
    const runtime = new CanvasBoardRuntime(context, { api, db: {} });
    const fileId = uuid(90);
    api.updateTowerPgFile.mockResolvedValue({ file: { id: fileId, display_name: 'Planning' } });
    expect(await runtime.renameBoard(fileId, '  Planning  ')).toBe('Planning');
    expect(api.updateTowerPgFile).toHaveBeenLastCalledWith(context.workspaceId, fileId, { display_name: 'Planning' }, expect.objectContaining({ baseUrl: context.baseUrl }));
    const calls = api.updateTowerPgFile.mock.calls.length;
    await expect(runtime.renameBoard(fileId, '   ')).rejects.toThrow('Enter a board name');
    expect(api.updateTowerPgFile).toHaveBeenCalledTimes(calls);
    api.updateTowerPgFile.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(runtime.renameBoard(fileId, 'Denied')).rejects.toThrow('Forbidden');
    api.updateTowerPgFile.mockResolvedValueOnce({ file: { id: fileId, display_name: 'Other' } });
    await expect(runtime.renameBoard(fileId, 'Planning')).rejects.toThrow('did not confirm');
  });
});
