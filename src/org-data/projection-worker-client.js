import { normalizeOrgSnapshotAsync } from './normalize.js';
export function normalizeOrgDataInWorker(payload, c, requestId, signal) {
  // Unit tests have no Worker; production browsers use the isolated normalizer.
  if (typeof Worker === 'undefined') return normalizeOrgSnapshotAsync(payload, c, requestId);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./projection-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, row) => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); if (error) reject(error); else resolve(row); };
    const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('Organisation data validation timed out')), 10000);
    worker.addEventListener('message', e => finish(e.data.error ? new Error(e.data.error) : null, e.data.row), { once: true });
    worker.addEventListener('error', e => finish(new Error(e.message || 'Organisation data validation failed')), { once: true });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    // Only the public authority tuple goes to this worker, never signing state.
    const context = Object.fromEntries(['workspaceId','workspaceOwnerNpub','appNpub','tower','service'].map(k => [k, c[k]]));
    worker.postMessage({ payload, context, requestId });
  });
}
