import { acceptNativeTowerPort } from '../tower-native-worker-transport.js';
import { createTowerEventSource } from '../tower-event-source.js';
import { importTowerTransports } from '../tower-transport.js';
import {
  runSync,
  flushPendingWrites,
  pullRecordsForFamilies,
  pruneOnLogin,
  checkStaleness,
} from './sync-worker.js';
import { getPendingWrites, getSyncState, openWorkspaceDb, setSyncState } from '../db.js';
import { setBaseUrl } from '../api.js';
import { setExtensionSignerBridge } from '../auth/nostr.js';
import { importDecryptedKeys, setActiveSessionNpub } from '../crypto/group-keys.js';
import { importWorkspaceKeyFromMain } from '../crypto/workspace-keys.js';
import {
  buildSSESigningUrl,
  createSSETokenRequestTracker,
} from '../sse-stream-protocol.js';

const REQUEST_TYPE = 'sync-worker:request';
const PROGRESS_TYPE = 'sync-worker:progress';
const RESPONSE_TYPE = 'sync-worker:response';
const AUTH_REQUEST_TYPE = 'sync-worker:auth-request';
const AUTH_RESPONSE_TYPE = 'sync-worker:auth-response';
const BOOTSTRAP_KEYS_TYPE = 'sync-worker:bootstrap-keys';
const START_FLUSH_TIMER_TYPE = 'sync-worker:start-flush-timer';
const STOP_FLUSH_TIMER_TYPE = 'sync-worker:stop-flush-timer';
const FLUSH_RESULT_TYPE = 'sync-worker:flush-result';

// SSE advisory transport — worker ↔ main-thread message types.
// SSE events notify the worker what to refresh; actual data comes from pull requests.
const SSE_CONNECT_TYPE = 'sync-worker:sse-connect';
const SSE_DISCONNECT_TYPE = 'sync-worker:sse-disconnect';
const SSE_STATUS_TYPE = 'sync-worker:sse-status';
const SSE_TOKEN_TYPE = 'sync-worker:sse-token';
const SSE_ACK_TYPE = 'sync-worker:sse-ack';
const FLUSH_NOW_TYPE = 'sync-worker:flush-now';

let nextAuthRequestId = 1;
const pendingAuthRequests = new Map();

// --- Independent outbox flush timer ---
let flushTimerId = null;
let flushOwnerNpub = null;
let flushBackendUrl = null;
let flushWorkspaceDbKey = null;
let flushCheckoutPolicyConfig = null;
let flushInProgress = false; // guard against concurrent flushes
const FLUSH_INTERVAL_MS = 2000;

// --- SSE advisory transport state ---
let eventSource = null;
let sseOwnerNpub = null;
let sseViewerNpub = null;
let sseBackendUrl = null;
let sseWorkspaceDbKey = null;
let sseCheckoutPolicyConfig = null;
let ssePgWorkspaceId = null;
let sseConnectionKey = null;
let ssePgMode = false;
let sseConnectionState = 'disconnected';
let sseLastEventId = null;
let sseLastPgCursor = null;
let sseLastReceivedPgCursor = null;
let sseConnectionGeneration = 0;
let sseContextGeneration = 0;
let sseNextBatchId = 1;
const ssePendingBatches = new Map();
let sseAckWritePromise = Promise.resolve();
let sseReconnectTimer = null;
let sseReconnectAttempts = 0;
const SSE_DEBOUNCE_MS = 300;
const SSE_ECHO_TTL_MS = 30_000;
const SSE_FALLBACK_PROBE_MS = 60_000;
const SSE_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
let sseDebounceTimer = null;
let sseFallbackProbeTimer = null;
let sseTokenRequestTimer = null;
let sseLastFailureReason = null;
const sseTokenRequests = createSSETokenRequestTracker();
const sseStaleFamilies = new Set();
const sseEchoSet = new Map(); // key: "recordId:version" → expiry timestamp

