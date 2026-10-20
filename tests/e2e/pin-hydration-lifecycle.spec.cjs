const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test('retained canonical pins render through real application startup', async ({ page }) => {
 const options={bundle:true,write:false,format:'esm',logLevel:'silent',define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1test'),'import.meta.env':'{}'}};
 const seed=(await build({...options,stdin:{resolveDir:path.resolve(__dirname,'../..'),contents:`export * from './src/db.js';export { normalizeWorkspaceEntry } from './src/workspaces.js';export { threadPinContext, threadPinMigrationKey, threadPinSupportKey } from './src/thread-pin-store.js';`} })).outputFiles[0].text;
 const app=(await build({...options,plugins:[{name:'editor-fixture',setup(b){b.onResolve({filter:/^virtual:document-editor-asset$/},()=>({path:'editor',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default "/unused-editor.js";',loader:'js'}));}}],loader:{'.html':'text','.css':'empty','.png':'dataurl','.svg':'dataurl'},stdin:{resolveDir:path.resolve(__dirname,'../..'),contents:`
 import Alpine from 'alpinejs';
 const original=Alpine.store;
 Alpine.store=function(name,value){
  if(name==='chat' && value){
   value.maybeAutoLogin=async function(){this.session={npub:'npub1reader'};};
   value.ensureWorkspaceSessionKey=async()=>{};
   value.startExtensionSignerWatch=()=>{};
   value.verifyPgDescriptor=async()=>{throw new TypeError('Network unavailable in synthetic lifecycle test');};
   value.refreshKnownHostsMetadata=async()=>{};
  }
  return original(name,value);
 };
 import('./src/main.js');
 `} })).outputFiles[0].text;
 await page.route('**/*', route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/__seed')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>seed</title>'});
  if(pathname==='/__pin-seed.js')return route.fulfill({contentType:'text/javascript',body:seed});
  if(/\/assets\/app-.*\.js$/.test(pathname))return route.fulfill({contentType:'text/javascript',body:app});
  return serveBuiltFlightDeck(route);
 });
 await page.goto('/__seed');
 const key=await page.evaluate(async()=>{
  const m=await import('/__pin-seed.js');
  const workspace=m.normalizeWorkspaceEntry({workspaceId:'workspace',workspaceOwnerNpub:'npub1owner',pgSessionNpub:'npub1reader',towerServiceNpub:'npub1tower',workspaceServiceNpub:'npub1workspace',pgBackendMode:true,appNpub:'npub1test',directHttpsUrl:'http://127.0.0.1:3100',pgMe:{actor:{npub:'npub1reader',actor_id:'actor'},identity:{workspace_id:'workspace'}}});
  const db=m.openWorkspaceDb(workspace.workspaceKey);await db.open();
  const context=m.threadPinContext({session:{npub:'npub1reader'},currentWorkspace:workspace});
  await db.thread_pins.put({id:'pin',record_id:'pin',context:context.key,workspace_id:'workspace',actor_id:'actor',resource_type:'thread',resource_id:'thread',thread_id:'thread',channel_id:'channel',root_record_id:'source',pinned:true,pinned_at:'2026-10-01',row_version:1});
  await db.channels.put({record_id:'channel',title:'Channel',record_state:'active'});
  await db.chat_messages.put({record_id:'thread',channel_id:'channel',pg_source_message_id:'source',title:'Retained conversation',record_state:'active'});
  await db.sync_state.put({key:m.threadPinSupportKey(context),value:true});
  await m.saveSettings({knownWorkspaces:[workspace],currentWorkspaceKey:workspace.workspaceKey,currentWorkspaceOwnerNpub:'npub1owner',backendUrl:'http://127.0.0.1:3100',deckInboxEnabled:true});
  return workspace.workspaceKey;
 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await page.waitForFunction(()=>window.Alpine?.store('chat')?.routeSyncPaused===false);
 console.log('PIN_STARTUP',await page.evaluate(()=>{const s=window.Alpine.store('chat');return {session:s.session,workspace:s.currentWorkspaceKey,pins:s.pinnedThreads,context:s.pinnedThreadsContext,partition:s.pinnedThreadsPartition,error:s.pinnedThreadsError};}),errors);
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toBeVisible();
 await expect(page.locator('[data-testid="deck-pinned-threads"]')).toContainText('Retained conversation');
});
