const LOG_BUFFER_KEY = '__wingmanFlightDeckLogs';
const LOG_BUFFER_LIMIT = 200;
const TRANSACTION_FAILURE_LOGS = new WeakMap();

function appendBrowserLog(entry) {
  if (typeof window === 'undefined') return;
  const existing = Array.isArray(window[LOG_BUFFER_KEY]) ? window[LOG_BUFFER_KEY] : [];
  const next = existing.concat(entry);
  window[LOG_BUFFER_KEY] = next.length > LOG_BUFFER_LIMIT
    ? next.slice(next.length - LOG_BUFFER_LIMIT)
    : next;
}

export function flightDeckLog(level, topic, message, details = null) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    topic,
    message,
    details: details ?? null,
  };

  appendBrowserLog(entry);

  const prefix = `[WingmanFD:${topic}] ${message}`;
  if (level === 'error') {
    console.error(prefix, details ?? '');
  } else if (level === 'warn') {
    console.warn(prefix, details ?? '');
  } else if (level === 'info') {
    console.info(prefix, details ?? '');
  } else {
    console.debug(prefix, details ?? '');
  }

  return entry;
}

export function flightDeckTrace(topic, message, details = null) {
  const entry = {
    ts: new Date().toISOString(),
    level: 'trace',
    topic,
    message,
    details: details ?? null,
  };
  appendBrowserLog(entry);
  return entry;
}

// Keep one actionable transaction diagnostic across startup, SSE, and polling.
// Retries still run and remain in the trace buffer; a minute or a changed
// workspace/error emits a fresh console diagnostic, never a permanent mute.
export function flightDeckSyncFailure(store, level, topic, message, error, details = {}) {
  const diagnostic = { ...details, error: error?.message || String(error),
    errorName: error?.name || 'Error', workerContext: error?.materializationContext || null };
  if (['pg_read_authority_changed', 'pg_read_authority_resetting'].includes(error?.code)) {
    return flightDeckTrace(topic, message, diagnostic);
  }
  if (error?.name === 'TransactionInactiveError' || diagnostic.error === 'Transaction has already completed or failed') {
    const key = JSON.stringify([store.currentWorkspaceKey, store.workspaceOwnerNpub,
      store.backendUrl, store.session?.npub, diagnostic.errorName, diagnostic.error]);
    const prior = TRANSACTION_FAILURE_LOGS.get(store);
    if (prior?.key === key && Date.now() - prior.at < 60_000) {
      return flightDeckTrace(topic, message, { ...diagnostic, repeated: true });
    }
    TRANSACTION_FAILURE_LOGS.set(store, { key, at: Date.now() });
    diagnostic.errorStack = error?.stack || null;
    diagnostic.action = 'Update stalled: retry the workspace update. If it repeats, capture this worker stack and context; the transaction failure remains unresolved.';
  }
  return flightDeckLog(level, topic, message, diagnostic);
}

export function getFlightDeckLogBufferKey() {
  return LOG_BUFFER_KEY;
}
