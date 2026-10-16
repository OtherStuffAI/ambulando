import { SimplePool } from 'nostr-tools';
import { APP_NPUB, FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import {
  decodeNpub,
  personalDecryptFromNpub,
  personalEncryptForNpub,
  pubkeyToNpub,
  signNostrEvent,
} from './auth/nostr.js';
import { buildAgentConnectPackage } from './agent-connect.js';
import { parsePgWorkspaceDescriptor } from './pg-workspace-descriptor.js';
import { normalizeBackendUrl } from './utils/state-helpers.js';

export const ONBOARDING_ANNOUNCEMENT_KIND = 33357;
export const ONBOARDING_PROTOCOL = 'onboarding';
export const ONBOARDING_PAYLOAD_TYPE = 'flightdeck_onboarding';
export const ONBOARDING_ACTION_GRANT = 'grant';
export const ONBOARDING_ACTION_REVOKED = 'revoked';
export const ONBOARDING_ACTION_DELETED = 'deleted';

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://proxy.nostr-relay.app/8c5723f2601334234e1922d2e842d6bbf209283b07120b3f1d38660915f13793',
];

const RELAYS_WITH_UNINDEXED_APP_PUB_FILTERS = new Set([
  'wss://relay.primal.net',
]);

function trimText(value) {
  return String(value ?? '').trim();
}

function trimUrl(value) {
  return trimText(value).replace(/\/+$/, '');
}

function normalizeRelayIdentity(value) {
  return trimUrl(value).toLowerCase();
}

function envOnboardingRelays() {
  return String(import.meta.env?.VITE_FLIGHT_DECK_ONBOARDING_RELAYS || '')
    .split(',')
    .map((entry) => trimText(entry))
    .filter(Boolean);
}

