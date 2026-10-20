import { nip19 } from 'nostr-tools';

import { FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import { PG_WORKSPACE_DESCRIPTOR_TYPE } from './pg-workspace-descriptor.js';

const REQUIRED_PROVIDER_METHODS = [
  'isAvailable',
  'requestDiscovery',
  'listNStacks',
  'listWorkspaces',
  'getConnection',
  'revoke',
  'on',
];

const FORBIDDEN_FIELD = /(?:password|credential|private.?key|\bnsec\b|secret|bearer|token|signature|wrapped|browser.?id|internal.?id|remote.?id)/i;

class NStackConnectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'NStackConnectionError';
    this.code = code;
  }
}

function text(value, label, maximum = 256) {
  const result = String(value ?? '').trim();
  const hasControlCharacter = [...result].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!result || result.length > maximum || hasControlCharacter) {
    throw new NStackConnectionError('malformed_descriptor', `${label} is missing or invalid.`);
  }
  return result;
}

function npub(value, label) {
  const result = text(value, label, 128);
  try {
    if (nip19.decode(result).type !== 'npub') throw new Error('not npub');
  } catch {
    throw new NStackConnectionError('malformed_descriptor', `${label} must be a valid npub.`);
  }
  return result;
}

function httpsTowerOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new NStackConnectionError('malformed_descriptor', 'Tower URL must be valid HTTPS.');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new NStackConnectionError('malformed_descriptor', 'Tower URL must be an HTTPS origin without credentials, query, or fragment.');
  }
  return url.origin;
}

function optionalFipsMetadata(stack = {}, workspace = {}) {
  const fipsEndpoint = String(workspace.fipsEndpoint || stack.fipsEndpoint || '').trim();
  const peer = String(workspace.peerNpub || stack.peerNpub || '').trim();
  if (!fipsEndpoint && !peer) return {};
  if (!fipsEndpoint || !peer) {
    throw new NStackConnectionError('malformed_descriptor', 'FIPS endpoint and peer npub must be disclosed together.');
  }
  let endpoint;
  try {
    endpoint = new URL(fipsEndpoint);
  } catch {
    throw new NStackConnectionError('malformed_descriptor', 'FIPS endpoint is invalid.');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol)
    || !endpoint.hostname.endsWith('.fips')
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash
  ) {
    throw new NStackConnectionError('malformed_descriptor', 'FIPS endpoint must be an exact .fips origin.');
  }
  const peerNpub = npub(peer, 'FIPS peer npub');
  if (endpoint.hostname.slice(0, -'.fips'.length) !== peerNpub) {
    throw new NStackConnectionError('malformed_descriptor', 'FIPS endpoint does not match its peer npub.');
  }
  return { fipsEndpoint: endpoint.origin, peerNpub };
}

function findForbiddenField(value, path = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    if (FORBIDDEN_FIELD.test(key)) return next.join('.');
    const nested = findForbiddenField(child, next);
    if (nested) return nested;
  }
  return null;
}

function isNStackProvider(value) {
  return Boolean(
    value
    && REQUIRED_PROVIDER_METHODS.every((method) => typeof value[method] === 'function')
  );
}

export async function waitForNStackProvider({
  windowObject = globalThis.window,
  timeoutMs = 2500,
  pollIntervalMs = 50,
} = {}) {
  if (!windowObject) return null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let readyObserved = false;
  let readyProvider = null;
  const onReady = () => { readyObserved = true; };
  windowObject.addEventListener?.('nstackready', onReady);
  Promise.resolve(windowObject.NStackReady).then((provider) => {
    if (provider) {
      readyProvider = provider;
      readyObserved = true;
    }
  }).catch(() => {});
  try {
    do {
      const provider = windowObject.NStack || readyProvider;
      if (isNStackProvider(provider)) {
        try {
          const remaining = Math.max(0, deadline - Date.now());
          const availability = await Promise.race([
            provider.isAvailable(),
            new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
          ]);
          if (availability?.available === true) return provider;
        } catch {
          // An injected but not-yet-ready bridge can become usable within the
          // same bounded startup window.
        }
      }
      if (Date.now() >= deadline) break;
      if (readyObserved) readyObserved = false;
      else await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() <= deadline);
    return null;
  } finally {
    windowObject.removeEventListener?.('nstackready', onReady);
  }
}

