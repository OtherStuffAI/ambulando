import { createAutopilotDiscoveryClient } from './autopilot-connect-client.js';
import { updateTowerPgAutopilotConnection } from './tower-command-intents.js';

const text = (value) => String(value ?? '').trim();

export function storedPackage(connection) {
  const endpoint = new URL(text(connection?.fips_endpoint));
  const transportNpub = text(connection?.fips_transport_npub || connection?.metadata?.installation_npub);
  if (endpoint.protocol !== 'http:' || !endpoint.port || endpoint.origin !== `http://${transportNpub}.fips:${endpoint.port}`) {
    throw new Error('Stored Autopilot transport identity does not match its signed FIPS origin.');
  }
  const metadata = connection?.metadata || {};
  return Object.freeze({
    version: Number(metadata.connect_package_version || 1), installationId: text(connection.installation_id),
    installationNpub: text(metadata.installation_npub), transportNpub, fipsEndpoint: endpoint.origin,
    httpsEndpoint: text(connection.https_endpoint) || null, apiVersion: Number(connection.api_version || 1),
    capabilities: Object.freeze([...(connection.capabilities || [])]), healthPath: text(metadata.health_path), agentsPath: text(metadata.agents_path),
    pipelineViewerPath: text(metadata.pipeline_viewer_path),
    controlledRestartPath: text(metadata.controlled_restart_path), controlledRestartStatusPath: text(metadata.controlled_restart_status_path),
  });
}

export function verifiedConnectionPayload(verified, connection = {}) {
  return {
    installation_id: verified.installationId,
    fips_transport_npub: verified.transportNpub,
    display_name: text(connection.display_name) || `Autopilot ${verified.installationId}`,
    fips_endpoint: verified.fipsEndpoint,
    https_endpoint: verified.httpsEndpoint,
    api_version: String(verified.apiVersion),
    capabilities: [...verified.capabilities],
    metadata: {
      connect_package_version: verified.version,
      installation_npub: verified.installationNpub,
      health_path: verified.healthPath,
      agents_path: verified.agentsPath,
      pipeline_viewer_path: verified.pipelineViewerPath,
      controlled_restart_path: verified.controlledRestartPath,
      controlled_restart_status_path: verified.controlledRestartStatusPath,
    },
  };
}

export async function refreshInstalledAutopilotConnection(store, connection, {
  createClient = createAutopilotDiscoveryClient,
  persist = updateTowerPgAutopilotConnection,
} = {}) {
  const installed = storedPackage(connection);
  const workspaceId = text(store.currentWorkspace?.workspaceId);
  if (!workspaceId) throw new Error('A Tower workspace is required to refresh this Autopilot connection.');
  const installedClient = createClient(installed);
  try {
    await installedClient.health();
    const verified = await installedClient.refreshConnectPackage();
    const refreshedClient = createClient(verified);
    try {
      await refreshedClient.health();
    } finally {
      await refreshedClient.disconnect?.();
    }

    if (text(store.currentWorkspace?.workspaceId) !== workspaceId) {
      throw new Error('The active workspace changed before the Autopilot connection refresh completed.');
    }
    if (!Number.isInteger(Number(connection.row_version)) || Number(connection.row_version) < 1) {
      throw new Error('The installed Autopilot connection version is unavailable; sync with Tower before refreshing.');
    }
    const response = await persist(store, workspaceId, connection.id, {
      ...verifiedConnectionPayload(verified, connection),
      row_version: Number(connection.row_version),
    }, {
      baseUrl: store.backendUrl,
    });
    const refreshedConnection = response?.autopilot_connection;
    if (!refreshedConnection?.id || refreshedConnection.id !== connection.id
      || text(refreshedConnection.installation_id).toLowerCase() !== text(connection.installation_id).toLowerCase()
      || text(refreshedConnection.fips_transport_npub) !== installed.transportNpub) {
      throw new Error('Tower did not preserve the installed Autopilot connection identity.');
    }
    return { verified, connection: refreshedConnection };
  } finally {
    await installedClient.disconnect?.();
  }
}
