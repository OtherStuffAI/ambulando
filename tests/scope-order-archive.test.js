import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { applyPgRecordChanges, recordDeltaCursorKey } from '../src/pg-record-delta.js';
import { markPgTargetArchived, filterArchivedProjection, canLoadPgTarget } from '../src/pg-archive-state.js';
import { sortScopesPersonally, mapScopeOrder } from '../src/scope-order.js';
import { hydrateTowerPgEventUpdates, mapPgScopeToLocal } from '../src/pg-read-hydrator.js';
import { applyPgNavigationProjection, readPgNavigationProjection } from '../src/section-live-queries.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { scopesManagerMixin } from '../src/scopes-manager.js';
import * as api from '../src/api.js';
import { syncManagerMixin } from '../src/sync-manager.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
const workspaceId=fixture.one_message_delta.changes[0].workspace_id;
const actor='10000000-0000-4000-8000-000000000001';
const store={workspaceId,workspaceOwnerNpub:'npub1owner',backendUrl:'http://127.0.0.1:3100',session:{npub:'npub1viewer'},currentWorkspace:{workspaceId,workspaceOwnerNpub:'npub1owner',pgBackendMode:true}};
const page=(changes,cursor)=>({...fixture.one_message_delta,families:[...fixture.one_message_delta.families,'scope_order'],changes,next_cursor:cursor,has_more:false});
function orderUi(rows, save = vi.fn()) {
 const ui = Object.defineProperties({}, Object.getOwnPropertyDescriptors(scopesManagerMixin));
 Object.assign(ui, {isTowerPgMode:true, scopeTree:rows, savePersonalScopeOrder:save});
 return ui;
}
let db;
beforeEach(async()=>{db=openWorkspaceDb('scope-order-archives');await db.open();await Promise.all(db.tables.map(t=>t.clear()));});
afterEach(() => vi.restoreAllMocks());
describe('personal order and targeted archive materialisation',()=>{
 it.each([false, true])('hydrates personal order through the real request dispatch (initialized service: %s) without bootstrap',async(initialized)=>{
  const row={workspace_id:workspaceId,actor_id:actor,scope_ids:['b','a'],row_version:2};
  const read=vi.spyOn(api,'getTowerPgScopeOrder').mockResolvedValue({scope_order:row});
  const ui=Object.assign({requestTowerSyncFamily:syncManagerMixin.requestTowerSyncFamily,loadTowerSyncTarget:syncManagerMixin.loadTowerSyncTarget,getTowerSyncService:syncManagerMixin.getTowerSyncService},store,{
   workspaceDbKey:'scope-order-archives',
   currentWorkspace:{...store.currentWorkspace,pgMe:{actor:{id:actor,npub:store.session.npub}}},
   runTowerPgWorkspaceSync:vi.fn(),connectSSEStream:vi.fn(),performSync:vi.fn(),
  });
  const initialize=vi.spyOn(ui,'getTowerSyncService');
  if(initialized) ui.getTowerSyncService();
  initialize.mockClear();
  const fallback=vi.spyOn(ui,'loadTowerSyncTarget');
  const result=await ui.requestTowerSyncFamily('scope-order','',{force:true});
  expect(result).toMatchObject({...row,record_id:actor,sync_status:'synced'});
  expect(await db.scope_orders.get(actor)).toEqual(result);
  expect(read).toHaveBeenCalledExactlyOnceWith(workspaceId,expect.objectContaining({workspaceId,baseUrl:store.backendUrl}));
  expect(initialize).not.toHaveBeenCalled();
  expect(ui.runTowerPgWorkspaceSync).not.toHaveBeenCalled();
  expect(ui.performSync).not.toHaveBeenCalled();expect(ui.connectSSEStream).not.toHaveBeenCalled();
  if(initialized) expect(fallback).not.toHaveBeenCalled();
  else {expect(fallback).toHaveBeenCalledExactlyOnceWith('scope-order','',{force:true});expect(ui._towerSyncService).toBeUndefined();}
 });

 it('persists personal order through canonical deltas and database reopen; never writes shared scopes',async()=>{
  await db.scopes.bulkPut([{record_id:'a',title:'A'},{record_id:'b',title:'B'},{record_id:'c',title:'C'}]);
  const before=await db.scopes.toArray();
  await applyPgRecordChanges(store,page([{workspace_id:workspaceId,family:'scope_order',id:actor,operation:'upsert',version:'31',scope_id:null,channel_id:null,row:{id:actor,workspace_id:workspaceId,actor_id:actor,scope_ids:['b','a'],row_version:1,updated_at:'2026-10-08T00:00:00Z'}}],'order-cursor'));
  expect(await db.scopes.toArray()).toEqual(before);db.close();await db.open();
  const order=await db.scope_orders.get(actor);expect(sortScopesPersonally(await db.scopes.toArray(),order.scope_ids).map(r=>r.record_id)).toEqual(['b','a','c']);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.cursor).toBe('order-cursor');
 });
 it('retains affected content, unrelated cache/cursor and pending edits, suppresses archived projection and stale target loads',async()=>{
  const c=fixture.one_message_delta.changes[0];
  await applyPgRecordChanges(store,page([c],'before-archive'));
  await db.scopes.put({record_id:c.scope_id,title:'Archive'});await db.channels.put({record_id:c.channel_id,scope_id:c.scope_id});
  await db.tasks.put({record_id:'draft',channel_id:c.channel_id,scope_id:c.scope_id,title:'Pending',sync_status:'pending'});
  await db.pending_writes.add({record_id:'draft',envelope:{title:'Pending'}});await db.sync_state.put({key:'unrelated-cursor',value:'unchanged'});
  await db.documents.put({record_id:'unrelated-doc',channel_id:'other',title:'Cached'});
  const content=await db.chat_messages.get(c.id),draft=await db.tasks.get('draft');
  await applyPgRecordChanges(store,page([{family:'scope',id:c.scope_id,workspace_id:workspaceId,scope_id:c.scope_id,channel_id:null,operation:'delete',version:'40',row:null},{family:'channel',id:c.channel_id,workspace_id:workspaceId,scope_id:c.scope_id,channel_id:c.channel_id,operation:'delete',version:'41',row:null}],'archive-cursor'),{expectedCursor:'before-archive'});
  expect(await db.chat_messages.get(c.id)).toEqual(content);expect(await db.tasks.get('draft')).toEqual(draft);
  expect(await db.pending_writes.count()).toBe(1);expect((await db.sync_state.get('unrelated-cursor')).value).toBe('unchanged');
  expect(await db.documents.get('unrelated-doc')).toBeTruthy();expect(await filterArchivedProjection([content,draft,await db.documents.get('unrelated-doc')])).toEqual([await db.documents.get('unrelated-doc')]);
  const load=vi.fn();const sync=new TowerSyncService({workspaceKey:'isolated',families:{'channel-messages':{load}},ports:{canLoad:(family,id,options)=>canLoadPgTarget(family,id,options)}});
  expect(await sync.ensureLoaded('channel-messages',c.channel_id,{force:true})).toMatchObject({archived:true});expect(load).not.toHaveBeenCalled();
  expect(await sync.ensureLoaded('task-detail','draft',{channelId:c.channel_id})).toMatchObject({archived:true});
  // An older content delta may remain cached but cannot reappear in the view.
  await applyPgRecordChanges(store,page([{...c,version:'39'}],'stale-content'),{expectedCursor:'archive-cursor'});
  expect(await filterArchivedProjection([await db.chat_messages.get(c.id)])).toEqual([]);
  expect((await db.sync_state.get(recordDeltaCursorKey(store))).value.localGeneration||0).toBe(0);
 });
 it('moves active archived navigation to overview, preserving unrelated selection and drafts',async()=>{
  const ui={channels:[{record_id:'selected',scope_id:'scope'}],selectedChannelId:'selected',pgContextScopeId:'scope',saveChatComposerDraft:vi.fn(),closeThread:vi.fn(),openAllScopesOverview:vi.fn(),syncRoute:vi.fn()};
  await scopesManagerMixin.handlePgArchivedTargets.call(ui,[{family:'scope',id:'unrelated'}]);expect(ui.openAllScopesOverview).not.toHaveBeenCalled();
  await scopesManagerMixin.handlePgArchivedTargets.call(ui,[{family:'scope',id:'scope'}]);expect(ui.selectedChannelId).toBeNull();expect(ui.saveChatComposerDraft).toHaveBeenCalledWith('message');expect(ui.openAllScopesOverview).toHaveBeenCalledOnce();
 });
 it('archive projection handles detail and paged windows without mutating their cached rows',async()=>{
  await markPgTargetArchived('channel','c');const row={record_id:'d',channel_id:'c',body:'retain'};
  expect(await filterArchivedProjection(row)).toBeNull();expect(await filterArchivedProjection({rows:[row,{record_id:'safe',channel_id:'other'}],hasMore:false})).toEqual({rows:[{record_id:'safe',channel_id:'other'}],hasMore:false});expect(row.body).toBe('retain');
 });
 it('keyboard movement sends a preference command without shared metadata or content writes',async()=>{
  const save=vi.fn();const ui=orderUi([{record_id:'a'},{record_id:'b'}],save);
  await scopesManagerMixin.moveScope.call(ui,'a',-1);expect(save).not.toHaveBeenCalled();
  await scopesManagerMixin.moveScope.call(ui,'a',1);expect(save).toHaveBeenCalledWith(['b','a']);
 });
 it('moves and drops only normal translated roots while preserving special navigation',async()=>{
  const rows=['system','scope','dm','scope','scope'].map((kind,index)=>mapPgScopeToLocal({id:`scope-${index}`,kind,title:`Root ${index}`,workspace_id:workspaceId}));
  rows.splice(3,0,{record_id:'virtual',virtual:true},{record_id:'deleted',record_state:'deleted'},{record_id:'archived',archived_at:'2026-10-08'});
  const save=vi.fn(),ui=orderUi(rows,save),before=[...rows];
  expect(ui.personalOrderScopes.map(row=>row.record_id)).toEqual(['scope-1','scope-3','scope-4']);
  expect(ui.canMoveScope('scope-1',-1)).toBe(false);expect(ui.canMoveScope('scope-4',1)).toBe(false);
  for(const row of rows.filter(row=>!ui.isPersonalOrderScope(row))) {
   expect(ui.canReorderScope(row)).toBe(false);await ui.moveScope(row.record_id,1);
   ui.startScopeDrag(row.record_id,{preventDefault:vi.fn()});expect(ui.draggedScopeId).toBeFalsy();
   ui.draggedScopeId=row.record_id;await ui.dropScopeBefore('scope-1');
   ui.draggedScopeId='scope-4';await ui.dropScopeBefore(row.record_id);
  }
  expect(save).not.toHaveBeenCalled();
  await ui.moveScope('scope-1',1);expect(save).toHaveBeenLastCalledWith(['scope-3','scope-1','scope-4']);
  ui.startScopeDrag('scope-4');await ui.dropScopeBefore('scope-1');
  expect(save).toHaveBeenLastCalledWith(['scope-4','scope-1','scope-3']);expect(ui.scopeTree).toEqual(before);
 });
 it('archive and preference wake events request journal recovery without list/content hydration',async()=>{
  const readChannels=vi.fn(),readMessages=vi.fn();
  const result=await hydrateTowerPgEventUpdates(store,[{entity_type:'scope_order',operation:'updated'},{entity_type:'channel',operation:'archived',channel_id:'c'},{entity_type:'scope',operation:'archived'}],{getTowerPgChannels:readChannels,getTowerPgChannelMessages:readMessages});
  expect(result.fallbackEvents).toBe(3);expect(readChannels).not.toHaveBeenCalled();expect(readMessages).not.toHaveBeenCalled();
 });
 it('stale tombstones cannot hide a newer active target; accepted restoration clears its marker',async()=>{
  const c=fixture.canonical_upserts.changes.find(row=>row.family==='scope');
  await applyPgRecordChanges(store,page([{...c,version:'50'}],'active'));
  await applyPgRecordChanges(store,page([{...c,operation:'delete',version:'49',row:null}],'stale-delete'),{expectedCursor:'active'});
  expect(await canLoadPgTarget('scope',c.id)).toBe(true);
  await applyPgRecordChanges(store,page([{...c,operation:'delete',version:'51',row:null}],'deleted'),{expectedCursor:'stale-delete'});
  expect(await canLoadPgTarget('scope',c.id)).toBe(false);
  await applyPgRecordChanges(store,page([{...c,version:'52'}],'restored'),{expectedCursor:'deleted'});
  expect(await canLoadPgTarget('scope',c.id)).toBe(true);
 });
 it('drag placement and personal projection never apply another actor preference',async()=>{
  const save=vi.fn(),ui=orderUi([{record_id:'a'},{record_id:'b'},{record_id:'c'}],save);ui.draggedScopeId='c';
  await scopesManagerMixin.dropScopeBefore.call(ui,'a',{preventDefault:vi.fn()});expect(save).toHaveBeenCalledWith(['c','a','b']);
  const getter=Object.getOwnPropertyDescriptor(scopesManagerMixin,'personallyOrderedScopes').get;
  const own={scopes:ui.scopeTree,session:{npub:'viewer'},currentWorkspace:{workspaceId:'w',pgMe:{actor:{id:'me',npub:'viewer'}}},personalScopeOrder:{actor_id:'other',workspace_id:'w',scope_ids:['c','b','a']}};
  expect(getter.call(own).map(r=>r.record_id)).toEqual(['a','b','c']);own.personalScopeOrder.actor_id='me';expect(getter.call(own).map(r=>r.record_id)).toEqual(['c','b','a']);
 });

 it('preserves dirty document and task editor input locally before archive navigation',async()=>{
  const document={record_id:'doc',channel_id:'archived'};
  await db.documents.put(document);
  const persistDoc=vi.fn(async()=>{await db.document_drafts.put({draft_key:'local-doc',document_id:'doc',content:'Unsent document'});});
  const persistTask=vi.fn(async()=>{await db.sync_state.put({key:'local-task',value:{task_id:'task',title:'Unsent task'}});});
  const ui={selectedDocId:'doc',docEditDraftDirty:true,editingTask:{record_id:'task',channel_id:'archived'},taskDraftDirty:true,persistSelectedDocDraft:persistDoc,persistTaskLocalDraft:persistTask,openAllScopesOverview:vi.fn()};
  await scopesManagerMixin.handlePgArchivedTargets.call(ui,[{family:'channel',id:'archived'}]);
  expect(persistDoc).toHaveBeenCalledWith({immediate:true,item:document});expect(persistTask).toHaveBeenCalledOnce();
  expect((await db.document_drafts.get('local-doc')).content).toBe('Unsent document');expect((await db.sync_state.get('local-task')).value.title).toBe('Unsent task');expect(ui.openAllScopesOverview).toHaveBeenCalledOnce();
 });

 it('reads archive markers atomically with navigation and prevents unrelated channel auto-selection',async()=>{
  await db.scopes.put({record_id:'scope',owner_npub:'owner'});await db.channels.put({record_id:'safe',scope_id:'scope',owner_npub:'owner'});await markPgTargetArchived('channel','archived');
  const ui={currentWorkspaceKey:'atomic',workspaceOwnerNpub:'owner',currentWorkspace:{workspaceId},selectedChannelId:'archived',channels:[{record_id:'archived',scope_id:'scope'}],navSection:'chat',saveChatComposerDraft:vi.fn(),closeThread:vi.fn(),openAllScopesOverview(){this.navSection='status';},applyScopes:vi.fn(),applyChannels:vi.fn(),syncRoute:vi.fn()};
  ui.handlePgArchivedTargets=scopesManagerMixin.handlePgArchivedTargets.bind(ui);
  const projection=await readPgNavigationProjection(ui);expect(projection.archivedTargets).toEqual([{key:'channel:archived',family:'channel',id:'archived'}]);
  await applyPgNavigationProjection(ui,projection);expect(ui.selectedChannelId).toBeNull();expect(ui.navSection).toBe('status');expect(ui.applyChannels).toHaveBeenCalledOnce();expect(ui.applyChannels.mock.calls[0][1]).toMatchObject({preserveNavigation:true});
 });

});
