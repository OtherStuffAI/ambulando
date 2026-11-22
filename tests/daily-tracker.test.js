import { expect, it, vi } from 'vitest';
import { FileNappletData, TRACKER_MODEL as M, parseFileNapplet, validFileNappletRequest } from '../src/napplets/file-data.js';
import { FileNappletFrame } from '../src/napplets/file-frame.js';
import { packageTrackerBundle } from '../src/napplets/tracker-bundle.js';
import { readFile } from 'node:fs/promises';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const metrics=[{id:id(1),label:'A custom label',type:'boolean',unit:'',archived:false},{id:id(2),label:'Weight',type:'number',unit:'kg',archived:false},{id:id(3),label:'Optional',type:'boolean',unit:'',archived:false}];
const value=()=>({format:'daily-tracker-v1',metrics:structuredClone(metrics),days:{'2026-11-22':{[id(1)]:false,[id(2)]:0}}});
it('preserves false and zero, distinguishes unanswered, validates real local calendar dates',()=>{
 const parsed=M.validate(JSON.parse(JSON.stringify(value())));expect(parsed.days['2026-11-22']).toEqual({[id(1)]:false,[id(2)]:0});expect(Object.hasOwn(parsed.days['2026-11-22'],id(3))).toBe(false);
 expect(M.localDate(new Date(2026,0,1,0,1))).toBe('2026-01-01');expect(M.localDate(new Date(2026,11,31,23,59))).toBe('2026-12-31');
 expect(M.validDate('2024-02-29')).toBe(true);for(const date of ['2026-02-29','2026-04-31','2026-13-01','0000-01-01'])expect(M.validDate(date)).toBe(false);
 const bad=value();bad.days['2026-11-22'][id(2)]=null;expect(()=>M.validate(bad)).toThrow();
});
it('archives and reorders while retaining history and prevents changing used metric type',()=>{
 const before=value(),next=value();next.metrics.reverse();next.metrics[2].archived=true;next.days['2026-11-21']={[id(2)]:72};expect(M.validateReplacement(before,next).days['2026-11-21'][id(2)]).toBe(72);
 next.metrics[2].type='number';expect(()=>M.validateReplacement(before,next)).toThrow();
});
async function fixture(){
 let model=value(),version=id(10),denied=false,wrongChannel=false,canWrite=true;const objects=new Map();
 const bytes=()=>new TextEncoder().encode(JSON.stringify(model));
 const sha=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
 const api={
 getTowerPgFile:vi.fn(async(_w,file)=>{if(denied)throw Object.assign(Error('denied'),{status:403});return {file:{id:file,workspace_id:id(20),channel_id:id(30),current_version_id:file===id(40)?id(41):version,current_version:null,can_write:canWrite,...(file===id(40)?{metadata:{napplet:{version:1,app_id:'daily-tracker',bindings:{tracker:{file_id:id(50)}}}}}:{})}};}),
 getTowerPgChannel:vi.fn(async()=>({channel:{id:id(30),workspace_id:id(20),kind:'dm',participant_npubs:wrongChannel?['someone-else']:['viewer']}})),
 getTowerPgFileVersions:vi.fn(async()=>({current_version_id:version,versions:[{id:version,content_type:'application/json',size_bytes:bytes().length,sha256_hex:await sha(bytes())}]})),
 getTowerPgFileVersionObjectBytes:vi.fn(async()=>({bytes:bytes(),contentType:'application/json'})),
 prepareTowerPgStorageObject:vi.fn(async()=>({object_id:id(60)})),uploadStorageObject:vi.fn(async(p,b)=>objects.set(p.object_id,b)),completeStorageObject:vi.fn(async()=>{}),
 createTowerPgFileVersion:vi.fn(async(_w,_f,body)=>{if(body.base_version_id!==version)throw Object.assign(Error('stale'),{status:409});model=JSON.parse(new TextDecoder().decode(objects.get(body.storage_object_id)));version=id(Number(version.slice(-12))+1);return {version:{id:version}};})};
 const create=()=>new FileNappletData({workspaceId:id(20),viewer:'viewer'},id(40),{appId:'daily-tracker',fileId:id(50)},{transport:api});
 return {api,create,access:v=>canWrite=v,deny:()=>denied=true,wrong:()=>wrongChannel=true,model:()=>model};
}
it('saves/reopens history through File versions and refuses stale concurrent device writes',async()=>{
 const f=await fixture(),a=f.create(),b=f.create();const first=await a.read();await b.read();const next=value();next.days['2026-11-21']={[id(2)]:75};
 const saved=await a.save(first.baseVersionId,next);expect(saved.value.days['2026-11-21'][id(2)]).toBe(75);
 await expect(b.save(first.baseVersionId,value())).rejects.toMatchObject({status:409});expect((await f.create().read()).value).toEqual(next);
});
it('fails closed for another self channel, revoked access and disposed late loads',async()=>{
 const f=await fixture();f.wrong();await expect(f.create().read()).rejects.toThrow('private self');expect(f.api.getTowerPgFileVersionObjectBytes).not.toHaveBeenCalled();
 const g=await fixture(),data=g.create();await data.read();g.deny();await expect(data.save(data.base,value())).rejects.toMatchObject({status:403});expect(g.api.uploadStorageObject).not.toHaveBeenCalled();
 const h=await fixture(),stopped=h.create();h.api.getTowerPgFileVersionObjectBytes.mockImplementation(async()=>{stopped.stop();return {bytes:new Uint8Array(),contentType:'application/json'};});await expect(stopped.read()).rejects.toThrow('context changed');expect(stopped.value).toBe(null);
});
it('validates exact source, nonce and message keys and grants no ordinary HTML bridge',async()=>{
 const parts=await Promise.all(['index.html','style.css','model.js','app.js'].map(n=>readFile(new URL(`../public/napplets/daily-tracker/v1/${n}`,import.meta.url),'utf8')));
 const html=packageTrackerBundle({html:parts[0],style:parts[1],model:parts[2],app:parts[3]});expect(html).not.toContain('src="app.js"');
 expect(parseFileNapplet('<h1>Ordinary</h1>',{})).toBe(null);
 const meta={napplet:{version:1,app_id:'daily-tracker',bindings:{tracker:{file_id:id(50)}}}};expect(parseFileNapplet(html,meta).fileId).toBe(id(50));
 const frame={},data={type:'wingman-napplet-data',version:1,session:'secret',requestId:'request1',operation:'read',binding:'tracker'};
 expect(validFileNappletRequest({source:frame,origin:'null',data},frame,'secret')).toBe(true);
 for(const event of [{source:{},origin:'null',data},{source:frame,origin:'https://bad',data},{source:frame,origin:'null',data:{...data,path:'/anything'}}])expect(validFileNappletRequest(event,frame,'secret')).toBe(false);
 expect(validFileNappletRequest({source:frame,origin:'null',data},frame,'old-session')).toBe(false);
});

