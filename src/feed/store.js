export const feedContextKey = c => JSON.stringify([c.baseUrl, c.workspaceId, c.readerActorId]);
export const feedSourceKey = s => JSON.stringify(s.kind === 'wapp' ? [s.kind, s.autopilot_connection_id, s.installation_id, s.feed_id] : [s.kind, s.url]);
export const feedRowKey = (context, subscription, item = '') => JSON.stringify([context, subscription, item]);
export async function putFeedRows(db, table, context, rows, assertCurrent = () => {}) {
  await db.transaction('rw', db[table], async () => {
    assertCurrent();
    for (const row of rows) {
      const key = feedRowKey(context, row.subscription_id || row.id, table === 'feed_item_states' ? row.item_id : '');
      const prior = await db[table].get(key);
      if (!prior || prior.row_version <= row.row_version) await db[table].put({ ...row, key, context });
    }
  });
}
export async function purgePrivateFeedBodies(db, context, subscriptionId = '') {
  await db.transaction('rw', db.feed_items, async () => {
    await db.feed_items.where('context').equals(context).filter(r => r.private && (!subscriptionId || r.subscription_id === subscriptionId)).delete();
  });
}
export async function feedProjection(db, context) {
  const [subscriptions, states, bodies, statuses, commands] = await Promise.all(['feed_subscriptions', 'feed_item_states', 'feed_items', 'feed_source_status', 'feed_commands'].map(t => db[t].where('context').equals(context).toArray()));
  const active = new Map(subscriptions.filter(s => s.status === 'active').map(s => [s.id, s]));
  const flags = new Map(states.map(s => [feedRowKey(context, s.subscription_id, s.item_id), s]));
  const intents = new Map(); for (const command of commands) { const i = command.input; const k = feedRowKey(context, i.subscriptionId, i.body.item_id); intents.set(k, { ...intents.get(k), ...i.body.patch, pending: true }); }
  return { subscriptions, statuses, items: bodies.filter(b => active.has(b.subscription_id)).map(b => ({ ...b, source_title: active.get(b.subscription_id).title || b.source_title, read: false, dismissed: false, saved: false, ...flags.get(b.key), ...intents.get(b.key), id: b.id, key: b.key })).sort((a, b) => String(b.published).localeCompare(String(a.published)) || a.key.localeCompare(b.key)) };
}
