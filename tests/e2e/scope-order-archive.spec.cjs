const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// A bounded loopback request harness uses real TowerSyncService recovery,
// canonical materialization, IndexedDB and liveQuery in three browser sessions.
// Signed route/SSE and v2 checkpoint tests run against an isolated Tower DB.
test('two connected sessions and offline reconnect preserve personal order, caches and pending edits without bootstrap', async ({ browser, baseURL }) => {
  const source = `
import {liveQuery} from 'dexie';
import {openWorkspaceDb} from './src/db.js';
import {applyPgRecordChanges,recordDeltaCursorKey} from './src/pg-record-delta.js';
import {syncTowerPgWorkspace} from './src/pg-read-hydrator.js';
import {TowerSyncService} from './src/tower-sync-service.js';
import {filterArchivedProjection,canLoadPgTarget} from './src/pg-archive-state.js';
import {sortScopesPersonally} from './src/scope-order.js';
import {scopesManagerMixin} from './src/scopes-manager.js';
window.boot=async(fixture,key)=>{
 const c=fixture.one_message_delta.changes[0],actor='10000000-0000-4000-8000-000000000001';
 const store={workspaceId:c.workspace_id,workspaceOwnerNpub:'npub1owner',backendUrl:location.origin,session:{npub:'npub1viewer'},currentWorkspace:{workspaceId:c.workspace_id,workspaceOwnerNpub:'npub1owner',pgBackendMode:true,pgMe:{actor:{actor_id:actor,npub:'npub1viewer'}}},selectedChannelId:c.channel_id,channels:[{record_id:c.channel_id,scope_id:c.scope_id}],saveChatComposerDraft(){},closeThread(){},openAllScopesOverview(){this.overview=true;this.selectedChannelId=null;},syncRoute(){}};
 const db=openWorkspaceDb(key);await db.open();
 if(!await db.sync_state.get(recordDeltaCursorKey(store))){
  await applyPgRecordChanges(store,{...fixture.one_message_delta,changes:[c],next_cursor:'seed'});
  await db.sync_state.update(recordDeltaCursorKey(store),{value:{cursor:'seed',viewBaselineInitialized:true,localGeneration:0}});
  await db.scopes.bulkPut([{record_id:c.scope_id,title:'A'},{record_id:'second',title:'B'}]);
  await db.channels.put({record_id:c.channel_id,scope_id:c.scope_id});
  await db.documents.put({record_id:'unrelated',channel_id:'other',title:'Keep'});
  await db.tasks.put({record_id:'pending',channel_id:c.channel_id,title:'Unsent',sync_status:'pending'});
  await db.pending_writes.add({record_id:'pending',envelope:{title:'Unsent'}});
  await db.sync_state.put({key:'unrelated-cursor',value:'retain'});
 }
 let service;
 service=new TowerSyncService({workspaceKey:key,ports:{canLoad:(f,id,o)=>canLoadPgTarget(f,id,o),materialize:(_f,p)=>applyPgRecordChanges(store,p,p.local_apply_options),recoverCursor:()=>syncTowerPgWorkspace(store,{}, {getTowerPgRecordSync:async(_w,o)=>{const r=await fetch('/__scope-sync?cursor='+encodeURIComponent(o.cursor));if(!r.ok)throw Error('request rejected');return r.json();},hydrateTowerPgSyncBundle:(_s,p)=>service.materialize('records',p)})}});
 const sub=liveQuery(async()=>({order:await db.scope_orders.get(actor),scopes:await db.scopes.toArray(),targets:await db.pg_archived_targets.toArray(),content:await filterArchivedProjection(await db.chat_messages.toArray())})).subscribe(v=>{window.view={order:sortScopesPersonally(v.scopes,v.order?.scope_ids||[]).map(r=>r.record_id),content:v.content.length};scopesManagerMixin.handlePgArchivedTargets.call(store,v.targets);});
 window.probe={recover:()=>service.recoverCursor(),inspect:async()=>({view:window.view,overview:!!store.overview,pending:await db.pending_writes.count(),draft:await db.tasks.get('pending'),doc:await db.documents.get('unrelated'),unrelated:(await db.sync_state.get('unrelated-cursor')).value,state:(await db.sync_state.get(recordDeltaCursorKey(store))).value,cachedMessages:await db.chat_messages.count(),blocked:await service.ensureLoaded('channel-messages',c.channel_id,{force:true})}),close(){sub.unsubscribe();service.dispose();db.close();}};
};`;
  const bundle = await build({ stdin: { contents: source, resolveDir: path.resolve(__dirname, '../..'), sourcefile: 'scope-order-browser-probe.js' }, bundle: true, write: false, format: 'esm', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } });
  const origin = new URL(baseURL).origin, c = fixture.one_message_delta.changes[0];
  const actor = '10000000-0000-4000-8000-000000000001';
  let stage = 'order'; const requests = []; const contexts = [];
  const orderChange = { workspace_id: c.workspace_id, family: 'scope_order', id: actor, operation: 'upsert', version: '30', scope_id: null, channel_id: null, row: { id: actor, workspace_id: c.workspace_id, actor_id: actor, scope_ids: ['second', c.scope_id], row_version: 1, updated_at: '2026-10-08T00:00:00Z' } };
  try {
    for (let index = 0; index < 3; index++) {
      const context = await browser.newContext(); contexts.push(context);
      await context.route(`${origin}/__scope-probe`, route => route.fulfill({ contentType: 'text/html', body: '<script type="module" src="/__scope-probe.js"></script>' }));
      await context.route(`${origin}/__scope-probe.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
      await context.route(`${origin}/__scope-sync?*`, route => {
        const cursor = new URL(route.request().url()).searchParams.get('cursor'); requests.push({ index, cursor, stage });
        const changes = stage === 'order' ? [orderChange] : [...(cursor === 'seed' ? [orderChange] : []), { family: 'scope', id: c.scope_id, workspace_id: c.workspace_id, scope_id: c.scope_id, channel_id: null, operation: 'delete', version: '40', row: null }, { family: 'channel', id: c.channel_id, workspace_id: c.workspace_id, scope_id: c.scope_id, channel_id: c.channel_id, operation: 'delete', version: '41', row: null }];
        return route.fulfill({ json: { ...fixture.one_message_delta, actors: [], families: [...fixture.one_message_delta.families, 'scope_order'], changes, next_cursor: stage, has_more: false } });
      });
      const page = await context.newPage(); await page.goto(`${origin}/__scope-probe`); await page.waitForFunction(() => window.boot);
      await page.evaluate(({fixture,index}) => window.boot(fixture, `scope-archive-browser-${index}`), { fixture, index });
    }
    const pages = contexts.map(context => context.pages()[0]);
    for (const page of pages.slice(0,2)) await page.evaluate(() => window.probe.recover());
    await expect.poll(() => pages[1].evaluate(() => window.view?.order)).toEqual(['second', c.scope_id]);
    await pages[1].reload(); await pages[1].waitForFunction(() => window.boot);
    await pages[1].evaluate(fixture => window.boot(fixture,'scope-archive-browser-1'),fixture);
    await expect.poll(() => pages[1].evaluate(() => window.view?.order)).toEqual(['second',c.scope_id]);
    stage='archive';
    for (const page of pages.slice(0,2)) await page.evaluate(() => window.probe.recover());
    expect(requests.some(r=>r.index===2)).toBe(false); // disconnected session
    await pages[2].evaluate(() => window.probe.recover());
    for (const page of pages) {
      await expect.poll(() => page.evaluate(() => window.probe.inspect().then(r=>r.overview))).toBe(true);
      const result=await page.evaluate(() => window.probe.inspect());
      expect(result).toMatchObject({pending:1,draft:{title:'Unsent',sync_status:'pending'},doc:{title:'Keep'},unrelated:'retain',cachedMessages:1,view:{content:0},blocked:{archived:true},state:{localGeneration:0,cursor:'archive'}});
    }
    expect(requests).toEqual([{index:0,cursor:'seed',stage:'order'},{index:1,cursor:'seed',stage:'order'},{index:0,cursor:'order',stage:'archive'},{index:1,cursor:'order',stage:'archive'},{index:2,cursor:'seed',stage:'archive'}]);
  } finally { await Promise.all(contexts.map(context=>context.close())); }
});
