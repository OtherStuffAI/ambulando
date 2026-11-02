import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCommentsByTarget,
  getSyncState,
  getTaskById,
  openWorkspaceDb,
  replacePgCommentsForTarget,
  setSyncState,
  upsertResourceViewState,
  upsertTask,
} from '../src/db.js';

const {
  alpineStartMock,
  alpineStoreMock,
  createTowerPgTaskCommentFromLocalMock,
  createTowerPgTaskFromLocalMock,
  releaseTowerPgEditLeaseMock,
  updateTowerPgTaskFromLocalMock,
} = vi.hoisted(() => ({
  alpineStartMock: vi.fn(),
  alpineStoreMock: vi.fn(),
  createTowerPgTaskCommentFromLocalMock: vi.fn(),
  createTowerPgTaskFromLocalMock: vi.fn(),
  releaseTowerPgEditLeaseMock: vi.fn(),
  updateTowerPgTaskFromLocalMock: vi.fn(),
}));

vi.mock('alpinejs', () => ({
  default: {
    store: alpineStoreMock,
    start: alpineStartMock,
  },
}));

vi.mock('../src/pg-write-adapter.js', () => ({
  createTowerPgAudioNoteFromLocal: vi.fn(),
  createTowerPgDocFromLocal: vi.fn(),
  createTowerPgFileFromLocal: vi.fn(),
  createTowerPgMessageFromLocal: vi.fn(),
  createTowerPgTaskCommentFromLocal: createTowerPgTaskCommentFromLocalMock,
  createTowerPgTaskFromLocal: createTowerPgTaskFromLocalMock,
  deleteTowerPgDocFromLocal: vi.fn(),
  resolveTowerPgTaskChannel: vi.fn(),
  updateTowerPgDocFromLocal: vi.fn(),
  updateTowerPgTaskFromLocal: updateTowerPgTaskFromLocalMock,
}));

vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  releaseTowerPgEditLease: releaseTowerPgEditLeaseMock,
}));

beforeEach(() => {
  alpineStartMock.mockClear();
  alpineStoreMock.mockClear();
  createTowerPgTaskCommentFromLocalMock.mockReset();
  createTowerPgTaskFromLocalMock.mockReset();
  releaseTowerPgEditLeaseMock.mockReset();
  updateTowerPgTaskFromLocalMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
});

