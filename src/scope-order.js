import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { getWorkspaceDb } from './db.js';
import { getTowerPgScopeOrder } from './api.js';
import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';

export function sortScopesPersonally(scopes = [], order = []) {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...scopes].sort((a, b) => (positions.get(a.record_id) ?? Infinity) - (positions.get(b.record_id) ?? Infinity));
}
export function mapScopeOrder(row) {
  if (!row?.workspace_id || !row.actor_id || !Array.isArray(row.scope_ids) || !Number.isSafeInteger(row.row_version)) throw new Error('Invalid personal scope order');
  return { ...row, record_id: row.actor_id, scope_ids: [...row.scope_ids], sync_status: 'synced' };
}
export async function hydrateScopeOrder(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  const actorId = resolvePgReaderActorId(store);
  const generation = store._workspaceSelectionGeneration;
  const result = await getTowerPgScopeOrder(context.workspaceId, context);
  if (generation !== store._workspaceSelectionGeneration || resolveTowerPgWorkspaceContext(store).workspaceId !== context.workspaceId) throw new Error('Scope order workspace changed');
  const row = mapScopeOrder(result.scope_order);
  if (!actorId || row.actor_id !== actorId || resolvePgReaderActorId(store) !== actorId || row.workspace_id !== context.workspaceId) throw new Error('Scope order reader changed');
  const db = getWorkspaceDb();
  await db.transaction('rw', db.scope_orders, async () => {
    const prior = await db.scope_orders.get(row.record_id);
    if (!prior || prior.row_version <= row.row_version) await db.scope_orders.put(row);
  });
  return row;
}
