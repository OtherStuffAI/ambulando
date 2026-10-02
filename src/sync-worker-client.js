import { exportTowerTransports } from './tower-transport.js';
import { getExtensionPublicKey, signEventWithExtension } from './auth/nostr.js';
import { exportDecryptedKeys, getActiveSessionNpub } from './crypto/group-keys.js';
import { exportWorkspaceKeyForWorker } from './crypto/workspace-keys.js';

const REQUEST_TYPE = 'sync-worker:request';
const PROGRESS_TYPE = 'sync-worker:progress';
const RESPONSE_TYPE = 'sync-worker:response';
const AUTH_REQUEST_TYPE = 'sync-worker:auth-request';
const AUTH_RESPONSE_TYPE = 'sync-worker:auth-response';
const BOOTSTRAP_KEYS_TYPE = 'sync-worker:bootstrap-keys';
const SSE_STATUS_TYPE = 'sync-worker:sse-status';
const SSE_TOKEN_TYPE = 'sync-worker:sse-token';
const SSE_ACK_TYPE = 'sync-worker:sse-ack';

const MAX_RECOVERY_ATTEMPTS = 2;
const RECOVERY_DELAY_MS = 500;

let _sseStatusCallback = null;
let _workerDegradedCallback = null;

let workerInstance = null;
let detachNativeWorker = null;
let nextRequestId = 1;
const pendingRequests = new Map();
const requestQueue = [];
let drainingQueue = false;
let workerSessionGeneration = 0;

function supportsWorker() {
  return typeof Worker !== 'undefined';
}

function createWorkerInstance() {
  if (!supportsWorker()) return null;
  try {
    const worker = new Worker(new URL('./worker/sync-worker-runner.js', import.meta.url), { type: 'module' });
    const nativeTransport = globalThis.window?.fipsTransport;
    if (nativeTransport?.version >= 2 && nativeTransport.available !== false) {
      nativeTransport.attachWorker(worker);
      detachNativeWorker = () => nativeTransport.detachWorker?.(worker);
    }
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
    worker.addEventListener('messageerror', handleWorkerError);
    return worker;
  } catch {
    return null;
  }
}

function ensureWorkerInstance() {
  if (workerInstance) return workerInstance;
  workerInstance = createWorkerInstance();
  return workerInstance;
}

function resetWorkerInstance() {
  try { detachNativeWorker?.(); } catch { /* worker teardown must continue */ }
  detachNativeWorker = null;
  if (workerInstance) {
    try {
      workerInstance.removeEventListener('message', handleWorkerMessage);
      workerInstance.removeEventListener('error', handleWorkerError);
      workerInstance.removeEventListener('messageerror', handleWorkerError);
      workerInstance.terminate();
    } catch {
      // Ignore termination failures during cleanup.
    }
  }
  workerInstance = null;
}

function rejectPendingRequests(error) {
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const request of pending) {
    request.reject(error);
  }
}

async function resolveAuthBridgeRequest(message) {
  switch (message?.method) {
    case 'getPublicKey':
      return getExtensionPublicKey();
    case 'signEvent':
      return signEventWithExtension(message?.params?.event);
    default:
      throw new Error(`Unsupported sync worker auth method: ${message?.method || 'unknown'}`);
  }
}

function serializeWorkerError(error) {
  if (!error) return { name: 'Error', message: 'Sync worker failed' };
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || '',
  };
}

async function handleAuthBridgeRequest(message) {
  const worker = workerInstance;
  if (!worker) return;

  try {
    const value = await resolveAuthBridgeRequest(message);
    if (worker !== workerInstance) return;
    worker.postMessage({
      type: AUTH_RESPONSE_TYPE,
      authId: message.authId,
      ok: true,
      value,
    });
  } catch (error) {
    if (worker !== workerInstance) return;
    worker.postMessage({
      type: AUTH_RESPONSE_TYPE,
      authId: message.authId,
      ok: false,
      error: serializeWorkerError(error),
    });
  }
}

