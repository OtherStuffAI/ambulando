import { putPersonalThreadPin } from './tower-command-intents.js';
import { getSettings, getWorkspaceDb } from './db.js';
import { threadPinContext, threadPinSupportKey } from './thread-pin-store.js';
import { postTowerPgPersonalPinOrder, putTowerPgPersonalPin } from './api.js';

async function materialize(store, input) {
  return store.getTowerSyncService().materialize('workspace-bundle', { thread_pin_operation: input }, {
    workspaceDbKey: store.workspaceDbKey, store: store.buildTowerPgMaterializationStoreSnapshot(),
  });
}
export function prepareThreadPinCommand(store, input) {
  const context = threadPinContext(store);
  if (context.key !== input.context) throw new Error('Pin reader changed');
  return {
    entityKey: `thread-pin:${context.key}:${input.seq}`,
    execute: () => input.kind === 'order' ? postTowerPgPersonalPinOrder(context.workspaceId, input.body, context) : putTowerPgPersonalPin(context.workspaceId, input.resourceType || 'thread', input.threadId, input.body, context),
    reconcile: async result => {
      await materialize(store, { action: 'ack', seq: input.seq, mutationId: input.body.mutation_id, pin: result.pin, pins: result.pins });
      return result;
    },
  };
}
export async function synchronizeThreadPins(store) {
  const service = store.getTowerSyncService();
  if (!service || !store.pinnedThreadsPartition) return;
  return service.coalesce('thread-pins:flush', async () => {
    const context = threadPinContext(store);
    const db = getWorkspaceDb();
    if ((await db.sync_state.get(threadPinSupportKey(context)))?.value !== true) return;
    const partition = store.pinnedThreadsPartition;
    const generation = store._workspaceSelectionGeneration;
    const current = () => !service.disposed && generation === store._workspaceSelectionGeneration && threadPinContext(store).key === context.key;
    const settings = await getSettings();
    if (!current()) return;
    await materialize(store, { action: 'migrate', partition, pins: settings?.threadPins?.[partition] || {} });
    const queue = await db.thread_pin_outbox.where('context').equals(context.key).sortBy('seq');
    for (const op of queue) {
      if (!current()) return;
      if (!await db.thread_pin_outbox.get(op.seq)) continue;
      try {
        await putPersonalThreadPin(store, op);
      } catch (error) {
        if (!current()) return;
        const permanent = [400,403,404,409].includes(error.status);
        await materialize(store, { action: permanent ? 'reject' : 'retry', seq: op.seq, mutationId: op.body.mutation_id,
          error: error.code === 'pin_order_conflict' ? 'Pin order changed on another device. The latest saved order was kept; move the item again to change it.' : error.code === 'thread_pin_conflict' ? 'This pin changed on another device. The latest saved state was kept; pin or unpin again to change it.' : 'Could not synchronize this pin. Refresh the workspace and try again.' });
        if (!permanent) return;
        // Recovery belongs to the existing cursor owner; do not rebase stale intent.
        void store.runTowerPgWorkspaceSync({ afterCurrent: true }).catch(() => {});
      }
    }
  });
}
