import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { hydrateOrgData } from '../src/org-data/tower.js';
import { orgDataContext, orgDataPartition, normalizeOrgData, projectOrgData, sandboxBundle } from '../src/org-data/projection.js';
import { sameOrgDataAuthority } from '../src/org-data/manager.js';
import { validOrgDataRequest } from '../src/org-data/bridge.js';
const id='11111111-1111-4111-8111-111111111111';
const makeStore=()=>({session:{npub:'reader'},signingNpub:'reader',workspaceDbKey:'org-tests',selectedBoardId:'scope',currentWorkspace:{workspaceId:'workspace',workspaceOwnerNpub:'owner',directHttpsUrl:'http://localhost:3100',appNpub:'app',towerServiceNpub:'tower',workspaceServiceNpub:'service'}});
const payload=()=>({identity:{workspace_id:'workspace',workspace_owner_npub:'owner',app_npub:'app',tower_service_npub:'tower',workspace_service_npub:'service'},workspace_id:'workspace',complete:true,types:[{key:'people',label:'People',revision:1,fields:[{key:'name',label:'Name',type:'text'}],access:{read:'members',write:'members'},capabilities:{read:true,write:true}}],records:[{id,type_key:'people',revision:1,values:{name:'Alex',unknown:'never-copy'}}],capabilities:{read:true,write:true},installations:[]});
beforeEach(async()=>{await openWorkspaceDb('org-tests-'+crypto.randomUUID()).open()});
afterEach(async()=>{await getWorkspaceDb().delete()});
it('persists only an identity-validated complete snapshot and reads all shared views from one Dexie projection',async()=>{
 const store=makeStore(),read=vi.fn(async()=>payload()),db=getWorkspaceDb();
 await hydrateOrgData(store,{requestId:'current'},{read});
 const row=await db.org_data.get(orgDataPartition(orgDataContext(store)));
 expect(row.request_id).toBe('current');expect(projectOrgData(row).records.people[0].values).toEqual({name:'Alex'});
 expect(read).toHaveBeenCalledWith('workspace','snapshot',expect.objectContaining({baseUrl:'http://localhost:3100',appNpub:'app'}));
});
it.each([p=>{p.complete=false},p=>{p.workspace_id='foreign'},p=>{p.identity.workspace_owner_npub='foreign'},p=>{p.records.push(p.records[0])},p=>{p.records[0].values.name={secret:true}}])('rejects incomplete/foreign/malformed projections',mutate=>{const p=payload();mutate(p);expect(()=>normalizeOrgData(p,orgDataContext(makeStore()),'r')).toThrow('Invalid or incomplete')});
it('does not materialize a late result after a workspace switch or disposal',async()=>{
 const store=makeStore(),service=new TowerSyncService({workspaceKey:"org-tests"}),db=getWorkspaceDb();store._towerSyncService=service;
 let resolve;const pending=hydrateOrgData(store,{requestId:'stale'},{read:()=>new Promise(r=>resolve=r)});await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
 store.selectedBoardId='new';resolve(payload());await expect(pending).rejects.toThrow('Workspace changed');expect(await db.org_data.count()).toBe(0);
 store.selectedBoardId='scope';let done;const second=hydrateOrgData(store,{requestId:'disposed'},{read:()=>new Promise(r=>done=r)});await vi.waitFor(()=>expect(done).toBeTypeOf('function'));service.dispose();done(payload());await expect(second).rejects.toThrow();expect(await db.org_data.count()).toBe(0);
});
it('bridge rejects foreign senders, arbitrary requests and credentials but allows only named typed writes',()=>{
 const frame={},session='s',event=data=>({source:frame,origin:'null',data:{version:1,session,...data}});
 expect(validOrgDataRequest(event({type:'write',path:'types/people/records/'+id,method:'PATCH',body:{expected_revision:1,values:{name:'Alex'}}}),frame,session)).toBe(true);
 for(const d of [{type:'fetch',url:'https://evil'},{type:'write',path:'../../admin',method:'POST',body:{}},{type:'ready',key:'private'},{type:'view',view:'foreign'}])expect(validOrgDataRequest(event(d),frame,session)).toBe(false);
 expect(validOrgDataRequest({...event({type:'ready'}),source:{}},frame,session)).toBe(false);
 const html=sandboxBundle('<script>fetch("https://evil")</script>','s');expect(html.indexOf('connect-src')).toBeLessThan(html.indexOf('fetch('));expect(html).toContain("frame-src 'none'");
});

it('failed reads erase the persisted previously broader projection',async()=>{
 const store=makeStore(),db=getWorkspaceDb();await hydrateOrgData(store,{requestId:'before'},{read:async()=>payload()});
 await expect(hydrateOrgData(store,{requestId:'after'},{read:async()=>{throw Object.assign(new Error('unavailable'),{status:500})}})).rejects.toThrow('unavailable');expect(await db.org_data.count()).toBe(0);
});
it('bridge publication byte bound accommodates escaped HTML and rejects oversized serialized JSON',()=>{
 const frame={},session='s',event=body=>({source:frame,origin:'null',data:{version:1,session,type:'write',path:'napplets/bundles',method:'POST',body}});
 expect(validOrgDataRequest(event({html:'\u0001'.repeat(524288),trusted_code_acknowledged:true}),frame,session)).toBe(true);
 expect(validOrgDataRequest(event({html:'x'.repeat(6*524288+16384)}),frame,session)).toBe(false);
});

it('draft authority comparison retains ordinary value conflicts and rejects narrowed datasets/capabilities',()=>{
 const before=projectOrgData(normalizeOrgData(payload(),orgDataContext(makeStore()),'r'));
 const changed=structuredClone(before);changed.records.people[0].values.name='Concurrent edit';changed.records.people[0].revision++;
 expect(sameOrgDataAuthority(before,changed)).toBe(true);
 changed.capabilities.write=false;expect(sameOrgDataAuthority(before,changed)).toBe(false);
 const narrowed=structuredClone(before);narrowed.types=[];narrowed.records={};expect(sameOrgDataAuthority(before,narrowed)).toBe(false);
});
