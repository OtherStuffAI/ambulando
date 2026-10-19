const SECRET_KEYS = new Set([
  'adminCredential', 'bearerToken', 'cookie', 'databaseCredential', 'nsec',
  'nwc', 'privateKey', 'rawToken', 'secret', 'signerSecret', 'token',
]);

export const NSTACK_V1_CAPABILITIES = Object.freeze(new Set([
  'workspace.read', 'storage.read', 'storage.write', 'events.read', 'events.write',
]));

function text(value) { return String(value ?? '').trim(); }

function fail(code, message, cause) {
  const error = new Error(message);
  error.name = 'NStackError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeProviderError(error, fallback = 'unavailable') {
  return fail(text(error?.code) || fallback, error?.message || 'The NStack provider request failed.', error);
}

function assertNoSecrets(value, path = 'response') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) throw fail('malformed', `${path} exposed forbidden credential material.`);
    if (child && typeof child === 'object') assertNoSecrets(child, `${path}.${key}`);
  }
}

function validateStack(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('malformed', `NStack ${index + 1} is malformed.`);
  assertNoSecrets(value, `NStack ${index + 1}`);
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name || typeof value.host !== 'boolean' || value.available !== true) {
    throw fail('malformed', `NStack ${index + 1} does not match the window.NStack v1 summary.`);
  }
  return { id, name, host: value.host, available: true };
}

function validateWorkspace(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('malformed', `Workspace ${index + 1} is malformed.`);
  assertNoSecrets(value, `Workspace ${index + 1}`);
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) throw fail('malformed', `Workspace ${index + 1} does not match the window.NStack v1 summary.`);
  return { id, name };
}

function validateCapabilityResult(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('malformed', 'The NStack capability result is malformed.');
  assertNoSecrets(value, 'capability response');
  const handle = text(value.handle);
  const stackId = text(value.stackId);
  const workspaceId = text(value.workspaceId);
  const expiresAt = text(value.expiresAt);
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities.map(text) : [];
  const connection = value.connection;
  if (!handle || stackId !== request.stackId || workspaceId !== (request.workspaceId || '') || !expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw fail('malformed', 'The NStack provider returned an invalid capability handle.');
  }
  if (capabilities.length !== request.capabilities.length || request.capabilities.some(capability => !capabilities.includes(capability))) {
    throw fail('malformed', 'The NStack provider returned different capabilities than Ambulando requested.');
  }
  let connectionUrl;
  try { connectionUrl = new URL(text(connection?.url)); } catch { /* handled below */ }
  if (!connection || connection.transport !== 'https' || connectionUrl?.protocol !== 'https:' || connectionUrl.username || connectionUrl.password) {
    throw fail('malformed', 'The NStack provider returned invalid connection metadata.');
  }
  return {
    handle,
    stackId,
    ...(workspaceId ? { workspaceId } : {}),
    capabilities: [...capabilities],
    expiresAt,
    connection: {
      transport: 'https',
      url: connectionUrl.toString().replace(/\/$/, ''),
      ...(text(connection.fipsEndpoint) ? { fipsEndpoint: text(connection.fipsEndpoint) } : {}),
      ...(text(connection.peerNpub) ? { peerNpub: text(connection.peerNpub) } : {}),
    },
  };
}

