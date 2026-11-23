import {it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import fixture from './fixtures/napplets/workspace-report-storage-v1.json';
import {REPORT_MODEL,normalizeWorkspaceReport} from '../src/napplets/aggregate-capability.js';
import {GenericNappletData} from '../src/napplets/generic-data.js';
import {parseGenericNapplet,genericReceipt,validGenericRequest} from '../src/napplets/generic-protocol.js';
import {genericWorkspaceReportBundle} from '../scripts/package-generic-workspace-report.mjs';
const copy=()=>structuredClone(fixture.value),html=m=>`<script id="wingman-napplet-manifest">${JSON.stringify(m)}</script>`;
const context={baseUrl:'https://tower.example',appNpub:'app',workspaceId:fixture.value.workspace_id,viewer:'alice',tower:'tower',service:'service'},file='00000000-0000-4000-8000-000000000002';
const binding=parseGenericNapplet(html(fixture.manifest),fixture.metadata);
it('keeps legacy exact, validates generic future metrics and distinguishes unavailable from zero',()=>{
 const v=copy();expect(()=>REPORT_MODEL.validate(v)).toThrow();
 v.storage.groups.push({id:'future_group',metrics:[{id:'future_metric',method:'new-method',unit:'bytes',value:0,status:'actual'}]});
 const result=REPORT_MODEL.validateWithStorage(v);expect(result.storage.groups.at(-1).metrics[0].value).toBe(0);expect(result.storage.groups[0].metrics.at(-1).value).toBeNull();
 const {storage,...legacy}=v;expect(REPORT_MODEL.validate(legacy)).toEqual(legacy);
});
it.each([
 v=>delete v.storage,v=>v.storage.workspace_id=file,v=>v.storage.as_of='2026-01-02T00:00:00.000Z',v=>v.storage.activity_range_applies=true,v=>v.storage.groups.push(v.storage.groups[0]),v=>v.storage.groups[0].metrics.push(v.storage.groups[0].metrics[0]),v=>v.storage.groups[0].metrics[0].value=null,v=>v.storage.groups[0].metrics[0].value=-1,v=>v.storage.groups[0].metrics[0].value=Number.MAX_SAFE_INTEGER+1,v=>v.storage.groups[0].metrics[0].value=-0,v=>v.storage.groups[0].metrics[0].unit='USD',v=>v.storage.groups[0].metrics.at(-1).value=0,v=>v.storage.groups[0].id='<script>',v=>v.storage.groups[0].metrics[0].method='x'.repeat(65),v=>v.storage.groups=Array.from({length:9},(_,i)=>({id:`g${i}`,metrics:[]})),v=>v.storage.groups[0].metrics=Array.from({length:33},(_,i)=>({id:`m${i}`,value:0,unit:'count',method:'count',status:'estimated'})),v=>v.storage.caveats=Array(17).fill('x'),v=>v.storage.caveats=['x'.repeat(1025)],v=>v.storage.last_object_completed_at='invalid',v=>v.storage.extra='private',v=>v.activity.messages=1
])('rejects invalid/oversized storage or original report without partial success %#',mutate=>{const v=copy();mutate(v);expect(()=>REPORT_MODEL.validateWithStorage(v)).toThrow();});
it('binds @2 manifest to approval, current workspace, exact range read and no writes or arbitrary queries',async()=>{
 const old=structuredClone(fixture.manifest);old.bindings.summary.version=1;const legacy=parseGenericNapplet(html(old),fixture.metadata);
 expect((await genericReceipt(context,file,'a'.repeat(64),binding,false)).fingerprint).not.toBe((await genericReceipt(context,file,'a'.repeat(64),legacy,false)).fingerprint);
 for(const version of [0,3,'2']){const m=structuredClone(fixture.manifest);m.bindings.summary.version=version;expect(()=>parseGenericNapplet(html(m),fixture.metadata)).toThrow();}
 const frame={},request={type:'wingman-napplet-data',version:2,session:'a'.repeat(32),requestId:'r',binding:'summary',operation:'read',range:'all'},event={source:frame,origin:'null',data:request};
 expect(validGenericRequest(event,frame,request.session,binding)).toBe(true);expect(validGenericRequest({...event,data:{...request,sql:'select 1'}},frame,request.session,binding)).toBe(false);
 const transport={getTowerPgFile:async()=>({file:{id:file,workspace_id:context.workspaceId,current_version_id:file,channel_id:file,metadata:fixture.metadata},can_write:false}),getTowerPgChannel:async()=>({channel:{id:file,workspace_id:context.workspaceId}})};
 const query=vi.fn(async()=>copy()),data=new GenericNappletData(context,file,binding,{transport,query});data.grant(false);
 expect((await data.read('all')).value.storage).toEqual(fixture.value.storage);expect(query.mock.calls[0][2]).toEqual({storage:true});
 await expect(data.save(file,{})).rejects.toThrow('Read only');query.mockRejectedValue(Object.assign(Error('denied'),{status:403}));await expect(data.read('all')).rejects.toMatchObject({status:403});data.stop();await expect(data.read('all')).rejects.toThrow();
 const payload={...copy(),identity:{workspace_id:context.workspaceId,app_npub:'app',tower_service_npub:'tower',workspace_service_npub:'service'}};
 expect(normalizeWorkspaceReport(payload,context,'all',{storage:true}).identity).toBeUndefined();payload.identity.workspace_id=file;expect(()=>normalizeWorkspaceReport(payload,context,'all',{storage:true})).toThrow();
});
it('packages a generic same-app cartridge with safely escaped future labels, zero and unavailable',async()=>{
 const source=await genericWorkspaceReportBundle({storage:true});expect(parseGenericNapplet(source,fixture.metadata)).toMatchObject({appId:'workspace-report-generic',version:2,name:'summary'});
 const dom=new JSDOM(source,{runScripts:'dangerously',beforeParse(w){w.TextEncoder=TextEncoder;}});const view=dom.window.WorkspaceStorageView;
 const s=structuredClone(fixture.value.storage);s.caveats.push('<img src=x onerror=alert(1)>');s.groups.push({id:'future_group',metrics:[{id:'new_metric',value:0,unit:'count',method:'new-method',status:'actual'}]});view.render(s);
 const root=dom.window.document.querySelector('#storage');expect(root.hidden).toBe(false);expect(root.textContent).toContain('Unavailable');expect(root.textContent).toContain('new metric');expect(root.textContent).toContain('0');expect(root.querySelector('img')).toBeNull();view.clear();expect(root.hidden).toBe(true);expect(root.querySelector('#storage-groups').children).toHaveLength(0);dom.window.close();
});
it('maps admin denial distinctly only for @2 and removes the frame on revoked authority',async()=>{
 const {GenericNappletFrame}=await import('../src/napplets/generic-frame.js');
 const errors=(await import('./fixtures/napplets/workspace-storage-errors-v1.json')).default;
 const target=new EventTarget();vi.stubGlobal('addEventListener',target.addEventListener.bind(target));vi.stubGlobal('removeEventListener',target.removeEventListener.bind(target));vi.stubGlobal('document',{visibilityState:'visible'});
 try{
  for(const [version,status,expected] of [[2,403,errors.forbidden],[2,503,errors.unavailable],[1,403,errors.unavailable]]){
   const data={binding:{...binding,version},stopped:false,authority:vi.fn(async()=>{}),read:vi.fn(async()=>{throw Object.assign(Error('private server details'),{status});}),stop(){this.stopped=true;}};
   const contentWindow={postMessage:vi.fn()},host=new GenericNappletFrame(data);host.attach({contentWindow},errors.request.session);
   const event=new Event('message');Object.assign(event,{source:contentWindow,origin:'null',data:errors.request});target.dispatchEvent(event);
   await vi.waitFor(()=>expect(contentWindow.postMessage).toHaveBeenCalledOnce());expect(contentWindow.postMessage.mock.calls[0][0]).toEqual(expected);
   const revoke=vi.fn();host.onRevoke=revoke;data.authority.mockRejectedValue(Object.assign(Error('revoked'),{status:403}));await host.check();expect(revoke).toHaveBeenCalledOnce();expect(data.stopped).toBe(true);host.stop();
  }
 }finally{vi.unstubAllGlobals();}
});
it('rechecks @2 administrative aggregate permission on foreground checks and tears down stale totals',async()=>{
 const {GenericNappletFrame}=await import('../src/napplets/generic-frame.js');const errors=(await import('./fixtures/napplets/workspace-storage-errors-v1.json')).default;
 const target=new EventTarget();vi.stubGlobal('addEventListener',target.addEventListener.bind(target));vi.stubGlobal('removeEventListener',target.removeEventListener.bind(target));vi.stubGlobal('document',{visibilityState:'visible'});
 let host;
 try{
  const data={binding,stopped:false,authority:vi.fn(async()=>{}),read:vi.fn(async()=>({value:copy(),canWrite:false,privacy:'viewer-channels'})),stop(){this.stopped=true;}};
  const contentWindow={postMessage:vi.fn()},revoked=vi.fn();host=new GenericNappletFrame(data,{onRevoke:revoked});host.attach({contentWindow},errors.request.session);
  const event=new Event('message');Object.assign(event,{source:contentWindow,origin:'null',data:errors.request});target.dispatchEvent(event);await vi.waitFor(()=>expect(contentWindow.postMessage).toHaveBeenCalledOnce());
  await host.check();expect(data.read).toHaveBeenCalledTimes(2);expect(contentWindow.postMessage).toHaveBeenCalledTimes(2);
  data.read.mockRejectedValue(Object.assign(Error('admin revoked'),{status:403}));await host.check();expect(revoked).toHaveBeenCalledOnce();expect(data.stopped).toBe(true);
 }finally{host?.stop();vi.unstubAllGlobals();}
});
