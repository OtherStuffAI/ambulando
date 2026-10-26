import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';
import { getWorkspaceDb } from './db.js';

// Local shape of the shared notification inbox. Server truth lives in
// `notification_items`; user intent that has not been acknowledged lives only in
// `notification_inbox.pending` and is overlaid at render time, so a rejected or
// conflicted intent can never leave a fabricated server state behind.

const MAX_CONFLICT_RETRIES = 3;
const MAX_PENDING = 500;
export const ITEM_PATCH_KEYS = Object.freeze(['read', 'dismissed', 'archived']);
export const BULK_OPS = Object.freeze(['mark_read', 'mark_unread', 'dismiss', 'archive', 'unarchive']);

export function notificationInboxContext(store) {
  const { baseUrl, appNpub, workspaceId, generation } = resolveTowerPgWorkspaceContext(store);
  const actorId = resolvePgReaderActorId(store);
  if (!workspaceId || !actorId || (store.currentViewerNpub && store.currentViewerNpub !== store.session?.npub)) {
    throw Object.assign(new Error('Sign in and finish workspace synchronization before using notifications.'), { code: 'notification_context_unavailable' });
  }
  return { baseUrl, appNpub, workspaceId, actorId, generation, key: JSON.stringify([baseUrl, appNpub, workspaceId, actorId]) };
}

export function notificationInboxContextOrNull(store) {
  try { return notificationInboxContext(store); } catch { return null; }
}

const emptyState = context => ({
  key: context.key, context: context.key, ready: false, status: 'unknown', local_seq: 0, head_seq: 0,
  counts: null, pending: [], error: '', notice: '', archived_hydrated: false, snapshot: null, activated_at: null,
  retry_after: 0, heal_after: 0,
});

// ---- pure projection helpers (shared by the worker reducer and the UI) -----

function applyPatch(row, patch) {
  const next = { ...row };
  if (patch.read !== undefined) next.read = Boolean(patch.read);
  if (patch.dismissed !== undefined) { next.dismissed = Boolean(patch.dismissed); if (patch.dismissed) next.read = true; }
  if (patch.archived !== undefined) { next.archived = Boolean(patch.archived); if (patch.archived) next.read = true; }
  return next;
}

function bulkMatches(row, selector) {
  if (!selector) return false;
  if (Array.isArray(selector.ids)) return selector.ids.includes(row.id);
  if (row.change_seq > selector.up_to_seq) return false; // observed boundary only
  if (selector.category && row.category !== selector.category) return false;
  if (selector.source_app_id && row.source.app_id !== selector.source_app_id) return false;
  if (selector.view === 'unread' && (row.read || row.dismissed || row.archived)) return false;
  return true;
}

function applyBulk(row, pending) {
  if (!bulkMatches(row, pending.selector)) return row;
  const patch = { mark_read: { read: true }, mark_unread: { read: false }, dismiss: { dismissed: true }, archive: { archived: true }, unarchive: { archived: false } }[pending.op];
  return patch ? applyPatch(row, patch) : row;
}

/** Server rows with unacknowledged local intent applied. Never mutates inputs. */
export function overlayPending(rows, pending = []) {
  if (!pending.length) return rows;
  return rows.map(row => {
    let next = row;
    for (const entry of pending) {
      if (entry.kind === 'bulk') next = applyBulk(next, entry);
      else if (entry.item_id === row.id) next = applyPatch(next, entry.patch);
    }
    return next;
  });
}

export const isUnreadRow = row => row.status === 'active' && !row.read && !row.dismissed && !row.archived && !row.unavailable && !row.removed;

export function projectNotificationInbox(rows, state, { view = 'inbox', category = '', sourceAppId = '' } = {}) {
  const overlaid = overlayPending(rows, state?.pending);
  const filtered = overlaid.filter(row => {
    if (row.removed || row.dismissed) return false;
    if (category && row.category !== category) return false;
    if (sourceAppId && row.source.app_id !== sourceAppId) return false;
    if (view === 'archived') return row.archived;
    if (row.archived) return false;
    return view === 'unread' ? isUnreadRow(row) : true;
  });
  return filtered.sort((a, b) => b.occurred_ms - a.occurred_ms || (a.id < b.id ? 1 : -1));
}

export function unreadCount(rows, state) {
  return overlayPending(rows, state?.pending).filter(isUnreadRow).length;
}

// ---- worker-side reducer ---------------------------------------------------

const rowKey = (context, id) => `${context.key}|${id}`;

