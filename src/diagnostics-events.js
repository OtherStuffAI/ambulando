// Each runtime context has its own subscriber. Raw payloads never leave the
// caller here; the recorder converts only allowlisted metadata before queuing.
let observer = null;
export function observeDiagnostics(callback) { observer = callback; return () => { if (observer === callback) observer = null; }; }
export function emitDiagnostic(input) { try { observer?.(input); } catch { /* diagnostics must never break application work */ } }

const ownedRequests = new WeakSet();
const operations = new WeakSet();
export function markDiagnosticRequest(init) { ownedRequests.add(init); return init; }
export function isDiagnosticRequest(init) { return init && ownedRequests.has(init); }
export function createDiagnosticOperation(operation) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const correlation = 'd-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const context = Object.freeze({ operation, correlation });
  operations.add(context);
  return context;
}
export function diagnosticOperationMetadata(context) { return operations.has(context) ? context : {}; }
export function finishDiagnosticOperation(context, outcome, error = null, extra = {}) {
  emitDiagnostic({ ...extra, ...diagnosticOperationMetadata(context), source: 'browser', code: 'recovery',
    level: outcome === 'failed' ? 'error' : 'info', outcome, category: extra.category || (error?.code === 'auth_timeout' || error?.status === 401 ? 'auth'
      : error?.status ? 'http' : error?.name === 'AbortError' ? 'cancellation' : error ? 'exception' : 'unavailable'),
    errorCode: error?.code, status: error?.status, name: error?.name, stack: error?.stack });
}
