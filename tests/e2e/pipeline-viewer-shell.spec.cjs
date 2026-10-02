const {test,expect}=require('playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const {serveBuiltFlightDeck}=require('./fixtures/serve-built-flightdeck.cjs');
const evidence=path.resolve(__dirname,'../../tmp/docs/handoffs/pipeline-viewer/actual-port-browser');
test.use({hasTouch:true,serviceWorkers:'block'});
let data;
test.beforeAll(async()=>{
 const source=await fs.readFile(path.resolve(__dirname,'../fixtures/pipeline-viewer.js'),'utf8');
 const compiled=require('esbuild').transformSync(source,{format:'cjs'}).code;
 const module={exports:{}};new Function('module','exports',compiled)(module,module.exports);const fixture=module.exports;
 const definition=structuredClone(fixture.birdDefinition);
 definition.steps[1].outputs[0].path='tweets';definition.steps[2].inputs[0].path='tweets';definition.wiring[1].sourcePath='tweets';definition.wiring[1].targetPath='tweets';
 const snapshot=fixture.birdSnapshot();snapshot.definition=definition;
 const values={};
 for(const step of snapshot.steps){
  const node=definition.steps.find(n=>n.logicalKey===step.logicalKey);step.inputs=node.inputs;step.outputs=node.outputs;
  step.evidence.push({...step.evidence[0],id:step.id+'-resolved_input',kind:'resolved_input'});
  for(const ref of step.evidence){
   const value=ref.kind==='resolved_input'?{request:'Read my Following timeline',tweets:fixture.tweetRecords,response:'Exact response',thread:'source-thread'}:step.logicalKey==='thread'?{request:'Read my Following timeline'}:step.logicalKey==='retrieve'?{tweets:fixture.tweetRecords,privateSibling:'EXCLUDE_PRIVATE_SIBLING'}:step.logicalKey==='format'?{response:fixture.longText,privateSibling:'EXCLUDE_PRIVATE_SIBLING'}:{delivery:{delivered:true,url:'https://example.invalid/delivery/1'}};
   values[ref.id]=value;
   ref.preview={value:step.logicalKey==='retrieve'?{tweets:fixture.tweetRecords.slice(0,2)}:step.logicalKey==='format'?{response:'Exact retained request…'}:value,truncated:step.logicalKey==='retrieve'||step.logicalKey==='format',count:null,counts:step.logicalKey==='retrieve'?{'$.tweets':237}:{}};
   if(ref.kind==='resolved_input')ref.preview={value:{request:'Read my Following timeline',response:'Exact response',thread:'source-thread'},truncated:true,count:null,counts:{}};
  }
 }
 data={definition,snapshot,values,longText:fixture.longText,tweetRecords:fixture.tweetRecords};
});
async function setup(page,baseURL,viewport,fixtureData=data){
 await page.setViewportSize(viewport);const errors=[],consoleErrors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
 await page.addInitScript(({data})=>{
  let failure=null;const delayed=new Set(),delayedReads=new Set(),heldSignals=new Map(),releases=new Map(),requests=[];let viewerFailure=null;
  const pubkey='44'.repeat(32);
  const workspaces=[['workspace','viewer-shell','fixture'],['other','viewer-other','other']].map(([workspaceId,workspaceKey,slug])=>({workspaceId,workspaceKey,workspaceOwnerNpub:'owner',workspaceServiceNpub:'workspace-service',towerServiceNpub:'tower',appNpub:'app',sourceAppNpub:'app',directHttpsUrl:'http://127.0.0.1:3100',slug,name:slug,pgBackendMode:true}));
  // Alpine.store invokes init when registering the store. Seed valid identity and
  // isolate unrelated workspace startup before that invocation, not after render.
  let alpine;
  Object.defineProperty(window,'Alpine',{configurable:true,get:()=>alpine,set(value){
   alpine=value;const register=value.store;
   value.store=function(name,state){
    if(name==='chat'&&state){const init=state.init;state.init=async function(){
     for(const method of ['startSharedLiveQueries','stopWorkspaceLiveQueries','startWorkspaceLiveQueries','ensureWorkspaceSessionKey','loadLocalWorkspaceCoreData','persistWorkspaceSettings','refreshWorkspaceSettings','syncWorkspaceProfileDraft','refreshLegacyWorkspaceRecovery','stopDrive','validateSelectedBoardId','normalizeSettingsTab','registerCurrentWorkspaceApp','publishCurrentWorkspaceAppSchema','hydrateKnownWorkspaceProfiles','loadRemoteWorkspaces','bootstrapSelectedWorkspace','ensureBackgroundSync','maybeAutoLogin'])this[method]=async()=>{};
     this.session={npub:'npub1fixtureactor'};this.backendUrl='http://127.0.0.1:3100';this.knownWorkspaces=workspaces;this.selectedWorkspaceKey='viewer-shell';this.currentWorkspaceOwnerNpub='owner';
     await init.call(this);window.shellFixture.booted=true;
    };}
    return register.apply(this,arguments);
   };
  }});
  window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>({...event,pubkey,id:'55'.repeat(32),sig:'66'.repeat(64)})};
  window.fipsTransport={version:2,available:true,connect:async args=>({version:2,...args,disconnect:async()=>{},fetch:async(url,options)=>{
   const u=new URL(url),serviceId=u.hostname==='peer-two.fips'?'installation-two':data.runtime?data.snapshot.serviceId:'installation';
   requests.push({url,serviceId,workspace:u.searchParams.get('workspace_id')});
   const event=JSON.parse(atob(options.headers.Authorization.slice(6)));if(!event.tags.some(tag=>tag[0]==='u'&&tag[1]===url))throw Error('Unsigned exact URL');
   const id=decodeURIComponent(u.pathname.split('/runs/')[1]?.split('/')[0]||'');
   if(delayed.has(id)){delayed.delete(id);await new Promise(resolve=>releases.set(id,resolve));}
   if(failure)return new Response('{}',{status:failure});
   if(viewerFailure&&!u.pathname.endsWith('/health'))return new Response(JSON.stringify({version:1,serviceId,error:viewerFailure.error}),{status:viewerFailure.status});
   let payload;const base={version:1,serviceId};
   if(u.pathname.endsWith('/health'))payload={ok:true,installation_id:serviceId,installation_npub:u.hostname==='peer-two.fips'?'signer-two':'signer',api_version:1};
   else if(data.runtime){
    const current=data.snapshots[id]||data.snapshot;
    if(u.pathname.endsWith('/definitions'))payload={...base,definitions:[data.definition],nextCursor:null};
    else if(u.pathname.includes('/definitions/'))payload={...base,definition:data.definition};
    else if(u.pathname.endsWith('/runs'))payload={...base,runs:[data.snapshot.run],nextCursor:null};
    else if(u.pathname.includes('/evidence/')){const evidenceId=decodeURIComponent(u.pathname.split('/evidence/')[1]),ref=current.steps.flatMap(s=>s.evidence).find(r=>r.id===evidenceId);if(!Object.hasOwn(data.values,evidenceId))throw Error('Unexpected unavailable evidence read');payload={...base,evidence:ref,value:data.values[evidenceId],nextOffset:null};}
    else payload=current;
   }
   else if(u.pathname.endsWith('/definitions'))payload={...base,definitions:[data.definition],nextCursor:null};
   else if(u.pathname.includes('/definitions/'))payload={...base,definition:data.definition};
   else if(u.pathname.endsWith('/runs'))payload={...base,runs:[{...data.snapshot.run,serviceId},{...data.snapshot.run,id:'slow',name:'Slow run',serviceId},{...data.snapshot.run,id:'fast',name:'Fast run',serviceId}],nextCursor:null};
   else if(u.pathname.includes('/evidence/')){const evidenceId=decodeURIComponent(u.pathname.split('/evidence/')[1]),ref=data.snapshot.steps.flatMap(s=>s.evidence).find(r=>r.id===evidenceId);payload={...base,evidence:ref,value:data.values[evidenceId],nextOffset:null};}
   else {payload=structuredClone(data.snapshot);payload.serviceId=serviceId;payload.run.serviceId=serviceId;payload.run.id=id||'run';payload.run.name=serviceId+' '+(id||'run');for(const child of payload.children||[]){child.serviceId=serviceId;child.parentRunId=payload.run.id;}for(const step of payload.steps)for(const ref of step.evidence)ref.runId=payload.run.id;if(id==='absent')payload.definition=null;if(id==='child'){payload.run.parentRunId='run';payload.run.parentStepId='retrieve-exec';}}
   // Freeze a genuine200 before waiting. These reads deliberately ignore abort.
   const response=new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});
   const readKey=u.pathname.includes('/evidence/')?'evidence:'+decodeURIComponent(u.pathname.split('/evidence/')[1]):u.pathname.endsWith('/updates')?'updates:'+id:'snapshot:'+id;
   if(delayedReads.has(readKey)){delayedReads.delete(readKey);heldSignals.set(readKey,options.signal);await new Promise(resolve=>releases.set(readKey,resolve));}
   return response;
  }})};
  window.shellFixture={data,workspaces,requests,delayRead(key){delayedReads.add(key)},isAborted(key){return heldSignals.get(key)?.aborted===true},setViewerFailure(status,error){viewerFailure=status?{status,error}:null},setFailure(v){failure=v},delay(id){delayed.add(id)},hasPending(id){return releases.has(id)},release(id){const fn=releases.get(id);if(!fn)throw Error('Delay not outstanding');releases.delete(id);fn();}};
 },{data:fixtureData});
 await page.route('**/*',route=>serveBuiltFlightDeck(route));
 await page.goto(new URL(baseURL).origin+'/fixture/agents',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.shellFixture.booted && window.Alpine?.store('chat'));
 await page.evaluate(async()=>{
  const s=window.Alpine.store('chat');
  s.knownWorkspaces=window.shellFixture.workspaces;
  s.wappDelegationDraft={};s.wappPublishingDraftInstallation={};
  await s.selectWorkspace('viewer-shell',{skipPgVerification:true});
  const connection=(id,installation,signer,peer)=>({id,installation_id:installation,installation_identity_verified:true,display_name:installation,fips_endpoint:'http://'+peer+'.fips:43101',fips_transport_npub:peer,capabilities:['pipelines.viewer.read.v1'],metadata:{installation_npub:signer,health_path:'/api/owners/owner/control-plane/v1/health',pipeline_viewer_path:'/api/owners/owner/control-plane/v1/pipeline-viewer'}});
  s.agentConnections=[connection('one',window.shellFixture.data.runtime?window.shellFixture.data.snapshot.serviceId:'installation','signer','peer'),connection('two','installation-two','signer-two','peer-two')];s.workspaceAgents=[{id:'agent',agent_npub:'fixture-agent',connection_id:'one'}];s.selectedWorkspaceAgentId='agent';s.navSection='agents';
  localStorage.setItem('nostr_secure_auth_recovery_v1',JSON.stringify({method:'extension',pubkey:'44'.repeat(32),expiresAt:Date.now()+86400000}));
  // Use the real shell URL builder/navigation; seed only backend-independent state.
  s.openPipelineViewer({connection:s.agentConnections[0],runId:window.shellFixture.data.runtime?window.shellFixture.data.snapshot.run.id:'run'});
 });
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 // Hidden WApp editors have known null-draft startup errors before fixture seeding.
 expect(errors.every(message=>/^Cannot read properties of null/.test(message))).toBe(true);const initialPageErrors=[...errors];errors.length=0;
 const initialConsoleErrors=[...consoleErrors];consoleErrors.length=0;
 await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'known-startup-errors.json'),JSON.stringify({knownNullDraftErrors:initialPageErrors,consoleErrors:initialConsoleErrors},null,2));
 if(process.env.FLIGHTDECK_TEST_VIEWER_DISABLED==='1')await expect(page.getByTestId('pipeline-activation-pending')).toBeVisible();else await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 return {errors,consoleErrors,initialConsoleErrors};
}
test.describe('enabled viewer',()=>{
 test.skip(process.env.FLIGHTDECK_TEST_VIEWER_DISABLED==='1','This acceptance matrix requires the opted-in isolated build.');
for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]])test('production shell '+name+' previews, ports, exact inspection and touch/keyboard',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,viewport);
 await expect(page.getByTestId('pipeline-step-retrieve')).toBeVisible();
 expect(await page.locator('.pipeline-viewer').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(17, 24, 39)');
 const tweets=page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true});
 await expect(tweets).toContainText('237 records');await expect(page.getByRole('button',{name:'Inspect Validate chat invocation inputs: Request',exact:true})).toContainText('Following');
 await expect(page.getByRole('button',{name:'Inspect Format exact response outputs: Response text',exact:true})).toContainText('Exact retained request');
 await expect(page.getByRole('button',{name:'Inspect Deliver to source thread outputs: Delivery confirmation',exact:true})).toContainText('https://example.invalid/delivery/1');
 expect(await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length)).toBe(0);
 await expect(page.locator('.pipeline-viewer-edges g')).toHaveCount(3);
 await fs.mkdir(evidence,{recursive:true});await page.getByTestId('pipeline-step-retrieve').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,name+'-diagram.png'),fullPage:false});
 if(name==='mobile')await tweets.tap();else{await tweets.focus();await page.keyboard.press('Enter');}await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(50);
 await page.getByTestId('pipeline-value-search').fill('tweet 237');await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(1);
 await page.evaluate(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied.push(value)}})});
 await page.getByRole('button',{name:'Copy retained record 237',exact:true}).click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(JSON.stringify(data.tweetRecords[236],null,2));
 await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(JSON.stringify(data.tweetRecords,null,2));
 await page.keyboard.press('Escape');await expect(tweets).toBeFocused();
 const response=page.getByRole('button',{name:'Inspect Format exact response outputs: Response text',exact:true});await response.click();
 await expect(page.getByTestId('pipeline-exact-value')).toHaveText(data.longText);await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(data.longText);
 await page.screenshot({path:path.join(evidence,name+'-inspector.png'),fullPage:false});
 const bounds=await page.getByTestId('pipeline-inspector').boundingBox();expect(bounds.height).toBeLessThan(viewport.height*.95);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await page.getByRole('button',{name:'Close value inspector',exact:true}).click();
 await page.getByRole('button',{name:'Open child workflow: Retrieve tweets attempt 1',exact:true}).click();await expect(page).toHaveURL(/run=child/);
 await page.getByTestId('pipeline-parent').click();await expect(page).toHaveURL(/run=run/);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
