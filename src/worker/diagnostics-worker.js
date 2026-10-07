import { createDiagnosticsDb, DiagnosticsStore } from '../diagnostics-store.js';
const store = new DiagnosticsStore(createDiagnosticsDb());
void store.prune().catch(() => {});
setInterval(() => { void store.prune().catch(() => {}); }, 60_000);
self.addEventListener('message', async ({ data }) => {
  const { id, method, key, args = [] } = data || {};
  try {
    if (!['info', 'configure', 'append', 'queue', 'next', 'patch', 'clear'].includes(method)) throw new Error('Unknown diagnostics operation');
    self.postMessage({ id, result: await store[method](key, ...args) });
  } catch {
    self.postMessage({ id, error: 'Local diagnostics operation failed. Check consent, destination and storage availability.' });
  }
});
