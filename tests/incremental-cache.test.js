import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { openWorkspaceDb, getMessagePresentationWindowByChannel, getMessagePresentationWindowByChannels, replacePgMessagesForChannel, replacePgTasksForChannel, getCommentsByTarget } from '../src/db.js';
let db;
const row = (id, patch = {}) => ({ record_id: id, channel_id: 'channel', updated_at: '2026-09-05T00:00:00.000Z', version: 1, sync_status: 'synced', pg_backend: true, ...patch });
beforeEach(async () => {
  db = openWorkspaceDb('incremental-cache-tests');
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});
describe('indexed incremental cache', () => {
  it('reads incoming identities only and performs no writes on replay', async () => {
    await db.chat_messages.bulkPut(Array.from({length:1000}, (_, i) => row(`m${i}`)));
    const all = vi.spyOn(db.chat_messages, 'where');
    expect(await replacePgMessagesForChannel('channel', [row('m500', { version: 2, body: 'edit' })])).toBe(1);
    expect(all.mock.calls.some(([index]) => index === 'channel_id')).toBe(false);
    expect(await replacePgMessagesForChannel('channel', [row('m500', { version: 2, body: 'edit' })])).toBe(0);
    expect(await replacePgMessagesForChannel('channel', [row('m500')])).toBe(0);
    expect(await db.chat_messages.count()).toBe(1000);
    all.mockRestore();
  });
  it('keeps partial task omissions, pending writes and failed rows', async () => {
    await db.tasks.bulkPut([row('t1', {pg_channel_id:'channel'}), row('pending', {sync_status:'pending',pg_channel_id:'channel'}), row('failed',{sync_status:'failed',pg_channel_id:'channel'})]);
    await db.pending_writes.add({ record_id:'pending', envelope:{local:true} });
    expect(await replacePgTasksForChannel('channel', [row('t1',{pg_channel_id:'channel', version:2})])).toBe(1);
    expect(await replacePgTasksForChannel('channel', [])).toBe(0);
    expect(await db.tasks.count()).toBe(3);
    expect(await db.pending_writes.count()).toBe(1);
  });
  it('does not erase unchanged included rows during complete reconciliation', async () => {
    await replacePgMessagesForChannel('channel', [row('keep'),row('omit')]);
    await replacePgMessagesForChannel('channel', [row('keep')], {authoritative:true});
    expect(await db.chat_messages.toCollection().primaryKeys()).toEqual(['keep', 'omit']);
  });
  it('replaces optimistic identities exactly once without channel scans', async () => {
    await db.chat_messages.put(row('local', {sync_status:'pending'}));
    const canonical=row('server',{pg_client_record_id:'local'});
    expect(await replacePgMessagesForChannel('channel',[canonical])).toBe(2);
    expect(await replacePgMessagesForChannel('channel',[canonical])).toBe(0);
    expect(await db.chat_messages.toCollection().primaryKeys()).toEqual(['server']);
  });
  it('bounds huge threads and pages identical root timestamps without skipping IDs', async () => {
    await db.chat_messages.bulkPut([...Array.from({length:100},(_,i)=>row(`root-${String(i).padStart(3,'0')}`)),...Array.from({length:2000},(_,i)=>row(`reply-${i}`,{parent_message_id:'root-099'}))]);
    const page=await getMessagePresentationWindowByChannel('channel',{rootLimit:10,replyLimit:6});
    expect(page.length).toBeLessThanOrEqual(18);
    const roots=page.filter(r=>!r.parent_message_id);
    const next=await getMessagePresentationWindowByChannel('channel',{rootLimit:10,replyLimit:6,before:{timestamp:roots[0].updated_at,recordId:roots[0].record_id}});
    expect(next.some(r=>roots.some(old=>old.record_id===r.record_id))).toBe(false);
    const aggregate=await getMessagePresentationWindowByChannels(['channel','channel'],{rootLimit:10,replyLimit:6});
    expect(aggregate.length).toBeLessThanOrEqual(18);
  });
  it('pages comments by timestamp and identity', async () => {
    await db.comments.bulkPut(Array.from({length:1000},(_,i)=>row(`c${String(i).padStart(4,'0')}`,{target_record_id:'task'})));
    const page=await getCommentsByTarget('task',{limit:20});
    const last=page.at(-1);
    const next=await getCommentsByTarget('task',{limit:20,before:{timestamp:last.updated_at,recordId:last.record_id}});
    expect(page.length).toBe(20);expect(next.length).toBe(20);
    expect(new Set([...page,...next].map(r=>r.record_id)).size).toBe(40);
  });
  it('upgrades cached rows and preserves commands and the legacy cursor', async () => {
    const name='wingman-fd-ws-incremental-migration';
    const old=new Dexie(name);
    old.version(24).stores({chat_messages:'record_id, channel_id, parent_message_id, sync_status, updated_at, [channel_id+updated_at]',pending_writes:'++row_id, record_id',sync_state:'key'});
    await old.open();await old.table('chat_messages').put(row('cached'));await old.table('pending_writes').add({record_id:'cached'});await old.table('sync_state').put({key:'legacy',value:'cursor'});
    const upgraded=openWorkspaceDb('incremental-migration');await upgraded.open();
    expect(old.isOpen()).toBe(false);
    expect((await getMessagePresentationWindowByChannel('channel')).map(r=>r.record_id)).toEqual(['cached']);
    expect(await upgraded.pending_writes.count()).toBe(1);expect((await upgraded.sync_state.get('legacy')).value).toBe('cursor');
    await upgraded.delete();
  });
});

