import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => true),
}));

vi.mock('../src/db.js', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  upsertWorkspaceSettings: vi.fn(),
  openWorkspaceDb: vi.fn(),
  isWorkspaceDbOpenForKey: vi.fn(() => true),
  deleteWorkspaceDb: vi.fn(),
  clearRuntimeData: vi.fn().mockResolvedValue(undefined),
  addPendingWrite: vi.fn(),
  cacheStorageImage: vi.fn(),
  evictStorageImageCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/api.js', () => ({
  setBaseUrl: vi.fn(),
  createWorkspace: vi.fn(),
  deleteTowerPgWorkspace: vi.fn(),
  fetchWorkspaceAppSchemas: vi.fn(),
  getWorkspaces: vi.fn(),
  listTowerPgWorkspaces: vi.fn(),
  publishWorkspaceAppSchema: vi.fn(),
  recoverWorkspace: vi.fn(),
  updateTowerPgWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  registerWorkspaceApp: vi.fn(),
  prepareStorageObject: vi.fn(),
  uploadStorageObject: vi.fn(),
  completeStorageObject: vi.fn(),
}));

vi.mock('../src/crypto/workspace-keys.js', () => ({
  clearActiveWorkspaceKey: vi.fn(),
  getActiveWorkspaceKey: vi.fn(() => null),
  removeCachedWorkspaceKeyBlob: vi.fn().mockResolvedValue(undefined),
}));

function applyWorkspaceMixin(store) {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(store.workspaceManagerMixin))) {
    if (Object.prototype.hasOwnProperty.call(store, key)) continue;
    Object.defineProperty(store, key, descriptor);
  }
  return store;
}

async function buildStore(overrides = {}) {
  const { workspaceManagerMixin } = await import('../src/workspace-manager.js');
  const store = {
    workspaceManagerMixin,
    knownWorkspaces: [],
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    session: { npub: 'npub1user' },
    backendUrl: 'https://tower.example/',
    groups: [],
    workspaceProfileRowsByKey: {},
    showWorkspaceSwitcherMenu: false,
    showWorkspaceAccessGate: false,
    workspaceAccessGateStep: 'review',
    workspaceAccessGateWorkspaces: [],
    workspaceAccessGateProgress: {
      active: false,
      phase: 'idle',
      label: '',
      completed: 0,
      total: 0,
      error: '',
    },
    workspaceAccessGateBusy: false,
    workspaceSwitchPendingKey: '',
    workspaceSwitchPendingNpub: '',
    _workspaceProfileHydratedKeys: new Set(),
    channels: [],
    messages: [],
    documents: [],
    directories: [],
    tasks: [],
    schedules: [],
    audioNotes: [],
    taskComments: [],
    flows: [],
    approvals: [],
    chatProfiles: {},
    showNewScheduleModal: false,
    docCommentBackfillAttemptsByDocId: {},
    scopesLoaded: false,
    hasForcedInitialBackfill: false,
    hasForcedTaskFamilyBackfill: false,
    selectedBoardId: null,
    navSection: 'tasks',
    selectedChannelId: null,
    activeThreadId: null,
    showBoardDescendantTasks: true,
    taskViewMode: 'list',
    taskSortMode: 'modified_desc',
    selectedDocType: null,
    selectedDocId: null,
    selectedDocCommentId: null,
    currentFolderId: null,
    selectedReportId: null,
    activeOpportunityId: null,
    startSharedLiveQueries: vi.fn(),
    stopWorkspaceLiveQueries: vi.fn(),
    revokeStorageImageObjectUrls: vi.fn(),
    cancelEditSchedule: vi.fn(),
    startWorkspaceLiveQueries: vi.fn(),
    readStoredTaskBoardId: vi.fn(() => null),
    persistSelectedBoardId: vi.fn(),
    validateSelectedBoardId: vi.fn(),
    normalizeSettingsTab: vi.fn(),
    persistWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    ensureWorkspaceSessionKey: vi.fn().mockResolvedValue(undefined),
    registerCurrentWorkspaceApp: vi.fn().mockResolvedValue(undefined),
    publishCurrentWorkspaceAppSchema: vi.fn().mockResolvedValue(undefined),
    refreshWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    syncWorkspaceProfileDraft: vi.fn(),
    syncRoute: vi.fn(),
    closeThread: vi.fn(),
    closeTaskDetail: vi.fn(),
    getSenderAvatar: vi.fn(() => null),
    getInitials: vi.fn((value) => String(value || 'WS').slice(0, 2).toUpperCase()),
    mergeKnownWorkspaces(entries) {
      this.knownWorkspaces = entries;
    },
    ...overrides,
  };
  const { taskBoardStateMixin } = await import('../src/task-board-state.js');
  for (const key of ['pgContextSelectedChannelId', 'pgContextSelectedThreadId']) {
    Object.defineProperty(store, key, Object.getOwnPropertyDescriptor(taskBoardStateMixin, key));
  }
  return applyWorkspaceMixin(store);
}

