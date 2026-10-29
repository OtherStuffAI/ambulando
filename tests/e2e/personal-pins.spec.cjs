const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
let bundle, lifecycleBundle;
test.beforeAll(async () => {
 lifecycleBundle=(await build({bundle:true,write:false,format:'esm',logLevel:'silent',plugins:[{name:'editor-fixture',setup(b){b.onResolve({filter:/^virtual:document-editor-asset$/},()=>({path:'editor',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default "/unused-editor.js";',loader:'js'}));}}],loader:{'.html':'text','.css':'empty','.png':'dataurl','.svg':'dataurl'},define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1test'),'import.meta.env':'{}'},stdin:{resolveDir:path.resolve(__dirname,'../..'),contents:`import './src/main.js'; import * as db from './src/db.js'; window.pinLifecycleDb=db;`} })).outputFiles[0].text;
 bundle=(await build({bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1test')},stdin:{resolveDir:path.resolve(__dirname,'../..'),contents:`export {openWorkspaceDb} from './src/db.js';export {pinnedThreadsMixin} from './src/pinned-threads.js';`} })).outputFiles[0].text;
});
for(const width of [375,1440])test(`task/document pin controls and typed list preserve view/edit state at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/*',route=>new URL(route.request().url()).pathname==='/__personal-pins.js'?route.fulfill({contentType:'text/javascript',body:bundle}):serveBuiltFlightDeck(route));
 await openFixture(page,true);
 await page.evaluate(async()=>{
  const m=await import('/__personal-pins.js'),s=window.Alpine.store('chat');
  s.closeThread({syncRoute:false});s.stopBackgroundSync();s.requestTowerSyncFamily=async()=>{};
  const key='personal-pin-browser',actor='10000000-0000-4000-8000-000000000001',workspaceId='20000000-0000-4000-8000-000000000001';
  const db=m.openWorkspaceDb(key);await db.open();window.personalPinDb=db;
  Object.defineProperties(s,Object.getOwnPropertyDescriptors(m.pinnedThreadsMixin));
  s.knownWorkspaces=[{workspaceKey:key,workspaceId,workspaceOwnerNpub:s.session.npub,appNpub:'npub1test',directHttpsUrl:'http://127.0.0.1:3100',pgBackendMode:true,pgMe:{actor:{actor_id:actor,npub:s.session.npub},identity:{workspace_id:workspaceId}}}];
  s.selectedWorkspaceKey=key;s.workspaceDbKey=key;s.isTowerPgMode=true;
  for(const row of s.tasks) {row.pg_backend=true;row.pg_record_type='task';}
  for(const row of s.documents.filter(r=>r.pg_record_type!=='file')){row.pg_backend=true;row.pg_record_type='doc';row.pg_channel_id='sol-channel';}
  await db.channels.bulkPut(JSON.parse(JSON.stringify(s.channels)));
  await db.tasks.bulkPut(JSON.parse(JSON.stringify(s.tasks)));await db.documents.bulkPut(JSON.parse(JSON.stringify(s.documents)));
  s.syncPinnedThreadsContext(s.pinnedThreadsPartition);
  s.openTaskDetail('sol-task');window.taskDraftBeforePin=JSON.stringify(s.editingTask);window.taskModeBeforePin=s.taskDetailMode;
 });
 const taskPin=page.locator('[data-testid="personal-pin-task"]:visible');await expect(taskPin).toHaveCount(1);
 await taskPin.click();await expect(taskPin).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>JSON.stringify(window.Alpine.store('chat').editingTask)===window.taskDraftBeforePin&&window.Alpine.store('chat').taskDetailMode===window.taskModeBeforePin)).toBe(true);
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.openDoc('sol-doc',{ensureSync:false});window.docModeBeforePin=s.docEditAccessState;});
 const docPin=page.locator('[data-testid="personal-pin-document"]:visible');await expect(docPin).toHaveCount(1);await docPin.click();await expect(docPin).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>window.Alpine.store('chat').docEditAccessState===window.docModeBeforePin)).toBe(true);
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.navSection='status';s.showTaskDetail=false;s.selectedDocId=null;s.deckInboxEnabled=true;});
 const panel=page.locator('[data-testid="deck-pinned-threads"]');
 if(width<769)await page.getByRole('button',{name:'Show Pinned items',exact:true}).click();
 await expect(panel.locator('.pinned-thread-row')).toHaveCount(2);
 await expect(panel.locator('[aria-label="task"]')).toHaveCount(1);await expect(panel.locator('[aria-label="document"]')).toHaveCount(1);
 // Pin actions write only their typed local outbox, never resource/read/lease rows.
 expect(await page.evaluate(async()=>({writes:await window.personalPinDb.pending_writes.count(),reads:await window.personalPinDb.resource_view_states.count(),pins:(await window.personalPinDb.thread_pin_outbox.toArray()).map(r=>r.resourceType).sort()}))).toEqual({writes:0,reads:0,pins:['document','task']});
 await panel.locator('.pinned-thread-open').filter({hasText:'Connected design review'}).click();
 await expect.poll(()=>page.evaluate(()=>window.Alpine.store('chat').selectedDocId)).toBe('sol-doc');
 await page.evaluate(()=>{window.Alpine.store('chat').navSection='status';});
 if(width<769)await page.getByRole('button',{name:'Show Pinned items',exact:true}).click();
 await panel.locator('.pinned-thread-open').filter({hasText:'Review connected frontend'}).click();
 await expect.poll(()=>page.evaluate(()=>window.Alpine.store('chat').activeTaskId)).toBe('sol-task');
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.navSection='status';s.showTaskDetail=false;});
 if(width<769)await page.getByRole('button',{name:'Show Pinned items',exact:true}).click();

 await panel.getByRole('button',{name:'Unpin Connected design review',exact:true}).click();await expect(panel.locator('.pinned-thread-row')).toHaveCount(1);
 await page.evaluate(async()=>{await window.personalPinDb.tasks.update('sol-task',{record_state:'deleted'});});
 await expect(panel).toContainText('Task unavailable');await expect(panel.locator('.pinned-thread-open')).toBeDisabled();
 await panel.getByRole('button',{name:'Unpin Task unavailable',exact:true}).click();await expect(panel).toBeHidden();
 console.log('PERSONAL_PINS_BROWSER',JSON.stringify({width,taskAndDocumentControls:true,typedIcons:true,unchangedEditAndReadState:true,unavailableUnpin:true,hiddenEmpty:true}));
});
test('canonical thread pins survive late reader hydration and subsequent refresh', async ({page}) => {
 await page.route('**/*',route=>new URL(route.request().url()).pathname==='/__personal-pins.js'?route.fulfill({contentType:'text/javascript',body:bundle}):serveBuiltFlightDeck(route));
 await openFixture(page,true);
 await page.evaluate(async()=>{
  const m=await import('/__personal-pins.js'),s=window.Alpine.store('chat');
  s.closeThread({syncRoute:false});s.stopBackgroundSync();s.requestTowerSyncFamily=async()=>{};
  const key='canonical-pin-lifecycle',workspaceId='workspace',actor='actor';
  const db=m.openWorkspaceDb(key);await db.open();window.personalPinDb=db;
  s.startWorkspaceLiveQueries=window.fixtureStartWorkspaceLiveQueries;
  s.ensureWorkspaceSessionKey=async()=>{};s.loadLocalWorkspaceCoreData=async()=>{};s.persistWorkspaceSettings=async()=>{};
  s.knownWorkspaces=[{workspaceKey:key,workspaceOwnerNpub:s.session.npub,workspaceId,appNpub:'npub1test',directHttpsUrl:'http://127.0.0.1:3100',pgBackendMode:true}];
  await s.selectWorkspace(key,{skipPgVerification:true});s.isTowerPgMode=true;s.navSection='status';s.deckInboxEnabled=true;
  await db.thread_pins.put({record_id:'pin',id:'pin',context:JSON.stringify(['http://127.0.0.1:3100','npub1test',workspaceId,actor]),workspace_id:workspaceId,actor_id:actor,resource_type:'thread',resource_id:'thread',thread_id:'thread',pinned:true,pinned_at:'2026-10-01',row_version:1});
 });
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.knownWorkspaces[0].pgMe={actor:{actor_id:'actor',npub:s.session.npub}};});
 await expect(page.locator('[data-testid="deck-pinned-threads"] .pinned-thread-row')).toHaveCount(1);
 await page.evaluate(async()=>{
  await window.personalPinDb.channels.put({record_id:'sol-channel',record_state:'active'});
  await window.personalPinDb.chat_messages.put({record_id:'thread',channel_id:'sol-channel',pg_source_message_id:'source',title:'Recovered thread',record_state:'active'});
 });
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toContainText('Recovered thread');
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toBeVisible();
 const families=[...require('../fixtures/flightdeck-record-delta-v1.json').one_message_delta.families,'personal_pin'];
 await page.evaluate(async families=>{
  const s=window.Alpine.store('chat');
  await s.materializeTowerPgWorkspaceBundle({protocol_version:1,families,mode:'snapshot',snapshot_id:'pin-snapshot',snapshot_complete:true,partitions_complete:families,next_cursor:'snapshot',has_more:true,changes:[{family:'personal_pin',id:'pin',workspace_id:'workspace',version:'1',operation:'upsert',row:{id:'pin',workspace_id:'workspace',actor_id:'actor',resource_type:'thread',resource_id:'thread',thread_id:'thread',channel_id:'sol-channel',root_record_id:'source',pinned:true,pinned_at:'2026-10-01',row_version:1}}]});
  await s.materializeTowerPgWorkspaceBundle({protocol_version:1,families,mode:'delta',snapshot_id:null,snapshot_complete:false,partitions_complete:[],next_cursor:'delta',has_more:false,changes:[]});
 },families);
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toBeVisible();
 await expect(page.locator('[data-testid="deck-pinned-threads"] .pinned-thread-row')).toHaveCount(1);
 await page.evaluate(async families=>{
  const s=window.Alpine.store('chat');
  await s.materializeTowerPgWorkspaceBundle({protocol_version:1,families,mode:'delta',snapshot_id:null,snapshot_complete:false,partitions_complete:[],next_cursor:'unpin',has_more:false,changes:[{family:'personal_pin',id:'pin',workspace_id:'workspace',version:'2',operation:'upsert',row:{id:'pin',workspace_id:'workspace',actor_id:'actor',resource_type:'thread',resource_id:'thread',thread_id:'thread',channel_id:'sol-channel',root_record_id:'source',pinned:false,pinned_at:null,row_version:2}}]});
 },families);
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toBeHidden();
 await page.evaluate(async families=>{
  const s=window.Alpine.store('chat');
  await s.materializeTowerPgWorkspaceBundle({protocol_version:1,families,mode:'delta',snapshot_id:null,snapshot_complete:false,partitions_complete:[],next_cursor:'repin',has_more:false,changes:[{family:'personal_pin',id:'pin',workspace_id:'workspace',version:'3',operation:'upsert',row:{id:'pin',workspace_id:'workspace',actor_id:'actor',resource_type:'thread',resource_id:'thread',thread_id:'thread',channel_id:'sol-channel',root_record_id:'source',pinned:true,pinned_at:'2026-10-02',row_version:3}}]});
 },families);
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toBeVisible();
});

for(const width of [375,1440])test(`channel Inbox pins persist and navigate across scopes at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/*',route=>new URL(route.request().url()).pathname==='/__personal-pins.js'?route.fulfill({contentType:'text/javascript',body:bundle}):serveBuiltFlightDeck(route));
 await openFixture(page,true);
 await page.evaluate(async()=>{
  const m=await import('/__personal-pins.js'),s=window.Alpine.store('chat');
  s.closeThread({syncRoute:false});s.stopBackgroundSync();s.requestTowerSyncFamily=async()=>{};
  const key='channel-pin-browser',workspaceId='workspace',actor='actor';
  const db=m.openWorkspaceDb(key);await db.open();window.personalPinDb=db;
  Object.defineProperties(s,Object.getOwnPropertyDescriptors(m.pinnedThreadsMixin));
  s.knownWorkspaces=[{workspaceKey:key,workspaceId,workspaceOwnerNpub:s.session.npub,appNpub:'npub1test',directHttpsUrl:'http://127.0.0.1:3100',pgBackendMode:true,pgMe:{actor:{actor_id:actor,npub:s.session.npub}}}];
  s.selectedWorkspaceKey=key;s.workspaceDbKey=key;s.isTowerPgMode=true;
  await db.channels.bulkPut(JSON.parse(JSON.stringify(s.channels)));
  s.navSection='status';s.deckInboxEnabled=true;s.selectPgChannelContext('sol-channel');
  s.syncPinnedThreadsContext(s.pinnedThreadsPartition);
 });
 const toggle=page.getByTestId('personal-pin-channel');await expect(toggle).toBeVisible();
 await expect(page.locator('.deck-inbox-title')).toContainText('Inbox:');
 if(width<769){const boxes=await page.locator('.deck-inbox-title, .inbox-type-toggles').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[1].top);expect(await toggle.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);await page.screenshot({path:`tmp/docs/handoffs/channel-pins-inbox-${width}.png`,fullPage:true});}
 await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-pressed','true');
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s._unreadChannels={'sol-channel':true};});
 const panel=page.getByTestId('deck-pinned-threads');
 if(width<769)await page.getByRole('button',{name:'Show Pinned items',exact:true}).click();
 await expect(panel.locator('.pinned-thread-row')).toHaveCount(1);
 await expect(panel.locator('.pinned-thread-row')).toHaveClass(/inbox-unread/);
 await expect(panel.locator('.pinned-thread-row')).toHaveClass(/pinned-channel-unread/);
 await page.screenshot({path:`tmp/docs/handoffs/channel-pins-${width}.png`,fullPage:true});
 await page.evaluate(()=>{const s=window.Alpine.store('chat');s.stopPinnedThreads();s.syncPinnedThreadsContext(s.pinnedThreadsPartition);s.selectedBoardId='pg:scope:other';});
 await expect(panel.locator('.pinned-thread-row')).toHaveCount(1);
 await panel.locator('.pinned-thread-open').click();
 await expect.poll(()=>page.evaluate(()=>window.Alpine.store('chat').autopilotOverviewContext.channelId)).toBe('sol-channel');
 expect(await page.evaluate(()=>window.Alpine.store('chat').navSection)).toBe('status');
 await page.evaluate(()=>{window.Alpine.store('chat')._unreadChannels={'sol-channel':false};});
 await expect(panel.locator('.pinned-thread-row')).not.toHaveClass(/inbox-unread/);
 expect(await page.evaluate(async()=>({writes:await window.personalPinDb.pending_writes.count(),reads:await window.personalPinDb.resource_view_states.count(),pins:await window.personalPinDb.thread_pin_outbox.count()}))).toEqual({writes:0,reads:0,pins:1});
 await page.evaluate(async()=>{await window.personalPinDb.channels.update('sol-channel',{record_state:'deleted'});});
 await expect(panel).toContainText('Channel unavailable');await expect(panel.locator('.pinned-thread-open')).toBeDisabled();
 await panel.getByRole('button',{name:'Unpin Channel unavailable',exact:true}).click();await expect(panel).toBeHidden();
});

for(const width of [375,1440])test(`mixed personal pins reorder with pointer, keyboard and touch at ${width}px`,async({page})=>{
 page.setDefaultTimeout(10000);
 await page.setViewportSize({width,height:1000});
 await page.route('**/*',route=>new URL(route.request().url()).pathname==='/__personal-pins.js'?route.fulfill({contentType:'text/javascript',body:bundle}):serveBuiltFlightDeck(route));
 await openFixture(page,true);
 await page.evaluate(async()=>{
  const m=await import('/__personal-pins.js'),s=window.Alpine.store('chat');
  s.closeThread({syncRoute:false});s.stopBackgroundSync();s.requestTowerSyncFamily=async()=>{};
  const key='pin-order-browser',workspaceId='workspace',actor='actor';
  const db=m.openWorkspaceDb(key);await db.open();window.personalPinDb=db;
  s.knownWorkspaces=[{workspaceKey:key,workspaceId,workspaceOwnerNpub:s.session.npub,appNpub:'npub1test',directHttpsUrl:'http://127.0.0.1:3100',pgBackendMode:true,pgMe:{actor:{actor_id:actor,npub:s.session.npub}}}];
  // Open the application's real DB singleton through workspace selection.
  // The seed bundle is a separate module graph and must not replace the mixin.
  s.ensureWorkspaceSessionKey=async()=>{};s.loadLocalWorkspaceCoreData=async()=>{};s.persistWorkspaceSettings=async()=>{};
  await s.selectWorkspace(key,{skipPgVerification:true});
  s.isTowerPgMode=true;s.navSection='status';s.deckInboxEnabled=true;
  const context=JSON.stringify(['http://127.0.0.1:3100','npub1test',workspaceId,actor]);
  await db.sync_state.put({key:`pin-order-support:${context}`,value:true});
  await db.sync_state.put({key:`thread-pin-support:${context}`,value:true});
  await db.channels.put({record_id:'same',title:'Hashtag channel',record_state:'active'});
  await db.tasks.put({record_id:'same',title:'Collision task',channel_id:'same',record_state:'active'});
  await db.documents.put({record_id:'same',title:'Collision document',channel_id:'same',record_state:'active'});
  for(const [i,type] of ['channel','task','document'].entries())await db.thread_pins.put({record_id:`pin-${type}`,id:`pin-${type}`,context,workspace_id:workspaceId,actor_id:actor,resource_type:type,resource_id:'same',pinned:true,pinned_at:'2026-10-01',order_position:i,row_version:1});
  s.syncPinnedThreadsContext(s.pinnedThreadsPartition);
  s.testPinOpens=0;s.openPinnedThread=async()=>{s.testPinOpens++;};
 });
 if(width<769)await page.getByRole('button',{name:'Show Pinned items',exact:true}).click({timeout:5000});
 const panel=page.getByTestId('deck-pinned-threads'),rows=panel.locator('.pinned-thread-row');
 await expect(rows).toHaveCount(3);
 if(width<769)await expect.poll(async()=>(await panel.boundingBox()).x).toBeLessThan(20);
 expect(await rows.first().locator('.pinned-item-type svg').innerHTML()).toContain('M4 9h16');
 const keys=()=>rows.evaluateAll(els=>els.map(e=>e.dataset.pinKey));
 expect(await keys()).toEqual(['channel:same','task:same','document:same']);
 const handle=rows.first().locator('.pin-reorder-handle'),last=rows.last();
 const from=await handle.boundingBox(),to=await last.boundingBox();
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+10,to.y+to.height-2,{steps:10});
 await expect(last).toHaveClass(/pin-insert-after/);await page.mouse.up();
 await expect.poll(keys).toEqual(['task:same','document:same','channel:same']);
 expect(await page.evaluate(()=>window.Alpine.store('chat').testPinOpens)).toBe(0);
 const saved=await page.evaluate(async()=>{const [op]=await window.personalPinDb.thread_pin_outbox.toArray();return op;});expect(saved.kind).toBe('order');expect(saved.body.before).toBeNull();
 // Reload the persisted projection (same IndexedDB), then emulate the canonical ack.
 await page.evaluate(async()=>{const s=window.Alpine.store('chat'),db=window.personalPinDb;s.stopPinnedThreads();s.syncPinnedThreadsContext(s.pinnedThreadsPartition);});
 await expect.poll(keys).toEqual(['task:same','document:same','channel:same']);
 await page.evaluate(async()=>{const db=window.personalPinDb;for(const [i,type]of ['task','document','channel'].entries())await db.thread_pins.update(`pin-${type}`,{order_position:i,row_version:2});await db.thread_pin_outbox.clear();});
 const channel=panel.getByRole('button',{name:'Reorder channel: Hashtag channel',exact:true});
 await channel.focus();await page.keyboard.press('Space');await page.keyboard.press('Home');await expect(rows.first()).toHaveClass(/pin-insert-before/);await page.keyboard.press('Escape');
 expect(await keys()).toEqual(['task:same','document:same','channel:same']);
 await page.keyboard.press('Space');await page.keyboard.press('Home');await page.keyboard.press('Enter');
 await expect.poll(keys).toEqual(['channel:same','task:same','document:same']);
 await page.evaluate(async()=>{const db=window.personalPinDb;for(const [i,type]of ['channel','task','document'].entries())await db.thread_pins.update(`pin-${type}`,{order_position:i,row_version:3});await db.thread_pin_outbox.clear();});
 // Real Chromium touch input, same production pointer handler/capture path.
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const touchFrom=await panel.getByRole('button',{name:'Reorder channel: Hashtag channel',exact:true}).boundingBox(),touchTo=await rows.last().boundingBox();
 const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
 await touch('touchStart',touchFrom.x+touchFrom.width/2,touchFrom.y+touchFrom.height/2);await touch('touchMove',touchFrom.x+touchFrom.width/2,touchTo.y+touchTo.height-2);
 await expect(rows.last()).toHaveClass(/pin-insert-after/);await touch('touchEnd');
 await expect.poll(keys).toEqual(['task:same','document:same','channel:same']);
 expect(await page.evaluate(async()=>({opens:window.Alpine.store('chat').testPinOpens,reads:await window.personalPinDb.resource_view_states.count(),writes:await window.personalPinDb.pending_writes.count(),pins:await window.personalPinDb.thread_pins.count()}))).toEqual({opens:0,reads:0,writes:0,pins:3});
 console.log('PIN_ORDER_LAYOUT',await panel.evaluate(el=>{const s=window.Alpine.store('chat');return {column:s.deckMobileColumn,scroll:document.documentElement.scrollLeft,width:innerWidth,box:el.getBoundingClientRect().toJSON()};}));
 if(width<769){
  await expect.poll(async()=>(await panel.boundingBox()).x).toBeLessThan(20);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 }
 await page.screenshot({path:`tmp/docs/handoffs/pin-order-${width}.png`,fullPage:false});
 console.log('PIN_ORDER_BROWSER',JSON.stringify({width,pointer:true,touch:true,keyboard:true,persistedProjection:true,typedCollision:true,noAccidentalOpenOrRead:true}));

 // A remote unpin during a drag cancels the move; it cannot recreate membership.
 await page.evaluate(async()=>{await window.personalPinDb.thread_pin_outbox.clear();});
 const doomed=panel.getByRole('button',{name:'Reorder channel: Hashtag channel',exact:true});
 const doomedBox=await doomed.boundingBox();
 await page.mouse.move(doomedBox.x+10,doomedBox.y+20);await page.mouse.down();
 await page.mouse.move(doomedBox.x+10,doomedBox.y-50,{steps:5});
 await page.evaluate(async()=>{await window.personalPinDb.thread_pins.update('pin-channel',{pinned:false,row_version:4});});
 await expect(rows).toHaveCount(2);await page.mouse.up();
 expect(await page.evaluate(async()=>window.personalPinDb.thread_pin_outbox.count())).toBe(0);
 // Long retained/unavailable lists remain scrollable and edge-scroll during dragging.
 await page.evaluate(async()=>{const db=window.personalPinDb,base=await db.thread_pins.get('pin-task');
  for(let i=0;i<20;i++)await db.thread_pins.put({...base,id:`extra-${i}`,record_id:`extra-${i}`,resource_type:'channel',resource_id:`extra-${i}`,order_position:i+5});
 });
 await expect(rows).toHaveCount(22);
 if(width<769){await page.getByRole('button',{name:'Show Pinned items',exact:true}).click();await expect.poll(async()=>(await panel.boundingBox()).x).toBeLessThan(20);}
 const scroll=panel.locator('.deck-card-scroll');await scroll.evaluate(el=>{el.scrollTop=0;});
 const firstHandle=rows.first().locator('.pin-reorder-handle'),start=await firstHandle.boundingBox(),edge=await scroll.boundingBox();
 await page.mouse.move(start.x+10,start.y+20);await page.mouse.down();await page.mouse.move(start.x+10,edge.y+edge.height-5,{steps:8});
 await expect.poll(()=>scroll.evaluate(el=>el.scrollTop)).toBeGreaterThan(30);
 await page.keyboard.press('Escape');await page.mouse.up();
 expect(await page.evaluate(async()=>window.personalPinDb.thread_pin_outbox.count())).toBe(0);

});