async function registerEchoEntries() {
  if (!eventSource) return; // only needed when SSE is active
  try {
    const pending = await getPendingWrites();
    for (const pw of pending) {
      if (pw.envelope?.record_id && pw.envelope?.version) {
        markOwnWrite(pw.envelope.record_id, pw.envelope.version);
      }
    }
  } catch { /* non-fatal */ }
}

async function tickFlush() {
  if (!flushOwnerNpub || !flushBackendUrl) return;
  if (flushInProgress) return; // skip if a flush or runSync is already running
  flushInProgress = true;
  try {
    if (flushBackendUrl) setBaseUrl(flushBackendUrl);
    await registerEchoEntries();
    const result = await flushPendingWrites(flushOwnerNpub, null, {
      workspaceDbKey: flushWorkspaceDbKey || flushOwnerNpub,
      checkoutPolicyConfig: flushCheckoutPolicyConfig,
    });
    if (result.pushed > 0) {
      self.postMessage({ type: FLUSH_RESULT_TYPE, pushed: result.pushed });
    }
    cleanEchoSet();
  } catch {
    // Silent — next tick will retry
  } finally {
    flushInProgress = false;
  }
}

function startFlushTimer(ownerNpub, backendUrl, workspaceDbKey, options = {}) {
  stopFlushTimer();
  flushOwnerNpub = ownerNpub;
  flushBackendUrl = backendUrl;
  flushWorkspaceDbKey = workspaceDbKey;
  flushCheckoutPolicyConfig = options.checkoutPolicyConfig || null;
  flushTimerId = setInterval(tickFlush, FLUSH_INTERVAL_MS);
}

function stopFlushTimer() {
  if (flushTimerId != null) {
    clearInterval(flushTimerId);
    flushTimerId = null;
  }
  flushOwnerNpub = null;
  flushBackendUrl = null;
  flushWorkspaceDbKey = null;
  flushCheckoutPolicyConfig = null;
}

// --- Echo suppression ---

function markOwnWrite(recordId, version) {
  sseEchoSet.set(`${recordId}:${version}`, Date.now() + SSE_ECHO_TTL_MS);
}

function isOwnEcho(recordId, version) {
  const key = `${recordId}:${version}`;
  const expiry = sseEchoSet.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sseEchoSet.delete(key);
    return false;
  }
  sseEchoSet.delete(key);
  return true;
}

function cleanEchoSet() {
  const now = Date.now();
  for (const [key, expiry] of sseEchoSet) {
    if (now > expiry) sseEchoSet.delete(key);
  }
}

// --- SSE client ---

function buildSSEConnectionKey(ownerNpub, viewerNpub, backendUrl, workspaceDbKey, checkoutPolicyConfig = null, pgMode = false, workspaceId = null) {
  return JSON.stringify({
    ownerNpub,
    viewerNpub,
    backendUrl,
    workspaceDbKey: workspaceDbKey || ownerNpub,
    workspaceId: workspaceId || null,
    pgMode: Boolean(pgMode),
    checkoutPolicyConfig: checkoutPolicyConfig || null,
  });
}

function closeSSE({ resetContext = false, preserveWork = false } = {}) {
  sseTokenRequests.clear();
  if (sseTokenRequestTimer) {
    clearTimeout(sseTokenRequestTimer);
    sseTokenRequestTimer = null;
  }
  if (!preserveWork && sseDebounceTimer) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sseFallbackProbeTimer) {
    clearTimeout(sseFallbackProbeTimer);
    sseFallbackProbeTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (!preserveWork) sseStaleFamilies.clear();
  if (resetContext) {
    sseOwnerNpub = null;
    sseViewerNpub = null;
    sseBackendUrl = null;
    sseWorkspaceDbKey = null;
    sseCheckoutPolicyConfig = null;
    ssePgWorkspaceId = null;
    ssePgMode = false;
    sseConnectionKey = null;
    sseConnectionState = 'disconnected';
    sseLastEventId = null;
    sseLastPgCursor = null;
    sseLastReceivedPgCursor = null;
    ssePendingBatches.clear();
    sseReconnectAttempts = 0;
    sseLastFailureReason = null;
  }
}

