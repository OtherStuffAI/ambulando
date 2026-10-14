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
  if (!row?.id || row.workspace_id !== context.workspaceId || row.actor_id !== context.actorId
    || !row.thread_id || typeof row.pinned !== 'boolean' || !Number.isSafeInteger(row.row_version) || row.row_version < 1) throw new Error('Invalid personal thread pin');
  return { ...row, key: row.id, record_id: row.id, context: context.key, sync_status: 'synced' };
}
export const threadPinSupportKey = context => `thread-pin-support:${context.key}`;
export const threadPinMigrationKey = partition => `thread-pin-migration:${partition}`;
const errorKey = context => `thread-pin-error:${context.key}`;
export async function readThreadPinProjection(db, context, partition) {
  const rows = await db.thread_pins.where('context').equals(context.key).toArray();
  const pending = await db.thread_pin_outbox.where('context').equals(context.key).sortBy('seq');
  const pins = (await db.sync_state.get(threadPinMigrationKey(partition))) ? {} : { ...(await getSettings())?.threadPins?.[partition] };
  for (const row of rows) {
    const canonical = row.pinned && !row.channel_id ? await db.chat_messages.get(row.thread_id) : null;
    if (row.pinned) pins[row.thread_id] = { id: row.thread_id, channelId: row.channel_id || canonical?.channel_id || '', rootRecordId: row.root_record_id || canonical?.pg_source_message_id || row.thread_id, pinnedAt: row.pinned_at || '' };
    else delete pins[row.thread_id];
  }
  for (const op of pending) {
    if (op.body.pinned) pins[op.threadId] = { ...op.thread, pinnedAt: op.pinnedAt };
    else delete pins[op.threadId];
  }
  const supported = (await db.sync_state.get(threadPinSupportKey(context)))?.value === true;
  return { rows: await getPinnedThreadRows(db, pins), error: (await db.sync_state.get(errorKey(context)))?.value
    || (!supported && Object.keys(pins).length ? 'Pins are saved on this device until Tower supports pin synchronization.' : '') };
}
export async function queueThreadPin(db, context, thread, pinned) {
  if (!thread?.id || (pinned && !thread.channelId)) throw new Error('Thread unavailable.');
  return db.transaction('rw', db.thread_pins, db.thread_pin_outbox, db.sync_state, async () => {
    const row = await db.thread_pins.where('[context+thread_id]').equals([context.key, thread.id]).first();
    const queued = await db.thread_pin_outbox.where('[context+threadId]').equals([context.key, thread.id]).sortBy('seq');
    const last = queued.at(-1);
    // Never mutate a sent or uncertain request. Dependent toggles retain the
    // predicted revision, and are discarded if their ancestor conflicts.
    const version = last ? last.body.expected_row_version + 1 : row?.row_version || 0;
    const pinnedAt = new Date().toISOString();
    await db.thread_pin_outbox.add({ context: context.key, threadId: thread.id,
      thread: { id: thread.id, channelId: thread.channelId, rootRecordId: thread.rootRecordId || thread.id }, pinnedAt,
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
        await db.thread_pin_outbox.add({ context: context.key, threadId: pin.id, thread: pin, pinnedAt: pin.pinnedAt || new Date().toISOString(),
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
      if (row.thread_id !== op.threadId) throw new Error('Pin acknowledgement target mismatch');
      const prior = await db.thread_pins.get(row.record_id);
      if (!prior || prior.row_version <= row.row_version) await db.thread_pins.put(row);
      await db.thread_pin_outbox.delete(op.seq);
      return;
    }
    if (input.action === 'reject') {
      await db.thread_pin_outbox.where('[context+threadId]').equals([context.key, op.threadId]).filter(r => r.seq >= op.seq).delete();
      await db.sync_state.put({ key: errorKey(context), value: input.error });
    } else if (input.action === 'retry') {
      await db.sync_state.put({ key: errorKey(context), value: 'Pin changes are saved on this device and will retry when Tower is available.' });
    }
  });
}
