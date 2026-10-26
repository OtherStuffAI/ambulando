import { towerPgNotificationInbox } from './api.js';
import { getWorkspaceDb } from './db.js';
import { notificationInboxContext } from './notification-inbox-store.js';
import { unreadCount } from './notification-inbox-store.js';
import {
  NOTIFICATION_CHANGES_PAGE_LIMIT, NOTIFICATION_SNAPSHOT_MAX_PAGES, NOTIFICATION_SNAPSHOT_PAGE_LIMIT,
  errorCode, isUnsupportedBackend, normalizeChangesPage, normalizeCounts, normalizeItemsPage, normalizeNotificationItem, requestBodyForMutation,
} from './notification-inbox-wire.js';

const UNSUPPORTED_RETRY_MS = 10 * 60_000;
const HEAL_COOLDOWN_MS = 5 * 60_000;
const slots = new WeakMap();

/**
 * Single-flight reconciliation of the actor-private inbox. It runs under the
 * workspace's TowerSyncService (no second network owner): a stream hint, a
 * reconnect, a fallback tick or a local intent all call this, and a request made
 * while a pass is running schedules exactly one more pass.
 */
export async function synchronizeNotificationInbox(store, { db = getWorkspaceDb(), transport = towerPgNotificationInbox, now = Date.now } = {}) {
  const service = store.getTowerSyncService();
  if (!service) return { skipped: 'no-service' };
  let context;
  try { context = notificationInboxContext(store); } catch { return { skipped: 'no-context' }; }
  let slot = slots.get(service);
  if (!slot) slots.set(service, slot = { running: null, dirty: false });
  if (slot.running) { slot.dirty = true; return slot.running; }
  slot.running = service.coalesce(`notification-inbox:${context.key}`, async () => {
    try {
      do {
        slot.dirty = false;
        await pass(store, service, context, { db, transport, now });
      } while (slot.dirty && !service.disposed);
    } finally { slot.running = null; }
  });
  return slot.running;
}