function pgSSECursorStateKey() {
  if (!ssePgMode || !ssePgWorkspaceId || !sseBackendUrl || !sseViewerNpub) return null;
  let backendOrigin = '';
  try { backendOrigin = new URL(sseBackendUrl).origin; } catch { return null; }
  return [
    'sse_pg_ack_cursor:v1',
    encodeURIComponent(backendOrigin),
    encodeURIComponent(ssePgWorkspaceId),
    encodeURIComponent(sseOwnerNpub || ''),
    encodeURIComponent(sseViewerNpub),
  ].join(':');
}

function normalizedBackendOrigin(value) {
  try { return new URL(value).origin; } catch { return ''; }
}

function compatibleWorkspaceCursorFallback(fallback) {
  if (!fallback?.cursor || !ssePgMode) return null;
  const expected = {
    backendOrigin: normalizedBackendOrigin(sseBackendUrl),
    workspaceId: String(ssePgWorkspaceId || ''),
    ownerNpub: String(sseOwnerNpub || ''),
    viewerNpub: String(sseViewerNpub || ''),
    workspaceDbKey: String(sseWorkspaceDbKey || ''),
  };
  const actual = {
    backendOrigin: normalizedBackendOrigin(fallback.backendOrigin),
    workspaceId: String(fallback.workspaceId || ''),
    ownerNpub: String(fallback.ownerNpub || ''),
    viewerNpub: String(fallback.viewerNpub || ''),
    workspaceDbKey: String(fallback.workspaceDbKey || ''),
  };
  return Object.keys(expected).every((key) => expected[key] && actual[key] === expected[key])
    ? String(fallback.cursor)
    : null;
}

async function restoreCommittedPgCursor(contextGeneration, workspaceCursorFallback = null) {
  const key = pgSSECursorStateKey();
  if (!key) return;
  try {
    const cursor = await getSyncState(key);
    if (contextGeneration !== sseContextGeneration) return;
    const restored = cursor ? String(cursor) : compatibleWorkspaceCursorFallback(workspaceCursorFallback);
    if (restored) sseLastPgCursor = restored;
  } catch {
    const fallback = compatibleWorkspaceCursorFallback(workspaceCursorFallback);
    if (contextGeneration === sseContextGeneration && fallback) sseLastPgCursor = fallback;
  }
}

function requestSSEToken(extra = {}) {
  if (!sseConnectionKey || !sseBackendUrl) return;
  const signingUrl = buildSSESigningUrl({
    backendUrl: sseBackendUrl,
    pgMode: ssePgMode,
    workspaceId: ssePgWorkspaceId,
    ownerNpub: sseOwnerNpub,
    cursor: sseLastPgCursor,
    lastEventId: sseLastEventId,
  });
  const request = sseTokenRequests.request(sseConnectionKey, signingUrl);
  if (sseTokenRequestTimer) clearTimeout(sseTokenRequestTimer);
  sseTokenRequestTimer = setTimeout(() => {
    sseTokenRequestTimer = null;
    const failed = sseTokenRequests.fail(request);
    if (!failed || failed.connectionKey !== sseConnectionKey) return;
    sseLastFailureReason = {
      reason: 'token-request-timeout',
      at: new Date().toISOString(),
    };
    postSSEStatus('token-failed', {
      phase: 'signing-timeout',
      reason: 'token-request-timeout',
      requestId: failed.requestId,
    });
    scheduleReconnect({ reason: 'token-request-timeout' });
  }, SSE_TOKEN_REQUEST_TIMEOUT_MS);
  sseConnectionState = 'token-needed';
  postSSEStatus('token-needed', {
    ...extra,
    requestId: request.requestId,
    signingUrl: request.signingUrl,
  });
}

