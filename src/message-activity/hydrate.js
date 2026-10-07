import { getTowerPgMessageActivity } from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { messageActivityContext, messageActivityLifecycle, normalizeMessageActivity } from './projection.js';

// Only invoked by TowerSyncService's registered on-demand read family.
export async function hydrateMessageActivity(store, range, options = {}, deps = {}) {
  const db = deps.db || getWorkspaceDb();
  const c = messageActivityContext(store), lifecycle = messageActivityLifecycle(c);
  const service = store._towerSyncService;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = [options.signal, service?.readAbortController?.signal].filter(Boolean);
  for (const signal of signals) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const current = () => {
    controller.signal.throwIfAborted();
    service?.assertActive();
    if (messageActivityLifecycle(messageActivityContext(store)) !== lifecycle
      || (!deps.db && getWorkspaceDb() !== db)) throw new Error('Message activity context changed');
  };
  try {
    current();
    const payload = await (deps.read || getTowerPgMessageActivity)(c.workspaceId, range, {
      baseUrl: c.baseUrl, appNpub: c.appNpub, signal: controller.signal,
    });
    current();
    const row = normalizeMessageActivity(payload, c, range, options.requestId);
    await db.transaction('rw', db.message_activity, async () => {
      current();
      await db.message_activity.put(row);
      current();
    });
    return { complete: true };
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', abort);
  }
}
