import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createTowerPgCanvas: vi.fn(),
  createTowerPgCanvasComment: vi.fn(),
  createTowerPgCanvasElement: vi.fn(),
  createTowerPgCanvasNaplet: vi.fn(),
  deleteTowerPgCanvasElement: vi.fn(),
  deleteTowerPgCanvasNaplet: vi.fn(),
  getTowerPgCanvases: vi.fn(),
  getTowerPgCanvasSnapshot: vi.fn(),
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
