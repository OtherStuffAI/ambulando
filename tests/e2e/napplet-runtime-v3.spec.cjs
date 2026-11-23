const {test,expect}=require('playwright/test');
const {build}=require('esbuild');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');let bundle,html,hostDigest;
test.use({serviceWorkers:'allow',actionTimeout:10000});test.setTimeout(90000);
test.beforeAll(async()=>{
 const source=fs.readFileSync(path.join(root,'index.html'),'utf8'),start=source.indexOf('<dialog id="napplet-runtime-dialog"');
 const css=(await build({entryPoints:[path.join(root,'src/styles.css')],bundle:true,write:false,logLevel:'silent',loader:{'.woff2':'dataurl','.woff':'dataurl','.png':'dataurl','.svg':'dataurl'}})).outputFiles[0].text;
 const dialog=source.slice(start,source.indexOf('</dialog>',start)+9);
 html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main x-data><template x-for="app in $store.chat.runtimeApps" :key="app.napplet_id"><button @click="$store.chat.openRuntimeNapplet(app.napplet_id)" x-text="app.display_name"></button></template>${dialog}</main><script type="module" src="/__runtime.js"></script></body></html>`;
 bundle=(await build({bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1testapp')},plugins:[{name:'fixture-api',setup(b){b.onResolve({filter:/api\.js$/},a=>a.importer.startsWith(root+'/src/')?{path:'runtime-api',namespace:'runtime-api'}:null);b.onLoad({filter:/.*/,namespace:'runtime-api'},()=>({resolveDir:root,contents:`export * from '${root}/src/api.js';export const nappletRequest=(...a)=>window.fixture.request(...a);export const nappletBundleRequest=async(_w,id)=>({bytes:window.fixture.blobs.get(window.fixture.installations.get(id).bundle.file_version_id),contentType:'text/html'});export const getTowerPgFileVersionObjectBytes=(...a)=>window.fixture.bytes(...a);`}));}}],stdin:{resolveDir:root,contents:`
 import Alpine from 'alpinejs';import {runtimeManagerMixin} from './src/napplets/runtime-manager.js';import {openWorkspaceDb} from './src/db.js';import {TowerSyncService} from './src/tower-sync-service.js';import {readRuntimeTarget,readRuntimeBundleTarget,prepareRuntimeCommand} from './src/napplets/runtime-sync.js';import {readNappletTarget} from './src/napplets/generic-reads.js';import {registerCanvasHtml} from './src/canvas/html-naplet.js';
 const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),workspace=id(1),app='npub1testapp';
 window.fixture={installations:new Map(),collections:new Map(),records:new Map(),blobs:new Map(),history:[],denied:false,calls:[],bytes:async(_w,_f,v)=>({bytes:window.fixture.blobs.get(v),contentType:'text/html'}),request:async(_w,path,o={})=>{
   const f=window.fixture,s=window.Alpine.store('chat'),url=new URL('/'+path,'http://fixture'),parts=url.pathname.split('/').filter(Boolean),i=f.installations.get(parts[0]),method=o.method||'GET',body=o.body||{};
   f.calls.push({path,method,body});if(f.denied)throw Object.assign(Error('denied'),{status:403});
   const visible=x=>x.owner_npub===s.currentViewerNpub||x.publisher_npub===s.currentViewerNpub||x.audience_npubs.includes(s.currentViewerNpub);
   if(!parts.length)return {installations:[...f.installations.values()].filter(x=>!x.removed&&visible(x)),next_cursor:null};
   if(!i||!visible(i))throw Object.assign(Error('unavailable'),{status:404});
   if(parts.length===1){if(method==='DELETE'){if(body.expected_revision!==i.revision)throw Object.assign(Error('conflict'),{status:409});i.removed=true;if(body.data==='delete'){for(const [key,c] of f.collections)if(c.napplet_id===i.napplet_id){f.collections.delete(key);f.records.delete(key);}}}return {installation:structuredClone(i)};}
   if(parts[1]==='collections'&&parts.length===2){if(method==='POST'){const c={...body,id:id(f.collections.size+20),workspace_id:workspace,app_npub:app,napplet_id:i.napplet_id,owner_npub:s.currentViewerNpub,revision:1};f.collections.set(c.id,c);f.records.set(c.id,new Map());return {collection:c};}return {collections:[...f.collections.values()].filter(c=>c.napplet_id===i.napplet_id&&(c.owner_npub===s.currentViewerNpub||c.read_npubs.includes(s.currentViewerNpub)||c.write_npubs.includes(s.currentViewerNpub))),next_cursor:null};}
   const c=f.collections.get(parts[2]);if(!c||c.napplet_id!==i.napplet_id||!(c.owner_npub===s.currentViewerNpub||c.read_npubs.includes(s.currentViewerNpub)||c.write_npubs.includes(s.currentViewerNpub)))throw Object.assign(Error('denied'),{status:403});
   const rows=f.records.get(c.id);if(parts.length===4)return {records:[...rows.values()].filter(r=>!r.deleted).slice(0,Number(url.searchParams.get('limit'))),next_cursor:null};
   const r=rows.get(parts[4]);if(method==='GET')return {record:structuredClone(r)};
   if(c.owner_npub!==s.currentViewerNpub&&!c.write_npubs.includes(s.currentViewerNpub))throw Object.assign(Error('denied'),{status:403});
   if((r?.revision||0)!==body.expected_revision)throw Object.assign(Error('conflict'),{status:409});const next={collection_id:c.id,id:parts[4],revision:(r?.revision||0)+1,schema_version:c.schema_version,data:body.data||null,deleted:method==='DELETE'};rows.set(next.id,next);f.history.push(structuredClone(next));return {record:structuredClone(next)};
 }};
 const db=openWorkspaceDb('runtime-browser-fixture');await db.open();await db.delete();await db.open();
 const store={session:{npub:'alice'},currentViewerNpub:'alice',currentPgActorId:'actor',currentWorkspaceKey:'runtime-browser-fixture',currentWorkspace:{workspaceId:workspace,directHttpsUrl:location.origin,pgMe:{actor:{actor_id:'actor',npub:'alice'}}},backendUrl:location.origin,isTowerPgMode:true,$nextTick:Alpine.nextTick};Object.defineProperties(store,Object.getOwnPropertyDescriptors(runtimeManagerMixin));
 store._towerSyncService=new TowerSyncService({workspaceKey:'fixture',families:{'napplet-runtime-bundle':{trackFreshness:false,load:(p,o)=>readRuntimeBundleTarget(Alpine.store('chat'),p,o)},'napplet-runtime':{trackFreshness:false,load:(p,o)=>readRuntimeTarget(Alpine.store('chat'),p,o)},'napplet-read':{trackFreshness:false,load:(p,o)=>readNappletTarget(Alpine.store('chat'),p,o)}},ports:{prepareCommand:(_n,input)=>prepareRuntimeCommand(Alpine.store('chat'),input)}});store.getTowerSyncService=function(){return this._towerSyncService;};
 Alpine.store('chat',store);window.Alpine=Alpine;registerCanvasHtml(Alpine,{name:'runtime-html',assetStore:()=>null,dataHost:()=>Alpine.store('chat').runtimeDataHost()});Alpine.start();Alpine.store('chat').initNappletRuntime();window.ready=true;
 `}})).outputFiles[0].text;
 hostDigest=crypto.createHash('sha256').update(bundle).digest('hex');
});
// Cartridge bytes are generated in the browser only AFTER the host bundle above
// is frozen. Names/content never enter its compiled source. This is fixture
// transport evidence, not a live NStack delivery claim.
async function publish(page,name,version=1){return page.evaluate(async({name,version})=>{
 const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),f=window.fixture,s=window.Alpine.store('chat'),existing=f.installations.get(name),v=id(100+f.blobs.size);
 const manifest={version:3,napplet_id:name,bundle_version:String(version),title:name,icon:'🌱',runtime:{protocol:3,min_host:3},collections:{entries:{scope:'personal',schema_version:1,operations:['list','get','create','update','delete']}},capabilities:{}};
 const html='<style>body{font:16px system-ui;margin:1rem;overflow-wrap:anywhere}output{white-space:pre-wrap;overflow-wrap:anywhere}button{min-height:44px}</style><h1>'+name+' '+version+'</h1><button id="save">Save note</button><output id="value"></output><script id="wingman-napplet-manifest" type="application/json">'+JSON.stringify(manifest)+'</'+'script><script>let revision=0;const send=(operation,extra={})=>parent.postMessage({type:"wingman-napplet-data",version:3,session:window.nappletSession,requestId:crypto.randomUUID(),operation,collection:"entries",...extra},"*");addEventListener("message",e=>{const d=e.data;if(d.type!=="wingman-napplet-result")return;document.querySelector("output").textContent=JSON.stringify(d);if(d.result?.record)revision=d.result.record.revision;else if(d.result?.records?.length)revision=d.result.records[0].revision;});document.querySelector("#save").onclick=()=>send(revision?"update":"create",{record_id:"note",base_revision:revision,value:{text:"retained",zero:0,done:false}});send("list",{limit:50,cursor:null});</'+'script>';
 const bytes=new TextEncoder().encode(html),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');f.blobs.set(v,bytes);
 f.installations.set(name,{workspace_id:s.currentWorkspace.workspaceId,app_npub:'npub1testapp',napplet_id:name,owner_npub:'alice',publisher_npub:'bot',audience_npubs:['alice'],display_name:name,manifest,bundle:{file_id:id(90),file_version_id:v,sha256_hex:digest},revision:(existing?.revision||0)+1,removed:false,pending_release:null});await s.loadRuntimeApps({force:true});return name;
 },{name,version});}
test('fixture: two post-build cartridges, data-preserving automatic update, revocation and context teardown',async({page})=>{
 page.on('dialog',dialog=>dialog.accept());const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{const p=new URL(r.request().url()).pathname;if(p==='/__runtime.js')return r.fulfill({contentType:'text/javascript',body:bundle});if(p==='/__runtime.html')return r.fulfill({contentType:'text/html',body:html});return r.abort();});
 await page.goto('/__runtime.html');await page.waitForFunction(()=>window.ready);
 const first='app-'+crypto.randomBytes(5).toString('hex'),second='app-'+crypto.randomBytes(5).toString('hex');expect(bundle).not.toContain(first);expect(bundle).not.toContain(second);
 await publish(page,first);await publish(page,second);await expect(page.getByRole('button',{name:first,exact:true})).toBeVisible();await expect(page.getByRole('button',{name:second,exact:true})).toBeVisible();
 await page.getByRole('button',{name:first,exact:true}).click();await page.getByRole('button',{name:'Approve and open',exact:true}).click();
 await page.locator('#napplet-runtime-dialog summary').first().click();await page.getByRole('button',{name:'Create personal collection: entries',exact:true}).click();
 let frame=page.frameLocator('#napplet-runtime-dialog iframe');await page.locator('#napplet-runtime-dialog summary').first().click();await frame.getByRole('button',{name:'Save note',exact:true}).click();await expect(frame.locator('output')).toContainText('"text":"retained"');
 await publish(page,first,2);await page.evaluate(()=>window.Alpine.store('chat').refreshRuntimeAuthority());await expect(frame.getByRole('heading')).toHaveText(first+' 2');await expect(frame.locator('output')).toContainText('"text":"retained"');await expect(page.getByRole('button',{name:'Approve and open',exact:true})).toBeHidden();
 for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:844});expect(await page.locator('#napplet-runtime-dialog').evaluate(e=>e.scrollWidth<=innerWidth)).toBe(true);expect(await frame.locator('body').evaluate(e=>e.scrollWidth<=innerWidth)).toBe(true);}
 expect(crypto.createHash('sha256').update(bundle).digest('hex')).toBe(hostDigest);
 await page.evaluate(first=>{const i=window.fixture.installations.get(first),manifest=structuredClone(i.manifest);manifest.collections.secret={scope:'team',schema_version:1,operations:['list']};i.pending_release={manifest,bundle:i.bundle};},first);
 await page.evaluate(first=>window.Alpine.store('chat').openRuntimeNapplet(first),first);
 await expect(frame.getByRole('heading')).toHaveText(first+' 2');await expect(page.getByRole('button',{name:'Approve and open',exact:true})).toBeHidden();
 // Decline expansion by leaving pending untouched. The prior active version
 // remains functional and no new collection grant has been created.
 expect(await page.evaluate(first=>window.fixture.installations.get(first).manifest.collections.secret,first)).toBeUndefined();await expect(frame.locator('output')).toContainText('"text":"retained"');
 await page.evaluate(async first=>{const s=window.Alpine.store('chat');s.closeRuntimeNapplet(true);await s.removeRuntimeNapplet({nappletId:first},'keep');},first);
 expect(await page.evaluate(()=>[...window.fixture.records.values()].some(rows=>rows.has('note')))).toBe(true);
 await publish(page,first,3);await page.getByRole('button',{name:first,exact:true}).click();await expect(frame.getByRole('heading')).toHaveText(first+' 3');await expect(frame.locator('output')).toContainText('"text":"retained"');
 await page.evaluate(()=>{window.fixture.denied=true;return window.Alpine.store('chat').refreshRuntimeAuthority();});await expect(page.locator('#napplet-runtime-dialog iframe')).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('no longer available');
 await page.evaluate(()=>{window.fixture.denied=false;window.Alpine.store('chat').closeRuntimeNapplet(true);});await page.getByRole('button',{name:second,exact:true}).click();await page.getByRole('button',{name:'Approve and open',exact:true}).click();await expect(page.locator('#napplet-runtime-dialog iframe')).toHaveCount(1);
 await page.evaluate(async first=>{const s=window.Alpine.store('chat');s.closeRuntimeNapplet(true);await s.removeRuntimeNapplet({nappletId:first},'delete');},first);
 expect(await page.evaluate(()=>[...window.fixture.records.values()].some(rows=>rows.has('note')))).toBe(false);
 expect(await page.evaluate(()=>window.fixture.blobs.size)).toBeGreaterThanOrEqual(4);
 await page.getByRole('button',{name:second,exact:true}).click();await expect(page.locator('#napplet-runtime-dialog iframe')).toHaveCount(1);
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.currentViewerNpub='bob';s._towerSyncService.dispose('identity-change');});await expect(page.locator('#napplet-runtime-dialog iframe')).toHaveCount(0);
 expect(errors).toEqual([]);console.log(JSON.stringify({kind:'fixture-only',frozenHostSha256:hostDigest,postBuildApps:[first,second],updatesWithoutConsent:true,retainedData:true}));
});