/** Stored rows only advance; replaying an old change is a no-op. */
async function putIfNewer(db, row) {
  const prior = await db.notification_items.get(row.key);
  if (prior && prior.change_seq > row.change_seq) return false;
  if (prior && prior.change_seq === row.change_seq && prior.row_version > row.row_version) return false;
  await db.notification_items.put({ ...row, partition: row.archived ? 'archived' : 'inbox', snapshot_gen: row.snapshot_gen ?? prior?.snapshot_gen ?? '' });
  return true;
}

function intentSatisfied(patch, row) {
  return Object.entries(patch).every(([key, value]) => Boolean(row[key]) === Boolean(value));
}

/** Observation-sensitive intents must not be blindly re-applied over newer server activity. */
function observationSensitive(patch) {
  return patch.read === true && !patch.dismissed && !patch.archived;
}

export async function applyNotificationInboxOperation(input, db = getWorkspaceDb()) {
  const { context } = input;
  return db.transaction('rw', db.notification_items, db.notification_inbox, async () => {
    const state = await db.notification_inbox.get(context.key) || emptyState(context);
    const upsert = async (rows) => { for (const row of rows) { if (row.removed) await db.notification_items.delete(row.key); else await putIfNewer(db, row); } };
    switch (input.action) {
      case 'snapshot_page': {
        if (input.first) state.snapshot = { gen: input.gen, seq: input.head_seq, partition: input.partition || 'inbox', started_at: input.inbox_started_at || '' };
        if (state.snapshot?.gen !== input.gen) break;
        await upsert(input.items.map(row => ({ ...row, snapshot_gen: input.gen })));
        break;
      }
      case 'snapshot_finish': {
        if (state.snapshot?.gen !== input.gen) break;
        const { seq, partition } = state.snapshot;
        // Rows the authoritative list no longer contains and nothing newer touched are gone.
        if (!input.partial) {
          const stale = await db.notification_items.where('context').equals(context.key)
            .filter(row => row.partition === partition && row.snapshot_gen !== input.gen && row.change_seq <= seq).primaryKeys();
          await db.notification_items.bulkDelete(stale);
        }
        if (partition === 'inbox') {
          state.ready = true;
          // The snapshot's head is the replay origin, even after a server restore moved the head backwards.
          state.local_seq = seq;
          state.activated_at = state.snapshot.started_at || state.activated_at || '';
          state.needs_snapshot = false;
        } else state.archived_hydrated = true;
        state.head_seq = partition === 'inbox' ? seq : state.head_seq;
        state.status = 'ok';
        state.error = '';
        state.snapshot = null;
        break;
      }
      case 'changes': {
        for (const change of input.changes) {
          const key = rowKey(context, change.id);
          const prior = await db.notification_items.get(key);
          if (prior && prior.change_seq > change.change_seq) continue; // idempotent replay
          if (change.removed) { await db.notification_items.delete(key); continue; }
          const row = change.row;
          if (row.dismissed) { await db.notification_items.delete(key); continue; }
          // Unknown items entering a partition that was never hydrated are ignored; the cursor still advances.
          if (!prior && row.archived && !state.archived_hydrated) continue;
          await putIfNewer(db, row);
        }
        state.local_seq = Math.max(state.local_seq, input.through_seq);
        state.head_seq = Math.max(state.head_seq, input.head_seq || 0);
        break;
      }
      case 'counts':
        state.counts = input.counts;
        if (input.counts?.inbox_started_at) state.activated_at = input.counts.inbox_started_at;
        break;
      case 'needs_snapshot':
        state.needs_snapshot = true;
        break;
      case 'status':
        state.status = input.status;
        state.error = input.error || '';
        state.retry_after = input.retry_after || 0;
        if (input.status !== 'ok') state.ready = state.ready && input.status !== 'forbidden';
        break;
      case 'heal':
        state.heal_after = input.heal_after;
        state.needs_snapshot = true;
        break;
      case 'begin_attempt': {
        const entry = state.pending.find(op => op.mutation_id === input.mutationId);
        if (entry && !entry.attempted) {
          if (entry.kind === 'item' && !(await db.notification_items.get(rowKey(context, entry.item_id)))) { state.pending = state.pending.filter(op => op !== entry); break; }
          entry.attempted = true;
        }
        break;
      }
      case 'ack': {
        const entry = state.pending.find(op => op.mutation_id === input.mutationId);
        state.pending = state.pending.filter(op => op.mutation_id !== input.mutationId);
        if (input.row) await upsert([input.row]);
        // A bulk acknowledgement is materialised locally until `changes` delivers the per-item truth.
        if (entry?.kind === 'bulk') {
          const rows = await db.notification_items.where('context').equals(context.key).toArray();
          for (const row of rows) {
            const next = applyBulk(row, entry);
            if (next !== row) await db.notification_items.put({ ...next, partition: next.archived ? 'archived' : 'inbox' });
          }
        }
        state.error = '';
        break;
      }
      case 'conflict': {
        const index = state.pending.findIndex(op => op.mutation_id === input.mutationId);
        if (input.row) await upsert([input.row]);
        if (index < 0) break;
        const entry = state.pending[index];
        const server = input.row;
        if (!server || server.removed || intentSatisfied(entry.patch, server)) state.pending.splice(index, 1);
        else if (observationSensitive(entry.patch) || (entry.conflicts || 0) >= MAX_CONFLICT_RETRIES) {
          state.pending.splice(index, 1);
          state.notice = 'A notification changed on another device or received newer activity, so it was left unread. Review it, then mark it read.';
        } else {
          // Idempotent intents (dismiss/archive/unread) are re-applied to the server's current row under a new identity.
          state.pending[index] = { ...entry, mutation_id: input.newMutationId, expected_row_version: server.row_version, observed_change_seq: server.change_seq, attempted: false, conflicts: (entry.conflicts || 0) + 1 };
        }
        break;
      }
      case 'reject': {
        state.pending = state.pending.filter(op => op.mutation_id !== input.mutationId);
        if (input.removeItemId) await db.notification_items.delete(rowKey(context, input.removeItemId));
        state.notice = input.notice || 'A notification change was not accepted and was discarded.';
        break;
      }
      case 'retry':
        state.error = 'Saved on this device; waiting to synchronize with Tower.';
        break;
      case 'clear_notice':
        state.notice = '';
        break;
      default:
        throw new Error(`Unknown notification inbox operation: ${input.action}`);
    }
    await db.notification_inbox.put(state);
    return state;
  });
}

