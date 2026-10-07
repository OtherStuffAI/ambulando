// Each runtime context has its own subscriber. Raw payloads never leave the
// caller here; the recorder converts only allowlisted metadata before queuing.
let observer = null;
export function observeDiagnostics(callback) { observer = callback; return () => { if (observer === callback) observer = null; }; }
export function emitDiagnostic(input) { try { observer?.(input); } catch { /* diagnostics must never break application work */ } }
