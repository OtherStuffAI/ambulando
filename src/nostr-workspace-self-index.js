import { SimplePool, verifyEvent } from 'nostr-tools';
import { APP_NPUB, FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import {
  decodeNpub,
  personalDecryptFromNpub,
  personalEncryptForNpub,
  pubkeyToNpub,
  signNostrEvent,
} from './auth/nostr.js';
import { parsePgWorkspaceDescriptor } from './pg-workspace-descriptor.js';
import { normalizeBackendUrl } from './utils/state-helpers.js';

export const WORKSPACE_SELF_INDEX_KIND = 33356;
export const WORKSPACE_SELF_INDEX_PROTOCOL = 'workspace-self-index';
export const WORKSPACE_SELF_INDEX_PAYLOAD_TYPE = 'flightdeck_workspace_self_index';
export const WORKSPACE_SELF_INDEX_NAMESPACE = 'flightdeck_pg';

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793',
];

const RELAYS_WITH_UNINDEXED_APP_PUB_FILTERS = new Set([
  'wss://relay.primal.net',
]);

// nostr-tools caches verification on a symbol; copied/mutated event objects must be verified anew.
function validEvent(event) {
  try { return verifyEvent(JSON.parse(JSON.stringify(event))); } catch { return false; }
}

function trimText(value) {
  return String(value ?? '').trim();
}

function trimUrl(value) {
  return trimText(value).replace(/\/+$/, '');
}

function normalizeRelayIdentity(value) {
  return trimUrl(value).toLowerCase();
}

function envSelfIndexRelays() {
  return String(import.meta.env?.VITE_FLIGHT_DECK_SELF_INDEX_RELAYS || '')
    .split(',')
    .map((entry) => trimText(entry))
    .filter(Boolean);
}

export function workspaceSelfIndexRelayUrls(...relayLists) {
  const configuredRelays = envSelfIndexRelays();
  const relays = (configuredRelays.length > 0 ? configuredRelays : DEFAULT_RELAYS)
    .map((entry) => trimText(entry))
    .filter(Boolean);
  return [...new Set(relays)];
}

export function normalizeNostrPubkeyHex(value) {
  const text = trimText(value);
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  if (text.startsWith('npub1')) return decodeNpub(text).toLowerCase();
  throw new Error('Nostr pubkey must be hex or npub.');
}