async function pass(store, service, context, { db, transport, now }) {
  const current = () => !service.disposed && notificationInboxContextSafe(store)?.key === context.key && (store._workspaceSelectionGeneration || 0) === (context.generation || 0);
  const materialize = async input => current() ? service.materialize('workspace-bundle', { notification_inbox_operation: { ...input, context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() }) : null;
  const request = (route, options = {}) => transport(context.workspaceId, route, { baseUrl: context.baseUrl, appNpub: context.appNpub, signal: service.readAbortController.signal, ...options });
  const readState = () => db.notification_inbox.get(context.key);

  let state = await readState();
  if (state?.status === 'unsupported' && now() < state.retry_after) return;
  try {
    if (!state?.ready || state.needs_snapshot) await snapshot('inbox');
    if (!current()) return;
    await catchUp();
    if (!current()) return;
    const flushed = await flush();
    if (!current()) return;
    if (flushed) await catchUp();
    await reconcileCounts();
  } catch (error) {
    if (!current()) return;
    if (isUnsupportedBackend(error)) {
      await materialize({ action: 'status', status: 'unsupported', error: 'This Tower does not provide the shared notification inbox yet.', retry_after: now() + UNSUPPORTED_RETRY_MS });
      return;
    }
    if (error.status === 403) { await materialize({ action: 'status', status: 'forbidden', error: 'You no longer have access to notifications in this workspace.' }); return; }
    throw error;
  }

  async function snapshot(partition) {
    const gen = crypto.randomUUID();
    let cursor = null, head = null, pages = 0;
    do {
      const page = normalizeItemsPage(await request('items', { query: { view: partition === 'archived' ? 'archived' : 'inbox', limit: NOTIFICATION_SNAPSHOT_PAGE_LIMIT, cursor } }), context);
      if (!current()) return;
      // Capture the replay origin from the first page: later pages may be newer, which replay repairs.
      if (head === null) head = page.head_seq;
      await materialize({ action: 'snapshot_page', gen, first: pages === 0, head_seq: head, partition, items: page.items, inbox_started_at: page.inbox_started_at });
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < NOTIFICATION_SNAPSHOT_MAX_PAGES);
    // An exhausted page budget (partial) leaves older rows untouched rather than guessing they were removed.
    await materialize({ action: 'snapshot_finish', gen, partial: Boolean(cursor) });
  }

  async function catchUp() {
    let resetOnce = false;
    for (;;) {
      state = await readState();
      let page;
      try {
        page = normalizeChangesPage(await request('changes', { query: { after_seq: state.local_seq, limit: NOTIFICATION_CHANGES_PAGE_LIMIT } }), context);
      } catch (error) {
        // Cursor older than the retained tombstones (or ahead of a restored head): rebuild, keep local intent.
        if ((error.status === 410 || errorCode(error) === 'reset_required') && !resetOnce) {
          resetOnce = true;
          await snapshot('inbox');
          if (state.archived_hydrated) await snapshot('archived');
          continue;
        }
        throw error;
      }
      if (!current()) return;
      const advanced = await materialize({ action: 'changes', changes: page.changes, through_seq: page.through_seq, head_seq: page.head_seq });
      if (!page.has_more) return;
      if (!advanced || advanced.local_seq <= state.local_seq) return; // a stuck cursor must not spin
    }
  }

  async function flush() {
    let sent = false;
    for (;;) {
      state = await readState();
      const entry = state?.pending[0];
      if (!entry || !current()) return sent;
      await materialize({ action: 'begin_attempt', mutationId: entry.mutation_id });
      const ready = (await readState())?.pending.find(op => op.mutation_id === entry.mutation_id);
      if (!ready) continue; // target vanished locally
      try {
        const route = ready.kind === 'bulk' ? 'bulk' : `items/${encodeURIComponent(ready.item_id)}`;
        const result = await request(route, { method: ready.kind === 'bulk' ? 'POST' : 'PATCH', body: requestBodyForMutation(ready) });
        const row = ready.kind === 'item' && result?.item ? normalizeNotificationItem(result.item, context) : null;
        await materialize({ action: 'ack', mutationId: ready.mutation_id, row: row || null });
        sent = true;
      } catch (error) {
        if (!current()) return sent;
        const code = errorCode(error);
        if (error.status === 409 && code === 'mutation_id_reused') { await materialize({ action: 'ack', mutationId: ready.mutation_id, row: null }); sent = true; continue; }
        if (error.status === 409 && ready.kind === 'item') {
          let row = null;
          try { row = error.payload?.item ? normalizeNotificationItem(error.payload.item, context) : null; } catch { row = null; }
          await materialize({ action: 'conflict', mutationId: ready.mutation_id, newMutationId: crypto.randomUUID(), row });
          sent = true;
          continue;
        }
        if (error.status === 404 && ready.kind === 'item') { await materialize({ action: 'reject', mutationId: ready.mutation_id, removeItemId: ready.item_id, notice: 'That notification is no longer available.' }); sent = true; continue; }
        if ([400, 403, 409, 413, 422].includes(error.status)) { await materialize({ action: 'reject', mutationId: ready.mutation_id }); if (error.status === 403) throw error; sent = true; continue; }
        await materialize({ action: 'retry', mutationId: ready.mutation_id }); // uncertain/transient: body stays immutable
        throw error;
      }
    }
  }

  async function reconcileCounts() {
    const counts = normalizeCounts(await request('counts'), context);
    if (!current()) return;
    await materialize({ action: 'counts', counts });
    state = await readState();
    if (state.pending.length || counts.head_seq === null || counts.head_seq > state.local_seq || counts.unread_total >= counts.capped_at) return;
    const rows = await db.notification_items.where('context').equals(context.key).toArray();
    // A local/server disagreement at the same sequence means a lost transition: rebuild once per cooldown.
    if (unreadCount(rows, state) !== counts.unread_total && now() >= (state.heal_after || 0)) {
      await materialize({ action: 'heal', heal_after: now() + HEAL_COOLDOWN_MS });
      slots.get(service).dirty = true;
    }
  }
}

function notificationInboxContextSafe(store) {
  try { return notificationInboxContext(store); } catch { return null; }
}

/** Load a non-default partition on demand (archived items are never hydrated implicitly). */
export async function hydrateArchivedNotifications(store, options = {}) {
  const service = store.getTowerSyncService();
  if (!service) return;
  const context = notificationInboxContext(store);
  const { db = getWorkspaceDb(), transport = towerPgNotificationInbox } = options;
  return service.coalesce(`notification-inbox-archived:${context.key}`, async () => {
    const gen = crypto.randomUUID();
    let cursor = null, head = null, pages = 0;
    do {
      const page = normalizeItemsPage(await transport(context.workspaceId, 'items', { baseUrl: context.baseUrl, appNpub: context.appNpub, signal: service.readAbortController.signal, query: { view: 'archived', limit: NOTIFICATION_SNAPSHOT_PAGE_LIMIT, cursor } }), context);
      if (head === null) head = page.head_seq;
      await service.materialize('workspace-bundle', { notification_inbox_operation: { action: 'snapshot_page', gen, first: pages === 0, head_seq: head, partition: 'archived', items: page.items, context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() });
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < NOTIFICATION_SNAPSHOT_MAX_PAGES);
    if (!cursor) await service.materialize('workspace-bundle', { notification_inbox_operation: { action: 'snapshot_finish', gen, context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() });
    return db.notification_inbox.get(context.key);
  });
}
