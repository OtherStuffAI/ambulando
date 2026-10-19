function text(value) {
  return String(value ?? '').trim();
}

export function normalizeNStackEndpoint(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizeServerNpub(value) {
  const normalized = text(value).toLowerCase();
  return normalized.startsWith('npub1') ? normalized : '';
}

function endpointLabel(endpoint) {
  try { return new URL(endpoint).hostname || ''; }
  catch { return ''; }
}

function configuredIdentity({ endpoint, serverNpub, fallback }) {
  if (endpoint) return `endpoint:${endpoint}`;
  if (serverNpub) return `server:${serverNpub}`;
  return `configured:${text(fallback) || 'current'}`;
}

function configuredLabel({ towerName, label, endpoint, active }) {
  return text(towerName) || text(label) || endpointLabel(endpoint) || (active ? 'Current NStack' : 'Known NStack');
}

function workspaceKey(entry = {}) {
  return text(entry.workspaceKey || entry.workspace_key || entry.workspaceOwnerNpub || entry.workspace_owner_npub);
}

function workspaceEndpoint(entry = {}) {
  return normalizeNStackEndpoint(entry.directHttpsUrl || entry.direct_https_url || entry.backendUrl || entry.httpUrl);
}

function workspaceServerNpub(entry = {}) {
  return normalizeServerNpub(entry.towerServiceNpub || entry.tower_service_npub || entry.serviceNpub || entry.service_npub);
}

function workspaceLabel(entry = {}) {
  return text(entry.name || entry.workspaceName || entry.workspace_name) || 'Workspace';
}

function sourceLabel(sources, provisional) {
  if (provisional) return 'Found through Nostr Browser';
  if (sources.includes('browser') && sources.includes('configured')) return 'Configured · shared by Nostr Browser';
  if (sources.includes('browser')) return 'Shared by Nostr Browser';
  return 'Configured on this device';
}

function addSource(entry, source) {
  if (!entry.sources.includes(source)) entry.sources.push(source);
}

function findConfiguredMatch(stacks, connection = {}) {
  const endpoint = normalizeNStackEndpoint(connection.url);
  const serverNpub = normalizeServerNpub(connection.peerNpub);
  return stacks.find(stack => (
    (endpoint && stack.endpoint === endpoint)
    || (serverNpub && stack.serverNpub === serverNpub)
  )) || null;
}

export function projectNStackDestinations({
  knownHosts = [],
  knownWorkspaces = [],
  currentWorkspace = null,
  currentBackendUrl = '',
  browserStacks = [],
  browserWorkspaceCatalogues = {},
  browserApprovedConnections = {},
  browserOrigin = '',
} = {}) {
  const activeWorkspaceKey = workspaceKey(currentWorkspace || {});
  const activeEndpoint = normalizeNStackEndpoint(workspaceEndpoint(currentWorkspace || {}) || currentBackendUrl);
  const activeServerNpub = workspaceServerNpub(currentWorkspace || {});
  const configured = new Map();

  const ensureConfigured = ({ endpoint = '', serverNpub = '', label = '', towerName = '', fallback = '', active = false } = {}) => {
    const identity = configuredIdentity({ endpoint, serverNpub, fallback });
    if (!configured.has(identity)) {
      configured.set(identity, {
        key: `configured:${identity}`,
        endpoint,
        serverNpub,
        label: configuredLabel({ towerName, label, endpoint, active }),
        sources: ['configured'],
        provisional: false,
        active: false,
        browserStackId: '',
        workspaces: [],
      });
    }
    const stack = configured.get(identity);
    if (!stack.endpoint && endpoint) stack.endpoint = endpoint;
    if (!stack.serverNpub && serverNpub) stack.serverNpub = serverNpub;
    const richerLabel = configuredLabel({ towerName, label, endpoint, active });
    if (text(towerName) || (richerLabel && (!stack.label || stack.label === 'Known NStack' || stack.label === 'Current NStack'))) stack.label = richerLabel;
    return stack;
  };

  for (const host of knownHosts) {
    const endpoint = normalizeNStackEndpoint(host?.url || host?.directHttpsUrl);
    const serverNpub = normalizeServerNpub(host?.serviceNpub || host?.towerServiceNpub);
    if (!endpoint && !serverNpub) continue;
    const active = Boolean((activeEndpoint && endpoint === activeEndpoint) || (activeServerNpub && serverNpub === activeServerNpub));
    ensureConfigured({ endpoint, serverNpub, label: host?.label, towerName: host?.towerName, fallback: host?.url, active });
  }

  for (const workspace of knownWorkspaces) {
    const endpoint = workspaceEndpoint(workspace);
    const serverNpub = workspaceServerNpub(workspace);
    const key = workspaceKey(workspace);
    const active = Boolean((key && key === activeWorkspaceKey) || (!activeWorkspaceKey && activeEndpoint && endpoint === activeEndpoint));
    const stack = ensureConfigured({
      endpoint,
      serverNpub,
      label: workspace?.towerName,
      towerName: workspace?.towerName,
      fallback: key,
      active,
    });
    stack.active ||= active;
    if (!stack.workspaces.some(entry => entry.workspaceKey && entry.workspaceKey === key)) {
      stack.workspaces.push({
        key: `configured:${key || `${stack.key}:${stack.workspaces.length}`}`,
        workspaceKey: key,
        browserWorkspaceId: '',
        remoteWorkspaceId: text(workspace?.workspaceId || workspace?.workspace_id),
        workspaceOwnerNpub: text(workspace?.workspaceOwnerNpub || workspace?.workspace_owner_npub),
        workspaceServiceNpub: text(workspace?.workspaceServiceNpub || workspace?.workspace_service_npub),
        label: workspaceLabel(workspace),
        source: 'configured',
        active,
        authorized: false,
      });
    }
  }

  if (activeWorkspaceKey || activeEndpoint || activeServerNpub) {
    const stack = ensureConfigured({
      endpoint: activeEndpoint,
      serverNpub: activeServerNpub,
      label: currentWorkspace?.towerName,
      towerName: currentWorkspace?.towerName,
      fallback: activeWorkspaceKey || activeEndpoint,
      active: true,
    });
    stack.active = true;
    if (activeWorkspaceKey && !stack.workspaces.some(entry => entry.workspaceKey === activeWorkspaceKey)) {
      stack.workspaces.push({
        key: `configured:${activeWorkspaceKey}`,
        workspaceKey: activeWorkspaceKey,
        browserWorkspaceId: '',
        remoteWorkspaceId: text(currentWorkspace?.workspaceId || currentWorkspace?.workspace_id),
        workspaceOwnerNpub: text(currentWorkspace?.workspaceOwnerNpub || currentWorkspace?.workspace_owner_npub),
        workspaceServiceNpub: text(currentWorkspace?.workspaceServiceNpub || currentWorkspace?.workspace_service_npub),
        label: workspaceLabel(currentWorkspace),
        source: 'configured',
        active: true,
        authorized: false,
      });
    }
  }

  const stacks = [...configured.values()];
  for (const browserStack of browserStacks) {
    const browserStackId = text(browserStack?.id);
    if (!browserStackId) continue;
    const connection = browserApprovedConnections[browserStackId] || null;
    let stack = connection ? findConfiguredMatch(stacks, connection) : null;
    if (!stack) {
      const endpoint = connection ? normalizeNStackEndpoint(connection.url) : '';
      const serverNpub = connection ? normalizeServerNpub(connection.peerNpub) : '';
      stack = {
        key: `browser:${text(browserOrigin) || 'origin'}:${browserStackId}`,
        endpoint,
        serverNpub,
        label: text(browserStack.name) || (endpoint ? endpointLabel(endpoint) : 'Discovered NStack'),
        sources: ['browser'],
        provisional: !connection,
        active: false,
        browserStackId,
        workspaces: [],
      };
      stacks.push(stack);
    } else {
      addSource(stack, 'browser');
      stack.browserStackId = browserStackId;
    }
    const catalogue = Array.isArray(browserWorkspaceCatalogues[browserStackId])
      ? browserWorkspaceCatalogues[browserStackId]
      : [];
    for (const workspace of catalogue) {
      const id = text(workspace?.id);
      if (!id || stack.workspaces.some(entry => entry.browserWorkspaceId === id)) continue;
      const remoteWorkspaceId = text(workspace?.workspaceId);
      const workspaceOwnerNpub = text(workspace?.workspaceOwnerNpub);
      const workspaceServiceNpub = text(workspace?.workspaceServiceNpub);
      const configuredWorkspace = stack.workspaces.find(entry => (
        remoteWorkspaceId && entry.remoteWorkspaceId === remoteWorkspaceId
        && workspaceOwnerNpub && entry.workspaceOwnerNpub === workspaceOwnerNpub
        && workspaceServiceNpub && entry.workspaceServiceNpub === workspaceServiceNpub
      ));
      if (configuredWorkspace) {
        configuredWorkspace.browserWorkspaceId = id;
        configuredWorkspace.source = 'configured_browser';
        continue;
      }
      stack.workspaces.push({
        key: `browser:${browserStackId}:${id}`,
        workspaceKey: '',
        browserWorkspaceId: id,
        remoteWorkspaceId,
        workspaceOwnerNpub,
        workspaceServiceNpub,
        label: text(workspace.name) || 'Workspace',
        source: 'browser',
        active: false,
        authorized: false,
      });
    }
  }

  for (const stack of stacks) {
    stack.sourceLabel = sourceLabel(stack.sources, stack.provisional);
    stack.status = stack.active ? 'active' : (stack.provisional ? 'discovered' : 'known');
    stack.workspaces.sort((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label));
  }
  return stacks.sort((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label));
}

export function activeNStackRoute(destinations = []) {
  const stack = destinations.find(entry => entry.active) || null;
  if (!stack) return null;
  const workspace = stack.workspaces.find(entry => entry.active) || null;
  return {
    stackLabel: stack.label || 'Current NStack',
    workspaceLabel: workspace?.label || 'No workspace selected',
  };
}
