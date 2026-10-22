const {test,expect}=require('playwright/test');
const {build}=require('esbuild');
const {serveBuiltFlightDeck}=require('./fixtures/serve-built-flightdeck.cjs');
const {spawn,execFileSync}=require('node:child_process');
const path=require('node:path');
let towerUrl,server,container;
test.skip(!process.env.TOWER_TEST_CHECKOUT,'Set TOWER_TEST_CHECKOUT to run against a disposable local Tower/Postgres');
test.setTimeout(90000);
test.use({serviceWorkers:'block'});
test.beforeAll(async()=>{
 container='task-tree-roundtrip-'+process.pid;
 execFileSync('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=postgres','-p','127.0.0.1::5432','postgres:16-alpine']);
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1);
 for(let n=0;n<60;n++){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'});break;}catch{await new Promise(r=>setTimeout(r,250));}}
 server=spawn('bun',[path.resolve(__dirname,'fixtures/task-tree-tower.ts')],{env:{...process.env,RECORD_TEST_PORT:port,SUPERBASED_DIRECT_HTTPS_URL:'http://127.0.0.1',ADMIN_NPUB:'npub1canvasapp',FLIGHT_DECK_PG_APP_NPUB:'npub1canvasapp',DB_USER:'postgres',DB_PASSWORD:'postgres',STORAGE_S3_ENDPOINT_PUBLIC:'http://127.0.0.1:1',STORAGE_S3_ACCESS_KEY:'test',STORAGE_S3_SECRET_KEY:'test',GRAPH_DB_ADMIN_USER:'test',GRAPH_DB_ADMIN_PASSWORD:'test',GRAPH_DB_APP_USER:'test',GRAPH_DB_APP_PASSWORD:'test'},stdio:['ignore','pipe','pipe']});
 towerUrl=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(new Error('Disposable Tower startup timed out')),30000);server.stdout.on('data',data=>{output+=data;const ready=output.match(/READY (.*)/);if(ready){clearTimeout(timeout);resolve(JSON.parse(ready[1]).url.replace(/\/$/,''));}});server.stderr.on('data',d=>console.log('DISPOSABLE_TOWER',String(d)));server.once('exit',code=>{clearTimeout(timeout);reject(new Error('Disposable Tower exited '+code));});});
});
test.afterAll(async()=>{server?.kill('SIGTERM');if(container)execFileSync('docker',['stop',container],{stdio:'ignore'});});
let bundle;
test.beforeAll(async()=>{bundle=(await build({bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1canvasapp')},stdin:{resolveDir:require('node:path').resolve(__dirname,'../..'),contents:`export {getTowerPgChannelTasks,getTowerPgScopeTasks} from './src/api.js';export {saveSettings,createWorkspaceDb} from './src/db.js';export {signLoginEvent,pubkeyToNpub} from './src/auth/nostr.js';export {normalizeWorkspaceEntry} from './src/workspaces.js';`}})).outputFiles[0].text;});
test('real canonical API creates tasks and normal Tasks board displays them',async({page,context})=>{
 let failCreatedResponse=false,failRootView=false,failBinding=false;
 page.on('pageerror',e=>console.log('ROUNDTRIP_PAGE_ERROR',e.message));
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===towerUrl){
    if(failBinding && route.request().method()==='PATCH' && route.request().postDataJSON()?.tree_channel_id){failBinding=false;return route.fulfill({status:503,headers:{'access-control-allow-origin':'*'},body:'{}'});}
    if(failCreatedResponse && route.request().method()==='POST' && /\/channels\/[^/]+\/tasks$/.test(u.pathname)) {
      failCreatedResponse=false;const real=await route.fetch();expect(real.status()).toBe(201);
      return route.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{}'});
    }
    if(failRootView && route.request().method()==='PATCH' && /\/naplets\//.test(u.pathname) && route.request().postDataJSON()?.layout?.task_tree?.root_task_id) {
      failRootView=false;return route.fulfill({status:409,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({code:'stale_row_version'})});
    }
    return route.continue();
  }if(u.pathname==='/__seed.js')return route.fulfill({contentType:'text/javascript',body:bundle});if(u.pathname==='/__seed.html')return route.fulfill({contentType:'text/html',body:'<title>seed</title>'});return serveBuiltFlightDeck(route);});
 await page.goto('/__seed.html');
 const data=await page.evaluate(async(towerUrl)=>{const m=await import('/__seed.js');const event=await m.signLoginEvent('ephemeral');const npub=await m.pubkeyToNpub(event.pubkey);const d=await (await fetch(towerUrl+'/test/bootstrap',{method:'POST',body:JSON.stringify({npub})})).json();const identity={workspace_id:d.workspace.id,app_npub:'npub1canvasapp',tower_service_npub:'npub1canvastower',workspace_service_npub:d.workspace.workspace_service_npub,workspace_owner_npub:npub};const w=m.normalizeWorkspaceEntry({workspaceId:d.workspace.id,workspaceOwnerNpub:npub,pgSessionNpub:npub,directHttpsUrl:towerUrl,appNpub:identity.app_npub,towerServiceNpub:identity.tower_service_npub,workspaceServiceNpub:identity.workspace_service_npub,pgBackendMode:true,pgMe:{actor:{actor_id:d.actor.id,npub},identity},pgDescriptor:{identity}});await m.saveSettings({knownWorkspaces:[w],currentWorkspaceKey:w.workspaceKey});return {...d,key:w.workspaceKey};},towerUrl);
 await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(data.key)}&canvasid=${data.canvas.id}`,{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'Task Tree',exact:true}).click();await page.locator('.canvas-stage').click({position:{x:80,y:80}});let tree=page.locator('.canvas-task-tree').last();
 await tree.getByLabel('Task Tree scope',{exact:true}).selectOption(data.scopes[0].id);await tree.getByLabel('Task Tree channel',{exact:true}).selectOption(data.channels[0].id);
 await tree.getByRole('button',{name:'New Task',exact:true}).click();await tree.getByLabel('New task title',{exact:true}).fill('Canonical root');await tree.getByRole('button',{name:'Add task',exact:true}).click({clickCount:2});await expect(tree.locator('.tree-task')).toHaveCount(1);
 await tree.getByRole('button',{name:'Add child to Canonical root',exact:true}).click();await tree.getByLabel('New task title',{exact:true}).fill('Canonical child');await tree.getByRole('button',{name:'Add task',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(2);
 await tree.getByRole('button',{name:'Add next task after Canonical root',exact:true}).click();await tree.getByLabel('New task title',{exact:true}).fill('Canonical successor');await tree.getByRole('button',{name:'Add task',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(3);
 console.log('REAL_GRAPH',await page.evaluate(()=>{const s=Alpine.store('canvas');return s.naplets.map(n=>({source:n.source,content:n.content,root:n.layout.task_tree?.root_task_id}));}));
 await tree.getByRole('button',{name:'Cancel',exact:true}).click();
 const readLists=()=>page.evaluate(async({data,towerUrl})=>{
   const api=await import('/__seed.js'),channels=[];
   for(const channel of data.channels){let cursor=null,rows=[];do{const p=await api.getTowerPgChannelTasks(data.workspace.id,channel.id,{baseUrl:towerUrl,appNpub:'npub1canvasapp',limit:1,cursor});rows.push(...p.tasks);cursor=p.has_more?p.next_cursor:null;}while(cursor);channels.push(rows);}
   const scopeLists=[];for(const scope of data.scopes){const p=await api.getTowerPgScopeTasks(data.workspace.id,scope.id,{baseUrl:towerUrl,appNpub:'npub1canvasapp',limit:200});scopeLists.push(p.tasks);}
   for(let i=0;i<channels.length;i++)if(JSON.stringify(channels[i].map(t=>t.id).sort())!==JSON.stringify(scopeLists[i].map(t=>t.id).sort()))throw new Error('Scope and channel task lists differ');
   return channels;
 },{data,towerUrl});
 const original=await readLists();expect(original[0]).toHaveLength(3);expect(original[1]).toHaveLength(0);
 for(const row of original[0]){expect(row.scope_id).toBe(data.scopes[0].id);expect(row.channel_id).toBe(data.channels[0].id);}
 const root=original[0].find(t=>t.title==='Canonical root');
 expect(original[0].find(t=>t.title==='Canonical child').metadata.parent_task_id).toBe(root.id);
 expect(original[0].find(t=>t.title==='Canonical successor').metadata.predecessor_task_ids).toEqual([root.id]);
 // A partially chosen scope cannot write through the previous channel.
 await tree.getByLabel('Task Tree scope',{exact:true}).selectOption(data.scopes[1].id);
 await expect(tree.getByRole('button',{name:'New Task',exact:true})).toBeDisabled();
 await expect(tree.getByRole('button',{name:'Add child to Canonical root',exact:true})).toBeDisabled();
 failBinding=true;await tree.getByLabel('Task Tree channel',{exact:true}).selectOption(data.channels[1].id);
 await expect(tree.getByRole('button',{name:'New Task',exact:true})).toBeDisabled();await tree.getByRole('button',{name:'Retry saving destination',exact:true}).click();await expect(tree.getByRole('button',{name:'New Task',exact:true})).toBeEnabled();
 await tree.getByRole('button',{name:'New Task',exact:true}).click();
 await tree.getByLabel('New task title',{exact:true}).fill('Beta root');failCreatedResponse=true;
 await tree.getByRole('button',{name:'Add task',exact:true}).click();
 await expect(tree.getByLabel('New task title',{exact:true})).toHaveValue('Beta root');
 await expect(tree.locator('.tree-error')).toBeVisible();failRootView=true;
 await tree.getByRole('button',{name:'Add task',exact:true}).click();
 await expect(tree.locator('.tree-error')).toContainText('Task saved');
 await tree.getByRole('button',{name:'Add task',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(1);
 const all=await readLists();expect(all[0].map(t=>t.id).sort()).toEqual(original[0].map(t=>t.id).sort());expect(all[1]).toHaveLength(1);
 expect(all[1][0]).toMatchObject({title:'Beta root',scope_id:data.scopes[1].id,channel_id:data.channels[1].id});
 console.log('AUTHORITATIVE_TASKS',JSON.stringify(all.map(rows=>rows.map(t=>({id:t.id,title:t.title,scope:t.scope_id,channel:t.channel_id,parent:t.metadata.parent_task_id,predecessors:t.metadata.predecessor_task_ids})))));
 // Reload the persisted binding/root, then return to the original destination.
 await page.reload({waitUntil:'domcontentloaded'});tree=page.locator('.canvas-task-tree').last();
 await expect(tree.locator('.tree-task-open strong')).toHaveText('Beta root');
 await tree.getByLabel('Task Tree scope',{exact:true}).selectOption(data.scopes[0].id);await tree.getByLabel('Task Tree channel',{exact:true}).selectOption(data.channels[0].id);
 await tree.getByRole('button',{name:'Existing Task',exact:true}).click();await tree.getByRole('button',{name:'Canonical root',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(3);
 await page.evaluate(()=>localStorage.setItem('coworker:workspace:collapsed-sections',JSON.stringify({new:true,done:true})));
 const href=await tree.getByRole('link',{name:'Open Tasks board'}).getAttribute('href');expect(href).toContain('revealnew=1');await page.goto(href,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Boolean(window.Alpine?.store('chat')));await expect(page.locator('.kanban-card').filter({hasText:'Canonical root'})).toBeVisible();try{await expect(page.locator('.kanban-card').filter({hasText:'Canonical child'})).toBeVisible({timeout:20000});}catch(e){console.log('BOARD_FAILED',await page.evaluate(()=>{const s=Alpine.store('chat');return {route:location.href,collapsed:s.collapsedSections,board:s.selectedBoardId,nav:s.navSection,error:s.error,paused:s.routeSyncPaused,ready:s.ready,tasks:s.tasks.map(t=>({title:t.title,state:t.state}))};}));throw e;}await expect(page.locator('.kanban-card').filter({hasText:'Canonical successor'})).toBeVisible();
 await expect(page.locator('.kanban-card').filter({hasText:'Beta root'})).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('coworker:workspace:collapsed-sections'))).toBe(JSON.stringify({new:true,done:true}));
 await expect.poll(()=>page.evaluate(()=>Alpine.store('chat').selectedBoardId)).toBe('__pg_channel__:'+data.channels[0].id);
 console.log('REAL_BOARD',await page.evaluate(()=>{const s=Alpine.store('chat');return {nav:s.navSection,board:s.selectedBoardId,collapsed:s.collapsedSections,tasks:s.tasks.map(t=>({id:t.record_id,title:t.title,scope:t.scope_id,channel:t.pg_channel_id,parent:t.parent_task_id,predecessors:t.predecessor_task_ids}))};}));
});