function openSSEWithToken(message) {
  if (message?.ok === false || message?.error) {
    const failed = sseTokenRequests.fail(message);
    if (!failed || failed.connectionKey !== sseConnectionKey) return;
    if (sseTokenRequestTimer) {
      clearTimeout(sseTokenRequestTimer);
      sseTokenRequestTimer = null;
    }
    sseLastFailureReason = {
      reason: 'token-request-failed',
      code: String(message?.errorCode || 'signing-failed'),
      at: new Date().toISOString(),
    };
    postSSEStatus('token-failed', {
      phase: 'signing-failed',
      reason: 'token-request-failed',
      requestId: failed.requestId,
    });
    scheduleReconnect({ reason: 'token-request-failed' });
    return;
  }
  const accepted = sseTokenRequests.accept(message);
  if (!accepted || accepted.connectionKey !== sseConnectionKey) return;
  if (sseTokenRequestTimer) {
    clearTimeout(sseTokenRequestTimer);
    sseTokenRequestTimer = null;
  }

  const source = createTowerEventSource(accepted.eventSourceUrl);
  sseConnectionGeneration += 1;
  source.sseConnectionGeneration = sseConnectionGeneration;
  eventSource = source;

  source.addEventListener('record-changed', (event) => {
    if (source !== eventSource) return;
    handleRecordChanged(event);
  });
  source.addEventListener('flightdeck_pg.event', (event) => {
    if (source !== eventSource) return;
    handleFlightDeckPgEvent(event);
  });
  source.addEventListener('group-changed', (event) => {
    if (source !== eventSource) return;
    handleGroupChanged(event);
  });
  source.addEventListener('catch-up-required', (event) => {
    if (source !== eventSource) return;
    handleCatchUpRequired(event);
  });
  source.addEventListener('connected', (event) => {
    if (source !== eventSource) return;
    handleConnected(event);
  });
  source.addEventListener('heartbeat', () => {
    if (source !== eventSource) return;
  });

  source.onerror = () => {
    if (source !== eventSource) return;
    sseLastFailureReason = {
      reason: 'eventsource-error',
      readyState: Number(source.readyState),
      at: new Date().toISOString(),
    };
    closeSSE({ preserveWork: true });
    scheduleReconnect({ reason: 'eventsource-error' });
  };

  sseConnectionState = 'connecting';
  postSSEStatus('connecting', {
    phase: 'signed-stream-open',
    reason: 'token-received',
  });
}

async function connectSSE(ownerNpub, viewerNpub, backendUrl, workspaceDbKey, options = {}) {
  const connectionKey = buildSSEConnectionKey(
    ownerNpub,
    viewerNpub,
    backendUrl,
    workspaceDbKey,
    options.checkoutPolicyConfig || null,
    Boolean(options?.pgMode),
    options?.workspaceId || null,
  );
  const force = Boolean(options?.force);
  const reason = String(options?.reason || 'connect');
  const hasActiveLifecycle = Boolean(eventSource || sseReconnectTimer)
    || ['connecting', 'connected', 'reconnecting', 'token-needed'].includes(sseConnectionState);

  if (!force && connectionKey === sseConnectionKey && hasActiveLifecycle) {
    postSSEStatus(sseConnectionState, {
      connectionKey,
      phase: 'connect-skipped',
      reason: 'duplicate-connect',
    });
    return;
  }

  const phase = !sseConnectionKey
    ? 'initial-connect'
    : connectionKey === sseConnectionKey
      ? 'intentional-reconnect'
      : 'context-switch';

  const contextChanged = Boolean(sseConnectionKey && connectionKey !== sseConnectionKey);
  closeSSE({ preserveWork: !contextChanged });

  if (contextChanged) {
    sseLastEventId = null;
    sseLastPgCursor = null;
  }

  sseOwnerNpub = ownerNpub;
  sseViewerNpub = viewerNpub;
  sseBackendUrl = backendUrl;
  sseWorkspaceDbKey = workspaceDbKey;
  sseCheckoutPolicyConfig = options.checkoutPolicyConfig || null;
  ssePgMode = Boolean(options?.pgMode);
  ssePgWorkspaceId = String(options?.workspaceId || '').trim() || null;
  sseConnectionKey = connectionKey;
  sseContextGeneration += 1;
  const contextGeneration = sseContextGeneration;

  if (contextChanged) ssePendingBatches.clear();
  if (sseWorkspaceDbKey) {
    try { openWorkspaceDb(sseWorkspaceDbKey); } catch { /* cursor restore reports bounded fallback */ }
  }
  if (ssePgMode && !sseLastPgCursor) {
    await restoreCommittedPgCursor(contextGeneration, options?.workspaceCursorFallback || null);
  }
  if (contextGeneration !== sseContextGeneration || connectionKey !== sseConnectionKey) return;

  requestSSEToken({
    connectionKey,
    phase,
    reason,
    forced: force,
  });
}