export function nstackWorkspaceDescriptor(stack, workspace) {
  if (!stack || typeof stack !== 'object' || !workspace || typeof workspace !== 'object') {
    throw new NStackConnectionError('malformed_descriptor', 'NBrowser returned an invalid NStack workspace.');
  }
  const forbidden = findForbiddenField({ stack, workspace });
  if (forbidden) {
    throw new NStackConnectionError('malformed_descriptor', `NBrowser returned forbidden field ${forbidden}.`);
  }
  const stackId = text(stack.id, 'NStack opaque ID');
  const workspaceOpaqueId = text(workspace.id, 'Workspace opaque ID');
  const workspaceId = text(workspace.workspaceId, 'Tower workspace ID');
  const workspaceOwnerNpub = npub(workspace.workspaceOwnerNpub, 'Workspace owner npub');
  const workspaceServiceNpub = npub(workspace.workspaceServiceNpub, 'Workspace service npub');
  const towerServiceNpub = npub(
    workspace.towerServiceNpub || workspace.serviceNpub || stack.towerServiceNpub || stack.serviceNpub,
    'Tower service npub',
  );
  const towerBaseUrl = httpsTowerOrigin(workspace.directHttpsUrl || workspace.towerBaseUrl || stack.directHttpsUrl || stack.url);
  const name = text(workspace.name, 'Workspace name');
  const fips = optionalFipsMetadata(stack, workspace);
  const descriptor = {
    type: PG_WORKSPACE_DESCRIPTOR_TYPE,
    version: 1,
    tower_base_url: towerBaseUrl,
    identity: {
      tower_service_npub: towerServiceNpub,
      workspace_service_npub: workspaceServiceNpub,
      workspace_owner_npub: workspaceOwnerNpub,
      workspace_id: workspaceId,
      app_npub: FLIGHT_DECK_PG_APP_NPUB,
    },
    label: name,
    description: String(workspace.description || '').trim(),
    metadata: Object.keys(fips).length ? { nstack_fips: fips } : {},
    capabilities: [],
    links: {},
  };
  return {
    stackId,
    workspaceOpaqueId,
    stackName: text(stack.name, 'NStack name'),
    workspaceName: name,
    descriptor,
  };
}

export async function discoverNStackWorkspaces(provider) {
  if (!isNStackProvider(provider)) {
    throw new NStackConnectionError('bridge_unavailable', 'The NBrowser NStack bridge is unavailable.');
  }
  try {
    await provider.requestDiscovery({ workspaces: true });
  } catch (error) {
    if (error?.code === 'consent_denied') {
      throw new NStackConnectionError('consent_declined', 'NStack discovery was declined in NBrowser.', { cause: error });
    }
    throw new NStackConnectionError('bridge_unavailable', error?.message || 'NBrowser could not disclose NStacks.', { cause: error });
  }
  let stacks;
  try {
    stacks = await provider.listNStacks();
  } catch (error) {
    throw new NStackConnectionError('bridge_unavailable', error?.message || 'NBrowser could not list NStacks.', { cause: error });
  }
  if (!Array.isArray(stacks)) {
    throw new NStackConnectionError('malformed_descriptor', 'NBrowser returned an invalid NStack list.');
  }
  const results = [];
  for (const stack of stacks) {
    const stackId = text(stack?.id, 'NStack opaque ID');
    let workspaces;
    try {
      workspaces = await provider.listWorkspaces({ stackId });
    } catch (error) {
      throw new NStackConnectionError('bridge_unavailable', error?.message || 'NBrowser could not list workspaces.', { cause: error });
    }
    if (!Array.isArray(workspaces)) {
      throw new NStackConnectionError('malformed_descriptor', 'NBrowser returned an invalid workspace list.');
    }
    for (const workspace of workspaces) results.push(nstackWorkspaceDescriptor(stack, workspace));
  }
  if (results.length === 0) {
    throw new NStackConnectionError('no_accessible_workspaces', 'No accessible NStack workspaces were disclosed.');
  }
  return results;
}

export async function resolveNStackWorkspace(provider, connection) {
  if (!isNStackProvider(provider)) {
    throw new NStackConnectionError('bridge_unavailable', 'The NBrowser NStack bridge is unavailable.');
  }
  const stackId = text(connection?.stackId, 'NStack opaque ID');
  const workspaceOpaqueId = text(connection?.workspaceOpaqueId, 'Workspace opaque ID');
  let workspace;
  try {
    workspace = await provider.getConnection({ stackId, workspaceId: workspaceOpaqueId });
  } catch (error) {
    throw new NStackConnectionError('bridge_unavailable', error?.message || 'NBrowser could not resolve the selected workspace.', { cause: error });
  }
  const resolved = nstackWorkspaceDescriptor({
    ...(workspace?.nstack || {}),
    id: workspace?.nstack?.id || stackId,
    name: workspace?.nstack?.name || connection?.stackName,
    url: workspace?.nstack?.url,
    serviceNpub: workspace?.serviceNpub,
  }, workspace);
  if (resolved.stackId !== stackId || resolved.workspaceOpaqueId !== workspaceOpaqueId) {
    throw new NStackConnectionError('malformed_descriptor', 'NBrowser returned mismatched opaque workspace aliases.');
  }
  return resolved;
}

export function nstackUserMessage(error, phase = 'discovery') {
  switch (error?.code) {
    case 'consent_declined':
      return 'NStack discovery was declined in NBrowser. You can retry or use BYO Tower.';
    case 'no_accessible_workspaces':
      return 'No accessible NStack workspaces were disclosed for this identity.';
    case 'malformed_descriptor':
      return `NBrowser returned a malformed workspace descriptor: ${error.message}`;
    case 'bridge_unavailable':
      return 'The NBrowser connection bridge is unavailable. BYO Tower remains available below.';
    default:
      return phase === 'tower'
        ? `Tower access failed: ${error?.message || error}`
        : `NStack discovery failed: ${error?.message || error}`;
  }
}
