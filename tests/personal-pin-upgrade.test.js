import Dexie from 'dexie';
import { expect, it } from 'vitest';
import { createWorkspaceDb } from '../src/db.js';
it('upgrades a real v39 pin cache/outbox without losing fixed retries, tombstones, resource records or migration markers',async()=>{
 const key=`pin-v39-upgrade-${Date.now()}`,current=createWorkspaceDb(key);
 const stores=Object.fromEntries(current.tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')]));
 stores.thread_pins='&record_id, context, [context+thread_id]';stores.thread_pin_outbox='++seq, context, [context+threadId]';
 const legacy=new Dexie(current.name);legacy.version(39).stores(stores);await legacy.open();
 const pin={record_id:'f-pin',id:'f-pin',context:'actor-context',workspace_id:'w',actor_id:'a',thread_id:'t',pinned:false,row_version:4};
 const op={context:'actor-context',threadId:'t',thread:{id:'t',channelId:'c'},body:{pinned:true,expected_row_version:4,mutation_id:'fixed-mutation'}};
 await legacy.thread_pins.put(pin);await legacy.thread_pin_outbox.add(op);await legacy.sync_state.put({key:'thread-pin-migration:legacy',value:true});
 await legacy.tasks.put({record_id:'existing-task',title:'Keep this task',sync_status:'synced'});
 const oldOp=await legacy.thread_pin_outbox.toArray();legacy.close();await current.open();
 try{
  const upgraded=await current.thread_pins.get('f-pin');expect(upgraded).toMatchObject({...pin,key:'f-pin',resource_type:'thread',resource_id:'t'});
  const [retry]=await current.thread_pin_outbox.toArray();expect(retry.body).toEqual(oldOp[0].body);expect(retry.seq).toBe(oldOp[0].seq);expect(retry.targetKey).toBe('thread:t');expect(retry.resourceType).toBe('thread');
  expect((await current.sync_state.get('thread-pin-migration:legacy')).value).toBe(true);expect((await current.tasks.get('existing-task')).title).toBe('Keep this task');
 }finally{current.close();await current.delete();}
});
