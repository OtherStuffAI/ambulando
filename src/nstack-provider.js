const SECRET_KEYS = new Set([
  'adminCredential', 'bearerToken', 'cookie', 'databaseCredential', 'nsec',
  'nwc', 'privateKey', 'rawToken', 'secret', 'signature', 'signerSecret', 'token',
  'wrappedSecret', 'wrappedWorkspaceNsec',
]);

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
    if (SECRET_KEYS.has(key) || /(?:^|_)(?:credential|password|secret|signature|token)(?:$|_)/i.test(key)) {
      throw fail('malformed', `${path} exposed forbidden credential material.`);
    }
    if (child && typeof child === 'object') assertNoSecrets(child, `${path}.${key}`);
  }
}

function validateNpub(value, label) {
  const npub = text(value);
  if (!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(npub)) {
    throw fail('malformed', `${label} is not a valid npub.`);
  }
  return npub;
}

function canonicalHttpsUrl(value, label) {
  let url;
  try { url = new URL(text(value)); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw fail('malformed', `${label} is not a safe canonical HTTPS URL.`);
  }
  return url.toString().replace(/\/$/, '');
}

function safeFipsMetadata(value = {}) {
  const rawEndpoint = text(value.fipsEndpoint);
  const rawPeer = text(value.peerNpub);
  if (!rawEndpoint && !rawPeer) return {};
  if (!rawEndpoint || !rawPeer) throw fail('malformed', 'FIPS endpoint and peer npub must be disclosed together.');
  let endpoint;
  try { endpoint = new URL(rawEndpoint); } catch { /* handled below */ }
  if (!endpoint || endpoint.protocol !== 'http:' || !endpoint.hostname.endsWith('.fips')
    || endpoint.hostname.length <= 5 || !endpoint.port || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
    throw fail('malformed', 'The NStack provider returned unsafe FIPS metadata.');
  }
  return {
    fipsEndpoint: endpoint.toString(),
    peerNpub: validateNpub(rawPeer, 'FIPS peer npub'),
  };
}

function validateStack(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('malformed', `NStack ${index + 1} is malformed.`);
  assertNoSecrets(value, `NStack ${index + 1}`);
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name || typeof value.host !== 'boolean' || value.available !== true) {
    throw fail('malformed', `NStack ${index + 1} does not match the window.NStack v1 summary.`);
  }
  const result = { id, name, host: value.host, available: true };
  if (value.url !== undefined) result.url = canonicalHttpsUrl(value.url, `NStack ${index + 1} URL`);
  if (value.stale !== undefined) {
    if (typeof value.stale !== 'boolean') throw fail('malformed', `NStack ${index + 1} stale state is malformed.`);
    result.stale = value.stale;
  }
  if (value.lastRefreshedAt !== undefined && value.lastRefreshedAt !== null) {
    const lastRefreshedAt = text(value.lastRefreshedAt);
    if (!lastRefreshedAt || Number.isNaN(Date.parse(lastRefreshedAt))) throw fail('malformed', `NStack ${index + 1} refresh time is malformed.`);
    result.lastRefreshedAt = lastRefreshedAt;
  }
  return result;
}

function validateWorkspace(value, index, stack) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('malformed', `Workspace ${index + 1} is malformed.`);
  assertNoSecrets(value, `Workspace ${index + 1}`);
  const id = text(value.id);
  const name = text(value.name);
  const workspaceId = text(value.workspaceId);
  if (!id || !name || !workspaceId) throw fail('malformed', `Workspace ${index + 1} does not match the window.NStack v1 summary.`);
  const directHttpsUrl = canonicalHttpsUrl(value.directHttpsUrl, `Workspace ${index + 1} Tower URL`);
  const nstack = value.nstack;
  if (!nstack || typeof nstack !== 'object' || Array.isArray(nstack)
    || text(nstack.id) !== stack.id || text(nstack.name) !== stack.name
    || (stack.url && canonicalHttpsUrl(nstack.url, `Workspace ${index + 1} NStack URL`) !== stack.url)) {
    throw fail('malformed', `Workspace ${index + 1} does not match its disclosed NStack.`);
  }
  return {
    id,
    name,
    workspaceId,
    workspaceOwnerNpub: validateNpub(value.workspaceOwnerNpub, `Workspace ${index + 1} owner npub`),
    workspaceServiceNpub: validateNpub(value.workspaceServiceNpub, `Workspace ${index + 1} service npub`),
    directHttpsUrl,
    serviceNpub: validateNpub(value.serviceNpub, `Workspace ${index + 1} Tower service npub`),
    ...safeFipsMetadata(value),
    nstack: { id: stack.id, name: stack.name, url: canonicalHttpsUrl(nstack.url, `Workspace ${index + 1} NStack URL`) },
  };
}