test('production shell dropdown, colliding run IDs, history, authority and released stale read',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,{width:1440,height:900});
 await page.getByTestId('pipeline-service').selectOption('two');await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 await page.getByRole('button',{name:'Open run: Bird request · run',exact:true}).click();await expect(page).toHaveURL(/service=installation-two/);await expect(page).toHaveURL(/run=run/);
 await page.goBack();await expect(page.getByTestId('pipeline-service')).toHaveValue('two');await page.goBack();await expect(page.getByTestId('pipeline-service')).toHaveValue('one');
 await page.goForward();await expect(page.getByTestId('pipeline-service')).toHaveValue('two');
 await page.evaluate(()=>window.shellFixture.delay('slow'));
 await page.getByRole('button',{name:'Open run: Slow run · slow',exact:true}).click();await page.waitForFunction(()=>window.shellFixture.hasPending('slow'));
 await page.getByRole('button',{name:'Open run: Fast run · fast',exact:true}).click();await expect(page).toHaveURL(/run=fast/);
 await page.evaluate(()=>window.shellFixture.release('slow'));await page.waitForTimeout(100);await expect(page).toHaveURL(/run=fast/);
 await page.evaluate(()=>window.shellFixture.setFailure(403));await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toContainText('denied');await expect(page.getByTestId('pipeline-step-retrieve')).toHaveCount(0);
 await page.evaluate(()=>{window.shellFixture.setFailure(null);const s=window.Alpine.store('chat');s.agentConnections[1].capabilities=[]});await expect(page.getByTestId('pipeline-status')).toContainText('unavailable');
 await page.evaluate(()=>{window.Alpine.store('chat').agentConnections[1].capabilities=['pipelines.viewer.read.v1']});await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.selectedWorkspaceAgentId='';s.pipelineViewerRoute={service:'installation-two',signer:'signer-two',run:'absent'};s.syncRoute()});await expect(page.getByText('The immutable definition snapshot is unavailable for this historical run.')).toBeVisible();expect(await page.locator('[data-testid^="pipeline-step-"]').count()).toBe(4);
 await page.evaluate(async()=>{const s=window.Alpine.store('chat');await s.selectWorkspace('viewer-other',{skipPgVerification:true});s.navSection='agents'});await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 expect(await page.evaluate(()=>window.Alpine.$data(document.querySelector('.pipeline-viewer')).inspector)).toBeNull();
 await page.evaluate(()=>window.Alpine.store('chat').navigateTo('chat'));await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
