import { describe, expect, it, vi } from 'vitest';
import { isTowerPgBackendMode } from '../src/backend-mode.js';
vi.mock('../src/backend-mode.js', () => ({ isTowerPgBackendMode: vi.fn(() => true) }));
import { connectSettingsManagerMixin } from '../src/connect-settings-manager.js';

function createStore(overrides = {}) {
  const store = {
    session: null,
    backendUrl: '',
    ownerNpub: '',
    botNpub: '',
    superbasedTokenInput: '',
    superbasedError: null,
    useCvmSync: false,
    knownHosts: [],
    knownWorkspaces: [],
    currentWorkspaceOwnerNpub: '',
    defaultAgentNpub: '',
    defaultAgentQuery: '',
    workspaceHarnessAgentNpub: '',
    workspaceHarnessAgents: [],
    wingmanHarnessDraftAgentNpub: '',
    wingmanHarnessAgentQuery: '',
    wingmanHarnessInput: '',
    wingmanHarnessDirty: false,
    wingmanHarnessError: null,
    showAvatarMenu: false,
    showConnectModal: false,
    connectStep: 1,
    connectHostUrl: '',
    connectHostLabel: '',
    connectHostServiceNpub: '',
    connectHostTowerName: '',
    connectHostTowerDescription: '',
    connectHostError: null,
    connectHostBusy: false,
    connectManualUrl: '',
    connectWorkspaces: [],
    connectWorkspacesBusy: false,
    connectWorkspacesError: null,
    connectNewWorkspaceName: '',
    connectNewWorkspaceDescription: '',
    connectCreatingWorkspace: false,
    connectTokenInput: '',
    connectShowTokenFallback: false,
    showWorkspaceSwitcherMenu: false,
    mobileNavOpen: false,
    showAgentConfigModal: false,
    agentConnectJson: '',
    agentConfigCopied: false,
    presetConnecting: false,
    error: null,
    // Stubs
    persistWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    ensureBackgroundSync: vi.fn(),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    mergeKnownWorkspaces: vi.fn(),
    loadRemoteWorkspaces: vi.fn().mockResolvedValue(undefined),
    tryRecoverWorkspace: vi.fn().mockResolvedValue(undefined),
    updateWorkspaceBootstrapPrompt: vi.fn(),
    rememberPeople: vi.fn().mockResolvedValue(undefined),
    resolveChatProfile: vi.fn(),
    refreshKnownHostsMetadata: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  const descriptors = Object.getOwnPropertyDescriptors(connectSettingsManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }
  return store;
}

function bindMethod(methodName, overrides = {}) {
  const store = createStore(overrides);
  const method = store[methodName];
  if (typeof method === 'function') return { fn: method.bind(store), store };
  return { store };
}

// --- settings ---
describe('settings methods', () => {
  it('handleHarnessInput updates the unsaved add-entry draft', () => {
    const { fn, store } = bindMethod('handleHarnessInput', {
      wingmanHarnessInput: '',
      wingmanHarnessDirty: false,
      wingmanHarnessError: 'old',
    });
    fn('https://harness.example.com');
    expect(store.wingmanHarnessInput).toBe('https://harness.example.com');
    expect(store.wingmanHarnessDirty).toBe(false);
    expect(store.wingmanHarnessError).toBeNull();
  });

  it('handleDefaultAgentInput updates query', () => {
    const { fn, store } = bindMethod('handleDefaultAgentInput', {
      defaultAgentQuery: '',
    });
    fn('some-query');
    expect(store.defaultAgentQuery).toBe('some-query');
  });

  it('handleHarnessAgentInput updates the add-entry query without changing the saved list', () => {
    const { fn, store } = bindMethod('handleHarnessAgentInput', {
      wingmanHarnessAgentQuery: '',
      wingmanHarnessDirty: false,
      wingmanHarnessError: 'old',
    });
    fn('Agent B');
    expect(store.wingmanHarnessAgentQuery).toBe('Agent B');
    expect(store.wingmanHarnessDirty).toBe(false);
    expect(store.wingmanHarnessError).toBeNull();
  });

  it('selectHarnessAgent resolves the add-entry draft without changing the legacy primary', async () => {
    const { fn, store } = bindMethod('selectHarnessAgent');
    await fn('npub1agent');
    expect(store.wingmanHarnessDraftAgentNpub).toBe('npub1agent');
    expect(store.workspaceHarnessAgentNpub).toBe('');
    expect(store.wingmanHarnessAgentQuery).toBe('');
    expect(store.wingmanHarnessDirty).toBe(false);
    expect(store.rememberPeople).toHaveBeenCalledWith(['npub1agent'], 'autopilot-agent');
    expect(store.persistWorkspaceSettings).not.toHaveBeenCalled();
  });

  it('adds, removes, and reorders Autopilot entries without losing exact order', async () => {
    const store = createStore({
      workspaceHarnessAgents: [
        { agent_npub: 'npub1testagent', url: 'https://testagent.example' },
        { agent_npub: 'npub1lara', url: 'https://lara.example' },
      ],
    });

    store.wingmanHarnessDraftAgentNpub = 'npub1longname';
    store.wingmanHarnessInput = 'long.example';
    expect(store.addHarnessAgent()).toBe(true);
    expect(store.workspaceHarnessAgents.map((entry) => entry.agent_npub)).toEqual([
      'npub1testagent', 'npub1lara', 'npub1longname',
    ]);
    expect(store.workspaceHarnessAgents[2].url).toBe('https://long.example');

    store.moveHarnessAgent(2, 'up');
    expect(store.workspaceHarnessAgents.map((entry) => entry.agent_npub)).toEqual([
      'npub1testagent', 'npub1longname', 'npub1lara',
    ]);
    store.removeHarnessAgent(0);
    expect(store.workspaceHarnessAgents.map((entry) => entry.agent_npub)).toEqual([
      'npub1longname', 'npub1lara',
    ]);
    expect(store.wingmanHarnessDirty).toBe(true);
  });

  it('rejects duplicate agents and unsafe Autopilot URLs', () => {
    const store = createStore({
      workspaceHarnessAgents: [{ agent_npub: 'npub1testagent', url: 'https://testagent.example' }],
      wingmanHarnessDraftAgentNpub: 'npub1testagent',
      wingmanHarnessInput: 'https://other.example',
    });
    expect(store.addHarnessAgent()).toBe(false);
    expect(store.wingmanHarnessError).toContain('already');

    store.wingmanHarnessDraftAgentNpub = 'npub1lara';
    store.wingmanHarnessInput = 'javascript:alert(1)';
    expect(store.addHarnessAgent()).toBe(false);
    expect(store.isHarnessAgentUrlValid('javascript:alert(1)')).toBe(false);
  });

  it('handleDefaultAgentInput resolves profile for npub-like input', () => {
    const resolveChatProfile = vi.fn();
    const { fn } = bindMethod('handleDefaultAgentInput', {
      defaultAgentQuery: '',
      resolveChatProfile,
    });
    fn('npub1abcdefghijklmnopqrst');
    expect(resolveChatProfile).toHaveBeenCalledWith('npub1abcdefghijklmnopqrst');
  });

  it('selectDefaultAgent sets npub and persists', async () => {
    const { fn, store } = bindMethod('selectDefaultAgent');
    await fn('npub1agent');
    expect(store.defaultAgentNpub).toBe('npub1agent');
    expect(store.defaultAgentQuery).toBe('');
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('clearDefaultAgent clears and persists', async () => {
    const { fn, store } = bindMethod('clearDefaultAgent', {
      defaultAgentNpub: 'npub1old',
      defaultAgentQuery: 'old',
    });
    await fn();
    expect(store.defaultAgentNpub).toBe('');
    expect(store.defaultAgentQuery).toBe('');
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('saveSettings calls setBaseUrl and persists', async () => {
    const { fn, store } = bindMethod('saveSettings', {
      backendUrl: 'https://backend.example.com',
    });
    await fn();
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
    expect(store.ensureBackgroundSync).toHaveBeenCalled();
  });
});

// --- connection settings ---
describe('saveConnectionSettings', () => {
  it('applies a valid legacy override draft only on save', async () => {
    vi.mocked(isTowerPgBackendMode).mockReturnValueOnce(false);
    const { fn, store } = bindMethod('saveConnectionSettings', {
      backendUrl: 'https://tower.example', backendOverrideDraft: 'https://alternate.example',
      saveSettings: vi.fn(),
    });
    vi.stubGlobal('localStorage', { setItem: vi.fn() });
    try {
      expect(store.backendUrl).toBe('https://tower.example');
      await fn();
      expect(store.backendUrl).toBe('https://alternate.example');
      expect(store.saveSettings).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps the PG descriptor authoritative rather than applying an override draft', async () => {
    const descriptor = '{"workspace_id":"fixture"}';
    const connectWithPgDescriptor = vi.fn();
    const { fn, store } = bindMethod('saveConnectionSettings', {
      backendUrl: 'https://tower.example', backendOverrideDraft: 'https://alternate.example',
      superbasedTokenInput: descriptor, connectWithPgDescriptor,
    });
    await fn();
    expect(store.backendUrl).toBe('https://tower.example');
    expect(connectWithPgDescriptor).toHaveBeenCalledWith(descriptor, { closeModal: false });
  });

  it.each(['http://node.fips:43100', 'https://node.fips:43100'])('rejects mesh overrides without changing the active backend: %s', async (endpoint) => {
    const { fn, store } = bindMethod('saveConnectionSettings', {
      backendOverrideDraft: endpoint, backendUrl: 'https://tower.example', saveSettings: vi.fn(),
    });
    await fn();
    expect(store.superbasedError).toContain('FIPS address');
    expect(store.backendUrl).toBe('https://tower.example');
    expect(store.saveSettings).not.toHaveBeenCalled();
  });

  it('rejects legacy or invalid connection tokens in PG-only mode', async () => {
    const { fn, store } = bindMethod('saveConnectionSettings', {
      superbasedTokenInput: 'bad-token',
    });
    await fn();
    expect(store.superbasedError).toBe('This Flight Deck build only accepts Tower PG workspace descriptors, not legacy connection tokens.');
  });

  it('requires a PG descriptor when saving connection settings directly', async () => {
    const { fn, store } = bindMethod('saveConnectionSettings', {
      superbasedTokenInput: '',
      backendUrl: '',
      session: { npub: 'npub1me' },
    });
    await fn();
    expect(store.superbasedError).toBe('Flight Deck PG requires a workspace descriptor. Connect through a Tower PG host or paste a descriptor.');
  });

  it('does not import tower metadata from legacy connection tokens in PG-only mode', async () => {
    const token = btoa(JSON.stringify({
      type: 'superbased_connection',
      version: 2,
      direct_https_url: 'https://tower.example',
      service_npub: 'npub1service',
      tower_name: 'Family Tower',
      tower_description: 'Shared family workspace host',
      workspace_owner_npub: 'npub1workspace',
    }));
    const { fn, store } = bindMethod('saveConnectionSettings', {
      superbasedTokenInput: token,
      session: { npub: 'npub1me' },
      mergeKnownWorkspaces: vi.fn(),
    });

    await fn();

    expect(store.knownHosts).toEqual([]);
    expect(store.mergeKnownWorkspaces).not.toHaveBeenCalled();
    expect(store.superbasedError).toBe('This Flight Deck build only accepts Tower PG workspace descriptors, not legacy connection tokens.');
  });
});

// --- connect modal ---
describe('connect modal', () => {
  it('openConnectModal initializes state', () => {
    const refreshKnownHostsMetadata = vi.fn().mockResolvedValue(undefined);
    const { fn, store } = bindMethod('openConnectModal', { refreshKnownHostsMetadata });
    fn();
    expect(store.showWorkspaceBootstrapModal).toBe(false);
    expect(store.showConnectModal).toBe(true);
    expect(store.connectStep).toBe(1);
    expect(store.connectHostUrl).toBe('');
    expect(store.connectHostTowerName).toBe('');
    expect(store.connectHostTowerDescription).toBe('');
    expect(store.connectHostBusy).toBe(false);
    expect(store.connectWorkspaces).toEqual([]);
    expect(refreshKnownHostsMetadata).toHaveBeenCalledTimes(1);
  });

  it('closeConnectModal closes when not busy', () => {
    const { fn, store } = bindMethod('closeConnectModal', {
      showConnectModal: true,
      connectHostBusy: false,
      connectWorkspacesBusy: false,
      connectCreatingWorkspace: false,
    });
    fn();
    expect(store.showConnectModal).toBe(false);
  });

  it('closeConnectModal blocked when busy', () => {
    const { fn, store } = bindMethod('closeConnectModal', {
      showConnectModal: true,
      connectHostBusy: true,
    });
    fn();
    expect(store.showConnectModal).toBe(true);
  });

  it('connectGoBack resets to step 1', () => {
    const { fn, store } = bindMethod('connectGoBack', {
      connectStep: 2,
      connectWorkspaces: [{ id: 'w1' }],
      connectNewWorkspaceName: 'Test',
    });
    fn();
    expect(store.connectStep).toBe(1);
    expect(store.connectWorkspaces).toEqual([]);
    expect(store.connectNewWorkspaceName).toBe('');
  });

  it('remembers a verified PG workspace descriptor in the existing workspace list', async () => {
    const mergeKnownWorkspaces = vi.fn(function merge(workspaces) {
      this.knownWorkspaces = workspaces;
    });
    const { fn, store } = bindMethod('rememberVerifiedPgWorkspace', {
      session: { npub: 'npub1user' },
      backendUrl: '',
      knownWorkspaces: [],
      mergeKnownWorkspaces,
    });
    const descriptor = {
      type: 'wingman_workspace_locator',
      version: 1,
      identity: {
        tower_service_npub: 'npub1tower',
        workspace_service_npub: 'npub1workspace_service',
        workspace_owner_npub: 'npub1owner',
        workspace_id: 'workspace-1',
        app_npub: 'flightdeck_pg',
      },
      tower_base_url: 'https://tower.example.com/',
      label: 'Wingmen',
      capabilities: ['pg_scopes'],
      links: {
        descriptor: '/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
        me: '/api/v4/flightdeck-pg/workspaces/workspace-1/me',
      },
    };

    const workspace = await fn(descriptor, { actor: { npub: 'npub1user' }, membership: { role: 'owner' } });

    expect(workspace).toMatchObject({
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace_service::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      name: 'Wingmen',
      directHttpsUrl: 'https://tower.example.com',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
      connectionToken: '',
    });
    expect(store.backendUrl).toBe('https://tower.example.com');
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(store.currentWorkspaceOwnerNpub).toBe('npub1owner');
    expect(store.ownerNpub).toBe('npub1owner');
    expect(store.superbasedTokenInput).toBe('');
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
    expect(mergeKnownWorkspaces).toHaveBeenCalledWith([workspace]);
  });

  it('does not let PG descriptor verification clear an existing workspace avatar', async () => {
    const existingWorkspace = {
      workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace_service::app:flightdeck_pg::id:workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      name: 'Wingmen',
      avatarUrl: 'storage://workspace-avatar-1',
      directHttpsUrl: 'https://tower.example.com',
      towerServiceNpub: 'npub1tower',
      workspaceServiceNpub: 'npub1workspace_service',
      workspaceId: 'workspace-1',
      appNpub: 'flightdeck_pg',
      pgSessionNpub: 'npub1user',
      pgBackendMode: true,
    };
    const mergeKnownWorkspaces = vi.fn(function merge(workspaces) {
      this.knownWorkspaces = workspaces;
    });
    const { fn } = bindMethod('rememberVerifiedPgWorkspace', {
      session: { npub: 'npub1user' },
      backendUrl: 'https://tower.example.com',
      knownWorkspaces: [existingWorkspace],
      mergeKnownWorkspaces,
    });
    const descriptor = {
      type: 'wingman_workspace_locator',
      version: 1,
      identity: {
        tower_service_npub: 'npub1tower',
        workspace_service_npub: 'npub1workspace_service',
        workspace_owner_npub: 'npub1owner',
        workspace_id: 'workspace-1',
        app_npub: 'flightdeck_pg',
      },
      tower_base_url: 'https://tower.example.com/',
      label: 'Wingmen',
    };

    const workspace = await fn(descriptor, { actor: { npub: 'npub1user' }, membership: { role: 'owner' } });

    expect(workspace.avatarUrl).toBe('storage://workspace-avatar-1');
    expect(mergeKnownWorkspaces).toHaveBeenCalledWith([
      expect.objectContaining({ avatarUrl: 'storage://workspace-avatar-1' }),
    ]);
  });
});

// --- known hosts ---
describe('known hosts', () => {
  it('addKnownHost adds new host', () => {
    const { fn, store } = bindMethod('addKnownHost', { knownHosts: [] });
    fn({ url: 'https://host.example.com', label: 'Test', serviceNpub: 'npub1svc' });
    expect(store.knownHosts).toHaveLength(1);
    expect(store.knownHosts[0].url).toBe('https://host.example.com');
  });

  it('addKnownHost updates existing host', () => {
    const { fn, store } = bindMethod('addKnownHost', {
      knownHosts: [{ url: 'https://host.example.com', label: 'Old', serviceNpub: '' }],
    });
    fn({
      url: 'https://host.example.com',
      label: 'New',
      serviceNpub: 'npub1svc',
      towerName: 'Tower Name',
      towerDescription: 'Private tower',
    });
    expect(store.knownHosts).toHaveLength(1);
    expect(store.knownHosts[0].label).toBe('Tower Name');
    expect(store.knownHosts[0].towerName).toBe('Tower Name');
    expect(store.knownHosts[0].towerDescription).toBe('Private tower');
  });

  it('addKnownHost strips trailing slashes', () => {
    const { fn, store } = bindMethod('addKnownHost', { knownHosts: [] });
    fn({ url: 'https://host.example.com///', label: 'Test', serviceNpub: '' });
    expect(store.knownHosts[0].url).toBe('https://host.example.com');
  });

  it('addKnownHost ignores empty URL', () => {
    const { fn, store } = bindMethod('addKnownHost', { knownHosts: [] });
    fn({ url: '', label: 'Test', serviceNpub: '' });
    expect(store.knownHosts).toHaveLength(0);
  });

  it('mergedHostsList includes defaults and custom', () => {
    const store = createStore({
      knownHosts: [{ url: 'https://custom.example.com', label: 'Custom', serviceNpub: '' }],
    });
    const merged = store.mergedHostsList;
    expect(merged.some((h) => h.url === 'https://custom.example.com')).toBe(true);
  });

  it('mergedHostsList deduplicates by URL', () => {
    const store = createStore({
      knownHosts: [
        { url: 'https://host.example.com', label: 'Original', serviceNpub: '' },
        { url: 'https://host.example.com', label: 'Updated', serviceNpub: 'npub1svc', towerName: 'Tower', towerDescription: 'Shared host' },
      ],
    });
    const merged = store.mergedHostsList;
    const matchingUrls = merged.filter((h) => h.url === 'https://host.example.com');
    expect(matchingUrls).toHaveLength(1);
    expect(matchingUrls[0]).toMatchObject({
      label: 'Tower',
      serviceNpub: 'npub1svc',
      towerName: 'Tower',
      towerDescription: 'Shared host',
    });
  });

  it('refreshKnownHostsMetadata fetches live tower metadata for known hosts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        status: 'ok',
        service_npub: 'npub1svc',
        tower_name: 'Managed Tower',
        tower_description: 'Managed on the server',
      }),
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      const store = createStore({
        knownHosts: [{ url: 'https://tower.example', label: 'https://tower.example', serviceNpub: '' }],
      });
      const fn = connectSettingsManagerMixin.refreshKnownHostsMetadata.bind(store);

      await fn();

      expect(fetchMock).toHaveBeenCalledWith('https://tower.example/health');
      expect(store.knownHosts).toContainEqual(expect.objectContaining({
        url: 'https://tower.example',
        label: 'Managed Tower',
        serviceNpub: 'npub1svc',
        towerName: 'Managed Tower',
        towerDescription: 'Managed on the server',
      }));
      expect(store.persistWorkspaceSettings).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// --- toggleCvmSync ---
describe('toggleCvmSync', () => {
  it('toggles useCvmSync', () => {
    const { fn, store } = bindMethod('toggleCvmSync', { useCvmSync: false });
    fn();
    expect(store.useCvmSync).toBe(true);
    fn();
    expect(store.useCvmSync).toBe(false);
  });
});

// --- agent connect ---
describe('agent connect', () => {
  it('showAgentConnect sets modal state', () => {
    const { fn, store } = bindMethod('showAgentConnect', {
      showAvatarMenu: true,
      backendUrl: 'https://backend.example.com',
      session: { npub: 'npub1me' },
    });
    fn();
    expect(store.showAvatarMenu).toBe(false);
    expect(store.showAgentConfigModal).toBe(true);
    expect(store.agentConfigCopied).toBe(false);
    expect(store.agentConnectJson).toBeTruthy();
  });

  it('closeAgentConnect closes modal', () => {
    const { fn, store } = bindMethod('closeAgentConnect', {
      showAgentConfigModal: true,
    });
    fn();
    expect(store.showAgentConfigModal).toBe(false);
  });

  it('copyContext writes the active Flight Deck context to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    const { fn, store } = bindMethod('copyContext', {
      showAvatarMenu: true,
      backendUrl: 'https://tower.example',
      session: { npub: 'npub1user' },
      currentWorkspace: {
        name: 'Operator A Workspace',
        towerName: 'Operator A Tower',
        directHttpsUrl: 'https://tower.example',
        workspaceId: 'workspace-123',
        workspaceKey: 'workspace-key-123',
        workspaceOwnerNpub: 'npub1owner',
      },
      currentWorkspaceName: 'Operator A Workspace',
      currentWorkspaceKey: 'workspace-key-123',
      workspaceOwnerNpub: 'npub1owner',
      pgContextScopeId: 'scope-123',
      pgContextScope: { record_id: 'scope-123', title: 'Build FD' },
      pgContextSelectedChannelId: 'channel-123',
      pgContextSelectedThreadId: 'thread-123',
      pgContextThreads: [{ id: 'thread-123', label: 'Context copy thread' }],
      selectedBoardLabel: 'Build FD',
      channels: [{ record_id: 'channel-123', title: 'Autopilot' }],
      getScopeBreadcrumb: vi.fn(() => 'Wingman / Build FD'),
      getChannelLabel: vi.fn(() => 'Autopilot'),
    });

    await fn();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Tower: Operator A Tower');
    expect(writeText.mock.calls[0][0]).toContain('Workspace ID: workspace-123');
    expect(writeText.mock.calls[0][0]).toContain('Scope ID: scope-123');
    expect(writeText.mock.calls[0][0]).toContain('Channel ID: channel-123');
    expect(writeText.mock.calls[0][0]).toContain('Thread ID: thread-123');
    expect(writeText.mock.calls[0][0]).toContain('User: npub1user');
    expect(store.showAvatarMenu).toBe(false);
  });
});

// --- loadConnectWorkspaces ---
describe('loadConnectWorkspaces', () => {
  it('sets error when not signed in', async () => {
    const { fn, store } = bindMethod('loadConnectWorkspaces', { session: null });
    await fn();
    expect(store.connectWorkspacesError).toBe('Sign in first');
  });
});

// --- connectCreateWorkspace ---
describe('connectCreateWorkspace', () => {
  it('sets error when not signed in', async () => {
    const { fn, store } = bindMethod('connectCreateWorkspace', { session: null });
    await fn();
    expect(store.connectWorkspacesError).toBe('Sign in first');
  });

  it('sets error for empty name', async () => {
    const { fn, store } = bindMethod('connectCreateWorkspace', {
      session: { npub: 'npub1me' },
      connectNewWorkspaceName: '',
    });
    await fn();
    expect(store.connectWorkspacesError).toBe('Workspace name is required');
  });
});
