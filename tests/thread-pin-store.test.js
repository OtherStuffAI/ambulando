import { beforeEach, expect, it } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { applyThreadPinOperation, queueThreadPin, readThreadPinProjection, threadPinContext, mapThreadPin, threadPinSupportKey, threadPinMigrationKey } from '../src/thread-pin-store.js';
const actor='actor',workspace='workspace';
const store={session:{npub:'alice'},currentWorkspace:{workspaceId:workspace,directHttpsUrl:'http://localhost:3100',pgMe:{actor:{actor_id:actor,npub:'alice'}}}};
const context=threadPinContext(store),thread={id:'thread',channelId:'channel',rootRecordId:'source'};
let db;
beforeEach(async()=>{db=openWorkspaceDb('pin-store-unit');await db.open();await Promise.all(db.tables.map(t=>t.clear()));});
it('queues rapid toggles as immutable dependent CAS operations and preserves unrelated threads on conflict',async()=>{
 await queueThreadPin(db,context,thread,true);await queueThreadPin(db,context,thread,false);await queueThreadPin(db,context,{...thread,id:'other'},true);
 const [first,second,other]=await db.thread_pin_outbox.toArray();
 expect(first.body.expected_row_version).toBe(0);expect(second.body.expected_row_version).toBe(1);expect(other.body.expected_row_version).toBe(0);
 await applyThreadPinOperation(store,{action:'retry',seq:first.seq,mutationId:first.body.mutation_id},db);
 expect((await db.thread_pin_outbox.get(first.seq)).body).toEqual(first.body);
 await applyThreadPinOperation(store,{action:'reject',seq:first.seq,mutationId:first.body.mutation_id,error:'Conflict'},db);
 expect((await db.thread_pin_outbox.toArray()).map(r=>r.threadId)).toEqual(['other']);
});
it('atomically marks legacy migration, keeps existing tombstones and rejects cross-reader acknowledgements',async()=>{
 const row={id:'row',workspace_id:workspace,actor_id:actor,thread_id:thread.id,channel_id:'channel',root_record_id:'source',pinned:false,pinned_at:null,row_version:3};
 await db.thread_pins.put(mapThreadPin(row,context));
 const importInput={action:'migrate',partition:'legacy',pins:{thread,other:{...thread,id:'other',pinnedAt:'2026-10-01T00:00:00Z'}}};
 await applyThreadPinOperation(store,importInput,db);await applyThreadPinOperation(store,importInput,db);
 const ops=await db.thread_pin_outbox.toArray();expect(ops).toHaveLength(1);expect(ops[0].threadId).toBe('other');
 await expect(applyThreadPinOperation(store,{action:'ack',seq:ops[0].seq,mutationId:ops[0].body.mutation_id,pin:{...row,thread_id:'other',actor_id:'bob'}},db)).rejects.toThrow('Invalid personal thread pin');
 expect(await db.thread_pin_outbox.count()).toBe(1);
 expect((await readThreadPinProjection(db,context,'legacy')).rows.map(r=>r.id)).toEqual(['other']);
});
it('allows removing unavailable UUIDs and hides another backend or workspace projection',async()=>{
 await queueThreadPin(db,context,{id:'missing'},false);
 const [op]=await db.thread_pin_outbox.toArray();expect(op.body.pinned).toBe(false);
 expect((await readThreadPinProjection(db,{...context,key:'another-backend'},'unknown')).rows).toEqual([]);
 expect(()=>threadPinContext({...store,currentViewerNpub:'bob'})).toThrow('Sign in');
});

it('keeps legacy selections visible when the connected Tower lacks the new family',async()=>{
 const {saveSettings}=await import('../src/db.js');
 await saveSettings({threadPins:{legacy:{thread}}});
 await db.sync_state.put({key:threadPinSupportKey(context),value:false});
 const projection=await readThreadPinProjection(db,context,'legacy');
 expect(projection.rows.map(r=>r.id)).toEqual(['thread']);expect(projection.error).toContain('until Tower supports');
 expect(await db.thread_pin_outbox.count()).toBe(0);
});

