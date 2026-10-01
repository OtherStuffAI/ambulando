import { getWorkspaceDb } from '../db.js';
import { resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';
import { inboundFeedReaderRow } from '../translators/feed-reader.js';
import { feedContextKey, putFeedRows } from './store.js';
// Existing service-owned SSE materialisation path calls this; no network owner.
export async function materializeFeedReaderEvent(store, event) {
  const c = { ...resolveTowerPgWorkspaceContext(store), readerActorId: store.currentWorkspaceActorId || store.pgActorId || store.currentActorId || '' };
  const state = event.entity_type === 'feed_item_state';
  const row = inboundFeedReaderRow(event.payload, c, state), context = feedContextKey(c);
  const current = () => { const n = resolveTowerPgWorkspaceContext(store); if (n.baseUrl !== c.baseUrl || n.workspaceId !== c.workspaceId || n.generation !== c.generation || (store.currentWorkspaceActorId || store.pgActorId || store.currentActorId || '') !== c.readerActorId) throw new Error('feed_disposed'); };
  await putFeedRows(getWorkspaceDb(), state ? 'feed_item_states' : 'feed_subscriptions', context, [row], current);
}
