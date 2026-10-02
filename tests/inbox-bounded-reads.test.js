import { beforeEach, expect, it } from 'vitest';
import Dexie from 'dexie';
import { openWorkspaceDb, getChannelActivityWindow, getRecentChannelActivity, getOwnerActivityWindow } from '../src/db.js';
import { mapPgMessageToLocal, mapPgThreadToLocal, mapPgTaskToLocal } from '../src/pg-read-hydrator.js';
import { instrumentIndexedDb } from './helpers/indexeddb-metrics.js';
let db;
beforeEach(async () => { db = openWorkspaceDb('inbox-bounded'); await db.open(); await Promise.all(db.tables.map(table => table.clear())); });

it('bounds a 100000-reply channel and reads one Recent value despite newer metadata/archived rows', async () => {
  await db.channels.put({ record_id: 'channel', owner_npub: 'owner' });
  const options = { workspaceOwnerNpub: 'owner' };
  const thread = id => mapPgThreadToLocal({ id, channel_id: 'channel', title: id, updated_at: '2026-01-01T00:00:00Z' }, options);
  await db.chat_messages.bulkPut([thread('busy'), thread('quiet')]);
  const message = (id, threadId, updated_at, record_state) => mapPgMessageToLocal({ id, channel_id: 'channel', thread_id: threadId, body: id, updated_at, record_state }, options);
  for (let start = 0; start < 100000; start += 1000) {
    await db.chat_messages.bulkPut(Array.from({ length: 1000 }, (_, i) => message(`reply-${start + i}`, 'busy', '2026-03-01T00:00:00Z')));
  }
  await db.chat_messages.put(message('quiet-reply', 'quiet', '2026-02-01T00:00:00Z'));
  await db.chat_messages.bulkPut(Array.from({ length: 500 }, (_, i) => ({ ...thread(`archived-${i}`), updated_at: '2099-01-01T00:00:00Z', record_state: 'archived' })));
  const metrics = instrumentIndexedDb();
  try {
    const recent = await getRecentChannelActivity('owner');
    expect(recent).toHaveLength(1);
    expect(recent[0].pg_record_type).toBe('message');
    expect(metrics.snapshot().valueRowsRead).toBe(2); // channel + actual message
    const before = metrics.snapshot().valueRowsRead;
    const page = await getChannelActivityWindow(['channel'], { limit: 50, groupThreads: true });
    const initialValues = metrics.snapshot().valueRowsRead - before;
    expect(initialValues).toBeLessThan(220);
    // Filtering archived roots is bounded rather than draining 500 rows. The
    // explicit source window can be resumed/expanded to reach older roots.
    expect(page.hasMore).toBe(true);
    const expanded = await getChannelActivityWindow(['channel'], { limit: 550, groupThreads: true });
    expect(expanded.rows.some(row => row.record_id === 'quiet-reply')).toBe(true);
    expect(metrics.snapshot().valueRowsRead - before).toBeLessThan(2500);
    console.info(JSON.stringify({ replyHistory: 100000, recentValues: before, initialValues, expandedValues: metrics.snapshot().valueRowsRead - before - initialValues }));
  } finally { metrics.restore(); }
}, 120000);

it('uses native sparse task/document scope prefixes and limits content candidates before filtering', async () => {
  const task = (id, scope) => mapPgTaskToLocal({ id, scope_id: scope, title: 'task', updated_at: '2026-01-01T00:00:00Z', state: 'ready' }, { workspaceOwnerNpub: 'owner' });
  await db.tasks.bulkPut(Array.from({ length: 10000 }, (_, i) => task(`other-${i}`, 'elsewhere')));
  await db.tasks.put(task('wanted', 'wanted'));
  await db.documents.bulkPut(Array.from({ length: 10000 }, (_, i) => ({ record_id: `doc-${i}`, owner_npub: 'owner', scope_id: 'elsewhere', updated_at: '2026-01-01', title: 'unrelated' })));
  await db.documents.put({ record_id: 'wanted-doc', owner_npub: 'owner', scope_id: 'wanted', updated_at: '2000-01-01', title: 'wanted' });
  const metrics = instrumentIndexedDb();
  try {
    const tasks = await getOwnerActivityWindow('tasks', 'owner', { limit: 50, scopeIds: ['wanted'], matches: () => true });
    expect(tasks.rows.map(row => row.record_id)).toEqual(['wanted']);
    const docs = await getOwnerActivityWindow('documents', 'owner', { limit: 50, scopeIds: ['wanted'], matches: () => true });
    expect(docs.rows.map(row => row.record_id)).toEqual(['wanted-doc']);
    expect(metrics.snapshot().valueRowsRead).toBe(2);
    const empty = await getOwnerActivityWindow('documents', 'owner', { limit: 50, matches: () => false });
    expect(empty.rows).toEqual([]); expect(empty.hasMore).toBe(true);
    expect(metrics.snapshot().valueRowsRead).toBe(53);
  } finally { metrics.restore(); }
}, 60000);

it('upgrades an ownerless v25 cache without losing messages, commands, drafts or cursor', async () => {
  const key = 'inbox-v25-upgrade';
  const old = new Dexie(`wingman-fd-ws-${key}`);
  old.version(25).stores({ chat_messages: 'record_id,channel_id', documents: 'record_id', comments: 'record_id',
    pending_writes: '++row_id,record_id', sync_state: 'key', document_drafts: 'draft_key' });
  await old.open();
  await old.chat_messages.put({ record_id: 'cached', channel_id: 'channel', pg_record_type: 'message', body: 'keep', updated_at: '2026-01-01' });
  await old.pending_writes.add({ record_id: 'cached', envelope: { body: 'pending' } });
  await old.sync_state.put({ key: 'cursor', value: 'keep' });
  await old.document_drafts.put({ draft_key: 'draft', body: 'keep draft' });
  old.close();
  const upgraded = openWorkspaceDb(key); await upgraded.open();
  expect(upgraded.verno).toBe(32);
  expect(upgraded.pipeline_viewer_snapshots).toBeTruthy();
  expect(upgraded.pipeline_viewer_state).toBeTruthy();
  expect(upgraded.feed_subscriptions).toBeTruthy();
  expect(upgraded.feed_item_states).toBeTruthy();
  expect(upgraded.autopilot_connections).toBeTruthy();
  expect(upgraded.workspace_agents).toBeTruthy();
  expect((await getChannelActivityWindow(['channel'])).rows[0].body).toBe('keep');
  expect((await upgraded.chat_messages.get('cached')).owner_npub).toBeUndefined();
  expect(await upgraded.pending_writes.count()).toBe(1);
  expect((await upgraded.sync_state.get('cursor')).value).toBe('keep');
  expect((await upgraded.document_drafts.get('draft')).body).toBe('keep draft');
  upgraded.close(); await Dexie.delete(`wingman-fd-ws-${key}`);
});