test('production shell rejects released old reads across service, workspace, denial and disposal',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,{width:1440,height:900});
 const begin=async()=>{await page.evaluate(()=>window.shellFixture.delay('slow'));await page.getByRole('button',{name:'Open run: Slow run · slow',exact:true}).click();await page.waitForFunction(()=>window.shellFixture.hasPending('slow'));};
 const release=async()=>{await page.evaluate(()=>window.shellFixture.release('slow'));await page.waitForTimeout(100);};
 await begin();await page.getByTestId('pipeline-service').selectOption('two');await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');await release();await expect(page).toHaveURL(/service=installation-two/);expect(new URL(page.url()).searchParams.get('run')).not.toBe('slow');
 await begin();await page.evaluate(async()=>{const s=window.Alpine.store('chat');await s.selectWorkspace('viewer-other',{skipPgVerification:true});s.navSection='agents';s.pipelineViewerRoute={service:'installation-two',signer:'signer-two',run:'fast'};s.syncRoute()});await expect(page).toHaveURL(/run=fast/);await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');await release();await expect(page).toHaveURL(/run=fast/);
 await begin();await page.evaluate(()=>window.shellFixture.setFailure(403));await page.getByTestId('pipeline-definition').selectOption('bird.timeline.chat.v2');await expect(page.getByTestId('pipeline-status')).toContainText('denied');await release();expect(new URL(page.url()).searchParams.get('run')).not.toBe('slow');await expect(page.getByTestId('pipeline-step-retrieve')).toHaveCount(0);
 await page.evaluate(()=>{window.shellFixture.setFailure(null);const s=window.Alpine.store('chat');s.agentConnections[1].metadata={...s.agentConnections[1].metadata,connect_package_version:2}});await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 await begin();await page.getByTestId('pipeline-viewer-close').click();const url=page.url();await release();expect(page.url()).toBe(url);await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]])test('production shell actual API Bird definition '+name+' connects configured ports and previews before evidence reads',async({page,baseURL})=>{
 const snapshot=JSON.parse(await fs.readFile(path.resolve(__dirname,'../fixtures/pipeline-viewer-contract/completed-run.json'),'utf8'));
 const actual={snapshot,definition:snapshot.definition,values:{}};const observed=await setup(page,baseURL,viewport,actual);
 const count=snapshot.definition.wiring.filter(w=>!w.carriedForward).length;
 await expect(page.locator('.pipeline-viewer-edges g')).toHaveCount(count);
 await expect(page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true})).toContainText('35 records');
 await expect(page.getByRole('button',{name:'Inspect Format exact tweets outputs: Response',exact:true})).toContainText('Synthetic exact tweet 1');
 expect(await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length)).toBe(0);
 await page.getByTestId('pipeline-step-retrieve').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,name+'-actual-bird.png'),fullPage:false});
 const endpoints=await page.evaluate(()=>window.Alpine.$data(document.querySelector('.pipeline-viewer')).edges.map(edge=>({path:edge.path,label:edge.label})));
 expect(endpoints.every(edge=>edge.path.startsWith('M ')&&edge.label.includes('→'))).toBe(true);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});


