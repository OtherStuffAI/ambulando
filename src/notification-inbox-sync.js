import { towerPgNotificationInbox } from './api.js';
import { getWorkspaceDb } from './db.js';
import { notificationInboxContext } from './notification-inbox-store.js';
import { unreadCount } from './notification-inbox-store.js';
import {
  NOTIFICATION_CHANGES_PAGE_LIMIT, NOTIFICATION_SNAPSHOT_PAGES_PER_JOB, NOTIFICATION_SNAPSHOT_PAGE_LIMIT,
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
export async function synchronizeNotificationInbox(store, { db = getWorkspaceDb(), transport = towerPgNotificationInbox, now = Date.now, snapshotPageBudget = NOTIFICATION_SNAPSHOT_PAGES_PER_JOB } = {}) {
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
        await pass(store, service, context, { db, transport, now, snapshotPageBudget });
      } while (slot.dirty && !service.disposed);
    } finally { slot.running = null; }
  });
  return slot.running;
}

async function pass(store, service, context, { db, transport, now, snapshotPageBudget }) {
  const current = () => !service.disposed && notificationInboxContextSafe(store)?.key === context.key && (store._workspaceSelectionGeneration || 0) === (context.generation || 0);
  const materialize = async input => current() ? service.materialize('workspace-bundle', { notification_inbox_operation: { ...input, context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() }) : null;
  const request = (route, options = {}) => transport(context.workspaceId, route, { baseUrl: context.baseUrl, appNpub: context.appNpub, signal: service.readAbortController.signal, ...options });
  const readState = () => db.notification_inbox.get(context.key);

  let state = await readState();
  if (state?.status === 'unsupported' && now() < state.retry_after) return;
  try {
    if (!state?.ready || state.needs_snapshot || state.snapshot?.partition === 'inbox') {
      // Ready only at next_cursor=null; a budget-bounded job resumes in the next pass with the same origin.
      if (!await snapshot('inbox')) { slots.get(service).dirty = current(); return; }
    }
    if (!current()) return;
    await catchUp();
    if (!current()) return;
    state = await readState();
    if ((state.archived_requested && !state.archived_hydrated) || state.snapshot?.partition === 'archived') {
      if (!await snapshot('archived')) { slots.get(service).dirty = current(); return; }
    }
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

  /** Returns true once the whole partition is applied; false when the page budget ended first. */
  async function snapshot(partition, { restart = false } = {}) {
    let attempts = 0;
    for (;;) {
      state = await readState();
      let snap = !restart && attempts === 0 && state?.snapshot?.partition === partition ? state.snapshot : null;
      if (!snap && state?.snapshot) await materialize({ action: 'snapshot_abort' });
      const gen = snap?.gen || crypto.randomUUID();
      let cursor = snap?.cursor || null, head = snap?.seq ?? null, started = snap?.started_at || '', pages = 0;
      try {
        do {
          const page = normalizeItemsPage(await request('items', { query: { view: partition === 'archived' ? 'archived' : 'inbox', limit: NOTIFICATION_SNAPSHOT_PAGE_LIMIT, cursor } }), context);
          if (!current()) return false;
          // The first page's head is the replay origin for the whole snapshot, across jobs.
          if (head === null) { head = page.head_seq; started = page.inbox_started_at; }
          await materialize({ action: 'snapshot_page', gen, first: !snap && pages === 0, head_seq: head, partition, items: page.items, inbox_started_at: started, next_cursor: page.next_cursor });
          cursor = page.next_cursor;
          pages += 1;
        } while (cursor && pages < snapshotPageBudget);
      } catch (error) {
        // A cursor we persisted has expired or no longer matches: start over once with a new origin.
        if (snap && attempts === 0 && (error.status === 400 || errorCode(error) === 'invalid_cursor')) { attempts += 1; snap = null; await materialize({ action: 'snapshot_abort', gen }); restart = true; continue; }
        throw error;
      }
      if (cursor) return false; // older pages remain: never mark ready or delete anything yet
      await materialize({ action: 'snapshot_finish', gen });
      return true;
    }
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
          // Rebuild from a fresh origin; unsent intent is kept, archived rows re-hydrate in the next pass.
          if (!await snapshot('inbox', { restart: true })) { slots.get(service).dirty = current(); return; }
          if (state.archived_hydrated) await materialize({ action: 'rehydrate_archived' });
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
        // An identical retry returns 200 with the original acknowledgement. A 409 reuse means the server saw a
        // different request under this id: that is a rejection, never a silent success. Drop the overlay, say so,
        // and let the follow-up `changes` pull show the current state.
        if (error.status === 409 && code === 'mutation_id_reused') { await materialize({ action: 'reject', mutationId: ready.mutation_id, notice: 'A notification change could not be confirmed and was discarded. The latest state has been reloaded.' }); sent = true; continue; }
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

/** Ask the sync owner to hydrate archived items; they then follow `changes` like inbox items. */
export async function hydrateArchivedNotifications(store, options = {}) {
  const service = store.getTowerSyncService();
  if (!service) return;
  const context = notificationInboxContext(store);
  await service.materialize('workspace-bundle', { notification_inbox_operation: { action: 'request_archived', context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() });
  await synchronizeNotificationInbox(store, options);
}
