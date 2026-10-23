import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { getWorkspaceDb } from './db.js';
import { getTowerPgScopeOrder } from './api.js';
import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';

export function sortScopesPersonally(scopes = [], order = [], getId = scope => scope.record_id) {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...scopes].sort((a, b) => (positions.get(getId(a)) ?? Infinity) - (positions.get(getId(b)) ?? Infinity));
}
export function mapScopeOrder(row) {
  if (!row?.workspace_id || !row.actor_id || !Array.isArray(row.scope_ids) || !Number.isSafeInteger(row.row_version)) throw new Error('Invalid personal scope order');
  return { ...row, record_id: row.actor_id, scope_ids: [...row.scope_ids], sync_status: 'synced' };
}

// Keep a read or acknowledgement tied to its initiating reader and DB handle.
// A workspace switch must never materialize a response into the new database.
export function captureScopeOrderSession(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  const actorId = resolvePgReaderActorId(store);
  const db = getWorkspaceDb();
  if (!actorId) throw new Error('Scope order reader is not ready. Reopen Scope Management and try again.');
  const assertCurrent = () => {
    const current = resolveTowerPgWorkspaceContext(store);
    if (current.generation !== context.generation || current.workspaceId !== context.workspaceId
      || current.baseUrl !== context.baseUrl || current.appNpub !== context.appNpub || getWorkspaceDb() !== db) throw new Error('Scope order workspace changed');
    if (current.sessionNpub !== context.sessionNpub || resolvePgReaderActorId(store) !== actorId) throw new Error('Scope order reader changed');
  };
  return {
    context, assertCurrent,
    async materialize(value) {
      assertCurrent();
      const row = mapScopeOrder(value);
      if (row.actor_id !== actorId || row.workspace_id !== context.workspaceId) throw new Error('Scope order acknowledgement identity changed');
      await db.transaction('rw', db.scope_orders, async () => {
        assertCurrent();
        const prior = await db.scope_orders.get(row.record_id);
        if (!prior || prior.row_version <= row.row_version) await db.scope_orders.put(row);
      });
      assertCurrent();
      return row;
    },
  };
}

export async function hydrateScopeOrder(store) {
  const session = captureScopeOrderSession(store);
  const result = await getTowerPgScopeOrder(session.context.workspaceId, session.context);
  return session.materialize(result.scope_order);
}
