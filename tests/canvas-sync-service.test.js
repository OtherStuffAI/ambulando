import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createTowerPgCanvas: vi.fn(),
  createTowerPgCanvasComment: vi.fn(),
  createTowerPgCanvasElement: vi.fn(),
  createTowerPgCanvasNaplet: vi.fn(),
  deleteTowerPgCanvasComment: vi.fn(),
  deleteTowerPgCanvasElement: vi.fn(),
  deleteTowerPgCanvasNaplet: vi.fn(),
  getTowerPgCanvases: vi.fn(),
  getTowerPgCanvasSnapshot: vi.fn(),
  getTowerPgFile: vi.fn(),
  reorderTowerPgCanvases: vi.fn(),
  updateTowerPgCanvas: vi.fn(),
  updateTowerPgCanvasComment: vi.fn(),
  updateTowerPgCanvasElement: vi.fn(),
  updateTowerPgCanvasNaplet: vi.fn(),
}));

vi.mock('../src/api.js', () => api);

import { getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { canvasDefinitionKey, normalizeCanvasSnapshot } from '../src/canvas/projection.js';
import { CanvasSyncRuntime } from '../src/canvas/sync-service.js';

const context = {
  baseUrl: 'https://tower.example',
  tower: 'tower',
  service: 'service',
  workspaceId: 'workspace',
  appNpub: 'app',
  viewer: 'reader',
  actorId: 'actor',
  dbKey: 'db',
};
const identity = { workspace_id: 'workspace', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' };
const payload = (rowVersion, title = 'Current') => ({
  workspace_id: 'workspace',
  identity,
  complete: true,
  canvas: { id: 'canvas', title, position: 1, row_version: rowVersion, can_manage: true, visibility: { mode: 'workspace' }, viewport: { x: 0, y: 0, scale: 1 } },
  naplets: [],
});

afterEach(async () => {
  vi.clearAllMocks();
  try { await getWorkspaceDb().delete(); } catch {}
});

it('does not publish a cached Canvas projection before a fresh signed hydration succeeds', async () => {
  const db = openWorkspaceDb(`canvas-sync-${crypto.randomUUID()}`);
  await db.open();
  await db.canvas_snapshots.put(normalizeCanvasSnapshot(payload(1, 'Stale'), context, 'canvas', 'old-request'));
  let resolveHydration;
  api.getTowerPgCanvasSnapshot.mockReturnValue(new Promise(resolve => { resolveHydration = resolve; }));
  const seen = [];
  const runtime = new CanvasSyncRuntime(context, 'canvas', { onSnapshot: snapshot => seen.push(snapshot.canvas.title) });
  runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(seen).toEqual([]);
  resolveHydration(payload(2, 'Fresh'));
  await vi.waitFor(() => expect(seen).toContain('Fresh'));
  expect(await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).toMatchObject({ canvas: { title: 'Fresh', row_version: 2 } });
  runtime.stop();
});

it('serializes Canvas mutations and rehydrates each accepted row version through Dexie', async () => {
  const db = openWorkspaceDb(`canvas-sync-cas-${crypto.randomUUID()}`);
  await db.open();
  let serverVersion = 1;
  api.getTowerPgCanvasSnapshot.mockImplementation(async () => payload(serverVersion));
  api.updateTowerPgCanvas.mockImplementation(async (_workspaceId, _canvasId, body) => {
    expect(body.expected_row_version).toBe(serverVersion);
    serverVersion += 1;
    return { canvas: payload(serverVersion).canvas };
  });
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  runtime.start();
  await vi.waitFor(async () => expect((await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas')))?.canvas?.row_version).toBe(1));
  await Promise.all([
    runtime.updateViewport({ x: 10, y: 0, scale: 1 }),
    runtime.updateViewport({ x: 20, y: 0, scale: 1 }),
  ]);
  expect(api.updateTowerPgCanvas.mock.calls.map(call => call[2].expected_row_version)).toEqual([1, 2]);
  expect((await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).canvas.row_version).toBe(3);
  runtime.stop();
});

it('queues the complete Canvas projection before IndexedDB can auto-commit the transaction', async () => {
  const db = openWorkspaceDb(`canvas-sync-transaction-${crypto.randomUUID()}`);
  await db.open();
  api.getTowerPgCanvasSnapshot.mockResolvedValue(payload(1, 'Atomic'));

  const putSnapshot = db.canvas_snapshots.put.bind(db.canvas_snapshots);
  const putDefinition = db.canvas_definitions.put.bind(db.canvas_definitions);
  let releaseSnapshotWrite;
  vi.spyOn(db.canvas_snapshots, 'put').mockImplementation(snapshot => {
    const queuedWrite = putSnapshot(snapshot);
    const schedulingGap = new Promise(resolve => {
      releaseSnapshotWrite = resolve;
      setTimeout(resolve, 0);
    });
    return Dexie.Promise.all([queuedWrite, schedulingGap]).then(([key]) => key);
  });
  vi.spyOn(db.canvas_definitions, 'put').mockImplementation(definition => {
    releaseSnapshotWrite?.();
    return putDefinition(definition);
  });

  const runtime = new CanvasSyncRuntime(context, 'canvas');
  await expect(runtime.refresh()).resolves.toMatchObject({ canvas: { title: 'Atomic' } });
  expect(await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).toMatchObject({
    canvas: { title: 'Atomic' },
  });
  expect(await db.canvas_definitions.get(canvasDefinitionKey(context, 'canvas'))).toMatchObject({
    title: 'Atomic',
  });
  runtime.stop();
});

it('aborts the atomic projection when the refresh generation changes during commit', async () => {
  const db = openWorkspaceDb(`canvas-sync-generation-${crypto.randomUUID()}`);
  await db.open();
  api.getTowerPgCanvasSnapshot.mockResolvedValue(payload(1, 'Superseded'));

  const runtime = new CanvasSyncRuntime(context, 'canvas');
  const putDefinition = db.canvas_definitions.put.bind(db.canvas_definitions);
  vi.spyOn(db.canvas_definitions, 'put').mockImplementation(definition => {
    runtime.stop();
    return putDefinition(definition);
  });

  await expect(runtime.refresh()).resolves.toBeNull();
  expect(await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).toBeUndefined();
  expect(await db.canvas_definitions.get(canvasDefinitionKey(context, 'canvas'))).toBeUndefined();
});


it('deletes using the confirmed revision and reply set, rehydrates Dexie, and refuses unauthorized actions', async () => {
  const db = openWorkspaceDb(`canvas-comments-${crypto.randomUUID()}`); await db.open();
  const source = { ...payload(1), comments: [{ id: 'root', anchor: { type: 'canvas', x: 30, y: 40 }, body: 'Root', author: { actor_id: 'actor' }, row_version: 3, can_delete: true, can_retarget: true, retarget_preserves_position: true }] };
  api.getTowerPgCanvasSnapshot.mockResolvedValue(source);
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  await runtime.refresh();
  await runtime.retargetComment('root', { type: 'canvas', x: 50, y: 60 });
  expect(api.updateTowerPgCanvasComment).toHaveBeenCalledWith('workspace', 'canvas', 'root', { anchor: { type: 'canvas', x: 50, y: 60 }, expected_row_version: 3 }, expect.any(Object));
  api.getTowerPgCanvasSnapshot.mockResolvedValue(payload(1));
  await runtime.deleteComment('root', { expected_row_version: 2, expected_reply_versions: { reply: 4 } });
  expect(api.deleteTowerPgCanvasComment).toHaveBeenCalledWith('workspace', 'canvas', 'root', { expected_row_version: 2, expected_reply_versions: { reply: 4 } }, expect.any(Object));
  expect((await db.canvas_snapshots.get(runtime.key)).comments).toEqual([]);
  await expect(runtime.deleteComment('root', {})).rejects.toThrow('cannot delete');
  await expect(runtime.retargetComment('root', {})).rejects.toThrow('cannot change');
  runtime.stop();
});


it('hydrates one canonical File title for repeated board naplets and persists it in the snapshot', async () => {
  const db = openWorkspaceDb(`canvas-board-title-${crypto.randomUUID()}`); await db.open();
  const fileId = '10000000-0000-4000-8000-000000000001';
  const raw = payload(1);
  raw.naplets = [1, 2].map(n => ({ id: `naplet-${n}`, access: 'ready', title: 'Legacy override', source: { type: 'excalidraw', id: fileId }, content: { file_id: fileId, can_write: true }, row_version: 1, layout: { x: 0, y: 0, width: 640, height: 480, z: n } }));
  api.getTowerPgCanvasSnapshot.mockResolvedValue(raw);
  api.getTowerPgFile.mockResolvedValue({ file: { id: fileId, display_name: 'Renamed' } });
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  const snapshot = await runtime.refresh();
  expect(snapshot.naplets.map(row => row.title)).toEqual(['Renamed', 'Renamed']);
  expect(api.getTowerPgFile).toHaveBeenCalledTimes(1);
  expect((await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas'))).naplets.map(row => row.title)).toEqual(['Renamed', 'Renamed']);
  runtime.stop();
});


it.each([403, 404, 503])('isolates a failed board title lookup (%s) without retaining restricted metadata or blanking unrelated naplets', async status => {
  const db = openWorkspaceDb(`canvas-board-title-failure-${crypto.randomUUID()}`); await db.open();
  const fileId = '10000000-0000-4000-8000-000000000002';
  const raw = payload(1);
  const layout = { x: 0, y: 0, width: 640, height: 480, z: 1 };
  raw.naplets = [
    { id: 'board', access: 'ready', title: 'Secret board', source: { type: 'excalidraw', id: fileId }, content: { file_id: fileId, can_write: true }, row_version: 1, layout },
    { id: 'doc', access: 'ready', title: 'Useful document', source: { type: 'document', id: 'doc-id' }, content: { title: 'Useful document', body: 'Keep visible' }, row_version: 1, layout },
  ];
  api.getTowerPgCanvasSnapshot.mockResolvedValue(raw);
  api.getTowerPgFile.mockRejectedValue(Object.assign(new Error('Failed'), { status }));
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  const snapshot = await runtime.refresh();
  expect(runtime.authorized).toBe(true);
  expect(snapshot.naplets[0]).toEqual({ id: 'board', access: 'denied', layout, row_version: 1 });
  expect(snapshot.naplets[1]).toMatchObject({ title: 'Useful document', content: { body: 'Keep visible' } });
  expect(JSON.stringify(await db.canvas_snapshots.get(canvasDefinitionKey(context, 'canvas')))).not.toContain('Secret board');
  api.getTowerPgFile.mockResolvedValue({ file: { id: fileId, display_name: 'Recovered' } });
  expect((await runtime.refresh()).naplets[0]).toMatchObject({ title: 'Recovered', access: 'ready' });
  runtime.stop();
});

it('persists canvas references without destination snapshot reads and removes revoked metadata', async () => {
  const db = openWorkspaceDb(`canvas-link-${crypto.randomUUID()}`); await db.open();
  let naplets = [];
  api.getTowerPgCanvasSnapshot.mockImplementation(async () => ({ ...payload(1), naplets }));
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  await runtime.refresh();
  api.createTowerPgCanvasNaplet.mockImplementation(async (_workspace, _canvas, body) => {
    naplets = [{ id: 'link', access: 'ready', source: body.source, title: body.title, content: { title: 'Destination', thumbnail: 'discard.png' }, layout: body.layout, row_version: 1 }];
  });
  const body = { source: { type: 'canvas', id: 'destination' }, title: 'Overview', layout: { x: 10, y: 10, width: 380, height: 280, z: 1 } };
  await runtime.addNaplet(body);
  expect(api.createTowerPgCanvasNaplet).toHaveBeenCalledWith('workspace', 'canvas', body, expect.any(Object));
  expect((await db.canvas_snapshots.get(runtime.key)).naplets[0]).toMatchObject({ title: 'Overview', content: { title: 'Destination' } });
  expect(api.getTowerPgCanvasSnapshot.mock.calls.every(args => args[1] === 'canvas')).toBe(true);
  naplets = [{ ...naplets[0], access: 'denied' }]; await runtime.refresh();
  expect((await db.canvas_snapshots.get(runtime.key)).naplets[0]).not.toHaveProperty('source');
  runtime.stop();
});

it('orders a delayed pre-save refresh, overlapping saves and refreshes without stale CAS versions', async () => {
  const db = openWorkspaceDb(`canvas-sync-overlap-${crypto.randomUUID()}`); await db.open();
  let serverVersion = 1, viewport = { x: 0, y: 0, scale: 1 }, release;
  api.getTowerPgCanvasSnapshot.mockImplementation(async () => ({ ...payload(serverVersion), canvas: { ...payload(serverVersion).canvas, viewport } }));
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  await runtime.refresh();
  api.getTowerPgCanvasSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(payload(1)); }));
  const oldRead = runtime.refresh();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  api.updateTowerPgCanvas.mockImplementation(async (_w, _c, body) => {
    expect(body.expected_row_version).toBe(serverVersion);
    serverVersion++; viewport = body.viewport;
  });
  const first = runtime.updateViewport({ x: 100, y: 10, scale: 1 });
  const refresh = runtime.refresh();
  const second = runtime.updateViewport({ x: 250, y: 40, scale: 1.5 });
  expect(api.updateTowerPgCanvas).not.toHaveBeenCalled();
  release();
  await Promise.all([oldRead, first, refresh, second]);
  expect(api.updateTowerPgCanvas.mock.calls.map(call => call[2].expected_row_version)).toEqual([1, 2]);
  expect((await db.canvas_snapshots.get(runtime.key)).canvas.viewport).toEqual(viewport);
  expect(viewport.x).toBe(250);
  runtime.stop();
});

it('rebases layout field changes on refreshed task-tree metadata and refuses revoked naplets', async () => {
  const db = openWorkspaceDb(`canvas-sync-layout-${crypto.randomUUID()}`); await db.open();
  const source = { ...payload(1), naplets: [{ id: 'tree', access: 'ready', row_version: 3, title: 'Tree', source: { type: 'task_tree', id: 'scope' }, layout: { x: 1, y: 2, width: 300, height: 200, z: 4, task_tree: { instance_id: '60000000-0000-4000-8000-000000000001' } }, content: {} }] };
  api.getTowerPgCanvasSnapshot.mockResolvedValue(source);
  const runtime = new CanvasSyncRuntime(context, 'canvas'); await runtime.refresh();
  await runtime.updateNapletLayout('tree', { width: 500 });
  expect(api.updateTowerPgCanvasNaplet.mock.calls.at(-1)[3]).toMatchObject({ layout: { x: 1, width: 500, z: 4, task_tree: { instance_id: '60000000-0000-4000-8000-000000000001' } }, expected_row_version: 3 });
  source.naplets[0].access = 'denied'; await runtime.refresh();
  await expect(runtime.updateNapletLayout('tree', { width: 600 })).rejects.toThrow('authorization');
  runtime.stop();
});

it('does not let a queued refresh reauthorize a stopped canvas', async () => {
  const db = openWorkspaceDb(`canvas-sync-stop-${crypto.randomUUID()}`); await db.open();
  let release;
  api.getTowerPgCanvasSnapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const runtime = new CanvasSyncRuntime(context, 'canvas');
  const active = runtime.refresh();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const queued = runtime.refresh();
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  runtime.stop(); release(payload(1));
  await expect(active).resolves.toBeNull(); await rejected;
  expect(api.getTowerPgCanvasSnapshot).toHaveBeenCalledTimes(1);
  expect(runtime.authorized).toBe(false);
});