export function createNStackProviderAdapter({ provider, origin } = {}) {
  const pageOrigin = text(origin);
  let discoveryApproved = false;
  let stacks = new Map();
  let workspaces = new Map();
  const handles = new Map();
  const listeners = new Set();
  let providerUnsubscribe = null;

  function requireMethod(name) {
    if (typeof provider?.[name] !== 'function') throw fail('unavailable', 'NStack discovery is unavailable in this browser.');
    return provider[name].bind(provider);
  }

  function invalidate(change = {}) {
    const reason = text(change?.reason) || 'changed';
    for (const handle of handles.values()) {
      handle.active = false;
      handle.reason = reason;
    }
    for (const listener of listeners) listener({ reason });
  }

  return {
    get origin() { return pageOrigin; },
    get discoveryApproved() { return discoveryApproved; },

    async isAvailable() {
      if (!provider) return { available: false, version: '' };
      try {
        if (provider.version !== 1) throw fail('malformed', 'window.NStack does not expose protocol version 1.');
        const result = await requireMethod('isAvailable')();
        if (result?.available !== true || result?.version !== 1) {
          if (result?.available === false) return { available: false, version: text(result?.version) };
          throw fail('malformed', 'NStack availability does not match the window.NStack v1 contract.');
        }
        return { available: true, version: '1' };
      } catch (error) {
        if (error?.name === 'NStackError') throw error;
        throw normalizeProviderError(error);
      }
    },

    async requestDiscovery(options = {}) {
      try {
        const result = await requireMethod('requestDiscovery')({ workspaces: options.workspaces !== false });
        if (!result || !Number.isInteger(result.disclosed) || result.disclosed < 0 || typeof result.workspaces !== 'boolean') {
          throw fail('malformed', 'NStack discovery returned an invalid v1 result.');
        }
        discoveryApproved = true;
        return { disclosed: result.disclosed, workspaces: result.workspaces };
      } catch (error) {
        discoveryApproved = false;
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    async listNStacks() {
      if (!discoveryApproved) throw fail('not_disclosed', 'Request NStack discovery first.');
      try {
        const result = await requireMethod('listNStacks')();
        if (!Array.isArray(result)) throw fail('malformed', 'The NStack list is malformed.');
        const rows = result.map(validateStack);
        stacks = new Map(rows.map(row => [row.id, row]));
        return rows;
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    async listWorkspaces({ stackId } = {}) {
      const selectedStackId = text(stackId);
      if (!discoveryApproved) throw fail('not_disclosed', 'Request NStack discovery first.');
      if (!stacks.has(selectedStackId)) throw fail('not_disclosed', 'Choose an NStack disclosed to this origin.');
      try {
        const result = await requireMethod('listWorkspaces')({ stackId: selectedStackId });
        if (!Array.isArray(result)) throw fail('malformed', 'The NStack workspace list is malformed.');
        const rows = result.map(validateWorkspace);
        workspaces.set(selectedStackId, new Map(rows.map(row => [row.id, row])));
        return rows;
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    async requestCapabilities(request = {}) {
      const stackId = text(request.stackId);
      const workspaceId = text(request.workspaceId);
      const capabilities = [...new Set((request.capabilities || []).map(text).filter(Boolean))];
      if (!stacks.has(stackId)) throw fail('not_disclosed', 'Choose an NStack disclosed to this origin.');
      if (workspaceId && !workspaces.get(stackId)?.has(workspaceId)) throw fail('not_disclosed', 'Choose a workspace disclosed to this origin.');
      if (capabilities.length === 0) throw fail('invalid_request', 'Request at least one NStack capability.');
      if (capabilities.some(capability => !NSTACK_V1_CAPABILITIES.has(capability))) {
        throw fail('unsupported_capability', 'Ambulando requested an unsupported NStack capability.');
      }
      const outbound = { stackId, ...(workspaceId ? { workspaceId } : {}), capabilities };
      if (request.duration !== undefined) outbound.duration = request.duration;
      try {
        const handle = { ...validateCapabilityResult(await requireMethod('requestCapabilities')(outbound), outbound), active: true, reason: '' };
        handles.set(handle.handle, handle);
        return { ...handle, connection: { ...handle.connection } };
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    async revoke({ handle } = {}) {
      const id = text(handle);
      if (!id) throw fail('invalid_request', 'handle is required.');
      try {
        const result = await requireMethod('revoke')({ handle: id });
        if (result !== true) throw fail('malformed', 'The NStack provider returned an invalid revoke result.');
        const active = handles.get(id);
        if (active) {
          active.active = false;
          active.reason = 'revoked';
        }
        return true;
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    assertHandleActive(handleId) {
      const handle = handles.get(text(handleId));
      if (!handle?.active) throw fail('stale_handle', 'The NStack capability is no longer active. Request access again.');
      if (Date.parse(handle.expiresAt) <= Date.now()) {
        handle.active = false;
        handle.reason = 'expired';
        throw fail('stale_handle', 'The NStack capability expired. Request access again.');
      }
      return { ...handle, connection: { ...handle.connection } };
    },

    on(event, handler) {
      if (event !== 'change' || typeof handler !== 'function') throw fail('invalid_request', 'Only NStack change events are supported.');
      listeners.add(handler);
      if (!providerUnsubscribe && typeof provider?.on === 'function') providerUnsubscribe = provider.on('change', invalidate);
      return () => {
        listeners.delete(handler);
        if (listeners.size === 0 && typeof providerUnsubscribe === 'function') {
          providerUnsubscribe();
          providerUnsubscribe = null;
        }
      };
    },

    dispose() {
      if (typeof providerUnsubscribe === 'function') providerUnsubscribe();
      providerUnsubscribe = null;
      listeners.clear();
      handles.clear();
      stacks.clear();
      workspaces.clear();
    },
  };
}

export function nstackErrorMessage(error) { return error?.message || 'The NStack request failed.'; }