// ---- main-thread intent queueing (offline-safe, mirrors private preferences) -

async function requireReady(db, context) {
  const state = await db.notification_inbox.get(context.key);
  if (!state?.ready) throw Object.assign(new Error('Connect to Tower to load notifications before changing them.'), { code: 'notification_not_ready' });
  if (state.pending.length >= MAX_PENDING) throw new Error('Too many unsynchronized notification changes. Reconnect to Tower and try again.');
  return state;
}

export async function queueNotificationPatch(db, context, itemId, patch) {
  const clean = Object.fromEntries(ITEM_PATCH_KEYS.filter(key => typeof patch?.[key] === 'boolean').map(key => [key, patch[key]]));
  if (!Object.keys(clean).length) throw new Error('Nothing to change.');
  return db.transaction('rw', db.notification_inbox, db.notification_items, async () => {
    const state = await requireReady(db, context);
    const open = state.pending.find(op => op.kind === 'item' && op.item_id === itemId && !op.attempted);
    // Coalesce into a not-yet-sent change for the same item; sent bodies stay immutable.
    if (open) Object.assign(open.patch, clean);
    else {
      // CAS against the version the user actually saw, never a version fetched later: a newer fold must conflict.
      const row = await db.notification_items.get(`${context.key}|${itemId}`);
      const behind = [...state.pending].reverse().find(op => op.kind === 'item' && op.item_id === itemId);
      const expected = behind ? (behind.expected_row_version ?? 0) + 1 : row?.row_version;
      if (!Number.isSafeInteger(expected)) throw new Error('That notification is no longer available.');
      state.pending.push({ kind: 'item', mutation_id: crypto.randomUUID(), item_id: itemId, patch: clean, expected_row_version: expected, observed_change_seq: behind ? undefined : row.change_seq, attempted: false, conflicts: 0, created_at: new Date().toISOString() });
    }
    state.error = '';
    await db.notification_inbox.put(state);
  });
}

/** Bulk intents carry the observed sequence boundary; newer concurrent items stay unread. */
export async function queueNotificationBulk(db, context, op, filters = {}) {
  if (!BULK_OPS.includes(op)) throw new Error('Unsupported bulk action.');
  return db.transaction('rw', db.notification_inbox, async () => {
    const state = await requireReady(db, context);
    const selector = { up_to_seq: state.local_seq, ...(filters.category ? { category: filters.category } : {}), ...(filters.source_app_id ? { source_app_id: filters.source_app_id } : {}), ...(filters.view === 'unread' ? { view: 'unread' } : {}) };
    state.pending.push({ kind: 'bulk', mutation_id: crypto.randomUUID(), op, selector, attempted: true, conflicts: 0, created_at: new Date().toISOString() });
    state.error = '';
    await db.notification_inbox.put(state);
    return selector.up_to_seq;
  });
}
