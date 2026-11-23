import {beforeEach,it,expect,vi} from 'vitest';
import {NappletRuntimeData,loadRuntimeBundle,validateInstallation} from '../src/napplets/runtime-data.js';
import {sha256} from '../src/napplets/generic-protocol.js';
import manifest from './fixtures/napplet-runtime-v3/manifest.json';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={workspaceId:id(1),appNpub:'app',viewer:'alice'};
let installation,collection,record,transport,active;
beforeEach(()=>{
 active=true;installation={workspace_id:context.workspaceId,app_npub:'app',napplet_id:manifest.napplet_id,owner_npub:'alice',publisher_npub:'bot',audience_npubs:['alice'],removed:false,revision:1,manifest:structuredClone(manifest),bundle:{file_id:id(2),file_version_id:id(3),sha256_hex:'a'.repeat(64)}};
 collection={workspace_id:context.workspaceId,app_npub:'app',napplet_id:manifest.napplet_id,id:id(4),name:'entries',scope:'personal',schema_version:1,owner_npub:'alice',read_npubs:[],write_npubs:[],revision:1};record={collection_id:id(4),id:'entry_1',revision:1,schema_version:1,data:{zero:0,answered:false},deleted:false};
 transport={read:vi.fn(async path=>path.includes('/records?')?{records:[structuredClone(record)],next_cursor:null}:path.includes('/records/')?{record:structuredClone(record)}:path.includes('/collections?')?{collections:[structuredClone(collection)],next_cursor:null}:{installation:structuredClone(installation)}),command:vi.fn(async(_p,method,b)=>{if(b.expected_revision!==record.revision)throw Object.assign(Error('conflict'),{status:409});record={...record,revision:record.revision+1,data:b.data??null,deleted:method==='DELETE'};return {record:structuredClone(record)};})};
});
const owner=()=>new NappletRuntimeData(context,structuredClone(installation),{transport,current:()=>active});
it('checks authenticated namespace/audience and digest, not a self-declared publisher',async()=>{
 expect(validateInstallation(installation,context,manifest.napplet_id)).toBe(installation);
 for(const patch of [{workspace_id:id(8)},{app_npub:'other'},{napplet_id:'other'},{removed:true},{owner_npub:'bob',publisher_npub:'bot',audience_npubs:['bob']}])expect(()=>validateInstallation({...installation,...patch},context,manifest.napplet_id)).toThrow();
 const html='<script id="wingman-napplet-manifest">'+JSON.stringify(manifest)+'</script>',bytes=new TextEncoder().encode(html);installation.bundle.sha256_hex=await sha256(bytes);
 const files={getTowerPgFileVersionObjectBytes:async()=>({bytes,contentType:'text/html'})};expect((await loadRuntimeBundle(installation,context,files)).manifest).toEqual(manifest);installation.bundle.sha256_hex='0'.repeat(64);await expect(loadRuntimeBundle(installation,context,files)).rejects.toThrow('integrity');
});
it('reads bounded record pages, maps exact CAS and confirms readback',async()=>{
 const d=owner();await expect(d.execute({collection:'entries',operation:'list',limit:1,cursor:null})).rejects.toThrow('Approval');d.grant();
 expect(await d.execute({collection:'entries',operation:'list',limit:1,cursor:null})).toEqual({records:[record],next_cursor:null});
 const r=await d.execute({collection:'entries',operation:'update',record_id:'entry_1',base_revision:1,value:{zero:0,done:false}});expect(r.record.data).toEqual({zero:0,done:false});expect(transport.command).toHaveBeenCalledWith(expect.stringContaining('/records/entry_1'),'PUT',{expected_revision:1,schema_version:1,data:{zero:0,done:false}});
 await expect(d.execute({collection:'entries',operation:'update',record_id:'entry_1',base_revision:1,value:{}})).rejects.toMatchObject({status:409});expect(record.data).toEqual({zero:0,done:false});
});
it('does not use collection grants as app audience and rechecks revoked collection access',async()=>{
 const d=owner();d.grant();installation.audience_npubs=[];installation.owner_npub='someone';await expect(d.authority()).rejects.toThrow('audience');
 installation.owner_npub='alice';transport.read.mockImplementation(async path=>path.includes('/collections?')?{collections:[],next_cursor:null}:{installation});await expect(d.execute({collection:'entries',operation:'get',record_id:'entry_1'})).rejects.toThrow('request access');expect(transport.command).not.toHaveBeenCalled();
});
it('requires explicit selection for ambiguous datasets and honors own-personal default',async()=>{
 const other={...collection,id:id(5),owner_npub:'bob'},d=owner();d.grant();transport.read.mockImplementation(async()=>({collections:[other,collection],next_cursor:null}));expect((await d.collection('entries')).id).toBe(collection.id);
 d.selectCollection('entries',other.id);expect((await d.collection('entries')).id).toBe(other.id);
 transport.read.mockResolvedValue({collections:[other,{...other,id:id(6)}],next_cursor:null});d.selection.clear();await expect(d.collection('entries')).rejects.toThrow('unambiguous');
});
it('drops in-flight private results after identity switch and never retries uncertain writes',async()=>{
 const d=owner();d.grant();transport.read.mockImplementation(async()=>{active=false;return {collections:[collection],next_cursor:null};});await expect(d.execute({collection:'entries',operation:'get',record_id:'entry_1'})).rejects.toThrow('context');expect(transport.command).not.toHaveBeenCalled();
 active=true;const e=owner();e.grant();transport.read.mockResolvedValue({collections:[collection],next_cursor:null});transport.command.mockRejectedValue(Error('lost acknowledgement'));await expect(e.execute({collection:'entries',operation:'update',record_id:'entry_1',base_revision:1,value:{}})).rejects.toThrow('lost');expect(transport.command).toHaveBeenCalledTimes(1);e.stop();expect(e.collections.size).toBe(0);await expect(e.authority()).rejects.toThrow('context');
});
it('rejects publisher change, preserves bound code on compatible update until host swaps',async()=>{
 const d=owner();installation.bundle.file_version_id=id(9);expect((await d.authority()).updateAvailable).toBe(true);expect(d.installation.bundle.file_version_id).toBe(id(3));installation.publisher_npub='other';await expect(d.authority()).rejects.toThrow('Publisher');
});

it('reauthorization clears access when a previously used personal dataset is revoked',async()=>{
 const d=owner();d.grant();await d.execute({collection:'entries',operation:'list',limit:1,cursor:null});
 transport.read.mockImplementation(async path=>path.includes('/collections?')?{collections:[],next_cursor:null}:{installation});await expect(d.authority()).rejects.toThrow('request access');
});