test('production shell exact redaction refusal clears cached selectors, full values and derived inspector, rejecting old200 after409',async({page,baseURL})=>{
 const unsafe=structuredClone(data),selector='SYNTHETIC_OLD_SELECTOR',secret='SYNTHETIC_OLD_VALUE';
 unsafe.snapshot.run.status='running';unsafe.snapshot.run.completedAt=null;unsafe.snapshot.revision='a'.repeat(64);
 unsafe.definition.steps[1].outputs.push({label:'Old selector',path:'$.'+selector});
 unsafe.snapshot.steps[1].outputs=unsafe.definition.steps[1].outputs;
 unsafe.tweetRecords[0].text=secret;const ref=unsafe.snapshot.steps[1].evidence.find(r=>r.kind==='returned_output');
 unsafe.values[ref.id].tweets=unsafe.tweetRecords;unsafe.values[ref.id][selector]=secret;
 ref.preview={value:{tweets:[unsafe.tweetRecords[0]],[selector]:secret},truncated:true,count:null,counts:{'$.tweets':237}};
 const observed=await setup(page,baseURL,{width:1440,height:900},unsafe);
 await page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true}).click();await expect(page.getByTestId('pipeline-value-completeness')).toHaveText('Complete retained value');
 await page.getByTestId('pipeline-value-search').fill(secret);await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(1);
 expect(await page.evaluate(()=>window.Alpine.$data(document.querySelector('.pipeline-viewer')).matchingRecords[0].text)).toContain(secret);
 const dbRows=async()=>page.evaluate(async()=>{
  const rows={};for(const info of await indexedDB.databases()){
   if(!info.name)continue;const database=await new Promise((resolve,reject)=>{const request=indexedDB.open(info.name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
   const names=['pipeline_viewer_state','pipeline_viewer_definitions','pipeline_viewer_runs','pipeline_viewer_snapshots'];
   if(names.every(name=>database.objectStoreNames.contains(name)))for(const name of names)rows[name]=await new Promise((resolve,reject)=>{const request=database.transaction(name).objectStore(name).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
   database.close();
  }return rows;
 });
 expect(JSON.stringify(await dbRows())).toContain(selector);
 await page.evaluate(()=>{window.shellFixture.delayRead('updates:run');window.shellFixture.delayRead('evidence:format-exec-returned_output');});
 await page.waitForFunction(()=>window.shellFixture.hasPending('updates:run'));
 await page.evaluate(()=>{const v=window.Alpine.$data(document.querySelector('.pipeline-viewer')),n=v.nodes.find(n=>n.logicalKey==='format');void v.inspectPort(n,'outputs',v.ports(n,'outputs')[0],null,true);});
 await page.waitForFunction(()=>window.shellFixture.hasPending('evidence:format-exec-returned_output'));
 const code='pipeline-viewer-evidence-redaction-review-required';
 await page.evaluate(async(code)=>{window.shellFixture.setViewerFailure(409,code);await window.Alpine.$data(document.querySelector('.pipeline-viewer')).moreRuns();},code);
 await expect(page.getByTestId('pipeline-status')).toHaveText('Evidence withheld pending credential redaction review');
 await expect(page.locator('[data-testid^="pipeline-step-"]')).toHaveCount(0);await expect(page.getByTestId('pipeline-inspector')).not.toBeVisible();
 const assertCleared=async()=>{
  const rows=await dbRows();for(const name of ['pipeline_viewer_definitions','pipeline_viewer_runs','pipeline_viewer_snapshots'])expect(rows[name]).toEqual([]);
  expect(rows.pipeline_viewer_state.some(row=>row.reason===code&&row.status==='unavailable'&&!row.selectedRunId&&!row.selectedDefinitionId)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(selector);expect(JSON.stringify(rows)).not.toContain(secret);
  expect(await page.evaluate(()=>{const v=window.Alpine.$data(document.querySelector('.pipeline-viewer'));return {snapshot:v.snapshot,definitions:v.definitions,runs:v.runs,inspector:v.inspector,preview:v.preview,path:v.inspectPath,evidence:v.inspectEvidenceId,execution:v.inspectExecutionId,label:v.inspectLabel,side:v.inspectSide,trail:v.parentTrail,records:v.matchingRecords};})).toEqual({snapshot:null,definitions:[],runs:[],inspector:null,preview:'',path:'',evidence:'',execution:'',label:'',side:'',trail:[],records:[]});
  expect(await page.locator('.pipeline-viewer').textContent()).not.toContain(secret);expect(await page.locator('.pipeline-viewer').textContent()).not.toContain(selector);
 };
 await assertCleared();expect(await page.evaluate(()=>['updates:run','evidence:format-exec-returned_output'].every(key=>window.shellFixture.isAborted(key)))).toBe(true);
 const url=page.url();await page.evaluate(()=>{window.shellFixture.release('updates:run');window.shellFixture.release('evidence:format-exec-returned_output')});await page.waitForTimeout(150);
 await assertCleared();expect(page.url()).toBe(url);
 // Same-context remount uses the same evidence IDs and successful health, still409.
 await page.getByTestId('pipeline-viewer-close').click();await page.evaluate(()=>window.Alpine.store('chat').openPipelineViewer({runId:'run'}));
 await expect(page.getByTestId('pipeline-status')).toHaveText('Evidence withheld pending credential redaction review');await assertCleared();
 // New authoritative safe snapshot is the sole recovery source, not cached values.
 await page.evaluate(()=>{const d=window.shellFixture.data;d.snapshot.run.status='completed';d.snapshot.run.completedAt='2026-10-02T00:00:01Z';d.snapshot.revision='b'.repeat(64);d.definition.steps[1].outputs=d.definition.steps[1].outputs.filter(p=>p.label!=='Old selector');d.snapshot.steps[1].outputs=d.definition.steps[1].outputs;d.snapshot.definition=d.definition;const ref=d.snapshot.steps[1].evidence.find(r=>r.kind==='returned_output');ref.preview={value:{tweets:[{id:'1',text:'SAFE_NEW_VALUE'}]},truncated:true,count:null,counts:{'$.tweets':237}};d.values[ref.id]={tweets:[{id:'1',text:'SAFE_NEW_VALUE'}]};window.shellFixture.setViewerFailure(null);});
 await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 await page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true}).click();await expect(page.locator('.pipeline-viewer-records li')).toContainText('SAFE_NEW_VALUE');
 expect(await page.locator('.pipeline-viewer').textContent()).not.toContain(secret);expect(await page.locator('.pipeline-viewer').textContent()).not.toContain(selector);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});

test('production shell refuses late snapshot navigation after exact redaction409',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,{width:1440,height:900});
 await page.evaluate(()=>window.shellFixture.delayRead('snapshot:slow'));
 await page.getByRole('button',{name:'Open run: Slow run · slow',exact:true}).click();await page.waitForFunction(()=>window.shellFixture.hasPending('snapshot:slow'));
 const url=page.url();await page.evaluate(async()=>{window.shellFixture.setViewerFailure(409,'pipeline-viewer-evidence-redaction-review-required');await window.Alpine.$data(document.querySelector('.pipeline-viewer')).moreRuns();});
 await expect(page.getByTestId('pipeline-status')).toHaveText('Evidence withheld pending credential redaction review');
 expect(await page.evaluate(()=>window.shellFixture.isAborted('snapshot:slow'))).toBe(true);
 await page.evaluate(()=>window.shellFixture.release('snapshot:slow'));await page.waitForTimeout(150);
 expect(page.url()).toBe(url);expect(new URL(page.url()).searchParams.get('run')).not.toBe('slow');
 expect(await page.evaluate(()=>{const v=window.Alpine.$data(document.querySelector('.pipeline-viewer'));return {selected:v.selectedRunId,snapshot:v.snapshot,path:v.inspectPath,trail:v.parentTrail};})).toEqual({selected:'',snapshot:null,path:'',trail:[]});
 await expect(page.locator('[data-testid^="pipeline-step-"]')).toHaveCount(0);
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});