function dedupeEvents(events = []) {
  const seen = new Set();
  const deduped = [];
  for (const event of events || []) {
    const key = event?.id || JSON.stringify(event || {});
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

async function queryWithRelayCompatibleFilters(pool, relays, filter, options = {}) {
  const strictRelays = [];
  const appPubFallbackRelays = [];
  for (const relay of relays || []) {
    if (RELAYS_WITH_UNINDEXED_APP_PUB_FILTERS.has(normalizeRelayIdentity(relay))) {
      appPubFallbackRelays.push(relay);
    } else {
      strictRelays.push(relay);
    }
  }

  const events = [];
  if (strictRelays.length > 0) {
    events.push(...(await pool.querySync(strictRelays, filter, options) || []));
  }
  if (appPubFallbackRelays.length > 0) {
    const fallbackFilter = { ...filter };
    delete fallbackFilter['#app_pub'];
    events.push(...(await pool.querySync(appPubFallbackRelays, fallbackFilter, options) || []));
  }
  return dedupeEvents(events);
}

export function flightDeckSelfIndexAppPubkeyHex(appNpub = APP_NPUB) {
  return normalizeNostrPubkeyHex(appNpub || APP_NPUB);
}

async function sha256Hex(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function workspaceSelfIndexDTag({
  userPubkeyHex,
  appPubkeyHex,
  towerServiceNpub,
  workspaceId,
}) {
  const input = [
    'v1',
    trimText(userPubkeyHex).toLowerCase(),
    trimText(appPubkeyHex).toLowerCase(),
    trimText(towerServiceNpub),
    trimText(workspaceId),
  ].join(':');
  return `fd-self:${await sha256Hex(input)}`;
}

function descriptorInputFromWorkspace(workspace = {}) {
  if (workspace.type === 'wingman_workspace_locator') {
    return workspace;
  }
  if (workspace.pgDescriptor) {
    return {
      ...workspace.pgDescriptor,
      tower_base_url: workspace.pgDescriptor.tower_base_url || workspace.directHttpsUrl,
    };
  }
  return {
    type: 'wingman_workspace_locator',
    version: 1,
    tower_base_url: workspace.directHttpsUrl,
    identity: {
      tower_service_npub: workspace.towerServiceNpub || workspace.serviceNpub,
      workspace_service_npub: workspace.workspaceServiceNpub,
      workspace_owner_npub: workspace.workspaceOwnerNpub,
      workspace_id: workspace.workspaceId,
      app_npub: workspace.appNpub || FLIGHT_DECK_PG_APP_NPUB,
    },
    label: workspace.name,
    description: workspace.description,
    capabilities: Array.isArray(workspace.capabilities) ? workspace.capabilities : [],
    links: workspace.links || workspace.pgDescriptor?.links || {},
  };
}

export function buildWorkspaceSelfIndexLocator(workspace = {}) {
  const descriptor = parsePgWorkspaceDescriptor(descriptorInputFromWorkspace(workspace));
  return {
    type: 'wingman_workspace_locator',
    version: descriptor.version || 1,
    tower_base_url: normalizeBackendUrl(descriptor.towerBaseUrl),
    tower_service_npub: descriptor.towerServiceNpub,
    workspace_id: descriptor.workspaceId,
    workspace_service_npub: descriptor.workspaceServiceNpub,
    workspace_owner_npub: descriptor.workspaceOwnerNpub,
    app_npub: descriptor.appNpub || FLIGHT_DECK_PG_APP_NPUB,
    label: descriptor.label,
    description: descriptor.description || '',
    capabilities: Array.isArray(descriptor.capabilities) ? descriptor.capabilities : [],
    links: {
      descriptor: trimText(descriptor.links?.descriptor),
      me: trimText(descriptor.links?.me),
      scopes: trimText(descriptor.links?.scopes),
      events: trimText(descriptor.links?.events),
    },
  };
}

export async function buildWorkspaceSelfIndexPayload({
  workspace,
  userNpub,
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(appNpub),
  now = new Date(),
}) {
  const issuedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const locator = buildWorkspaceSelfIndexLocator(workspace);
  return {
    type: WORKSPACE_SELF_INDEX_PAYLOAD_TYPE,
    version: 1,
    issued_at: issuedAt,
    updated_at: issuedAt,
    user_npub: userNpub,
    app: {
      app_npub: appNpub,
      app_pubkey: appPubkeyHex,
      namespace: WORKSPACE_SELF_INDEX_NAMESPACE,
    },
    workspace: locator,
    verification: {
      last_verified_at: workspace.pgDescriptorVerifiedAt || issuedAt,
      verified_by: 'flightdeck',
      tower_service_npub: locator.tower_service_npub,
    },
    state: {
      deleted: false,
    },
  };
}

export async function buildWorkspaceSelfIndexTombstonePayload({
  workspace,
  userNpub,
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(appNpub),
  now = new Date(),
  towerResult = 'workspace_deleted',
  reason = 'workspace_deleted',
  sourceEventId = '',
} = {}) {
  const issuedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const locator = buildWorkspaceSelfIndexLocator(workspace);
  return {
    type: WORKSPACE_SELF_INDEX_PAYLOAD_TYPE,
    version: 1,
    issued_at: issuedAt,
    updated_at: issuedAt,
    user_npub: userNpub,
    app: {
      app_npub: appNpub,
      app_pubkey: appPubkeyHex,
      namespace: WORKSPACE_SELF_INDEX_NAMESPACE,
    },
    workspace: locator,
    verification: {
      last_checked_at: issuedAt,
      verified_by: 'flightdeck',
      tower_result: towerResult,
      tower_service_npub: locator.tower_service_npub,
    },
    state: {
      deleted: true,
      status: 'deleted',
      deleted_at: issuedAt,
      reason,
      source_33357_event_id: trimText(sourceEventId) || null,
    },
  };
}

export async function buildUnsignedWorkspaceSelfIndexEvent({
  workspace,
  userNpub,
  userPubkeyHex,
  content,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(),
  createdAt = Math.floor(Date.now() / 1000),
}) {
  const locator = buildWorkspaceSelfIndexLocator(workspace);
  const dTag = await workspaceSelfIndexDTag({
    userPubkeyHex,
    appPubkeyHex,
    towerServiceNpub: locator.tower_service_npub,
    workspaceId: locator.workspace_id,
  });
  return {
    kind: WORKSPACE_SELF_INDEX_KIND,
    pubkey: userPubkeyHex,
    created_at: createdAt,
    tags: [
      ['d', dTag],
      ['p', userPubkeyHex],
      ['app_pub', appPubkeyHex],
      ['protocol', WORKSPACE_SELF_INDEX_PROTOCOL],
      ['v', '1'],
    ],
    content,
  };
}

function tagValue(event, name) {
  return (event?.tags || []).find((tag) => tag?.[0] === name)?.[1] || '';
}

function assertNoCleartextLeaks(event) {
  const text = JSON.stringify(event.tags || []);
  if (/https?:\/\//i.test(text)) throw new Error('Workspace self-index tags must not contain URLs.');
}

export async function publishWorkspaceSelfIndex({
  workspace,
  userNpub,
  userPubkeyHex,
  relayUrls = [],
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(appNpub),
  encryptForNpub = personalEncryptForNpub,
  signEvent = signNostrEvent,
  poolFactory = () => new SimplePool(),
  now = new Date(),
} = {}) {
  const pubkeyHex = normalizeNostrPubkeyHex(userPubkeyHex || decodeNpub(userNpub));
  const npub = userNpub || await pubkeyToNpub(pubkeyHex);
  const payload = await buildWorkspaceSelfIndexPayload({
    workspace,
    userNpub: npub,
    appNpub,
    appPubkeyHex,
    now,
  });
  const plaintext = JSON.stringify(payload);
  const encrypted = await encryptForNpub(npub, plaintext);
  const unsigned = await buildUnsignedWorkspaceSelfIndexEvent({
    workspace,
    userNpub: npub,
    userPubkeyHex: pubkeyHex,
    appPubkeyHex,
    content: encrypted,
    createdAt: Math.floor(new Date(now).getTime() / 1000),
  });
  assertNoCleartextLeaks(unsigned);
  const signed = await signEvent(unsigned);
  return broadcastWorkspaceSelfIndexEvent({
    event: signed,
    relayUrls,
    workspace,
    poolFactory,
    now,
    payload,
  });
}

export async function publishWorkspaceSelfIndexTombstone({
  workspace,
  userNpub,
  userPubkeyHex,
  relayUrls = [],
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(appNpub),
  encryptForNpub = personalEncryptForNpub,
  signEvent = signNostrEvent,
  poolFactory = () => new SimplePool(),
  now = new Date(),
  towerResult = 'workspace_deleted',
  reason = 'workspace_deleted',
  sourceEventId = '',
} = {}) {
  const pubkeyHex = normalizeNostrPubkeyHex(userPubkeyHex || decodeNpub(userNpub));
  const npub = userNpub || await pubkeyToNpub(pubkeyHex);
  const payload = await buildWorkspaceSelfIndexTombstonePayload({
    workspace,
    userNpub: npub,
    appNpub,
    appPubkeyHex,
    now,
    towerResult,
    reason,
    sourceEventId,
  });
  const plaintext = JSON.stringify(payload);
  const encrypted = await encryptForNpub(npub, plaintext);
  const unsigned = await buildUnsignedWorkspaceSelfIndexEvent({
    workspace,
    userNpub: npub,
    userPubkeyHex: pubkeyHex,
    appPubkeyHex,
    content: encrypted,
    createdAt: Math.floor(new Date(now).getTime() / 1000),
  });
  assertNoCleartextLeaks(unsigned);
  const signed = await signEvent(unsigned);
  return broadcastWorkspaceSelfIndexEvent({
    event: signed,
    relayUrls,
    workspace,
    poolFactory,
    now,
    payload,
  });
}

export async function broadcastWorkspaceSelfIndexEvent({
  event,
  relayUrls = [],
  workspace = {},
  poolFactory = () => new SimplePool(),
  now = new Date(),
  payload = null,
} = {}) {
  if (!event || !validEvent(event) || Number(event.kind) !== WORKSPACE_SELF_INDEX_KIND) {
    throw new Error('A signed kind 33356 workspace self-index event is required.');
  }
  assertNoCleartextLeaks(event);
  const relays = workspaceSelfIndexRelayUrls(relayUrls, workspace.relayUrls || []);
  const pool = poolFactory();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: 2500 }));
    const acceptedRelays = [];
    const failedRelays = [];
    results.forEach((result, index) => {
      const relay = relays[index];
      if (result.status === 'fulfilled') acceptedRelays.push(relay);
      else failedRelays.push({ relay, error: result.reason?.message || String(result.reason || 'publish failed') });
    });
    if (acceptedRelays.length === 0) throw new Error('No relay accepted the workspace self-index event.');
    const readback = await pool.querySync(acceptedRelays, { ids: [event.id], limit: 1 }, { maxWait: 2500 });
    if (!(readback || []).some((received) => received.id === event.id && validEvent(received)
      && received.content === event.content && received.sig === event.sig)) {
      throw new Error('Workspace index publication pending: exact signed event readback missing.');
    }
    return {
      event,
      payload,
      acceptedRelays,
      failedRelays,
      publishedAt: new Date(now).toISOString(),
    };
  } finally {
    if (typeof pool.destroy === 'function') pool.destroy();
    else if (typeof pool.close === 'function') pool.close(relays);
  }
}

