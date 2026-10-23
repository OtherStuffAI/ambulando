import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sync = vi.hoisted(() => ({ createCanvasRecord: vi.fn(), hydrateCanvasList: vi.fn(), reorderCanvasRecords: vi.fn(), updateCanvasRecord: vi.fn() }));
vi.mock('../src/canvas/sync-service.js', () => sync);
import { attachCanvasLinkCreation } from '../src/canvas/link-create.js';
const context = { workspaceId: 'workspace', appNpub: 'app', tower: 'tower', service: 'service', viewer: 'viewer', dbKey: 'db' };
const identity = { workspace_id: 'workspace', app_npub: 'app', tower_service_npub: 'tower', workspace_service_npub: 'service' };
let storage;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('sessionStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
  vi.stubGlobal('document', { getElementById: () => ({ close: vi.fn() }) });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
function makeStore() {
  const store = attachCanvasLinkCreation({ context: () => context, canvasId: 'original', canvas: { can_manage: true }, addDialog: { type: 'canvas', sourceId: 'previous', title: 'Draft label', point: { x: 95, y: 150 } }, sourceSearch: 'Previous search', sourceOptions: [{ type: 'document', id: 'doc', title: 'Document' }] });
  store.canvasDialog = { title: 'New canvas', visibilityMode: 'restricted', actorIds: ['actor-2'], groupIds: ['group-1'] };
  return store;
}
it('selects the accepted canvas through refreshed visibility while preserving the pending link draft', async () => {
  const store = makeStore();
  sync.createCanvasRecord.mockImplementation(async (_context, body, options) => { options.onCreated({ identity, workspace_id: 'workspace', canvas: { id: 'new' } }); return [{ canvas_id: 'new', title: body.title }]; });
  await store.saveCanvasDialog();
  expect(sync.createCanvasRecord).toHaveBeenCalledWith(context, { title: 'New canvas', visibility: { mode: 'restricted', actor_ids: ['actor-2'], group_ids: ['group-1'] } }, expect.any(Object));
  expect(store.addDialog).toEqual({ type: 'canvas', sourceId: 'new', title: 'Draft label', point: { x: 95, y: 150 } });
  expect(store.sourceSearch).toBe('Previous search'); expect(store.canvasCreateAttempt).toBeNull();
});
it('retries only hydration after an accepted creation and failed list read', async () => {
  const store = makeStore();
  sync.createCanvasRecord.mockImplementation(async (_context, _body, options) => { options.onCreated({ identity, workspace_id: 'workspace', canvas: { id: 'new' } }); throw new Error('List unavailable'); });
  await store.saveCanvasDialog(); expect(store.canvasDialogError).toContain('List unavailable');
  sync.hydrateCanvasList.mockResolvedValue([{ canvas_id: 'new', title: 'New canvas' }]);
  await store.saveCanvasDialog(); expect(sync.createCanvasRecord).toHaveBeenCalledTimes(1); expect(store.addDialog.sourceId).toBe('new');
});
it('permits correction/retry after a definitive rejection and prevents overlapping creation', async () => {
  const store = makeStore(); let reject;
  sync.createCanvasRecord.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const sending = store.saveCanvasDialog(); await store.saveCanvasDialog(); expect(sync.createCanvasRecord).toHaveBeenCalledTimes(1);
  reject(Object.assign(new Error('Access denied'), { status: 403 })); await sending;
  expect(store.canvasCreateAttempt).toBeNull(); expect(store.canvasDialogError).toContain('Access denied'); expect(store.canvasDialogCanSave).toBe(true);
});
it('persists an uncertain send across reload and checks rather than re-posting or guessing a same-title canvas', async () => {
  const store = makeStore(); sync.createCanvasRecord.mockRejectedValue(new Error('Connection lost'));
  await store.saveCanvasDialog();
  const next = makeStore(); next.canvasCreateAttempt = JSON.parse([...storage.values()][0]);
  sync.hydrateCanvasList.mockResolvedValue([{ canvas_id: 'maybe', title: 'New canvas' }]);
  await next.saveCanvasDialog(); expect(sync.createCanvasRecord).toHaveBeenCalledTimes(1);
  expect(next.addDialog.sourceId).toBe('previous'); expect(next.canvasLinkNotice).toContain('Choose the canvas');
});
it('refuses creation without parent management and does not select a created canvas absent from the fresh list', async () => {
  const store = makeStore(); store.canvas.can_manage = false; await store.saveCanvasDialog(); expect(sync.createCanvasRecord).not.toHaveBeenCalled();
  store.canvas.can_manage = true;
  sync.createCanvasRecord.mockImplementation(async (_context, _body, options) => { options.onCreated({ identity, workspace_id: 'workspace', canvas: { id: 'denied' } }); return []; });
  await store.saveCanvasDialog(); expect(store.canvasDialogError).toContain('not visible'); expect(store.addDialog.sourceId).toBe('previous');
});
it('keeps accepted results and in-memory recovery when browser storage throws', async () => {
  vi.stubGlobal('sessionStorage', { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('disabled'); } });
  const store = makeStore();
  sync.createCanvasRecord.mockImplementation(async (_context, _body, options) => { options.onCreated({ identity, workspace_id: 'workspace', canvas: { id: 'new' } }); return [{ canvas_id: 'new', title: 'New canvas' }]; });
  await store.saveCanvasDialog(); expect(store.addDialog.sourceId).toBe('new'); expect(store.canvasDialogError).toBe(''); expect(store.canvasAttemptPersistenceError).toBe(true);
  sync.createCanvasRecord.mockRejectedValue(new Error('lost'));
  await store.saveCanvasDialog(); expect(store.canvasCreateAttempt).not.toBeNull(); expect(store.canvasDialogError).toContain('Keep this tab open');
});
