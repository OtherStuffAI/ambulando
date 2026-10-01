/**
 * V4 API client — all network calls live here (or in the sync worker).
 * The UI never calls these directly; the worker or explicit user actions do.
 */

import { towerFetch as fetch, resolveTowerSigningUrl, nativeTowerFetch, getTowerTransport, normalizeTowerConnectionResponse } from './tower-transport.js';
import { SuperbasedClient, SuperbasedHttpError } from '@nostr-superbased/core/client';
import { createNip98AuthHeader, createNip98AuthHeaderForSecret } from './auth/nostr.js';
import { getActiveSessionNpub } from './crypto/group-keys.js';
import { getActiveWorkspaceKeyNpub, getActiveWorkspaceKeySecretForAuth } from './crypto/workspace-keys.js';
import { buildFlightDeckSyncRequest } from './superbased/sync-request.js';
import { FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';

let _baseUrl = '';

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const UPLOAD_FETCH_TIMEOUT_MS = 60_000;
const READ_AUTH_HEADER_TIMEOUT_MS = 10_000;
const INTERACTIVE_AUTH_HEADER_TIMEOUT_MS = 10_000;
const MUTATION_AUTH_HEADER_TIMEOUT_MS = 45_000;

export function createFetchTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  return controller.signal;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function setBaseUrl(url) {
  _baseUrl = url.replace(/\/+$/, '');
}

export function getBaseUrl() {
  return _baseUrl;
}

export async function searchTowerPgWorkspace(workspaceId, {
  query,
  scopeId = null,
  mode = scopeId ? 'subtree' : 'workspace',
  limit = 5,
  signal,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
} = {}) {
  const params = new URLSearchParams({ q: String(query || ''), mode, limit: String(limit), app_npub: appNpub });
  if (scopeId) params.set('scope_id', scopeId);
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/search?${params.toString()}`;
  const requestUrl = `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
  const headers = { Authorization: await createApiAuthHeader(requestUrl, 'GET') };
  const response = await fetch(requestUrl, { headers, signal: signal || createFetchTimeoutSignal(DEFAULT_FETCH_TIMEOUT_MS) });
  return json(response, { requestUrl, method: 'GET', prefix: 'Flight Deck PG search' });
}

function url(path) {
  return `${_baseUrl}${path}`;
}

function getEffectiveViewerNpub(viewerNpub = null) {
  return String(
    viewerNpub
    || getActiveSessionNpub()
    || ''
  ).trim();
}

function getWorkspaceKeyNpubForAuth() {
  if (!getActiveWorkspaceKeySecretForAuth()) return null;
  return String(getActiveWorkspaceKeyNpub() || '').trim() || null;
}

function getEffectiveReadViewerNpub(viewerNpub = null) {
  return getWorkspaceKeyNpubForAuth() || getEffectiveViewerNpub(viewerNpub);
}

function addWorkspaceKeyAuthParams(params) {
  const workspaceKeyNpub = getWorkspaceKeyNpubForAuth();
  if (!workspaceKeyNpub) return null;
  params.set('workspace_user_key_npub', workspaceKeyNpub);
  params.set('ws_key_npub', workspaceKeyNpub);
  return workspaceKeyNpub;
}

function addWorkspaceKeyAuthBodyFields(body) {
  const workspaceKeyNpub = getWorkspaceKeyNpubForAuth();
  if (!workspaceKeyNpub) return body;
  return {
    ...body,
    workspace_user_key_npub: workspaceKeyNpub,
    ws_key_npub: workspaceKeyNpub,
  };
}

async function createApiAuthHeader(requestUrl, method, body = null, options = {}) {
  return createAuthHeaderForIntendedUrl(resolveTowerSigningUrl(requestUrl), method, body, options);
}

async function createAuthHeaderForIntendedUrl(requestUrl, method, body = null, options = {}) {
  const workspaceSecret = options.useWorkspaceKey === false
    ? null
    : getActiveWorkspaceKeySecretForAuth();
  const authTimeoutMs = getAuthHeaderTimeoutMs(method, options);
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const priority = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod) ? 'high' : 'normal';
  const timeoutMessage = `NIP-98 signing timed out for ${normalizedMethod} ${requestUrl}`;
  if (!workspaceSecret) {
    return createNip98AuthHeader(requestUrl, method, body ?? null, {
      signTimeoutMs: authTimeoutMs,
      timeoutMessage,
      priority,
    });
  }
  return withTimeout(
    createNip98AuthHeaderForSecret(requestUrl, method, body ?? null, workspaceSecret),
    authTimeoutMs,
    timeoutMessage,
  );
}

function getAuthHeaderTimeoutMs(method, options = {}) {
  const explicitTimeoutMs = Number(options.authTimeoutMs);
  if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) return explicitTimeoutMs;
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) return MUTATION_AUTH_HEADER_TIMEOUT_MS;
  return READ_AUTH_HEADER_TIMEOUT_MS;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'auth_timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

async function buildApiError(resp, { requestUrl = '', method = 'GET', prefix = 'API' } = {}) {
  const text = await resp.text().catch(() => '');
  const requestMethod = String(method || 'GET').toUpperCase();
  const location = requestUrl ? ` ${requestMethod} ${requestUrl}` : '';
  const suffix = text ? `: ${text}` : '';
  const error = new Error(`${prefix} ${resp.status}${location}${suffix}`);
  error.status = resp.status;
  error.method = requestMethod;
  error.requestUrl = requestUrl || null;
  error.responseText = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      error.payload = parsed;
      error.code = typeof parsed.code === 'string' ? parsed.code : null;
      error.reason = typeof parsed.reason === 'string'
        ? parsed.reason
        : (typeof parsed.error === 'string' ? parsed.error : (typeof parsed.details?.reason === 'string' ? parsed.details.reason : null));
      error.requiredPermission = typeof parsed.required_permission === 'string' ? parsed.required_permission : null;
      error.holder_actor_npub = typeof parsed.holder_actor_npub === 'string' ? parsed.holder_actor_npub : null;
      error.holder_display_name = typeof parsed.holder_display_name === 'string' ? parsed.holder_display_name : null;
      error.expires_at = typeof parsed.expires_at === 'string' ? parsed.expires_at : null;
    }
  } catch {
    // Non-JSON error bodies keep the raw text only.
  }
  return error;
}