export async function queryWorkspaceSelfIndexEvents({
  userPubkeyHex,
  relayUrls = [],
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(),
  poolFactory = () => new SimplePool(),
  maxWait = 2500,
} = {}) {
  const pubkeyHex = normalizeNostrPubkeyHex(userPubkeyHex);
  const relays = workspaceSelfIndexRelayUrls(relayUrls);
  const filter = {
    kinds: [WORKSPACE_SELF_INDEX_KIND],
    authors: [pubkeyHex],
    '#p': [pubkeyHex],
    limit: 1000,
  };
  const pool = poolFactory();
  try {
    const events = await queryWithRelayCompatibleFilters(pool, relays, filter, { maxWait });
    if (events.length >= 1000) throw new Error('Workspace index query incomplete; narrow relay history or retry.');
    return events;
  } finally {
    if (typeof pool.destroy === 'function') pool.destroy();
    else if (typeof pool.close === 'function') pool.close(relays);
  }
}

export function workspaceSelfIndexIdentityKey(locator = {}, appPubkeyHex = '') {
  return [
    trimText(appPubkeyHex || locator.app_pubkey || locator.app_npub),
    trimText(locator.tower_service_npub || locator.towerServiceNpub),
    trimText(locator.workspace_id || locator.workspaceId),
    trimText(locator.workspace_service_npub || locator.workspaceServiceNpub),
  ].join('::');
}

