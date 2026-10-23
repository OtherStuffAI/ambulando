const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.setTimeout(60000);
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: true });
const workspaceId = '20000000-0000-4000-8000-000000000002';
const ids = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003'];
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js'; export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js'; export { normalizeWorkspaceEntry } from './src/workspaces.js';` }
  })).outputFiles[0].text;
});
async function seedSessionAndWorkspace(page) {
  await page.goto('/__canvas-seed.html');
  return page.evaluate(async ({ workspaceId, identity }) => {
    const module = await import('/__canvas-seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({
      workspaceId,
      workspaceOwnerNpub: npub,
      pgSessionNpub: npub,
      directHttpsUrl: 'http://127.0.0.1:3100',
      appNpub: identity.app_npub,
      towerServiceNpub: identity.tower_service_npub,
      workspaceServiceNpub: identity.workspace_service_npub,
      pgBackendMode: true,
      pgMe: { actor: { actor_id: 'actor-reader', npub }, identity },
      pgDescriptor: { identity },
    });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = module.createWorkspaceDb(workspace.workspaceKey);
    await db.open();
    await Promise.all([
      db.documents.put({ record_id: 'doc-2', title: 'New reference', record_state: 'active' }),
      db.channels.put({ record_id: 'scope-2', name: 'Delivery', record_state: 'active' }),
      db.chat_messages.put({ record_id: 'thread-2', title: 'Launch discussion', pg_record_type: 'thread', record_state: 'active' }),
      db.documents.put({ record_id: 'file-2', title: 'Interactive report', pg_record_type: 'file', pg_storage_version_id: 'package-2', content_type: 'text/html', record_state: 'active' }),
    ]);
    db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity });
}



const scopeId='40000000-0000-4000-8000-000000000001';
const channels=['50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002'];
const taskId=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(page,context,{large=0}={}) {
  page.on('pageerror',error=>console.log('TASK_TREE_PAGE_ERROR',error.message));
  page.on('console',msg=>{if(msg.type()==='error')console.log('BROWSER_ERROR',msg.text());});
  const naplets=[],tasks=[],writes=[],replays=new Map();let sequence=0,revoked=false,failNext=false;
  const definition={id:ids[0],title:'Task Tree acceptance',row_version:1,position:1,can_manage:true,viewport:{x:0,y:0,scale:1},visibility:{mode:'workspace'}};
  function task(title,metadata={},channel=channels[0]){const row={id:taskId(++sequence),workspace_id:workspaceId,scope_id:scopeId,channel_id:channel,title,state:'new',metadata,row_version:1,created_at:new Date(sequence*1000).toISOString(),updated_at:new Date(sequence*1000).toISOString()};tasks.push(row);return row;}
  const root=task('Existing root');
  if(large)for(let n=0;n<large;n++)task(`Large child ${n}`,{parent_task_id:root.id});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    if(url.pathname==='/__canvas-seed.js')return route.fulfill({contentType:'text/javascript',body:seedBundle});
    if(url.pathname==='/__canvas-seed.html')return route.fulfill({contentType:'text/html',body:'<title>Seed</title>'});
    const prefix=`/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
    if(!url.pathname.startsWith(prefix)) {
      if(process.env.SOL_RUNTIME_ASSETS==='1' && url.origin===new URL(process.env.PLAYWRIGHT_BASE_URL).origin)return route.continue();
      return serveBuiltFlightDeck(route);
    }
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PATCH,DELETE','access-control-allow-headers':'*'}});
    if(!request.headers().authorization){console.log('UNSIGNED_FIXTURE_REQUEST',url.pathname);return route.fulfill({status:503,body:'{}'});}
    expect(request.headers().authorization).toMatch(/^Nostr /);
    const path=url.pathname.slice(prefix.length),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({identity,...body})});
    if(path==='/scopes')return json({scopes:[{id:scopeId,name:'Delivery'}]});
    if(path===`/scopes/${scopeId}/channels`)return json({channels:channels.map((id,i)=>({id,scope_id:scopeId,name:`Channel ${i+1}`}))});
    if(path==='/canvases')return json({workspace_id:workspaceId,complete:true,canvases:[definition]});
    if(path===`/canvases/${ids[0]}`&&method==='PATCH') {
      const body=request.postDataJSON();
      if(body.expected_row_version!==definition.row_version)return json({code:'stale_row_version'},409);
      if(body.viewport)definition.viewport=body.viewport;
      definition.row_version++;return json({canvas:definition});
    }
    if(path===`/canvases/${ids[0]}/snapshot`)return json({workspace_id:workspaceId,complete:true,canvas:definition,naplets:naplets.map(row=>revoked?{id:row.id,access:'denied',layout:row.layout,row_version:row.row_version}:row),elements:[],comments:[]});
    if(path===`/canvases/${ids[0]}/naplets`&&method==='POST'){
      const body=request.postDataJSON();writes.push(body);const row={id:`70000000-0000-4000-8000-${String(naplets.length+1).padStart(12,'0')}`,access:'ready',source:body.source,title:'Task Tree',layout:body.layout,row_version:1,content:{scope_id:scopeId,channel_id:body.source.id,channel_title:`Channel ${channels.indexOf(body.source.id)+1}`,can_create:true}};naplets.push(row);return json({naplet:row},201);
    }
    if(path.startsWith(`/canvases/${ids[0]}/naplets/`)&&method==='PATCH'){
      const row=naplets.find(row=>row.id===path.split('/').at(-1)),body=request.postDataJSON();
      if(row.row_version!==body.expected_row_version)return json({code:'stale_row_version'},409);
      if(body.layout)row.layout=body.layout;
      if(body.tree_channel_id){row.source.id=body.tree_channel_id;row.content.channel_id=body.tree_channel_id;row.content.channel_title=`Channel ${channels.indexOf(body.tree_channel_id)+1}`;}
      row.row_version++;return json({naplet:row});
    }
    const directTask=path.match(/^\/tasks\/([^/]+)$/);
    if(directTask){const row=tasks.find(row=>row.id===directTask[1]);if(!row)return json({code:'task_unavailable'},404);if(method==='PATCH'){const body=request.postDataJSON();Object.assign(row,{...body,metadata:{...row.metadata,...body.metadata},row_version:row.row_version+1});}return json({task:row});}
    const directChannel=path.match(/^\/channels\/([^/]+)$/);
    if(directChannel)return json({channel:{id:directChannel[1],workspace_id:workspaceId,scope_id:scopeId,name:'Channel 1',record_state:'active',row_version:1}});
    if(path==='/members')return json({members:[]});
    if(path==='/groups')return json({groups:[]});
    if(path.match(/^\/tasks\/[^/]+\/comments$/))return json({comments:[],has_more:false,next_cursor:null});
    if(path==='/edit-leases')return json({lease:null});
    const taskCreate=path.match(/^\/channels\/([^/]+)\/tasks$/);
    if(taskCreate){
      if(method==='POST'){
        const body=request.postDataJSON();writes.push(body);
        if(failNext){failNext=false;return route.fulfill({status:503,body:'{}'});}
        let row=replays.get(body.client_request_id);if(!row){row=task(body.title,body.metadata,taskCreate[1]);replays.set(body.client_request_id,row);}
        return json({task:row},201);
      }
      const matches=tasks.filter(row=>row.channel_id===taskCreate[1]),offset=Number(url.searchParams.get('cursor')||0),limit=100,more=matches.length>offset+limit;return json({tasks:matches.slice(offset,offset+limit),has_more:more,next_cursor:more?String(offset+limit):null});
    }
    const related=path.match(/^\/tasks\/([^/]+)\/relationships$/);
    if(related){
      if(revoked)return json({code:'task_unavailable'},404);
      const source=tasks.find(row=>row.id===related[1]);if(!source)return json({code:'task_unavailable'},404);
      const matches=tasks.filter(row=>row.metadata?.parent_task_id===source.id||row.metadata?.predecessor_task_ids?.includes(source.id));
      const offset=Number(url.searchParams.get('cursor')||0),limit=Number(url.searchParams.get('limit')||100),more=matches.length>offset+limit;
      return json({task:source,tasks:matches.slice(offset,offset+limit),unavailable:false,has_more:more,next_cursor:more?String(offset+limit):null});
    }
    return json({code:'fixture_unhandled',path},503);
  });
  const workspaceKey=await seedSessionAndWorkspace(page);
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${ids[0]}`);
  await expect(page.locator('.canvas-stage')).toBeVisible();
  return {naplets,tasks,writes,root,task,workspaceKey,revoke:()=>{revoked=true;},fail:()=>{failNext=true;}};
}
async function addTree(page,channel=channels[0]){
  await page.getByRole('button',{name:'Task Tree',exact:true}).click();await page.locator('.canvas-stage').click({position:{x:80,y:100}});
  const tree=page.locator('.canvas-task-tree').last();await tree.getByLabel('Task Tree scope',{exact:true}).selectOption(scopeId);await tree.getByLabel('Task Tree channel',{exact:true}).selectOption(channel);await expect(tree.getByRole('button',{name:'New Task',exact:true})).toBeEnabled();return tree;
}
async function enter(tree,title){const input=tree.locator('input[aria-label="New task title"]');await input.fill(title);await input.press('Enter');await expect(input).toHaveValue('');if(await input.isVisible())await expect(input).toBeFocused();}

test('Task Tree creates shared hierarchy, repeated siblings, parallel successors and chains with reload and other-view updates',async({page,context})=>{
  const f=await fixture(page,context);const tree=await addTree(page);
  await tree.getByRole('button',{name:'New Task',exact:true}).click();await enter(tree,'New base');await expect(tree.locator('.tree-task')).toHaveCount(1);
  const base=f.tasks.find(row=>row.title==='New base');
  await tree.getByRole('button',{name:'Add child to New base',exact:true}).click();for(const title of ['One','Two','Three'])await enter(tree,title);
  await expect(tree.locator('.tree-task')).toHaveCount(4);
  expect(f.tasks.filter(row=>row.metadata.parent_task_id===base.id)).toHaveLength(3);
  await tree.getByRole('button',{name:'Add next task after One',exact:true}).click();await enter(tree,'Next A');await enter(tree,'Next B');
  const one=f.tasks.find(row=>row.title==='One');expect(f.tasks.find(row=>row.title==='Next A').metadata).toEqual({parent_task_id:base.id,predecessor_task_ids:[one.id]});
  const nextA=f.tasks.find(row=>row.title==='Next A');expect(await tree.locator(`[data-tree-task="${nextA.id}"]`).evaluate(node=>node.offsetLeft)).toBeGreaterThan(await tree.locator(`[data-tree-task="${one.id}"]`).evaluate(node=>node.offsetLeft));
  await tree.getByRole('button',{name:'Continue from new task',exact:true}).click();await enter(tree,'Chain C');expect(f.tasks.find(row=>row.title==='Chain C').metadata.predecessor_task_ids).toEqual([f.tasks.find(row=>row.title==='Next B').id]);
  await expect(tree.locator('.tree-task')).toHaveCount(7);
  await tree.getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await tree.locator('xpath=ancestor::dialog').getByRole('button',{name:'Open full screen',exact:true}).click();await tree.getByRole('button',{name:'Fit tree',exact:true}).click();await page.screenshot({path:require('node:path').resolve(__dirname,'../../tmp/docs/handoffs/task-tree/populated-tree.png')});await tree.locator('xpath=ancestor::dialog').getByRole('button',{name:'Restore from full screen',exact:true}).click();
  const before=await tree.locator(`[data-tree-task="${base.id}"]`).getAttribute('style');await tree.getByRole('button',{name:'Refresh tree',exact:true}).click();await expect(tree.locator(`[data-tree-task="${base.id}"]`)).toHaveAttribute('style',before);
  await page.reload();await expect(page.locator('.tree-task')).toHaveCount(7);
  f.tasks.find(row=>row.id===base.id).title='Edited through another view';
  await page.locator('.canvas-task-tree').getByRole('button',{name:'Refresh tree',exact:true}).click();await expect(page.locator('.tree-task-open strong').filter({hasText:'Edited through another view'})).toBeVisible();
  await page.locator(`[data-tree-task="${base.id}"]`).getByRole('button',{name:'Collapse',exact:true}).click();await expect(page.locator('.tree-task')).toHaveCount(1);await page.reload();await expect(page.locator('.tree-task')).toHaveCount(1);
  await page.locator(`[data-tree-task="${base.id}"]`).getByRole('button',{name:'Expand',exact:true}).click();await expect(page.locator('.tree-task')).toHaveCount(7);
});

test('Task Tree keeps destinations independent, retains failed titles and uses same retry identity',async({page,context})=>{
  const f=await fixture(page,context);let tree=await addTree(page);
  await tree.getByRole('button',{name:'New Task',exact:true}).click();f.fail();await tree.getByRole('textbox',{name:'New task title',exact:true}).fill('Retry root');await tree.getByRole('button',{name:'Add task',exact:true}).click();await expect(tree.getByRole('alert')).toBeVisible();await expect(tree.getByRole('textbox',{name:'New task title',exact:true})).toHaveValue('Retry root');await tree.getByRole('button',{name:'Add task',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(1);
  const retries=f.writes.filter(row=>row.title==='Retry root');expect(retries[0].client_request_id).toBe(retries[1].client_request_id);expect(f.tasks.filter(row=>row.title==='Retry root')).toHaveLength(1);
  tree=await addTree(page,channels[1]);await tree.getByRole('button',{name:'New Task',exact:true}).click();await enter(tree,'Other root');expect(f.tasks.find(row=>row.title==='Other root').channel_id).toBe(channels[1]);expect(f.tasks.find(row=>row.title==='Retry root').channel_id).toBe(channels[0]);
  f.revoke();await page.reload();await expect(page.locator('.tree-task')).toHaveCount(0);await expect(page.getByText('Ask your workspace owner for access.').first()).toBeVisible();
});

test('large Task Tree renders progressively with shared successors and invalid cycles bounded',async({page,context})=>{
  const f=await fixture(page,context,{large:1200});const a=f.tasks[1],b=f.tasks[2];f.task('Shared successor',{predecessor_task_ids:[a.id,b.id]});f.root.metadata.predecessor_task_ids=[a.id];
  const tree=await addTree(page);await tree.getByRole('button',{name:'Existing Task',exact:true}).click();await tree.getByRole('button',{name:'Existing root',exact:true}).click();
  await expect(tree.locator('.tree-task')).toHaveCount(100);await expect(tree.getByRole('button',{name:'Load / show more relationships',exact:true})).toBeVisible();
  const start=Date.now();await tree.getByRole('button',{name:'Load / show more relationships',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(200);console.log(JSON.stringify({scenario:'Task Tree simulated local browser',canonicalTasks:f.tasks.length,visibleCards:200,loadMoreMs:Date.now()-start}));
  await tree.getByRole('button',{name:'Fit tree',exact:true}).click();await expect(tree.locator('.tree-world')).toHaveAttribute('style',/scale\(/);
});

test('card opens the existing editable task detail modal and saves to the same shared task',async({page,context})=>{
  const f=await fixture(page,context);const tree=await addTree(page);await tree.getByRole('button',{name:'Existing Task',exact:true}).click();await tree.getByRole('button',{name:'Existing root',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(1);
  await tree.locator('.tree-task-open').click();await expect(page.locator('.canvas-task-detail-dialog')).toBeVisible();
  const frame=page.frameLocator('.canvas-task-detail-dialog iframe');await frame.locator('body').waitFor();try{await expect(frame.locator('.task-detail-panel')).toBeVisible({timeout:10000});}catch(error){console.log('MODAL_LATE',await frame.locator('body').evaluate(()=>{const s=Alpine.store('chat');return {url:location.href,ready:s.canvasChatEmbedReady,error:s.canvasChatEmbedError,appError:s.error,show:s.showTaskDetail,active:s.activeTaskId,modal:s.chatTaskModalOpen,tasks:s.tasks.length,text:document.body.innerText.slice(0,1000)};}));throw error;}
  if(await frame.getByRole('button',{name:'Edit',exact:true}).first().isVisible())await frame.getByRole('button',{name:'Edit',exact:true}).first().click();await frame.locator('.task-detail-title').first().fill('Edited in normal task details');await frame.getByRole('button',{name:'Save',exact:true}).first().click();
  await expect.poll(()=>f.tasks.find(row=>row.id===f.root.id).title).toBe('Edited in normal task details');await page.getByRole('button',{name:'Close task details',exact:true}).click();await expect(tree.locator('.tree-task-open strong')).toHaveText('Edited in normal task details');
});

test('existing nested graph draws shared successors once and keeps selected root with explicit upstream context',async({page,context})=>{
  const f=await fixture(page,context);const parent=f.task('Parent context');f.root.metadata.parent_task_id=parent.id;const a=f.task('Nested child',{parent_task_id:f.root.id}),b=f.task('Sibling',{parent_task_id:f.root.id});f.task('Shared result',{predecessor_task_ids:[a.id,b.id]},channels[1]);
  const tree=await addTree(page);await tree.getByRole('button',{name:'Existing Task',exact:true}).click();await tree.getByRole('button',{name:'Existing root',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(4);await expect(tree.locator('.tree-task-open strong').filter({hasText:'Shared result'})).toHaveCount(1);await expect(tree.locator('.tree-connectors path.successor')).toHaveCount(2);await expect(tree.getByRole('button',{name:'Load parent context',exact:true})).toBeVisible();await tree.getByRole('button',{name:'Load parent context',exact:true}).click();await expect(tree.locator('.tree-task')).toHaveCount(5);expect(f.naplets[0].layout.task_tree.root_task_id).toBe(f.root.id);
});

test('phone full-screen tree supports touch creation and local graph scrolling',async({page,context})=>{
  await fixture(page,context);await page.setViewportSize({width:390,height:850});
  // Place through the ordinary toolbar, then use the standard full-screen window.
  await page.getByRole('button',{name:'Task Tree',exact:true}).click();await page.locator('.canvas-stage').tap({position:{x:30,y:70}});const window=page.locator('.canvas-naplet').last();await window.getByRole('button',{name:'Open full screen',exact:true}).tap();
  const tree=window.locator('.canvas-task-tree');await tree.getByLabel('Task Tree scope',{exact:true}).selectOption(scopeId);await tree.getByLabel('Task Tree channel',{exact:true}).selectOption(channels[0]);await tree.getByRole('button',{name:'New Task',exact:true}).tap();await tree.locator('input[aria-label="New task title"]').fill('Touch base');await tree.getByRole('button',{name:'Add task',exact:true}).tap();await expect(tree.locator('.tree-task')).toHaveCount(1);
  await tree.getByRole('button',{name:'Add child to Touch base',exact:true}).tap();await tree.locator('input[aria-label="New task title"]').fill('Touch child');await tree.getByRole('button',{name:'Add task',exact:true}).tap();await expect(tree.locator('.tree-task')).toHaveCount(2);
  const dimensions=await tree.locator('.tree-scroll').evaluate(node=>({width:node.clientWidth,height:node.clientHeight,scrollHeight:node.scrollHeight}));expect(dimensions.width).toBeLessThan(390);expect(dimensions.height).toBeGreaterThan(100);
});

test('phone graph touch pan keeps the canvas mounted without refreshing the outer snapshot',async({page,context})=>{
  await fixture(page,context,{large:12});await page.setViewportSize({width:390,height:850});
  const tree=await addTree(page);const win=tree.locator('xpath=ancestor::dialog');await win.getByRole('button',{name:'Open full screen',exact:true}).tap();
  await tree.getByRole('button',{name:'Existing Task',exact:true}).tap();await tree.getByRole('button',{name:'Existing root',exact:true}).tap();
  await expect(tree.locator('.tree-task')).toHaveCount(13);
  await page.evaluate(()=>{const s=Alpine.store('canvas');window.__panProbe={refreshes:0,cancels:0};const refresh=s.refresh.bind(s);s.refresh=(...args)=>{window.__panProbe.refreshes++;return refresh(...args)};document.addEventListener('pointercancel',()=>window.__panProbe.cancels++);document.querySelector('.tree-scroll').__originalTree=true;window.__panViewport={...s.viewport};});
  const scroll=tree.locator('.tree-scroll');const box=await scroll.boundingBox();
  const cdp=await context.newCDPSession(page);
  const x=box.x+box.width-12,y=box.y+Math.min(180,box.height-10);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let d=10;d<=110;d+=10){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-d}]});await page.waitForTimeout(20);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(600);
  console.log('TOUCH_PAN_PROBE',await page.evaluate(()=>window.__panProbe));
  expect(await page.evaluate(()=>window.__panProbe)).toEqual({refreshes:0,cancels:1});
  expect(await scroll.evaluate(el=>el.__originalTree)).toBe(true);
  expect(await page.evaluate(()=>({...Alpine.store('canvas').viewport}))).toEqual(await page.evaluate(()=>window.__panViewport));
  expect(await scroll.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await expect(tree.locator('.tree-task')).toHaveCount(13);
  // Native cancellation and debounced viewport persistence retain the same view.
  const scale=await page.evaluate(()=>Alpine.store('canvas').naplets[0].layout.task_tree.viewport.scale);
  await tree.getByRole('button',{name:'Zoom tree in',exact:true}).tap();
  await expect.poll(()=>page.evaluate(()=>Alpine.store('canvas').naplets[0].layout.task_tree.viewport.scale)).toBeGreaterThan(scale);
  await scroll.evaluate(el=>{el.scrollTop=0;el.scrollLeft=0;});
  await tree.locator('.tree-task-open').first().tap();await expect(page.locator('.canvas-task-detail-dialog')).toBeVisible();
  await expect(page.frameLocator('.canvas-task-detail-dialog iframe').locator('.task-detail-panel')).toBeVisible();
  await page.getByRole('button',{name:'Close task details',exact:true}).tap();
  await win.getByRole('button',{name:'Restore from full screen',exact:true}).tap();
  await win.getByRole('button',{name:'Minimise window',exact:true}).tap();await expect(tree).not.toBeVisible();
  await win.getByRole('button',{name:'Restore window',exact:true}).tap();await expect(tree).toBeVisible();
  expect(await scroll.evaluate(el=>el.__originalTree)).toBe(true);
  const stage=page.locator('.canvas-stage'),stageBox=await stage.boundingBox();
  // A move that began in a naplet must never become an extra outer pinch finger.
  await tree.dispatchEvent('pointermove',{pointerId:999,pointerType:'touch',clientX:200,clientY:400});
  const before=await page.evaluate(()=>({...Alpine.store('canvas').viewport}));
  const outer={x:stageBox.x+5,y:stageBox.y+10};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[outer]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:outer.x+20,y:outer.y+30}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>page.evaluate(()=>Alpine.store('canvas').viewport.y)).toBeGreaterThan(before.y);
  expect(await page.evaluate(()=>Alpine.store('canvas').viewport.scale)).toBe(before.scale);
  await expect.poll(()=>page.evaluate(()=>Alpine.store('canvas').viewportSaving)).toBe(false);
  const pinchBefore=await page.evaluate(()=>Alpine.store('canvas').viewport.scale);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[outer,{x:outer.x+40,y:outer.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[outer,{x:outer.x+80,y:outer.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>page.evaluate(()=>Alpine.store('canvas').viewport.scale)).toBeGreaterThan(pinchBefore);
  await expect.poll(()=>page.evaluate(()=>Alpine.store('canvas').viewportSaving)).toBe(false);
  // Cancellation of an actual outer gesture still reconciles its optimistic edit.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[outer]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await expect.poll(()=>page.evaluate(()=>window.__panProbe.refreshes)).toBe(1);
});
