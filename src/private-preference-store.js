import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';
import { getWorkspaceDb } from './db.js';
export function privatePreferenceContext(store) {
  const { baseUrl, appNpub, workspaceId, generation } = resolveTowerPgWorkspaceContext(store);
  const actorId = resolvePgReaderActorId(store);
  if (!workspaceId || !actorId || (store.currentViewerNpub && store.currentViewerNpub !== store.session?.npub)) throw new Error('Sign in and finish workspace synchronization before changing private preferences.');
  return { baseUrl, appNpub, workspaceId, actorId, generation, key: JSON.stringify([baseUrl, appNpub, workspaceId, actorId]) };
}
export const NOSTR_VIEWER_KEY = 'ambulando.nostr-viewer';
export const preferenceStorageKey = context => `${context.key}:${NOSTR_VIEWER_KEY}`;
export function mapPrivatePreference(row, context) {
  if (!row || row.workspace_id !== context.workspaceId || row.actor_id !== context.actorId || row.preference_key !== NOSTR_VIEWER_KEY
    || typeof row.value !== 'string' || !Number.isSafeInteger(row.row_version) || row.row_version < 1) throw new Error('Invalid private preference response');
  return row;
}
// Worker-owned reconciliation. Pending requests stay immutable across uncertain retries.
export async function applyPrivatePreferenceOperation(input, db = getWorkspaceDb()) {
  const { context } = input, key = preferenceStorageKey(context);
  return db.transaction('rw', db.private_preferences, async () => {
    const state = await db.private_preferences.get(key) || { key, context: context.key, row: null, pending: [], ready: false };
    if (input.action === 'read') {
      const row = input.row === null ? null : mapPrivatePreference(input.row, context);
      if (row && (!state.row || row.row_version >= state.row.row_version)) state.row = row;
      // Absence never erases a previously acknowledged value.
      state.ready = true;
    } else if (input.action === 'ack') {
      const row = mapPrivatePreference(input.row, context);
      if (!state.row || row.row_version >= state.row.row_version) state.row = row;
      state.pending = state.pending.filter(op => op.mutation_id !== input.mutationId);
      state.error = '';
    } else if (input.action === 'reject') {
      const index = state.pending.findIndex(op => op.mutation_id === input.mutationId);
      if (index >= 0) state.pending.splice(index);
      state.error = 'This preference changed on another device. The saved choice was kept; save again to change it.';
    } else if (input.action === 'retry') {
      state.error = 'Saved on this device; waiting to synchronize with Tower.';
    } else if (input.action === 'import' && state.ready && !state.row && !state.pending.length && input.value) {
      state.pending.push({ value: input.value, expected_row_version: 0, mutation_id: input.mutationId, import_only: true });
    }
    await db.private_preferences.put(state);
    return state;
  });
}
export async function queuePrivatePreference(db, context, value) {
  const key = preferenceStorageKey(context);
  return db.transaction('rw', db.private_preferences, async () => {
    const state = await db.private_preferences.get(key);
    if (!state?.ready) throw new Error('Connect to Tower before saving this preference for the first time.');
    const last = state.pending.at(-1);
    state.pending.push({ value, expected_row_version: last ? last.expected_row_version + 1 : state.row?.row_version || 0, mutation_id: crypto.randomUUID() });
    state.error = '';
    await db.private_preferences.put(state);
  });
}
