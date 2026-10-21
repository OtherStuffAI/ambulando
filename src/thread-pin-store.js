import { getWorkspaceDb, getSettings, getPinnedThreadRows } from './db.js';
import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';

export function threadPinContext(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  const actorId = resolvePgReaderActorId(store);
  if (!context.workspaceId || !actorId || (store.currentViewerNpub && store.currentViewerNpub !== store.session?.npub)) throw new Error('Sign in and finish workspace synchronization before pinning.');
  return { ...context, actorId, key: JSON.stringify([context.baseUrl, context.appNpub, context.workspaceId, actorId]) };
}
export function mapThreadPin(row, context) {
  const type = row?.resource_type || 'thread', id = row?.resource_id || row?.thread_id;
  if (!row?.id || row.workspace_id !== context.workspaceId || row.actor_id !== context.actorId
    || !['thread','task','document','channel'].includes(type) || !id || typeof row.pinned !== 'boolean' || !Number.isSafeInteger(row.row_version) || row.row_version < 1) throw new Error('Invalid personal thread pin');
  return { ...row, resource_type: type, resource_id: id, key: row.id, record_id: row.id, context: context.key, sync_status: 'synced' };
}
export const threadPinSupportKey = context => `thread-pin-support:${context.key}`;
export const threadPinMigrationKey = partition => `thread-pin-migration:${partition}`;
const errorKey = context => `thread-pin-error:${context.key}`;
export async function readThreadPinProjection(db, context, partition) {
  const rows = await db.thread_pins.where('context').equals(context.key).toArray();
  const pending = await db.thread_pin_outbox.where('context').equals(context.key).sortBy('seq');
  const legacy = (await db.sync_state.get(threadPinMigrationKey(partition))) ? {} : { ...(await getSettings())?.threadPins?.[partition] };
  const pins = Object.fromEntries(Object.values(legacy).map(pin => [`thread:${pin.id}`, { ...pin, type: 'thread', key: `thread:${pin.id}` }]));
  for (const row of rows) {
    const type = row.resource_type || 'thread', id = row.resource_id || row.thread_id, key = `${type}:${id}`;
    const canonical = row.pinned && !row.channel_id && type === 'thread' ? await db.chat_messages.get(id) : null;
    if (row.pinned) pins[key] = { id, type, key, recordId: id, channelId: row.channel_id || canonical?.channel_id || '', rootRecordId: row.root_record_id || canonical?.pg_source_message_id || id, pinnedAt: row.pinned_at || '' };
    else delete pins[key];
  }
  for (const op of pending) {
    const type = op.resourceType || 'thread', key = op.targetKey || `${type}:${op.threadId}`;
    if (op.body.pinned) pins[key] = { ...op.thread, type, key, pinnedAt: op.pinnedAt };
    else delete pins[key];
  }
  const rendered = await Promise.all(Object.values(pins).map(async pin => {
    if (pin.type === 'thread') return (await getPinnedThreadRows(db, { [pin.key]: pin }))[0];
    if (pin.type === 'channel') {
      const [channel, authority] = await Promise.all([db.channels.get(pin.id), db.pg_record_rows.get(`channel:${pin.id}`)]);
      const archived = await db.pg_archived_targets.bulkGet([`channel:${pin.id}`, `scope:${channel?.scope_id || channel?.pg_scope_id || channel?.scope_l1_id || ''}`]);
      const unavailable = !channel || archived.some(Boolean) || authority?.operation === 'delete' || authority?.row?.deleted_at
        || channel.deleted_at || ['deleted','archived'].includes(channel.record_state)
        || ['stale','access-lost'].includes(channel.pg_access_status) || channel.can_read === false || channel.readable === false;
      return { ...pin, channelId: pin.id, title: unavailable ? 'Channel unavailable' : channel.title || channel.name || 'Untitled channel',
        activityAt: unavailable ? '' : channel.updated_at || '', unavailable: Boolean(unavailable) };
    }
    const family = pin.type === 'document' ? 'doc' : 'task';
    const table = pin.type === 'document' ? db.documents : db.tasks;
    const [resource, authority, attention] = await Promise.all([table.get(pin.id), db.pg_record_rows.get(`${family}:${pin.id}`), db.pg_resource_attention.get(`${pin.type}:${pin.id}`)]);
    const channelId = resource?.pg_channel_id || resource?.channel_id || pin.channelId;
    const [channel, archived] = await Promise.all([db.channels.get(channelId || ''), db.pg_archived_targets.bulkGet([`channel:${channelId || ''}`, `scope:${resource?.scope_id || resource?.pg_scope_id || ''}`])]);
    const unavailable = !resource || !channel || archived.some(Boolean) || authority?.operation === 'delete' || authority?.row?.deleted_at
      || (pin.type === 'document' && resource.pg_record_type === 'file')
      || [resource,channel].some(r => ['deleted','archived'].includes(r.record_state) || ['stale','access-lost'].includes(r.pg_access_status) || r.can_read === false || r.readable === false);
    return { ...pin, channelId, title: unavailable ? `${pin.type === 'task' ? 'Task' : 'Document'} unavailable` : resource.title || `Untitled ${pin.type}`,
      activityAt: unavailable ? '' : resource.updated_at || '', unavailable: Boolean(unavailable), persistedUnread: attention ? Boolean(attention.unread) : false };
  }));
  const supported = (await db.sync_state.get(threadPinSupportKey(context)))?.value === true;
  return { rows: rendered, error: (await db.sync_state.get(errorKey(context)))?.value
    || (!supported && Object.keys(pins).length ? 'Pins are saved on this device until Tower supports pin synchronization.' : '') };
}
export async function queueThreadPin(db, context, thread, pinned, resourceType = thread?.type || 'thread') {
  const targetKey = `${resourceType}:${thread?.id}`;
  if (!['thread','task','document','channel'].includes(resourceType) || !thread?.id || (pinned && resourceType === 'thread' && !thread.channelId)) throw new Error('Thread unavailable.');
  return db.transaction('rw', db.thread_pins, db.thread_pin_outbox, db.sync_state, async () => {
    const row = await db.thread_pins.where('[context+resource_type+resource_id]').equals([context.key, resourceType, thread.id]).first();
    const queued = await db.thread_pin_outbox.where('[context+targetKey]').equals([context.key, targetKey]).sortBy('seq');
    const last = queued.at(-1);
    // Never mutate a sent or uncertain request. Dependent toggles retain the
    // predicted revision, and are discarded if their ancestor conflicts.
    const version = last ? last.body.expected_row_version + 1 : row?.row_version || 0;
    const pinnedAt = new Date().toISOString();
    await db.thread_pin_outbox.add({ context: context.key, threadId: thread.id, resourceType, targetKey,
      thread: { id: thread.id, type: resourceType, channelId: thread.channelId || '', rootRecordId: thread.rootRecordId || thread.id }, pinnedAt,
      body: { pinned, expected_row_version: version, mutation_id: crypto.randomUUID() } });
    await db.sync_state.delete(errorKey(context));
  });
}

