import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLIGHT_DECK_PG_APP_NPUB } from '../src/app-identity.js';

const DEFAULT_BUILD_PG_APP_NPUB = FLIGHT_DECK_PG_APP_NPUB;

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => true),
}));

vi.mock('../src/api.js', () => ({
  setBaseUrl: vi.fn(),
  createTowerPgAdminWorkspace: vi.fn(),
  createTowerPgWorkspaceScope: vi.fn(),
  createTowerPgScopeChannel: vi.fn(),
  createWorkspace: vi.fn(),
  getWorkspaces: vi.fn(),
  getTowerPgService: vi.fn(),
  listTowerPgWorkspaces: vi.fn(),
  getTowerPgWorkspaceDescriptor: vi.fn(),
  getTowerPgWorkspaceMe: vi.fn(),
}));

const descriptor = {
  type: 'wingman_workspace_locator',
  version: 1,
  tower_base_url: 'https://tower.example',
  identity: {
    tower_service_npub: 'npub1tower',
    workspace_service_npub: 'npub1workspace',
    workspace_owner_npub: 'npub1owner',
    workspace_id: 'workspace-1',
    app_npub: 'flightdeck_pg',
  },
  label: 'Example Workspace',
  description: 'PG workspace',
  capabilities: ['pg_scopes', 'pg_tasks'],
  links: {
    descriptor: '/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
    me: '/api/v4/flightdeck-pg/workspaces/workspace-1/me',
  },
};

