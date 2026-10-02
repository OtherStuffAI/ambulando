const {test,expect}=require('playwright/test');
const {build}=require('esbuild');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const evidence=path.join(root,'tmp/docs/handoffs/pipeline-viewer/browser');
let bundle,css;
test.beforeAll(async()=>{
  css=await fs.readFile(path.join(root,'src/pipeline-viewer.css'),'utf8');
  const result=await build({bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1fixture'),__FLIGHTDECK_PIPELINE_VIEWER_ENABLED__:'true'},
    plugins:[{name:'raw-html',setup(api){api.onResolve({filter:/\.html\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.replace('?raw','')),namespace:'raw-html'}));api.onLoad({filter:/.*/,namespace:'raw-html'},async args=>({contents:await fs.readFile(args.path,'utf8'),loader:'text'}));}}],
    stdin:{resolveDir:root,contents:`
      import Alpine from 'alpinejs';import Dexie from 'dexie';
      import {openWorkspaceDb} from './src/db.js';import {createPipelineViewerView} from './src/pipeline-viewer-view.js';
      import {birdSnapshot,birdDefinition,runSummary,tweetRecords,longText} from './tests/fixtures/pipeline-viewer.js';
      const db=openWorkspaceDb('viewer-browser-'+crypto.randomUUID());await db.open();let failure=null,revision=1,delay=false,release=null;
      const copied=[],requests=[];
      const connection={id:'connection',installation_id:'installation',fips_endpoint:'http://peer.fips:43101',fips_transport_npub:'peer',capabilities:['pipelines.viewer.read.v1'],display_name:'Synthetic Autopilot',metadata:{installation_npub:'signer',health_path:'/api/owners/owner/control-plane/v1/health',pipeline_viewer_path:'/api/owners/owner/control-plane/v1/pipeline-viewer'}};
      Alpine.store('chat',{agentConnections:[connection],selectedAgentConnection:connection,currentWorkspace:{workspaceId:'workspace',towerServiceNpub:'tower'},pipelineViewerRoute:{},syncRoute(){}});
      const read=async(op,options,signal)=>{
        requests.push({op,options});if(failure)throw Object.assign(Error('PRIVATE FAILURE'),{status:failure});
        const base={version:1,serviceId:'installation'};
        if(op==='definitions')return {...base,definitions:[birdDefinition],nextCursor:null};
        if(op==='definition')return {...base,definition:birdDefinition};
        if(op==='runs')return {...base,runs:[runSummary],nextCursor:null};
        if(op==='evidence'){
          if(delay)await new Promise(resolve=>release=resolve);
          const snapshot=birdSnapshot(revision);const ref=snapshot.steps.flatMap(step=>step.evidence).find(ref=>ref.id===options.evidenceId);
          const value=ref.stepId==='retrieve-exec'?tweetRecords:ref.stepId==='format-exec'?{response:longText,privateSibling:'Do not copy sibling values'}:ref.stepId==='reply-exec'?{delivered:false,error:'Synthetic delivery failure'}:'Synthetic exact request';
          return {...base,evidence:ref,value:Array.isArray(value)?value.slice(options.offset,options.offset+100):value,nextOffset:Array.isArray(value)&&options.offset+100<value.length?options.offset+100:null};
        }
        const snapshot=birdSnapshot(revision);if(options.id==='child'){
          snapshot.run={...snapshot.run,id:'child',name:'Retrieval child',parentRunId:'run',parentStepId:'retrieve-exec'};
          snapshot.definition={...birdDefinition,id:'child-definition',title:'Retrieval child',steps:[{logicalKey:'loop',name:'Bounded loop',title:'Bounded retrieval',description:'Actual defined loop',type:'loop',inputs:[],outputs:[],children:[{logicalKey:'loop/read',name:'Read',title:'Read timeline',description:'Read-only retrieval',type:'code',inputs:[],outputs:[],children:[]}]}],wiring:[]};
          snapshot.steps=[{...snapshot.steps[1],id:'loop-exec',logicalKey:'loop',evidence:[],childRunId:null,exitReason:'Enough retained records after attempt 1'},{...snapshot.steps[1],id:'read-exec',logicalKey:'loop/read',parentStepId:'loop-exec',childRunId:null,evidence:[],exitReason:'Requested count reached'}];
        }
        return snapshot;
      };
      Alpine.data('pipelineViewerView',()=>createPipelineViewerView({store:Alpine.store('chat'),getDb:()=>db,isDbReady:()=>true,createConnection:()=>({health:async()=>({ok:true}),disconnect:async()=>{}}),createClient:()=>({read}),clipboard:{writeText:async value=>copied.push(value)}}));
      window.Alpine=Alpine;window.fixture={db,copied,requests,longText,tweetRecords,setFailure(value){failure=value},setRevision(value){revision=value},setDelay(value){delay=value},release(){release?.()},get view(){return Alpine.$data(document.querySelector('.pipeline-viewer'))},async cleanup(){this.view.destroy();await db.delete();}};
      Alpine.start();`}});bundle=result.outputFiles[0].text;
});
async function start(page,baseURL,viewport){
  await page.setViewportSize(viewport||{width:1440,height:900});
  const origin=new URL(baseURL).origin;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/__viewer.js')return route.fulfill({contentType:'text/javascript',body:bundle});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0f1724;font-family:system-ui}[x-cloak]{display:none!important}'+css+'</style><main class="pipeline-viewer" x-data="pipelineViewerView" x-html="template" x-effect="queueSync($store.chat.currentWorkspace.workspaceId,\'actor\',\'db\',\'http://127.0.0.1:3100\',$store.chat.agentConnections,true)"></main><script type="module" src="/__viewer.js"></script>'});
  });
  await page.goto(origin+'/__viewer');await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
  await page.getByRole('button',{name:'Open run: Bird request · run',exact:true}).click();await expect(page.getByTestId('pipeline-step-retrieve')).toBeVisible();
}
test.afterEach(async({page})=>{await page.evaluate(()=>window.fixture?.cleanup()).catch(()=>{});});
for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]])test(name+' actual nodes, full pages, exact safe copy, child context and keyboard',async({page,baseURL})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await start(page,baseURL,viewport);
  const tweets=page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true});await tweets.click();
  await expect(page.getByTestId('pipeline-value-completeness')).toHaveText('Partial page · more retained records available');
  await expect(page.getByTestId('pipeline-copy-value')).toBeDisabled();
  await page.getByTestId('pipeline-more-evidence').click();await page.getByTestId('pipeline-more-evidence').click();
  await expect(page.getByTestId('pipeline-value-completeness')).toHaveText('Complete retained value');
  await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(50);
  await page.getByTestId('pipeline-value-search').fill('tweet 237');await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(1);
  await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.fixture.copied[0])).toBe(await page.evaluate(()=>JSON.stringify(window.fixture.tweetRecords,null,2)));
  expect(await page.locator('script').count()).toBe(1);
  await page.keyboard.press('Escape');await expect(tweets).toBeFocused();
  await expect(page.locator('.pipeline-viewer-edges g')).toHaveCount(3);
  await page.getByRole('button',{name:'Inspect Format exact response outputs: Response text',exact:true}).click();
  await expect(page.getByTestId('pipeline-exact-value')).toHaveText(await page.evaluate(()=>window.fixture.longText));
  await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.fixture.copied.at(-1))).toBe(await page.evaluate(()=>window.fixture.longText));
  await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});
  const geometry=await page.evaluate(()=>{const a=document.querySelector('.pipeline-viewer-diagram').getBoundingClientRect(),b=document.querySelector('.pipeline-viewer-inspector').getBoundingClientRect();return {a:{x:a.x,y:a.y,w:a.width,h:a.height},b:{x:b.x,y:b.y},overflow:document.documentElement.scrollWidth>innerWidth};});expect(geometry.overflow).toBe(false);
  if(name==='mobile'){expect(geometry.b.y).toBeGreaterThanOrEqual(0);expect(geometry.b.y).toBeLessThan(viewport.height);expect(await page.getByTestId('pipeline-inspector').evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(viewport.height*.7);}else expect(geometry.b.x).toBeGreaterThan(geometry.a.x);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Open child workflow: Retrieve tweets attempt 1',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Retrieval child',exact:true})).toBeVisible();await expect(page.getByText('Exited: Enough retained records after attempt 1',{exact:true})).toBeVisible();
  await page.getByTestId('pipeline-parent').click();await expect(page.getByTestId('pipeline-step-retrieve')).toBeVisible();
  expect(errors).toEqual([]);
});
test('access loss, recovery and workspace change clear private values and late responses',async({page,baseURL})=>{
  await start(page,baseURL);await page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true}).click();
  await page.evaluate(()=>window.fixture.setFailure(503));await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toContainText('disconnected');
  await expect(page.getByTestId('pipeline-value-completeness')).toHaveCount(0);
  await page.evaluate(()=>{window.fixture.setFailure(null);window.fixture.setRevision(2)});await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
  expect(await page.locator('[data-testid^="pipeline-attempt-"]').count()).toBe(4);
  await page.evaluate(()=>window.fixture.setFailure(403));await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer access denied.');
  await expect(page.getByTestId('pipeline-step-retrieve')).not.toBeVisible();
  await page.evaluate(()=>{window.fixture.setFailure(null);window.fixture.view.suspend();window.fixture.view.selectedConnectionId='';window.Alpine.store('chat').currentWorkspace={workspaceId:'other',towerServiceNpub:'tower'};});
  await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');expect(await page.evaluate(()=>window.fixture.view.inspector)).toBeNull();
});
test('built shell mounts the viewer from Agents, keeps deep-link identity and disposes on navigation',async({page,baseURL})=>{
  const {serveBuiltFlightDeck}=require('./fixtures/serve-built-flightdeck.cjs');const origin=new URL(baseURL).origin;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>serveBuiltFlightDeck(route));
  await page.goto(origin+'/fixture/agents',{waitUntil:'domcontentloaded',timeout:15000});await page.waitForFunction(()=>window.Alpine?.store('chat'),null,{timeout:15000});
  await page.evaluate(()=>{const store=window.Alpine.store('chat');store.startWorkspaceLiveQueries=()=>{};store.syncRoute=()=>{};store.session={npub:'fixture-actor'};store.navSection='agents';store.agentConnections=[];store.workspaceAgents=[];store.wappDelegationDraft={};store.wappPublishingDraftInstallation={};});
  // Existing hidden WApp editors bind null drafts during initial shell boot.
  // Seed their unrelated fixture drafts, then check errors caused by the viewer.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(errors.every(message=>/^Cannot read properties of null/.test(message))).toBe(true);errors.length=0;
  await page.getByTestId('pipeline-viewer-open').click();await expect(page.getByTestId('pipeline-viewer')).toBeVisible();
  await expect(page.getByTestId('pipeline-status')).toContainText('Choose a verified Autopilot');
  expect(await page.evaluate(()=>window.Alpine.store('chat').buildRouteUrl())).toContain('viewer=1');
  await page.evaluate(()=>{const store=window.Alpine.store('chat');store.pipelineViewerRoute={service:'verified-installation',signer:'verified-signer',run:'historical'};});
  expect(await page.evaluate(()=>window.Alpine.store('chat').buildRouteUrl())).toContain('signer=verified-signer');
  expect(await page.evaluate(()=>window.Alpine.store('chat').buildRouteUrl())).toContain('run=historical');
  await page.getByTestId('pipeline-viewer-close').click();await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);
  await page.getByTestId('pipeline-viewer-open').click();await page.evaluate(()=>window.Alpine.store('chat').navigateTo('chat'));await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);
  expect(errors).toEqual([]);
});