export async function decryptWorkspaceSelfIndexEvent({
  event,
  userNpub,
  userPubkeyHex,
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(),
  decryptFromNpub = personalDecryptFromNpub,
} = {}) {
  const pubkeyHex = normalizeNostrPubkeyHex(userPubkeyHex || decodeNpub(userNpub));
  if (event.kind !== WORKSPACE_SELF_INDEX_KIND) throw new Error('Unsupported workspace self-index kind.');
  if (!validEvent(event)) throw new Error('Invalid workspace index signature.');
  if (event.created_at > Math.floor(Date.now() / 1000) + 300) throw new Error('Future workspace index.');
  if (event.pubkey !== pubkeyHex) throw new Error('Workspace self-index author mismatch.');
  for (const key of ['d', 'p', 'app_pub', 'protocol', 'v']) {
    const tags = event.tags.filter((tag) => tag[0] === key);
    if (tags.length !== 1 || tags[0].length !== 2) throw new Error('Ambiguous workspace index tags.');
  }
  if (tagValue(event, 'v') !== '1') throw new Error('Unsupported index version.');
  if (tagValue(event, 'p') !== pubkeyHex) throw new Error('Workspace self-index recipient mismatch.');
  const originatingApp = normalizeNostrPubkeyHex(tagValue(event, 'app_pub'));
  if (tagValue(event, 'protocol') !== WORKSPACE_SELF_INDEX_PROTOCOL) throw new Error('Workspace self-index protocol mismatch.');

  const senderNpub = userNpub || await pubkeyToNpub(pubkeyHex);
  const plaintext = await decryptFromNpub(senderNpub, event.content || '');
  const payload = JSON.parse(plaintext);
  if (payload?.type !== WORKSPACE_SELF_INDEX_PAYLOAD_TYPE || payload.version !== 1) {
    throw new Error('Invalid workspace self-index payload.');
  }
  if (payload.user_npub !== senderNpub || payload.app?.namespace !== 'flightdeck_pg'
    || normalizeNostrPubkeyHex(payload.app?.app_npub) !== originatingApp
    || payload.app?.app_pubkey !== originatingApp || typeof payload.state?.deleted !== 'boolean') {
    throw new Error('Workspace self-index payload identity mismatch.');
  }
  if (payload.workspace?.type !== 'wingman_workspace_locator' || payload.workspace.version !== 1) {
    throw new Error('Unsupported workspace locator.');
  }
  const locator = buildWorkspaceSelfIndexLocator(payload.workspace);
  const origin = new URL(locator.tower_base_url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(locator.workspace_id)) {
    throw new Error('Unsafe workspace index locator.');
  }
  for (const value of [locator.tower_service_npub, locator.workspace_service_npub, locator.workspace_owner_npub, locator.app_npub]) normalizeNostrPubkeyHex(value);
  const expectedAddress = await workspaceSelfIndexDTag({ userPubkeyHex: pubkeyHex,
    appPubkeyHex: originatingApp, towerServiceNpub: locator.tower_service_npub, workspaceId: locator.workspace_id });
  if (tagValue(event, 'd') !== expectedAddress) throw new Error('Workspace index address mismatch.');
  const identityKey = tagValue(event, 'd');
  if (payload.state?.deleted) {
    return { event, payload, locator, deleted: true, identityKey };
  }
  return {
    event,
    payload,
    locator,
    deleted: false,
    identityKey,
  };
}

