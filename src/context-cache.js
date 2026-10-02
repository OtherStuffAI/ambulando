import { liveQuery } from 'dexie';

// Transport rows contain identifiers, never target authority or copied titles.
export function mapContextRow(row) {
  const { resolution, ...authority } = row;
  return { ...authority, record_id: row.id, version: row.row_version, sync_status: 'synced' };
}

export async function clearContextAuthority(db) {
  await db.context_components.clear();
  await db.context_references.clear();
  await db.context_coverage.clear();
  await db.context_reference_resolutions.clear();
}

// Called in the worker's terminal cursor transaction. Pages accumulate in the
// canonical journal; neither partial snapshots nor split subtree tombstones
// publish half a tree. Omission recovery uses only the authorized generation.
export async function publishContextAuthority(db, workspaceId, state) {
  const raw = await db.pg_record_rows.where('family').anyOf('context_component', 'context_reference', 'scope').toArray();
  const active = raw.filter(r => r.workspace_id === workspaceId && r.operation === 'upsert'
    && !r.row?.deleted_at && !r.row?.archived_at
    && (!state.snapshotReconciliationPending || r.generation === state.generation));
  const visibleScopes = new Set(active.filter(r => r.family === 'scope').map(r => r.id));
  const knownScopes = new Set(raw.filter(r => r.family === 'scope').map(r => r.id));
  const components = active.filter(r => r.family === 'context_component' && (!knownScopes.has(r.row.scope_id) || visibleScopes.has(r.row.scope_id))).map(r => mapContextRow(r.row));
  const byId = new Map(components.map(r => [r.id, r]));
  const valid = new Set();
  // Iterative parent walks handle deep trees, cycles, missing and cross-scope parents.
  for (const row of components) {
    const path = new Set(); let node = row;
    while (node && !valid.has(node.id)) {
      if (path.has(node.id)) break;
      path.add(node.id);
      if (!node.parent_id) { for (const id of path) valid.add(id); break; }
      const parent = byId.get(node.parent_id);
      if (!parent || parent.scope_id !== row.scope_id || parent.workspace_id !== row.workspace_id) break;
      node = parent;
    }
    if (node && valid.has(node.id)) for (const id of path) valid.add(id);
  }
  const references = active.filter(r => r.family === 'context_reference' && valid.has(r.row.component_id)
    && byId.get(r.row.component_id)?.scope_id === r.row.scope_id).map(r => mapContextRow(r.row));
  const scopes = new Set(active.filter(r => r.family === 'scope').map(r => r.id));
  for (const row of components.filter(r => valid.has(r.id))) scopes.add(row.scope_id);
  const prior = await db.context_coverage.toArray();
  await db.context_components.clear(); await db.context_references.clear();
  await db.context_reference_resolutions.clear();
  if (valid.size) await db.context_components.bulkPut(components.filter(r => valid.has(r.id)));
  if (references.length) await db.context_references.bulkPut(references);
  await db.context_coverage.bulkPut([...new Set([...scopes, ...prior.map(r => r.scope_id)])].map(scope_id => ({
    ...(prior.find(r => r.scope_id === scope_id) || {}), scope_id, status: scopes.has(scope_id) ? 'complete' : 'denied', workspace_id: workspaceId,
  })));
}

export function observeContextScope(db, workspaceId, scopeId) {
  return liveQuery(() => db.transaction('r', db.context_components, db.context_references, db.context_coverage, db.context_reference_resolutions, async () => {
    const coverage = await db.context_coverage.get(scopeId);
    const components = (await db.context_components.where('scope_id').equals(scopeId).toArray()).filter(r => r.workspace_id === workspaceId);
    const references = (await db.context_references.where('scope_id').equals(scopeId).toArray()).filter(r => r.workspace_id === workspaceId);
    const resolutions = new Map((await db.context_reference_resolutions.where('scope_id').equals(scopeId).toArray()).filter(r => r.workspace_id === workspaceId).map(r => [r.record_id, r]));
    for (const row of references) {
      const resolved = resolutions.get(row.record_id);
      row.resolution = resolved?.row_version === row.row_version ? resolved.resolution : { status: 'unavailable' };
    }
    const status = coverage?.workspace_id === workspaceId ? coverage.status : 'unloaded';
    const capabilities = status === 'complete' ? coverage?.capabilities || { read: true, manage: false } : { read: false, manage: false };
    return { status, capabilities, components, references, empty: status === 'complete' && components.length === 0 };
  }));
}
