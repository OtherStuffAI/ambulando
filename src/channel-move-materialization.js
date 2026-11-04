import { buildScopeTags } from './scope-delivery.js';
import { taskIndexFields } from './task-index-keys.js';

// Called only by the sync command/delta materializers, inside their authority
// transaction. IDs, bodies, grants, local drafts and sync cursors stay intact.
export async function materializeChannelScope(db, channelId, destinationScopeId) {
  const scope = await db.scopes.get(destinationScopeId);
  const tags = buildScopeTags(scope || { record_id: destinationScopeId, level: 'l1' });
  const boundIds = new Set([channelId]);
  const tables = db.tables.filter(table => ['comments', 'daily_notes', 'directories', 'schedules', 'notification_items', 'pg_record_rows', 'pg_resource_attention'].includes(table.name)
    || table.schema.indexes.some(index => ['scope_id', 'channel_id', 'pg_channel_id', 'target_record_id', 'workroom_id'].includes(index.name)));
  const rows = await Promise.all(tables.map(async table => [table, await table.toArray()]));
  const bound = row => row && (row.channel_id === channelId || row.pg_channel_id === channelId
    || row.record_id === channelId || [row.task_id, row.doc_id, row.document_id, row.thread_id, row.parent_message_id,
      row.workroom_id, row.parent_directory_id, row.parent_task_id, row.parent_comment_id, row.pg_thread_id, row.target_record_id, row.resource_id].some(id => id && boundIds.has(id)));
  // Comments and projections may only carry a parent ID, including nested replies.
  let expanded;
  do {
    expanded = false;
    for (const [, values] of rows) for (const row of values) {
      const value = row.row || row;
      if ((bound(value) || bound(row)) && (value.record_id || value.id)) {
        const id = value.record_id || value.id;
        if (!boundIds.has(id)) { boundIds.add(id); expanded = true; }
      }
    }
  } while (expanded);
  for (const [table, values] of rows) for (const row of values) {
    const value = row.row || row;
    if (table.name === 'notification_items') {
      if (bound(row.subject) || bound(row.target)) await table.put({ ...row,
        ...(bound(row.subject) ? { subject: { ...row.subject, scope_id: destinationScopeId } } : {}),
        ...(bound(row.target) ? { target: { ...row.target, scope_id: destinationScopeId } } : {}),
      });
      continue;
    }
    if (!(bound(value) || bound(row) || boundIds.has(value.record_id || value.id))) continue;
    // Only scope-bearing rows are projections of scope; unrelated metadata rows
    // sharing a resource ID do not acquire invented authority fields.
    if (!('scope_id' in value) && !('pg_scope_id' in value) && !('scope_l1_id' in value)) continue;
    const updated = table.name === 'pg_record_rows'
      ? { ...value, scope_id: destinationScopeId }
      : { ...value, ...tags };
    if ('pg_scope_id' in value) updated.pg_scope_id = destinationScopeId;
    if ('cache_scope' in value) updated.cache_scope = destinationScopeId;
    if (table.name === 'tasks') Object.assign(updated, taskIndexFields(updated));
    await table.put(row.row ? { ...row, row: updated } : updated);
  }
}

export async function materializeChannelMove(db, channel, mapChannel, owner) {
  if (!channel?.id || !channel?.scope_id) throw new Error('Tower did not return the moved channel. Retry the same move.');
  await db.transaction('rw', db.tables, async () => {
    const current = await db.channels.get(channel.id);
    if (current?.updated_at && channel.updated_at && Date.parse(current.updated_at) > Date.parse(channel.updated_at)) return;
    if (current?.scope_id !== channel.scope_id) await materializeChannelScope(db, channel.id, channel.scope_id);
    const prior = await db.channels.get(channel.id);
    const mapped = mapChannel(channel, { workspaceOwnerNpub: owner });
    if (!Array.isArray(channel.channel_grants) && !Array.isArray(channel.grants) && prior) mapped.channel_grants = prior.channel_grants || [];
    await db.channels.put({ ...prior, ...mapped });
  });
}