test('production shell unrelated409 retains stale summaries and recovers normally',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,{width:1440,height:900});
 await page.evaluate(()=>window.shellFixture.setViewerFailure(409,'other-conflict'));await page.getByTestId('pipeline-retry').click();
 await expect(page.getByTestId('pipeline-status')).toHaveText('Autopilot disconnected. Retained summaries may be stale.');await expect(page.getByTestId('pipeline-step-retrieve')).toBeVisible();
 await page.evaluate(()=>window.shellFixture.setViewerFailure(null));await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});

test('production shell clears cached summaries when same-context remount health is denied',async({page,baseURL})=>{
 const observed=await setup(page,baseURL,{width:1440,height:900});await expect(page.getByTestId('pipeline-step-retrieve')).toBeVisible();
 await page.getByTestId('pipeline-viewer-close').click();await page.evaluate(()=>{window.shellFixture.setFailure(403);window.Alpine.store('chat').openPipelineViewer({runId:'run'})});
 await expect(page.getByTestId('pipeline-status')).toContainText('denied');await expect(page.locator('[data-testid^="pipeline-step-"]')).toHaveCount(0);
 await page.evaluate(()=>window.shellFixture.setFailure(null));await page.getByTestId('pipeline-retry').click();await expect(page.getByTestId('pipeline-status')).toHaveText('Pipeline viewer ready.');
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]])test('production shell '+name+' bounds 5000 records with searchable last record and exact copy',async({page,baseURL})=>{
 const many=structuredClone(data);many.tweetRecords=Array.from({length:5000},(_,index)=>({id:String(index+1),text:`Exact record ${index+1}`}));
 const step=many.snapshot.steps.find(s=>s.logicalKey==='retrieve');for(const ref of step.evidence)if(ref.kind==='returned_output'){many.values[ref.id]={tweets:many.tweetRecords,privateSibling:'EXCLUDE_PRIVATE_SIBLING'};ref.preview={value:{tweets:many.tweetRecords.slice(0,2)},truncated:true,count:null,counts:{'$.tweets':5000}};}
 const observed=await setup(page,baseURL,viewport,many);const tweets=page.getByRole('button',{name:'Inspect Retrieve tweets outputs: Tweets',exact:true});await expect(tweets).toContainText('5000 records');await tweets.click();
 await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(50);expect(await page.locator('.pipeline-viewer-records').evaluate(el=>el.querySelectorAll('*').length)).toBeLessThan(160);
 await expect(page.getByTestId('pipeline-record-count')).toHaveText('1–50 of 5000 loaded records · Page 1 of 100');
 const next=page.getByRole('button',{name:'Next record page',exact:true});if(name==='mobile')await next.tap();else{await next.focus();await page.keyboard.press('Enter');}
 await expect(page.getByTestId('pipeline-record-count')).toContainText('51–100');
 const number=page.getByRole('spinbutton',{name:'Record page number',exact:true});await number.fill('100');await number.press('Enter');await expect(page.getByRole('button',{name:'Copy retained record 5000',exact:true})).toBeAttached();await expect(next).toBeDisabled();
 await page.getByTestId('pipeline-value-search').fill('Exact record 5000');await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(1);await expect(page.getByTestId('pipeline-record-count')).toHaveText('1–1 of 1 matching records · Page 1 of 1');
 await page.evaluate(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied.push(value)}})});
 await page.getByRole('button',{name:'Copy retained record 5000',exact:true}).click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(JSON.stringify(many.tweetRecords[4999],null,2));
 await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(JSON.stringify(many.tweetRecords,null,2));
 await page.getByTestId('pipeline-value-search').fill('');await expect(page.locator('.pipeline-viewer-records li')).toHaveCount(50);await expect(page.getByTestId('pipeline-record-count')).toContainText('Page 1 of 100');
 await page.screenshot({path:path.join(evidence,name+'-5000-records.png'),fullPage:false});await page.keyboard.press('Escape');await expect(tweets).toBeFocused();expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
