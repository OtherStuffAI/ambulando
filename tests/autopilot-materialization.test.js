import { beforeEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import {
  clearRuntimeData,
  getAutopilotConnectionsByWorkspace,
  getWorkspaceAgentsByConnection,
  getWorkspaceAgentsByWorkspace,
  migrateLegacyAutopilotLaunchers,
  openWorkspaceDb,
  reconcileTowerPgSnapshot,
  runWorkspaceSyncTransaction,
} from '../src/db.js';
import { applyPgRecordChanges, PG_RECORD_DELTA_FAMILIES, resetPgRecordAuthority } from '../src/pg-record-delta.js';
import {
  inboundAutopilotConnection,
  inboundWorkspaceAgent,
  outboundAutopilotConnection,
  outboundWorkspaceAgent,
} from '../src/translators/autopilot-connections.js';
import { PG_SYNC_FAMILY_MAP } from '../src/sync-families.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const store = { currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner' } };
let db;

beforeEach(async () => {
  db = openWorkspaceDb('autopilot-materialization-tests');
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});

function page(changes, cursor = 'next') {
  return {
    ...fixture.one_message_delta,
    changes,
    next_cursor: cursor,
    families: fixture.canonical_upserts.families,
    actors: fixture.canonical_upserts.actors,
  };
}

describe('Autopilot PG translators', () => {
  it('retains canonical audit/version fields and builds later command payloads', () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection').row;
    const agent = fixture.canonical_upserts.changes.find(change => change.family === 'workspace_agent').row;
    expect(inboundAutopilotConnection({ ...connection, installation_id: 'INSTALLATION-EXAMPLE' })).toMatchObject({
      id: connection.id, installation_id: 'installation-example', row_version: 1, archived_at: null, pg_backend: true,
    });
    expect(inboundWorkspaceAgent(agent)).toMatchObject({
      connection_id: connection.id, agent_id: 'agent-example', agent_npub: 'npub1agentexample', sort_order: 0, is_visible: true,
    });
    expect(outboundAutopilotConnection(connection)).toEqual(expect.objectContaining({ installation_id: 'installation-example', fips_endpoint: connection.fips_endpoint }));
    expect(outboundWorkspaceAgent(agent)).toEqual(expect.objectContaining({ connection_id: connection.id, agent_id: agent.agent_id }));
  });

  it('rejects private connection material instead of persisting it as metadata', () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection').row;
    expect(() => inboundAutopilotConnection({ ...connection, metadata: { bearer_token: 'nope' } })).toThrow('not public capability metadata');
    expect(() => outboundAutopilotConnection({ ...connection, metadata: { nested: { bunker_uri: 'bunker://secret' } } })).toThrow('not public capability metadata');
    for (const key of [
      'connect_package', 'connect_package_payload', 'connect_package_signature', 'raw_connect_package',
      'discovery_response', 'raw_discovery', 'nip98_event', 'nip_98_authorization', 'access_token', 'private_key',
    ]) {
      expect(() => inboundAutopilotConnection({ ...connection, metadata: { [key]: 'sensitive' } }))
        .toThrow('not public capability metadata');
    }
    expect(() => inboundAutopilotConnection({ ...connection, metadata: { connect_package_version: { package: 'sensitive' } } }))
      .toThrow('must be a non-negative integer');
  });

  it('round-trips the public connect package version through create response materialization', async () => {
    const change = fixture.canonical_upserts.changes.find(item => item.family === 'autopilot_connection');
    const metadata = {
      connect_package_version: 2,
      installation_npub: 'npub1installation',
      health_path: '/api/owners/owner/control-plane/v1/health',
      agents_path: '/api/owners/owner/control-plane/v1/agents',
    };
    const createPayload = outboundAutopilotConnection({ ...change.row, metadata });
    const responseChange = { ...change, row: { ...change.row, ...createPayload } };

    await applyPgRecordChanges(store, page([responseChange]), { expectedCursor: null });

    expect(await db.autopilot_connections.get(change.id)).toMatchObject({
      metadata,
      sync_status: 'synced',
      pg_backend: true,
    });
    expect(inboundAutopilotConnection(responseChange.row).metadata.connect_package_version).toBe(2);
  });

  it('preserves v2 signer, transport identity and the exact signed HTTP FIPS origin', () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection').row;
    const row = {
      ...connection,
      fips_transport_npub: 'npub1transport',
      fips_endpoint: 'http://npub1transport.fips:3601',
    };
    expect(outboundAutopilotConnection(inboundAutopilotConnection(row))).toMatchObject({
      fips_transport_npub: 'npub1transport',
      fips_endpoint: 'http://npub1transport.fips:3601',
    });
    expect(() => inboundAutopilotConnection({ ...row, fips_endpoint: 'http://npub1other.fips:3601' }))
      .toThrow('must exactly match fips_transport_npub');
  });
});

