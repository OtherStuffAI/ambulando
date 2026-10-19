import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';

vi.mock('../src/backend-mode.js', () => ({ isTowerPgBackendMode: vi.fn(() => true) }));
vi.mock('../src/hosted-workspace-signup.js', () => ({
  hostedSignupConfig: vi.fn(),
  hostedSignupIntent: vi.fn(),
  submitHostedSignup: vi.fn(),
}));
vi.mock('../src/api.js', () => ({
  setBaseUrl: vi.fn(),
  createWorkspace: vi.fn(),
  getWorkspaces: vi.fn(),
  getTowerPgService: vi.fn(),
  verifyPairedTowerWorkspace: vi.fn(),
  getTowerPgWorkspaceDescriptor: vi.fn(),
  getTowerPgWorkspaceMe: vi.fn(),
  listTowerPgWorkspaces: vi.fn(),
}));

const towerNpub = nip19.npubEncode('11'.repeat(32));
const workspaceServiceNpub = nip19.npubEncode('22'.repeat(32));
const ownerNpub = nip19.npubEncode('33'.repeat(32));
const userNpub = nip19.npubEncode('44'.repeat(32));

const descriptor = {
  type: 'wingman_workspace_locator',
  version: 1,
  tower_base_url: 'https://tower.example',
  identity: {
    tower_service_npub: towerNpub,
    workspace_service_npub: workspaceServiceNpub,
    workspace_owner_npub: ownerNpub,
    workspace_id: 'workspace-real',
    app_npub: 'flightdeck_pg',
  },
  label: 'Wingmen',
  links: {},
};

function provider() {
  let change;
  return {
    version: 1,
    isAvailable: vi.fn(async () => ({ available: true, version: 1 })),
    requestDiscovery: vi.fn(async () => ({ disclosed: 1, workspaces: true })),
    listNStacks: vi.fn(async () => [{ id: 'opaque-stack', name: 'Home', url: 'https://tower.example', serviceNpub: towerNpub }]),
    listWorkspaces: vi.fn(async () => [{
      id: 'opaque-workspace', name: 'Wingmen', workspaceId: 'workspace-real',
      workspaceOwnerNpub: ownerNpub, workspaceServiceNpub,
      directHttpsUrl: 'https://tower.example', serviceNpub: towerNpub,
    }]),
    revoke: vi.fn(async () => true),
    on: vi.fn((_name, handler) => { change = handler; return () => {}; }),
    emitChange(reason = 'revoked') { change?.({ reason }); },
  };
}

function store(overrides = {}) {
  return {
    session: { npub: userNpub },
    knownHosts: [],
    knownWorkspaces: [],
    backendUrl: '',
    showConnectModal: true,
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    ownerNpub: '',
    mergeKnownWorkspaces(entries) { this.knownWorkspaces = entries; },
    addKnownHost(host) { this.knownHosts.push(host); },
    persistWorkspaceSettings: vi.fn(async () => {}),
    ensureBackgroundSync: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    selectWorkspace: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('NStack connect settings integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {});
  });

  it('discovers through a late provider and preserves a verified saved workspace on revoke', async () => {
    const bridge = provider();
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const value = store({ knownWorkspaces: [{ workspaceKey: 'verified', name: 'Saved' }] });
    Object.defineProperties(value, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));
    setTimeout(() => { globalThis.window.NStack = bridge; }, 5);

    await value.initializeNStackConnection({ timeoutMs: 100, pollIntervalMs: 2 });
    await value.discoverFromNStack();
    expect(value.nstackConnections).toHaveLength(1);

    bridge.emitChange('revoked');
    expect(value.nstackConnections).toEqual([]);
    expect(value.knownWorkspaces).toEqual([{ workspaceKey: 'verified', name: 'Saved' }]);
    expect(value.nstackNotice).toMatch(/saved workspace was not changed/);
  });

  it('imports through fresh signed descriptor and membership verification', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockResolvedValue(descriptor);
    api.getTowerPgWorkspaceMe.mockResolvedValue({ actor: { npub: userNpub }, membership: { role: 'member' } });
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const value = store();
    Object.defineProperties(value, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await value.connectFromNStack({ descriptor });

    expect(value.nstackError).toBe('');
    expect(api.getTowerPgWorkspaceDescriptor).toHaveBeenCalledTimes(1);
    expect(api.getTowerPgWorkspaceMe).toHaveBeenCalledTimes(1);
    expect(value.knownWorkspaces[0]).toMatchObject({
      workspaceId: 'workspace-real',
      workspaceOwnerNpub: ownerNpub,
      towerServiceNpub: towerNpub,
      workspaceServiceNpub,
      pgSessionNpub: userNpub,
      pgBackendMode: true,
    });
    expect(value.selectWorkspace).toHaveBeenCalledWith(expect.stringContaining('workspace-real'), { pgVerified: true });
  });

  it('reports Tower access failures separately without importing', async () => {
    const api = await import('../src/api.js');
    api.getTowerPgWorkspaceDescriptor.mockRejectedValue(new Error('membership denied'));
    const { connectSettingsManagerMixin } = await import('../src/connect-settings-manager.js');
    const value = store();
    Object.defineProperties(value, Object.getOwnPropertyDescriptors(connectSettingsManagerMixin));

    await value.connectFromNStack({ descriptor });

    expect(value.nstackError).toBe('Tower access failed: membership denied');
    expect(value.knownWorkspaces).toEqual([]);
  });
});
