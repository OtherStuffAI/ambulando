const REQUEST_TYPE = 'tower-pg-materializer:request';
const RESPONSE_TYPE = 'tower-pg-materializer:response';

function createAbortError(reason = 'disposed') {
  const error = new Error(`Tower PG materialisation cancelled: ${reason}`);
  error.name = 'AbortError';
  return error;
}

function deserializeWorkerError(value) {
  const error = new Error(value?.message || 'Tower PG materialisation worker failed');
  if (value?.name) error.name = value.name;
  if (value?.stack) error.stack = value.stack;
  if (value?.materializationContext) error.materializationContext = value.materializationContext;
  return error;
}

function defaultWorkerFactory() {
  if (typeof Worker === 'undefined') {
    throw new Error('Tower PG materialisation requires Web Worker support');
  }
  return new Worker(new URL('./worker/tower-pg-materialization-worker.js', import.meta.url), { type: 'module' });
}

/**
 * Workspace-bound physical materialisation port.
 *
 * TowerSyncService remains the lifecycle/update owner. This client owns only
 * the dedicated execution boundary that commits one bundle page and its cursor
 * in Dexie. Disposal terminates the worker so a replaced workspace cannot
 * publish a late completion or continue an old transaction.
 */
export class TowerPgMaterializationWorkerClient {
  constructor({ workspaceKey, workerFactory = defaultWorkerFactory, onDiagnostic = detail => console.warn('[Tower materializer] Slow operation', detail), diagnosticDelayMs = 10000 } = {}) {
    this.workspaceKey = String(workspaceKey || '').trim();
    if (!this.workspaceKey) throw new Error('Tower PG materialisation worker requires a workspace key');
    this.workerFactory = workerFactory;
    this.onDiagnostic = onDiagnostic;
    this.diagnosticDelayMs = diagnosticDelayMs;
    this.worker = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.disposed = false;
    this.disposeReason = null;
  }

  async materialize({ workspaceDbKey, store, bundle } = {}) {
    this.assertActive();
    const dbKey = String(workspaceDbKey || '').trim();
    if (!dbKey) throw new Error('Tower PG materialisation requires a workspace database key');
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const pending = new Promise((resolve, reject) => {
      const diagnosticTimer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // Observe only. Never resolve/retry alongside an old transaction.
        this.onDiagnostic?.({ operation: bundle?.thread_history_page ? 'thread-history'
          : bundle?.reset_authority ? 'authority-reset' : bundle?.mode || 'materialize',
          changeCount: bundle?.changes?.length || 0, pendingCount: this.pending.size,
          elapsedMs: this.diagnosticDelayMs });
      }, this.diagnosticDelayMs);
      this.pending.set(id, { resolve, reject, diagnosticTimer });
    });
    try {
      worker.postMessage({
        type: REQUEST_TYPE,
        id,
        workspaceKey: this.workspaceKey,
        workspaceDbKey: dbKey,
        store,
        bundle,
      });
    } catch (error) {
      clearTimeout(this.pending.get(id)?.diagnosticTimer);
      this.pending.delete(id);
      throw error;
    }
    return pending;
  }

  dispose(reason = 'dispose') {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeReason = String(reason || 'dispose');
    const error = createAbortError(this.disposeReason);
    for (const request of this.pending.values()) { clearTimeout(request.diagnosticTimer); request.reject(error); }
    this.pending.clear();
    this.destroyWorker();
  }

  ensureWorker() {
    this.assertActive();
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    if (!worker) throw new Error('Tower PG materialisation worker could not be created');
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleError);
    worker.addEventListener('messageerror', this.handleError);
    this.worker = worker;
    return worker;
  }

  destroyWorker() {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      worker.removeEventListener('message', this.handleMessage);
      worker.removeEventListener('error', this.handleError);
      worker.removeEventListener('messageerror', this.handleError);
      worker.terminate();
    } catch {
      // The lifecycle has already been invalidated; termination is best effort.
    }
  }

  handleMessage = (event) => {
    const message = event?.data;
    if (message?.type !== RESPONSE_TYPE || message?.workspaceKey !== this.workspaceKey) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.diagnosticTimer);
    this.pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(deserializeWorkerError(message.error));
  };

  handleError = (event) => {
    const error = event?.error instanceof Error
      ? event.error
      : new Error(event?.message || 'Tower PG materialisation worker crashed');
    for (const request of this.pending.values()) { clearTimeout(request.diagnosticTimer); request.reject(error); }
    this.pending.clear();
    this.destroyWorker();
  };

  assertActive() {
    if (this.disposed) throw createAbortError(this.disposeReason);
  }
}

export const TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL = Object.freeze({
  request: REQUEST_TYPE,
  response: RESPONSE_TYPE,
});
