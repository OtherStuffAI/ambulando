import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock('../src/autopilot-connect-client.js', () => ({ createAutopilotDiscoveryClient: mocks.create, verifyAutopilotConnectPackage: mocks.verify }));
import { agentSpaceManagerMixin } from '../src/agent-space-manager.js';

describe('Agent Space transient client ownership', () => {
  let client, store;
  beforeEach(() => {
    vi.clearAllMocks();
    client = { disconnect: vi.fn(async () => {}), health: vi.fn(async () => ({ ok: true })), discoverAgents: vi.fn(async () => []), readAgent: vi.fn(async () => ({ agent: { name: 'DakkaBot' } })), controlledRestartStatus: vi.fn(async () => ({ inProgress: false, operation: { status: 'complete' } })) };
    mocks.create.mockReturnValue(client);
    mocks.verify.mockReturnValue({});
    store = { ...agentSpaceManagerMixin, selectedWorkspaceAgentId: 'dakka', agentSpaceView: 'overview', workspaceAgents: [{ id: 'dakka', connection_id: 'autopilot', agent_id: 'dakka', agent_npub: 'npub-agent' }], agentConnections: [{ id: 'autopilot', fips_endpoint: 'http://npub-transport.fips:3601', fips_transport_npub: 'npub-transport', metadata: { installation_npub: 'npub-installation' } }] };
  });
  it('releases each overview read including failed requests and retry', async () => {
    client.readAgent.mockRejectedValueOnce(new Error('first read failed'));
    await store.loadSelectedAgentSpaceView();
    expect(store.agentSpaceError).toBe('first read failed');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    await store.loadSelectedAgentSpaceView();
    expect(store.agentSpaceData).toEqual({ name: 'DakkaBot' });
    expect(store.agentSpaceError).toBe('');
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });
  it('preserves the original failure and clears loading when native cleanup rejects', async () => {
    client.disconnect.mockRejectedValue(new Error('teardown failed'));
    client.readAgent.mockRejectedValue(new Error('original overview failure'));
    await store.loadSelectedAgentSpaceView();
    expect(store.agentSpaceError).toBe('original overview failure');
    expect(store.agentSpaceLoading).toBe(false);
    client.health.mockRejectedValue(new Error('original discovery failure'));
    await store.verifyAndDiscoverAutopilotAgents();
    expect(store.agentConnectError).toBe('original discovery failure');
    expect(store.agentConnectBusy).toBe(false);
    store.controlledRestartConnection = store.agentConnections[0];
    store._verifiedControlledRestartPackages = new Map([['autopilot', {}]]);
    store.controlledRestartAvailability = 'available';
    client.controlledRestart = vi.fn(async () => { throw new Error('original restart failure'); });
    await store.requestControlledRestart();
    expect(store.controlledRestartError).toBe('original restart failure');
    expect(store.controlledRestartBusy).toBe(false);
  });

  it('releases discovery when health or discovery fails', async () => {
    client.health.mockRejectedValueOnce(new Error('health failed'));
    await store.verifyAndDiscoverAutopilotAgents();
    client.discoverAgents.mockRejectedValueOnce(new Error('discovery failed'));
    await store.verifyAndDiscoverAutopilotAgents();
    expect(client.disconnect).toHaveBeenCalledTimes(2);
    expect(store.agentConnectBusy).toBe(false);
  });
  it('releases resumed and polled restart status clients', async () => {
    store.controlledRestartConnection = store.agentConnections[0];
    store._verifiedControlledRestartPackages = new Map([['autopilot', {}]]);
    await store.resumeControlledRestartStatus();
    await store.pollControlledRestartStatus();
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });
});