describe('PG workspace manager mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('activates cached scopes and channels without a signer or authority setup', async () => {
    const workspace = {
      workspaceKey: 'pg:cached', workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace', workspaceId: 'workspace-1', pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace], selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub, session: null,
      loadLocalScopes: vi.fn().mockResolvedValue([{ record_id: 'scope-1' }]),
      loadLocalChannels: vi.fn().mockResolvedValue([{ record_id: 'channel-1' }]),
    });

    await expect(store.activateCachedWorkspace({ workspace, workspaceKey: workspace.workspaceKey }))
      .resolves.toBe(true);

    expect(store.startWorkspaceLiveQueries).toHaveBeenCalledTimes(1);
    expect(store.loadLocalScopes).toHaveBeenCalledTimes(1);
    expect(store.loadLocalChannels).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.ensureWorkspaceSessionKey).not.toHaveBeenCalled();
  });

  it('refuses mismatched partitions and rejects a cache load superseded by a workspace switch', async () => {
    const db = await import('../src/db.js');
    const workspace = {
      workspaceKey: 'pg:cached', workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace', workspaceId: 'workspace-1', pgBackendMode: true,
    };
    const other = { ...workspace, workspaceKey: 'pg:other', workspaceOwnerNpub: 'npub1other' };
    let finishChannels;
    const store = await buildStore({
      knownWorkspaces: [workspace, other], selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      _workspaceSelectionGeneration: 1,
      loadLocalScopes: vi.fn().mockResolvedValue([]),
      loadLocalChannels: vi.fn(() => new Promise(resolve => { finishChannels = resolve; })),
    });

    db.isWorkspaceDbOpenForKey.mockReturnValueOnce(false);
    await expect(store.activateCachedWorkspace({ workspace, workspaceKey: workspace.workspaceKey }))
      .resolves.toBe(false);
    expect(store.startWorkspaceLiveQueries).not.toHaveBeenCalled();

    const activation = store.activateCachedWorkspace({ workspace, workspaceKey: workspace.workspaceKey });
    await vi.waitFor(() => expect(store.loadLocalChannels).toHaveBeenCalledTimes(1));
    store.selectedWorkspaceKey = other.workspaceKey;
    store.currentWorkspaceOwnerNpub = other.workspaceOwnerNpub;
    store._workspaceSelectionGeneration += 1;
    finishChannels([]);
    await expect(activation).resolves.toBe(false);
  });

  it('loads remote workspaces from Tower PG discovery in PG mode', async () => {
    const api = await import('../src/api.js');
    api.listTowerPgWorkspaces.mockResolvedValue({
      workspaces: [{
        identity: {
          tower_service_npub: 'npub1tower',
          workspace_service_npub: 'npub1workspace',
          workspace_owner_npub: 'npub1owner',
          workspace_id: 'workspace-1',
          app_npub: 'flightdeck_pg',
        },
        label: 'Wingmen',
        description: 'PG workspace',
        capabilities: ['pg_scopes'],
      }],
    });
    const store = await buildStore();

    await store.loadRemoteWorkspaces();

    expect(api.listTowerPgWorkspaces).toHaveBeenCalledWith({
      baseUrl: 'https://tower.example',
      appNpub: expect.any(String),
      limit: 200,
    });
    expect(api.getWorkspaces).not.toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    });
    expect(store.showWorkspaceAccessGate).toBe(true);
    expect(store.workspaceAccessGateStep).toBe('review');
    expect(store.workspaceAccessGateWorkspaces[0]).toMatchObject({
      name: 'Wingmen',
      workspaceOwnerNpub: 'npub1owner',
    });
  });

  it('preserves a selected workspace and its Dexie partition when discovery omits it', async () => {
    const api = await import('../src/api.js');
    const db = await import('../src/db.js');
    api.listTowerPgWorkspaces.mockResolvedValue({ workspaces: [] });
    const remembered = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      towerServiceNpub: 'npub1tower',
      serviceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      pgSessionNpub: 'npub1user',
      directHttpsUrl: 'https://tower.example',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [remembered],
      selectedWorkspaceKey: remembered.workspaceKey,
      currentWorkspaceOwnerNpub: remembered.workspaceOwnerNpub,
    });

    await store.loadRemoteWorkspaces();

    expect(store.knownWorkspaces).toHaveLength(1);
    expect(store.knownWorkspaces[0]).toMatchObject(remembered);
    expect(store.selectedWorkspaceKey).toBe(remembered.workspaceKey);
    expect(store.currentWorkspaceOwnerNpub).toBe(remembered.workspaceOwnerNpub);
    expect(db.deleteWorkspaceDb).not.toHaveBeenCalled();
  });

  it('keeps Tower-visible PG workspaces when the build app namespace discovery is empty', async () => {
    const api = await import('../src/api.js');
    api.listTowerPgWorkspaces
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce({
        workspaces: [{
          identity: {
            tower_service_npub: 'npub1tower',
            workspace_service_npub: 'npub1workspace',
            workspace_owner_npub: 'npub1owner',
            workspace_id: 'workspace-1',
            app_npub: 'flightdeck_pg',
          },
          tower_base_url: 'https://tower.example',
          label: 'Wingmen',
          description: 'PG workspace',
          capabilities: ['pg_scopes'],
        }],
      });
    const store = await buildStore();

    await store.loadRemoteWorkspaces();

    expect(api.listTowerPgWorkspaces).toHaveBeenNthCalledWith(1, {
      baseUrl: 'https://tower.example',
      appNpub: expect.any(String),
      limit: 200,
    });
    expect(api.listTowerPgWorkspaces).toHaveBeenNthCalledWith(2, {
      baseUrl: 'https://tower.example',
      appNpub: '',
      limit: 200,
    });
    expect(store.knownWorkspaces[0]).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      appNpub: 'flightdeck_pg',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    });
    expect(store.showWorkspaceAccessGate).toBe(true);
  });

  it('lets a fresh Tower PG workspace list clear a stale local forgotten marker', async () => {
    const api = await import('../src/api.js');
    const remoteWorkspace = {
      identity: {
        tower_service_npub: 'npub1tower',
        workspace_service_npub: 'npub1workspace',
        workspace_owner_npub: 'npub1owner',
        workspace_id: 'workspace-1',
        app_npub: 'flightdeck_pg',
      },
      tower_base_url: 'https://tower.example',
      label: 'Recovered from Tower',
      description: 'Tower still lists this workspace',
      capabilities: ['pg_scopes'],
    };
    api.listTowerPgWorkspaces.mockResolvedValue({ workspaces: [remoteWorkspace] });
    const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    const store = await buildStore({
      forgottenPgWorkspaces: [{
        sessionNpub: 'npub1user',
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
        workspaceId: 'workspace-1',
        workspaceServiceNpub: 'npub1workspace',
        workspaceOwnerNpub: 'npub1owner',
        towerServiceNpub: 'npub1tower',
        appNpub: 'flightdeck_pg',
        forgottenAt: '2026-09-14T00:00:00.000Z',
        reason: 'descriptor_not_found',
      }],
      persistWorkspaceSettings,
    });

    await store.loadRemoteWorkspaces();

    expect(store.forgottenPgWorkspaces).toEqual([]);
    expect(store.knownWorkspaces).toHaveLength(1);
    expect(store.knownWorkspaces[0]).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      name: 'Recovered from Tower',
      pgBackendMode: true,
    });
    expect(store.showWorkspaceAccessGate).toBe(true);
    expect(persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('continues from the workspace access gate by selecting and bootstrapping the first workspace', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      towerServiceNpub: 'npub1tower',
      serviceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      name: 'Wingmen',
    };
    const selectWorkspace = vi.fn().mockResolvedValue(undefined);
    const bootstrapSelectedWorkspace = vi.fn().mockResolvedValue(undefined);
    const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    const ensureBackgroundSync = vi.fn();
    const updateWorkspaceBootstrapPrompt = vi.fn();
    const store = await buildStore({
      knownWorkspaces: [workspace],
      workspaceAccessGateWorkspaces: [workspace],
      showWorkspaceAccessGate: true,
      selectWorkspace,
      bootstrapSelectedWorkspace,
      persistWorkspaceSettings,
      ensureBackgroundSync,
      updateWorkspaceBootstrapPrompt,
    });

    await store.continueWorkspaceAccessGate();

    expect(selectWorkspace).toHaveBeenCalledWith(workspace.workspaceKey, {
      refresh: false,
      openWorkspaceHome: true,
    });
    expect(persistWorkspaceSettings).toHaveBeenCalled();
    expect(bootstrapSelectedWorkspace).toHaveBeenCalledWith({ runAccessPrune: true });
    expect(ensureBackgroundSync).toHaveBeenCalledWith(true);
    expect(store.showWorkspaceAccessGate).toBe(false);
    expect(store.workspaceAccessGateProgress).toMatchObject({
      phase: 'complete',
      completed: 4,
      total: 4,
    });
  });

  it('does not let sparse Tower PG discovery clear an existing workspace avatar', async () => {
    const api = await import('../src/api.js');
    const { mergeWorkspaceEntries } = await import('../src/workspaces.js');
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      towerServiceNpub: 'npub1tower',
      serviceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      avatarUrl: 'storage://workspace-avatar-1',
    };
    api.listTowerPgWorkspaces.mockResolvedValue({
      workspaces: [{
        identity: {
          tower_service_npub: 'npub1tower',
          workspace_service_npub: 'npub1workspace',
          workspace_owner_npub: 'npub1owner',
          workspace_id: 'workspace-1',
          app_npub: 'flightdeck_pg',
        },
        label: 'Wingmen',
        description: 'PG workspace',
        avatar_url: null,
      }],
    });
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: 'npub1owner',
      mergeKnownWorkspaces(entries) {
        this.knownWorkspaces = mergeWorkspaceEntries(this.knownWorkspaces, entries);
      },
    });

    await store.loadRemoteWorkspaces();

    expect(store.knownWorkspaces).toHaveLength(1);
    expect(store.knownWorkspaces[0].avatarUrl).toBe('storage://workspace-avatar-1');
  });

  it('retains saved PG workspaces that the active Tower list omits', async () => {
    const api = await import('../src/api.js');
    const db = await import('../src/db.js');
    const { mergeWorkspaceEntries } = await import('../src/workspaces.js');
    const stale = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1stale::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1stale',
      workspaceId: 'workspace-stale',
      towerServiceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      name: 'Deleted workspace',
    };
    api.listTowerPgWorkspaces.mockResolvedValue({ workspaces: [] });
    const persistWorkspaceSettings = vi.fn().mockResolvedValue(undefined);
    const store = await buildStore({
      knownWorkspaces: [stale],
      mergeKnownWorkspaces(entries) {
        this.knownWorkspaces = mergeWorkspaceEntries(this.knownWorkspaces, entries);
      },
      persistWorkspaceSettings,
    });

    await store.loadRemoteWorkspaces();

    expect(store.knownWorkspaces).toHaveLength(1);
    expect(store.knownWorkspaces[0]).toMatchObject({
      ...stale,
      workspaceKey: `${stale.workspaceKey}::id:${stale.workspaceId}`,
    });
    expect(db.deleteWorkspaceDb).not.toHaveBeenCalled();
    expect(persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('deletes an administered PG workspace from Tower before clearing its local cache', async () => {
    const api = await import('../src/api.js');
    api.deleteTowerPgWorkspace.mockResolvedValue({
      deleted: true,
      revoked_member_npubs: ['npub1agent', 'npub1member', 'npub1servermember'],
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('alert', vi.fn());
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      towerServiceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgMe: { permissions: ['workspace.manage'] },
      name: 'Disposable',
    };
    const publishPgWorkspaceSelfIndexTombstone = vi.fn().mockResolvedValue({});
    const publishPgOnboardingAnnouncementRevocation = vi.fn().mockResolvedValue({});
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      publishPgWorkspaceSelfIndexTombstone,
      publishPgOnboardingAnnouncementRevocation,
      pgWorkspaceMembers: [
        { npub: 'npub1agent' },
        { npub: 'npub1member' },
      ],
      stopBackgroundSync: vi.fn(),
      ensureBackgroundSync: vi.fn(),
      navigateTo: vi.fn(),
      removingWorkspace: false,
    });

    await store.removeWorkspace(workspace.workspaceKey);

    expect(api.deleteTowerPgWorkspace).toHaveBeenCalledWith('workspace-1', {
      confirmation: 'workspace-1',
    }, {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(publishPgWorkspaceSelfIndexTombstone).toHaveBeenCalledWith(workspace, {
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
    });
    expect(publishPgOnboardingAnnouncementRevocation).toHaveBeenCalledTimes(3);
    expect(publishPgOnboardingAnnouncementRevocation).toHaveBeenCalledWith({
      recipientNpub: 'npub1agent',
      workspace,
      grantId: 'workspace-1:workspace:npub1agent',
      reason: 'workspace_deleted',
      action: 'deleted',
    });
    expect(store.knownWorkspaces).toEqual([]);
  });

  it('persists a local forget marker without deleting the Tower workspace', async () => {
    const api = await import('../src/api.js');
    vi.stubGlobal('confirm', vi.fn(() => true));
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      towerServiceNpub: 'npub1tower',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgMe: { permissions: ['workspace.read'] },
      name: 'Local only',
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      forgottenPgWorkspaces: [],
      stopBackgroundSync: vi.fn(),
      ensureBackgroundSync: vi.fn(),
      navigateTo: vi.fn(),
      removingWorkspace: false,
    });

    await store.removeWorkspace(workspace.workspaceKey);

    expect(api.deleteTowerPgWorkspace).not.toHaveBeenCalled();
    expect(store.forgottenPgWorkspaces).toHaveLength(1);
    expect(store.forgottenPgWorkspaces[0]).toMatchObject({
      sessionNpub: 'npub1user',
      workspaceId: 'workspace-1',
      reason: 'local_forget',
    });
    expect(store.knownWorkspaces).toEqual([]);
  });

  it('activates PG workspace auth before local data without legacy app schema setup', async () => {
    const api = await import('../src/api.js');
    const refreshGroups = vi.fn().mockResolvedValue([]);
    const loadLocalWorkspaceCoreData = vi.fn().mockResolvedValue({ scopes: [], channels: [] });
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      refreshGroups,
      loadLocalWorkspaceCoreData,
      refreshScopes: vi.fn().mockResolvedValue([]),
      refreshChannels: vi.fn().mockResolvedValue([]),
      refreshTasks: vi.fn().mockResolvedValue([]),
      refreshDocuments: vi.fn().mockResolvedValue([]),
      refreshAudioNotes: vi.fn().mockResolvedValue([]),
    });
    store.syncWorkspaceProfileDraft = vi.fn();

    await store.selectWorkspace(workspace.workspaceKey, { pgVerified: true });

    expect(store.ensureWorkspaceSessionKey).toHaveBeenCalledTimes(1);
    expect(store.ensureWorkspaceSessionKey.mock.invocationCallOrder[0])
      .toBeLessThan(loadLocalWorkspaceCoreData.mock.invocationCallOrder[0]);
    expect(loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalled();
    expect(refreshGroups).not.toHaveBeenCalled();
    expect(api.registerWorkspaceApp).not.toHaveBeenCalled();
    expect(api.publishWorkspaceAppSchema).not.toHaveBeenCalled();
  });

  it('ignores verification that finishes after a newer workspace selection', async () => {
    const first = { workspaceKey: 'pg:alpha', workspaceId: 'alpha', workspaceOwnerNpub: 'npub1owner', pgBackendMode: true };
    const next = { ...first, workspaceKey: 'pg:beta', workspaceId: 'beta' };
    let resolve;
    const store = await buildStore({ knownWorkspaces: [first, next],
      ensurePgWorkspaceAvailable: () => new Promise(r => { resolve = r; }),
    });
    const delayed = store.selectWorkspace(first.workspaceKey);
    await store.selectWorkspace(next.workspaceKey, { pgVerified: true });
    resolve(first);
    await delayed;
    expect(store.currentWorkspace.workspaceId).toBe('beta');
  });

  it('switches same-owner workspaces without clearing either persisted partition', async () => {
    const db = await import('../src/db.js');
    const first = { workspaceKey: 'pg:alpha', workspaceId: 'alpha', workspaceOwnerNpub: 'npub1owner', pgBackendMode: true };
    const next = { ...first, workspaceKey: 'pg:beta', workspaceId: 'beta' };
    const store = await buildStore({ knownWorkspaces: [first, next], selectedWorkspaceKey: first.workspaceKey,
      localWorkspaceCoreLoadedForKey: first.workspaceKey, scopes: [{ record_id: 'old' }],
      reports: [{ record_id: 'old' }], wapps: [{ record_id: 'old' }],
      addressBookPeople: [{ npub: 'global-user' }],
    });
    await store.selectWorkspace(next.workspaceKey, { pgVerified: true });
    expect(store.currentWorkspace.workspaceId).toBe('beta');
    expect(store.scopes).toEqual([]);
    expect(store.reports).toEqual([]);
    expect(store.wapps).toEqual([]);
    expect(store.addressBookPeople).toEqual([{ npub: 'global-user' }]);
    await store.selectWorkspace(first.workspaceKey, { pgVerified: true });
    expect(db.clearRuntimeData).not.toHaveBeenCalled();
    expect(db.openWorkspaceDb).toHaveBeenLastCalledWith(first.workspaceKey);
  });

  it('opens newly created PG workspaces on the home route with all scopes selected', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      selectedBoardId: 'old-scope-id',
      selectedChannelId: 'old-channel-id',
      activeThreadId: 'old-thread-id',
      selectedDocType: 'document',
      selectedDocId: 'old-doc-id',
      selectedReportId: 'old-report-id',
      activeOpportunityId: 'old-opportunity-id',
      readStoredTaskBoardId: vi.fn(() => 'old-scope-id'),
    });

    await store.selectWorkspace(workspace.workspaceKey, { pgVerified: true, openWorkspaceHome: true });

    expect(store.navSection).toBe('status');
    expect(store.selectedBoardId).toBe('__all__');
    expect(store.persistSelectedBoardId).toHaveBeenCalledWith('__all__');
    expect(store.selectedChannelId).toBeNull();
    expect(store.pgContextSelectedChannelId).toBeNull();
    expect(store.pgContextSelectedThreadId).toBeNull();
    expect(store.selectedDocType).toBeNull();
    expect(store.selectedDocId).toBeNull();
    expect(store.selectedReportId).toBeNull();
    expect(store.activeOpportunityId).toBeNull();
    expect(store.showBoardDescendantTasks).toBe(false);
    expect(store.taskViewMode).toBe('kanban');
    expect(store.taskSortMode).toBe('manual');
    expect(store.closeThread).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.closeTaskDetail).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledWith(true);
  });

  it('uses workspace initials instead of the owner Nostr avatar when no workspace avatar is set', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      name: 'Test 2',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const getSenderAvatar = vi.fn(() => 'https://nostr.example/avatar.png');
    const ensureWorkspaceProfileHydrated = vi.fn();
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      getSenderAvatar,
      ensureWorkspaceProfileHydrated,
    });

    expect(store.getWorkspaceAvatar(workspace)).toBeNull();
    expect(getSenderAvatar).not.toHaveBeenCalled();
    expect(ensureWorkspaceProfileHydrated).toHaveBeenCalledWith(workspace.workspaceKey);
    expect(store.getWorkspaceInitials(workspace)).toBe('TE');
  });

  it('reverifies a cached same-signer PG workspace before selecting it after reload', async () => {
    const descriptor = {
      type: 'wingman_workspace_locator',
      tower_base_url: 'https://tower.example',
      identity: {
        tower_service_npub: 'npub1tower',
        workspace_service_npub: 'npub1workspace',
        workspace_owner_npub: 'npub1owner',
        workspace_id: 'workspace-1',
        app_npub: 'flightdeck_pg',
      },
    };
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      towerServiceNpub: 'npub1tower',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      appNpub: 'flightdeck_pg',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgDescriptor: descriptor,
    };
    const verifiedWorkspace = { ...workspace, pgMe: { actor: { npub: 'npub1user' } } };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      verifyPgDescriptor: vi.fn().mockResolvedValue({
        descriptor,
        me: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
      }),
      rememberVerifiedPgWorkspace: vi.fn(function remember() {
        this.knownWorkspaces = [verifiedWorkspace];
        return verifiedWorkspace;
      }),
    });

    store.verifyPgDescriptor.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await store.selectWorkspace(workspace.workspaceKey);
    expect(store.workspaceSelectionError).toContain('Failed to fetch');
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();

    await store.selectWorkspace(workspace.workspaceKey);
    expect(store.workspaceSelectionError).toBe('');

    expect(store.verifyPgDescriptor).toHaveBeenCalledWith(descriptor, {
      baseUrl: 'https://tower.example',
    });
    expect(store.rememberVerifiedPgWorkspace).toHaveBeenCalledWith(
      descriptor,
      { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
    );
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(store.currentWorkspaceOwnerNpub).toBe('npub1owner');
  });

  it('can restore a cached PG workspace locally before remote verification', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const loadLocalWorkspaceCoreData = vi.fn().mockResolvedValue({ scopes: [], channels: [] });
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      verifyPgDescriptor: vi.fn(),
      rememberVerifiedPgWorkspace: vi.fn(),
      loadLocalWorkspaceCoreData,
    });

    await store.selectWorkspace(workspace.workspaceKey, { refresh: false, skipPgVerification: true });

    expect(store.verifyPgDescriptor).not.toHaveBeenCalled();
    expect(loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.localWorkspaceCoreLoadedForKey).toBe(workspace.workspaceKey);
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(store.currentWorkspaceOwnerNpub).toBe('npub1owner');
  });

  it('clears stale chat state when a newly selected PG workspace was preselected by connect flow', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1newworkspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      localWorkspaceCoreLoadedForKey: 'pg:npub1user::tower:npub1tower::workspace:npub1oldworkspace::app:flightdeck_pg',
      selectedChannelId: 'old-channel',
      activeThreadId: 'old-thread',
      selectedBoardId: '__pg_thread__:old-channel:old-thread',
      channels: [{ record_id: 'old-channel' }],
      messages: [{ record_id: 'old-message', channel_id: 'old-channel' }],
      loadLocalWorkspaceCoreData: vi.fn().mockResolvedValue({ scopes: [], channels: [] }),
      closeThread: vi.fn(),
      stopSelectedChannelLiveQuery: vi.fn(),
    });

    await store.selectWorkspace(workspace.workspaceKey, { pgVerified: true });

    expect(store.selectedChannelId).toBeNull();
    expect(store.pgContextSelectedChannelId).toBeNull();
    expect(store.pgContextSelectedThreadId).toBeNull();
    expect(store.channels).toEqual([]);
    expect(store.messages).toEqual([]);
    expect(store.closeThread).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.stopSelectedChannelLiveQuery).toHaveBeenCalled();
  });

  it('clears stale runtime rows when a created PG workspace was preselected before opening home', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1createdworkspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      localWorkspaceCoreLoadedForKey: '',
      selectedChannelId: 'old-channel',
      activeThreadId: 'old-thread',
      selectedBoardId: '__pg_thread__:old-channel:old-thread',
      channels: [{ record_id: 'old-channel' }],
      messages: [{ record_id: 'old-message', channel_id: 'old-channel' }],
      documents: [{ record_id: 'old-doc' }],
      tasks: [{ record_id: 'old-task' }],
      loadLocalWorkspaceCoreData: vi.fn().mockResolvedValue({ scopes: [], channels: [] }),
      closeThread: vi.fn(),
      stopSelectedChannelLiveQuery: vi.fn(),
    });

    await store.selectWorkspace(workspace.workspaceKey, { pgVerified: true, openWorkspaceHome: true });

    expect(store.navSection).toBe('status');
    expect(store.selectedBoardId).toBe('__all__');
    expect(store.selectedChannelId).toBeNull();
    expect(store.pgContextSelectedChannelId).toBeNull();
    expect(store.pgContextSelectedThreadId).toBeNull();
    expect(store.channels).toEqual([]);
    expect(store.messages).toEqual([]);
    expect(store.documents).toEqual([]);
    expect(store.tasks).toEqual([]);
    expect(store.closeThread).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.stopSelectedChannelLiveQuery).toHaveBeenCalled();
    expect(store.loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.localWorkspaceCoreLoadedForKey).toBe(workspace.workspaceKey);
    expect(store.syncRoute).toHaveBeenCalledWith(true);
  });

  it('keeps known same-workspace channels visible while reopening home and verifying the session', async () => {
    const workspace = { workspaceKey: 'pg:alpha', workspaceId: 'alpha', workspaceOwnerNpub: 'npub1owner', pgBackendMode: true };
    let release;
    const channels = [{ record_id: 'known-channel', scope_id: 'known-scope' }];
    const scopes = [{ record_id: 'known-scope' }];
    const store = await buildStore({ knownWorkspaces: [workspace], selectedWorkspaceKey: workspace.workspaceKey,
      localWorkspaceCoreLoadedForKey: workspace.workspaceKey, channels, scopes,
      ensureWorkspaceSessionKey: vi.fn(() => new Promise(resolve => { release = resolve; })),
      loadLocalWorkspaceCoreData: vi.fn(),
    });
    const selecting = store.selectWorkspace(workspace.workspaceKey, { pgVerified: true, openWorkspaceHome: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(store.channels).toEqual(channels);
    expect(store.scopes).toEqual(scopes);
    release();
    await selecting;
    expect(store.channels).toEqual(channels);
    expect(store.scopes).toEqual(scopes);
    expect(store.loadLocalWorkspaceCoreData).not.toHaveBeenCalled();
    expect(store.navSection).toBe('status');
  });

  it('does not reload local PG core data when selecting the same already-loaded workspace', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const loadLocalWorkspaceCoreData = vi.fn().mockResolvedValue({ scopes: [], channels: [] });
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      localWorkspaceCoreLoadedForKey: workspace.workspaceKey,
      loadLocalWorkspaceCoreData,
    });

    await store.selectWorkspace(workspace.workspaceKey, { refresh: false, pgVerified: true });

    expect(loadLocalWorkspaceCoreData).not.toHaveBeenCalled();
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalled();
  });

  it('uploads PG workspace avatars without requiring a legacy admin group ref', async () => {
    const api = await import('../src/api.js');
    const db = await import('../src/db.js');
    api.uploadStorageObject.mockResolvedValue({ object_id: 'storage-avatar-1' });
    api.completeStorageObject.mockResolvedValue({ object_id: 'storage-avatar-1' });
    db.cacheStorageImage.mockResolvedValue(undefined);

    const workspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      workspaceId: 'workspace-1',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgMe: { permissions: ['workspace.manage'] },
    };
    const prepareStorageObjectForCurrentWorkspace = vi.fn().mockResolvedValue({
      object_id: 'storage-avatar-1',
      upload_url: '',
    });
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' },
      groups: [],
      prepareStorageObjectForCurrentWorkspace,
      defaultPastedImageName: vi.fn(() => 'workspace-avatar.png'),
      sha256HexForBytes: vi.fn().mockResolvedValue('sha256-avatar'),
      rememberStorageImageUrl: vi.fn(),
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' });

    const result = await store.uploadWorkspaceAvatarFile(file);

    expect(result).toBe('storage://storage-avatar-1');
    expect(prepareStorageObjectForCurrentWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub1owner',
      is_public: true,
      content_type: 'image/png',
      file_name: 'workspace-avatar.png',
      metadata: {
        purpose: 'workspace-profile/avatar',
        visibility: 'public',
        workspace_id: 'workspace-1',
      },
    }));
    expect(prepareStorageObjectForCurrentWorkspace.mock.calls[0][0]).not.toHaveProperty('owner_group_id');
    expect(prepareStorageObjectForCurrentWorkspace.mock.calls[0][0]).not.toHaveProperty('access_group_ids');
    expect(api.uploadStorageObject).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'storage-avatar-1' }),
      expect.any(Uint8Array),
      'image/png',
      { baseUrl: 'https://tower.example' },
    );
    expect(api.completeStorageObject).toHaveBeenCalledWith(
      'storage-avatar-1',
      { size_bytes: 3, sha256_hex: 'sha256-avatar' },
      { baseUrl: 'https://tower.example' },
    );
  });

  describe.each([
    ['network', new TypeError('Failed to fetch')],
    ['native signer', new Error('FormatException: secret key must be 32-byte hex or nsec')],
    ['unauthorized', Object.assign(new Error('Unauthorized'), { status: 401 })],
    ['forbidden', Object.assign(new Error('Forbidden'), { status: 403 })],
  ])('%s verification recovery', (_label, failure) => {
    it.each(['same selection', 'different selection', 'no selection'])(
      'preserves saved state and refuses activation during %s', async (scenario) => {
        const db = await import('../src/db.js');
        const keys = await import('../src/crypto/workspace-keys.js');
        const saved = {
          workspaceKey: 'pg:saved', workspaceOwnerNpub: 'npub1owner',
          workspaceServiceNpub: 'npub1saved', workspaceId: 'saved',
          directHttpsUrl: 'https://tower.example', pgSessionNpub: 'npub1user', pgBackendMode: true,
        };
        const other = { ...saved, workspaceKey: 'pg:other', workspaceServiceNpub: 'npub1other', workspaceId: 'other' };
        const selected = scenario === 'no selection' ? '' : saved.workspaceKey;
        const owner = selected ? saved.workspaceOwnerNpub : '';
        const messages = [{ record_id: 'cached-message' }];
        const tasks = [{ record_id: 'cached-task', sync_status: 'pending' }];
        const store = await buildStore({
          knownWorkspaces: [saved, other], selectedWorkspaceKey: selected,
          currentWorkspaceOwnerNpub: owner, messages, tasks,
          selectedChannelId: 'cached-channel', activeThreadId: 'cached-thread',
          localWorkspaceCoreLoadedForKey: selected,
          showConnectModal: false, showWorkspaceBootstrapModal: false,
          verifyPgDescriptor: vi.fn().mockRejectedValue(failure),
          rememberVerifiedPgWorkspace: vi.fn(),
          publishPgWorkspaceSelfIndexTombstone: vi.fn(),
          disposeTowerSyncService: vi.fn(),
        });

        await store.selectWorkspace(scenario === 'different selection' ? other.workspaceKey : saved.workspaceKey,
          scenario === 'startup refresh' ? { refresh: false } : {});
        store.updateWorkspaceBootstrapPrompt();

        expect(store.selectedWorkspaceKey).toBe(selected);
        expect(store.currentWorkspaceOwnerNpub).toBe(owner);
        expect(store.knownWorkspaces).toEqual([saved, other]);
        expect(store.messages).toBe(messages);
        expect(store.tasks).toBe(tasks);
        expect(store.selectedChannelId).toBe('cached-channel');
        expect(store.activeThreadId).toBe('cached-thread');
        expect(store.localWorkspaceCoreLoadedForKey).toBe(selected);
        expect(store.showConnectModal).toBe(false);
        expect(store.showWorkspaceBootstrapModal).toBe(false);
        expect(store.workspaceSelectionError).toContain(failure.message);
        expect(store.workspaceSelectionError).toContain('select the workspace again to retry');
        expect(store.persistWorkspaceSettings).not.toHaveBeenCalled();
        expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
        expect(store.ensureWorkspaceSessionKey).not.toHaveBeenCalled();
        expect(store.startWorkspaceLiveQueries).not.toHaveBeenCalled();
        expect(store.stopWorkspaceLiveQueries).not.toHaveBeenCalled();
        expect(store.disposeTowerSyncService).not.toHaveBeenCalled();
        expect(store.publishPgWorkspaceSelfIndexTombstone).not.toHaveBeenCalled();
        expect(db.openWorkspaceDb).not.toHaveBeenCalled();
        expect(db.clearRuntimeData).not.toHaveBeenCalled();
        expect(db.deleteWorkspaceDb).not.toHaveBeenCalled();
        expect(keys.clearActiveWorkspaceKey).not.toHaveBeenCalled();
        expect(keys.removeCachedWorkspaceKeyBlob).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    new TypeError('Failed to fetch'),
    new DOMException('The operation timed out', 'TimeoutError'),
    Object.assign(new Error('Bad gateway'), { status: 502 }),
  ])('hydrates the saved workspace on refresh after a transient failure: %s', async (failure) => {
    const workspace = {
      workspaceKey: 'pg:saved', workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example', pgSessionNpub: 'npub1user', pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace], selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      verifyPgDescriptor: vi.fn().mockRejectedValue(failure),
      rememberVerifiedPgWorkspace: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn().mockResolvedValue(undefined),
    });
    await store.selectWorkspace(workspace.workspaceKey, { refresh: false });
    expect(store.loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalled();
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(store.superbasedError).toContain('Updates unavailable');
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
  });

  it.each([401, 403])('does not restore cached access after HTTP %s on refresh', async (status) => {
    const workspace = { workspaceKey: 'pg:saved', pgBackendMode: true, pgSessionNpub: 'npub1user' };
    const store = await buildStore({
      selectedWorkspaceKey: workspace.workspaceKey,
      verifyPgWorkspaceForSelection: vi.fn().mockRejectedValue(Object.assign(new Error('Denied'), { status })),
    });
    await expect(store.ensurePgWorkspaceAvailable(workspace, { allowCached: true })).rejects.toThrow('Denied');
  });

  it('rejects a cached PG workspace scoped to a different signer before Tower calls', async () => {
    const workspace = {
      workspaceKey: 'pg:npub1other::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1other',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [workspace],
      selectedWorkspaceKey: workspace.workspaceKey,
      verifyPgDescriptor: vi.fn(),
      rememberVerifiedPgWorkspace: vi.fn(),
    });

    await store.selectWorkspace(workspace.workspaceKey);

    expect(store.verifyPgDescriptor).not.toHaveBeenCalled();
    expect(store.selectedWorkspaceKey).toBe('');
    expect(store.currentWorkspaceOwnerNpub).toBe('');
    expect(store.showWorkspaceBootstrapModal).toBe(false);
    expect(store.showConnectModal).toBe(true);
  });

  it('forgets an exact descriptor 404, clears its key and DB, and selects only a verified fallback', async () => {
    const db = await import('../src/db.js');
    const workspaceKeys = await import('../src/crypto/workspace-keys.js');
    const stale = {
      workspaceKey: 'pg:stale',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1stale',
      workspaceId: 'workspace-stale',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgDescriptor: { identity: { workspace_id: 'workspace-stale' } },
    };
    const fallback = {
      ...stale,
      workspaceKey: 'pg:fallback',
      workspaceServiceNpub: 'npub1fallback',
      workspaceId: 'workspace-fallback',
      pgDescriptor: { identity: { workspace_id: 'workspace-fallback' } },
    };
    const keyBootstrapWorkspaces = [];
    const missing = Object.assign(new Error('Tower PG API 404'), { status: 404 });
    const store = await buildStore({
      knownWorkspaces: [stale, fallback],
      selectedWorkspaceKey: stale.workspaceKey,
      currentWorkspaceOwnerNpub: stale.workspaceOwnerNpub,
      stopBackgroundSync: vi.fn(),
      verifyPgDescriptor: vi.fn(async (input) => {
        if (input.identity?.workspace_id === 'workspace-stale') throw missing;
        return {
          descriptor: fallback.pgDescriptor,
          me: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
        };
      }),
      rememberVerifiedPgWorkspace: vi.fn().mockResolvedValue(fallback),
      publishPgWorkspaceSelfIndexTombstone: vi.fn().mockResolvedValue(null),
      ensureWorkspaceSessionKey: vi.fn(function ensureKey() {
        keyBootstrapWorkspaces.push(this.currentWorkspace?.workspaceServiceNpub);
      }),
    });

    await store.selectWorkspace(stale.workspaceKey);
    await expect(store.ensurePgWorkspaceAvailable(stale)).resolves.toBeNull();

    expect(store.verifyPgDescriptor).toHaveBeenCalledTimes(2);
    expect(store.knownWorkspaces).toEqual([fallback]);
    expect(store.selectedWorkspaceKey).toBe(fallback.workspaceKey);
    expect(keyBootstrapWorkspaces).toEqual(['npub1fallback']);
    expect(workspaceKeys.clearActiveWorkspaceKey).toHaveBeenCalled();
    expect(workspaceKeys.removeCachedWorkspaceKeyBlob).toHaveBeenCalledWith('npub1stale');
    expect(db.deleteWorkspaceDb).toHaveBeenCalledWith(stale.workspaceKey);
    expect(store.publishPgWorkspaceSelfIndexTombstone).toHaveBeenCalledWith(stale, {
      towerResult: 'workspace_not_found',
      reason: 'descriptor_not_found',
    });
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it.each([
    ['network error', new TypeError('Failed to fetch')],
    ['timeout', Object.assign(new Error('Timed out'), { name: 'AbortError' })],
    ['Tower 500', Object.assign(new Error('Tower PG API 500'), { status: 500 })],
    ['Tower 403', Object.assign(new Error('Tower PG API 403'), { status: 403 })],
  ])('keeps a remembered workspace after %s', async (_label, failure) => {
    const db = await import('../src/db.js');
    const workspaceKeys = await import('../src/crypto/workspace-keys.js');
    const remembered = {
      workspaceKey: 'pg:remembered',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const store = await buildStore({
      knownWorkspaces: [remembered],
      selectedWorkspaceKey: remembered.workspaceKey,
      verifyPgDescriptor: vi.fn().mockRejectedValue(failure),
      rememberVerifiedPgWorkspace: vi.fn(),
      publishPgWorkspaceSelfIndexTombstone: vi.fn(),
    });

    await expect(store.ensurePgWorkspaceAvailable(remembered)).rejects.toBe(failure);

    expect(store.knownWorkspaces).toEqual([remembered]);
    expect(db.deleteWorkspaceDb).not.toHaveBeenCalled();
    expect(workspaceKeys.removeCachedWorkspaceKeyBlob).not.toHaveBeenCalled();
    expect(store.publishPgWorkspaceSelfIndexTombstone).not.toHaveBeenCalled();
  });

  it('clears PG workspaces that Tower no longer verifies', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const descriptor = {
      type: 'wingman_workspace_locator',
      tower_base_url: 'https://tower.example',
      identity: {
        tower_service_npub: 'npub1tower',
        workspace_service_npub: 'npub1workspace',
        workspace_owner_npub: 'npub1owner',
        workspace_id: 'workspace-1',
        app_npub: 'flightdeck_pg',
      },
    };
    const kept = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      towerServiceNpub: 'npub1tower',
      workspaceServiceNpub: 'npub1workspace',
      workspaceId: 'workspace-1',
      appNpub: 'flightdeck_pg',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgDescriptor: descriptor,
    };
    const stale = {
      ...kept,
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1stale::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1staleowner',
      workspaceServiceNpub: 'npub1stale',
      workspaceId: 'workspace-stale',
      name: 'Removed workspace',
      pgDescriptor: {
        ...descriptor,
        identity: {
          ...descriptor.identity,
          workspace_service_npub: 'npub1stale',
          workspace_owner_npub: 'npub1staleowner',
          workspace_id: 'workspace-stale',
        },
      },
    };
    const store = await buildStore({
      knownWorkspaces: [kept, stale],
      selectedWorkspaceKey: kept.workspaceKey,
      appManagementCleanupBusy: false,
      appManagementCleanupMessage: '',
      appManagementCleanupError: '',
      verifyPgDescriptor: vi.fn(async (input) => {
        if (input.identity?.workspace_id === 'workspace-stale') {
          throw Object.assign(new Error('Tower PG API 404'), { status: 404 });
        }
        return {
          descriptor,
          me: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
        };
      }),
      rememberVerifiedPgWorkspace: vi.fn().mockResolvedValue(kept),
      publishPgWorkspaceSelfIndexTombstone: vi.fn().mockResolvedValue(null),
    });

    const summary = await store.clearUnavailablePgWorkspaces();

    expect(summary).toMatchObject({ checked: 2, kept: 1, removed: 1 });
    expect(store.knownWorkspaces).toHaveLength(1);
    expect(store.knownWorkspaces[0].workspaceKey).toBe(kept.workspaceKey);
    expect(store.publishPgWorkspaceSelfIndexTombstone).toHaveBeenCalledWith(stale, {
      towerResult: 'workspace_not_found',
      reason: 'app_management_cleanup',
    });
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
    expect(store.appManagementCleanupMessage).toContain('Removed 1 unavailable workspace');
  });
});