async function waitForCondition(predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('app PG task offline drafts', () => {
  it('replaces the optimistic local task row when Tower accepts a PG create', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-create');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    createTowerPgTaskFromLocalMock.mockResolvedValueOnce({
      record_id: 'pg-task-1',
      owner_npub: 'npub1pgworkspace-create',
      title: 'Online PG task',
      description: '',
      state: 'new',
      priority: 'sand',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      pg_backend: true,
      pg_record_type: 'task',
      pg_channel_id: 'channel-1',
    });

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-create',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-create',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-create',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
      selectedBoardId: 'scope-1',
      newTaskTitle: 'Online PG task',
      tasks: [],
      buildTaskBoardAssignment: vi.fn(() => ({
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        board_group_id: null,
        shares: [],
        group_ids: [],
      })),
      refreshTasks: vi.fn(async () => store.tasks),
      scheduleTasksRefresh: vi.fn(),
    });

    const acceptedTask = await store.addTask({ channelId: 'channel-1', scopeId: 'scope-1' });
    const localTask = createTowerPgTaskFromLocalMock.mock.calls[0]?.[1];

    expect(acceptedTask.record_id).toBe('pg-task-1');
    expect(localTask.record_id).not.toBe('pg-task-1');
    expect(await getTaskById(localTask.record_id)).toBeUndefined();
    expect(await getTaskById('pg-task-1')).toMatchObject({ title: 'Online PG task', sync_status: 'synced' });
    expect(store.tasks.map((task) => task.record_id)).toEqual(['pg-task-1']);
  });

  it('creates PG subtasks under their parent task', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-subtask');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    createTowerPgTaskFromLocalMock.mockResolvedValueOnce({
      record_id: 'pg-subtask-1',
      owner_npub: 'npub1pgworkspace-subtask',
      title: 'Child PG task',
      description: '',
      state: 'new',
      priority: 'sand',
      parent_task_id: 'pg-parent-1',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      pg_backend: true,
      pg_record_type: 'task',
      pg_channel_id: 'channel-1',
    });

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    const parentTask = {
      record_id: 'pg-parent-1',
      owner_npub: 'npub1pgworkspace-subtask',
      title: 'Parent PG task',
      description: '',
      state: 'new',
      priority: 'sand',
      parent_task_id: null,
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      pg_backend: true,
      pg_record_type: 'task',
      pg_channel_id: 'channel-1',
    };

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-subtask',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-subtask',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-subtask',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
      selectedBoardId: 'scope-1',
      newSubtaskTitle: 'Child PG task',
      tasks: [parentTask],
      buildTaskBoardAssignment: vi.fn(() => ({
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        board_group_id: null,
        shares: [],
        group_ids: [],
      })),
      refreshTasks: vi.fn(async () => store.tasks),
      scheduleTasksRefresh: vi.fn(),
    });
    await upsertTask(parentTask);

    const acceptedSubtask = await store.addSubtask('pg-parent-1');
    const localSubtask = createTowerPgTaskFromLocalMock.mock.calls[0]?.[1];

    expect(localSubtask).toMatchObject({
      title: 'Child PG task',
      parent_task_id: 'pg-parent-1',
      pg_backend: true,
      pg_channel_id: 'channel-1',
    });
    expect(acceptedSubtask).toMatchObject({
      record_id: 'pg-subtask-1',
      parent_task_id: 'pg-parent-1',
      sync_status: 'synced',
    });
    expect(await getTaskById(localSubtask.record_id)).toBeUndefined();
    expect(await getTaskById('pg-subtask-1')).toMatchObject({
      title: 'Child PG task',
      parent_task_id: 'pg-parent-1',
    });
    expect(store.tasks.find((task) => task.record_id === 'pg-subtask-1')).toMatchObject({
      parent_task_id: 'pg-parent-1',
    });
  });

  it('creates a local PG task offline and keeps it editable until Tower accepts it', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    });
    createTowerPgTaskFromLocalMock.mockRejectedValueOnce(new Error('offline'));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
      selectedBoardId: 'scope-1',
      newTaskTitle: 'Offline PG task',
      tasks: [],
      buildTaskBoardAssignment: vi.fn(() => ({
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        board_group_id: null,
        shares: [],
        group_ids: [],
      })),
      refreshTasks: vi.fn(async () => store.tasks),
    });

    const localTask = await store.addTask({ channelId: 'channel-1', scopeId: 'scope-1' });

    expect(localTask).toMatchObject({
      title: 'Offline PG task',
      pg_backend: true,
      pg_record_type: 'task',
      pg_channel_id: 'channel-1',
      sync_status: 'failed',
    });
    expect(store.error).toBe('PG task saved locally. Reconnect to sync it.');
    expect(await getTaskById(localTask.record_id)).toMatchObject({ sync_status: 'failed' });

    const edited = await store.applyTaskPatch(localTask.record_id, { title: 'Offline PG task edited' }, {
      env: { navigator: { onLine: false } },
    });

    expect(edited).toMatchObject({
      record_id: localTask.record_id,
      title: 'Offline PG task edited',
      sync_status: 'failed',
      pg_backend: true,
    });
    expect(createTowerPgTaskFromLocalMock).toHaveBeenCalledTimes(1);
    expect(await getTaskById(localTask.record_id)).toMatchObject({
      title: 'Offline PG task edited',
      sync_status: 'failed',
    });
  });

  it('releases a held synced PG task lease when switching task detail routes', async () => {
    releaseTowerPgEditLeaseMock.mockResolvedValueOnce({ released: true });
    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: [
        {
          record_id: 'task-1',
          title: 'Synced PG task',
          pg_backend: true,
          sync_status: 'synced',
          record_state: 'active',
        },
        {
          record_id: 'task-2',
          title: 'Next synced PG task',
          pg_backend: true,
          sync_status: 'synced',
          record_state: 'active',
        },
      ],
      activeTaskId: 'task-1',
      editingTask: {
        record_id: 'task-1',
        title: 'Synced PG task',
        pg_backend: true,
        sync_status: 'synced',
        record_state: 'active',
      },
      taskDetailMode: 'edit',
      pgEditLeaseSessions: {
        'task:task-1': {
          acquireState: 'held',
          lease: { id: 'lease-task-1', lease_token: 'task-token-1' },
        },
      },
      pgEditLeaseRenewalTimers: {
        'task:task-1': 123,
      },
      loadTaskComments: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      markTaskRead: vi.fn(),
      syncRoute: vi.fn(),
    });

    store.openTaskDetail('task-2');

    expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledWith('workspace-1', 'lease-task-1', {
      lease_token: 'task-token-1',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.pgEditLeaseSessions['task:task-1']).toBeUndefined();
    expect(store.pgEditLeaseRenewalTimers['task:task-1']).toBeUndefined();
    expect(store.activeTaskId).toBe('task-2');
    expect(store.editingTask.record_id).toBe('task-2');
    expect(store.taskDetailMode).toBe('edit');
  });

  it('clears stale task comments immediately when switching task detail records', async () => {
    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      tasks: [
        { record_id: 'task-1', title: 'First task', record_state: 'active' },
        { record_id: 'task-2', title: 'Second task', record_state: 'active' },
      ],
      activeTaskId: 'task-1',
      editingTask: { record_id: 'task-1', title: 'First task', record_state: 'active' },
      taskComments: [{ record_id: 'comment-1', target_record_id: 'task-1', body: 'Old task comment' }],
      taskDetailMode: 'view',
      pgEditLeaseSessions: {},
      pgEditLeaseRenewalTimers: {},
      loadTaskComments: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      markTaskRead: vi.fn(),
      syncRoute: vi.fn(),
    });

    store.openTaskDetail('task-2');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.editingTask.record_id).toBe('task-2');
    expect(store.taskComments).toEqual([]);
    expect(store.loadTaskComments).toHaveBeenCalledWith('task-2');
  });

  it('opens PG task detail as an editable local draft and restores unsaved changes', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-task-draft');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-task-draft',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-task-draft',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-task-draft',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: [{
        record_id: 'task-1',
        title: 'Original title',
        description: '',
        state: 'new',
        priority: 'sand',
        version: 7,
        pg_backend: true,
        sync_status: 'synced',
        record_state: 'active',
      }],
      loadTaskComments: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      markTaskRead: vi.fn(),
      syncRoute: vi.fn(),
    });

    store.openTaskDetail('task-1');
    expect(store.taskDetailMode).toBe('edit');

    store.editingTask.title = 'Unsaved local title';
    store.handleEditingTaskDraftChanged();
    await store.persistTaskLocalDraft();

    const draft = await getSyncState('pg_task_detail_draft:v1:task-1');
    expect(draft).toMatchObject({
      record_id: 'task-1',
      base_version: 7,
      draft: {
        title: 'Unsaved local title',
      },
    });

    store.editingTask = null;
    store.taskEditOriginal = null;
    store.openTaskDetail('task-1');
    await waitForCondition(() => store.editingTask?.title === 'Unsaved local title');

    expect(store.taskDraftDirty).toBe(true);
    expect(store.taskDraftSaveState).toBe('local');
    expect(store.editingTask.title).toBe('Unsaved local title');
  });

  it('uses the original PG workspace context when a task comment save finishes after switching workspaces', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-comment-race');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    createTowerPgTaskCommentFromLocalMock.mockResolvedValueOnce({
      record_id: 'comment-accepted',
      target_record_id: 'task-1',
      body: 'Race comment',
      sender_npub: 'npub1owner',
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
      pg_record_type: 'task_comment',
      updated_at: '2026-06-23T00:00:00.000Z',
    });

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-comment-race',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-comment-race',
      selectedWorkspaceKey: 'workspace-original',
      knownWorkspaces: [{
        workspaceKey: 'workspace-original',
        workspaceId: 'workspace-original',
        workspaceOwnerNpub: 'npub1pgworkspace-comment-race',
        directHttpsUrl: 'https://original.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://original.example',
      tasks: [{
        record_id: 'task-1',
        title: 'Original task',
        owner_npub: 'npub1pgworkspace-comment-race',
        pg_backend: true,
        pg_record_type: 'task',
        pg_channel_id: 'channel-1',
        sync_status: 'synced',
        record_state: 'active',
      }],
      activeTaskId: 'task-1',
      editingTask: { record_id: 'task-1', title: 'Original task', pg_backend: true },
      taskComments: [],
      taskCommentAudioDrafts: [],
      newTaskCommentBody: 'Race comment',
      scheduleStorageImageHydration: vi.fn(),
      scheduleTaskCommentsRefresh: vi.fn(),
      markTaskRead: vi.fn(),
      syncRoute: vi.fn(),
    });

    const save = store.addTaskComment('task-1');
    store.knownWorkspaces = [
      ...store.knownWorkspaces,
      {
        workspaceKey: 'workspace-next',
        workspaceId: 'workspace-next',
        workspaceOwnerNpub: 'npub1other',
        directHttpsUrl: 'https://next.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      },
    ];
    store.selectedWorkspaceKey = 'workspace-next';
    store.backendUrl = 'https://next.example';
    store.activeTaskId = 'task-2';
    await save;

    expect(createTowerPgTaskCommentFromLocalMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        target_record_id: 'task-1',
        body: 'Race comment',
        pg_workspace_id: 'workspace-original',
      }),
      expect.objectContaining({
        workspaceId: 'workspace-original',
        baseUrl: 'https://original.example',
        appNpub: 'flightdeck_pg',
      }),
    );
  });

  it('keeps an accepted PG task comment visible through a stale refresh and reconciles the authoritative row', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-comment-reconciliation');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    createTowerPgTaskCommentFromLocalMock.mockImplementationOnce(async (_store, localRow) => ({
      record_id: 'comment-accepted',
      target_record_id: 'task-1',
      body: localRow.body,
      sender_npub: 'npub1owner',
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      created_at: '2026-08-05T05:22:24.011Z',
      updated_at: '2026-08-05T05:22:24.011Z',
      pg_backend: true,
      pg_record_type: 'task_comment',
      pg_workspace_id: 'workspace-1',
    }));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-comment-reconciliation',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-comment-reconciliation',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-comment-reconciliation',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: [{
        record_id: 'task-1',
        title: 'Task with comments',
        pg_backend: true,
        pg_channel_id: 'channel-1',
        sync_status: 'synced',
        record_state: 'active',
      }],
      activeTaskId: 'task-1',
      editingTask: { record_id: 'task-1', title: 'Task with comments', pg_backend: true },
      taskComments: [],
      taskCommentAudioDrafts: [],
      newTaskCommentBody: 'Visible throughout',
      scheduleStorageImageHydration: vi.fn(),
      scheduleTaskCommentsRefresh: vi.fn(),
    });

    await store.addTaskComment('task-1');
    const clientRecordId = createTowerPgTaskCommentFromLocalMock.mock.calls[0][1].record_id;
    const acceptedRows = await getCommentsByTarget('task-1');
    expect(acceptedRows).toEqual([
      expect.objectContaining({
        record_id: 'comment-accepted',
        pg_client_record_id: clientRecordId,
        pg_reconciliation_pending: true,
      }),
    ]);
    expect(store.scheduleTaskCommentsRefresh).not.toHaveBeenCalled();

    await replacePgCommentsForTarget('task-1', []);
    await store.applyTaskComments(await getCommentsByTarget('task-1'));
    expect(store.taskComments).toEqual([
      expect.objectContaining({ record_id: 'comment-accepted', pg_reconciliation_pending: true }),
    ]);

    await replacePgCommentsForTarget('task-1', [{
      ...acceptedRows[0],
      pg_client_record_id: clientRecordId,
      pg_reconciliation_pending: undefined,
      updated_at: '2026-08-05T05:22:25.000Z',
    }]);
    await store.applyTaskComments(await getCommentsByTarget('task-1'));

    expect(store.taskComments).toHaveLength(1);
    expect(store.taskComments[0]).toMatchObject({
      record_id: 'comment-accepted',
      pg_client_record_id: clientRecordId,
      sync_status: 'synced',
    });
    expect(store.taskComments[0].pg_reconciliation_pending).toBeUndefined();
  });

  it('does not use PG lease release when switching from an encrypted-record task detail edit', async () => {
    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      tasks: [
        { record_id: 'task-classic-1', title: 'Classic task', record_state: 'active' },
        { record_id: 'task-classic-2', title: 'Next classic task', record_state: 'active' },
      ],
      activeTaskId: 'task-classic-1',
      editingTask: { record_id: 'task-classic-1', title: 'Classic task', record_state: 'active' },
      taskDetailMode: 'edit',
      pgEditLeaseSessions: {},
      pgEditLeaseRenewalTimers: {},
      loadTaskComments: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      markTaskRead: vi.fn(),
      syncRoute: vi.fn(),
    });

    store.openTaskDetail('task-classic-2');

    expect(releaseTowerPgEditLeaseMock).not.toHaveBeenCalled();
    expect(store.activeTaskId).toBe('task-classic-2');
    expect(store.editingTask.record_id).toBe('task-classic-2');
  });

  it.each([false, true])('restores a review task when an awaited PG done-state write is rejected (outside selected collection: %s)', async (outsideCollection) => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-review-rollback');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    updateTowerPgTaskFromLocalMock.mockRejectedValueOnce(new Error('Tower rejected the state update.'));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    const reviewTask = {
      record_id: 'task-review-rollback',
      owner_npub: 'npub1pgworkspace-review-rollback',
      title: 'Review task',
      state: 'review',
      version: 4,
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
      pg_channel_id: 'channel-1',
      updated_at: '2026-08-26T00:00:00.000Z',
    };
    await upsertTask(reviewTask);
    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-review-rollback',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-review-rollback',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-review-rollback',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: outsideCollection ? [] : [reviewTask],
      editingTask: null,
    });

    await expect(store.applyTaskPatch(reviewTask.record_id, { state: 'done' }, {
      backgroundPg: false,
      rollbackOnFailure: true,
      ...(outsideCollection ? { sourceTask: reviewTask } : {}),
    })).resolves.toBeNull();

    expect(updateTowerPgTaskFromLocalMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ record_id: reviewTask.record_id, state: 'done' }),
      reviewTask,
      { state: 'done' },
    );
    expect(store.tasks).toEqual(outsideCollection ? [] : [reviewTask]);
    expect(await getTaskById(reviewTask.record_id)).toEqual(reviewTask);
    expect(store.error).toBe('Tower rejected the state update.');
  });

  it('keeps the viewer\'s normal background done path read before Tower reconciliation', async () => {
    const ownerNpub = 'npub1pgworkspace-normal-close';
    const workspaceKey = 'workspace-1';
    const wsDb = openWorkspaceDb(workspaceKey);
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    let resolveUpdate;
    updateTowerPgTaskFromLocalMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveUpdate = () => resolve({
        record_id: 'task-normal-close', title: 'Live close regression', state: 'done',
        activity_version: 12, version: 6, sync_status: 'synced', record_state: 'active',
        pg_backend: true, pg_channel_id: 'channel-1',
        pg_updated_by_actor_id: 'actor-viewer', pg_updated_by_actor_npub: 'npub1viewer',
        updated_at: '2026-08-26T11:32:38.813Z',
      });
    }));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    const task = {
      record_id: 'task-normal-close', owner_npub: ownerNpub,
      title: 'Live close regression', state: 'review', activity_version: 11,
      version: 5, sync_status: 'synced', record_state: 'active', pg_backend: true,
      pg_channel_id: 'channel-1', pg_updated_by_actor_id: 'actor-other',
      updated_at: '2026-08-26T08:44:03.599Z',
    };
    await upsertTask(task);
    await upsertResourceViewState({
      record_id: 'task:task-normal-close', resource_type: 'task', resource_id: 'task-normal-close',
      viewer_actor_id: 'actor-viewer', channel_id: 'channel-1', activity_version: 11,
      viewed_activity_version: 10, row_version: 2, sync_status: 'synced',
      updated_at: '2026-08-26T08:44:03.599Z',
    });
    Object.assign(store, {
      session: { npub: 'npub1viewer' },
      ownerNpub,
      currentWorkspaceOwnerNpub: ownerNpub,
      selectedWorkspaceKey: workspaceKey,
      knownWorkspaces: [{
        workspaceKey, workspaceId: 'workspace-1', workspaceOwnerNpub: ownerNpub,
        directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg', pgBackendMode: true,
        pgMe: { actor: { actor_id: 'actor-viewer', npub: 'npub1viewer' } },
      }],
      backendUrl: 'https://tower.example',
      tasks: [task],
      editingTask: { ...task },
      taskDetailMode: 'view',
      activeTaskId: task.record_id,
      _unreadTaskItems: { [task.record_id]: true },
      _unreadChannels: { 'channel-1': true },
    });

    await store.applyTaskDetailQuickAction('done');

    expect(store.tasks[0]).toMatchObject({
      state: 'done', sync_status: 'pending',
      pg_updated_by_actor_id: 'actor-viewer',
      pg_updated_by_actor_npub: 'npub1viewer',
    });
    expect(store._unreadTaskItems).toEqual({});
    expect(store._unreadChannels).toEqual({});

    await waitForCondition(() => updateTowerPgTaskFromLocalMock.mock.calls.length === 1);
    resolveUpdate();
    await waitForCondition(() => store.pgTaskWriteInFlight === false);
  });

  it('archives PG bulk task updates locally before background Tower writes finish', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-bulk-failed');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    let resolveFirstUpdate;
    let resolveSecondUpdate;
    updateTowerPgTaskFromLocalMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstUpdate = () => resolve({
        record_id: 'task-1',
        title: 'Task one',
        state: 'archive',
        version: 2,
        sync_status: 'synced',
        record_state: 'active',
        pg_backend: true,
      });
    }));
    updateTowerPgTaskFromLocalMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSecondUpdate = () => resolve({
        record_id: 'task-2',
        title: 'Task two',
        state: 'archive',
        version: 2,
        sync_status: 'synced',
        record_state: 'active',
        pg_backend: true,
      });
    }));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-bulk-failed',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-bulk-failed',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-bulk-failed',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: [
        { record_id: 'task-1', title: 'Task one', state: 'ready', version: 1, sync_status: 'synced', record_state: 'active', pg_backend: true },
        { record_id: 'task-2', title: 'Task two', state: 'ready', version: 1, sync_status: 'synced', record_state: 'active', pg_backend: true },
      ],
      selectedTaskIds: ['task-1', 'task-2'],
      pgEditLeaseSessions: {
        'task:task-1': { acquireState: 'held', lease: { id: 'lease-task-1', lease_token: 'token-1' } },
        'task:task-2': { acquireState: 'held', lease: { id: 'lease-task-2', lease_token: 'token-2' } },
      },
      flushAndBackgroundSync: vi.fn(async () => ({ pushed: 0 })),
      scheduleTasksRefresh: vi.fn(),
      refreshTasks: vi.fn(),
    });

    await store.applyBulkTaskAction('archive');

    expect(store.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: 'task-1', state: 'archive', sync_status: 'pending' }),
      expect.objectContaining({ record_id: 'task-2', state: 'archive', sync_status: 'pending' }),
    ]));
    expect(store.selectedTaskIds).toEqual([]);
    expect(store.bulkTaskBusy).toBe(false);
    expect(store.syncStatus).toBe('syncing');
    expect(store.syncProgressLabel()).toBe('Updating tasks 0 / 2');
    expect(await getSyncState('pg_task_write_queue:v1')).toHaveLength(2);
    await waitForCondition(() => updateTowerPgTaskFromLocalMock.mock.calls.length === 2);
    expect(updateTowerPgTaskFromLocalMock).toHaveBeenCalledTimes(2);
    expect(store.scheduleTasksRefresh).not.toHaveBeenCalled();
    expect(store.refreshTasks).not.toHaveBeenCalled();

    resolveFirstUpdate();
    resolveSecondUpdate();
    await waitForCondition(() => store.pgTaskWriteInFlight === false);

    expect(updateTowerPgTaskFromLocalMock).toHaveBeenCalledWith(store, expect.objectContaining({
      record_id: 'task-1',
      state: 'archive',
    }), expect.objectContaining({ record_id: 'task-1' }), expect.objectContaining({ state: 'archive' }));
    expect(updateTowerPgTaskFromLocalMock).toHaveBeenCalledWith(store, expect.objectContaining({
      record_id: 'task-2',
      state: 'archive',
    }), expect.objectContaining({ record_id: 'task-2' }), expect.objectContaining({ state: 'archive' }));
    expect(store.scheduleTasksRefresh).not.toHaveBeenCalled();
    expect(store.refreshTasks).not.toHaveBeenCalled();
    expect(store.syncStatus).toBe('synced');
    expect(await getSyncState('pg_task_write_queue:v1')).toBeNull();
    expect(store.tasks.find((task) => task.record_id === 'task-2')).toMatchObject({
      state: 'archive',
      sync_status: 'synced',
    });
  });

  it('persists PG task background patches as plain cloneable data', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-plain-task-queue');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    const previousTask = {
      record_id: 'task-proxy-patch',
      title: 'Proxy patch task',
      state: 'ready',
      version: 1,
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
    };
    const updatedTask = {
      ...previousTask,
      state: 'done',
      version: 2,
      sync_status: 'pending',
    };
    const proxiedAssignees = new Proxy([], {});
    expect(() => structuredClone(proxiedAssignees)).toThrow();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      tasks: [previousTask],
      pgTaskWriteQueue: [],
    });

    await expect(store.enqueuePgTaskPatch(
      updatedTask,
      previousTask,
      { state: 'done', assigned_to_npubs: proxiedAssignees },
      { deferPgProcessing: true },
    )).resolves.toBeUndefined();

    const persisted = await getSyncState('pg_task_write_queue:v1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].patch).toEqual({ state: 'done', assigned_to_npubs: [] });
    expect(() => structuredClone(persisted)).not.toThrow();
  });

  it('resumes persisted PG task background updates after page reload', async () => {
    const wsDb = openWorkspaceDb('npub1pgworkspace-resume-task-writes');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));

    const { initApp } = await import('../src/app.js');
    initApp();
    const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
    expect(store).toBeTruthy();

    Object.assign(store, {
      session: { npub: 'npub1owner' },
      ownerNpub: 'npub1pgworkspace-resume-task-writes',
      currentWorkspaceOwnerNpub: 'npub1pgworkspace-resume-task-writes',
      selectedWorkspaceKey: 'workspace-1',
      knownWorkspaces: [{
        workspaceKey: 'workspace-1',
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace-resume-task-writes',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      }],
      backendUrl: 'https://tower.example',
      tasks: [
        { record_id: 'task-resume-1', title: 'Task one', state: 'ready', version: 1, sync_status: 'synced', record_state: 'active', pg_backend: true },
      ],
      pgEditLeaseSessions: {
        'task:task-resume-1': { acquireState: 'held', lease: { id: 'lease-task-resume-1', lease_token: 'token-1' } },
      },
      scheduleTasksRefresh: vi.fn(),
    });

    await upsertTask({
      record_id: 'task-resume-1',
      title: 'Task one',
      state: 'archive',
      version: 2,
      sync_status: 'pending',
      record_state: 'active',
      pg_backend: true,
    });
    await setSyncState('pg_task_write_queue:v1', [{
      queueId: 'task-resume-1:queued',
      recordId: 'task-resume-1',
      updatedTask: { record_id: 'task-resume-1', title: 'Task one', state: 'archive', version: 2, sync_status: 'pending', record_state: 'active', pg_backend: true },
      previousTask: { record_id: 'task-resume-1', title: 'Task one', state: 'ready', version: 1, sync_status: 'synced', record_state: 'active', pg_backend: true },
      patch: { state: 'archive' },
      options: { retainPgLease: true, intent: 'bulk_archive' },
      createdAt: '2026-06-22T00:00:00.000Z',
    }]);

    const persisted = await getSyncState('pg_task_write_queue:v1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      recordId: 'task-resume-1',
      patch: { state: 'archive' },
    });
    updateTowerPgTaskFromLocalMock.mockResolvedValueOnce({
      record_id: 'task-resume-1',
      title: 'Task one',
      state: 'archive',
      version: 2,
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
    });

    await store.resumePgTaskWriteQueue();
    await waitForCondition(() => updateTowerPgTaskFromLocalMock.mock.calls.length === 1);
    await waitForCondition(() => store.pgTaskWriteInFlight === false);

    expect(updateTowerPgTaskFromLocalMock).toHaveBeenCalledWith(store, expect.objectContaining({
      record_id: 'task-resume-1',
      state: 'archive',
    }), expect.objectContaining({ record_id: 'task-resume-1' }), expect.objectContaining({ state: 'archive' }));
    expect(await getSyncState('pg_task_write_queue:v1')).toBeNull();
    expect(store.tasks.find((task) => task.record_id === 'task-resume-1')).toMatchObject({
      state: 'archive',
      sync_status: 'synced',
    });
  });
});
