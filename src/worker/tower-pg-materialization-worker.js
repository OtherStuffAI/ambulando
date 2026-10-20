import { applyThreadPinOperation } from '../thread-pin-store.js';
import { openWorkspaceDb } from '../db.js';
import { hydrateTowerPgSyncBundle } from '../pg-read-hydrator.js';

const REQUEST_TYPE = 'tower-pg-materializer:request';
const RESPONSE_TYPE = 'tower-pg-materializer:response';
const FOREGROUND_TYPE = 'tower-pg-materializer:foreground';
const BACKGROUND_BATCH_SIZE = 16;
const BACKGROUND_BATCH_DELAY_MS = 6;

let boundWorkspaceKey = null;
let materializationQueue = Promise.resolve();
let foregroundQuietUntil = 0;

async function waitForForegroundIdle() {
  const startedAt = performance.now();
  while (Date.now() < foregroundQuietUntil) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, foregroundQuietUntil - Date.now())));
  }
  return performance.now() - startedAt;
}

function serializeError(error, message) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error || 'Tower PG materialisation failed'),
    stack: error?.stack || '',
    materializationContext: {
      operation: message?.bundle?.reset_authority ? 'authority-reset'
        : message?.bundle?.reconcile_commands ? 'command-reconciliation'
        : message?.bundle?.rebuild_summaries ? 'summary-rebuild' : 'bundle-apply',
      protocolVersion: message?.bundle?.protocol_version || null,
      mode: message?.bundle?.mode || null,
      changeCount: message?.bundle?.changes?.length || 0,
      hasMore: message?.bundle?.has_more === true,
    },
  };
}

async function applyBundle(message) {
  const workspaceKey = String(message?.workspaceKey || '').trim();
  const workspaceDbKey = String(message?.workspaceDbKey || '').trim();
  if (!workspaceKey || !workspaceDbKey) throw new Error('Invalid Tower PG materialisation request context');
  if (boundWorkspaceKey && boundWorkspaceKey !== workspaceKey) {
    throw new Error('Tower PG materialisation worker cannot switch workspace ownership');
  }
  boundWorkspaceKey = workspaceKey;
  openWorkspaceDb(workspaceDbKey);
  if (message.bundle?.thread_pin_operation) return applyThreadPinOperation(message.store || {}, message.bundle.thread_pin_operation);
  const bundle = message.bundle || {};
  const backgroundRecordPage = [1, 2].includes(bundle.protocol_version)
    && !bundle.thread_history_page
    && bundle.materialization_priority !== 'foreground';
  const scheduledBundle = backgroundRecordPage ? {
    ...bundle,
    local_apply_options: {
      ...bundle.local_apply_options,
      batchSize: Math.min(BACKGROUND_BATCH_SIZE, Math.max(1, Number(bundle.local_apply_options?.batchSize) || BACKGROUND_BATCH_SIZE)),
      yieldToForeground: waitForForegroundIdle,
      backgroundBatchDelayMs: BACKGROUND_BATCH_DELAY_MS,
    },
  } : bundle;
  return hydrateTowerPgSyncBundle(message.store || {}, scheduledBundle);
}

self.addEventListener('message', (event) => {
  const message = event?.data;
  if (message?.type === FOREGROUND_TYPE) {
    if (!boundWorkspaceKey || message.workspaceKey === boundWorkspaceKey) {
      foregroundQuietUntil = Math.max(foregroundQuietUntil, Date.now() + Math.min(5_000, Math.max(0, Number(message.durationMs) || 0)));
    }
    return;
  }
  if (message?.type !== REQUEST_TYPE) return;
  const run = async () => {
    const startedAt = performance.now();
    try {
      const value = await applyBundle(message);
      self.postMessage({
        type: RESPONSE_TYPE,
        id: message.id,
        workspaceKey: message.workspaceKey,
        ok: true,
        value,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      self.postMessage({
        type: RESPONSE_TYPE,
        id: message.id,
        workspaceKey: message.workspaceKey,
        ok: false,
        error: serializeError(error, message),
      });
    }
  };
  // Bounded targeted transcript transactions can take the next IDB turn while
  // the snapshot retirement walk yields. Reset/version guards run at commit.
  if (message.bundle?.thread_history_page || message.bundle?.device_lock || message.bundle?.materialization_priority === 'foreground') void run();
  else materializationQueue = materializationQueue.then(run);
});
