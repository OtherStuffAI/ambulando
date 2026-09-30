import { openWorkspaceDb } from '../db.js';
import { hydrateTowerPgSyncBundle } from '../pg-read-hydrator.js';

const REQUEST_TYPE = 'tower-pg-materializer:request';
const RESPONSE_TYPE = 'tower-pg-materializer:response';

let boundWorkspaceKey = null;
let materializationQueue = Promise.resolve();

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
  return hydrateTowerPgSyncBundle(message.store || {}, message.bundle || {});
}

self.addEventListener('message', (event) => {
  const message = event?.data;
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
  if (message.bundle?.thread_history_page) void run();
  else materializationQueue = materializationQueue.then(run);
});