describe('legacy recovery notice activation', () => {
  it('checks each startup/selection and rejects late checks from earlier activations', async () => {
    const workers = [];
    vi.stubGlobal('Worker', class {
      constructor() { workers.push(this); }
      postMessage() {}
      terminate() {}
    });
    try {
      const { normalizeWorkspaceEntry } = await import('../src/workspaces.js');
      const alpha = normalizeWorkspaceEntry({ workspaceId: 'alpha', workspaceOwnerNpub: 'owner', workspaceServiceNpub: 'service', towerServiceNpub: 'tower', pgSessionNpub: 'npub1user', pgBackendMode: true });
      const beta = normalizeWorkspaceEntry({ ...alpha, workspaceId: 'beta' });
      const store = await buildStore({ knownWorkspaces: [alpha, beta] });
      store.syncWorkspaceProfileDraft = vi.fn();
      await store.selectWorkspace(alpha.workspaceKey, { pgVerified: true });
      workers[0].onmessage({ data: { status: 'required' } });
      await Promise.resolve();
      expect(store.legacyWorkspaceRecoveryNotice).toContain('unsynced edits');
      await store.selectWorkspace(beta.workspaceKey, { pgVerified: true });
      expect(store.legacyWorkspaceRecoveryNotice).toBe('');
      await store.selectWorkspace(alpha.workspaceKey, { pgVerified: true });
      workers[2].onmessage({ data: { status: 'clear' } });
      workers[1].onmessage({ data: { status: 'required' } });
      await Promise.resolve();
      expect(store.legacyWorkspaceRecoveryNotice).toBe('');
      expect(workers).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
