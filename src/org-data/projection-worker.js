import { normalizeOrgSnapshotAsync, normalizeOrgCatalogueAsync } from './normalize.js';
self.addEventListener('message', async event => {
  try { self.postMessage({ row: await (event.data.catalogue ? normalizeOrgCatalogueAsync : normalizeOrgSnapshotAsync)(event.data.payload, event.data.context, event.data.requestId) }); }
  catch (error) { self.postMessage({ error: error?.message || 'Invalid organisation data' }); }
});