it('indexes every supported task sort with fixed pages and separate exact counts',async()=>{
  const {getTaskBoardWindow}=await import('../src/db.js');
  const {TASK_INDEX_SORT_MODES,compareIndexedTasks}=await import('../src/task-index-keys.js');
  const tasks=Array.from({length:1000},(_,i)=>row(`t${String(i).padStart(4,'0')}`,{owner_npub:'owner',pg_channel_id:'channel',scope_id:'scope',state:'ready',title:`Task ${1000-i}`,created_at:new Date(1700000000000+i*1000).toISOString(),board_order:i%5}));
  await db.tasks.bulkPut(tasks);
  for(const sortMode of TASK_INDEX_SORT_MODES) {
    const page=await getTaskBoardWindow({ownerNpub:'owner',limit:21,sortMode});
    expect(page.rows.map(r=>r.record_id)).toEqual([...tasks].sort((a,b)=>compareIndexedTasks(a,b,sortMode)).slice(0,21).map(r=>r.record_id));
    expect(page.counts.ready).toBe(1000);expect(page.hasMore).toBe(true);
  }
});

it('bounds overview and file history reads and exposes older pages', async () => {
  const { getOwnerActivityWindow } = await import('../src/db.js');
  const { instrumentIndexedDb } = await import('./helpers/indexeddb-metrics.js');
  await db.channels.put({ record_id: 'channel', owner_npub: 'owner' });
  for (const table of ['chat_messages','comments','documents']) {
    await db.table(table).bulkPut(Array.from({length:300},(_,i)=>row(`history-${String(i).padStart(4,'0')}`,{owner_npub:'owner'})));
    const metrics=instrumentIndexedDb();
    try {
      const page=await getOwnerActivityWindow(table,'owner',{limit:21});
      expect(page.rows).toHaveLength(21);expect(page.hasMore).toBe(true);
      expect(metrics.snapshot().valueRowsRead).toBe(table === 'chat_messages' ? 23 : 22);
      expect((await getOwnerActivityWindow(table,'owner',{limit:400})).hasMore).toBe(false);
    } finally {metrics.restore()}
  }
});

it('preserves queued and newer optimistic aliases during legacy acknowledgements', async () => {
  await db.chat_messages.put(row('client',{body:'new local text',version:3,sync_status:'pending',pg_reconciliation_pending:true}));
  await db.pending_writes.add({record_id:'client',envelope:{body:'new local text'}});
  expect(await replacePgMessagesForChannel('channel',[row('canonical',{pg_client_record_id:'client',version:2})])).toBe(0);
  expect((await db.chat_messages.get('client')).body).toBe('new local text');
  expect(await db.chat_messages.get('canonical')).toBeUndefined();
});

it('reconciles task client IDs once while retaining unresolved writes', async () => {
  await db.tasks.put(row('task-client',{pg_channel_id:'channel',pg_reconciliation_pending:true}));
  await db.pending_writes.add({record_id:'task-client',envelope:{title:'local'}});
  const ack=row('task-server',{pg_channel_id:'channel',pg_client_record_id:'task-client'});
  expect(await replacePgTasksForChannel('channel',[ack])).toBe(0);
  await db.pending_writes.clear();
  expect(await replacePgTasksForChannel('channel',[ack])).toBe(2);
  expect(await db.tasks.get('task-client')).toBeUndefined();
  expect(await replacePgTasksForChannel('channel',[ack])).toBe(0);
});

it('bounds active-thread reads and skips deleted comments through indexes while retaining legacy timestamps', async () => {
  const { instrumentIndexedDb } = await import('./helpers/indexeddb-metrics.js');
  await db.chat_messages.bulkPut([row('root'), ...Array.from({length:3000},(_,i)=>row(`reply-${i}`,{parent_message_id:'root'}))]);
  await db.comments.bulkPut([...Array.from({length:1000},(_,i)=>row(`deleted-${i}`,{target_record_id:'target',record_state:'deleted',updated_at:'2099-01-01T00:00:00.000Z'})),row('legacy',{target_record_id:'target',updated_at:undefined,created_at:'2026-01-01T00:00:00.000Z'})]);
  const metrics=instrumentIndexedDb();
  try {
    const messages=await getMessagePresentationWindowByChannel('channel',{rootLimit:21,replyLimit:6,activeThreadId:'root'});
    expect(messages.length).toBeLessThanOrEqual(8);expect(metrics.snapshot().valueRowsRead).toBeLessThanOrEqual(9);
    metrics.reset();expect((await getCommentsByTarget('target',{limit:21})).map(row=>row.record_id)).toEqual(['legacy']);
    expect(metrics.snapshot().valueRowsRead).toBe(1);
  } finally {metrics.restore()}
});

it('keeps every pending and failed message reachable beyond the first visible window', async () => {
  await db.chat_messages.bulkPut(Array.from({length:200},(_,i)=>row(`pending-${String(i).padStart(3,'0')}`,{sync_status:i%2?'pending':'failed'})));
  const initial=await getMessagePresentationWindowByChannel('channel',{rootLimit:80});
  const expanded=await getMessagePresentationWindowByChannel('channel',{rootLimit:240});
  expect(initial.length).toBeLessThan(200);expect(expanded.length).toBe(200);
});