function disconnectSSE() {
  closeSSE({ resetContext: true });
}

function scheduleReconnect({ reason = 'eventsource-error' } = {}) {
  if (sseReconnectTimer) clearTimeout(sseReconnectTimer);

  const attempt = sseReconnectAttempts + 1;
  const delay = sseReconnectAttempts === 0 ? 0 : Math.min(1000 * Math.pow(2, sseReconnectAttempts - 1), 60_000);
  sseReconnectAttempts = attempt;

  if (attempt > 5) {
    sseConnectionState = 'fallback-polling';
    postSSEStatus('fallback-polling', {
      phase: 'fallback-entered',
      reason: 'reconnect-exhausted',
      failure: sseLastFailureReason,
      attempt,
      delayMs: delay,
      probeDelayMs: SSE_FALLBACK_PROBE_MS,
    });
    sseFallbackProbeTimer = setTimeout(() => {
      sseFallbackProbeTimer = null;
      if (sseConnectionState !== 'fallback-polling') return;
      sseReconnectAttempts = 0;
      requestSSEToken({
        phase: 'fallback-probe',
        reason: 'fallback-probe',
        failure: sseLastFailureReason,
      });
    }, SSE_FALLBACK_PROBE_MS);
    return;
  }

  sseConnectionState = 'reconnecting';
  postSSEStatus('reconnecting', {
    phase: 'backoff',
    reason,
    attempt,
    delayMs: delay,
  });
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    requestSSEToken({
      phase: 'refresh-token',
      reason: 'reconnect-attempt',
      attempt,
    });
  }, delay);
}

function postSSEStatus(status, extra = {}) {
  self.postMessage({
    type: SSE_STATUS_TYPE,
    status,
    connectionKey: extra.connectionKey || sseConnectionKey,
    ...extra,
  });
}

function handleConnected(event) {
  sseReconnectAttempts = 0;
  sseConnectionState = 'connected';
  let data = null;
  try { data = event?.data ? JSON.parse(event.data) : null; } catch { data = null; }
  if (ssePgMode && data?.cursor) sseLastReceivedPgCursor = String(data.cursor);
  else if (event?.lastEventId) updateSSECursor('legacy', event.lastEventId);
  postSSEStatus('connected', {
    phase: 'stream-open',
    reason: 'eventsource-open',
    connectionGeneration: eventSource?.sseConnectionGeneration || sseConnectionGeneration,
    requestedCursor: sseLastPgCursor,
    receivedCursor: sseLastReceivedPgCursor,
    acknowledgedCursor: sseLastPgCursor,
  });
}

function updateSSECursor(kind, value) {
  if (value == null) return;
  const normalized = String(value);
  const changed = kind === 'pg'
    ? normalized !== sseLastPgCursor
    : normalized !== sseLastEventId;
  if (!changed) return;
  if (kind === 'pg') sseLastPgCursor = normalized;
  else sseLastEventId = normalized;
  if (sseTokenRequests.getPending()) {
    requestSSEToken({
      phase: 'cursor-changed',
      reason: 'cursor-changed-before-token',
    });
  }
}

function handleRecordChanged(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (event.lastEventId) updateSSECursor('legacy', event.lastEventId);

  // Echo suppression
  if (isOwnEcho(data.record_id, data.version)) return;

  const familyHash = String(data.family_hash || data.record_family_hash || '').trim();
  if (!familyHash) return;

  // Collect stale family and debounce
  sseStaleFamilies.add(familyHash);
  if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
  sseDebounceTimer = setTimeout(flushSSEStaleFamilies, SSE_DEBOUNCE_MS);
}