// Executed by Tower's existing workspace materialization worker, never a UI timer.
export async function applyThreadPinOperation(store, input, db = getWorkspaceDb()) {
  const context = threadPinContext(store);
  return db.transaction('rw', db.thread_pins, db.thread_pin_outbox, db.sync_state, async () => {
    if (input.action === 'migrate') {
      if (await db.sync_state.get(threadPinMigrationKey(input.partition))) return;
      for (const pin of Object.values(input.pins || {})) {
        if (!pin?.id) continue;
        const known = await db.thread_pins.where('[context+thread_id]').equals([context.key, pin.id]).first();
        const queued = await db.thread_pin_outbox.where('[context+threadId]').equals([context.key, pin.id]).count();
        if (known || queued) continue;
        await db.thread_pin_outbox.add({ context: context.key, threadId: pin.id, resourceType: 'thread', targetKey: `thread:${pin.id}`, thread: pin, pinnedAt: pin.pinnedAt || new Date().toISOString(),
          body: { pinned: true, expected_row_version: 0, mutation_id: crypto.randomUUID(), import_only: true,
            ...(Number.isFinite(Date.parse(pin.pinnedAt)) ? { pinned_at: pin.pinnedAt } : {}) } });
      }
      await db.sync_state.put({ key: threadPinMigrationKey(input.partition), value: true });
      return;
    }
    const op = await db.thread_pin_outbox.get(input.seq);
    if (!op || op.context !== context.key || op.body.mutation_id !== input.mutationId) return;
    if (input.action === 'ack') {
      const row = mapThreadPin(input.pin, context);
      if (row.resource_id !== op.threadId || row.resource_type !== (op.resourceType || 'thread')) throw new Error('Pin acknowledgement target mismatch');
      const prior = await db.thread_pins.get(row.record_id);
      if (!prior || prior.row_version <= row.row_version) await db.thread_pins.put(row);
      await db.thread_pin_outbox.delete(op.seq);
      return;
    }
    if (input.action === 'reject') {
      await db.thread_pin_outbox.where('[context+targetKey]').equals([context.key, op.targetKey || `thread:${op.threadId}`]).filter(r => r.seq >= op.seq).delete();
      await db.sync_state.put({ key: errorKey(context), value: input.error });
    } else if (input.action === 'retry') {
      await db.sync_state.put({ key: errorKey(context), value: 'Pin changes are saved on this device and will retry when Tower is available.' });
    }
  });
}
