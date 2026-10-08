import { getWorkspaceDb } from './db.js';

export function archiveTargetKey(family, id) { return `${family}:${id}`; }
export async function markPgTargetArchived(family, id, db = getWorkspaceDb()) {
  if (!['scope', 'channel'].includes(family) || !id) return;
  await db.pg_archived_targets.put({ key: archiveTargetKey(family, id), family, id });
}
function rowTargets(row) {
  return [row?.pg_channel_id || row?.channel_id || row?.channelId, row?.pg_scope_id || row?.scope_id || row?.scopeId, row?.scope_l1_id].filter(Boolean);
}
export async function filterArchivedProjection(value, db = getWorkspaceDb()) {
  return filterProjectionForArchivedTargets(value, await db.pg_archived_targets.toArray());
}
export function filterProjectionForArchivedTargets(value, rows = []) {
  const targets = new Set(rows.map(row => row.id));
  if (!targets.size) return value;
  const filter = item => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(filter).filter(item => item !== null);
    if (rowTargets(item).some(id => targets.has(id)) || targets.has(item.record_id)) return null;
    // Collection windows and detail bundles are wrappers; content rows remain
    // byte-for-byte cached, but cannot become browser-visible after archival.
    if (!item.record_id && !item.id) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, filter(child)]));
    return item;
  };
  return filter(value);
}
export async function canLoadPgTarget(family, id, options = {}, db = getWorkspaceDb()) {
  const targets = new Set((await db.pg_archived_targets.toArray()).map(row => row.id));
  if (!targets.size) return true;
  const direct = [options.scopeId, options.channelId];
  const recordId = String(id || '').split(':')[0];
  if (recordId) direct.push(recordId);
  if (direct.some(value => targets.has(value))) return false;
  if (recordId) {
    for (const kind of ['task', 'doc', 'thread', 'message', 'file', 'file_folder', 'audio_note']) {
      const raw = await db.pg_record_rows.get(`${kind}:${recordId}`);
      if (raw && rowTargets(raw).some(value => targets.has(value))) return false;
    }
    // Pending local rows may not yet have a canonical server record.
    for (const table of ['tasks', 'documents', 'chat_messages', 'audio_notes', 'file_folders']) {
      const row = await db.table(table).get(recordId);
      if (row && rowTargets(row).some(value => targets.has(value))) return false;
    }
  }
  return true;
}
