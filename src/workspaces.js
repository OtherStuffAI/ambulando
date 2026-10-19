import { pgWorkspaceIdentityKey } from './pg-workspace-descriptor.js';
import { APP_NPUB, FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import { isPgWorkspacesOnlyMode } from './backend-mode.js';
import { buildSuperBasedConnectionToken, parseSuperBasedToken } from './superbased-token.js';

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function firstOwnValue(obj, keys) {
  for (const key of keys) {
    if (hasOwn(obj, key)) return { found: true, value: obj[key] };
  }
  return { found: false, value: undefined };
}

export function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'workspace';
}

function sanitizeOptionalString(value) {
  if (value == null) return null;
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function sanitizeRelayUrls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeUrlForIdentity(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function pgSessionNpubFromEntry(raw = {}) {
  return String(
    raw.pgSessionNpub
    || raw.pg_session_npub
    || raw.sessionNpub
    || raw.session_npub
    || raw.pgMe?.actor?.npub
    || raw.pg_me?.actor?.npub
    || ''
  ).trim() || null;
}

export function buildWorkspaceKey({
  workspaceOwnerNpub,
  serviceNpub = null,
  directHttpsUrl = '',
} = {}) {
  const owner = String(workspaceOwnerNpub || '').trim();
  if (!owner) return '';
  const service = String(serviceNpub || '').trim();
  if (service) return `service:${service}::workspace:${owner}`;
  const url = normalizeUrlForIdentity(directHttpsUrl);
  if (url) return `url:${url}::workspace:${owner}`;
  return `workspace:${owner}`;
}

export function workspaceSelectionKey(raw = {}) {
  const normalized = normalizeWorkspaceEntry(raw);
  return normalized?.workspaceKey || '';
}

function sameWorkspaceIdentity(left = {}, right = {}) {
  const leftOwner = String(left.workspaceOwnerNpub || '').trim();
  const rightOwner = String(right.workspaceOwnerNpub || '').trim();
  if (!leftOwner || !rightOwner || leftOwner !== rightOwner) return false;

  if (left.pgBackendMode || right.pgBackendMode) {
    if (left.workspaceId !== right.workspaceId) return false;
    const leftKey = String(left.workspaceKey || '').trim();
    const rightKey = String(right.workspaceKey || '').trim();
    if (leftKey && rightKey && leftKey === rightKey) return true;

    const leftSession = String(left.pgSessionNpub || '').trim();
    const rightSession = String(right.pgSessionNpub || '').trim();
    if (leftSession && rightSession && leftSession !== rightSession) return false;

    const leftTower = String(left.towerServiceNpub || left.serviceNpub || '').trim();
    const rightTower = String(right.towerServiceNpub || right.serviceNpub || '').trim();
    const leftWorkspace = String(left.workspaceServiceNpub || '').trim();
    const rightWorkspace = String(right.workspaceServiceNpub || '').trim();
    const leftApp = String(left.appNpub || '').trim();
    const rightApp = String(right.appNpub || '').trim();
    return Boolean(leftTower && rightTower && leftWorkspace && rightWorkspace && leftApp && rightApp
      && leftTower === rightTower
      && leftWorkspace === rightWorkspace
      && leftApp === rightApp);
  }

  const leftService = String(left.serviceNpub || '').trim();
  const rightService = String(right.serviceNpub || '').trim();
  if (leftService && rightService) return leftService === rightService;

  if (!leftService && !rightService) {
    const leftUrl = normalizeUrlForIdentity(left.directHttpsUrl);
    const rightUrl = normalizeUrlForIdentity(right.directHttpsUrl);
    if (leftUrl && rightUrl) return leftUrl === rightUrl;
  }

  return true;
}

function findMergeCandidate(next, normalized) {
  if (!normalized) return null;
  if (next.has(normalized.workspaceKey)) {
    return normalized.workspaceKey;
  }
  for (const [key, current] of next.entries()) {
    if (sameWorkspaceIdentity(current, normalized)) return key;
  }
  return null;
}

export function normalizeWorkspaceEntry(raw = {}) {
  const token = String(raw.connectionToken || raw.connection_token || '').trim();
  const parsedToken = token ? parseSuperBasedToken(token) : { isValid: false };
  const workspaceOwnerNpub = String(
    raw.workspaceOwnerNpub
    || raw.workspace_owner_npub
    || raw.workspace_npub
    || raw.owner_npub
    || parsedToken.workspaceOwnerNpub
    || ''
  ).trim();
  if (!workspaceOwnerNpub) return null;

  const directHttpsUrl = String(
    raw.directHttpsUrl
    || raw.direct_https_url
    || raw.backendUrl
    || raw.httpUrl
    || parsedToken.directHttpsUrl
    || ''
  ).trim();
  const serviceNpub = String(raw.serviceNpub || raw.service_npub || parsedToken.serviceNpub || '').trim() || null;
  const towerServiceNpub = String(raw.towerServiceNpub || raw.tower_service_npub || '').trim() || serviceNpub || null;
  const workspaceServiceNpub = String(raw.workspaceServiceNpub || raw.workspace_service_npub || '').trim() || null;
  const pgBackendMode = Boolean(raw.pgBackendMode || raw.pg_backend_mode);
  const defaultAppNpub = pgBackendMode ? FLIGHT_DECK_PG_APP_NPUB : APP_NPUB;
  const appNpub = String(raw.appNpub || raw.app_npub || parsedToken.appNpub || defaultAppNpub || '').trim() || null;
  const pgSessionNpub = pgSessionNpubFromEntry(raw);
  const relayUrls = sanitizeRelayUrls(raw.relayUrls ?? raw.relay_urls ?? parsedToken.relayUrls);
  const towerName = sanitizeOptionalString(
    raw.towerName
    ?? raw.tower_name
    ?? parsedToken.towerName
    ?? null,
  );
  const towerDescription = sanitizeOptionalString(
    raw.towerDescription
    ?? raw.tower_description
    ?? parsedToken.towerDescription
    ?? null,
  );
  const name = String(
    raw.name
    ?? raw.workspace_name
    ?? raw.workspaceName
    ?? ''
  ).trim();
  const description = String(
    raw.description
    ?? raw.workspace_description
    ?? raw.workspaceDescription
    ?? ''
  ).trim();
  const avatarUrl = sanitizeOptionalString(
    raw.avatarUrl
    ?? raw.avatar_url
    ?? raw.workspace_avatar_url
    ?? raw.workspaceAvatarUrl
    ?? null,
  );
  const dashboardGreetingTemplate = String(
    raw.dashboardGreetingTemplate
    ?? raw.dashboard_greeting_template
    ?? ''
  ).trim();
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? raw.metadata
    : {};

  const connectionToken = pgBackendMode
    ? token
    : (token || buildSuperBasedConnectionToken({
      directHttpsUrl,
      serviceNpub,
      towerName,
      towerDescription,
      workspaceOwnerNpub,
      appNpub,
      relayUrls,
    }));

  const slug = String(raw.slug || '').trim() || slugify(name);
  const workspaceId = String(raw.workspaceId || raw.workspace_id || '').trim() || null;
  const fipsEndpoint = String(raw.fipsEndpoint || raw.fips_endpoint || '').trim() || null;
  const peerNpub = String(raw.peerNpub || raw.peer_npub || '').trim() || null;
  const savedKey = String(raw.workspaceKey || raw.workspace_key || '').trim();
  const workspaceKey = pgBackendMode && workspaceId
    ? pgWorkspaceIdentityKey({ pgSessionNpub, towerServiceNpub, workspaceServiceNpub, appNpub, workspaceId })
    : savedKey || (pgBackendMode
      ? pgWorkspaceIdentityKey({ pgSessionNpub, towerServiceNpub, workspaceServiceNpub, appNpub })
      : buildWorkspaceKey({ workspaceOwnerNpub, serviceNpub, directHttpsUrl }));

  return {
    workspaceKey,
    workspaceOwnerNpub,
    name,
    slug,
    description,
    avatarUrl,
    dashboardGreetingTemplate,
    metadata,
    directHttpsUrl,
    serviceNpub,
    towerServiceNpub,
    workspaceServiceNpub,
    workspaceId,
    fipsEndpoint,
    peerNpub,
    pgSessionNpub,
    pgBackendMode,
    pgDescriptor: raw.pgDescriptor || raw.pg_descriptor || null,
    pgDescriptorVerifiedAt: String(raw.pgDescriptorVerifiedAt || raw.pg_descriptor_verified_at || '').trim() || null,
    pgMe: raw.pgMe || raw.pg_me || null,
    pgSelfIndexStatus: String(raw.pgSelfIndexStatus || raw.pg_self_index_status || '').trim() || null,
    pgSelfIndexError: String(raw.pgSelfIndexError || raw.pg_self_index_error || '').trim() || null,
    pgSelfIndexPublishedAt: String(raw.pgSelfIndexPublishedAt || raw.pg_self_index_published_at || '').trim() || null,
    pgSelfIndexFailedAt: String(raw.pgSelfIndexFailedAt || raw.pg_self_index_failed_at || '').trim() || null,
    pgSelfIndexDiscoveredAt: String(raw.pgSelfIndexDiscoveredAt || raw.pg_self_index_discovered_at || '').trim() || null,
    pgSelfIndexVerifiedAt: String(raw.pgSelfIndexVerifiedAt || raw.pg_self_index_verified_at || '').trim() || null,
    pgSelfIndexStaleAt: String(raw.pgSelfIndexStaleAt || raw.pg_self_index_stale_at || '').trim() || null,
    pgSelfIndexEventId: String(raw.pgSelfIndexEventId || raw.pg_self_index_event_id || '').trim() || null,
    pgSelfIndexLastBroadcastAt: String(raw.pgSelfIndexLastBroadcastAt || raw.pg_self_index_last_broadcast_at || '').trim() || null,
    pgSelfIndexSignedEvent: raw.pgSelfIndexSignedEvent || raw.pg_self_index_signed_event || null,
    pgSelfIndexRelays: sanitizeRelayUrls(raw.pgSelfIndexRelays ?? raw.pg_self_index_relays),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    towerName,
    towerDescription,
    appNpub,
    relayUrls,
    defaultGroupNpub: String(raw.defaultGroupNpub || raw.default_group_npub || '').trim() || null,
    defaultGroupId: String(raw.defaultGroupId || raw.default_group_id || '').trim() || null,
    adminGroupNpub: String(raw.adminGroupNpub || raw.admin_group_npub || '').trim() || null,
    adminGroupId: String(raw.adminGroupId || raw.admin_group_id || '').trim() || null,
    privateGroupNpub: String(raw.privateGroupNpub || raw.private_group_npub || '').trim() || null,
    privateGroupId: String(raw.privateGroupId || raw.private_group_id || '').trim() || null,
    creatorNpub: String(raw.creatorNpub || raw.creator_npub || '').trim() || null,
    wrappedWorkspaceNsec: String(raw.wrappedWorkspaceNsec || raw.wrapped_workspace_nsec || '').trim() || null,
    wrappedByNpub: String(raw.wrappedByNpub || raw.wrapped_by_npub || '').trim() || null,
    connectionToken,
  };
}

function normalizeWorkspacePatch(raw = {}) {
  const normalized = normalizeWorkspaceEntry(raw);
  if (!normalized) return null;

  const patch = {
    workspaceKey: normalized.workspaceKey,
    workspaceOwnerNpub: normalized.workspaceOwnerNpub,
  };
  const fieldMap = [
    [['name', 'workspace_name', 'workspaceName'], 'name'],
    [['slug'], 'slug'],
    [['description', 'workspace_description', 'workspaceDescription'], 'description'],
    [['avatarUrl', 'avatar_url', 'workspace_avatar_url', 'workspaceAvatarUrl'], 'avatarUrl'],
    [['dashboardGreetingTemplate', 'dashboard_greeting_template'], 'dashboardGreetingTemplate'],
    [['metadata'], 'metadata'],
    [['directHttpsUrl', 'direct_https_url', 'backendUrl', 'httpUrl'], 'directHttpsUrl'],
    [['serviceNpub', 'service_npub'], 'serviceNpub'],
    [['towerServiceNpub', 'tower_service_npub'], 'towerServiceNpub'],
    [['workspaceServiceNpub', 'workspace_service_npub'], 'workspaceServiceNpub'],
    [['workspaceId', 'workspace_id'], 'workspaceId'],
    [['fipsEndpoint', 'fips_endpoint'], 'fipsEndpoint'],
    [['peerNpub', 'peer_npub'], 'peerNpub'],
    [['pgSessionNpub', 'pg_session_npub', 'sessionNpub', 'session_npub'], 'pgSessionNpub'],
    [['pgBackendMode', 'pg_backend_mode'], 'pgBackendMode'],
    [['pgDescriptor', 'pg_descriptor'], 'pgDescriptor'],
    [['pgDescriptorVerifiedAt', 'pg_descriptor_verified_at'], 'pgDescriptorVerifiedAt'],
    [['pgMe', 'pg_me'], 'pgMe'],
    [['pgSelfIndexStatus', 'pg_self_index_status'], 'pgSelfIndexStatus'],
    [['pgSelfIndexError', 'pg_self_index_error'], 'pgSelfIndexError'],
    [['pgSelfIndexPublishedAt', 'pg_self_index_published_at'], 'pgSelfIndexPublishedAt'],
    [['pgSelfIndexFailedAt', 'pg_self_index_failed_at'], 'pgSelfIndexFailedAt'],
    [['pgSelfIndexDiscoveredAt', 'pg_self_index_discovered_at'], 'pgSelfIndexDiscoveredAt'],
    [['pgSelfIndexVerifiedAt', 'pg_self_index_verified_at'], 'pgSelfIndexVerifiedAt'],
    [['pgSelfIndexStaleAt', 'pg_self_index_stale_at'], 'pgSelfIndexStaleAt'],
    [['pgSelfIndexEventId', 'pg_self_index_event_id'], 'pgSelfIndexEventId'],
    [['pgSelfIndexLastBroadcastAt', 'pg_self_index_last_broadcast_at'], 'pgSelfIndexLastBroadcastAt'],
    [['pgSelfIndexSignedEvent', 'pg_self_index_signed_event'], 'pgSelfIndexSignedEvent'],
    [['capabilities'], 'capabilities'],
    [['towerName', 'tower_name'], 'towerName'],
    [['towerDescription', 'tower_description'], 'towerDescription'],
    [['appNpub', 'app_npub'], 'appNpub'],
    [['defaultGroupNpub', 'default_group_npub'], 'defaultGroupNpub'],
    [['defaultGroupId', 'default_group_id'], 'defaultGroupId'],
    [['adminGroupNpub', 'admin_group_npub'], 'adminGroupNpub'],
    [['adminGroupId', 'admin_group_id'], 'adminGroupId'],
    [['privateGroupNpub', 'private_group_npub'], 'privateGroupNpub'],
    [['privateGroupId', 'private_group_id'], 'privateGroupId'],
    [['creatorNpub', 'creator_npub'], 'creatorNpub'],
    [['wrappedWorkspaceNsec', 'wrapped_workspace_nsec'], 'wrappedWorkspaceNsec'],
    [['wrappedByNpub', 'wrapped_by_npub'], 'wrappedByNpub'],
    [['connectionToken', 'connection_token'], 'connectionToken'],
  ];

  for (const [keys, normalizedKey] of fieldMap) {
    const own = firstOwnValue(raw, keys);
    if (own.found && own.value !== undefined) patch[normalizedKey] = normalized[normalizedKey];
  }
  const relayUrls = firstOwnValue(raw, ['relayUrls', 'relay_urls']);
  if (relayUrls.found && relayUrls.value !== undefined) patch.relayUrls = normalized.relayUrls;
  const pgSelfIndexRelays = firstOwnValue(raw, ['pgSelfIndexRelays', 'pg_self_index_relays']);
  if (pgSelfIndexRelays.found && pgSelfIndexRelays.value !== undefined) patch.pgSelfIndexRelays = normalized.pgSelfIndexRelays;

  return patch;
}

export function mergeWorkspaceEntries(existing = [], incoming = []) {
  const next = new Map();
  for (const entry of existing) {
    const normalized = normalizeWorkspaceEntry(entry);
    if (!normalized) continue;
    const candidateKey = findMergeCandidate(next, normalized) || normalized.workspaceKey;
    const current = next.get(candidateKey) || {};
    const merged = normalizeWorkspaceEntry({
      ...current,
      ...normalized,
    });
    if (!merged) continue;
    if (candidateKey !== merged.workspaceKey) next.delete(candidateKey);
    next.set(merged.workspaceKey, merged);
  }
  for (const entry of incoming) {
    const patch = normalizeWorkspacePatch(entry);
    if (!patch) continue;
    const candidateKey = findMergeCandidate(next, patch) || patch.workspaceKey;
    const current = next.get(candidateKey) || {};
    const merged = normalizeWorkspaceEntry({
      ...current,
      ...patch,
    });
    if (!merged) continue;
    if (candidateKey !== merged.workspaceKey) next.delete(candidateKey);
    next.set(merged.workspaceKey, merged);
  }
  return [...next.values()];
}

export function filterWorkspacesForSession(workspaces = [], sessionNpub = '') {
  const activeSession = String(sessionNpub || '').trim();
  const pgOnly = isPgWorkspacesOnlyMode();
  return (Array.isArray(workspaces) ? workspaces : [])
    .map((entry) => normalizeWorkspaceEntry(entry))
    .filter(Boolean)
    .filter((entry) => !pgOnly || entry.pgBackendMode)
    .filter((entry) => {
      if (!entry.pgBackendMode) return true;
      if (!activeSession) return false;
      return !entry.pgSessionNpub || entry.pgSessionNpub === activeSession;
    });
}

export function findWorkspaceByKey(workspaces, workspaceKey) {
  if (!workspaceKey || !Array.isArray(workspaces)) return null;
  const exact = workspaces.find((w) => w.workspaceKey === workspaceKey);
  if (exact) return exact;
  // Restore an old key only when it identifies one saved workspace unambiguously.
  const legacy = workspaces.filter((w) => w.pgBackendMode && w.workspaceId
    && w.workspaceKey === `${workspaceKey}::id:${w.workspaceId}`);
  return legacy.length === 1 ? legacy[0] : null;
}

export function findWorkspaceBySlug(workspaces, slug) {
  if (!slug || !Array.isArray(workspaces)) return null;
  return workspaces.find((w) => w.slug === slug) || null;
}

export function findWorkspaceById(workspaces, workspaceId) {
  const id = String(workspaceId || '').trim();
  if (!id || !Array.isArray(workspaces)) return null;
  return workspaces.find((w) => String(w?.workspaceId || '').trim() === id) || null;
}

export function workspaceFromToken(token, extras = {}) {
  const parsed = parseSuperBasedToken(token);
  if (!parsed?.isValid || !parsed?.directHttpsUrl) return null;
  const workspaceOwnerNpub = String(parsed.workspaceOwnerNpub || extras.workspaceOwnerNpub || '').trim();
  if (!workspaceOwnerNpub) return null;

  const workspace = {
    workspaceKey: buildWorkspaceKey({
      workspaceOwnerNpub,
      serviceNpub: parsed.serviceNpub,
      directHttpsUrl: parsed.directHttpsUrl,
    }),
    workspaceOwnerNpub,
    directHttpsUrl: parsed.directHttpsUrl,
    serviceNpub: parsed.serviceNpub,
    towerName: parsed.towerName,
    towerDescription: parsed.towerDescription,
    appNpub: parsed.appNpub,
    relayUrls: parsed.relayUrls || [],
    connectionToken: token,
  };

  const name = String(parsed.workspaceName || extras.name || '').trim();
  if (name) workspace.name = name;

  const description = String(extras.description || '').trim();
  if (description) workspace.description = description;

  return workspace;
}
