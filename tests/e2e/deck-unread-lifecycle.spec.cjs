const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Real browser IndexedDB and production selection/projection code. Synthetic
// records only; no backend writes or changes to a user's browser database.
test('Deck keeps unread completed work across visits and reload until explicitly read', async ({ page, baseURL }) => {
  const bundle = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
      export { openWorkspaceDb, upsertResourceViewState } from './src/db.js';
      export { applyPgRecordChanges, getPgAttentionProjection } from './src/pg-record-delta.js';
      export { queryInboxSource } from './src/section-live-queries.js';
      export { buildAutopilotOverviewTasks, buildAutopilotOverviewInbox } from './src/autopilot-overview-manager.js';
      export { unreadStoreMixin } from './src/unread-store.js';` } });
  const origin = new URL(baseURL).origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html',
      body: url.pathname.endsWith('.js') ? bundle.outputFiles[0].text : '<title>Deck unread lifecycle probe</title>' });
  });
  await page.goto(`${origin}/__deck-unread`);
  const key = `deck-unread-${Date.now()}`;
  const seed = await page.evaluate(async ({ fixture, key }) => {
    const m = await import('/__deck-unread.js');
    const db = m.openWorkspaceDb(key); await db.open();
    const change = fixture.canonical_upserts.changes.find(row => row.family === 'task');
    const store = { workspaceId: change.workspace_id, workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: change.workspace_id }, session: { npub: 'npub1viewer' } };
    await m.applyPgRecordChanges(store, fixture.canonical_upserts);
    await m.applyPgRecordChanges(store, { ...fixture.one_message_delta, next_cursor: 'while-away', changes: [
      { ...change, version: '200', row: { ...change.row, row_version: 200, state: 'done', activity_version: 10,
        metadata: { assigned_to_npub: store.session.npub }, assigned_to_npub: store.session.npub,
        attention: { policy_version: 1, last_activity_actor_id: 'another-reader', mention_activity_versions: {} } } },
    ] });
    return { store, id: change.id, channel: change.row.channel_id,
      tasks: await db.tasks.toArray(), views: await db.resource_view_states.toArray(), sync: await db.sync_state.toArray() };
  }, { fixture, key });
  const visit = () => page.evaluate(async ({ key, seed }) => {
    const m = await import('/__deck-unread.js');
    const db = m.openWorkspaceDb(key); await db.open();
    const context = { ...seed.store, deckInboxType: 'task',
      autopilotOverviewContext: { scopeId: 'all', channelId: seed.channel } };
    const source = await m.queryInboxSource(context, 'npub1owner', 'tasks');
    const store = { ...seed.store, tasks: source.rows };
    m.unreadStoreMixin.applyPgAttentionProjection.call(store, await m.getPgAttentionProjection(store));
    const cards = m.buildAutopilotOverviewInbox({ tasks: m.buildAutopilotOverviewTasks({ tasks: source.rows, unreadTaskMap: store._unreadTaskItems }) });
    const other = await m.queryInboxSource({ ...context, autopilotOverviewContext: { scopeId: 'all', channelId: 'unaffected' } }, 'npub1owner', 'tasks');
    return { unread: Boolean(store._unreadChannels[seed.channel]), cards: cards.map(row => ({ id: row.recordId, unread: row.isUnread })),
      other: other.rows.length, tasks: await db.tasks.toArray(), views: await db.resource_view_states.toArray(), sync: await db.sync_state.toArray() };
  }, { key, seed });
  for (let i = 0; i < 2; i++) {
    const result = await visit();
    expect(result).toMatchObject({ unread: true, cards: [{ id: seed.id, unread: true }], other: 0,
      tasks: seed.tasks, views: seed.views, sync: seed.sync });
    await page.reload();
  }
  await page.evaluate(async ({ key, seed }) => {
    const m = await import('/__deck-unread.js'); const db = m.openWorkspaceDb(key); await db.open();
    await m.upsertResourceViewState({ resource_type: 'task', resource_id: seed.id, channel_id: seed.channel,
      activity_version: 10, viewed_activity_version: 10 });
  }, { key, seed });
  const dismissed = await visit();
  expect(dismissed).toMatchObject({ unread: false, cards: [], other: 0, tasks: seed.tasks, sync: seed.sync });
  console.log('Deck unread browser evidence:', JSON.stringify({ visits: 2, reloads: 2, unreadBeforeRead: true,
    unreadAfterRead: dismissed.unread, cardsAfterRead: dismissed.cards.length, downloadsPreserved: true, unaffectedChannelCards: dismissed.other }));
});