function handleFlightDeckPgEvent(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data?.cursor) sseLastReceivedPgCursor = String(data.cursor);
  else if (event.lastEventId) updateSSECursor('legacy', event.lastEventId);

  data.browser_received_at = new Date().toISOString();
  sseStaleFamilies.add({
    family: 'flightdeck_pg',
    event: data,
    cursor: data?.cursor ? String(data.cursor) : null,
    connectionGeneration: eventSource?.sseConnectionGeneration || sseConnectionGeneration,
  });
  if (sseDebounceTimer) clearTimeout(sseDebounceTimer);
  sseDebounceTimer = setTimeout(flushSSEStaleFamilies, SSE_DEBOUNCE_MS);
}

async function flushSSEStaleFamilies() {
  sseDebounceTimer = null;
  const staleEntries = [...sseStaleFamilies];
  sseStaleFamilies.clear();
  const pgEvents = staleEntries
    .map((entry) => entry && typeof entry === 'object' ? entry.event : null)
    .filter(Boolean);
  const pgEntries = staleEntries.filter((entry) => entry && typeof entry === 'object' && entry.event);
  const families = [...new Set(staleEntries
    .map((entry) => entry && typeof entry === 'object' ? entry.family : entry)
    .filter(Boolean))];
  if (!families.length || !sseOwnerNpub || !sseBackendUrl) return;

  try {
    if (!ssePgMode) {
      if (sseBackendUrl) setBaseUrl(sseBackendUrl);
      await pullRecordsForFamilies(
        sseOwnerNpub,
        sseViewerNpub || sseOwnerNpub,
        families,
        {
          workspaceDbKey: sseWorkspaceDbKey || sseOwnerNpub,
          checkoutPolicyConfig: sseCheckoutPolicyConfig,
        },
      );
    }
    const lastPgEntry = pgEntries.at(-1) || null;
    const cursor = lastPgEntry?.cursor || null;
    let batch = pgEvents.length > 0
      ? [...ssePendingBatches.values()].find((entry) => (
        entry.connectionKey === sseConnectionKey && entry.cursor && entry.cursor === cursor
      ))
      : null;
    if (!batch && pgEvents.length > 0) {
      const batchId = `sse-batch-${sseNextBatchId++}`;
      batch = {
        batchId,
        connectionKey: sseConnectionKey,
        connectionGeneration: lastPgEntry?.connectionGeneration || sseConnectionGeneration,
        cursor,
        receivedAt: pgEvents[0]?.browser_received_at || null,
        committed: false,
      };
      ssePendingBatches.set(batchId, batch);
    }
    postSSEStatus('pull-complete', {
      families,
      pgEvents,
      ...batch,
      requestedCursor: sseLastPgCursor,
      receivedCursor: batch?.cursor || sseLastReceivedPgCursor,
      acknowledgedCursor: sseLastPgCursor,
    });
  } catch (error) {
    for (const entry of staleEntries) sseStaleFamilies.add(entry);
    if (!sseDebounceTimer) {
      sseDebounceTimer = setTimeout(flushSSEStaleFamilies, Math.min(2_000, SSE_FALLBACK_PROBE_MS));
    }
  }
}