describe('Autopilot materialization and compatibility migration', () => {
  it('registers the singular delta families and plural list envelopes', () => {
    expect(PG_SYNC_FAMILY_MAP.autopilot_connection).toMatchObject({ envelope: 'autopilot_connections', table: 'autopilot_connections' });
    expect(PG_SYNC_FAMILY_MAP.workspace_agent).toMatchObject({ envelope: 'workspace_agents', table: 'workspace_agents' });
    expect(PG_RECORD_DELTA_FAMILIES).toEqual(expect.arrayContaining(['autopilot_connection', 'workspace_agent']));
    expect(runWorkspaceSyncTransaction.toString()).toContain('db.autopilot_connections');
    expect(runWorkspaceSyncTransaction.toString()).toContain('db.workspace_agents');
  });

  it('reconciles omitted canonical snapshot rows while preserving present and compatibility rows', async () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection');
    const agent = fixture.canonical_upserts.changes.find(change => change.family === 'workspace_agent');
    const presentConnection = { ...connection, id: '50000000-0000-4000-8000-000000000019', row: {
      ...connection.row, id: '50000000-0000-4000-8000-000000000019', installation_id: 'present-installation', display_name: 'Present',
    } };
    const presentAgent = { ...agent, id: '50000000-0000-4000-8000-000000000020', row: {
      ...agent.row, id: '50000000-0000-4000-8000-000000000020', connection_id: presentConnection.id,
      agent_id: 'present-agent', agent_npub: 'npub1present', sort_order: 7,
    } };
    await applyPgRecordChanges(store, page([connection, agent, presentConnection, presentAgent]), { expectedCursor: null });
    await migrateLegacyAutopilotLaunchers(workspaceId, [{ agent_npub: 'npub1legacy', url: 'https://legacy.example' }]);

    await reconcileTowerPgSnapshot({ autopilot_connections: [presentConnection.id], workspace_agents: [presentAgent.id] });

    expect(await db.autopilot_connections.get(connection.id)).toMatchObject({ pg_access_status: 'stale' });
    expect(await db.workspace_agents.get(agent.id)).toMatchObject({ pg_access_status: 'stale' });
    expect(await db.autopilot_connections.get(presentConnection.id)).toMatchObject({ installation_id: 'present-installation' });
    expect(await db.workspace_agents.get(presentAgent.id)).toMatchObject({ connection_id: presentConnection.id, sort_order: 7 });
    expect((await db.autopilot_connections.toArray()).filter(row => row.pg_backend === false)).toHaveLength(1);
    expect((await db.workspace_agents.toArray()).filter(row => row.pg_backend === false)).toHaveLength(1);
    expect((await getWorkspaceAgentsByConnection(presentConnection.id)).map(row => row.agent_npub)).toEqual(['npub1present']);
  });

  it('materializes one connection with ordered, visible workspace agents and converges archive tombstones', async () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection');
    const baseAgent = fixture.canonical_upserts.changes.find(change => change.family === 'workspace_agent');
    const secondAgent = { ...baseAgent, id: '50000000-0000-4000-8000-000000000018', version: '16', row: {
      ...baseAgent.row, id: '50000000-0000-4000-8000-000000000018', agent_id: 'agent-second', agent_npub: 'npub1second',
      display_name: 'Second', sort_order: 5, is_visible: false,
    } };
    await applyPgRecordChanges(store, page([connection, baseAgent, secondAgent]), { expectedCursor: null });
    expect((await getAutopilotConnectionsByWorkspace(workspaceId)).map(row => row.id)).toEqual([connection.id]);
    expect((await getWorkspaceAgentsByConnection(connection.id)).map(row => row.agent_id)).toEqual(['agent-example', 'agent-second']);
    expect((await getWorkspaceAgentsByWorkspace(workspaceId, { visibleOnly: true })).map(row => row.agent_id)).toEqual(['agent-example']);

    await applyPgRecordChanges(store, page([{ ...baseAgent, version: '17', row: { ...baseAgent.row, row_version: 2, archived_at: '2026-09-06T00:00:00+00:00' } }], 'archive'), { expectedCursor: 'next' });
    expect(await db.workspace_agents.get(baseAgent.id)).toBeUndefined();
    expect((await db.pg_record_rows.get(`workspace_agent:${baseAgent.id}`)).row.archived_at).toBeTruthy();
  });

  it('deduplicates legacy endpoints idempotently without asserting installation identity', async () => {
    const legacy = [
      { agent_npub: 'npub1one', url: 'https://autopilot.example/' },
      { agent_npub: 'npub1two', url: 'https://autopilot.example' },
      { agent_npub: 'npub1invalid', url: 'bunker://secret' },
    ];
    expect(await migrateLegacyAutopilotLaunchers(workspaceId, legacy)).toEqual({ connections: 1, agents: 2 });
    expect(await migrateLegacyAutopilotLaunchers(workspaceId, legacy)).toEqual({ connections: 0, agents: 0 });
    const connections = await getAutopilotConnectionsByWorkspace(workspaceId);
    const agents = await getWorkspaceAgentsByWorkspace(workspaceId);
    expect(connections).toHaveLength(1);expect(agents).toHaveLength(2);
    expect(connections[0]).toMatchObject({ installation_id: null, fips_endpoint: null, https_endpoint: 'https://autopilot.example', pg_backend: false });
    expect(connections[0].metadata.installation_identity_verified).toBe(false);
    expect(agents.map(row => row.sort_order)).toEqual([0, 1]);
    expect(JSON.stringify({ connections, agents })).not.toContain('bunker://secret');
  });

  it('keeps repeated migration raw rows idempotent but hides an exact canonical launcher match, including after archive', async () => {
    const connection = fixture.canonical_upserts.changes.find(change => change.family === 'autopilot_connection');
    const agent = fixture.canonical_upserts.changes.find(change => change.family === 'workspace_agent');
    const legacy = [{ agent_npub: agent.row.agent_npub, url: connection.row.https_endpoint }];
    expect(await migrateLegacyAutopilotLaunchers(workspaceId, legacy)).toEqual({ connections: 1, agents: 1 });
    await applyPgRecordChanges(store, page([connection, agent]), { expectedCursor: null });
    expect(await migrateLegacyAutopilotLaunchers(workspaceId, legacy)).toEqual({ connections: 0, agents: 0 });
    expect(await getWorkspaceAgentsByWorkspace(workspaceId)).toHaveLength(1);
    expect((await db.workspace_agents.toArray()).filter(row => row.pg_backend === false)).toHaveLength(1);

    await applyPgRecordChanges(store, page([{ ...agent, version: '17', row: {
      ...agent.row, row_version: 2, archived_at: '2026-09-06T00:00:00+00:00',
    } }], 'archived'), { expectedCursor: 'next' });
    expect(await migrateLegacyAutopilotLaunchers(workspaceId, legacy)).toEqual({ connections: 0, agents: 0 });
    expect(await getWorkspaceAgentsByWorkspace(workspaceId)).toEqual([]);
    expect((await db.workspace_agents.toArray()).filter(row => row.pg_backend === false)).toHaveLength(1);
  });

  it('clears both normalized families on record-delta authority reset', async () => {
    await applyPgRecordChanges(store, page(fixture.canonical_upserts.changes.filter(change =>
      ['autopilot_connection', 'workspace_agent'].includes(change.family))), { expectedCursor: null });
    await resetPgRecordAuthority(store);
    expect(await db.autopilot_connections.count()).toBe(0);
    expect(await db.workspace_agents.count()).toBe(0);
  });

  it('clears both normalized families with workspace runtime teardown', async () => {
    await migrateLegacyAutopilotLaunchers(workspaceId, [{ agent_npub: 'npub1one', url: 'https://autopilot.example' }]);
    await clearRuntimeData();
    expect(await db.autopilot_connections.count()).toBe(0);
    expect(await db.workspace_agents.count()).toBe(0);
  });
});
