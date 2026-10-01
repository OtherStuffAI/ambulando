import { beforeEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
import { openWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, resetPgRecordAuthority, recordDeltaCursorKey } from '../src/pg-record-delta.js';
const workspaceId=fixture.one_message_delta.changes[0].workspace_id;
const store={workspaceId,workspaceOwnerNpub:'npub1owner',backendUrl:'http://localhost:3000',session:{npub:'npub1viewer'},currentWorkspace:{workspaceId,workspaceOwnerNpub:'npub1owner',pgBackendMode:true}};
let db;
beforeEach(async()=>{db=openWorkspaceDb('record-delta-tests');await db.open();await Promise.all(db.tables.map(t=>t.clear()))});
const page=(changes,cursor='next')=>({...fixture.one_message_delta, changes, next_cursor:cursor, has_more:false});
describe('Tower canonical record-delta v1 consumer',()=>{
  it('accepts every supplied canonical family without inventing row shapes',async()=>{
    const result=await applyPgRecordChanges(store,fixture.canonical_upserts,{expectedCursor:null});
    expect(result.protocolVersion).toBe(1);expect(await db.pg_record_rows.count()).toBe(17);
    expect(await db.tasks.count()).toBe(1);expect(await db.comments.count()).toBe(2);
    expect(await db.resource_view_states.count()).toBe(1);
    expect(await db.autopilot_connections.count()).toBe(1);expect(await db.workspace_agents.count()).toBe(1);
  });
  it('ignores duplicates and old upserts after a newer explicit tombstone',async()=>{
    const change=fixture.one_message_delta.changes[0];
    await applyPgRecordChanges(store,page([change],'one'),{expectedCursor:null});
    expect((await applyPgRecordChanges(store,page([change],'two'),{expectedCursor:'one'})).applied).toBe(0);
    await applyPgRecordChanges(store,page(fixture.explicit_delete.changes,'three'),{expectedCursor:'two'});
    await applyPgRecordChanges(store,page([change],'four'),{expectedCursor:'three'});
    expect(await db.chat_messages.count()).toBe(0);
    expect((await db.pg_record_rows.get(`message:${change.id}`)).version).toBe('20');
  });
  it('atomically rolls back rows, summaries, versions and cursor on a crash',async()=>{
    await expect(applyPgRecordChanges(store,page(fixture.one_message_delta.changes),{expectedCursor:null,beforeCommit:()=>{throw new Error('crash')}})).rejects.toThrow('crash');
    expect(await db.chat_messages.count()).toBe(0);expect(await db.pg_record_rows.count()).toBe(0);expect(await db.channel_summaries.count()).toBe(0);expect(await db.sync_state.count()).toBe(0);
    await applyPgRecordChanges(store,page(fixture.one_message_delta.changes),{expectedCursor:null});
    expect(await db.chat_messages.count()).toBe(1);
  });
  it('rejects out-of-order page commits with an opaque cursor compare-and-swap',async()=>{
    await applyPgRecordChanges(store,page(fixture.one_message_delta.changes,'one'),{expectedCursor:null});
    await expect(applyPgRecordChanges(store,page(fixture.explicit_delete.changes,'two'),{expectedCursor:null})).rejects.toThrow('cursor changed');
    expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('one');
  });
  it('retains unresolved local commands and exposes a durable conflict',async()=>{
    const change=fixture.one_message_delta.changes[0];
    await db.chat_messages.put({record_id:change.id,channel_id:change.channel_id,body:'local edit',sync_status:'pending'});
    await db.pending_writes.add({record_id:change.id,envelope:{body:'local edit'}});
    await applyPgRecordChanges(store,page([change]));
    expect((await db.chat_messages.get(change.id)).body).toBe('local edit');
    expect(await db.pg_record_conflicts.count()).toBe(1);expect(await db.pending_writes.count()).toBe(1);
  });
  it('hides revoked authority while preserving recoverable commands and legacy cursor',async()=>{
    await db.sync_state.put({key:'legacy-cursor',value:'old'});
    await applyPgRecordChanges(store,page(fixture.one_message_delta.changes));
    await db.chat_messages.put({record_id:'pending',sync_status:'pending',body:'local'});
    await db.pending_writes.add({record_id:'pending',envelope:{body:'local'}});
    await resetPgRecordAuthority(store);
    expect(await db.chat_messages.count()).toBe(0);expect(await db.pending_writes.count()).toBe(1);expect(await db.pg_record_conflicts.count()).toBe(1);
    expect((await db.sync_state.get('legacy-cursor')).value).toBe('old');
  });
  it('never deletes unseen history on a partial snapshot',async()=>{
    await db.chat_messages.put({record_id:'old',channel_id:'channel',body:'cached',sync_status:'synced'});
    await applyPgRecordChanges(store,{...fixture.canonical_upserts,snapshot_complete:false});
    expect(await db.chat_messages.get('old')).toBeTruthy();
  });
  it('compares versions beyond Number.MAX_SAFE_INTEGER exactly',async()=>{
    const c=fixture.one_message_delta.changes[0];
    await applyPgRecordChanges(store,page([{...c,version:'9007199254740993',row:{...c.row,body:'newer'}}]));
    await applyPgRecordChanges(store,page([{...c,version:'9007199254740992'}],'later'));
    expect((await db.chat_messages.get(c.id)).body).toBe('newer');
  });
});

it('retires an old generation only after the terminal snapshot and delta handover',async()=>{
  await db.chat_messages.put({record_id:'old',channel_id:'old-channel',pg_backend:true,sync_status:'synced'});
  await db.chat_messages.put({record_id:'pending-old',channel_id:'old-channel',pg_backend:true,sync_status:'pending'});
  await applyPgRecordChanges(store,{...fixture.canonical_upserts,next_cursor:'snapshot-end'},{expectedCursor:null});
  expect(await db.chat_messages.get('old')).toBeTruthy();
  await applyPgRecordChanges(store,page([],'handover'),{expectedCursor:'snapshot-end'});
  expect(await db.chat_messages.get('old')).toBeUndefined();
  expect(await db.chat_messages.get('pending-old')).toBeTruthy();
});

it('uses one predecessor when deleting the latest message',async()=>{
  const c=fixture.one_message_delta.changes[0];
  const older={...c,id:'older',version:'1',row:{...c.row,id:'older',updated_at:'2026-09-04T00:00:00Z'}};
  await applyPgRecordChanges(store,page([older,c],'one'));
  expect((await db.channel_summaries.get(c.channel_id)).latest_id).toBe(c.id);
  await applyPgRecordChanges(store,page(fixture.explicit_delete.changes,'two'));
  expect((await db.channel_summaries.get(c.channel_id)).latest_id).toBe('older');
});

it('keeps reply association when messages precede their thread across snapshot pages',async()=>{
  const c=fixture.one_message_delta.changes[0];
  const make=(id,version)=>({...c,id,version,row:{...c.row,id,thread_id:'thread'}});
  await applyPgRecordChanges(store,{...page([make('source','1'),make('reply','2')],'p1'),mode:'snapshot',snapshot_id:'generation',snapshot_complete:false,has_more:true},{expectedCursor:null});
  const t=fixture.canonical_upserts.changes.find(c=>c.family==='thread');
  await applyPgRecordChanges(store,{...page([{...t,id:'thread',version:'3',row:{...t.row,id:'thread',source_message_id:'source'}}],'p2'),mode:'snapshot',snapshot_id:'generation',snapshot_complete:true,has_more:true,partitions_complete:fixture.canonical_upserts.families},{expectedCursor:'p1'});
  const {getMessagePresentationWindowByChannel}=await import('../src/db.js');
  const visible=await getMessagePresentationWindowByChannel(c.channel_id,{rootLimit:10,replyLimit:6,activeThreadId:'source'});
  expect(visible.find(r=>r.record_id==='reply')?.parent_message_id).toBe('source');
  expect(visible.filter(r=>!r.parent_message_id).map(r=>r.record_id)).toEqual(['source']);
});

it('does not overwrite a newer targeted hydration with an older entity version',async()=>{
  const c=fixture.one_message_delta.changes[0];
  await db.chat_messages.put({record_id:c.id,channel_id:c.channel_id,version:5,sync_status:'synced',body:'newer targeted row'});
  await applyPgRecordChanges(store,page([{...c,row:{...c.row,row_version:4}}]));
  expect((await db.chat_messages.get(c.id)).body).toBe('newer targeted row');
});

it('retains the whole rich document model for same-body metadata deltas and invalidates changed bodies',async()=>{
  const c=fixture.canonical_upserts.changes.find(c=>c.family==='doc');
  await db.documents.put({record_id:c.id,version:1,sync_status:'synced',content_storage_object_id:c.row.storage_object_id,content:'rich body',content_storage_status:'loaded',content_blocks:[{id:'block'}],editor_state:{type:'doc'},content_format:'tiptap',pg_canonical_version_id:`${c.id}:1`});
  await applyPgRecordChanges(store,page([{...c,row:{...c.row,row_version:2,title:'new title'}}],'one'));
  expect(await db.documents.get(c.id)).toMatchObject({title:'new title',content:'rich body',content_blocks:[{id:'block'}],editor_state:{type:'doc'},content_storage_status:'loaded'});
  const {documentEditorBaseIdentity}=await import('../src/docs-manager.js');
  const updated=await db.documents.get(c.id);
  expect(updated.pg_canonical_version_id).toBe(`${c.id}:2`);
  expect(documentEditorBaseIdentity(updated)).toMatchObject({base_version_id:`${c.id}:2`,base_row_version:2});
  await applyPgRecordChanges(store,page([{...c,version:'30',row:{...c.row,row_version:3,storage_object_id:'different-body'}}],'two'));
  expect(await db.documents.get(c.id)).toMatchObject({content_storage_object_id:'different-body',content_blocks:[],editor_state:null,content_storage_status:'remote'});
});

it('rematerializes withheld canonical acknowledgements when commands resolve',async()=>{
  const c=fixture.one_message_delta.changes[0];
  await db.chat_messages.put({record_id:c.id,channel_id:c.channel_id,version:1,sync_status:'pending',body:'draft'});
  const command=await db.pending_writes.add({record_id:c.id});
  await applyPgRecordChanges(store,page([c]));
  await db.pending_writes.delete(command);
  await db.chat_messages.update(c.id,{sync_status:'synced'});
  const {reconcilePgRecordConflicts}=await import('../src/pg-record-delta.js');
  await reconcilePgRecordConflicts(store);
  expect((await db.chat_messages.get(c.id)).body).toBe(c.row.body);
  expect(await db.pg_record_conflicts.count()).toBe(0);
});

it('resolves an explicit remote choice while saving the local command for recovery',async()=>{
  const c=fixture.one_message_delta.changes[0];
  await db.chat_messages.put({record_id:c.id,channel_id:c.channel_id,version:1,sync_status:'pending',body:'draft'});
  await db.pending_writes.add({record_id:c.id,envelope:{body:'draft'}});
  await applyPgRecordChanges(store,page([c]));
  const {reconcilePgRecordConflicts}=await import('../src/pg-record-delta.js');
  await reconcilePgRecordConflicts(store,{acceptRemoteKey:`message:${c.id}`});
  expect((await db.chat_messages.get(c.id)).body).toBe(c.row.body);
  expect(await db.pg_record_conflicts.count()).toBe(0);expect(await db.pending_writes.count()).toBe(0);
  expect((await db.pg_command_recovery.get(`message:${c.id}`)).commands[0].envelope.body).toBe('draft');
});

it('keeps file clashes out of the main review count and resolves them with Tower winning',async()=>{
  const file=fixture.canonical_upserts.changes.find(c=>c.family==='file');
  const message=fixture.one_message_delta.changes[0];
  await applyPgRecordChanges(store,page([file,message],'base'));
  await db.documents.update(file.id,{title:'local file name',sync_status:'pending'});
  await db.pending_writes.add({record_id:file.id,envelope:{display_name:'local file name'}});
  await db.chat_messages.update(message.id,{body:'local message',sync_status:'pending'});
  await db.pending_writes.add({record_id:message.id,envelope:{body:'local message'}});
  await applyPgRecordChanges(store,page([{...file,version:'999',row:{...file.row,row_version:999,display_name:'Tower file name'}},{...message,version:'999',row:{...message.row,row_version:999,body:'Tower message'}}],'conflict'));
  const {getPgAttentionProjection,reconcilePgRecordConflicts}=await import('../src/pg-record-delta.js');
  const projection=await getPgAttentionProjection(store);
  expect(projection.conflictCount).toBe(1);
  expect(projection.conflicts.map(c=>c.family)).toEqual(['message']);
  expect(projection.avatarSyncConflictCount).toBe(1);
  expect(projection.avatarSyncConflicts.map(c=>c.family)).toEqual(['file']);
  await reconcilePgRecordConflicts(store);
  expect((await db.documents.get(file.id)).title).toBe('Tower file name');
  expect((await db.chat_messages.get(message.id)).body).toBe('local message');
  expect((await db.pg_record_conflicts.toArray()).map(c=>c.family)).toEqual(['message']);
  expect((await db.pg_command_recovery.get(`file:${file.id}`)).commands[0].envelope.display_name).toBe('local file name');
});

it('normalizes raw PostgreSQL timestamps before local chronology indexing',async()=>{
  const c=fixture.one_message_delta.changes[0];
  await applyPgRecordChanges(store,page([c]));
  expect((await db.chat_messages.get(c.id)).updated_at).toBe('2026-09-05T00:00:00.000Z');
  expect((await db.pg_record_rows.get(`message:${c.id}`)).row.updated_at).toBe(c.row.updated_at);
});

it('rebuilds summaries in bounded resumable batches and matches existing unread attention semantics',async()=>{
  const c=fixture.canonical_upserts.changes.find(c=>c.family==='task');
  const actor=c.row.updated_by_actor_id;
  await db.workspace_members.put({actor_id:actor,npub:'npub1someone-else',workspace_id:workspaceId});
  const tasks=Array.from({length:225},(_,i)=>({...c,id:`task-${i}`,version:String(i+1),row:{...c.row,id:`task-${i}`,activity_version:2}}));
  await applyPgRecordChanges(store,page(tasks.slice(0,199),'one'));
  await applyPgRecordChanges(store,page(tasks.slice(199),'two'));
  const before=await db.pg_attention_counts.toArray();
  const {rebuildPgRecordSummaries,getPgAttentionProjection}=await import('../src/pg-record-delta.js');
  expect((await rebuildPgRecordSummaries(store,{batchSize:50})).processed).toBe(225);
  expect(await db.pg_attention_counts.toArray()).toEqual(before);
  const {unreadStoreMixin}=await import('../src/unread-store.js');
  const local=await db.tasks.toArray();
  const old={...store,tasks:local,pgWorkspaceMembers:await db.workspace_members.toArray(),currentViewerNpub:'npub1viewer'};
  unreadStoreMixin.applyTowerPgResourceViewStates.call(old,local.map(task=>({resource_type:'task',resource_id:task.record_id,channel_id:task.pg_channel_id,activity_version:2,viewed_activity_version:0})));
  const projection=await getPgAttentionProjection({...store,tasks:local});
  expect(projection.values['section:tasks']).toBe(Object.keys(old._unreadTaskItems).length);
  expect(projection.values['section:tasks']).toBe(225);
});

it('hydrates actor references before canonical rows on a fresh negotiated workspace',async()=>{
  const {syncTowerPgWorkspace}=await import('../src/pg-read-hydrator.js');
  const task=fixture.canonical_upserts.changes.find(c=>c.family==='task');
  const assignment=fixture.canonical_upserts.changes.find(c=>c.family==='task_assignment');
  const c=fixture.one_message_delta.changes[0];
  const result=await syncTowerPgWorkspace(store,{}, {
    getTowerPgRecordSync:async()=>({...page([c,task,{...assignment,id:`${task.id}:${assignment.row.actor_id}`,row:{...assignment.row,task_id:task.id}}]),actors:undefined}),
    getTowerPgResourceViewStates:async()=>({states:[],baseline_created:true}),
    getTowerPgWorkspaceMembers:async()=>({members:[{actor:{id:c.row.created_by_actor_id,npub:'npub1sender'}}]}),
    getTowerPgWorkspaceGroups:async()=>({groups:[]}),
  });
  expect(result.protocolVersion).toBe(1);
  expect((await db.chat_messages.get(c.id)).sender_npub).toBe('npub1sender');
  expect((await db.tasks.get(task.id)).assigned_to_npub).toBe('npub1sender');
});

it('bootstraps restricted viewers from the atomic actor sidecar without directory permission',async()=>{
  const {syncTowerPgWorkspace}=await import('../src/pg-read-hydrator.js');
  let forbiddenDirectoryCalls=0;
  const forbidden=async()=>{forbiddenDirectoryCalls++;throw Object.assign(new Error('no workspace.read'),{status:403})};
  const c=fixture.one_message_delta.changes[0];
  await syncTowerPgWorkspace(store,{}, {getTowerPgRecordSync:async()=>page([c]),getTowerPgResourceViewStates:async()=>({states:[],baseline_created:true}),getTowerPgWorkspaceMembers:forbidden,getTowerPgWorkspaceGroups:forbidden});
  expect(forbiddenDirectoryCalls).toBe(0);
  expect(await db.workspace_members.count()).toBe(0);
  expect(await db.pg_actors.count()).toBe(1);
  expect((await db.chat_messages.get(c.id)).sender_npub).toBe(fixture.one_message_delta.actors[0].npub);
  await resetPgRecordAuthority(store);expect(await db.pg_actors.count()).toBe(0);
});

it('rejects a late first snapshot after an ACL reset even when both cursors are null',async()=>{
  await resetPgRecordAuthority(store);
  await expect(applyPgRecordChanges(store,fixture.canonical_upserts,{expectedCursor:null,expectedGeneration:0})).rejects.toThrow('authority generation changed');
  expect(await db.chat_messages.count()).toBe(0);
});

it('clears unread counts atomically on an optimistic local read and keeps its watermark', async () => {
  const { upsertResourceViewState } = await import('../src/db.js');
  await db.pg_resource_attention.put({record_id:'thread:read-thread',resource_type:'thread',resource_id:'read-thread',channel_id:'channel',unread:1,activity_version:8});
  await db.pg_attention_counts.bulkPut([{key:'section:chat',count:1},{key:'channel:channel',count:1}]);
  await upsertResourceViewState({resource_type:'thread',resource_id:'read-thread',viewed_activity_version:8,sync_status:'pending'});
  expect((await db.pg_resource_attention.get('thread:read-thread')).unread).toBe(0);
  expect((await db.pg_attention_counts.get('section:chat')).count).toBe(0);
  await upsertResourceViewState({resource_type:'thread',resource_id:'read-thread',viewed_activity_version:7,sync_status:'synced'});
  expect((await db.resource_view_states.get('thread:read-thread')).viewed_activity_version).toBe(8);
  expect((await db.pg_attention_counts.get('channel:channel')).count).toBe(0);
});

it('deletes a materialized source root when its thread placeholder has already been replaced', async () => {
  const original=fixture.canonical_upserts.changes.find(c=>c.family==='thread');
  const thread={...original,id:'thread-delete',row:{...original.row,id:'thread-delete',source_message_id:'source-delete'}};
  const originalMessage=fixture.one_message_delta.changes[0];
  const source={...originalMessage,id:'source-delete',row:{...originalMessage.row,id:'source-delete',thread_id:'thread-delete'}};
  await applyPgRecordChanges(store,page([thread,source],'root'));
  expect(await db.chat_messages.get('source-delete')).toBeTruthy();
  expect(await db.chat_messages.get('thread-delete')).toBeUndefined();
  await applyPgRecordChanges(store,page([{...thread,operation:'delete',row:null,version:'999'}],'deleted'));
  expect(await db.chat_messages.get('source-delete')).toBeUndefined();
});

it('retains earlier actor identities when an independent assignment rematerializes its task', async () => {
  const task=fixture.canonical_upserts.changes.find(c=>c.family==='task');
  const assignment=fixture.canonical_upserts.changes.find(c=>c.family==='task_assignment');
  const a=fixture.canonical_upserts.actors[0];
  const b={...a,actor_id:'second-assignee',npub:'npub1second'};
  await applyPgRecordChanges(store,{...page([task,{...assignment,id:`${task.id}:${a.actor_id}`,row:{...assignment.row,task_id:task.id}}],'first-assignee'),actors:[a]});
  const next={...assignment,id:`${task.id}:${b.actor_id}`,version:'999',row:{...assignment.row,task_id:task.id,actor_id:b.actor_id}};
  await applyPgRecordChanges(store,{...page([next],'second-assignee'),actors:[b]});
  expect((await db.tasks.get(task.id)).assigned_to_npubs.sort()).toEqual([a.npub,b.npub].sort());
});

it('retains full effective membership for metadata deltas and invalidates changed lineage', async () => {
  const original = fixture.canonical_upserts.changes.find(change => change.family === 'thread');
  await applyPgRecordChanges(store, page([original], 'one'), { expectedCursor: null });
  await db.chat_messages.update(original.id, { pg_effective_message_ids: ['inherited-before', 'inherited-later'] });
  const updated = { ...original, version: String(BigInt(original.version) + 1n), row: { ...original.row, title: 'Updated title', row_version: original.row.row_version + 1 } };
  await applyPgRecordChanges(store, page([updated], 'two'), { expectedCursor: 'one' });
  expect((await db.chat_messages.get(original.id)).pg_effective_message_ids).toEqual(['inherited-before', 'inherited-later']);
  const branched = { ...updated, version: String(BigInt(updated.version) + 1n), row: { ...updated.row, parent_thread_id: 'different-parent', branch_point_message_id: 'different-point', row_version: updated.row.row_version + 1 } };
  await applyPgRecordChanges(store, page([branched], 'three'), { expectedCursor: 'two' });
  expect((await db.chat_messages.get(original.id)).pg_effective_message_ids).toBeUndefined();
});

describe('read receipts reconcile without content conflicts', () => {
  const change = fixture.canonical_upserts.changes.find(c => c.family === 'resource_view_state');
  const recordId = `${change.row.resource_type}:${change.row.resource_id}`;
  const receipt = (viewed, version = '100') => ({ ...change, version, row: { ...change.row, viewed_activity_version: viewed } });

  it.each(['pending', 'failed', 'synced'])('retains an ahead %s watermark for reconnect and accepts its acknowledgement', async (syncStatus) => {
    await db.resource_view_states.put({ record_id: recordId, ...change.row, viewed_activity_version: 8, sync_status: syncStatus });
    await applyPgRecordChanges(store, page([receipt(6)], 'behind'));
    expect(await db.resource_view_states.get(recordId)).toMatchObject({ viewed_activity_version: 8, sync_status: 'pending', pg_sync_conflict: false });
    expect(await db.pg_record_conflicts.count()).toBe(0);
    await applyPgRecordChanges(store, page([receipt(8, '101')], 'ack'));
    expect(await db.resource_view_states.get(recordId)).toMatchObject({ viewed_activity_version: 8, sync_status: 'synced' });
    expect(await db.pg_record_conflicts.count()).toBe(0);
  });

  it('accepts a further shared read position while a local read is pending', async () => {
    await db.resource_view_states.put({ record_id: recordId, ...change.row, viewed_activity_version: 4, sync_status: 'pending' });
    await applyPgRecordChanges(store, page([receipt(9)]));
    expect(await db.resource_view_states.get(recordId)).toMatchObject({ viewed_activity_version: 9, sync_status: 'synced' });
    expect(await db.pg_record_conflicts.count()).toBe(0);
  });

  it('clears an existing read warning on an empty sync without discarding an offline read or content conflict', async () => {
    const shared = receipt(6);
    const content = fixture.one_message_delta.changes[0];
    await db.chat_messages.put({ record_id: content.id, body: 'unsent edit', sync_status: 'pending' });
    await db.pending_writes.add({ record_id: content.id, envelope: { body: 'unsent edit' } });
    await applyPgRecordChanges(store, page([shared, content], 'first'));
    const local = { record_id: recordId, ...change.row, viewed_activity_version: 8, sync_status: 'pending', pg_sync_conflict: true };
    await db.resource_view_states.put(local);
    await db.pg_record_conflicts.put({ key: `resource_view_state:${change.id}`, family: 'resource_view_state', record_id: recordId, local, remote: shared, reason: 'unresolved_local_command' });
    const { hydrateTowerPgSyncBundle } = await import('../src/pg-read-hydrator.js');
    await hydrateTowerPgSyncBundle(store, page([], 'reconnect'));
    expect(await db.resource_view_states.get(recordId)).toMatchObject({ viewed_activity_version: 8, sync_status: 'pending', pg_sync_conflict: false });
    expect((await db.pg_record_conflicts.toArray()).map(c => c.family)).toEqual(['message']);
    expect((await db.chat_messages.get(content.id)).body).toBe('unsent edit');
    expect(await db.pending_writes.count()).toBe(1);
  });

  it('honors an explicit receipt tombstone without creating a review warning', async () => {
    await db.resource_view_states.put({ record_id: recordId, ...change.row, viewed_activity_version: 8, sync_status: 'pending' });
    await applyPgRecordChanges(store, page([{ ...change, version: '100', operation: 'delete', row: null }]));
    expect(await db.resource_view_states.get(recordId)).toBeUndefined();
    expect(await db.pg_record_conflicts.count()).toBe(0);
  });
});

it('does not recreate a title-only thread when its source was hydrated by the send response', async () => {
  const t = fixture.canonical_upserts.changes.find(c => c.family === 'thread');
  const c = fixture.one_message_delta.changes[0];
  const { mapPgMessageToLocal } = await import('../src/pg-read-hydrator.js');
  const thread = { ...t.row, id: 'thread-ack', source_message_id: 'source-ack', title: 'Thread title' };
  const source = mapPgMessageToLocal({ ...c.row, id: 'source-ack', thread_id: thread.id, body: 'Signed source body' }, {
    workspaceOwnerNpub: store.workspaceOwnerNpub, senderNpub: 'npub1author', threadById: new Map([[thread.id, thread]]),
  });
  await db.chat_messages.put({ ...source, pg_reconciliation_pending: true, pg_client_record_id: 'local-source' });
  await applyPgRecordChanges(store, page([{ ...t, id: thread.id, row: thread }], 'thread-only'));
  expect(await db.chat_messages.get(thread.id)).toBeUndefined();
  expect(await db.chat_messages.get(source.record_id)).toMatchObject({ body: 'Signed source body', sender_npub: 'npub1author', parent_message_id: null });
});

it('a late send response cannot overwrite newer canonical SSE content or resurrect reconciliation', async () => {
  const { replaceMessageRecord } = await import('../src/db.js');
  const c = fixture.one_message_delta.changes[0];
  await db.chat_messages.put({ record_id: 'local-send', channel_id: c.channel_id, body: 'original', sync_status: 'pending', version: 1 });
  await applyPgRecordChanges(store, page([{ ...c, row: { ...c.row, body: 'edited on server', row_version: 2, metadata: { client_record_id: 'local-send' } } }]));
  await replaceMessageRecord('local-send', { record_id: c.id, channel_id: c.channel_id, body: 'original', version: 1, sync_status: 'synced', pg_client_record_id: 'local-send', pg_reconciliation_pending: true });
  expect(await db.chat_messages.get('local-send')).toBeUndefined();
  expect(await db.chat_messages.get(c.id)).toMatchObject({ body: 'edited on server', version: 2 });
  expect((await db.chat_messages.get(c.id)).pg_reconciliation_pending).not.toBe(true);
});

it('replaces a sync placeholder and local reply parents atomically when the send ack arrives', async () => {
  const { replaceMessageRecord } = await import('../src/db.js');
  const t = fixture.canonical_upserts.changes.find(c => c.family === 'thread');
  await applyPgRecordChanges(store, page([{ ...t, id: 'ack-thread', row: { ...t.row, id: 'ack-thread', source_message_id: 'ack-root' } }]));
  await db.chat_messages.put({ record_id: 'local-root', channel_id: t.channel_id, body: 'root', sync_status: 'pending' });
  await db.chat_messages.put({ record_id: 'local-reply', channel_id: t.channel_id, parent_message_id: 'local-root', body: 'reply draft', sync_status: 'pending' });
  await replaceMessageRecord('local-root', { record_id: 'ack-root', channel_id: t.channel_id, body: 'root', pg_record_type: 'message', pg_thread_id: 'ack-thread', parent_message_id: null, pg_reconciliation_pending: true, version: 1, sync_status: 'synced' });
  expect(await db.chat_messages.get('ack-thread')).toBeUndefined();
  expect(await db.chat_messages.get('local-reply')).toMatchObject({ parent_message_id: 'ack-root', pg_thread_id: 'ack-thread', body: 'reply draft', sync_status: 'pending' });
});

it('typed channel refresh never retains a summary beside an already cached source', async () => {
  const { replacePgMessagesForChannel, replacePgThreadsForChannel } = await import('../src/db.js');
  const source = { record_id: 'typed-source', channel_id: 'typed-channel', pg_record_type: 'message', pg_backend: true, pg_thread_id: 'typed-thread', parent_message_id: null, body: 'Authored body', sync_status: 'synced', version: 1 };
  const summary = { record_id: 'typed-thread', channel_id: 'typed-channel', pg_record_type: 'thread', pg_backend: true, pg_thread_id: 'typed-thread', pg_source_message_id: 'typed-source', parent_message_id: null, body: 'Title', sync_status: 'synced', version: 1 };
  await replacePgMessagesForChannel(source.channel_id, [source]);
  await replacePgMessagesForChannel(source.channel_id, [summary]);
  expect(await db.chat_messages.get(summary.record_id)).toBeUndefined();
  await replacePgThreadsForChannel(source.channel_id, [summary]);
  expect(await db.chat_messages.get(summary.record_id)).toBeUndefined();
  expect((await db.chat_messages.get(source.record_id)).body).toBe('Authored body');
});

it('finds the source outside the bounded root window for a retained history summary', async () => {
  const { getMessagePresentationWindowByChannel } = await import('../src/db.js');
  const { rankMainFeedMessages } = await import('../src/chat-order.js');
  const source = { record_id: 'old-source', channel_id: 'channel', pg_record_type: 'message', pg_thread_id: 'history-thread', parent_message_id: null, body: 'Original authored body', updated_at: '2026-01-01T00:00:00Z', record_state: 'active' };
  await db.chat_messages.bulkPut([source,
    { record_id: 'other-root', channel_id: 'channel', parent_message_id: null, updated_at: '2026-06-01T00:00:00Z', record_state: 'active' },
    { record_id: 'history-thread', channel_id: 'channel', pg_record_type: 'thread', pg_thread_id: 'history-thread', pg_source_message_id: source.record_id, pg_effective_message_ids: [source.record_id], parent_message_id: null, body: 'Title only', updated_at: '2026-09-07T00:00:00Z', record_state: 'active' },
  ]);
  const window = await getMessagePresentationWindowByChannel('channel', { rootLimit: 1 });
  const roots = rankMainFeedMessages(window);
  expect(roots.some(row => row.record_id === source.record_id)).toBe(true);
  expect(roots.some(row => row.record_id === 'history-thread')).toBe(false);
});

it('preserves cached history metadata when a thread with a materialized source changes', async () => {
  const t = fixture.canonical_upserts.changes.find(c => c.family === 'thread');
  const c = fixture.one_message_delta.changes[0];
  const thread = { ...t, id: 'history', row: { ...t.row, id: 'history', source_message_id: 'history-source' } };
  const source = { ...c, id: 'history-source', row: { ...c.row, id: 'history-source', thread_id: 'history' } };
  await applyPgRecordChanges(store, page([thread, source]));
  const { mapPgThreadToLocal } = await import('../src/pg-read-hydrator.js');
  await db.chat_messages.put({ ...mapPgThreadToLocal(thread.row), pg_effective_message_ids: ['history-source'] });
  await applyPgRecordChanges(store, page([{ ...thread, version: '100', row: { ...thread.row, title: 'Updated title', row_version: 2 } }], 'next-history'));
  expect(await db.chat_messages.get('history')).toMatchObject({ title: 'Updated title', pg_effective_message_ids: ['history-source'] });
});

it('hydrates the permitted member directory even when a fresh snapshot has an actor sidecar', async () => {
  const { syncTowerPgWorkspace } = await import('../src/pg-read-hydrator.js');
  const target = { ...store, currentWorkspace: { ...store.currentWorkspace, pgMe: { permissions: ['workspace.read'] } } };
  let calls = 0;
  const dependencies = {
    getTowerPgRecordSync: async () => page([]),
    getTowerPgResourceViewStates: async () => ({ states: [], baseline_created: true }),
    getTowerPgWorkspaceMembers: async () => { calls++; return { members: [{ actor: { actor_id: 'unreferenced-agent', npub: 'npub1unreferenced-agent', kind: 'agent', display_name: 'Ready Agent' }, membership: { role: 'member' } }] }; },
    getTowerPgWorkspaceGroups: async () => ({ groups: [] }),
  };
  await syncTowerPgWorkspace(target, {}, dependencies);
  expect((await db.workspace_members.get('unreferenced-agent'))?.display_name).toBe('Ready Agent');
  await resetPgRecordAuthority(target);
  expect(await db.workspace_members.count()).toBe(0);
  await syncTowerPgWorkspace(target, {}, dependencies);
  expect(calls).toBe(2);
  expect((await db.workspace_members.get('unreferenced-agent'))?.npub).toBe('npub1unreferenced-agent');
});

it('reconciles a seen acknowledgement during snapshot without advancing its cursor or retiring unseen rows', async () => {
  const c = fixture.one_message_delta.changes[0];
  await db.chat_messages.put({ record_id: c.id, channel_id: c.channel_id, sync_status: 'pending', body: 'draft' });
  const command = await db.pending_writes.add({ record_id: c.id });
  await db.chat_messages.put({ record_id: 'unseen', channel_id: c.channel_id, sync_status: 'synced', body: 'cached' });
  await applyPgRecordChanges(store, { ...fixture.canonical_upserts, changes: [c], snapshot_complete: false, next_cursor: 'partial' });
  await db.pending_writes.delete(command);
  await db.chat_messages.update(c.id, { sync_status: 'synced' });
  const { reconcilePgRecordConflicts } = await import('../src/pg-record-delta.js');
  await reconcilePgRecordConflicts(store);
  expect(await db.pg_record_conflicts.count()).toBe(0);
  expect((await db.chat_messages.get(c.id)).body).toBe(c.row.body);
  expect(await db.chat_messages.get('unseen')).toBeTruthy();
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value).toMatchObject({ cursor: 'partial', snapshotComplete: false, snapshotReconciliationPending: true });
  await expect(applyPgRecordChanges(store, page([], 'premature'))).rejects.toThrow('Incomplete snapshot handover');
});