function createStore(overrides = {}) {
  return {
    session: { npub: 'npub1user' },
    backendUrl: '',
    ownerNpub: '',
    superbasedTokenInput: '',
    knownHosts: [],
    knownWorkspaces: [],
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    showConnectModal: true,
    connectWorkspacesError: null,
    connectWorkspacesBusy: false,
    persistWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    ensureBackgroundSync: vi.fn(),
    mergeKnownWorkspaces(entries) {
      this.knownWorkspaces = entries;
    },
    addKnownHost(host) {
      this.knownHosts.push(host);
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PG connect settings manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('verifies a pasted descriptor with signed descriptor and me calls before storing it', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore();
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.connectWithPgDescriptor(JSON.stringify(descriptor));

    expect(api.getTowerPgWorkspaceDescriptor).toHaveBeenCalledWith('workspace-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      path: '/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
    });
    expect(api.getTowerPgWorkspaceMe).toHaveBeenCalledWith('workspace-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      path: '/api/v4/flightdeck-pg/workspaces/workspace-1/me',
    });
    expect(store.knownWorkspaces[0]).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      pgDescriptor: descriptor,
      pgMe: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
    });
    expect(store.selectedWorkspaceKey).toBe('pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1');
    expect(store.selectWorkspace).toHaveBeenCalledWith(
      'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      { pgVerified: true },
    );
  });

  it('publishes a 33356 self-index after a verified PG descriptor is remembered', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const publishPgWorkspaceSelfIndex = vi.fn().mockResolvedValue(null);
    const store = createStore({ publishPgWorkspaceSelfIndex });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.connectWithPgDescriptor(JSON.stringify(descriptor));
    await Promise.resolve();

    expect(publishPgWorkspaceSelfIndex).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      pgBackendMode: true,
    }));
    expect(store.knownWorkspaces[0]).toMatchObject({
      workspaceOwnerNpub: 'npub1owner',
      pgBackendMode: true,
    });
  });

  it('does not republish a fresh 33356 self-index when a verified PG descriptor is refreshed', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const publishPgWorkspaceSelfIndex = vi.fn().mockResolvedValue(null);
    const shouldQueuePgWorkspaceSelfIndexPublish = vi.fn(() => false);
    const store = createStore({
      publishPgWorkspaceSelfIndex,
      shouldQueuePgWorkspaceSelfIndexPublish,
      knownWorkspaces: [{
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        towerServiceNpub: 'npub1tower',
        workspaceServiceNpub: 'npub1workspace',
        workspaceId: 'workspace-1',
        appNpub: 'flightdeck_pg',
        pgSessionNpub: 'npub1user',
        pgBackendMode: true,
        pgSelfIndexStatus: 'indexed',
        pgSelfIndexLastBroadcastAt: '2026-06-08T00:00:00.000Z',
        pgSelfIndexEventId: 'event-indexed',
        pgSelfIndexSignedEvent: { id: 'event-indexed' },
      }],
    });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.connectWithPgDescriptor(JSON.stringify(descriptor));
    await Promise.resolve();

    expect(shouldQueuePgWorkspaceSelfIndexPublish).toHaveBeenCalledWith(expect.objectContaining({
      pgSelfIndexStatus: 'indexed',
      pgSelfIndexEventId: 'event-indexed',
    }));
    expect(publishPgWorkspaceSelfIndex).not.toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'indexed',
      pgSelfIndexEventId: 'event-indexed',
      pgSelfIndexSignedEvent: { id: 'event-indexed' },
    });
  });

  it('opens a verified PG workspace without waiting for relay self-index publish', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const { workspaceSelfIndexManagerMixin } = await import('../src/workspace-self-index-manager.js');
    let rejectPublish;
    const publishPgWorkspaceSelfIndex = vi.fn(() => new Promise((resolve, reject) => {
      rejectPublish = reject;
    }));
    const store = createStore({ publishPgWorkspaceSelfIndex });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workspaceSelfIndexManagerMixin));
    store.publishPgWorkspaceSelfIndex = publishPgWorkspaceSelfIndex;

    const workspace = await store.connectWithPgDescriptor(JSON.stringify(descriptor));

    expect(workspace).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      pgSelfIndexStatus: 'pending',
    });
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'pending',
      pgSelfIndexError: null,
    });
    expect(store.showConnectModal).toBe(false);
    expect(store.selectWorkspace).toHaveBeenCalledWith(
      'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      { pgVerified: true },
    );

    await Promise.resolve();

    expect(publishPgWorkspaceSelfIndex).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: workspace.workspaceKey,
      pgSelfIndexStatus: 'pending',
    }));

    rejectPublish(new Error('relay unavailable'));
    await store.pgWorkspaceSelfIndexPublishPromise;
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'failed',
      pgSelfIndexError: 'relay unavailable',
    });
  });

  it('does not call Tower PG routes when no Nostr session exists', async () => {
    const api = await import('../src/api.js');
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore({ session: null });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await expect(store.connectWithPgDescriptor(JSON.stringify(descriptor))).rejects.toThrow('Sign in first');

    expect(api.getTowerPgWorkspaceDescriptor).not.toHaveBeenCalled();
    expect(api.getTowerPgWorkspaceMe).not.toHaveBeenCalled();
  });

  it('falls back to Tower-visible PG workspaces when the build app namespace lists none', async () => {
    const api = await import('../src/api.js');
    api.listTowerPgWorkspaces
      .mockResolvedValueOnce({
        workspaces: [],
        towerPgRequest: {
          method: 'GET',
          url: `https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=${DEFAULT_BUILD_PG_APP_NPUB}`,
          route: '/api/v4/flightdeck-pg/workspaces',
          query: `app_npub=${DEFAULT_BUILD_PG_APP_NPUB}`,
          body: null,
          appNpub: DEFAULT_BUILD_PG_APP_NPUB,
          appNpubSent: true,
          signerNpub: 'npub1user',
          usedWorkspaceKey: false,
          transportMode: 'https',
          httpStatus: 200,
          responseShape: { type: 'object', keys: ['workspaces'], workspacesCount: 0 },
        },
      })
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
          label: 'Existing Tower Workspace',
          description: 'Created under the Tower workspace namespace',
          links: descriptor.links,
        }],
        towerPgRequest: {
          method: 'GET',
          url: 'https://tower.example/api/v4/flightdeck-pg/workspaces',
          route: '/api/v4/flightdeck-pg/workspaces',
          query: '',
          body: null,
          appNpub: '',
          appNpubSent: false,
          signerNpub: 'npub1user',
          usedWorkspaceKey: false,
          transportMode: 'https',
          httpStatus: 200,
          responseShape: { type: 'object', keys: ['workspaces'], workspacesCount: 1 },
        },
      });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore({
      backendUrl: 'https://tower.example',
      connectHostUrl: 'https://tower.example',
      connectHostServiceNpub: 'npub1tower',
      connectWorkspaces: [],
    });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.loadConnectWorkspaces();

    expect(api.listTowerPgWorkspaces).toHaveBeenNthCalledWith(1, {
      baseUrl: 'https://tower.example',
      appNpub: DEFAULT_BUILD_PG_APP_NPUB,
      limit: undefined,
    });
    expect(api.listTowerPgWorkspaces).toHaveBeenNthCalledWith(2, {
      baseUrl: 'https://tower.example',
      appNpub: '',
      limit: undefined,
    });
    expect(store.connectWorkspaces).toHaveLength(1);
    expect(store.connectWorkspaces[0]).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1workspace',
      appNpub: 'flightdeck_pg',
      directHttpsUrl: 'https://tower.example',
      name: 'Existing Tower Workspace',
      pgBackendMode: true,
    });
    expect(store.connectWorkspacesError).toBeNull();
    expect(store.connectWorkspaceRequestDiagnostics).toMatchObject({
      screen: 'connect-modal-pg-workspace-picker',
      sessionNpub: 'npub1user',
      towerServiceNpub: 'npub1tower',
      responseWorkspaceCount: 1,
      mappedWorkspaceCount: 1,
      visibleWorkspaceCount: null,
      attempts: [
        expect.objectContaining({
          appNpub: DEFAULT_BUILD_PG_APP_NPUB,
          appNpubSent: true,
          signerNpub: 'npub1user',
          httpStatus: 200,
          responseShape: expect.objectContaining({ workspacesCount: 0 }),
        }),
        expect.objectContaining({
          appNpub: '',
          appNpubSent: false,
          signerNpub: 'npub1user',
          httpStatus: 200,
          responseShape: expect.objectContaining({ workspacesCount: 1 }),
        }),
      ],
    });
    expect(store.connectWorkspaceRequestSummary()).toContain('retry GET https://tower.example/api/v4/flightdeck-pg/workspaces');
    expect(store.connectWorkspaceRequestSummary()).toContain('without app_npub');
    expect(store.connectWorkspaceRequestSummary()).toContain('fetched 1; mapped 1; visible rows pending');
  });

  it('keeps same-owner PG workspaces distinct and verifies the selected descriptor', async () => {
    const api = await import('../src/api.js');
    const second = {
      ...descriptor,
      identity: { ...descriptor.identity, workspace_id: 'workspace-2', workspace_service_npub: 'npub1workspace2' },
      label: 'Second Workspace',
      links: {
        descriptor: '/api/v4/flightdeck-pg/workspaces/workspace-2/descriptor',
        me: '/api/v4/flightdeck-pg/workspaces/workspace-2/me',
      },
    };
    api.listTowerPgWorkspaces.mockResolvedValue({
      workspaces: [descriptor, second],
      towerPgRequest: {
        method: 'GET', url: 'https://tower.example/api/v4/flightdeck-pg/workspaces',
        appNpubSent: true, appNpub: DEFAULT_BUILD_PG_APP_NPUB,
        signerNpub: 'npub1user', transportMode: 'https', httpStatus: 200,
        responseShape: { workspacesCount: 2 },
      },
    });
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(second);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore({ backendUrl: 'https://tower.example', connectHostUrl: 'https://tower.example' });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.loadConnectWorkspaces();
    expect(store.connectWorkspaces.map((workspace) => workspace.workspaceId)).toEqual(['workspace-1', 'workspace-2']);
    expect(store.connectWorkspaces.map((workspace) => workspace.workspaceOwnerNpub)).toEqual(['npub1owner', 'npub1owner']);
    expect(store.connectWorkspaceRequestDiagnostics).toMatchObject({
      responseWorkspaceCount: 2, mappedWorkspaceCount: 2, visibleWorkspaceCount: null,
    });

    await store.connectSelectWorkspace(store.connectWorkspaces[1]);
    expect(api.getTowerPgWorkspaceDescriptor).toHaveBeenNthCalledWith(1, 'workspace-2', {
      baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg', path: second.links.descriptor,
    });
    expect(api.getTowerPgWorkspaceDescriptor).toHaveBeenNthCalledWith(2, 'workspace-2', {
      baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg', path: second.links.descriptor,
    });
    expect(api.getTowerPgWorkspaceMe).toHaveBeenCalledWith('workspace-2', {
      baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg', path: second.links.me,
    });
    expect(store.selectWorkspace).toHaveBeenCalledWith(
      'pg:npub1user::tower:npub1tower::workspace:npub1workspace2::app:flightdeck_pg::id:workspace-2',
      { pgVerified: true },
    );
    expect(store.showConnectModal).toBe(false);
    expect(api.createTowerPgAdminWorkspace).not.toHaveBeenCalled();
  });

  it('creates PG workspaces through Tower admin setup and connects with the returned descriptor', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgAdminWorkspace.mockResolvedValue({ descriptor });
    api.createTowerPgWorkspaceScope.mockResolvedValue({ scope: { id: 'scope-1' } });
    api.createTowerPgScopeChannel.mockResolvedValue({ channel: { id: 'channel-1' } });
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: 'npub1user' }, membership: { role: 'owner' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore({
      ownerNpub: 'npub1previousowner',
      currentWorkspaceOwnerNpub: 'npub1previousworkspace',
      signingNpub: 'npub1workspacekey',
      connectPgBootstrapTemplateId: 'test',
      connectPgBootstrapTemplates: [{ id: 'test', scopes: [{
        name: 'Projects', description: 'Current work', selected: true,
        channels: [{ name: 'General', selected: true }],
      }] }],
      connectHostUrl: 'https://tower.example',
      backendUrl: 'https://tower.example',
      connectNewWorkspaceName: 'Operator A docs',
      connectNewWorkspaceDescription: 'PG workspace',
      connectCreatingWorkspace: false,
    });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.connectCreateWorkspace();

    expect(api.createTowerPgAdminWorkspace).toHaveBeenCalledWith({
      creator_npub: 'npub1user',
      workspace_name: 'Operator A docs',
      workspace_description: 'PG workspace',
      app_npub: DEFAULT_BUILD_PG_APP_NPUB,
    }, {
      baseUrl: 'https://tower.example',
      appNpub: DEFAULT_BUILD_PG_APP_NPUB,
    });
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(api.createTowerPgWorkspaceScope).toHaveBeenCalledWith('workspace-1', {
      client_record_id: expect.any(String),
      name: 'Projects', description: 'Current work', kind: 'project',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-1', {
      client_record_id: expect.any(String),
      name: 'General', description: undefined, kind: 'channel',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.createTowerPgAdminWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(api.createTowerPgWorkspaceScope.mock.invocationCallOrder[0]);
    expect(api.getTowerPgWorkspaceDescriptor.mock.invocationCallOrder[0])
      .toBeLessThan(store.selectWorkspace.mock.invocationCallOrder[0]);
    expect(store.selectWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(api.createTowerPgWorkspaceScope.mock.invocationCallOrder[0]);
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgBackendMode: true,
      workspaceOwnerNpub: 'npub1owner',
    });
    expect(store.selectWorkspace).toHaveBeenCalledWith(
      'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
      { pgVerified: true, openWorkspaceHome: true },
    );
    expect(store.showConnectModal).toBe(false);
    expect(store.connectCreatingWorkspace).toBe(false);
    expect(store.connectWorkspacesError).toBeNull();
    expect(store.connectNewWorkspaceName).toBe('');
  });

  it.each([null, {}, { npub: '' }, { npub: '   ' }])('requires a personal identity before creating a workspace: %j', async (session) => {
    const api = await import('../src/api.js');
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore({
      session,
      ownerNpub: 'npub1owner',
      currentWorkspaceOwnerNpub: 'npub1workspace',
      signingNpub: 'npub1workspacekey',
      connectHostUrl: 'https://tower.example',
      connectNewWorkspaceName: 'New workspace',
      connectCreatingWorkspace: false,
    });
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await store.connectCreateWorkspace();

    expect(store.connectWorkspacesError).toBe('Sign in first');
    expect(store.connectCreatingWorkspace).toBe(false);
    expect(api.createTowerPgAdminWorkspace).not.toHaveBeenCalled();
    expect(api.createTowerPgWorkspaceScope).not.toHaveBeenCalled();
    expect(api.createTowerPgScopeChannel).not.toHaveBeenCalled();
    expect(api.getTowerPgWorkspaceDescriptor).not.toHaveBeenCalled();
    expect(store.selectWorkspace).not.toHaveBeenCalled();
  });

  it('adds custom bootstrap scopes and channels before creating a PG workspace', async () => {
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const store = createStore();
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));
    store.resetConnectPgBootstrapState();

    store.connectPgNewScopeName = 'Finance';
    store.connectPgAddBootstrapScope();
    expect(store.connectPgSelectedScope()).toMatchObject({
      name: 'Finance',
      selected: true,
    });

    store.connectPgNewChannelName = 'Budgets';
    store.connectPgAddBootstrapChannel();

    expect(store.connectPgBootstrapCounts()).toEqual({ scopes: 5, channels: 14 });
    expect(store.selectedConnectPgBootstrapScopes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Finance',
          channels: [expect.objectContaining({ name: 'Budgets' })],
        }),
      ]),
    );
  });
});
