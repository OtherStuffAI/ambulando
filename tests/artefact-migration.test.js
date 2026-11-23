import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrationSource, importMigration } from '../scripts/artefact-migration.mjs';
import { templateSource } from '../src/artefact-templates.js';
const dirs=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function folder(){const d=await mkdtemp(path.join(os.tmpdir(),'migration-test-'));dirs.push(d);await writeFile(path.join(d,'index.html'),'<h1>Original</h1>');return d;}
const options=folder=>({folder,type:'system-flow',sourceUrl:'https://legacy.example/artifacts/project/flow/v2/',sourceVersion:'v2',title:'Flow'});
it('hydrates schema3 scenes and retains exact flow/index/scene source bytes',async()=>{
 const d=await folder(),base=templateSource('system-flow','system');
 const flow={schemaVersion:3,rootDiagramId:'main',diagrams:[{id:'main',title:'Main',nodes:base.nodes,edges:base.edges}],whiteboards:[{id:'board',title:'Board',currentSceneId:'current',proposedSceneId:'proposed'}]};
 const original=JSON.stringify(flow,null,4);await writeFile(path.join(d,'flow.json'),original);await mkdir(path.join(d,'scenes'));
 for(const name of ['current','proposed'])await writeFile(path.join(d,`scenes/${name}.json`),JSON.stringify({elements:[],appState:{},files:{}}));
 const source=await migrationSource(options(d));
 expect(Object.keys(JSON.parse(source.bytes).scenes)).toEqual(['current','proposed']);
 expect(Buffer.from(JSON.parse(source.archive).files.find(f=>f.path==='flow.json').base64,'base64').toString()).toBe(original);
 await rm(path.join(d,'scenes/proposed.json'));
 await expect(migrationSource(options(d))).rejects.toThrow();
});
function fake(){
 const files=[],objects=new Map(),versions=new Map();let serial=0;
 const hash=b=>createHash('sha256').update(b).digest('hex');
 return {files,objects,versions,
 request:async(_m,p)=>p.includes('/files?')?{files}: {channel:{id:'channel',workspace_id:'workspace'}},
 uploadObject:async({bytes})=>{const id='object'+(++serial);objects.set(id,Buffer.from(bytes));return id;},
 createFile:async(_c,b)=>{const id='file'+(++serial),v={id:'version'+serial,version_number:1,sha256_hex:hash(objects.get(b.storage_object_id))};const f={id,metadata:b.metadata};files.push(f);versions.set(id,{current_version_id:v.id,versions:[v],bytes:objects.get(b.storage_object_id)});return{file:f};},
 listVersions:async id=>versions.get(id), readVersionBytes:async (id,version)=>versions.get(id).historyBytes?.get(version)||versions.get(id).bytes,
 };
}
it('imports once, resumes after response loss, and rejects changed source provenance',async()=>{
 const d=await folder();await writeFile(path.join(d,'flow.json'),JSON.stringify(templateSource('system-flow','system')));
 const s=await migrationSource(options(d)),c=fake();
 await expect(importMigration(c,'workspace','channel',s)).rejects.toThrow('audiences');
 const create=c.createFile;let lose=true;c.createFile=async(...args)=>{const r=await create(...args);if(lose){lose=false;throw Error('response lost');}return r;};
 await expect(importMigration(c,'workspace','channel',s,{audienceVerified:true})).rejects.toThrow('response lost');
 expect(c.files).toHaveLength(1);
 const r=await importMigration(c,'workspace','channel',s,{audienceVerified:true});
 expect(c.files).toHaveLength(2);expect(r.provenance.history_policy).toBe('latest-selected-only');
 expect((await importMigration(c,'workspace','channel',s,{audienceVerified:true})).reused).toBe(true);expect(c.files).toHaveLength(2);
 const primary=c.versions.get(r.file_id),first=primary.versions[0];primary.historyBytes=new Map([[first.id,primary.bytes]]);primary.bytes=Buffer.from(JSON.stringify({...JSON.parse(primary.bytes),title:'Later user edit'}));const edited={id:'later-version',version_number:2,sha256_hex:createHash('sha256').update(primary.bytes).digest('hex')};primary.versions.push(edited);primary.current_version_id=edited.id;
 const retry=await importMigration(c,'workspace','channel',s,{audienceVerified:true});expect(retry.version_id).toBe('later-version');expect(JSON.parse(primary.bytes).title).toBe('Later user edit');
 await writeFile(path.join(d,'flow.json'),JSON.stringify({...templateSource('system-flow','system'),title:'Changed'}));
 await expect(importMigration(c,'workspace','channel',await migrationSource(options(d)),{audienceVerified:true})).rejects.toThrow('changed since import');
});
it('rejects HTML imports that would silently remove navigation',async()=>{
 const d=await folder();await writeFile(path.join(d,'index.html'),'<a href="../v1/">Earlier</a>');
 await expect(migrationSource({...options(d),type:'html'})).rejects.toThrow('packaging changes');
 const reviewed=await migrationSource({...options(d),type:'html',legacyNavigationReviewed:true});expect(reviewed.provenance.limitations[0]).toContain('legacy original');expect(JSON.parse(reviewed.archive).files).toHaveLength(1);
});

it.each([true, undefined])('refuses unconfirmed private storage (%s) before uploading source bytes',async isPublic=>{
 const {towerClient}=await import('../scripts/html-artifact/tower.mjs');const requests=[];
 const c=towerClient({baseUrl:'https://tower.example',workspaceId:'workspace',sign:async()=>({authorization:'Nostr test'}),fetchImpl:async(url,options)=>{requests.push({url,method:options.method});return new Response(JSON.stringify({object_id:'public-object',is_public:isPublic}),{status:200,headers:{'content-type':'application/json'}});}});
 await expect(c.uploadObject({bytes:Buffer.from('private source'),contentType:'application/json',fileName:'flow.json'})).rejects.toThrow('Private storage');
 expect(requests).toEqual([{url:'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/storage/prepare',method:'POST'}]);
});
