import { beforeEach, afterEach, expect, it } from 'vitest';
import Dexie, { liveQuery } from 'dexie';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { synchronizePrivatePreferences } from '../src/private-preference-sync.js';
import { applyPrivatePreferenceOperation, queuePrivatePreference, preferenceStorageKey } from '../src/private-preference-store.js';
import { privatePreferenceContext } from '../src/private-preference-store.js';
import { nostrViewerMixin } from '../src/feed/nostr-viewer.js';
let devices, server, receipts, offline, subscriptions;
// Explicitly simulated transport: independent Dexie stores and TowerSyncServices,
// mirroring the signed API's CAS/idempotency contract; no BroadcastChannel shortcut.
function device(name, actor='alice', workspace='workspace') {
 const db=new Dexie(`preference-${name}`); db.version(1).stores({private_preferences:'&key, context'});
 const store={session:{npub:actor},currentWorkspace:{workspaceId:workspace,directHttpsUrl:'http://localhost:3100',pgMe:{actor:{actor_id:actor,npub:actor}}},_workspaceSelectionGeneration:0,workspaceDbKey:name,buildTowerPgMaterializationStoreSnapshot:()=>({})};
 const service=new TowerSyncService({workspaceKey:name,ports:{materialize:(_f,b)=>applyPrivatePreferenceOperation(structuredClone(b.private_preference_operation),db)}});
 store.getTowerSyncService=()=>service;
 const context=privatePreferenceContext(store);
 const sync=()=>synchronizePrivatePreferences(store,{db,transport:async(w,key,options)=>{
  if(offline.has(name))throw new Error('offline');
  const partition=JSON.stringify([w,context.actorId,key]),body=options.body;
  let row=server.get(partition)||null;
  if(body){
   const receiptKey=`${partition}:${body.mutation_id}`;
   if(receipts.has(receiptKey))return receipts.get(receiptKey);
   if(!(body.import_only&&row)){
    if((row?.row_version||0)!==body.expected_row_version)throw Object.assign(new Error('conflict'),{status:409});
    row={id:partition,workspace_id:w,actor_id:context.actorId,preference_key:key,value:body.value,row_version:(row?.row_version||0)+1};server.set(partition,row);
   }
   const result={identity:{workspace_id:w},preference:row};receipts.set(receiptKey,result);return result;
  }
  return {identity:{workspace_id:w},preference:row};
 }});
 const d={db,store,service,context,sync,projection:null};
 subscriptions.push(liveQuery(()=>db.private_preferences.get(preferenceStorageKey(context))).subscribe(state=>{d.projection=state?.pending.at(-1)?.value??state?.row?.value??'https://njump.me/';}));
 return d;
}
async function settle(){await new Promise(resolve=>setTimeout(resolve,30));}
beforeEach(async()=>{server=new Map();receipts=new Map();offline=new Set();subscriptions=[];devices=[device('one'),device('two'),device('bob','bob'),device('other','alice','other')];for(const d of devices){await d.db.open();await d.db.private_preferences.clear();}});
afterEach(async()=>{subscriptions.forEach(s=>s.unsubscribe());for(const d of devices){d.service.dispose();await d.db.close();}});
it('converges across independent contexts, reload, default reset and private partitions',async()=>{
 const [one,two,bob,other]=devices;await Promise.all(devices.map(d=>d.sync()));
 await queuePrivatePreference(one.db,one.context,'https://canopy.winn.cloud/event/');await one.sync();await two.sync();await settle();
 expect(two.projection).toBe(one.projection);expect(two.projection).toBe('https://canopy.winn.cloud/event/');
 await bob.sync();await other.sync();await settle();expect(bob.projection).toBe('https://njump.me/');expect(other.projection).toBe('https://njump.me/');
 await two.db.close();await two.db.open();expect((await two.db.private_preferences.get(preferenceStorageKey(two.context))).row.value).toBe(two.projection);
 await queuePrivatePreference(two.db,two.context,'https://njump.me/');await two.sync();await one.sync();await settle();expect(one.projection).toBe('https://njump.me/');
 one.store.readLegacyNostrViewer=()=> 'https://stale.example/';await one.sync();expect((await one.db.private_preferences.get(preferenceStorageKey(one.context))).row.value).toBe('https://njump.me/');
});
it('reads remote before legacy import; first disconnected save is blocked; stale defaults never replace authority',async()=>{
 const [one,two]=devices;await expect(queuePrivatePreference(one.db,one.context,'x')).rejects.toThrow('Connect to Tower');
 await one.sync();await queuePrivatePreference(one.db,one.context,'https://chosen.example/');await one.sync();
 two.store.readLegacyNostrViewer=()=> 'https://njump.me/';await two.sync();expect((await two.db.private_preferences.get(preferenceStorageKey(two.context))).row.value).toBe('https://chosen.example/');
 const ctx=privatePreferenceContext(two.store);expect(preferenceStorageKey(ctx)).not.toBe(preferenceStorageKey(privatePreferenceContext(devices[2].store)));
});
it('retains immutable offline intent then reconnects; conflict keeps authoritative choice and drops dependent stale edits',async()=>{
 const [one,two]=devices;await one.sync();await two.sync();
 offline.add('one');await queuePrivatePreference(one.db,one.context,'https://offline.example/');const before=(await one.db.private_preferences.get(preferenceStorageKey(one.context))).pending;
 await expect(one.sync()).rejects.toThrow('offline');expect((await one.db.private_preferences.get(preferenceStorageKey(one.context))).pending).toEqual(before);
 offline.delete('one');await one.sync();await two.sync();
 await queuePrivatePreference(one.db,one.context,'https://winner.example/');await one.sync();
 await queuePrivatePreference(two.db,two.context,'https://stale.example/');await queuePrivatePreference(two.db,two.context,'https://staler.example/');await two.sync();await settle();
 expect(two.projection).toBe('https://winner.example/');expect((await two.db.private_preferences.get(preferenceStorageKey(two.context))).pending).toEqual([]);
});
it('adopts legacy only for its claimed actor/workspace and rejects cross-actor acknowledgements',async()=>{
 const [one,two,bob]=devices;localStorage.setItem('ambulando:nostr-viewer','https://legacy.example/');localStorage.removeItem('ambulando:nostr-viewer:owner');
 expect(nostrViewerMixin.readLegacyNostrViewer(one.context.key)).toBe('https://legacy.example/');expect(nostrViewerMixin.readLegacyNostrViewer(bob.context.key)).toBeNull();
 one.store.readLegacyNostrViewer=()=> 'https://legacy.example/';await one.sync();await two.sync();expect((await two.db.private_preferences.get(preferenceStorageKey(two.context))).row.value).toBe('https://legacy.example/');
 await expect(applyPrivatePreferenceOperation({context:one.context,action:'read',row:{workspace_id:'workspace',actor_id:'bob',preference_key:'ambulando.nostr-viewer',value:'x',row_version:100}},one.db)).rejects.toThrow('Invalid private');
});