it('limits Feed omission authority to advertised snapshot families and still honors supported deletion and revocation', async () => {
  const reader = { ...store, currentWorkspace: { ...store.currentWorkspace, pgMe: { actor: { actor_id: 'reader', npub: 'npub1viewer' } } } };
  const row = { schema_version: 1, id: 'subscription', workspace_id: workspaceId, reader_actor_id: 'reader', row_version: 1, status: 'active', source: { kind: 'public', url: 'https://feed.example/feed.json' } };
  const families = [...fixture.canonical_upserts.families, 'feed_subscription', 'feed_item_state'];
  const change = { family: 'feed_subscription', id: row.id, workspace_id: workspaceId, version: '1', operation: 'upsert', row };
  await applyPgRecordChanges(reader, { ...page([change], 'feed-seeded'), families });
  await resetPgRecordAuthority(reader, { preserveViews: true });
  await applyPgRecordChanges(reader, fixture.canonical_upserts);
  await applyPgRecordChanges(reader, page([], 'older-tower-handover'));
  expect(await db.feed_subscriptions.count()).toBe(1);
  expect(await db.pg_record_rows.get('feed_subscription:subscription')).toBeTruthy();
  await resetPgRecordAuthority(reader, { preserveViews: true });
  await applyPgRecordChanges(reader, { ...fixture.canonical_upserts, families, partitions_complete: families });
  await applyPgRecordChanges(reader, { ...page([], 'supported-empty-handover'), families });
  expect(await db.feed_subscriptions.count()).toBe(0);
  await applyPgRecordChanges(reader, { ...page([change], 'feed-returned'), families });
  await applyPgRecordChanges(reader, { ...page([{ ...change, version: '2', operation: 'delete', row: null }], 'feed-deleted'), families });
  expect(await db.feed_subscriptions.count()).toBe(0);
  await applyPgRecordChanges(reader, { ...page([{ ...change, version: '3' }], 'feed-returned-again'), families });
  await resetPgRecordAuthority(reader);
  expect(await db.feed_subscriptions.count()).toBe(0);
});
