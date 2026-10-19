// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeterministicNStackProviderFixture } from './fixtures/nstack-provider-fixture.js';

const selection = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));

vi.mock('../src/nstack-selection-store.js', () => ({
  loadNStackSelection: selection.load,
  saveNStackSelection: selection.save,
}));
vi.mock('../src/nstack-recovery-relay.js', () => ({
  createNStackRecoveryRepository: vi.fn(),
  nstackRecoveryRelayUrls: vi.fn(() => ['wss://relay.example']),
}));
vi.mock('../src/auth/nostr.js', () => ({
  decodeNpub: vi.fn(() => 'a'.repeat(64)),
  personalDecryptFromNpub: vi.fn(),
  personalEncryptForNpub: vi.fn(),
  signNostrEvent: vi.fn(),
}));

function store(overrides = {}) {
  return {
    session: { npub: 'npub1alice' },
    currentWorkspaceKey: 'workspace-local-a',
    selectedWorkspaceKey: '',
    knownHosts: [],
    knownWorkspaces: [],
    mergedHostsList: [],
    currentWorkspace: null,
    currentWorkspaceBackendUrl: '',
    ...overrides,
  };
}

async function withMixin(value) {
  const { nstackManagerMixin } = await import('../src/nstack-manager.js');
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(nstackManagerMixin));
  return value;
}