async function persistAcknowledgedSSEBatches() {
  const committed = [];
  for (const batch of ssePendingBatches.values()) {
    if (!batch.committed) break;
    committed.push(batch);
  }
  if (!committed.length) return;
  const lastCursorBatch = [...committed].reverse().find((batch) => batch.cursor) || null;
  const key = pgSSECursorStateKey();
  const connectionKey = sseConnectionKey;
  const contextGeneration = sseContextGeneration;
  try {
    if (key && lastCursorBatch) await setSyncState(key, String(lastCursorBatch.cursor));
  } catch {
    sseLastFailureReason = {
      reason: 'cursor-persist-failed',
      at: new Date().toISOString(),
    };
    postSSEStatus('cursor-ack-failed', {
      phase: 'cursor-persist-failed',
      reason: 'cursor-persist-failed',
      batchId: committed[0]?.batchId || null,
      connectionGeneration: committed[0]?.connectionGeneration || null,
    });
    closeSSE({ preserveWork: true });
    scheduleReconnect({ reason: 'cursor-persist-failed' });
    return;
  }
  if (connectionKey !== sseConnectionKey || contextGeneration !== sseContextGeneration) return;
  if (lastCursorBatch) sseLastPgCursor = String(lastCursorBatch.cursor);
  for (const batch of committed) ssePendingBatches.delete(batch.batchId);
  postSSEStatus('cursor-acknowledged', {
    phase: 'materialisation-committed',
    batchId: committed.at(-1)?.batchId || null,
    batchIds: committed.map((batch) => batch.batchId),
    connectionGeneration: committed.at(-1)?.connectionGeneration || null,
    requestedCursor: committed[0]?.requestedCursor || null,
    receivedCursor: lastCursorBatch?.cursor || null,
    acknowledgedCursor: sseLastPgCursor,
    receivedAt: committed[0]?.receivedAt || null,
    committedAt: committed.at(-1)?.committedAt || new Date().toISOString(),
  });
  if (sseTokenRequests.getPending()) {
    requestSSEToken({
      phase: 'cursor-changed',
      reason: 'cursor-acknowledged-before-token',
    });
  }
}

async function acknowledgeSSEBatch(message) {
  const batchId = String(message?.batchId || '').trim();
  const batch = ssePendingBatches.get(batchId);
  if (
    !batch
    || batch.connectionKey !== sseConnectionKey
    || message?.connectionKey !== batch.connectionKey
    || Number(message?.connectionGeneration) !== Number(batch.connectionGeneration)
  ) return;
  if (batch.committed) return;
  batch.committed = true;
  batch.requestedCursor = message?.requestedCursor || null;
  batch.committedAt = message?.committedAt || new Date().toISOString();
  await persistAcknowledgedSSEBatches();
}

function handleGroupChanged(event) {
  // Notify main thread to refresh groups
  postSSEStatus('group-changed');
}

function handleCatchUpRequired() {
  // Cursor evicted from ring buffer — main thread should do a full sync
  postSSEStatus('catch-up-required');
}

// --- Flush now (immediate outbox push) ---

async function flushNow() {
  if (!flushOwnerNpub || !flushBackendUrl) return;
  if (flushInProgress) return; // skip if a flush or runSync is already running
  flushInProgress = true;
  try {
    if (flushBackendUrl) setBaseUrl(flushBackendUrl);
    await registerEchoEntries();
    const result = await flushPendingWrites(flushOwnerNpub, null, {
      workspaceDbKey: flushWorkspaceDbKey || flushOwnerNpub,
      checkoutPolicyConfig: flushCheckoutPolicyConfig,
    });
    if (result.pushed > 0) {
      self.postMessage({ type: FLUSH_RESULT_TYPE, pushed: result.pushed });
    }
    cleanEchoSet();
  } catch {
    // Silent
  } finally {
    flushInProgress = false;
  }
}

function serializeError(error) {
  if (!error) {
    return { name: 'Error', message: 'Sync worker failed' };
  }
  return {
    name: error.name || 'Error',
    code: error.code || null,
    message: error.message || String(error),
    stack: error.stack || '',
  };
}

function respond(id, ok, value) {
  self.postMessage({
    type: RESPONSE_TYPE,
    id,
    ok,
    ...(ok ? { value } : { error: serializeError(value) }),
  });
}

function requestExtensionAuth(method, params = {}) {
  return new Promise((resolve, reject) => {
    const authId = nextAuthRequestId++;
    pendingAuthRequests.set(authId, { resolve, reject });
    self.postMessage({
      type: AUTH_REQUEST_TYPE,
      authId,
      method,
      params,
    });
  });
}

function deserializeWorkerError(error) {
  const reconstructed = new Error(error?.message || 'Sync worker signing failed');
  if (typeof error?.name === 'string') reconstructed.name = error.name;
  if (typeof error?.code === 'string') reconstructed.code = error.code;
  return reconstructed;
}

