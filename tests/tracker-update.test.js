import { it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { updateTrackerCode, canUpdateTracker, ORIGINAL_TRACKER_DIGEST } from '../src/napplets/tracker-update.js';
import { packageTrackerBundle } from '../src/napplets/tracker-bundle.js';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context = { workspaceId: id(1), viewer: 'alice' }, code = id(2), data = id(3), base = id(4), next = id(5);
const original = await readFile(new URL('./fixtures/daily-tracker-original.html', import.meta.url), 'utf8');
const parts = await Promise.all(['index.html','style.css','model.js','app.js'].map(n => readFile(new URL(`../public/napplets/daily-tracker/v1/${n}`, import.meta.url), 'utf8')));
const source = packageTrackerBundle({html:parts[0],style:parts[1],model:parts[2],app:parts[3]});
const sha = async b => Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
function fixture() {
 const state = { head:base, html:original, target:data, codeWrite:true, dataWrite:true, denied:false, private:true, current:true, uploaded:null };
 const metadata = () => ({napplet:{version:1,app_id:'daily-tracker',bindings:{tracker:{file_id:state.target}}}});
 const api = {
  getTowerPgFile:vi.fn(async (_w,f) => {if(state.denied)throw Error('denied');return {can_write:f===code?state.codeWrite:state.dataWrite,file:{id:f,workspace_id:context.workspaceId,channel_id:id(6),current_version_id:f===code?state.head:id(7),can_write:true,metadata:metadata()}};}),
  getTowerPgChannel:vi.fn(async () => ({channel:{id:id(6),workspace_id:context.workspaceId,kind:'dm',participant_npubs:state.private?['alice']:['other']}})),
  getTowerPgFileVersions:vi.fn(async () => {const bytes=new TextEncoder().encode(state.html);return {current_version_id:state.head,versions:[{id:state.head,file_id:code,content_type:'text/html',size_bytes:bytes.length,sha256_hex:await sha(bytes)}]};}),
  getTowerPgFileVersionObjectBytes:vi.fn(async () => ({bytes:new TextEncoder().encode(state.html)})),
  prepareTowerPgStorageObject:vi.fn(async () => ({object_id:id(8),is_public:false})),
  uploadStorageObject:vi.fn(async (_p,b) => {state.uploaded=b;}), completeStorageObject:vi.fn(async () => {}),
  createTowerPgFileVersion:vi.fn(async (_w,f,b) => {expect(f).toBe(code);if(b.base_version_id!==state.head)throw Object.assign(Error('stale'),{status:409});state.head=next;state.html=new TextDecoder().decode(state.uploaded);return {version:{id:next}};})
 };
 const run = () => updateTrackerCode({context,codeFileId:code,baseVersionId:base,binding:{appId:'daily-tracker',fileId:data},source,current:()=>state.current,transport:api});
 return {state,api,run};
}
it('pins the released original bytes and refuses same-manifest custom code',async()=>{
 expect(new TextEncoder().encode(original).length).toBe(14824);expect(await sha(new TextEncoder().encode(original))).toBe(ORIGINAL_TRACKER_DIGEST);
 expect(canUpdateTracker({digest:ORIGINAL_TRACKER_DIGEST,html:original})).toBe(true);
 for(const html of [original+'\n',source]){const f=fixture();f.state.html=html;await expect(f.run()).rejects.toThrow('customized');expect(f.api.prepareTowerPgStorageObject).not.toHaveBeenCalled();}
});
it('publishes one same-code File CAS, verifies bytes and never writes data or metadata',async()=>{
 const f=fixture();f.state.dataWrite=false;expect(await f.run()).toBe(next);
 expect(f.api.createTowerPgFileVersion).toHaveBeenCalledExactlyOnceWith(context.workspaceId,code,expect.objectContaining({base_version_id:base,storage_object_id:id(8)}),expect.anything());
 expect(Object.keys(f.api.createTowerPgFileVersion.mock.calls[0][2]).sort()).toEqual(['base_version_id','client_mutation_id','storage_object_id']);
 expect(f.state.target).toBe(data);expect(f.state.html).toBe(source);
 expect(f.api.getTowerPgFileVersionObjectBytes.mock.calls.every(c=>c[1]===code)).toBe(true);
});
it.each(['head','binding','codeWrite','denied','private','context'])('refuses changed %s before uploading',async kind=>{
 const f=fixture();if(kind==='head')f.state.head=next;if(kind==='binding')f.state.target=id(9);if(kind==='codeWrite')f.state.codeWrite=false;if(kind==='denied')f.state.denied=true;if(kind==='private')f.state.private=false;if(kind==='context')f.state.current=false;
 await expect(f.run()).rejects.toThrow();expect(f.api.prepareTowerPgStorageObject).not.toHaveBeenCalled();expect(f.api.createTowerPgFileVersion).not.toHaveBeenCalled();
});
it.each(['head','binding','codeWrite','private','context'])('rechecks %s after upload and refuses publication',async kind=>{
 const f=fixture();f.api.completeStorageObject.mockImplementation(async()=>{if(kind==='head')f.state.head=next;if(kind==='binding')f.state.target=id(9);if(kind==='codeWrite')f.state.codeWrite=false;if(kind==='private')f.state.private=false;if(kind==='context')f.state.current=false;});
 await expect(f.run()).rejects.toThrow();expect(f.api.uploadStorageObject).toHaveBeenCalledOnce();expect(f.api.createTowerPgFileVersion).not.toHaveBeenCalled();
});
it('keeps original CAS and does not retry conflicts or a lost publication acknowledgement',async()=>{
 for(const lost of [false,true]){const f=fixture(),publish=f.api.createTowerPgFileVersion.getMockImplementation();f.api.createTowerPgFileVersion.mockImplementation(async(...a)=>{if(lost)await publish(...a);throw Object.assign(Error('uncertain'),{status:lost?500:409});});await expect(f.run()).rejects.toThrow();expect(f.api.createTowerPgFileVersion).toHaveBeenCalledOnce();expect(f.state.head).toBe(lost?next:base);}
});
it('does not report success for bad readback or incomplete acknowledgement',async()=>{
 for(const bad of ['ack','bytes','newer']){const f=fixture(),publish=f.api.createTowerPgFileVersion.getMockImplementation();f.api.createTowerPgFileVersion.mockImplementation(async(...a)=>{const r=await publish(...a);if(bad==='ack')return {};if(bad==='bytes')f.state.html+='\n';if(bad==='newer')f.state.head=id(10);return r;});await expect(f.run()).rejects.toThrow();expect(f.api.createTowerPgFileVersion).toHaveBeenCalledOnce();}
});

it('bounds template fetching with the same abort signal and never uploads after timeout',async()=>{
 vi.useFakeTimers();
 const f=fixture();let signal;
 const run=updateTrackerCode({context,codeFileId:code,baseVersionId:base,binding:{appId:'daily-tracker',fileId:data},loadSource:s=>{signal=s;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));},transport:f.api});
 const rejected=expect(run).rejects.toThrow('aborted');
 try{await vi.advanceTimersByTimeAsync(45000);await rejected;expect(signal.aborted).toBe(true);expect(f.api.prepareTowerPgStorageObject).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});
