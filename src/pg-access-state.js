// Reader-specific access partitions are local metadata, separate from canonical
// content versions and device acknowledgement revisions. Tower supplies the
// partition notifications on the existing record page.
export function mergePgAccessState(state, page, families, workspaceId) {
  if (page.access_changes === undefined && page.access_revision === undefined) return state.accessPartitions || {};
  if (typeof page.access_revision !== 'string' || !/^\d+$/.test(page.access_revision) || !Array.isArray(page.access_changes) || page.access_changes.length > 200
    || page.retention_policy !== 'retain_downloaded') throw new Error('Invalid Tower access metadata');
  if (state.accessRevision && BigInt(page.access_revision) < BigInt(state.accessRevision)) throw new Error('Tower access revision regressed');
  const partitions = { ...state.accessPartitions };
  for (const change of page.access_changes) {
    if (!families.includes(change.family) || !['workspace', 'scope', 'channel'].includes(change.resource_type)
      || typeof change.resource_id !== 'string' || !change.resource_id
      || !['granted', 'lost'].includes(change.status)
      || change.resource_kind !== undefined && (change.family !== 'resource_view_state' || !['task', 'document', 'thread'].includes(change.resource_kind))
      || change.resource_type === 'workspace' && change.resource_id !== workspaceId) throw new Error('Invalid Tower access partition');
    partitions[`${change.family}${change.resource_kind ? '/' + change.resource_kind : ''}:${change.resource_type}:${change.resource_id}`] = change.status;
  }
  return partitions;
}

export function pgDownloadedAccess(row, state = {}) {
  if (state.accessLost) return 'access-lost';
  const family = row?.pg_delta_family || row?.pg_record_type || row?.family || (row?.resource_type && row?.resource_id ? 'resource_view_state' : '');
  const selector = family === 'resource_view_state' ? `${family}/${row.resource_type || row.row?.resource_type}` : family;
  if (!family) return row?.pg_access_status || 'current';
  const workspace = row.pg_workspace_id || row.workspace_id || row.row?.workspace_id;
  const scope = row.pg_scope_id || row.scope_id || row.scope_l1_id || row.row?.scope_id || (family === 'scope' ? row.record_id || row.id : null);
  const channel = row.pg_channel_id || row.channel_id || row.row?.channel_id || (family === 'channel' ? row.record_id || row.id : null);
  const partitions = state.accessPartitions || {};
  const statuses = [['workspace', workspace], ['scope', scope], ['channel', channel]]
    .filter(([, id]) => id).map(([type, id]) => partitions[`${selector}:${type}:${id}`] ?? partitions[`${family}:${type}:${id}`]);
  if (statuses.includes('lost')) return 'access-lost';
  if (statuses.includes('granted')) return 'current';
  return row.pg_access_status || 'current';
}

export function projectPgDownloadedAccess(value, state) {
  if (Array.isArray(value)) return value.map(row => projectPgDownloadedAccess(row, state));
  if (!value || typeof value !== 'object' || value instanceof Map || value instanceof Set) return value;
  if (value.record_id && (value.pg_backend || value.pg_record_type || value.pg_delta_family)) {
    return { ...value, pg_access_status: pgDownloadedAccess(value, state) };
  }
  // Collection wrappers contain rows, counts and paging metadata.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    Array.isArray(item) ? projectPgDownloadedAccess(item, state) : item]));
}