function handleAuthResponse(message) {
  const request = pendingAuthRequests.get(message?.authId);
  if (!request) return;
  pendingAuthRequests.delete(message.authId);

  if (message.ok) {
    request.resolve(message.value);
    return;
  }

  request.reject(deserializeWorkerError(message.error));
}

setExtensionSignerBridge({
  getPublicKey: () => requestExtensionAuth('getPublicKey'),
  signEvent: (event) => requestExtensionAuth('signEvent', { event }),
});

async function handleRequest(message) {
  const { id, method, payload } = message;
  const backendUrl = String(payload?.options?.backendUrl || '').trim();
  if (backendUrl) {
    setBaseUrl(backendUrl);
  }
  const onProgress = (update) => {
    self.postMessage({
      type: PROGRESS_TYPE,
      id,
      update,
    });
  };

  switch (method) {
    case 'runSync':
      // Set flushInProgress so tickFlush/flushNow skip while runSync
      // (which calls flushPendingWrites internally) is running.
      flushInProgress = true;
      try {
        return await runSync(
          payload.ownerNpub,
          payload.viewerNpub,
          onProgress,
          payload.options || {},
        );
      } finally {
        flushInProgress = false;
      }
    case 'pullRecordsForFamilies':
      return pullRecordsForFamilies(
        payload.ownerNpub,
        payload.viewerNpub,
        payload.families || [],
        payload.options || {},
        onProgress,
      );
    case 'pruneOnLogin':
      return pruneOnLogin(
        payload.viewerNpub,
        payload.ownerNpub,
        payload.options || {},
      );
    case 'flushOnly':
      flushInProgress = true;
      try {
        return await flushPendingWrites(
          payload.ownerNpub,
          onProgress,
          payload.options || {},
        );
      } finally {
        flushInProgress = false;
      }
    case 'checkStaleness':
      return checkStaleness(
        payload.ownerNpub,
        payload.options || {},
      );
    default:
      throw new Error(`Unsupported sync worker method: ${method}`);
  }
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (acceptNativeTowerPort(message)) return;
  if (message.type === 'sync-worker:tower-transports') {
    importTowerTransports(message.towerTransports);
    return;
  }
  if (message.type === AUTH_RESPONSE_TYPE) {
    handleAuthResponse(message);
    return;
  }
  if (message.type === BOOTSTRAP_KEYS_TYPE) {
    if (Array.isArray(message.towerTransports)) importTowerTransports(message.towerTransports);
    if (message.sessionNpub) setActiveSessionNpub(message.sessionNpub);
    importDecryptedKeys(message.keys || []);
    importWorkspaceKeyFromMain(message.wsKey);
    return;
  }
  if (message.type === START_FLUSH_TIMER_TYPE) {
    startFlushTimer(
      message.ownerNpub,
      message.backendUrl,
      message.workspaceDbKey,
      message.options || {},
    );
    return;
  }
  if (message.type === STOP_FLUSH_TIMER_TYPE) {
    stopFlushTimer();
    return;
  }
  if (message.type === SSE_CONNECT_TYPE) {
    connectSSE(
      message.ownerNpub,
      message.viewerNpub,
      message.backendUrl,
      message.workspaceDbKey,
      message.options || {},
    );
    return;
  }
  if (message.type === SSE_TOKEN_TYPE) {
    openSSEWithToken(message);
    return;
  }
  if (message.type === SSE_ACK_TYPE) {
    sseAckWritePromise = sseAckWritePromise.then(() => acknowledgeSSEBatch(message));
    await sseAckWritePromise;
    return;
  }
  if (message.type === SSE_DISCONNECT_TYPE) {
    const previousKey = sseConnectionKey;
    disconnectSSE();
    postSSEStatus('disconnected', {
      connectionKey: previousKey,
      phase: 'stream-closed',
      reason: message.options?.reason || 'client-disconnect',
    });
    return;
  }
  if (message.type === FLUSH_NOW_TYPE) {
    void flushNow();
    return;
  }
  if (message.type !== REQUEST_TYPE) return;

  try {
    const value = await handleRequest(message);
    respond(message.id, true, value);
  } catch (error) {
    respond(message.id, false, error);
  }
});
