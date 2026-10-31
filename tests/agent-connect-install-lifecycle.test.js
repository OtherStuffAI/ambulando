import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createTowerPgAutopilotConnection: vi.fn(),
  updateTowerPgAutopilotConnection: vi.fn(),
  createTowerPgWorkspaceAgent: vi.fn(),
}));

vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

import { agentSpaceManagerMixin } from '../src/agent-space-manager.js';
import { clearRuntimeData, getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle } from '../src/pg-read-hydrator.js';
import { PG_RECORD_DELTA_FAMILIES } from '../src/pg-record-delta.js';
import { syncManagerMixin } from '../src/sync-manager.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const connectionId = '50000000-0000-4000-8000-000000000001';
const agentId = '50000000-0000-4000-8000-000000000002';

function change(family, id, row, version = '1') {
  return { family, id, workspace_id: workspaceId, channel_id: null, operation: 'upsert', version, row };
}

function bundle(changes) {
  return {
    protocol_version: 1,
    families: PG_RECORD_DELTA_FAMILIES,
    mode: 'delta',
    changes,
    actors: [],
    next_cursor: 'cursor-1',
    has_more: false,
    snapshot_id: null,
    snapshot_complete: false,
    partitions_complete: [],
  };
}

function makeStore() {
  const store = {
    backendUrl: 'https://tower.example',
    currentWorkspaceKey: 'agent-connect-install-lifecycle',
    currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner' },
    workspaceOwnerNpub: 'npub1owner',
    session: { npub: 'npub1person' },
    _recordDeltaAttentionActive: true,
    agentConnectStep: 'agents',
    agentDiscoveredAgents: [{ agentId: 'test-agent', botNpub: 'npub1testagent', name: 'Test Agent', description: 'Agent', canInstruct: true, paths: {} }],
    agentSelectedDiscoveryIds: ['test-agent'],
    _verifiedAgentConnectPackage: {
      version: 2,
      installationId: 'installation-one',
      installationNpub: 'npub1installation',
      transportNpub: 'npub1transport',
      fipsEndpoint: 'http://npub1transport.fips:3601',
      httpsEndpoint: null,
      apiVersion: 1,
      capabilities: ['agents.read'],
      healthPath: '/health',
      agentsPath: '/agents',
    },
    agentConnections: [],
    workspaceAgents: [],
    openAgentSpace: vi.fn(),
    buildTowerPgMaterializationStoreSnapshot() {
      return {
        workspaceOwnerNpub: 'npub1owner',
        currentWorkspace: { workspaceId, workspaceOwnerNpub: 'npub1owner' },
        session: { npub: 'npub1person' },
        workspaceHarnessAgents: [],
      };
    },
  };
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(syncManagerMixin));
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(agentSpaceManagerMixin));
  Object.assign(store, {
    _recordDeltaAttentionActive: true,
    agentConnectStep: 'agents',
    agentDiscoveredAgents: [{ agentId: 'test-agent', botNpub: 'npub1testagent', name: 'Test Agent', description: 'Agent', canInstruct: true, paths: {} }],
    agentSelectedDiscoveryIds: ['test-agent'],
    _verifiedAgentConnectPackage: {
      version: 2, installationId: 'installation-one', installationNpub: 'npub1installation', transportNpub: 'npub1transport',
      fipsEndpoint: 'http://npub1transport.fips:3601', httpsEndpoint: null, apiVersion: 1, capabilities: ['agents.read'],
      healthPath: '/health', agentsPath: '/agents',
    },
    agentConnections: [], workspaceAgents: [], openAgentSpace: vi.fn(),
  });
  let materializationQueue = Promise.resolve();
  store.materializeTowerPgWorkspaceBundle = async (payload, options = {}) => {
    materializationQueue = materializationQueue.then(async () => {
      openWorkspaceDb(options.workspaceDbKey || store.workspaceDbKey);
      return hydrateTowerPgSyncBundle(options.store || store.buildTowerPgMaterializationStoreSnapshot(), payload);
    });
    return materializationQueue;
  };
  store.runTowerPgWorkspaceSync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connection = (await api.createTowerPgAutopilotConnection.mock.results[0].value).autopilot_connection;
    const agent = (await api.createTowerPgWorkspaceAgent.mock.results[0].value).workspace_agent;
    return store.materializeTowerPgWorkspaceBundle(bundle([
      change('autopilot_connection', connectionId, connection),
      change('workspace_agent', agentId, agent),
    ]), { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() });
  };
  return store;
}

