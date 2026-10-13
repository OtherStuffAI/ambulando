import { normalizeOrgDataInWorker } from './projection-worker-client.js';
import { orgDataRequest } from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { orgDataContext, orgDataLifecycle, orgDataPartition, orgDataInstallationsPartition } from './projection.js';
export async function hydrateOrgData(store, options = {}, deps = {}) {
  const lifecycle = c => options.catalogue ? JSON.stringify([orgDataPartition(c), c.generation]) : orgDataLifecycle(c);
  const c = orgDataContext(store), context = lifecycle(c), db = deps.db || getWorkspaceDb();
  const partition = options.catalogue ? orgDataInstallationsPartition(c) : orgDataPartition(c);
  const service = store._towerSyncService, controller = new AbortController();
  const signals = [options.signal, service?.readAbortController?.signal].filter(Boolean);
  const abort = () => controller.abort();
  for (const s of signals) { if (s.aborted) abort(); else s.addEventListener('abort', abort, { once: true }); }
  const current = () => { controller.signal.throwIfAborted(); service?.assertActive();
    if (lifecycle(orgDataContext(store)) !== context || (!deps.db && getWorkspaceDb() !== db)) throw new Error('Workspace changed'); };
  try {
    current();
    const payload = await (deps.read || orgDataRequest)(c.workspaceId, options.catalogue ? 'catalogue' : 'snapshot', { baseUrl: c.baseUrl, appNpub: c.appNpub, signal: controller.signal });
    current();
    const row = { ...await normalizeOrgDataInWorker(payload, c, options.requestId, controller.signal, options.catalogue), key: partition };
    current();
    await db.transaction('rw', db.org_data, async () => { current(); await db.org_data.put(row);
      if (!options.catalogue) await db.org_data.put({ key: orgDataInstallationsPartition(c), request_id: row.request_id, installations: row.installations.map(({ html, ...metadata }) => metadata) });
      current(); });
    return { complete: true };
  } catch (error) {
    // Failed reauthorization cannot leave a broader persisted read projection.
    try { current(); await db.org_data.bulkDelete([orgDataPartition(c), orgDataInstallationsPartition(c)]); } catch { /* superseded/context disposed */ }
    throw error;
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

export async function readOrgDataPermissions(store, options = {}) {
  const c = orgDataContext(store), context = orgDataLifecycle(c), service = store._towerSyncService;
  const current = () => { service?.assertActive(); options.signal?.throwIfAborted();
    if (orgDataLifecycle(orgDataContext(store)) !== context) throw new Error('Workspace changed'); };
  current();
  const result = await orgDataRequest(c.workspaceId, 'permissions', { baseUrl: c.baseUrl, appNpub: c.appNpub, signal: options.signal });
  current(); return result;
}
