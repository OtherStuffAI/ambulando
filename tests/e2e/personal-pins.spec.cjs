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
