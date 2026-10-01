import { feedContextKey, feedRowKey } from '../feed/store.js';
export function inboundFeedReaderRow(row, context, state = false) {
  if (!row || row.schema_version !== 1 || row.workspace_id !== context.workspaceId || row.reader_actor_id !== context.readerActorId || !row.id || !Number.isInteger(row.row_version) || row.row_version < 1) throw new Error('invalid_reader_row');
  if (state ? !row.subscription_id || typeof row.item_id !== 'string' || !row.item_id || ['read', 'dismissed', 'saved'].some(k => typeof row[k] !== 'boolean') : !row.source || !['active', 'unsubscribed'].includes(row.status)) throw new Error('invalid_reader_row');
  const partition = feedContextKey(context);
  return { ...row, record_id: row.id, context: partition, key: feedRowKey(partition, row.subscription_id || row.id, state ? row.item_id : ''), pg_backend: true, pg_record_type: state ? 'feed_item_state' : 'feed_subscription', version: row.row_version, sync_status: 'synced' };
}
