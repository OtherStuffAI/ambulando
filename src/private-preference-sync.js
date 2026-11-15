import { towerPgPrivatePreference } from './api.js';
import { getWorkspaceDb } from './db.js';
import { privatePreferenceContext, NOSTR_VIEWER_KEY, PRIVATE_PREFERENCE_KEYS, preferenceStorageKey } from './private-preference-store.js';
export async function synchronizePrivatePreferences(store, { db = getWorkspaceDb(), transport = towerPgPrivatePreference } = {}) {
  const service = store.getTowerSyncService();
  if (!service) return;
  const rootContext = privatePreferenceContext(store);
  return service.coalesce(`private-preferences:${rootContext.key}`, async () => {
    const results = await Promise.allSettled(PRIVATE_PREFERENCE_KEYS.map(async preferenceKey => {
      const context = { ...rootContext, preferenceKey };
      const current = () => !service.disposed && privatePreferenceContext(store).key === context.key && (store._workspaceSelectionGeneration || 0) === context.generation;
      const materialize = async input => {
        if (!current()) return;
        return service.materialize('workspace-bundle', { private_preference_operation: { ...input, context: { key: context.key, workspaceId: context.workspaceId, actorId: context.actorId, preferenceKey } } }, { workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot() });
      };
      const request = body => transport(context.workspaceId, preferenceKey, { ...context, signal: service.readAbortController.signal, ...(body ? { body } : {}) });
      const read = async () => {
        const result = await request();
        if (!current()) return false;
        if (result.identity?.workspace_id !== context.workspaceId || !Object.hasOwn(result, 'preference')) throw new Error('Invalid preference identity');
        await materialize({ action: 'read', row: result.preference });
        return current();
      };
      if (!await read()) return;
      // Only the first signed-in context on this browser may adopt the unscoped legacy setting.
      const legacy = preferenceKey === NOSTR_VIEWER_KEY && store.readLegacyNostrViewer?.(context.key);
      if (legacy) await materialize({ action: 'import', value: legacy, mutationId: crypto.randomUUID() });
      const state = await db.private_preferences.get(preferenceStorageKey(context));
      for (const body of state?.pending || []) {
        if (!current()) return;
        if (!(await db.private_preferences.get(preferenceStorageKey(context)))?.pending.some(op => op.mutation_id === body.mutation_id)) continue;
        try {
          const result = await request(body);
          if (!current()) return;
          if (result.identity?.workspace_id !== context.workspaceId) throw new Error('Invalid preference identity');
          await materialize({ action: 'ack', mutationId: body.mutation_id, row: result.preference });
        } catch (error) {
          if (!current()) return;
          const permanent = [400,403,404,409].includes(error.status);
          await materialize({ action: permanent ? 'reject' : 'retry', mutationId: body.mutation_id });
          if (permanent) await read();
          return;
        }
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}
