const {test,expect}=require('playwright/test');
const {build}=require('esbuild');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {serveBuiltFlightDeck}=require('./fixtures/serve-built-flightdeck.cjs');
let bundle,hostHtml;
test.use({hasTouch:true,serviceWorkers:'block',actionTimeout:15000});
test.setTimeout(60000);
test.beforeAll(async()=>{
 const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const dialog=source.slice(source.indexOf('<dialog id="artefact-dialog"'),source.indexOf('</dialog>',source.indexOf('<dialog id="artefact-dialog"'))+9);
 const styles=[...fs.readFileSync(path.join(root,'dist/index.html'),'utf8').matchAll(/<link[^>]+rel="stylesheet"[^>]+>/g)].map(m=>m[0]).join('');
 hostHtml=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body><div x-data><button @click="$store.chat.openArtefact(window.row,{appMode:true})">Open tracker</button>${dialog}</div><script type="module" src="/tracker-harness.js"></script></body></html>`;
 const original=fs.readFileSync(path.join(root,'tests/fixtures/daily-tracker-original.html'),'utf8');
 bundle=(await build({bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1testapp')},
 plugins:[{name:'synthetic-nstack',setup(b){
 b.onResolve({filter:/api\.js$/},args=>/(?:artefacts|board-sync|html-assets|artifact-picker|tracker-update|file-data)\.js$/.test(args.importer)?{path:'fake-api',namespace:'fake-api'}:null);
 b.onLoad({filter:/.*/,namespace:'fake-api'},()=>({resolveDir:root,contents:`export * from '${root}/src/api.js';${['getTowerPgFile','getTowerPgChannel','getTowerPgFileVersions','getTowerPgFileVersionObjectBytes','prepareTowerPgStorageObject','uploadStorageObject','completeStorageObject','createTowerPgFileVersion'].map(n=>`export const ${n}=(...a)=>window.fakeApi.${n}(...a);`).join('\n')}`}));
 }}],stdin:{resolveDir:root,contents:`
 import Alpine from 'alpinejs';import {artefactsMixin} from './src/artefacts.js';import {openWorkspaceDb} from './src/db.js';import {registerCanvasHtml} from './src/canvas/html-naplet.js';
 const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
 const model={format:'daily-tracker-v1',metrics:[{id:id(10),label:'Ate well',type:'boolean',unit:'',archived:false},{id:id(11),label:'Weight',type:'number',unit:'kg',archived:false},{id:id(12),label:'Earlier metric',type:'boolean',unit:'',archived:true}],days:{'2026-01-01':{[id(10)]:false,[id(11)]:0,[id(12)]:true}}};
 const fixture=window.fixture={head:id(4),writes:[],data:JSON.stringify(model),dataHistory:[id(5)],codeHistory:new Map([[id(4),${JSON.stringify(original)}]]),uploads:new Map()};
 const meta={html_artifact:true,napplet:{version:1,app_id:'daily-tracker',bindings:{tracker:{file_id:id(3)}}}};
 const bytes=f=>new TextEncoder().encode(f);const sha=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
 window.fakeApi={
 getTowerPgFile:async(_w,f)=>({file:{id:f,workspace_id:id(1),channel_id:id(6),current_version_id:f===id(2)?fixture.head:id(5),can_write:true,metadata:f===id(2)?meta:{},display_name:'My existing tracker.html'}}),
 getTowerPgChannel:async()=>({channel:{id:id(6),workspace_id:id(1),kind:'dm',participant_npubs:['alice']}}),
 getTowerPgFileVersions:async(_w,f)=>{const entries=f===id(2)?[...fixture.codeHistory]:[[id(5),fixture.data]];return {current_version_id:f===id(2)?fixture.head:id(5),versions:await Promise.all(entries.map(async([v,s])=>({id:v,file_id:f,version_number:1,content_type:f===id(2)?'text/html':'application/json',size_bytes:bytes(s).length,sha256_hex:await sha(bytes(s))}))) };},
 getTowerPgFileVersionObjectBytes:async(_w,f,v)=>({bytes:bytes(f===id(2)?fixture.codeHistory.get(v):fixture.data),contentType:f===id(2)?'text/html':'application/json'}),
 prepareTowerPgStorageObject:async()=>({object_id:'upload',is_public:false}),uploadStorageObject:async(_p,b)=>fixture.uploads.set('upload',b),completeStorageObject:async()=>{},
 createTowerPgFileVersion:async(_w,f,b)=>{fixture.writes.push({id:f,body:b});if(f!==id(2))throw Error('Data write forbidden in update test');if(b.base_version_id!==fixture.head)throw Object.assign(Error('stale'),{status:409});fixture.head=id(7);fixture.codeHistory.set(fixture.head,new TextDecoder().decode(fixture.uploads.get('upload')));return {version:{id:fixture.head}};}
 };
 await openWorkspaceDb('tracker-update-e2e').open();
 Alpine.store('chat',{...artefactsMixin,$nextTick:Alpine.nextTick,session:{npub:'alice'},currentViewerNpub:'alice',currentWorkspaceKey:'tracker-update-e2e',currentWorkspace:{workspaceId:id(1),directHttpsUrl:location.origin},isPersonalPinned:()=>false,togglePersonalPin:()=>{}});
 registerCanvasHtml(Alpine,{name:'artefact-html',assetStore:()=>Alpine.store('chat').artefactAssetStore(),dataHost:()=>Alpine.store('chat').artefactDataHost()});window.row={record_id:id(2),pg_record_type:'file',title:'My existing tracker.html'};window.Alpine=Alpine;Alpine.start();
 `}})).outputFiles[0].text;
});
test('phone existing-instance update preserves saved data/history and reconsents changed code once',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(!['localhost','127.0.0.1'].includes(u.hostname))return route.abort();
  if(u.pathname.startsWith('/assets/'))return serveBuiltFlightDeck(route);
  if(u.pathname==='/tracker-harness.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(u.pathname.startsWith('/napplets/')){const name=path.basename(u.pathname);return route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body:fs.readFileSync(path.join(root,'public/napplets/daily-tracker/v1',name))});}
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:503,json:{}});
  return route.fulfill({contentType:'text/html',body:hostHtml});
 });
 await page.goto('/tracker-test');await page.getByRole('button',{name:'Open tracker',exact:true}).click();
 await page.getByRole('button',{name:'Trust and open',exact:true}).click();
 const frame=page.frameLocator('#artefact-dialog iframe');
 await expect(frame.getByRole('heading',{name:'Daily tracker',exact:true})).toBeVisible();
 await frame.getByLabel('Day',{exact:true}).fill('2026-01-01');
 await expect(frame.getByRole('spinbutton')).toHaveValue('0');
 const before=await page.evaluate(()=>({data:fixture.data,history:fixture.dataHistory.slice()}));
 await page.screenshot({animations:'disabled',path:'tmp/docs/handoffs/tracker-ui-host-before-390.png'});
 await frame.getByRole('spinbutton').fill('77');
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Update app',exact:true}).tap();
 await expect(frame.getByRole('spinbutton')).toHaveValue('77');expect(await page.evaluate(()=>fixture.writes.length)).toBe(0);
 page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Update app',exact:true}).tap();
 await expect(page.getByRole('button',{name:'Trust and open',exact:true})).toBeVisible();
 await expect(page.locator('#artefact-dialog iframe')).toHaveCount(0);
 expect(await page.evaluate(()=>({data:fixture.data,history:fixture.dataHistory.slice()}))).toEqual(before);
 expect(await page.evaluate(()=>fixture.writes.map(w=>({id:w.id,base:w.body.base_version_id})))).toEqual([{id:'10000000-0000-4000-8000-000000000002',base:'10000000-0000-4000-8000-000000000004'}]);
 expect(await page.evaluate(()=>fixture.codeHistory.size)).toBe(2);
 await page.getByRole('button',{name:'Trust and open',exact:true}).click();
 await expect(frame.getByRole('heading',{name:'Daily Metrics',exact:true})).toBeVisible();
 await frame.getByLabel('Day',{exact:true}).fill('2026-01-01');await expect(frame.getByRole('spinbutton')).toHaveValue('0');
 await expect(frame.getByRole('group',{name:'Ate well',exact:true}).getByRole('button',{name:'No',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(frame.getByText('Earlier metric (archived)',{exact:true})).toBeVisible();
 await page.screenshot({animations:'disabled',path:'tmp/docs/handoffs/tracker-ui-host-after-390.png'});
 await page.getByRole('button',{name:'Close artefact',exact:true}).click();await page.getByRole('button',{name:'Open tracker',exact:true}).click();
 await expect(frame.getByRole('heading',{name:'Daily Metrics',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Trust and open',exact:true})).toBeHidden();await expect(page.getByRole('button',{name:'Update app',exact:true})).toBeHidden();
 expect(await page.evaluate(()=>({data:fixture.data,history:fixture.dataHistory.slice()}))).toEqual(before);
});