function handleWorkerMessage(event) {
  const message = event?.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === AUTH_REQUEST_TYPE) {
    void handleAuthBridgeRequest(message);
    return;
  }

  if (message.type === PROGRESS_TYPE) {
    const request = pendingRequests.get(message.id);
    if (request && typeof request.onProgress === 'function') {
      request.onProgress(message.update);
    }
    return;
  }

  if (message.type === SSE_STATUS_TYPE) {
    if (typeof _sseStatusCallback === 'function') {
      _sseStatusCallback(message);
    }
    return;
  }

  if (message.type !== RESPONSE_TYPE) return;

  const request = pendingRequests.get(message.id);
  if (!request) return;
  pendingRequests.delete(message.id);

  if (message.ok) {
    request.resolve(message.value);
    return;
  }

  request.reject(deserializeWorkerError(message.error));
}

function handleWorkerError(event) {
  const error = event?.error instanceof Error
    ? event.error
    : new Error(event?.message || 'Sync worker crashed');
  resetWorkerInstance();
  rejectPendingRequests(error);
}

function deserializeWorkerError(error) {
  if (!error) return new Error('Sync worker failed');
  if (error instanceof Error) return error;
  const message = typeof error.message === 'string' && error.message ? error.message : 'Sync worker failed';
  const reconstructed = new Error(message);
  if (typeof error.name === 'string') reconstructed.name = error.name;
  if (typeof error.stack === 'string') reconstructed.stack = error.stack;
  return reconstructed;
}

function syncKeysToWorker(worker) {
  if (!worker) return;
  // Transport selection must arrive even if optional key export fails.
  worker.postMessage({ type: 'sync-worker:tower-transports', towerTransports: exportTowerTransports() });
  try {
    worker.postMessage({
      type: BOOTSTRAP_KEYS_TYPE,
      sessionNpub: getActiveSessionNpub(),
      keys: exportDecryptedKeys(),
      wsKey: exportWorkspaceKeyForWorker(),
    });
  } catch {
    /* ignore — keys will be missing and records will quarantine */
  }
}

function notifyDegraded(reason) {
  if (typeof _workerDegradedCallback === 'function') {
    _workerDegradedCallback({ degraded: true, reason });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToWorker(worker, method, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject, onProgress });
    try {
      worker.postMessage({
        type: REQUEST_TYPE,
        id,
        method,
        payload,
      });
    } catch (error) {
      pendingRequests.delete(id);
      reject(error);
    }
  });
}

async function invokeWithWorker(method, payload, onProgress, generation) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
    if (generation !== workerSessionGeneration) throw new DOMException('Sync session ended', 'AbortError');
    const worker = ensureWorkerInstance();
    if (!worker) {
      const reason = supportsWorker()
        ? 'Sync worker could not be created'
        : 'Web Workers are not supported in this browser';
      notifyDegraded(reason);
      throw new Error(`Sync unavailable: ${reason}. Queued writes are preserved for later retry.`);
    }

    syncKeysToWorker(worker);

    try {
      return await sendToWorker(worker, method, payload, onProgress);
    } catch (error) {
      if (generation !== workerSessionGeneration) throw new DOMException('Sync session ended', 'AbortError');
      lastError = error;
      // Reset the dead worker so ensureWorkerInstance creates a fresh one
      resetWorkerInstance();
      if (attempt < MAX_RECOVERY_ATTEMPTS) {
        await delay(RECOVERY_DELAY_MS);
      }
    }
  }

  notifyDegraded(lastError?.message || 'Worker recovery failed');
  const surfaced = new Error(
    `Sync worker recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts: ${lastError?.message || 'unknown error'}. Queued writes are preserved for later retry.`,
  );
  surfaced.cause = lastError;
  throw surfaced;
}

function enqueue(method, payload, onProgress) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ method, payload, onProgress, resolve, reject, generation: workerSessionGeneration });
    if (!drainingQueue) {
      void drainQueue();
    }
  });
}

async function drainQueue() {
  drainingQueue = true;
  try {
    while (requestQueue.length > 0) {
      const request = requestQueue.shift();
      try {
        const value = await invokeWithWorker(request.method, request.payload, request.onProgress, request.generation);
        request.resolve(value);
      } catch (error) {
        request.reject(error);
      }
    }
  } finally {
    drainingQueue = false;
  }
}

