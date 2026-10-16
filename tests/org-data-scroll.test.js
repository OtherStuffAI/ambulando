// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { orgDataMixin, sameInstalledOrgDataAuthority } from '../src/org-data/manager.js';
import { orgDataContext, orgDataPartition } from '../src/org-data/projection.js';
let store;
const metadata = { key: 'register', title: 'Register', version: 1, revision: 1, bridge_version: 1, capabilities: [], sha256: 'a'.repeat(64) };
const projection = () => ({ types: [], records: {}, identities: {}, capabilities: { read: true, write: true }, installations: [metadata] });
beforeEach(async () => { await openWorkspaceDb('scroll-' + crypto.randomUUID()).open(); });
afterEach(async () => { store?.closeOrgData(true); await getWorkspaceDb().delete(); document.body.replaceChildren(); });
async function host(capabilities = []) {
 document.body.innerHTML='<dialog id="org-data-modal"><button data-napplet-close></button><iframe></iframe></dialog>';
 const dialog=document.querySelector('dialog');dialog.showModal=()=>{dialog.open=true};dialog.close=()=>{dialog.open=false};
 const s={session:{npub:'reader'},workspaceDbKey:'db',currentWorkspace:{workspaceId:'workspace',workspaceOwnerNpub:'owner',directHttpsUrl:'http://localhost:3100',appNpub:'app'},payload:projection()};
 s.load=vi.fn(async (_family,_id,{requestId,signal})=>{
  if(s.pause) await new Promise((resolve,reject)=>{s.pending.push({resolve,reject,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  signal.throwIfAborted(); if(s.denied)throw {status:403};
  await getWorkspaceDb().org_data.put({key:orgDataPartition(orgDataContext(s)),request_id:requestId,...s.payload,installations:s.payload.installations.map(b=>({...b,html:'<input value="draft"><details open>Evidence</details>'}))});
 });
 s.payload.installations=[{...metadata,capabilities}];
 s.pending=[];s.getTowerSyncService=()=>({ensureLoaded:s.load});Object.defineProperties(s,Object.getOwnPropertyDescriptors(orgDataMixin));store=s;
 await s.openOrgData({view:'bundle:register'});await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));
 handshake(s);return s;
}
function handshake(s) {
 const session=JSON.parse(s.orgDataSrcdoc.match(/window.nappletSession=("[^"]+")/)[1]);
 window.dispatchEvent(new MessageEvent('message',{source:document.querySelector('iframe').contentWindow,origin:'null',data:{version:1,session,type:'ready'}}));
}
it('keeps iframe, session and visible document through background cycles and unrelated data/grant/install changes',async()=>{
 const s=await host(),frame=document.querySelector('iframe'),srcdoc=s.orgDataSrcdoc;
 for(let i=0;i<3;i++){
  s.pause=true;const read=s.syncOrgData();await vi.waitFor(()=>expect(s.pending).toHaveLength(1));
  expect(s.orgDataHostStatus).toBe('loading');expect(s.orgDataBundleVisible).toBe(true);expect(document.querySelector('iframe')).toBe(frame);expect(s.orgDataSrcdoc).toBe(srcdoc);
  s.payload={...projection(),types:[{key:'unrelated',fields:[]}],records:{unrelated:[{id:'other',values:{}}]},identities:{other:'someone'},capabilities:{read:true,write:false},installations:[metadata,{...metadata,key:'another',sha256:'b'.repeat(64)}]};
  s.pending.shift().resolve();await read;await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));
  expect(document.querySelector('iframe')).toBe(frame);expect(s.orgDataSrcdoc).toBe(srcdoc);expect(s.orgDataBundleVisible).toBe(true);
 }
});
it('supersedes pending checks without remounting, then destroys the document on denied access',async()=>{
 const s=await host(),frame=document.querySelector('iframe');s.pause=true;
 const first=s.syncOrgData();await vi.waitFor(()=>expect(s.pending).toHaveLength(1));
 const second=s.syncOrgData();await vi.waitFor(()=>expect(s.pending).toHaveLength(2));expect(s.pending[0].signal.aborted).toBe(true);
 expect(s.orgDataBundleVisible).toBe(true);s.pending[1].resolve();await second;await first;
 expect(document.querySelector('iframe')).toBe(frame);
 s.pause=false;s.denied=true;await s.syncOrgData();expect(s.orgDataHostStatus).toBe('error');expect(s.orgDataBundleVisible).toBe(false);expect(s.orgDataSrcdoc).toBe('<!doctype html>');expect(document.querySelector('iframe')).not.toBe(frame);
});
it('replaces changed installations and keeps explicit refresh deliberate',async()=>{
 const s=await host(),frame=document.querySelector('iframe'),old=s.orgDataSrcdoc;
 s.pause=true;const refresh=s.refreshOrgData();await vi.waitFor(()=>expect(s.pending).toHaveLength(1));expect(s.orgDataBundleVisible).toBe(false);
 s.pending.shift().resolve();await refresh;await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));expect(s.orgDataSrcdoc).toBe(old);
 s.pause=false;s.payload={...projection(),installations:[{...metadata,version:2,revision:2,sha256:'b'.repeat(64)}]};
 await s.syncOrgData();await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));expect(document.querySelector('iframe')).not.toBe(frame);expect(s.orgDataSrcdoc).not.toBe(old);expect(s.orgDataFrameReady).toBe(false);
 handshake(s);expect(s.orgDataBundleVisible).toBe(true);
});
it('does not retain a missing installation/read grant or narrow a live-bridge authority check',()=>{
 const p=projection();expect(sameInstalledOrgDataAuthority(p,{...p,installations:[]},metadata)).toBe(false);
 expect(sameInstalledOrgDataAuthority(p,{...p,capabilities:{read:false}},metadata)).toBe(false);
 expect(sameInstalledOrgDataAuthority(p,{...p,capabilities:{read:true,write:false}},{...metadata,capabilities:['org_data.read']})).toBe(false);
});

it('keeps live-bridge bundles mounted during pending reads without weakening authority checks',async()=>{
 const s=await host(['org_data.read','org_data.write']),frame=document.querySelector('iframe');s.pause=true;const read=s.syncOrgData();
 await vi.waitFor(()=>expect(s.pending).toHaveLength(1));expect(s.orgDataBundleVisible).toBe(true);
 const command=vi.fn();s.getTowerSyncService=()=>({ensureLoaded:s.load,command});
 await s.writeOrgData({path:'types/people/records/x',method:'PATCH',body:{}});expect(command).not.toHaveBeenCalled();
 s.pending.shift().resolve();await read;await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));expect(document.querySelector('iframe')).toBe(frame);
 s.pause=false;s.payload.capabilities={read:true,write:false};await s.syncOrgData();await vi.waitFor(()=>expect(s.orgDataHostStatus).toBe('ready'));expect(document.querySelector('iframe')).not.toBe(frame);expect(s.orgDataFrameReady).toBe(false);
});
