const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
let bundle;
test.beforeAll(async () => {
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
