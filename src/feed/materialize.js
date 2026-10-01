import { getWorkspaceDb } from '../db.js';
import { resolveTowerPgWorkspaceContext } from '../pg-read-hydrator.js';
import { resolvePgReaderActorId } from '../pg-reader-identity.js';
const readerContext = store => ({ ...resolveTowerPgWorkspaceContext(store), readerActorId: resolvePgReaderActorId(store) });
import { inboundFeedReaderRow } from '../translators/feed-reader.js';
import { feedContextKey, putFeedRows } from './store.js';
// Existing service-owned SSE materialisation path calls this; no network owner.
export async function materializeFeedReaderEvent(store, event) {
  const c = readerContext(store);
  const state = event.entity_type === 'feed_item_state';
  const row = inboundFeedReaderRow(event.payload, c, state), context = feedContextKey(c);
  const current = () => { const n = readerContext(store); if (n.baseUrl !== c.baseUrl || n.workspaceId !== c.workspaceId || n.generation !== c.generation || n.readerActorId !== c.readerActorId) throw new Error('feed_disposed'); };
  await putFeedRows(getWorkspaceDb(), state ? 'feed_item_states' : 'feed_subscriptions', context, [row], current);
}