export function onboardingAnnouncementRelayUrls(...relayLists) {
  const configuredRelays = envOnboardingRelays();
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

export function flightDeckOnboardingAppPubkeyHex(appNpub = APP_NPUB) {
  return normalizeNostrPubkeyHex(appNpub || APP_NPUB);
}

function withPath(base, path) {
  const root = trimUrl(base);
  return root ? `${root}${path}` : '';
}

function descriptorInputFromWorkspace(workspace = {}) {
  if (workspace.type === 'wingman_workspace_locator') return workspace;
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

function workspaceDescriptor(workspace = {}) {
  return parsePgWorkspaceDescriptor(descriptorInputFromWorkspace(workspace));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function sha256Hex(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function onboardingGrantId({
  recipientNpub,
  towerServiceNpub,
  workspaceServiceNpub,
  workspaceId,
  reason = 'added_to_workspace_or_group',
} = {}) {
  const input = [
    'v1',
    trimText(recipientNpub),
    trimText(towerServiceNpub),
    trimText(workspaceServiceNpub),
    trimText(workspaceId),
    trimText(reason),
  ].join(':');
  return `fd-onboard:${await sha256Hex(input)}`;
}

export function onboardingAnnouncementDTag({
  recipientNpub,
  towerServiceNpub,
  workspaceServiceNpub,
  appNpub,
} = {}) {
  const parts = [towerServiceNpub, workspaceServiceNpub, appNpub, recipientNpub]
    .map((value) => trimText(value));
  if (parts.some((value) => !value)) {
    throw new Error('Onboarding announcement lifecycle identity is incomplete.');
  }
  return `wingman-access-grant:v1:${parts.join(':')}`;
}

async function opaqueGrantId(value) {
  const text = trimText(value);
  if (!text) return '';
  if (/^(fd-onboard|sha256):[0-9a-f]{64}$/i.test(text)) return text;
  return `fd-onboard:${await sha256Hex(`supplied:${text}`)}`;
}

export function buildOnboardingAgentConnectPackage({
  workspace,
  windowOrigin = '',
  backendUrl = '',
  session = null,
} = {}) {
  const descriptor = workspaceDescriptor(workspace);
  const directHttpsUrl = normalizeBackendUrl(backendUrl || descriptor.towerBaseUrl || workspace?.directHttpsUrl);
  return buildAgentConnectPackage({
    windowOrigin,
    backendUrl: directHttpsUrl,
    session,
    workspace,
  });
}

export async function buildOnboardingPayload({
  recipientNpub,
  issuedByNpub,
  workspace,
  agentConnect,
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(appNpub),
  now = new Date(),
  expiresAt = null,
  grantId = '',
  grantReason = 'added_to_workspace_or_group',
  action = ONBOARDING_ACTION_GRANT,
  revokedAt = null,
  revocationSource = 'tower',
} = {}) {
  if (!recipientNpub) throw new Error('Onboarding recipient npub is required.');
  if (!issuedByNpub) throw new Error('Onboarding issuer npub is required.');
  const issuedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const expiry = expiresAt ? new Date(expiresAt) : addDays(new Date(issuedAt), 7);
  const descriptor = workspaceDescriptor(workspace);
  const directHttpsUrl = normalizeBackendUrl(descriptor.towerBaseUrl || workspace?.directHttpsUrl);
  const serviceNpub = trimText(descriptor.towerServiceNpub || workspace?.towerServiceNpub || workspace?.serviceNpub);
  const workspaceServiceNpub = trimText(descriptor.workspaceServiceNpub || workspace?.workspaceServiceNpub);
  const workspaceId = trimText(descriptor.workspaceId || workspace?.workspaceId);
  const payloadGrantId = grantId
    ? await opaqueGrantId(grantId)
    : await onboardingGrantId({
      recipientNpub,
      towerServiceNpub: serviceNpub,
      workspaceServiceNpub,
      workspaceId,
      reason: grantReason,
    });
  const normalizedAction = onboardingActionFromPayload({ action });
  const connectPackage = normalizedAction === ONBOARDING_ACTION_GRANT
    ? (agentConnect || buildAgentConnectPackage({
      backendUrl: directHttpsUrl,
      session: { npub: issuedByNpub },
      workspace,
    }))
    : null;

  return {
    type: ONBOARDING_PAYLOAD_TYPE,
    version: 1,
    protocol: ONBOARDING_PROTOCOL,
    action: normalizedAction,
    issued_at: issuedAt,
    ...(normalizedAction === ONBOARDING_ACTION_GRANT ? { expires_at: expiry.toISOString() } : {}),
    issued_by_npub: issuedByNpub,
    recipient_npub: recipientNpub,
    app: {
      app_npub: appNpub,
      app_pubkey: appPubkeyHex,
    },
    service: {
      direct_https_url: directHttpsUrl,
      service_npub: serviceNpub || null,
      openapi_url: withPath(directHttpsUrl, '/openapi.json'),
      docs_url: withPath(directHttpsUrl, '/docs'),
      health_url: withPath(directHttpsUrl, '/health'),
      relay_urls: Array.isArray(workspace?.relayUrls) ? workspace.relayUrls : [],
    },
    workspace: {
      owner_npub: trimText(descriptor.workspaceOwnerNpub || workspace?.workspaceOwnerNpub) || null,
      workspace_service_npub: workspaceServiceNpub || null,
      workspace_id: workspaceId || null,
      app_npub: trimText(descriptor.appNpub || workspace?.appNpub || FLIGHT_DECK_PG_APP_NPUB) || null,
      label: trimText(descriptor.label || workspace?.name) || null,
      descriptor_url: trimText(descriptor.links?.descriptor) || null,
      me_url: trimText(descriptor.links?.me) || null,
    },
    ...(connectPackage ? { agent_connect: connectPackage } : {}),
    ...(isRevokedOnboardingAction(normalizedAction) ? {
      revocation: {
        reason: grantReason,
        revoked_at: revokedAt ? new Date(revokedAt).toISOString() : issuedAt,
        source: revocationSource,
      },
    } : {}),
    grant: {
      grant_id: payloadGrantId,
      reason: grantReason,
    },
  };
}

export const buildOnboardingAnnouncementPayload = buildOnboardingPayload;

export function validateOnboardingAnnouncementPayload(payload, {
  recipientNpub,
  recipientPubkeyHex,
  userNpub,
  userPubkeyHex,
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(),
  now = new Date(),
} = {}) {
  if (payload?.type !== ONBOARDING_PAYLOAD_TYPE || Number(payload.version || 0) !== 1) {
    throw new Error('Invalid onboarding announcement payload.');
  }
  if (payload.protocol !== ONBOARDING_PROTOCOL) throw new Error('Invalid onboarding announcement protocol.');
  const expectedRecipient = recipientPubkeyHex || userPubkeyHex || recipientNpub || userNpub;
  if (expectedRecipient && normalizeNostrPubkeyHex(payload.recipient_npub) !== normalizeNostrPubkeyHex(expectedRecipient)) {
    throw new Error('Onboarding announcement payload recipient mismatch.');
  }
  if (payload.app?.app_pubkey !== appPubkeyHex) {
    throw new Error('Onboarding announcement payload app_pubkey mismatch.');
  }
  const action = onboardingActionFromPayload(payload);
  if (action === ONBOARDING_ACTION_GRANT) {
    if (payload.agent_connect?.kind !== 'coworker_agent_connect') {
      throw new Error('Onboarding announcement payload is missing Agent Connect.');
    }
    if (payload.agent_connect?.protocol !== 'flightdeck_pg' || !payload.agent_connect?.workspace_descriptor) {
      throw new Error('Onboarding announcement payload is missing Postgres workspace descriptor.');
    }
  }
  if (action === ONBOARDING_ACTION_GRANT && payload.expires_at) {
    const expiryMs = new Date(payload.expires_at).getTime();
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs < nowMs) {
      throw new Error('Onboarding announcement payload is stale.');
    }
  }
  parsePgWorkspaceDescriptor(onboardingLocatorFromPayload(payload));
  return payload;
}

export function onboardingActionFromPayload(payload = {}) {
  const action = trimText(payload.action || ONBOARDING_ACTION_GRANT).toLowerCase();
  if (!action || action === ONBOARDING_ACTION_GRANT) return ONBOARDING_ACTION_GRANT;
  if (action === ONBOARDING_ACTION_REVOKED) return ONBOARDING_ACTION_REVOKED;
  if (action === ONBOARDING_ACTION_DELETED) return ONBOARDING_ACTION_DELETED;
  throw new Error('Unsupported onboarding announcement action.');
}

export function isRevokedOnboardingAction(action) {
  return action === ONBOARDING_ACTION_REVOKED || action === ONBOARDING_ACTION_DELETED;
}

function tagValue(event, name) {
  return (event?.tags || []).find((tag) => tag?.[0] === name)?.[1] || '';
}

function assertOnlyRoutingTags(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const names = tags.map((tag) => tag?.[0]);
  const allowed = new Set(['d', 'p', 'app_pub', 'protocol']);
  const required = ['p', 'app_pub', 'protocol'];
  if ((tags.length !== 3 && tags.length !== 4)
    || names.some((name) => !allowed.has(name))
    || required.some((name) => names.filter((candidate) => candidate === name).length !== 1)
    || names.filter((name) => name === 'd').length > 1) {
    throw new Error('Onboarding announcement tags must contain d (when addressable), p, app_pub, and protocol only.');
  }
  const text = JSON.stringify(tags);
  if (/https?:\/\//i.test(text)) throw new Error('Onboarding announcement tags must not contain URLs.');
}

export function buildUnsignedOnboardingAnnouncementEvent({
  issuerPubkeyHex,
  recipientNpub,
  recipientPubkeyHex,
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(),
  dTag = '',
  content,
  createdAt = Math.floor(Date.now() / 1000),
} = {}) {
  const issuerHex = normalizeNostrPubkeyHex(issuerPubkeyHex);
  const recipientHex = normalizeNostrPubkeyHex(recipientPubkeyHex || recipientNpub);
  const event = {
    kind: ONBOARDING_ANNOUNCEMENT_KIND,
    pubkey: issuerHex,
    created_at: createdAt,
    tags: [
      ...(trimText(dTag) ? [['d', trimText(dTag)]] : []),
      ['p', recipientHex],
      ['app_pub', appPubkeyHex],
      ['protocol', ONBOARDING_PROTOCOL],
    ],
    content,
  };
  assertOnlyRoutingTags(event);
  return event;
}

// Expire each signer stage before continuing to publication. A late signer
// response cannot publish an event after the UI has offered a retry.
async function awaitOnboardingSigner(operation, stage) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Onboarding ${stage} timed out. Retry the announcement.`)), 45_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function publishOnboardingAnnouncement({
  recipientNpub,
  recipientPubkeyHex,
  issuedByNpub,
  issuerNpub,
  issuerPubkeyHex,
  workspace,
  agentConnect,
  relayUrls = [],
  appNpub = APP_NPUB,
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(appNpub),
  encryptForNpub = personalEncryptForNpub,
  signEvent = signNostrEvent,
  poolFactory = () => new SimplePool(),
  now = new Date(),
  grantId = '',
  grantReason = 'added_to_workspace_or_group',
  reason = '',
  action = ONBOARDING_ACTION_GRANT,
  revokedAt = null,
  revocationSource = 'tower',
} = {}) {
  const recipientHex = normalizeNostrPubkeyHex(recipientPubkeyHex || recipientNpub);
  const recipient = recipientNpub || await pubkeyToNpub(recipientHex);
  const issuerInputNpub = issuedByNpub || issuerNpub;
  const issuerHex = normalizeNostrPubkeyHex(issuerPubkeyHex || issuerInputNpub);
  const issuer = issuerInputNpub || await pubkeyToNpub(issuerHex);
  const effectiveReason = reason || grantReason;
  const payload = await buildOnboardingPayload({
    recipientNpub: recipient,
    issuedByNpub: issuer,
    workspace,
    agentConnect,
    appNpub,
    appPubkeyHex,
    now,
    grantId,
    grantReason: effectiveReason,
    action,
    revokedAt,
    revocationSource,
  });
  const locator = onboardingLocatorFromPayload(payload);
  const dTag = onboardingAnnouncementDTag({
    recipientNpub: recipient,
    towerServiceNpub: locator.identity.tower_service_npub,
    workspaceServiceNpub: locator.identity.workspace_service_npub,
    appNpub: payload.app.app_npub,
  });
  const encrypted = await awaitOnboardingSigner(() => encryptForNpub(recipient, JSON.stringify(payload)), 'encryption');
  const unsigned = buildUnsignedOnboardingAnnouncementEvent({
    issuerPubkeyHex: issuerHex,
    recipientPubkeyHex: recipientHex,
    appPubkeyHex,
    dTag,
    content: encrypted,
    createdAt: Math.floor(new Date(now).getTime() / 1000),
  });
  const signed = await awaitOnboardingSigner(() => signEvent(unsigned), 'signing');
  const relays = onboardingAnnouncementRelayUrls(relayUrls, workspace?.relayUrls || [], payload.service.relay_urls || []);
  const pool = poolFactory();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed, { maxWait: 2500 }));
    const acceptedRelays = [];
    const failedRelays = [];
    results.forEach((result, index) => {
      const relay = relays[index];
      if (result.status === 'fulfilled') acceptedRelays.push(relay);
      else failedRelays.push({ relay, error: result.reason?.message || String(result.reason || 'publish failed') });
    });
    if (acceptedRelays.length === 0) throw new Error('No relay accepted the onboarding announcement.');
    return {
      event: signed,
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

export async function queryOnboardingAnnouncementEvents({
  recipientPubkeyHex,
  relayUrls = [],
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(),
  poolFactory = () => new SimplePool(),
  maxWait = 2500,
} = {}) {
  const recipientHex = normalizeNostrPubkeyHex(recipientPubkeyHex);
  const relays = onboardingAnnouncementRelayUrls(relayUrls);
  const filter = {
    kinds: [ONBOARDING_ANNOUNCEMENT_KIND],
    '#p': [recipientHex],
    '#app_pub': [appPubkeyHex],
    limit: 100,
  };
  const pool = poolFactory();
  try {
    return await queryWithRelayCompatibleFilters(pool, relays, filter, { maxWait });
  } finally {
    if (typeof pool.destroy === 'function') pool.destroy();
    else if (typeof pool.close === 'function') pool.close(relays);
  }
}

export function onboardingLocatorFromPayload(payload = {}) {
  const service = payload.service || {};
  const workspace = payload.workspace || {};
  return {
    type: 'wingman_workspace_locator',
    version: 1,
    tower_base_url: normalizeBackendUrl(service.direct_https_url),
    identity: {
      tower_service_npub: trimText(service.service_npub),
      workspace_service_npub: trimText(workspace.workspace_service_npub),
      workspace_owner_npub: trimText(workspace.owner_npub),
      workspace_id: trimText(workspace.workspace_id),
      app_npub: trimText(workspace.app_npub) || FLIGHT_DECK_PG_APP_NPUB,
    },
    label: trimText(workspace.label),
    description: '',
    capabilities: [],
    links: {
      descriptor: trimText(workspace.descriptor_url),
      me: trimText(workspace.me_url),
    },
  };
}

export async function decryptOnboardingAnnouncementEvent({
  event,
  recipientNpub,
  recipientPubkeyHex,
  userNpub,
  userPubkeyHex,
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(),
  decryptFromNpub = personalDecryptFromNpub,
  now = new Date(),
} = {}) {
  const effectiveRecipientNpub = recipientNpub || userNpub;
  const effectiveRecipientPubkeyHex = recipientPubkeyHex || userPubkeyHex;
  const recipientHex = normalizeNostrPubkeyHex(effectiveRecipientPubkeyHex || effectiveRecipientNpub);
  if (event.kind !== ONBOARDING_ANNOUNCEMENT_KIND) throw new Error('Unsupported onboarding announcement kind.');
  assertOnlyRoutingTags(event);
  if (tagValue(event, 'p') !== recipientHex) throw new Error('Onboarding announcement recipient mismatch.');
  if (tagValue(event, 'app_pub') !== appPubkeyHex) throw new Error('Onboarding announcement app mismatch.');
  if (tagValue(event, 'protocol') !== ONBOARDING_PROTOCOL) throw new Error('Onboarding announcement protocol mismatch.');

  const senderNpub = await pubkeyToNpub(normalizeNostrPubkeyHex(event.pubkey));
  const plaintext = await decryptFromNpub(senderNpub, event.content || '');
  const payload = JSON.parse(plaintext);
  validateOnboardingAnnouncementPayload(payload, {
    recipientPubkeyHex: recipientHex,
    appPubkeyHex,
    now,
  });
  const locator = onboardingLocatorFromPayload(payload);
  const eventDTag = tagValue(event, 'd');
  if (eventDTag) {
    const expectedDTag = onboardingAnnouncementDTag({
      recipientNpub: payload.recipient_npub,
      towerServiceNpub: locator.identity.tower_service_npub,
      workspaceServiceNpub: locator.identity.workspace_service_npub,
      appNpub: payload.app.app_npub,
    });
    if (eventDTag !== expectedDTag) throw new Error('Onboarding announcement lifecycle tag mismatch.');
  }
  const action = onboardingActionFromPayload(payload);
  return {
    event,
    payload,
    locator,
    action,
    revoked: isRevokedOnboardingAction(action),
    grantId: trimText(payload.grant?.grant_id),
    identityKey: [
      appPubkeyHex,
      trimText(locator.identity.tower_service_npub),
      trimText(locator.identity.workspace_id),
      trimText(locator.identity.workspace_service_npub),
    ].join('::'),
  };
}

export async function queryOnboardingAnnouncementCandidates({
  recipientNpub,
  recipientPubkeyHex,
  userNpub,
  userPubkeyHex,
  relayUrls = [],
  appPubkeyHex = flightDeckOnboardingAppPubkeyHex(),
  poolFactory,
  decryptFromNpub,
  now = new Date(),
} = {}) {
  const effectiveRecipientNpub = recipientNpub || userNpub;
  const effectiveRecipientPubkeyHex = recipientPubkeyHex || userPubkeyHex;
  const events = await queryOnboardingAnnouncementEvents({
    recipientPubkeyHex: effectiveRecipientPubkeyHex || effectiveRecipientNpub,
    relayUrls,
    appPubkeyHex,
    poolFactory,
  });
  const candidates = [];
  const rejected = [];
  for (const event of events || []) {
    try {
      candidates.push(await decryptOnboardingAnnouncementEvent({
        event,
        recipientNpub: effectiveRecipientNpub,
        recipientPubkeyHex: effectiveRecipientPubkeyHex,
        appPubkeyHex,
        decryptFromNpub,
        now,
      }));
    } catch (error) {
      rejected.push({ eventId: event?.id || '', error: error?.message || String(error) });
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => {
    const timeOrder = Number(b.event?.created_at || 0) - Number(a.event?.created_at || 0);
    return timeOrder || String(a.event?.id || '').localeCompare(String(b.event?.id || ''));
  })) {
    if (!candidate.identityKey || seen.has(candidate.identityKey)) continue;
    seen.add(candidate.identityKey);
    deduped.push(candidate);
  }
  return { candidates: deduped, rejected, events };
}
