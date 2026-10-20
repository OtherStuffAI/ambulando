import { afterEach, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({
  createCanvasRecord: vi.fn(),
  hydrateCanvasList: vi.fn(),
  reorderCanvasRecords: vi.fn(),
  updateCanvasRecord: vi.fn(),
}));

vi.mock('../src/canvas/sync-service.js', () => sync);

import { canvasManagerMixin } from '../src/canvas/manager.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('opens Canvas create and settings dialogs through Alpine nextTick from the store', () => {
  const showModal = vi.fn();
  const nextTick = vi.fn(callback => callback());
  vi.stubGlobal('Alpine', { nextTick });
  vi.stubGlobal('document', { getElementById: vi.fn(() => ({ showModal })) });
  const store = Object.assign(Object.create(canvasManagerMixin), {});

  store.openCanvasCreateDialog();
  expect(store.canvasDialog.mode).toBe('create');
  expect(nextTick).toHaveBeenCalledOnce();
  expect(showModal).toHaveBeenCalledOnce();

  store.openCanvasSettingsDialog({
    canvas_id: 'canvas', row_version: 3, title: 'Planning', can_manage: true,
    visibility: { mode: 'workspace', actor_ids: [], group_ids: [] },
  });
  expect(store.canvasDialog).toMatchObject({ mode: 'edit', id: 'canvas', rowVersion: 3, title: 'Planning' });
  expect(nextTick).toHaveBeenCalledTimes(2);
  expect(showModal).toHaveBeenCalledTimes(2);
});

it('sends the selected list row version when renaming or changing Canvas visibility', async () => {
  const close = vi.fn();
  vi.stubGlobal('document', { getElementById: vi.fn(() => ({ close })) });
  sync.updateCanvasRecord.mockResolvedValue([]);
  const store = Object.assign(Object.create(canvasManagerMixin), {
    currentWorkspace: {
      workspaceId: 'workspace',
      workspaceOwnerNpub: 'owner',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'app',
      pgBackendMode: true,
    },
    currentWorkspaceKey: 'db',
    currentViewerNpub: 'reader',
    currentPgActorId: 'actor',
    session: { npub: 'reader' },
    canvasDialog: {
      open: true,
      mode: 'edit',
      id: 'canvas',
      rowVersion: 7,
      title: 'Renamed canvas',
      visibilityMode: 'restricted',
      actorIds: ['actor-2'],
      groupIds: ['group-1'],
    },
  });

  await store.saveCanvasDialog();

  expect(sync.updateCanvasRecord).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace' }), 'canvas', {
    title: 'Renamed canvas',
    visibility: { mode: 'restricted', actor_ids: ['actor-2'], group_ids: ['group-1'] },
    expected_row_version: 7,
  });
  expect(close).toHaveBeenCalledOnce();
});