function buildRequestFailure(error, { requestUrl = '', method = 'GET', prefix = 'API request' } = {}) {
  const requestMethod = String(method || 'GET').toUpperCase();
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${prefix} failed ${requestMethod} ${requestUrl}: ${detail}`, { cause: error });
  wrapped.method = requestMethod;
  wrapped.requestUrl = requestUrl || null;
  if (error && typeof error === 'object') {
    if (error.code != null) wrapped.code = error.code;
    if (error.status != null) wrapped.status = error.status;
    if (error.reason != null) wrapped.reason = error.reason;
  }
  return wrapped;
}

async function json(resp, requestMeta = {}) {
  if (!resp.ok) {
    throw await buildApiError(resp, requestMeta);
  }
  return resp.json();
}

async function signedFetch(path, { method = 'GET', body } = {}, options = {}) {
  const requestUrl = url(path);
  const headers = {
    Authorization: await createApiAuthHeader(requestUrl, method, body ?? null, options),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(requestUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: createFetchTimeoutSignal(DEFAULT_FETCH_TIMEOUT_MS),
  });
}

function buildCoreApiClient() {
  const client = new SuperbasedClient({
    connection: { url: _baseUrl },
    auth: {
      kind: 'wingman-fd-api',
      async getPublicNpub() {
        return getActiveSessionNpub() || '';
      },
      async createNip98AuthHeader(requestUrl, method, body) {
        return createApiAuthHeader(requestUrl, method, body ?? null);
      },
      async nip44EncryptToNpub() {
        throw new Error('NIP-44 encryption is not available through the Flight Deck API bridge.');
      },
      async nip44DecryptFromNpub() {
        throw new Error('NIP-44 decryption is not available through the Flight Deck API bridge.');
      },
    },
  });
  if (getTowerTransport(_baseUrl).mode === 'fips') {
    // The SDK owns checkout serialization/error mapping. Supply this client's
    // request port so it cannot bypass the selected native transport.
    client.requestJson = async (path, method, body) => {
      const response = await signedFetch(path, { method, body });
      if (!response.ok) {
        const error = await buildApiError(response, { requestUrl: url(path), method });
        throw new SuperbasedHttpError(error.message, {
          status: response.status, method, url: url(path), body: error.payload, responseText: error.responseText,
        });
      }
      return response.status === 204 ? undefined : response.json();
    };
  }
  return client;
}

async function signedFetchAbsolute(requestUrl, { method = 'GET', body } = {}, options = {}) {
  const headers = {
    Authorization: await createApiAuthHeader(requestUrl, method, body ?? null, options),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(requestUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: createFetchTimeoutSignal(DEFAULT_FETCH_TIMEOUT_MS),
  });
}

function resolveTowerPgUrl(pathOrUrl, baseUrl = _baseUrl) {
  const value = String(pathOrUrl || '').trim();
  if (!value) throw new Error('Tower PG request path is required');
  const base = String(baseUrl || _baseUrl || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(value)) {
    const selected = getTowerTransport(base);
    if (selected.mode === 'fips') {
      const target = new URL(value);
      if (target.origin !== new URL(base).origin && target.origin !== selected.endpoint) {
        throw new Error('FIPS Tower response points outside the paired Tower; public requests are not permitted.');
      }
    }
    try {
      const absolute = new URL(value);
      const configuredBase = base ? new URL(base) : null;
      if (
        configuredBase?.protocol === 'https:'
        && absolute.protocol === 'http:'
        && absolute.hostname === configuredBase.hostname
      ) {
        absolute.protocol = 'https:';
      }
      return absolute.toString();
    } catch {
      return value;
    }
  }
  if (!base) throw new Error('Backend URL not configured');
  return `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

async function signedTowerPgFetch(pathOrUrl, {
  method = 'GET',
  body,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
  authTimeoutMs,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  useWorkspaceKey = true,
} = {}) {
  const requestUrl = resolveTowerPgUrl(pathOrUrl, baseUrl);
  const headers = {
    Authorization: await createApiAuthHeader(requestUrl, method, body ?? null, { authTimeoutMs, useWorkspaceKey }),
  };
  const cleanAppNpub = String(appNpub || '').trim();
  if (cleanAppNpub) headers['x-flightdeck-pg-app-npub'] = cleanAppNpub;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(requestUrl, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: createFetchTimeoutSignal(timeoutMs),
  });
}

function responseShape(payload) {
  if (Array.isArray(payload)) return { type: 'array', length: payload.length };
  if (!payload || typeof payload !== 'object') return { type: typeof payload };
  const shape = { type: 'object', keys: Object.keys(payload).sort() };
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) shape[`${key}Count`] = value.length;
  }
  return shape;
}

function towerPgRequestInfo({ requestUrl, method = 'GET', appNpub = '', response = null, payload = null, baseUrl = _baseUrl, useWorkspaceKey = true }) {
  let signingUrl = requestUrl;
  try {
    signingUrl = resolveTowerSigningUrl(requestUrl);
  } catch {}
  const parsed = new URL(requestUrl);
  return {
    method: String(method || 'GET').toUpperCase(),
    url: requestUrl,
    route: parsed.pathname,
    query: parsed.search ? parsed.search.slice(1) : '',
    body: null,
    appNpub: String(appNpub || '').trim(),
    appNpubSent: Boolean(String(appNpub || '').trim()),
    signerNpub: getEffectiveViewerNpub(),
    usedWorkspaceKey: Boolean(useWorkspaceKey),
    transportMode: getTowerTransport(baseUrl).mode,
    signingUrl,
    httpStatus: response?.status ?? null,
    responseShape: payload == null ? null : responseShape(payload),
  };
}

async function signedFetchWithFallbacks(path, { method = 'GET', body } = {}, options = {}) {
  const result = await signedFetchWithFallbackMeta(path, { method, body }, options);
  return result.response;
}

async function signedFetchWithFallbackMeta(path, { method = 'GET', body } = {}, options = {}) {
  const { baseUrl: baseUrlOverride, ...authOptions } = options || {};
  const baseUrl = String(baseUrlOverride || _baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('Backend URL not configured');
  }
  const requestUrl = `${baseUrl}${path}`;
  const response = await signedFetchAbsolute(requestUrl, { method, body }, authOptions);
  return { response, requestUrl };
}