describe('NStack settings manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selection.load.mockResolvedValue(null);
    selection.save.mockImplementation(async input => input.selection);
    delete window.NStack;
  });

  it('shows provider absence without enumerating and preserves the manual fallback state', async () => {
    const value = await withMixin(store({ backendUrl: 'https://manual-tower.example' }));
    await value.initializeNStackDiscovery({ timeoutMs: 0 });
    expect(value.nstackAvailability).toBe('unavailable');
    expect(value.nstackStacks).toEqual([]);
    expect(value.backendUrl).toBe('https://manual-tower.example');
  });

  it('imports a disclosed workspace through fresh Tower verification and activates it', async () => {
    const provider = new DeterministicNStackProviderFixture({
      origin: location.origin,
      stacks: [{ id: 'personal', name: 'Personal', host: true, url: 'https://stack.example' }],
      workspaces: { personal: [{ id: 'private', name: 'Private' }] },
    });
    window.NStack = provider;
    const imported = { workspaceKey: 'pg:verified-workspace', workspaceOwnerNpub: `npub1${'q'.repeat(58)}` };
    const verifyPgDescriptor = vi.fn(async candidate => ({
      descriptor: {
        workspaceId: 'private',
        workspaceOwnerNpub: candidate.identity.workspace_owner_npub,
        workspaceServiceNpub: candidate.identity.workspace_service_npub,
        towerServiceNpub: candidate.identity.tower_service_npub,
        towerBaseUrl: candidate.tower_base_url,
      },
      me: { actor: { npub: 'npub1alice' } },
    }));
    const rememberVerifiedPgWorkspace = vi.fn(async () => imported);
    const selectWorkspace = vi.fn(async () => {});
    const value = await withMixin(store({ verifyPgDescriptor, rememberVerifiedPgWorkspace, selectWorkspace }));
    await value.initializeNStackDiscovery();
    expect(provider.calls).toEqual([['isAvailable'], ['on', 'change']]);
    await value.requestNStackDiscovery();
    value.chooseNStackWorkspace(value.nstackWorkspaces[0].id);
    await value.activateNStackSelection();
    expect(value.nstackStatus).toBe('active');
    expect(provider.calls.some(call => call[0] === 'requestCapabilities')).toBe(false);
    expect(verifyPgDescriptor).toHaveBeenCalledTimes(1);
    expect(rememberVerifiedPgWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'private' }), expect.anything(), expect.objectContaining({ clearLocalForget: true }));
    expect(selectWorkspace).toHaveBeenCalledWith('pg:verified-workspace', { pgVerified: true });
    expect(selection.save).toHaveBeenCalledWith(expect.objectContaining({ workspacePartition: 'workspace-local-a' }));
    expect(selection.save.mock.calls[0][0].selection).toMatchObject({ remoteWorkspaceId: 'private' });

    value.knownHosts = [{ url: 'https://stack.example', label: 'Manual stack' }];
    value.mergedHostsList = value.knownHosts;
    expect(value.knownNStacks).toHaveLength(1);
    expect(value.knownNStacks[0].sources).toEqual(['configured', 'browser']);

    provider.emit('changed');
    expect(value.nstackStatus).toBe('changed');
    expect(value.nstackConnectionVerified).toBe(false);
    expect(value.nstackError).toMatch(/active Tower connection was preserved/);
    expect(value.knownNStacks.some(entry => entry.sources.includes('configured'))).toBe(true);
    expect(value.knownHosts).toEqual([{ url: 'https://stack.example', label: 'Manual stack' }]);
  });

  it('preserves the current destination when fresh NIP-98 verification fails', async () => {
    const provider = new DeterministicNStackProviderFixture({
      origin: location.origin,
      stacks: [{ id: 'work', name: 'Work', host: true, url: 'https://stack.example' }],
      workspaces: { work: [{ id: 'ops', name: 'Operations' }] },
    });
    window.NStack = provider;
    const verifyPgDescriptor = vi.fn(async () => { throw Object.assign(new Error('NIP-98 access denied'), { code: 'forbidden' }); });
    const selectWorkspace = vi.fn();
    const value = await withMixin(store({
      backendUrl: 'https://current.example',
      selectedWorkspaceKey: 'current-workspace',
      currentWorkspaceKey: 'current-workspace',
      verifyPgDescriptor,
      rememberVerifiedPgWorkspace: vi.fn(),
      selectWorkspace,
    }));
    await value.initializeNStackDiscovery();
    await value.requestNStackDiscovery();
    value.chooseNStackWorkspace(value.nstackWorkspaces[0].id);
    await value.activateNStackSelection();
    expect(value.nstackStatus).toBe('error');
    expect(value.backendUrl).toBe('https://current.example');
    expect(value.selectedWorkspaceKey).toBe('current-workspace');
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(selection.save).not.toHaveBeenCalled();
  });

  it('rejects a Tower descriptor that does not match the browser-disclosed workspace', async () => {
    const provider = new DeterministicNStackProviderFixture({
      origin: location.origin,
      stacks: [{ id: 'work', name: 'Work', host: true, url: 'https://stack.example' }],
      workspaces: { work: [{ id: 'ops', name: 'Operations' }] },
    });
    window.NStack = provider;
    const rememberVerifiedPgWorkspace = vi.fn();
    const selectWorkspace = vi.fn();
    const value = await withMixin(store({
      backendUrl: 'https://current.example',
      verifyPgDescriptor: vi.fn(async candidate => ({
        descriptor: {
          workspaceId: 'different-workspace',
          workspaceOwnerNpub: candidate.identity.workspace_owner_npub,
          workspaceServiceNpub: candidate.identity.workspace_service_npub,
          towerServiceNpub: candidate.identity.tower_service_npub,
          towerBaseUrl: candidate.tower_base_url,
        },
        me: { actor: { npub: 'npub1alice' } },
      })),
      rememberVerifiedPgWorkspace,
      selectWorkspace,
    }));
    await value.initializeNStackDiscovery();
    await value.requestNStackDiscovery();
    value.chooseNStackWorkspace(value.nstackWorkspaces[0].id);
    await value.activateNStackSelection();
    expect(value.nstackStatus).toBe('malformed');
    expect(value.backendUrl).toBe('https://current.example');
    expect(rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(selection.save).not.toHaveBeenCalled();
  });

  it('reports a consented NStack with no workspaces without changing manual setup', async () => {
    const provider = new DeterministicNStackProviderFixture({
      origin: location.origin,
      stacks: [{ id: 'empty', name: 'Empty', host: true, url: 'https://empty.example' }],
      workspaces: { empty: [] },
    });
    window.NStack = provider;
    const value = await withMixin(store({ backendUrl: 'https://manual.example' }));
    await value.initializeNStackDiscovery();
    await value.requestNStackDiscovery();
    expect(value.nstackStatus).toBe('no_workspaces');
    expect(value.nstackWorkspaces).toEqual([]);
    expect(value.backendUrl).toBe('https://manual.example');
  });
});