describe('Agent Connect install lifecycle', () => {
  beforeEach(async () => {
    openWorkspaceDb('agent-connect-install-lifecycle');
    await clearRuntimeData();
    api.createTowerPgAutopilotConnection.mockResolvedValue({ autopilot_connection: {
      id: connectionId, workspace_id: workspaceId, installation_id: 'installation-one',
      fips_transport_npub: 'npub1transport', display_name: 'Autopilot installation-one',
      fips_endpoint: 'http://npub1transport.fips:3601', https_endpoint: null, api_version: '1',
      capabilities: ['agents.read'], metadata: { connect_package_version: 2, installation_npub: 'npub1installation', health_path: '/health', agents_path: '/agents' },
      row_version: 1, created_by_actor_id: 'actor-1', updated_by_actor_id: 'actor-1', archived_by_actor_id: null,
      created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z', archived_at: null,
    } });
    api.createTowerPgWorkspaceAgent.mockResolvedValue({ workspace_agent: {
      id: agentId, workspace_id: workspaceId, connection_id: connectionId, agent_id: 'test-agent', agent_npub: 'npub1testagent',
      display_name: 'Test Agent', avatar_url: null, capabilities: [], sort_order: 0, is_visible: true,
      metadata: { description: 'Agent', can_instruct: true, paths: {} }, row_version: 1,
      created_by_actor_id: 'actor-1', updated_by_actor_id: 'actor-1', archived_by_actor_id: null,
      created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z', archived_at: null,
    } });
  });

  it('creates, acknowledges, force-materializes, and reloads a connection and selected agent', async () => {
    const store = makeStore();
    const db = getWorkspaceDb();
    const connection = (await api.createTowerPgAutopilotConnection()).autopilot_connection;
    api.createTowerPgAutopilotConnection.mockClear();
    api.createTowerPgAutopilotConnection.mockResolvedValue({ autopilot_connection: connection });
    await db.autopilot_connections.put({ ...connection, record_id: connection.id, sync_status: 'pending' });
    await db.pending_writes.add({ record_id: connection.id });
    await hydrateTowerPgSyncBundle(store.buildTowerPgMaterializationStoreSnapshot(), bundle([
      change('autopilot_connection', connectionId, connection),
    ]));
    await db.pending_writes.where('record_id').equals(connection.id).delete();
    await store.installSelectedAutopilotAgents();

    expect(store.agentConnectError).toBe('');
    expect(store.openAgentSpace).toHaveBeenCalledWith(agentId);
    expect(await db.autopilot_connections.get(connectionId)).toMatchObject({ installation_id: 'installation-one' });
    expect(await db.workspace_agents.get(agentId)).toMatchObject({ agent_id: 'test-agent', connection_id: connectionId });
    db.close();
    await openWorkspaceDb('agent-connect-install-lifecycle').open();
    expect(await getWorkspaceDb().workspace_agents.get(agentId)).toMatchObject({ agent_id: 'test-agent' });
  });

  it('persists an explicit HTTPS installation and repeated add keeps one connection and agent', async () => {
    const store = makeStore();
    store._verifiedAgentConnectPackage = { ...store._verifiedAgentConnectPackage, transportMode: 'https', version: 0,
      fipsEndpoint: null, transportNpub: null, httpsEndpoint: 'https://agents.example' };
    api.createTowerPgAutopilotConnection.mockImplementation(async (_workspaceId, payload) => ({ autopilot_connection: {
      id: connectionId, workspace_id: workspaceId, ...payload, fips_transport_npub: null,
      row_version: 1, created_by_actor_id: 'actor-1', updated_by_actor_id: 'actor-1', archived_by_actor_id: null,
      created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z', archived_at: null,
    } }));
    await store.installSelectedAutopilotAgents();
    expect(store.agentConnectError).toBe('');
    await store.installSelectedAutopilotAgents();
    expect(store.agentConnectError).toBe('');
    const db = getWorkspaceDb();
    expect(await db.autopilot_connections.count()).toBe(1);
    expect(await db.workspace_agents.count()).toBe(1);
    expect(await db.autopilot_connections.get(connectionId)).toMatchObject({ metadata: { transport_mode: 'https' }, https_endpoint: 'https://agents.example', fips_transport_npub: null });
    db.close(); await openWorkspaceDb('agent-connect-install-lifecycle').open();
    expect((await getWorkspaceDb().autopilot_connections.get(connectionId)).metadata.transport_mode).toBe('https');
  });

  it('selects HTTPS explicitly while retaining an existing signed FIPS connection', async () => {
    const store = makeStore();
    store._verifiedAgentConnectPackage = { ...store._verifiedAgentConnectPackage, transportMode: 'https', version: 0,
      fipsEndpoint: null, transportNpub: null, httpsEndpoint: 'https://agents.example' };
    const existing = (await api.createTowerPgAutopilotConnection()).autopilot_connection;
    api.createTowerPgAutopilotConnection.mockClear();
    api.updateTowerPgAutopilotConnection.mockImplementation(async (_workspace, _id, patch) => ({ autopilot_connection: { ...existing, ...patch, row_version: 2 } }));
    await store.installSelectedAutopilotAgents();
    expect(store.agentConnectError).toBe('');
    expect(api.updateTowerPgAutopilotConnection).toHaveBeenCalledWith(workspaceId, connectionId,
      expect.objectContaining({ row_version: 1, https_endpoint: 'https://agents.example', metadata: expect.objectContaining({ transport_mode: 'https' }) }), expect.anything());
    const patch = api.updateTowerPgAutopilotConnection.mock.calls[0][2];
    expect(patch).not.toHaveProperty('fips_endpoint');
    expect(patch).not.toHaveProperty('fips_transport_npub');
  });

  it('owns command transport and forced materialization outside an ambient Dexie transaction', async () => {
    const store = makeStore();
    const db = getWorkspaceDb();
    let install;
    await db.transaction('rw', db.sync_state, async () => {
      install = store.installSelectedAutopilotAgents();
      await db.sync_state.put({ key: 'unrelated-live-query-write', value: true });
    });
    await install;
    expect(store.agentConnectError).toBe('');
    expect(await db.workspace_agents.get(agentId)).toMatchObject({ agent_id: 'test-agent' });
  });
});