it('generates UUIDv4 in opaque native contexts without randomUUID',()=>{
 const actual=globalThis.crypto;vi.stubGlobal('crypto',{getRandomValues:actual.getRandomValues.bind(actual)});
 try{expect(M.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);}finally{vi.unstubAllGlobals();}
});
it('keeps original base when publication acknowledgement is lost',async()=>{
 const f=await fixture(),data=f.create();const first=await data.read();const original=f.api.createTowerPgFileVersion.getMockImplementation();
 f.api.createTowerPgFileVersion.mockImplementation(async(...args)=>{await original(...args);throw Error('response lost');});
 const next=value();next.days['2026-11-21']={[id(2)]:20};await expect(data.save(first.baseVersionId,next)).rejects.toThrow('response lost');expect(data.base).toBe(first.baseVersionId);expect((await f.create().read()).value).toEqual(next);
});
it('does not report another concurrent value as its own successful save',async()=>{
 const f=await fixture(),data=f.create(),other=f.create();const first=await data.read();const original=f.api.createTowerPgFileVersion.getMockImplementation();let injected=false;
 f.api.createTowerPgFileVersion.mockImplementation(async(...args)=>{const result=await original(...args);if(!injected){injected=true;const r=await other.read();const next=value();next.days['2026-11-20']={[id(2)]:33};await other.save(r.baseVersionId,next);}return result;});
 await expect(data.save(first.baseVersionId,value())).rejects.toMatchObject({status:409});expect(data.base).toBe(first.baseVersionId);
});


it('rejects a crafted valid save after readonly consent broadens without creating a data version',async()=>{
 const f=await fixture();f.access(false);const data=f.create();data.grant((await data.authority()).canWrite);
 const first=await data.read(),postMessage=vi.fn(),onRevoke=vi.fn(),listeners=new Map();
 vi.stubGlobal('addEventListener',(name,fn)=>listeners.set(name,fn));vi.stubGlobal('removeEventListener',()=>{});
 const frame={contentWindow:{postMessage}},host=new FileNappletFrame(data,{onRevoke});
 try{
  host.attach(frame,'approved-readonly');f.access(true);
  const next=value();next.days['2026-11-21']={[id(2)]:75};
  await listeners.get('message')({source:frame.contentWindow,origin:'null',data:{type:'wingman-napplet-data',version:1,session:'approved-readonly',requestId:'crafted-save',operation:'save',binding:'tracker',baseVersionId:first.baseVersionId,value:next}});
  expect(f.api.prepareTowerPgStorageObject).not.toHaveBeenCalled();expect(f.api.createTowerPgFileVersion).not.toHaveBeenCalled();
  expect(f.model()).toEqual(value());expect(postMessage).not.toHaveBeenCalled();expect(onRevoke).toHaveBeenCalledOnce();expect(data.stopped).toBe(true);
 }finally{host.stop();vi.unstubAllGlobals();}
});
it('rejects changed access during read delivery and before publishing an uploaded save',async()=>{
 const f=await fixture(),data=f.create();data.grant(true);const first=await data.read();
 f.api.completeStorageObject.mockImplementation(async()=>f.access(false));
 await expect(data.save(first.baseVersionId,value())).rejects.toMatchObject({status:403});expect(f.api.createTowerPgFileVersion).not.toHaveBeenCalled();
 const g=await fixture(),reader=g.create();g.access(false);reader.grant(false);
 const original=g.api.getTowerPgFileVersionObjectBytes.getMockImplementation();
 g.api.getTowerPgFileVersionObjectBytes.mockImplementation(async()=>{const result=await original();g.access(true);return result;});
 await expect(reader.read()).rejects.toMatchObject({status:403});expect(reader.base).toBe('');
});
it('closes on foreground or periodic access broadening before any frame read',async()=>{
 const f=await fixture(),data=f.create();f.access(false);data.grant(false);
 vi.stubGlobal('addEventListener',()=>{});vi.stubGlobal('removeEventListener',()=>{});
 const onRevoke=vi.fn(),host=new FileNappletFrame(data,{onRevoke});
 try{host.attach({contentWindow:{}},'readonly');f.access(true);await host.check();expect(onRevoke).toHaveBeenCalledOnce();expect(data.stopped).toBe(true);}finally{host.stop();vi.unstubAllGlobals();}
});
