import { afterEach, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({
  createCanvasRecord: vi.fn(),
  hydrateCanvasList: vi.fn(),
  reorderCanvasRecords: vi.fn(),
  updateCanvasRecord: vi.fn(),
}));

vi.mock('../src/canvas/sync-service.js', () => sync);

import { buildCanvasPrincipalOptions, canvasManagerMixin, truncateCanvasIdentity } from '../src/canvas/manager.js';

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

it('builds one readable mixed-principal search index with kind labels and safe fallbacks', () => {
  const fullNpub = `npub1${'a'.repeat(58)}`;
  const options = buildCanvasPrincipalOptions({
    members: [
      { actor_id: 'person-1', npub: 'npub-person', kind: 'human', display_name: 'Avery Stone', role: 'owner' },
      { actor_id: 'agent-1', npub: 'npub-agent', kind: 'agent', display_name: 'Research agent' },
      { actor_id: 'person-2', npub: fullNpub, kind: 'human', display_name: fullNpub },
      { actor_id: 'person-1', npub: 'duplicate', display_name: 'Duplicate row' },
    ],
    groups: [{ group_id: 'group-1', name: 'Delivery team', member_npubs: ['one', 'two'] }],
    getSenderName: npub => npub === fullNpub ? fullNpub : '',
    getSenderAvatar: npub => npub === 'npub-person' ? '/avatar.png' : '',
  });

  expect(options.map(option => [option.key, option.kindLabel])).toEqual([
    ['actor:person-1', 'Person'],
    ['group:group-1', 'Group'],
    ['actor:agent-1', 'Agent'],
    ['actor:person-2', 'Person'],
  ]);
  expect(options.find(option => option.id === 'person-1')).toMatchObject({ label: 'Avery Stone', subtitle: 'owner', avatarUrl: '/avatar.png' });
  expect(options.find(option => option.id === 'group-1')).toMatchObject({ label: 'Delivery team', subtitle: '2 members' });
  expect(options.find(option => option.id === 'person-2')).toMatchObject({ label: 'Unnamed person', subtitle: truncateCanvasIdentity(fullNpub) });
  expect(options.find(option => option.id === 'person-2').subtitle).not.toBe(fullNpub);
});

it('searches mixed principals, deduplicates selection, removes it, and hydrates edit selections', () => {
  const store = Object.assign(Object.create(canvasManagerMixin), {
    pgWorkspaceMembers: [
      { actor_id: 'person-1', npub: 'npub-person', kind: 'human', display_name: 'Avery Stone' },
      { actor_id: 'agent-1', npub: 'npub-agent', kind: 'agent', display_name: 'Research agent' },
    ],
    currentWorkspaceGroups: [{ group_id: 'group-1', name: 'Delivery team' }],
    groups: [],
    getSenderName: () => '',
    getSenderAvatar: () => '',
    canvasDialog: {
      open: true, mode: 'edit', id: 'canvas', rowVersion: 2, title: 'Plan',
      visibilityMode: 'restricted', actorIds: ['person-1'], groupIds: ['missing-group'],
    },
    canvasPrincipalQuery: '',
  });

  expect(store.canvasSelectedPrincipals.map(option => [option.label, option.kindLabel])).toEqual([
    ['Avery Stone', 'Person'],
    ['Unavailable group', 'Group'],
  ]);
  store.changeCanvasPrincipalQuery('research');
  expect(store.canvasPrincipalSearchResults.map(option => option.id)).toEqual(['agent-1']);
  const agent = store.canvasPrincipalSearchResults[0];
  store.selectCanvasPrincipal(agent);
  store.selectCanvasPrincipal(agent);
  expect(store.canvasDialog.actorIds).toEqual(['person-1', 'agent-1']);
  expect(store.canvasPrincipalOptions.find(option => option.id === 'agent-1').kindLabel).toBe('Agent');
  store.removeCanvasPrincipal(agent);
  expect(store.canvasDialog.actorIds).toEqual(['person-1']);
});

it('keeps restricted save invalid until a principal is selected and preserves create payload IDs', async () => {
  sync.createCanvasRecord.mockResolvedValue([]);
  vi.stubGlobal('document', { getElementById: vi.fn(() => ({ close: vi.fn() })) });
  const store = Object.assign(Object.create(canvasManagerMixin), {
    currentWorkspace: {
      workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'https://tower.example',
      appNpub: 'app', pgBackendMode: true,
    },
    currentWorkspaceKey: 'db', currentViewerNpub: 'reader', currentPgActorId: 'actor', session: { npub: 'reader' },
    canvasDialog: {
      open: true, mode: 'create', id: '', rowVersion: null, title: 'Restricted plan',
      visibilityMode: 'restricted', actorIds: [], groupIds: [],
    },
  });

  expect(store.canvasDialogCanSave).toBe(false);
  await store.saveCanvasDialog();
  expect(sync.createCanvasRecord).not.toHaveBeenCalled();
  store.canvasDialog = { ...store.canvasDialog, actorIds: ['actor-2'], groupIds: ['group-1'] };
  expect(store.canvasDialogCanSave).toBe(true);
  await store.saveCanvasDialog();
  expect(sync.createCanvasRecord).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace' }), {
    title: 'Restricted plan',
    visibility: { mode: 'restricted', actor_ids: ['actor-2'], group_ids: ['group-1'] },
  });
});
