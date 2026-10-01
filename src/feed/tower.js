import { inboundFeedReaderRow } from '../translators/feed-reader.js';
import { towerPgFeedRequest } from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';
import { feedContextKey, feedRowKey, putFeedRows } from './store.js';
export function readerContext(store) {
  const c = resolveTowerPgWorkspaceContext(store);
  return { ...c, readerActorId: store.currentWorkspaceActorId || store.pgActorId || store.currentActorId || '' };
}
const validateReaderRow = inboundFeedReaderRow;
export async function hydrateFeedReader(store, { request = towerPgFeedRequest, db = getWorkspaceDb(), replay = true } = {}) {
  const c = readerContext(store), context = feedContextKey(c), generation = c.generation;
  if (!c.readerActorId) throw new Error('reader_identity_required');
  const current = () => { if (feedContextKey(readerContext(store)) !== context || readerContext(store).generation !== generation) throw new Error('feed_disposed'); };
  const readPages = async (suffix, field, state = false) => {
    const seen = new Set(), rows = []; let cursor;
    do {
      current(); const page = await request(c.workspaceId, suffix, { ...c, cursor }); current();
      if (!Array.isArray(page[field]) || !(page.next_cursor === null || typeof page.next_cursor === 'string') || page[field].length > 200) throw new Error('invalid_reader_page');
      for (const row of page[field]) rows.push(validateReaderRow(row, c, state));
      cursor = page.next_cursor;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('reader_pagination_bound'); if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  };
  const subs = await readPages('', 'subscriptions');
  await putFeedRows(db, 'feed_subscriptions', context, subs, current);
  for (const sub of subs) await putFeedRows(db, 'feed_item_states', context, await readPages(`/${encodeURIComponent(sub.id)}/item-states`, 'item_states', true), current);
  if (replay && typeof store.commandTowerWorkspace === 'function') {
    const intents = await db.feed_commands.where('context').equals(context).toArray();
    for (const intent of intents) {
      current(); const sub = subs.find(s => s.id === intent.subscription_id);
      if (!sub || sub.status !== 'active') { await db.feed_commands.delete(intent.mutation_id); continue; }
      try { await store.commandTowerWorkspace('feed-state.patch', intent.input, { clientMutationId: intent.input.body.mutation_id }); } catch { /* Pending original-partition intent remains visible. */ }
    }
  }
  return { subscriptions: subs.length };
}
export function prepareFeedCommand(store, name, input, { request = towerPgFeedRequest, db = getWorkspaceDb() } = {}) {
  const c = readerContext(store), context = feedContextKey(c), generation = c.generation;
  const current = () => { if (feedContextKey(readerContext(store)) !== context || readerContext(store).generation !== generation) throw new Error('feed_disposed'); };
  const queueId = input.queueId || input.body.mutation_id;
  let body = structuredClone(input.body), suffix = input.subscriptionId ? `/${encodeURIComponent(input.subscriptionId)}` : '';
  const state = name === 'feed-state.patch';
  if (state) suffix += '/item-states';
  const method = state ? 'PUT' : name === 'feed-subscription.create' ? 'POST' : 'PATCH';
  return { entityKey: state ? feedRowKey(context, input.subscriptionId, body.item_id) : `feed-subscription:${input.subscriptionId || JSON.stringify(body.source)}`,
    optimistic: state ? async () => { current(); await db.feed_commands.put({ mutation_id: queueId, context, subscription_id: input.subscriptionId, input: { ...structuredClone(input), queueId } }); } : undefined,
    execute: async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        current();
        try { return await request(c.workspaceId, suffix, { ...c, method, body }); }
        catch (e) {
          if (!state || e.status !== 409 || e.code === 'mutation_id_reused') throw e;
          await hydrateFeedReader(store, { request, db, replay: false }); current();
          const sub = await db.feed_subscriptions.get(feedRowKey(context, input.subscriptionId));
          if (sub?.status !== 'active') throw new Error('subscription_unsubscribed');
          const latest = await db.feed_item_states.get(feedRowKey(context, input.subscriptionId, body.item_id));
          body = { ...body, expected_row_version: latest?.row_version || 0, mutation_id: crypto.randomUUID() };
          await db.feed_commands.put({ mutation_id: queueId, context, subscription_id: input.subscriptionId, input: { ...structuredClone(input), body: structuredClone(body), queueId } });
        }
      }
      throw new Error('state_conflict');
    },
    reconcile: async result => { current(); const row = validateReaderRow(state ? result.item_state : result.subscription, c, state); await putFeedRows(db, state ? 'feed_item_states' : 'feed_subscriptions', context, [row], current); if (state) await db.feed_commands.delete(queueId); return result; },
    fail: state ? async e => {
      current();
      if ([400, 401, 403, 404, 409].includes(e.status) || ['subscription_unsubscribed', 'state_conflict'].includes(e.message)) await db.feed_commands.delete(queueId);
    } : undefined,
  };
}