export async function queryWorkspaceSelfIndexCandidates({
  userNpub,
  userPubkeyHex,
  relayUrls = [],
  appPubkeyHex = flightDeckSelfIndexAppPubkeyHex(),
  poolFactory,
  decryptFromNpub,
} = {}) {
  const events = await queryWorkspaceSelfIndexEvents({
    userPubkeyHex,
    relayUrls,
    appPubkeyHex,
    poolFactory,
  });
  const decrypted = [];
  const rejected = [];
  const latest = new Map();
  for (const event of [...events].sort((a, b) => Number(b?.created_at || 0) - Number(a?.created_at || 0) || String(a?.id || '').localeCompare(String(b?.id || '')))) {
    if (!validEvent(event) || event.pubkey !== normalizeNostrPubkeyHex(userPubkeyHex || decodeNpub(userNpub))
      || event.kind !== 33356 || event.created_at > Math.floor(Date.now() / 1000) + 300) continue;
    const addresses = event.tags.filter((tag) => tag[0] === 'd');
    if (addresses.length === 0 || addresses[0].length < 2 || latest.has(addresses[0][1])) continue;
    latest.set(addresses[0][1], event);
  }
  for (const event of latest.values()) {
    try {
      const candidate = await decryptWorkspaceSelfIndexEvent({
        event,
        userNpub,
        userPubkeyHex,
        appPubkeyHex,
        decryptFromNpub,
      });
      decrypted.push(candidate);
    } catch (error) {
      rejected.push({ eventId: event?.id || '', error: error?.message || String(error) });
    }
  }
  const deduped = [];
  const tombstones = [];
  const seen = new Set();
  for (const candidate of decrypted.sort((a, b) => {
    const timeOrder = Number(b.event?.created_at || 0) - Number(a.event?.created_at || 0);
    return timeOrder || String(a.event?.id || '').localeCompare(String(b.event?.id || ''));
  })) {
    if (!candidate.identityKey || seen.has(candidate.identityKey)) continue;
    seen.add(candidate.identityKey);
    // A tombstone is the latest addressable event for this workspace identity.
    // Keep it in the dedupe set so stale active copies returned by another
    // relay cannot resurrect a deleted workspace.
    if (candidate.deleted) {
      tombstones.push(candidate);
      continue;
    }
    deduped.push(candidate);
  }
  return { candidates: deduped, tombstones, rejected, events };
}