export async function waitForNStackProvider({ windowObject = globalThis.window, provider, timeoutMs = 1_500 } = {}) {
  if (provider) return provider;
  if (!windowObject) return null;
  const immediate = windowObject.NStack;
  const ready = immediate?.ready || windowObject.NStackReady;
  if (ready && typeof ready.then === 'function') {
    return Promise.race([
      ready.then(value => value || windowObject.NStack),
      new Promise(resolve => setTimeout(() => resolve(windowObject.NStack || null), timeoutMs)),
    ]);
  }
  if (immediate) return immediate;
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      windowObject.removeEventListener?.('nstackready', onReady);
      resolve(windowObject.NStack || null);
    };
    const onReady = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    windowObject.addEventListener?.('nstackready', onReady, { once: true });
  });
}

export function createNStackProviderAdapter({ provider, origin } = {}) {
  const pageOrigin = text(origin);
  let discoveryApproved = false;
  let stacks = new Map();
  let workspaces = new Map();
  const listeners = new Set();
  let providerUnsubscribe = null;

  function requireMethod(name) {
    if (typeof provider?.[name] !== 'function') throw fail('unavailable', 'NStack discovery is unavailable in this browser.');
    return provider[name].bind(provider);
  }

  function invalidate(change = {}) {
    const reason = text(change?.reason) || 'changed';
    discoveryApproved = false;
    stacks = new Map();
    workspaces = new Map();
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
        if (new Set(rows.map(row => row.id)).size !== rows.length) throw fail('malformed', 'The NStack list contains duplicate opaque ids.');
        stacks = new Map(rows.map(row => [row.id, row]));
        return rows;
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    async listWorkspaces({ stackId } = {}) {
      const selectedStackId = text(stackId);
      if (!discoveryApproved) throw fail('not_disclosed', 'Request NStack discovery first.');
      const stack = stacks.get(selectedStackId);
      if (!stack) throw fail('not_disclosed', 'Choose an NStack disclosed to this origin.');
      try {
        const result = await requireMethod('listWorkspaces')({ stackId: selectedStackId });
        if (!Array.isArray(result)) throw fail('malformed', 'The NStack workspace list is malformed.');
        const rows = result.map((row, index) => validateWorkspace(row, index, stack));
        if (new Set(rows.map(row => row.id)).size !== rows.length
          || new Set(rows.map(row => `${row.workspaceId}\n${row.workspaceOwnerNpub}\n${row.workspaceServiceNpub}`)).size !== rows.length) {
          throw fail('malformed', 'The NStack workspace list contains duplicate identities.');
        }
        workspaces.set(selectedStackId, new Map(rows.map(row => [row.id, row])));
        return rows;
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
    },

    getWorkspaceDescriptor({ stackId, workspaceId } = {}) {
      const descriptor = workspaces.get(text(stackId))?.get(text(workspaceId));
      if (!descriptor) throw fail('not_disclosed', 'Choose a workspace disclosed to this origin.');
      return structuredClone(descriptor);
    },

    async getConnection({ stackId, workspaceId } = {}) {
      const selectedStackId = text(stackId);
      const selectedWorkspaceId = text(workspaceId);
      const stack = stacks.get(selectedStackId);
      const listed = workspaces.get(selectedStackId)?.get(selectedWorkspaceId);
      if (!stack || !listed) throw fail('not_disclosed', 'Choose a workspace disclosed to this origin.');
      try {
        const current = validateWorkspace(
          await requireMethod('getConnection')({ stackId: selectedStackId, workspaceId: selectedWorkspaceId }),
          0,
          stack,
        );
        const stableFields = ['id', 'workspaceId', 'workspaceOwnerNpub', 'workspaceServiceNpub', 'directHttpsUrl', 'serviceNpub', 'fipsEndpoint', 'peerNpub'];
        if (stableFields.some(field => text(current[field]) !== text(listed[field]))) {
          throw fail('malformed', 'The NStack connection changed after it was listed. Discover it again.');
        }
        return structuredClone(current);
      } catch (error) {
        throw error?.name === 'NStackError' ? error : normalizeProviderError(error);
      }
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
      stacks.clear();
      workspaces.clear();
    },
  };
}

export function nstackErrorMessage(error) { return error?.message || 'The NStack request failed.'; }
