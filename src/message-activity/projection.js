import { resolveTowerPgWorkspaceContext } from '../pg-workspace-context.js';

export const MESSAGE_ACTIVITY_RANGES = ['7d', '30d', 'all'];

export function messageActivityContext(store) {
  const c = resolveTowerPgWorkspaceContext(store);
  const identity = c.workspace.pgDescriptor?.identity || {};
  return { ...c, viewer: store.signingNpub || c.sessionNpub,
    tower: c.workspace.towerServiceNpub || identity.tower_service_npub || '',
    service: c.workspace.workspaceServiceNpub || identity.workspace_service_npub || '',
    dbKey: store.workspaceDbKey || '', board: store.selectedBoardId || '' };
}

export function messageActivityPartition(c) {
  return JSON.stringify([c.baseUrl, c.tower, c.service, c.workspaceId, c.workspaceOwnerNpub, c.appNpub, c.sessionNpub, c.viewer, c.dbKey]);
}

export function messageActivityLifecycle(c) {
  return JSON.stringify([messageActivityPartition(c), c.generation, c.board]);
}

export function messageActivityRowKey(c, range) {
  return JSON.stringify([messageActivityPartition(c), range]);
}

// Never copy arbitrary response fields (especially bodies/credentials) into
// the local projection or frame. Tower supplies completeness and ACL authority.
export function normalizeMessageActivity(payload, c, range, requestId) {
  const fail = () => { throw new Error('Invalid or incomplete Message activity response'); };
  if (typeof requestId !== 'string' || !requestId || !MESSAGE_ACTIVITY_RANGES.includes(range) || payload?.complete !== true
    || payload.workspace_id !== c.workspaceId || payload.range !== range) fail();
  const expected = { workspace_id: c.workspaceId, workspace_owner_npub: c.workspaceOwnerNpub,
    app_npub: c.appNpub, tower_service_npub: c.tower, workspace_service_npub: c.service };
  for (const [key, value] of Object.entries(expected)) {
    if (!value || payload.identity?.[key] !== value) fail();
  }
  const utc = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (!utc(payload.as_of) || !utc(payload.to) || Date.parse(payload.to) !== Date.parse(payload.as_of)) fail();
  if (range === 'all') { if (payload.from !== null) fail(); }
  else if (!utc(payload.from) || Date.parse(payload.as_of) - Date.parse(payload.from) !== (range === '7d' ? 7 : 30) * 86400000) fail();
  if (!Array.isArray(payload.channels)) fail();
  const seen = new Set();
  let total = 0;
  const channels = payload.channels.map(row => {
    if (typeof row?.channel_id !== 'string' || !row.channel_id.trim() || seen.has(row.channel_id)
      || !(row.scope_id === null || (typeof row.scope_id === 'string' && row.scope_id.trim()))
      || !Number.isSafeInteger(row.count) || row.count < 0) fail();
    seen.add(row.channel_id); total += row.count;
    if (!Number.isSafeInteger(total)) fail();
    return { channel_id: row.channel_id, scope_id: row.scope_id, count: row.count };
  });
  return { key: messageActivityRowKey(c, range), context: messageActivityPartition(c), range,
    request_id: requestId, from: payload.from, as_of: payload.as_of, complete: true, channels };
}

export function projectMessageActivity(row, channelRows, scopeRows) {
  const channels = new Map(channelRows.filter(r => !r.deleted_at && !['deleted', 'archived'].includes(r.record_state)).map(r => [r.record_id, r]));
  const scopes = new Map(scopeRows.filter(r => !r.deleted_at && !['deleted', 'archived'].includes(r.record_state)).map(r => [r.record_id, r]));
  const groups = new Map();
  let total = 0;
  for (const entry of row.channels) {
    // IDs/counts are authorized by the aggregate. Labels are only from existing
    // authorized metadata; missing metadata never drops a channel from totals.
    const scope = groups.get(entry.scope_id) || { id: entry.scope_id,
      label: entry.scope_id === null ? 'Unscoped' : scopes.get(entry.scope_id)?.title || 'Scope (label unavailable)', count: 0, channels: [] };
    scope.channels.push({ id: entry.channel_id, label: channels.get(entry.channel_id)?.title || channels.get(entry.channel_id)?.name || 'Channel (label unavailable)', count: entry.count });
    scope.count += entry.count; total += entry.count; groups.set(entry.scope_id, scope);
  }
  const result = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  for (const scope of result) scope.channels.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { range: row.range, from: row.from, as_of: row.as_of, complete: true, total,
    channel_count: row.channels.length, scopes: result };
}
