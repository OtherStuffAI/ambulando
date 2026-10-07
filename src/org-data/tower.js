import { normalizeOrgDataInWorker } from './projection-worker-client.js';
import { orgDataRequest } from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { orgDataContext, orgDataLifecycle, orgDataPartition } from './projection.js';
export async function hydrateOrgData(store, options = {}, deps = {}) {
  const c = orgDataContext(store), context = orgDataLifecycle(c), db = deps.db || getWorkspaceDb();
  const service = store._towerSyncService, controller = new AbortController();
  const signals = [options.signal, service?.readAbortController?.signal].filter(Boolean);
  const abort = () => controller.abort();
  for (const s of signals) { if (s.aborted) abort(); else s.addEventListener('abort', abort, { once: true }); }
  const current = () => { controller.signal.throwIfAborted(); service?.assertActive();
    if (orgDataLifecycle(orgDataContext(store)) !== context || (!deps.db && getWorkspaceDb() !== db)) throw new Error('Workspace changed'); };
  try {
    current();
    const payload = await (deps.read || orgDataRequest)(c.workspaceId, 'snapshot', { baseUrl: c.baseUrl, appNpub: c.appNpub, signal: controller.signal });
    current();
    const row = { ...await normalizeOrgDataInWorker(payload, c, options.requestId, controller.signal), key: orgDataPartition(c) };
    current();
    await db.transaction('rw', db.org_data, async () => { current(); await db.org_data.put(row); current(); });
    return { complete: true };
  } finally { for (const s of signals) s.removeEventListener('abort', abort); }
}
export function prepareOrgDataCommand(store, input) {
  const c = orgDataContext(store), context = orgDataLifecycle(c);
  return { entityKey: `org-data:${input.path}`, execute: async () => {
    if (orgDataLifecycle(orgDataContext(store)) !== context) throw new Error('Workspace changed');
    const result = await orgDataRequest(c.workspaceId, input.path, { baseUrl: c.baseUrl, appNpub: c.appNpub, method: input.method, body: input.body });
    if (orgDataLifecycle(orgDataContext(store)) !== context) throw new Error('Workspace changed');
    return result;
  } };
}