it('retains post-migration pending unpins when a backend is temporarily downgraded',async()=>{
 const row={id:'row',workspace_id:workspace,actor_id:actor,thread_id:thread.id,channel_id:'channel',root_record_id:'source',pinned:true,pinned_at:'2026-10-01T00:00:00Z',row_version:3};
 await db.thread_pins.put(mapThreadPin(row,context));
 await db.sync_state.put({key:threadPinMigrationKey('legacy'),value:true});
 await db.sync_state.put({key:threadPinSupportKey(context),value:false});
 await queueThreadPin(db,context,thread,false);
 expect((await readThreadPinProjection(db,context,'legacy')).rows).toEqual([]);
 expect((await db.thread_pin_outbox.toArray())[0].body.expected_row_version).toBe(3);
});

it('keeps the snapshot retirement cursor on the pin primary key rather than the actor UUID',()=>{
 const row={id:'ffffffff-ffff-4fff-8fff-ffffffffffff',workspace_id:workspace,actor_id:actor,thread_id:thread.id,pinned:false,row_version:1};
 const mapped=mapThreadPin(row,context);
 expect(mapped.key).toBe(mapped.record_id);expect(mapped.key).not.toBe(mapped.actor_id);
});

it('projects typed resources with canonical titles and attention, and scopes operations by type plus id',async()=>{
 await db.channels.put({record_id:'channel',record_state:'active'});
 await db.tasks.put({record_id:'same',title:'Current task',pg_channel_id:'channel',record_state:'active',updated_at:'2026-10-02'});
 await db.documents.put({record_id:'same',title:'Current document',pg_channel_id:'channel',pg_record_type:'doc',record_state:'active',updated_at:'2026-10-03'});
 await db.pg_resource_attention.put({record_id:'task:same',unread:1});
 await queueThreadPin(db,context,{id:'same',type:'task'},true);await queueThreadPin(db,context,{id:'same',type:'document'},true);
 let projection=await readThreadPinProjection(db,context,'typed');
 expect(projection.rows.map(r=>r.title).sort()).toEqual(['Current document','Current task']);
 expect(projection.rows.find(r=>r.type==='task').persistedUnread).toBe(true);
 const ops=await db.thread_pin_outbox.toArray();expect(ops.map(r=>r.body.expected_row_version)).toEqual([0,0]);
 await applyThreadPinOperation(store,{action:'reject',seq:ops[0].seq,mutationId:ops[0].body.mutation_id,error:'Task conflict'},db);
 expect((await db.thread_pin_outbox.toArray()).map(r=>r.resourceType)).toEqual(['document']);
 await db.documents.update('same',{record_state:'deleted'});projection=await readThreadPinProjection(db,context,'typed');expect(projection.rows[0]).toMatchObject({title:'Document unavailable',unavailable:true});
});

it('projects channel pins with canonical titles, safe unavailable states and immutable typed retries',async()=>{
 await db.channels.put({record_id:'channel',title:'Across scopes',scope_id:'other',record_state:'active'});
 await queueThreadPin(db,context,{id:'channel'},true,'channel');
 const [op]=await db.thread_pin_outbox.toArray();
 expect(op).toMatchObject({resourceType:'channel',targetKey:'channel:channel',body:{expected_row_version:0,pinned:true}});
 expect((await readThreadPinProjection(db,context,'channels')).rows[0]).toMatchObject({type:'channel',title:'Across scopes',channelId:'channel',unavailable:false});
 await applyThreadPinOperation(store,{action:'ack',seq:op.seq,mutationId:op.body.mutation_id,pin:{id:'channel-pin',workspace_id:workspace,actor_id:actor,resource_type:'channel',resource_id:'channel',channel_id:'channel',pinned:true,pinned_at:op.pinnedAt,row_version:1}},db);
 expect(await db.thread_pin_outbox.count()).toBe(0);
 expect((await readThreadPinProjection(db,context,'channels')).rows).toHaveLength(1);
 await db.pg_archived_targets.put({key:'scope:other'});
 expect((await readThreadPinProjection(db,context,'channels')).rows[0]).toMatchObject({title:'Channel unavailable',unavailable:true});
 await queueThreadPin(db,context,{id:'channel'},false,'channel');
 expect((await db.thread_pin_outbox.toArray())[0].body.expected_row_version).toBe(1);
 expect((await readThreadPinProjection(db,context,'channels')).rows).toEqual([]);
 expect(await db.resource_view_states.count()).toBe(0);expect(await db.pending_writes.count()).toBe(0);
});
