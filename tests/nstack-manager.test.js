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
    await value.initializeNStackDiscovery();
    expect(value.nstackAvailability).toBe('unavailable');
    expect(value.nstackStacks).toEqual([]);
    expect(value.backendUrl).toBe('https://manual-tower.example');
  });

  it('discovers, selects and requests only the required workspace capability', async () => {
    const provider = new DeterministicNStackProviderFixture({
      origin: location.origin,
      stacks: [{ id: 'personal', name: 'Personal', host: true, url: 'https://stack.example' }],
      workspaces: { personal: [{ id: 'private', name: 'Private' }] },
    });
    window.NStack = provider;
    const value = await withMixin(store());
    await value.initializeNStackDiscovery();
    expect(provider.calls).toEqual([['isAvailable'], ['on', 'change']]);
    await value.requestNStackDiscovery();
    value.chooseNStackWorkspace(value.nstackWorkspaces[0].id);
    await value.activateNStackSelection();
    expect(value.nstackStatus).toBe('active');
    expect(provider.calls.find(call => call[0] === 'requestCapabilities')[1].capabilities).toEqual(['workspace.read']);
    expect(selection.save).toHaveBeenCalledWith(expect.objectContaining({ workspacePartition: 'workspace-local-a' }));
    expect(selection.save.mock.calls[0][0].selection).not.toHaveProperty('handleId');

    provider.emit('changed');
    expect(value.nstackStatus).toBe('changed');
    expect(value.nstackCapabilityHandleId).toBe('');
    expect(value.nstackError).toMatch(/did not switch/);
  });
});