async function signedFetchBytes(path) {
  const requestUrl = url(path);
  const resp = await signedFetch(path);
  if (!resp.ok) {
    throw await buildApiError(resp, { requestUrl, method: 'GET' });
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function signedFetchBlob(path) {
  const requestUrl = url(path);
  const resp = await signedFetch(path);
  if (!resp.ok) {
    throw await buildApiError(resp, { requestUrl, method: 'GET' });
  }
  return resp.blob();
}

// --- Groups ---

export async function createGroup({ owner_npub, name, group_npub, member_keys }) {
  const requestUrl = url('/api/v4/groups');
  const resp = await signedFetch('/api/v4/groups', {
    method: 'POST',
    body: { owner_npub, name, group_npub, member_keys },
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function addGroupMember(groupId, { member_npub, wrapped_group_nsec, wrapped_by_npub }) {
  const requestPath = `/api/v4/groups/${groupId}/members`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(`/api/v4/groups/${groupId}/members`, {
    method: 'POST',
    body: { member_npub, wrapped_group_nsec, wrapped_by_npub },
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function rotateGroup(groupId, { group_npub, member_keys, name }) {
  const requestPath = `/api/v4/groups/${groupId}/rotate`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(`/api/v4/groups/${groupId}/rotate`, {
    method: 'POST',
    body: { group_npub, member_keys, name },
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function deleteGroupMember(groupId, memberNpub) {
  const requestPath = `/api/v4/groups/${groupId}/members/${encodeURIComponent(memberNpub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(requestPath, {
    method: 'DELETE',
  });
  return json(resp, { requestUrl, method: 'DELETE' });
}

export async function getGroups(npub) {
  const requestPath = `/api/v4/groups?npub=${encodeURIComponent(npub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

// Tower resolves this route for the authenticated actor/workspace-key path.
// Callers must treat it as self-only readable state, not a way to probe
// wrapped keys for arbitrary other members.
export async function getGroupKeys(memberNpub) {
  const requestPath = `/api/v4/groups/keys?member_npub=${encodeURIComponent(memberNpub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

export async function updateGroup(groupId, { name }) {
  const requestPath = `/api/v4/groups/${groupId}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(`/api/v4/groups/${groupId}`, {
    method: 'PATCH',
    body: { name },
  });
  return json(resp, { requestUrl, method: 'PATCH' });
}

export async function deleteGroup(groupId) {
  const requestPath = `/api/v4/groups/${groupId}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(`/api/v4/groups/${groupId}`, {
    method: 'DELETE',
  });
  return json(resp, { requestUrl, method: 'DELETE' });
}

// --- Workspaces ---

export async function createWorkspace(body) {
  const requestPath = '/api/v4/workspaces';
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks('/api/v4/workspaces', {
    method: 'POST',
    body,
  }, { useWorkspaceKey: false });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function getWorkspaces(memberNpub) {
  const requestPath = `/api/v4/workspaces?member_npub=${encodeURIComponent(memberNpub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks(requestPath, {}, { useWorkspaceKey: false });
  return json(resp, { requestUrl, method: 'GET' });
}

export async function getTowerPgService({ baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = '/api/v4/flightdeck-pg/service';
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, useWorkspaceKey: false });
  return normalizeTowerConnectionResponse(await json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' }));
}

export async function listTowerPgWorkspaces({ baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (appNpub) params.set('app_npub', String(appNpub));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  try {
    const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, useWorkspaceKey: false });
    const payload = await json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
    const normalized = normalizeTowerConnectionResponse(payload);
    return {
      ...normalized,
      towerPgRequest: towerPgRequestInfo({ requestUrl, method: 'GET', appNpub, response: resp, payload: normalized, baseUrl, useWorkspaceKey: false }),
    };
  } catch (error) {
    error.towerPgRequest = towerPgRequestInfo({
      requestUrl: error?.requestUrl || requestUrl,
      method: 'GET',
      appNpub,
      response: error?.status ? { status: error.status } : null,
      payload: error?.payload || null,
      baseUrl,
      useWorkspaceKey: false,
    });
    throw error;
  }
}

export async function createTowerPgAdminWorkspace(body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = '/api/v4/admin/flightdeck-pg/workspaces';
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return normalizeTowerConnectionResponse(await json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG Admin API' }));
}

export async function updateTowerPgWorkspace(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function deleteTowerPgWorkspace(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function updateTowerPgWorkspaceMemberProfile(workspaceId, actorId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedActorId = encodeURIComponent(String(actorId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedActorId) throw new Error('Tower PG actor id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/members/${encodedActorId}/profile`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkspaceDescriptor(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, path = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId && !path) throw new Error('Tower PG workspace id is required');
  const requestPath = path || `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/descriptor`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, useWorkspaceKey: false });
  return normalizeTowerConnectionResponse(await json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' }));
}

export async function getTowerPgWorkspaceMe(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, path = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId && !path) throw new Error('Tower PG workspace id is required');
  const requestPath = path || `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/me`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, useWorkspaceKey: false });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgPersonalAgentSettings(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/me/autopilot-agents`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function updateTowerPgPersonalAgentSettings(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/me/autopilot-agents`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PUT', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PUT', prefix: 'Tower PG API' });
}

export async function createTowerPgAutopilotConnection(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/autopilot-connections`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgAutopilotConnection(workspaceId, connectionId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedConnectionId = encodeURIComponent(String(connectionId || '').trim());
  if (!encodedWorkspaceId || !encodedConnectionId) throw new Error('Tower PG workspace and Autopilot connection ids are required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/autopilot-connections/${encodedConnectionId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkspaceAgent(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workspace-agents`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkspaceMembers(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/members${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgNotificationSettings(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/notifications/settings`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function updateTowerPgNotificationPreferences(workspaceId, preferences, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/notifications/preferences`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const patch = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? {
      chat_threads_enabled: Boolean(preferences.channel_threads ?? preferences.chat_threads_enabled),
      mentions_enabled: Boolean(preferences.mentions ?? preferences.mentions_enabled),
      dms_enabled: Boolean(preferences.dms ?? preferences.dms_enabled),
      comment_tags_enabled: Boolean(preferences.comment_tags ?? preferences.comment_tags_enabled),
      task_assignments_enabled: Boolean(preferences.task_assignments ?? preferences.task_assignments_enabled),
    }
    : {};
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'PATCH',
    body: patch,
    baseUrl,
    appNpub,
  });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function upsertTowerPgPushSubscription(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/notifications/subscriptions`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'POST',
    body,
    baseUrl,
    appNpub,
  });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function revokeTowerPgPushSubscription(workspaceId, subscriptionId, { endpoint = '', baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedSubscriptionId = encodeURIComponent(String(subscriptionId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedSubscriptionId && !endpoint) throw new Error('Tower PG subscription id or endpoint is required');
  const requestPath = encodedSubscriptionId
    ? `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/notifications/subscriptions/${encodedSubscriptionId}`
    : `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/notifications/subscriptions`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const body = encodedSubscriptionId ? undefined : { endpoint };
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'DELETE',
    body,
    baseUrl,
    appNpub,
  });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkspaceMember(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/members`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkspaceGroups(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkspaceGroup(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function addTowerPgWorkspaceGroupMember(workspaceId, groupId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedGroupId = encodeURIComponent(String(groupId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedGroupId) throw new Error('Tower PG group id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups/${encodedGroupId}/members`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function removeTowerPgWorkspaceGroupMember(workspaceId, groupId, actorId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedGroupId = encodeURIComponent(String(groupId || '').trim());
  const encodedActorId = encodeURIComponent(String(actorId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedGroupId) throw new Error('Tower PG group id is required');
  if (!encodedActorId) throw new Error('Tower PG actor id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups/${encodedGroupId}/members/${encodedActorId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function addTowerPgWorkspaceChildGroup(workspaceId, parentGroupId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedGroupId = encodeURIComponent(String(parentGroupId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedGroupId) throw new Error('Tower PG group id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups/${encodedGroupId}/child-groups`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function removeTowerPgWorkspaceChildGroup(workspaceId, parentGroupId, childGroupId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedGroupId = encodeURIComponent(String(parentGroupId || '').trim());
  const encodedChildGroupId = encodeURIComponent(String(childGroupId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedGroupId) throw new Error('Tower PG group id is required');
  if (!encodedChildGroupId) throw new Error('Tower PG child group id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/groups/${encodedGroupId}/child-groups/${encodedChildGroupId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelGrants(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/grants`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, {
    baseUrl,
    appNpub,
    authTimeoutMs: READ_AUTH_HEADER_TIMEOUT_MS,
  });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelGrant(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/grants`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgChannelGrant(workspaceId, channelId, principalType, principalId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  const encodedPrincipalType = encodeURIComponent(String(principalType || '').trim());
  const encodedPrincipalId = encodeURIComponent(String(principalId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  if (!encodedPrincipalType) throw new Error('Tower PG principal type is required');
  if (!encodedPrincipalId) throw new Error('Tower PG principal id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/grants/${encodedPrincipalType}/${encodedPrincipalId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PUT', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PUT', prefix: 'Tower PG API' });
}

export async function deleteTowerPgChannelGrant(workspaceId, channelId, principalType, principalId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  const encodedPrincipalType = encodeURIComponent(String(principalType || '').trim());
  const encodedPrincipalId = encodeURIComponent(String(principalId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  if (!encodedPrincipalType) throw new Error('Tower PG principal type is required');
  if (!encodedPrincipalId) throw new Error('Tower PG principal id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/grants/${encodedPrincipalType}/${encodedPrincipalId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkspaceScopes(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, path = null, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId && !path) throw new Error('Tower PG workspace id is required');
  const requestPath = path || `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const finalPath = params.size > 0
    ? `${requestPath}${requestPath.includes('?') ? '&' : '?'}${params.toString()}`
    : requestPath;
  const finalUrl = params.size > 0
    ? `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}${params.toString()}`
    : requestUrl;
  const resp = await signedTowerPgFetch(finalPath, { baseUrl, appNpub });
  return json(resp, { requestUrl: finalUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgRecordSync(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, cursor = null, limit = 200, timeoutMs = 30_000 } = {}) {
  const params = new URLSearchParams({ protocol_version: '1', limit: String(Math.min(200, Math.max(1, limit))) });
  if (cursor) params.set('cursor', cursor);
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/record-sync?${params}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, timeoutMs });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG record sync' });
}

export async function getTowerPgWorkspaceSync(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, cursor = null, limit = 500, timeoutMs = 30_000 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', String(cursor));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/sync${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub, timeoutMs });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkspaceScope(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgWorkspaceScope(workspaceId, scopeId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedScopeId = encodeURIComponent(String(scopeId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedScopeId) throw new Error('Tower PG scope id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes/${encodedScopeId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function deleteTowerPgWorkspaceScope(workspaceId, scopeId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedScopeId = encodeURIComponent(String(scopeId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedScopeId) throw new Error('Tower PG scope id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes/${encodedScopeId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function getTowerPgScopeChannels(workspaceId, scopeId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedScopeId = encodeURIComponent(String(scopeId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedScopeId) throw new Error('Tower PG scope id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes/${encodedScopeId}/channels${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgScopeChannel(workspaceId, scopeId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedScopeId = encodeURIComponent(String(scopeId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedScopeId) throw new Error('Tower PG scope id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes/${encodedScopeId}/channels`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgChannel(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  // Channel settings are an interactive mutation. Do not leave the modal in a
  // permanent "Saving" state when a browser signer is unavailable.
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'PATCH',
    body,
    baseUrl,
    appNpub,
    authTimeoutMs: INTERACTIVE_AUTH_HEADER_TIMEOUT_MS,
  });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function reorderTowerPgChannel(workspaceId, channelId, position, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  if (!Number.isInteger(Number(position)) || Number(position) < 1) throw new Error('Channel position must be a positive 1-based integer');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/reorder`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'POST',
    body: { position: Number(position) },
    baseUrl,
    appNpub,
    authTimeoutMs: INTERACTIVE_AUTH_HEADER_TIMEOUT_MS,
  });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function deleteTowerPgChannel(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelThreads(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100, includeArchived = false } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (includeArchived) params.set('include_archived', 'true');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/threads${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgResourceViewStates(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, resourceType = null, channelId = null, limit = 200, cursor = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (resourceType) params.set('resource_type', String(resourceType));
  if (channelId) params.set('channel_id', String(channelId));
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', String(cursor));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/resource-view-states?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function putTowerPgResourceViewState(workspaceId, resourceType, resourceId, viewedActivityVersion, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedResourceType = encodeURIComponent(String(resourceType || '').trim());
  const encodedResourceId = encodeURIComponent(String(resourceId || '').trim());
  if (!encodedWorkspaceId || !encodedResourceType || !encodedResourceId) throw new Error('Tower PG resource view-state identity is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/resource-view-states/${encodedResourceType}/${encodedResourceId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'PUT', body: { viewed_activity_version: Number(viewedActivityVersion || 0) }, baseUrl, appNpub,
  });
  return json(resp, { requestUrl, method: 'PUT', prefix: 'Tower PG API' });
}

export async function markTowerPgResourcesViewed(workspaceId, resources, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/resource-view-states/mark-viewed`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body: { resources }, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgThread(workspaceId, threadId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedThreadId = encodeURIComponent(String(threadId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedThreadId) throw new Error('Tower PG thread id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/threads/${encodedThreadId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function updateTowerPgThread(workspaceId, threadId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedThreadId = encodeURIComponent(String(threadId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedThreadId) throw new Error('Tower PG thread id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/threads/${encodedThreadId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelMessages(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, threadId = null, effectiveTranscript = false, limit = 200, cursor = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (threadId) params.set('thread_id', String(threadId));
  if (effectiveTranscript) params.set('effective_transcript', 'true');
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', String(cursor));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/messages${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgThreadBranch(workspaceId, channelId, parentThreadId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  const encodedParentThreadId = encodeURIComponent(String(parentThreadId || '').trim());
  if (!encodedWorkspaceId || !encodedChannelId || !encodedParentThreadId) throw new Error('Tower PG branch identity is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/threads/${encodedParentThreadId}/branches`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelTasks(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/tasks${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgScopeTasks(workspaceId, scopeId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedScopeId = encodeURIComponent(String(scopeId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedScopeId) throw new Error('Tower PG scope id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/scopes/${encodedScopeId}/tasks${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgTask(workspaceId, taskId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgTaskComments(workspaceId, taskId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/comments${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocComments(workspaceId, docId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/comments${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocVersions(workspaceId, docId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 50 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/versions${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocRecoveries(workspaceId, docId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, state = 'open', limit = 50 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const params = new URLSearchParams();
  if (state) params.set('state', String(state));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/recoveries${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocRecovery(workspaceId, docId, recoveryId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedRecoveryId = encodeURIComponent(String(recoveryId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedRecoveryId) throw new Error('Tower PG document recovery id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/recoveries/${encodedRecoveryId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocRecoveryBody(workspaceId, docId, recoveryId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedRecoveryId = encodeURIComponent(String(recoveryId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedRecoveryId) throw new Error('Tower PG document recovery id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/recoveries/${encodedRecoveryId}/body`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function promoteTowerPgDocRecovery(workspaceId, docId, recoveryId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedRecoveryId = encodeURIComponent(String(recoveryId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedRecoveryId) throw new Error('Tower PG document recovery id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/recoveries/${encodedRecoveryId}/promote`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function discardTowerPgDocRecovery(workspaceId, docId, recoveryId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedRecoveryId = encodeURIComponent(String(recoveryId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedRecoveryId) throw new Error('Tower PG document recovery id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/recoveries/${encodedRecoveryId}/discard`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgDailyNotes(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, noteDate = null, ownerActorId = null, ownerNpub = null, scopeId = null, channelId = null, limit = 30 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (noteDate) params.set('note_date', String(noteDate));
  if (ownerActorId) params.set('owner_actor_id', String(ownerActorId));
  if (ownerNpub) params.set('owner_npub', String(ownerNpub));
  if (scopeId) params.set('scope_id', String(scopeId));
  if (channelId) params.set('channel_id', String(channelId));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/daily-notes${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function upsertTowerPgDailyNote(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/daily-notes`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgDailyNoteVersions(workspaceId, dailyNoteId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 50 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDailyNoteId = encodeURIComponent(String(dailyNoteId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDailyNoteId) throw new Error('Tower PG daily note id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/daily-notes/${encodedDailyNoteId}/versions${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgPersonalWapps(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, ownerActorId = null, ownerNpub = null, includeArchived = false, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (ownerActorId) params.set('owner_actor_id', String(ownerActorId));
  if (ownerNpub) params.set('owner_npub', String(ownerNpub));
  if (includeArchived) params.set('include_archived', 'true');
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgPersonalWapp(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgPersonalWapp(workspaceId, personalWappId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWappId = encodeURIComponent(String(personalWappId || '').trim());
  if (!encodedWorkspaceId || !encodedWappId) throw new Error('Tower PG workspace id and personal WApp id are required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps/${encodedWappId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function deleteTowerPgPersonalWapp(workspaceId, personalWappId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWappId = encodeURIComponent(String(personalWappId || '').trim());
  if (!encodedWorkspaceId || !encodedWappId) throw new Error('Tower PG workspace id and personal WApp id are required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps/${encodedWappId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function reorderTowerPgPersonalWapps(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/personal-wapps/reorder`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

function towerPgWappManagementPath(workspaceId, suffix = '') {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  return `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}${suffix}`;
}

async function towerPgWappManagementRequest(workspaceId, suffix, { method = 'GET', body, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappManagementPath(workspaceId, suffix);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method, body, baseUrl, appNpub });
  return json(resp, { requestUrl, method, prefix: 'Tower PG WApp management' });
}

export const getTowerPgWappDelegations = (workspaceId, options = {}) => towerPgWappManagementRequest(workspaceId, '/wapp-delegations', options);
export const createTowerPgWappDelegation = (workspaceId, body, options = {}) => towerPgWappManagementRequest(workspaceId, '/wapp-delegations', { ...options, method: 'POST', body });
export const revokeTowerPgWappDelegation = (workspaceId, delegationId, options = {}) => towerPgWappManagementRequest(workspaceId, `/wapp-delegations/${encodeURIComponent(String(delegationId || '').trim())}/revoke`, { ...options, method: 'POST', body: {} });
export const getTowerPgWappInstallIntents = (workspaceId, options = {}) => towerPgWappManagementRequest(workspaceId, '/wapp-install-intents', options);
export const createTowerPgWappInstallIntent = (workspaceId, body, options = {}) => towerPgWappManagementRequest(workspaceId, '/wapp-install-intents', { ...options, method: 'POST', body });
export const getTowerPgManagedWappInstallations = (workspaceId, options = {}) => towerPgWappManagementRequest(workspaceId, '/wapp-installations', options);
export const reconcileTowerPgManagedWappInstallation = (workspaceId, installationId, options = {}) => towerPgWappManagementRequest(workspaceId, `/wapp-installations/${encodeURIComponent(String(installationId || '').trim())}/reconcile`, { ...options, method: 'POST', body: {} });
export const revokeTowerPgManagedWappInstallation = (workspaceId, installationId, options = {}) => towerPgWappManagementRequest(workspaceId, `/wapp-installations/${encodeURIComponent(String(installationId || '').trim())}/revoke`, { ...options, method: 'POST', body: {} });

export async function getAutopilotWappActivationCatalog(baseUrl = window.location.origin) {
  const requestUrl = resolveTowerPgUrl('/api/wapps/activation-catalog', baseUrl);
  const response = await signedTowerPgFetch(requestUrl, { baseUrl, appNpub: '' });
  return json(response, { requestUrl, method: 'GET', prefix: 'Autopilot WApp activation' });
}

export async function processAutopilotWappInstallIntent(workspaceId, intentId, baseUrl = window.location.origin) {
  const requestUrl = resolveTowerPgUrl('/api/wapps/install-intents/process', baseUrl);
  const body = { workspace_id: workspaceId, intent_id: intentId };
  const response = await signedTowerPgFetch(requestUrl, { method: 'POST', body, baseUrl, appNpub: '' });
  return json(response, { requestUrl, method: 'POST', prefix: 'Autopilot WApp activation' });
}

function towerPgWappPublishingPath(workspaceId, suffix = '') {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  return `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}${suffix}`;
}

function towerPgWappInstallationPath(workspaceId, wappInstallationId, suffix = '') {
  const encodedInstallationId = encodeURIComponent(String(wappInstallationId || '').trim());
  if (!encodedInstallationId) throw new Error('WApp installation id is required');
  return towerPgWappPublishingPath(workspaceId, `/wapp-publishing-grants/${encodedInstallationId}${suffix}`);
}

export async function getTowerPgWappPublishingGrants(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappPublishingPath(workspaceId, '/wapp-publishing-grants');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp publishing grants' });
}

export async function getTowerPgWappPublishingGrant(workspaceId, wappInstallationId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappInstallationPath(workspaceId, wappInstallationId);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp publishing grant' });
}

export async function putTowerPgWappPublishingGrant(workspaceId, wappInstallationId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappInstallationPath(workspaceId, wappInstallationId);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PUT', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PUT', prefix: 'Tower PG WApp publishing grant' });
}

export async function disableTowerPgWappPublishingGrant(workspaceId, wappInstallationId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappInstallationPath(workspaceId, wappInstallationId, '/disable');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG WApp publishing grant disable' });
}

export async function revokeTowerPgWappPublishingGrant(workspaceId, wappInstallationId, body = {}, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappInstallationPath(workspaceId, wappInstallationId, '/revoke');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG WApp publishing grant revoke' });
}

export async function rotateTowerPgWappPublishingGrant(workspaceId, wappInstallationId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappInstallationPath(workspaceId, wappInstallationId, '/rotate');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG WApp publishing grant rotation' });
}

export async function getTowerPgWappActivityItems(workspaceId, {
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
  unread,
  state,
  installationId,
  category,
  channelId,
  cursor,
  limit = 100,
  includeResolved = true,
} = {}) {
  const params = new URLSearchParams();
  if (typeof unread === 'boolean') params.set('unread', String(unread));
  if (state) params.set('state', String(state));
  if (installationId) params.set('installation_id', String(installationId));
  if (category) params.set('category', String(category));
  if (channelId) params.set('channel_id', String(channelId));
  if (cursor) params.set('cursor', String(cursor));
  if (limit) params.set('limit', String(limit));
  if (includeResolved) params.set('include_resolved', 'true');
  const requestPath = `${towerPgWappPublishingPath(workspaceId, '/wapp-activity/items')}${params.size ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp activity feed' });
}

export async function getTowerPgWappActivityItem(workspaceId, itemId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedItemId = encodeURIComponent(String(itemId || '').trim());
  if (!encodedItemId) throw new Error('WApp activity item id is required');
  const requestPath = towerPgWappPublishingPath(workspaceId, `/wapp-activity/items/${encodedItemId}`);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp activity item' });
}

export async function getTowerPgWappActivityCounts(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappPublishingPath(workspaceId, '/wapp-activity/counts');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp activity counts' });
}

export async function patchTowerPgWappActivityUserState(workspaceId, itemId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedItemId = encodeURIComponent(String(itemId || '').trim());
  if (!encodedItemId) throw new Error('WApp activity item id is required');
  const requestPath = towerPgWappPublishingPath(workspaceId, `/wapp-activity/items/${encodedItemId}/user-state`);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG WApp activity user state' });
}

export async function getTowerPgWappActivityMutes(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappPublishingPath(workspaceId, '/wapp-activity/mutes');
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG WApp activity mutes' });
}

function towerPgWappMutePath(workspaceId, targetType, targetValue) {
  const normalizedTargetType = String(targetType || '').trim();
  if (!['installation', 'category'].includes(normalizedTargetType)) {
    throw new Error('WApp activity mute target type must be installation or category');
  }
  const encodedTargetValue = encodeURIComponent(String(targetValue || '').trim());
  if (!encodedTargetValue) throw new Error('WApp activity mute target value is required');
  return towerPgWappPublishingPath(workspaceId, `/wapp-activity/mutes/${normalizedTargetType}/${encodedTargetValue}`);
}

export async function putTowerPgWappActivityMute(workspaceId, targetType, targetValue, body = {}, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappMutePath(workspaceId, targetType, targetValue);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PUT', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PUT', prefix: 'Tower PG WApp activity mute' });
}

export async function deleteTowerPgWappActivityMute(workspaceId, targetType, targetValue, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const requestPath = towerPgWappMutePath(workspaceId, targetType, targetValue);
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG WApp activity mute' });
}

export async function getTowerPgDailyScopeAgentAccess(workspaceId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/daily-scope/agent-access`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function upsertTowerPgDailyScopeAgentAccess(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/daily-scope/agent-access`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelDocs(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200, archived = false } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (archived) params.set('archived', 'true');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/docs${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDoc(workspaceId, docId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgDocBody(workspaceId, docId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/body`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgInvocations(workspaceId, {
  role = 'visible',
  status = null,
  targetType = null,
  targetId = null,
  recipientNpub = null,
  createdByNpub = null,
  scopeId = null,
  channelId = null,
  updatedSince = null,
  invocationId = null,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
  limit = 100,
} = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (role) params.set('role', String(role));
  if (status) params.set('status', String(status));
  if (targetType) params.set('target_type', String(targetType));
  if (targetId) params.set('target_id', String(targetId));
  if (recipientNpub) params.set('recipient_npub', String(recipientNpub));
  if (createdByNpub) params.set('created_by_npub', String(createdByNpub));
  if (scopeId) params.set('scope_id', String(scopeId));
  if (channelId) params.set('channel_id', String(channelId));
  if (updatedSince) params.set('updated_since', String(updatedSince));
  if (invocationId) params.set('invocation_id', String(invocationId));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/invocations${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgInvocation(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/invocations`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelFiles(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200, archived = false } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (archived) params.set('archived', 'true');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/files${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelFileFolders(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/file-folders${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelFileFolder(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/file-folders`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgFileFolder(workspaceId, folderId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedFolderId = encodeURIComponent(String(folderId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedFolderId) throw new Error('Tower PG file folder id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/file-folders/${encodedFolderId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function getTowerPgChannelAudioNotes(workspaceId, channelId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/audio-notes${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelTask(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/tasks`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelDoc(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/docs`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelFile(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/files`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgFile(workspaceId, fileId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedFileId = encodeURIComponent(String(fileId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedFileId) throw new Error('Tower PG file id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/files/${encodedFileId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelAudioNote(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/audio-notes`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function prepareTowerPgStorageObject(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/storage/prepare`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgEditLease(workspaceId, { entityType, entityId, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  params.set('entity_type', String(entityType || '').trim());
  params.set('entity_id', String(entityId || '').trim());
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/edit-leases?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function acquireTowerPgEditLease(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/edit-leases/acquire`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function renewTowerPgEditLease(workspaceId, leaseId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedLeaseId = encodeURIComponent(String(leaseId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedLeaseId) throw new Error('Tower PG edit lease id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/edit-leases/${encodedLeaseId}/renew`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function releaseTowerPgEditLease(workspaceId, leaseId, body = {}, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedLeaseId = encodeURIComponent(String(leaseId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedLeaseId) throw new Error('Tower PG edit lease id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/edit-leases/${encodedLeaseId}/release`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgDoc(workspaceId, docId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function moveTowerPgDoc(workspaceId, docId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/move`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function deleteTowerPgDoc(workspaceId, docId, { rowVersion = null, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const params = new URLSearchParams();
  if (rowVersion) params.set('row_version', String(rowVersion));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function updateTowerPgTask(workspaceId, taskId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function moveTowerPgTask(workspaceId, taskId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/move`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgTaskState(workspaceId, taskId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/state`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function assignTowerPgTask(workspaceId, taskId, actorId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  const normalizedActorId = String(actorId || '').trim();
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  if (!normalizedActorId) throw new Error('Tower PG assignment actor id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/assignments`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, {
    method: 'POST',
    body: { actor_id: normalizedActorId },
    baseUrl,
    appNpub,
  });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function unassignTowerPgTask(workspaceId, taskId, actorId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  const encodedActorId = encodeURIComponent(String(actorId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  if (!encodedActorId) throw new Error('Tower PG assignment actor id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/assignments/${encodedActorId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function deleteTowerPgTask(workspaceId, taskId, { rowVersion = null, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const params = new URLSearchParams();
  if (rowVersion) params.set('row_version', String(rowVersion));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function createTowerPgTaskComment(workspaceId, taskId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedTaskId) throw new Error('Tower PG task id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/tasks/${encodedTaskId}/comments`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function createTowerPgDocComment(workspaceId, docId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/comments`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgDocComment(workspaceId, docId, commentId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedCommentId = encodeURIComponent(String(commentId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedCommentId) throw new Error('Tower PG doc comment id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/comments/${encodedCommentId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function deleteTowerPgDocComment(workspaceId, docId, commentId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, rowVersion = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedDocId = encodeURIComponent(String(docId || '').trim());
  const encodedCommentId = encodeURIComponent(String(commentId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedDocId) throw new Error('Tower PG doc id is required');
  if (!encodedCommentId) throw new Error('Tower PG doc comment id is required');
  const params = new URLSearchParams();
  if (rowVersion) params.set('row_version', String(rowVersion));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/docs/${encodedDocId}/comments/${encodedCommentId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function createTowerPgChannelMessage(workspaceId, channelId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedChannelId = encodeURIComponent(String(channelId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedChannelId) throw new Error('Tower PG channel id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/channels/${encodedChannelId}/messages`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgMessage(workspaceId, messageId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedMessageId = encodeURIComponent(String(messageId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedMessageId) throw new Error('Tower PG message id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/messages/${encodedMessageId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function deleteTowerPgMessage(workspaceId, messageId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, rowVersion = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedMessageId = encodeURIComponent(String(messageId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedMessageId) throw new Error('Tower PG message id is required');
  const params = new URLSearchParams();
  if (rowVersion) params.set('row_version', String(rowVersion));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/messages/${encodedMessageId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function deleteTowerPgThread(workspaceId, threadId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, rowVersion = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedThreadId = encodeURIComponent(String(threadId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedThreadId) throw new Error('Tower PG thread id is required');
  const params = new URLSearchParams();
  if (rowVersion) params.set('row_version', String(rowVersion));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/threads/${encodedThreadId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function archiveTowerPgThread(workspaceId, threadId, { archived = true, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, rowVersion = null } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedThreadId = encodeURIComponent(String(threadId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedThreadId) throw new Error('Tower PG thread id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/threads/${encodedThreadId}/archive`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const body = { archived: archived === true };
  if (rowVersion) body.row_version = rowVersion;
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function getTowerPgReactions(workspaceId, { targetType, targetId, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!targetType) throw new Error('Tower PG reaction target type is required');
  if (!targetId) throw new Error('Tower PG reaction target id is required');
  const params = new URLSearchParams({
    target_type: String(targetType),
    target_id: String(targetId),
  });
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/reactions?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgResponseActivities(workspaceId, { targetType = null, targetId = null, channelId = null, includeCleared = false, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (targetType) params.set('target_type', String(targetType));
  if (targetId) params.set('target_id', String(targetId));
  if (channelId) params.set('channel_id', String(channelId));
  if (includeCleared) params.set('include_cleared', 'true');
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/response-activities${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgAgentActivities(workspaceId, { channelId, threadId = null, activityId = null, cursor = null, beforeSequence = null, afterSequence = null, afterCommentaryCursor = null, historyLimit = 50, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!channelId) throw new Error('Tower PG agent activity channel id is required');
  const params = new URLSearchParams({ channel_id: String(channelId) });
  if (threadId) params.set('thread_id', String(threadId));
  if (activityId) params.set('activity_id', String(activityId));
  if (cursor) params.set('cursor', String(cursor));
  if (beforeSequence != null) params.set('before_sequence', String(beforeSequence));
  if (afterSequence != null) params.set('after_sequence', String(afterSequence));
  if (afterCommentaryCursor != null) params.set('after_commentary_cursor', String(afterCommentaryCursor));
  params.set('history_limit', String(historyLimit));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/agent-activities?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function getTowerPgAgentSessionHealth(workspaceId, { channelId, threadId = null, sessionId = null, baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 100 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!channelId) throw new Error('Tower PG agent session health channel id is required');
  const params = new URLSearchParams({ channel_id: String(channelId) });
  if (threadId) params.set('thread_id', String(threadId));
  if (sessionId) params.set('session_id', String(sessionId));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/agent-session-health?${params.toString()}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgReaction(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/reactions`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function deleteTowerPgReaction(workspaceId, reactionId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedReactionId = encodeURIComponent(String(reactionId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedReactionId) throw new Error('Tower PG reaction id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/reactions/${encodedReactionId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'DELETE', baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'DELETE', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkrooms(workspaceId, {
  scopeId = null,
  channelId = null,
  status = null,
  limit = 100,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
} = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (scopeId) params.set('scope_id', String(scopeId));
  if (channelId) params.set('channel_id', String(channelId));
  if (status) params.set('status', String(status));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function searchTowerPgWorkrooms(workspaceId, {
  query = '',
  scopeId = null,
  channelId = null,
  limit = 100,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
} = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  const q = String(query || '').trim();
  if (q) params.set('q', q);
  if (scopeId) params.set('scope_id', String(scopeId));
  if (channelId) params.set('channel_id', String(channelId));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/search${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkroom(workspaceId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkroom(workspaceId, workroomId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function updateTowerPgWorkroom(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function startTowerPgWorkroom(workspaceId, workroomId, body = {}, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/start`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function archiveTowerPgWorkroom(workspaceId, workroomId, body = {}, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/archive`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkroomParticipants(workspaceId, workroomId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/participants`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkroomParticipant(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/participants`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function updateTowerPgWorkroomParticipant(workspaceId, workroomId, participantId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  const encodedParticipantId = encodeURIComponent(String(participantId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  if (!encodedParticipantId) throw new Error('Tower PG workroom participant id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/participants/${encodedParticipantId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'PATCH', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'PATCH', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkroomEvents(workspaceId, workroomId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/events${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkroomEvent(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/events`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgWorkroomLinks(workspaceId, workroomId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, limit = 200 } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/links${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkroomLink(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/links`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgApprovals(workspaceId, {
  targetType = null,
  targetId = null,
  action = null,
  status = null,
  limit = 100,
  baseUrl = _baseUrl,
  appNpub = FLIGHT_DECK_PG_APP_NPUB,
} = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  const params = new URLSearchParams();
  if (targetType) params.set('target_type', String(targetType));
  if (targetId) params.set('target_id', String(targetId));
  if (action) params.set('action', String(action));
  if (status) params.set('status', String(status));
  if (limit) params.set('limit', String(limit));
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/approvals${params.size > 0 ? `?${params.toString()}` : ''}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function createTowerPgWorkroomApproval(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/approvals`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function getTowerPgApproval(workspaceId, approvalId, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedApprovalId = encodeURIComponent(String(approvalId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedApprovalId) throw new Error('Tower PG approval id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/approvals/${encodedApprovalId}`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'GET', prefix: 'Tower PG API' });
}

export async function decideTowerPgApproval(workspaceId, approvalId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedApprovalId = encodeURIComponent(String(approvalId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedApprovalId) throw new Error('Tower PG approval id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/approvals/${encodedApprovalId}/decision`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function checkTowerPgProductionMergeApproval(workspaceId, workroomId, body, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB } = {}) {
  const encodedWorkspaceId = encodeURIComponent(String(workspaceId || '').trim());
  const encodedWorkroomId = encodeURIComponent(String(workroomId || '').trim());
  if (!encodedWorkspaceId) throw new Error('Tower PG workspace id is required');
  if (!encodedWorkroomId) throw new Error('Tower PG workroom id is required');
  const requestPath = `/api/v4/flightdeck-pg/workspaces/${encodedWorkspaceId}/workrooms/${encodedWorkroomId}/production-merge/check`;
  const requestUrl = resolveTowerPgUrl(requestPath, baseUrl);
  const resp = await signedTowerPgFetch(requestPath, { method: 'POST', body, baseUrl, appNpub });
  return json(resp, { requestUrl, method: 'POST', prefix: 'Tower PG API' });
}

export async function recoverWorkspace(body) {
  const requestPath = '/api/v4/workspaces/recover';
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks('/api/v4/workspaces/recover', {
    method: 'POST',
    body,
  }, { useWorkspaceKey: false });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function updateWorkspace(workspaceOwnerNpub, body) {
  const requestPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwnerNpub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks(requestPath, {
    method: 'PATCH',
    body,
  });
  return json(resp, { requestUrl, method: 'PATCH' });
}

export async function registerWorkspaceApp(workspaceOwnerNpub, { app_npub, app_name }) {
  const requestPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwnerNpub)}/apps`;
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks(requestPath, {
    method: 'POST',
    body: { app_npub, app_name },
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function publishWorkspaceAppSchema(workspaceOwnerNpub, appNpub, body) {
  const requestPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwnerNpub)}/apps/${encodeURIComponent(appNpub)}/schemas`;
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks(requestPath, {
    method: 'POST',
    body,
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function fetchWorkspaceAppSchemas(workspaceOwnerNpub, { app_npub, latest = true } = {}) {
  const params = new URLSearchParams();
  if (app_npub) params.set('app_npub', app_npub);
  if (latest !== undefined) params.set('latest', latest ? 'true' : 'false');
  const requestPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwnerNpub)}/app-schemas${params.size ? `?${params}` : ''}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetchWithFallbacks(requestPath, {});
  return json(resp, { requestUrl, method: 'GET' });
}

export async function registerWorkspaceKey({ workspace_owner_npub, ws_key_npub }) {
  const requestPath = '/api/v4/user/workspace-keys';
  const requestUrl = url(requestPath);
  const body = { workspace_owner_npub, ws_key_npub };
  const resp = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      Authorization: await createNip98AuthHeader(requestUrl, 'POST', body),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: createFetchTimeoutSignal(DEFAULT_FETCH_TIMEOUT_MS),
  });
  return json(resp, { requestUrl, method: 'POST' });
}

// --- Storage ---

export async function prepareStorageObject(body) {
  const requestPath = '/api/v4/storage/prepare';
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath, {
    method: 'POST',
    body,
  });
  return json(resp, { requestUrl, method: 'POST' });
}

export async function uploadStorageObject(prepared, bytes, contentType = 'application/octet-stream', options = {}) {
  const uploadUrl = String(prepared?.upload_url || '').trim();
  let directUploadFailure = null;
  if (uploadUrl && getTowerTransport(options.backendUrl || _baseUrl).mode !== 'fips') {
    let directResp;
    try {
      directResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
        },
        body: bytes,
        signal: createFetchTimeoutSignal(UPLOAD_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      directUploadFailure = error instanceof Error ? error : new Error(String(error));
    }

    if (directResp?.ok) {
      return {
        object_id: prepared.object_id,
        size_bytes: bytes.byteLength,
        content_type: contentType,
      };
    }

    if (directResp && !directResp.ok) {
      directUploadFailure = await buildApiError(directResp, {
        requestUrl: uploadUrl,
        method: 'PUT',
        prefix: 'Storage upload',
      });
    }
  }

  const payload = {
    base64_data: bytesToBase64(bytes),
  };
  const fallbackPath = `/api/v4/storage/${prepared.object_id}`;
  const { response: fallbackResp, requestUrl: fallbackUrl } = await signedFetchWithFallbackMeta(fallbackPath, {
    method: 'PUT',
    body: payload,
  }, options);
  if (fallbackResp.ok) {
    return json(fallbackResp, { requestUrl: fallbackUrl, method: 'PUT' });
  }

  const fallbackError = await buildApiError(fallbackResp, {
    requestUrl: fallbackUrl,
    method: 'PUT',
  });
  if (directUploadFailure) {
    fallbackError.directUploadMessage = directUploadFailure.message;
    fallbackError.message = `Direct storage upload failed: ${directUploadFailure.message} | backend upload fallback failed: ${fallbackError.message}`;
  }
  throw fallbackError;
}

export async function completeStorageObject(objectId, body = {}, options = {}) {
  const requestPath = `/api/v4/storage/${objectId}/complete`;
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath, {
    method: 'POST',
    body,
  }, options);
  return json(resp, { requestUrl, method: 'POST' });
}

export async function getStorageDownloadUrl(objectId) {
  const requestPath = `/api/v4/storage/${objectId}/download-url`;
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

export async function getStorageObject(objectId) {
  const requestPath = `/api/v4/storage/${objectId}`;
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

export async function downloadStorageObject(objectId) {
  const requestPath = `/api/v4/storage/${objectId}/content`;
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath);
  if (!resp.ok) {
    throw await buildApiError(resp, { requestUrl, method: 'GET' });
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export async function downloadStorageObjectBlob(objectId, options = {}) {
  const requestPath = `/api/v4/storage/${objectId}/content`;
  const explicitBackendUrl = String(options?.backendUrl || '').trim().replace(/\/+$/, '');
  if (explicitBackendUrl) {
    const requestUrl = `${explicitBackendUrl}${requestPath}`;
    let resp;
    try {
      resp = await signedFetchAbsolute(requestUrl);
    } catch (error) {
      throw buildRequestFailure(error, { requestUrl, method: 'GET', prefix: 'Storage download' });
    }
    if (!resp.ok) {
      throw await buildApiError(resp, { requestUrl, method: 'GET' });
    }
    return resp.blob();
  }
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath);
  if (!resp.ok) {
    throw await buildApiError(resp, { requestUrl, method: 'GET' });
  }
  return resp.blob();
}

// --- Records heartbeat ---

export async function fetchHeartbeat({ owner_npub, viewer_npub, family_cursors }) {
  const requestUrl = url('/api/v4/records/heartbeat');
  const effectiveViewerNpub = getEffectiveReadViewerNpub(viewer_npub);
  const body = addWorkspaceKeyAuthBodyFields({
    owner_npub,
    family_cursors,
    ...(effectiveViewerNpub ? { viewer_npub: effectiveViewerNpub } : {}),
  });
  const resp = await signedFetch('/api/v4/records/heartbeat', {
    method: 'POST',
    body,
  });
  return json(resp, { requestUrl, method: 'POST' });
}

// --- Records summary ---

export async function fetchRecordsSummary(ownerNpub) {
  try {
    const params = new URLSearchParams({ owner_npub: ownerNpub });
    addWorkspaceKeyAuthParams(params);
    const resp = await signedFetch(`/api/v4/records/summary?${params}`);
    if (resp.status === 404 || resp.status === 405) {
      return { available: false, families: [] };
    }
    const data = await json(resp);
    return { available: true, ...data };
  } catch {
    return { available: false, families: [] };
  }
}

// --- Records sync ---

export async function acquireRecordCheckout(input) {
  return buildCoreApiClient().records.acquireCheckout(input);
}

export async function releaseRecordCheckout(input) {
  return buildCoreApiClient().records.releaseCheckout(input);
}

export async function syncRecords({ owner_npub, records, signing_npub, checkout_policy_config }) {
  const syncRequest = await buildFlightDeckSyncRequest({
    ownerNpub: owner_npub,
    records,
    signingNpub: signing_npub,
    baseUrl: _baseUrl,
    checkoutPolicyConfig: checkout_policy_config,
  });
  const deferredRecordIds = Array.isArray(syncRequest.deferred_record_ids)
    ? syncRequest.deferred_record_ids
    : [];

  if (syncRequest.records.length === 0) {
    return { synced: 0, created: 0, updated: 0, rejected: [], deferred: deferredRecordIds };
  }

  const requestUrl = url('/api/v4/records/sync');
  const resp = await signedFetch('/api/v4/records/sync', {
    method: 'POST',
    body: {
      owner_npub: syncRequest.owner_npub,
      workspace_service_npub: syncRequest.workspace_service_npub,
      ...(syncRequest.user_npub ? { user_npub: syncRequest.user_npub } : {}),
      ...(syncRequest.actor_npub ? { actor_npub: syncRequest.actor_npub } : {}),
      ...(syncRequest.viewer_npub ? { viewer_npub: syncRequest.viewer_npub } : {}),
      ...(syncRequest.signer_npub ? { signer_npub: syncRequest.signer_npub } : {}),
      ...(syncRequest.workspace_user_key_npub ? { workspace_user_key_npub: syncRequest.workspace_user_key_npub } : {}),
      ...(syncRequest.ws_key_npub ? { ws_key_npub: syncRequest.ws_key_npub } : {}),
      records: syncRequest.records,
      group_write_tokens: syncRequest.group_write_tokens,
    },
  });
  const result = await json(resp, { requestUrl, method: 'POST' });
  result.deferred = deferredRecordIds;
  return result;
}

export async function fetchRecordHistory({ record_id, owner_npub, viewer_npub }) {
  const params = new URLSearchParams({ owner_npub });
  addWorkspaceKeyAuthParams(params);
  const effectiveViewerNpub = getEffectiveReadViewerNpub(viewer_npub);
  if (effectiveViewerNpub) params.set('viewer_npub', effectiveViewerNpub);
  const requestPath = `/api/v4/records/${encodeURIComponent(record_id)}/history?${params}`;
  const { response: resp, requestUrl } = await signedFetchWithFallbackMeta(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

export async function fetchWorkspaceKeyMappings(ownerNpub) {
  const requestPath = `/api/v4/user/workspace-key-mappings?workspace_owner_npub=${encodeURIComponent(ownerNpub)}`;
  const requestUrl = url(requestPath);
  const resp = await signedFetch(requestPath);
  return json(resp, { requestUrl, method: 'GET' });
}

export async function fetchRecords({ owner_npub, viewer_npub, record_family_hash, since }) {
  const PAGE_SIZE = 1000;
  const allRecords = [];
  let offset = 0;
  let firstPage = null;
  let lastPage = null;
  let firstRequestUrl = null;

  while (true) {
    const params = new URLSearchParams({ owner_npub });
    addWorkspaceKeyAuthParams(params);
    const effectiveViewerNpub = getEffectiveReadViewerNpub(viewer_npub);
    if (effectiveViewerNpub) params.set('viewer_npub', effectiveViewerNpub);
    if (record_family_hash) params.set('record_family_hash', record_family_hash);
    if (since) params.set('since', since);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));

    const requestPath = `/api/v4/records?${params}`;
    const requestUrl = url(requestPath);
    if (!firstRequestUrl) firstRequestUrl = requestUrl;
    const resp = await signedFetch(requestPath);
    const page = await json(resp, { requestUrl, method: 'GET' });
    if (!firstPage) firstPage = page;
    lastPage = page;

    const records = Array.isArray(page.records) ? page.records : [];
    allRecords.push(...records);
    if (!page.has_more || records.length === 0) break;
    offset += records.length;
  }

  return {
    ...(firstPage || {}),
    ...(lastPage || {}),
    requestUrl: firstRequestUrl || lastPage?.requestUrl || '',
    records: allRecords,
    limit: PAGE_SIZE,
    offset: 0,
    has_more: false,
  };
}

// Transport pairing is a connection/identity check, not workspace hydration.
export async function verifyPairedTowerWorkspace(connection, workspaceId, ownerNpub, appNpub = FLIGHT_DECK_PG_APP_NPUB) {
  const path = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/descriptor`;
  if (!connection?.handle?.fetch) throw new Error('Paired Tower transport handle is unavailable.');
  const response = await connection.handle.fetch(`${connection.endpoint}${path}`, {
    headers: {
      Authorization: await createAuthHeaderForIntendedUrl(`${connection.endpoint}${path}`, 'GET'),
      'x-flightdeck-pg-app-npub': appNpub,
    },
    credentials: 'omit', redirect: 'error', signal: createFetchTimeoutSignal(DEFAULT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Paired Tower workspace check failed (${response.status}).`);
  const result = await response.json();
  if (result.identity?.tower_service_npub !== connection.serviceNpub
    || result.identity?.workspace_id !== workspaceId
    || result.identity?.workspace_owner_npub !== ownerNpub) {
    throw new Error('Paired Tower does not match this workspace identity.');
  }
}

export async function fetchTowerPgDriveShares(workspaceId, {baseUrl=_baseUrl,appNpub=FLIGHT_DECK_PG_APP_NPUB}={}) {
  const path=`/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/drive/shares`;
  const response=await signedTowerPgFetch(path,{method:'GET',baseUrl,appNpub});
  return json(response,{requestUrl:resolveTowerPgUrl(path,baseUrl),method:'GET',prefix:'Drive'});
}

// T1-selected typed feed routes. Reader authority comes from Tower's signer
// resolution; request bodies never accept an actor override.
export async function towerPgFeedRequest(workspaceId, suffix, { baseUrl = _baseUrl, appNpub = FLIGHT_DECK_PG_APP_NPUB, method = 'GET', body, cursor } = {}) {
  const path = towerPgWappPublishingPath(workspaceId, `/feed-subscriptions${suffix}`);
  const query = method === 'GET' ? `?${new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) })}` : '';
  const requestUrl = resolveTowerPgUrl(path + query, baseUrl);
  const response = await signedTowerPgFetch(requestUrl, { baseUrl, appNpub, method, body, useWorkspaceKey: false });
  return json(response, { requestUrl, method, prefix: 'Tower feed reader' });
}