for(const outcome of ['complete','partial','clarification','blocked','noresults'])for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]])test('production shell actual runner '+outcome+' '+name+' parent/child previews and exact retained ports',async({page,baseURL})=>{
 const read=async file=>JSON.parse(await fs.readFile(path.resolve(__dirname,'../fixtures/pipeline-viewer-contract/runtime/'+file+'.json'),'utf8'));
 const [parent,child,parentValues,childValues]=await Promise.all([read('bird-wrapper-'+outcome),read('bird-child-'+outcome),read('evidence/bird-wrapper-'+outcome),read('evidence/bird-child-'+outcome)]);
 expect(parent.run.id).toBe(parentValues.runId);expect(child.run.id).toBe(childValues.runId);
 const actual={runtime:true,snapshot:parent,definition:parent.definition,snapshots:{[parent.run.id]:parent,[child.run.id]:child},values:{...parentValues.values,...childValues.values}};
 const observed=await setup(page,baseURL,viewport,actual);
 const portButton=(key,side,field)=>page.locator(`[data-port-node="${key}"][data-port-side="${side}"][data-port-path="${field}"]`);
 const select=(value,field)=>field.replace(/^\$\.?/,'').split('.').filter(Boolean).reduce((row,key)=>row?.[key],value);
 const latest=(snapshot,key,side)=>snapshot.steps.find(s=>s.logicalKey===key).evidence.filter(r=>r.kind===(side==='inputs'?'resolved_input':'returned_output')).at(-1);
 const tweetRef=latest(parent,'retrieve','outputs'),tweets=select(actual.values[tweetRef.id],'$.retrieval.tweets');
 const parentTweets=portButton('retrieve','outputs','$.retrieval.tweets');await expect(parentTweets).toContainText(tweets.length+' records');
 await expect(portButton('reply','outputs','$.delivery.delivered')).toContainText('true');await expect(portButton('format','outputs','$.message')).not.toContainText('Field outside bounded preview');
 await expect(page.locator('.pipeline-viewer-edges g')).toHaveCount(parent.definition.wiring.filter(w=>!w.carriedForward).length);
 await parentTweets.focus();expect(await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length)).toBe(0);
 await page.evaluate(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied.push(value)}})});
 const inspectCopy=async(snapshot,key,side,field)=>{
  const ref=latest(snapshot,key,side),value=select(actual.values[ref.id],field),expected=typeof value==='string'?value:JSON.stringify(value,null,2),button=portButton(key,side,field);
  if(name==='mobile')await button.tap();else{await button.focus();await page.keyboard.press('Enter');}
  await expect(page.getByTestId('pipeline-value-completeness')).toHaveText('Complete retained value');
  await page.getByTestId('pipeline-copy-value').click();expect(await page.evaluate(()=>window.copied.at(-1))).toBe(expected);
  await page.keyboard.press('Escape');await expect(button).toBeFocused();return value;
 };
 await inspectCopy(parent,'thread','inputs','$.prompt');await inspectCopy(parent,'retrieve','outputs','$.retrieval.tweets');await inspectCopy(parent,'format','inputs','$.state.tweets');await inspectCopy(parent,'format','outputs','$.message');await inspectCopy(parent,'reply','outputs','$.delivery.delivered');await inspectCopy(parent,'reply/reply / return-to-thread','outputs','$.delivered');
 await page.getByTestId('pipeline-step-retrieve').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,name+'-runner-'+outcome+'.png'),fullPage:false});
 const beforeChild=await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length);
 await page.getByRole('button',{name:'Open child workflow: Retrieve tweets attempt 1',exact:true}).click();await expect(page).toHaveURL(new RegExp('run='+child.run.id));await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-status',child.run.status);
 expect(await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length)).toBe(beforeChild);
 const childResults=child.steps.find(s=>s.logicalKey==='bounded-retrieval');
 if(childResults.status!=='skipped'){
  const ref=latest(child,'bounded-retrieval','outputs'),results=select(actual.values[ref.id],'$.current.retrieval.tweets');await expect(portButton('bounded-retrieval','outputs','$.current.retrieval.tweets')).toContainText(results.length+' records');await inspectCopy(child,'bounded-retrieval','outputs','$.current.retrieval.tweets');await inspectCopy(child,'bounded-retrieval','outputs','$.current.retrieval.verdict');
 }else{
  const results=portButton('bounded-retrieval','outputs','$.current.retrieval.tweets');await expect(results).toContainText('Not captured');await results.click();await expect(page.getByTestId('pipeline-copy-value')).toHaveCount(1);await expect(page.getByTestId('pipeline-copy-value')).toBeDisabled();await expect(page.getByTestId('pipeline-value-completeness')).toContainText('unavailable');await page.keyboard.press('Escape');
 }
 const unavailable=child.steps.find(s=>s.status==='skipped'&&s.outputs.length);if(unavailable){const ref=unavailable.evidence.find(r=>r.kind==='returned_output');const before=await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length);const article=page.getByTestId('pipeline-attempt-'+unavailable.id);await article.locator('summary').click();
  const input=unavailable.inputs[0];if(input){await article.getByRole('button',{name:'Inspect '+input.label+' inputs for execution '+unavailable.id,exact:true}).click();await expect(page.getByTestId('pipeline-field-missing')).toBeVisible();await expect(page.getByTestId('pipeline-copy-value')).toBeDisabled();await expect(page.getByTestId('pipeline-value-completeness')).toHaveText('Complete retained value');await page.keyboard.press('Escape');}
  const afterInput=await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length);await article.getByRole('button',{name:'Inspect '+unavailable.outputs[0].label+' outputs for execution '+unavailable.id,exact:true}).click();await expect(page.getByTestId('pipeline-copy-value')).toBeDisabled();expect(await page.evaluate(()=>window.shellFixture.requests.filter(r=>r.url.includes('/evidence/')).length)).toBe(afterInput);expect(ref.availability).toBe('not_captured');await page.keyboard.press('Escape');}
 await page.getByTestId('pipeline-parent').click();await expect(page).toHaveURL(new RegExp('run='+parent.run.id));expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});

});
test('default-OFF build blocks navigation and deep-linked viewer reads',async({page,baseURL})=>{
 test.skip(process.env.FLIGHTDECK_TEST_VIEWER_DISABLED!=='1','Requires the default build without opt-in.');
 const observed=await setup(page,baseURL,{width:1440,height:900});
 await expect(page.getByTestId('pipeline-viewer-open')).toBeHidden();await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.navigateTo('agents');history.pushState(null,'','/fixture/agents?viewer=1&service=installation&signer=signer&run=run');dispatchEvent(new PopStateEvent('popstate'));});
 await expect(page.getByTestId('pipeline-activation-pending')).toBeVisible();await expect(page.getByTestId('pipeline-viewer')).toHaveCount(0);await page.waitForTimeout(100);
 expect(await page.evaluate(()=>window.shellFixture.requests)).toEqual([]);expect(await page.evaluate(()=>window.Alpine.store('chat').pipelineViewerRoute)).toEqual({});
 expect(observed.errors).toEqual([]);expect(observed.consoleErrors).toEqual([]);
});