export function primeSyncWorker() {
  return Boolean(ensureWorkerInstance());
}

export function shutdownSyncWorker() {
  workerSessionGeneration += 1;
  stopWorkerFlushTimer();
  resetWorkerInstance();
  const error = new DOMException('Sync session ended', 'AbortError');
  rejectPendingRequests(error);
  for (const request of requestQueue.splice(0)) request.reject(error);
  _sseStatusCallback = null;
}

/**
 * Start an independent outbox flush timer in the worker.
 * The worker will flush pending writes every 5s on its own,
 * decoupling UI responsiveness from sync latency.
 */
export function startWorkerFlushTimer(ownerNpub, backendUrl, workspaceDbKey, options = {}) {
  const worker = ensureWorkerInstance();
  if (!worker) return;
  try {
    syncKeysToWorker(worker);
    worker.postMessage({
      type: 'sync-worker:start-flush-timer',
      ownerNpub,
      backendUrl,
      workspaceDbKey,
      options,
    });
  } catch { /* ignore */ }
}

export function stopWorkerFlushTimer() {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({ type: 'sync-worker:stop-flush-timer' });
  } catch { /* ignore */ }
}

export async function runSync(ownerNpub, viewerNpub = ownerNpub, onProgress, options = {}) {
  return enqueue('runSync', { ownerNpub, viewerNpub, options }, onProgress);
}

/**
 * Flush pending writes to Tower without pulling or running a heartbeat.
 * Returns { pushed } — much faster than runSync for write-then-continue flows.
 */
export async function flushOnly(ownerNpub, onProgress, options = {}) {
  return enqueue('flushOnly', { ownerNpub, options }, onProgress);
}

export async function pullRecordsForFamilies(ownerNpub, viewerNpub = ownerNpub, families = [], options = {}, onProgress) {
  return enqueue('pullRecordsForFamilies', { ownerNpub, viewerNpub, families, options }, onProgress);
}

export async function pruneOnLogin(viewerNpub, ownerNpub, options = {}) {
  return enqueue('pruneOnLogin', { viewerNpub, ownerNpub, options });
}

export async function checkStaleness(ownerNpub, options = {}) {
  return enqueue('checkStaleness', { ownerNpub, options });
}

// --- SSE control ---

export function setSSEStatusCallback(callback) {
  _sseStatusCallback = callback;
}

export function setWorkerDegradedCallback(callback) {
  _workerDegradedCallback = callback;
}

export function connectSSE(ownerNpub, viewerNpub, backendUrl, workspaceDbKey, options = {}) {
  const worker = ensureWorkerInstance();
  if (!worker) return;
  syncKeysToWorker(worker);
  try {
    worker.postMessage({
      type: 'sync-worker:sse-connect',
      ownerNpub,
      viewerNpub,
      backendUrl,
      workspaceDbKey,
      options,
    });
  } catch { /* ignore */ }
}

export function provideSSEToken(requestId, connectionKey, token) {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({
      type: SSE_TOKEN_TYPE,
      requestId,
      connectionKey,
      token,
    });
  } catch { /* ignore */ }
}

export function rejectSSEToken(requestId, connectionKey, errorCode = 'signing-failed') {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({
      type: SSE_TOKEN_TYPE,
      requestId,
      connectionKey,
      ok: false,
      errorCode: String(errorCode || 'signing-failed'),
    });
  } catch { /* ignore */ }
}

export function acknowledgeSSEBatch(batch = {}) {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({
      type: SSE_ACK_TYPE,
      batchId: batch.batchId,
      connectionKey: batch.connectionKey,
      connectionGeneration: batch.connectionGeneration,
      requestedCursor: batch.requestedCursor || null,
      committedAt: batch.committedAt || new Date().toISOString(),
    });
  } catch { /* ignore */ }
}

export function disconnectSSE(options = {}) {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({ type: 'sync-worker:sse-disconnect', options });
  } catch { /* ignore */ }
}

export function flushNow() {
  if (!workerInstance) return;
  try {
    workerInstance.postMessage({ type: 'sync-worker:flush-now' });
  } catch { /* ignore */ }
}
