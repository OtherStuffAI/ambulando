const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// The production store and actual Inbox template, including its context effect,
// empty/loading branch and card projection. No manual Inbox array assignment.
test('downloaded Deck Inbox cards render while control-plane sync is delayed', async ({ page, baseURL }) => {
  page.on('pageerror',e=>console.log('INBOX_ERROR',e.message));
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = source.indexOf('<section class="flightdeck-summary-panel flightdeck-summary-panel-inbox');
  const inbox = source.slice(start, source.indexOf('</section>', start) + '</section>'.length);
  const bundle = await build({ plugins: [{name:'fixture-editor-url',setup(b){b.onResolve({filter:/^virtual:document-editor-asset$/},()=>({path:'fixture-editor-url',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export default '/unused-editor.js';",loader:'js'}));}}], bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': JSON.stringify({ VITE_FLIGHT_DECK_BACKEND_MODE: 'tower-pg' }) },
    stdin: { resolveDir: root, contents: `
      import {initApp} from './src/app.js';
      import {openWorkspaceDb,getChannelsByOwner,getRecentChannelActivity} from './src/db.js';
      import {applyPgRecordChanges,resetPgRecordAuthority,recordDeltaCursorKey} from './src/pg-record-delta.js';
      import {normalizeWorkspaceEntry} from './src/workspaces.js';
      window.probe={openWorkspaceDb,getChannelsByOwner,getRecentChannelActivity,applyPgRecordChanges,resetPgRecordAuthority,recordDeltaCursorKey,normalizeWorkspaceEntry};initApp();
    ` } });
  const origin = new URL(baseURL).origin;
  const releases=[];
  await page.route('**/*', route => {
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
    if(url.pathname==='/harness.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    if(url.pathname==='/api/delayed')return new Promise(resolve=>releases.push(()=>route.fulfill({json:{ok:true}}).then(resolve)));
    if(url.pathname.startsWith('/api/'))return route.fulfill({status:503,json:{error:'fixture unavailable'}});
    return route.fulfill({contentType:'text/html',body:`<!doctype html><style>[x-cloak]{display:none!important}</style><script type="module" src="/harness.js"></script><main x-data>${inbox}<section data-recent><template x-for="row in $store.chat.deckRecentChannels"><p x-text="row.latestMessage"></p></template></section></main>`});
  });
  const setup=async()=>{
    await page.goto(`${origin}/fixture`);await page.waitForFunction(()=>window.probe&&window.Alpine?.store('chat'));
    await page.evaluate(async fixture=>{
      const m=window.probe,s=window.Alpine.store('chat'),key='retained-inbox-browser';
      // Let empty-shell startup settle before restoring the synthetic reader.
      await s.init();
      s.session={npub:'reader',method:'extension'};
      const workspace=m.normalizeWorkspaceEntry({workspaceId:fixture.one_message_delta.changes[0].workspace_id,
        workspaceOwnerNpub:'owner',workspaceServiceNpub:'service',towerServiceNpub:'tower',appNpub:'flightdeck_pg',
        pgSessionNpub:'reader',pgBackendMode:true,directHttpsUrl:location.origin,name:'Cached workspace'});
      s.knownWorkspaces=[workspace];s.selectedWorkspaceKey=workspace.workspaceKey;s.currentWorkspaceOwnerNpub='owner';s.ownerNpub='owner';s.backendUrl=location.origin;
      s.ensureTowerPgControlPlaneHydrated=async()=>fetch('/api/delayed');
      s.verifyPgWorkspaceForSelection=async candidate=>{await fetch('/api/delayed');return candidate;};
      s.refreshWorkspaceSettings=async()=>{};
      s.requestTowerSyncFamily=async()=>({deferred:true});s.ensureBackgroundSync=()=>{};s.refreshGroups=async()=>{};
      s.readStoredTaskBoardId=()=> '__all__';s.readStoredCollapsedSections=()=>({});
      s.applyRouteFromLocation=async()=>{s.navSection='status';s.selectedBoardId='__all__';s.selectedChannelId=null;s.startWorkspaceLiveQueries();};
      s.navSection='status';s.selectedBoardId='__all__';s.selectedChannelId=null;
      const db=m.openWorkspaceDb(workspace.workspaceKey);await db.open();
      if(!await db.chat_messages.count())await m.applyPgRecordChanges(s,fixture.canonical_upserts,{expectedCursor:null});
      window.db=db;window.s=s;window.started=performance.now();
      // A preview already proves cached content exists, as in the reported UI.
      s.channels=await m.getChannelsByOwner('owner');
      s.recentChannelMessages=await m.getRecentChannelActivity('owner');
      window.activation=(async()=>{
        await s.selectWorkspace(workspace.workspaceKey,{refresh:false});
        await s.bootstrapSelectedWorkspace();
        window.localReady=performance.now()-window.started;
      })();
    },fixture);
  };
  try{
    await setup();
    const text=fixture.canonical_upserts.changes.find(row=>row.family==='message').row.body;
    await expect(page.locator('[data-recent]')).toContainText(text);
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText(text,{timeout:1500});
    const domReadyMs=await page.evaluate(()=>performance.now()-window.started);
    await expect(page.locator('.inbox-no-results')).toBeHidden();
    await expect.poll(()=>page.evaluate(()=>window.s.inboxActivityLoading)).toBe(false);
    await page.waitForFunction(()=>Number.isFinite(window.localReady));
    const timing=await page.evaluate(()=>window.localReady);
    expect(timing).toBeLessThan(1500);
    for(let i=0;i<20;i++){
      if(i===5)await page.evaluate(async()=>{await window.probe.resetPgRecordAuthority(window.s,{preserveViews:true});window.s.startWorkspaceLiveQueries();});
      if(i===10)await page.evaluate(()=>{window.s.stopWorkspaceLiveQueries();window.s.startWorkspaceLiveQueries();});
      await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText(text);
      await page.waitForTimeout(1000);
    }
    await page.evaluate(()=>window.s.stopWorkspaceLiveQueries());
    for(const release of releases.splice(0))await release();
    await setup();
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText(text,{timeout:1500});
    await expect.poll(()=>page.evaluate(()=>window.s.inboxActivityLoading)).toBe(false);
    await page.evaluate(async fixture=>{
      const cached=fixture.canonical_upserts.changes.find(row=>row.family==='message');
      const remote={...cached,id:'50000000-0000-4000-8000-000000000098',version:'16',row:{...cached.row,id:'50000000-0000-4000-8000-000000000098',body:'New Inbox conversation',client_request_id:'new-inbox-command',row_version:2}};
      const cursor=(await window.db.sync_state.get(window.probe.recordDeltaCursorKey(window.s)))?.value?.cursor||null;
      await window.probe.applyPgRecordChanges(window.s,{...fixture.one_message_delta,changes:[remote],next_cursor:'inbox-merged'},{expectedCursor:cursor});
    },fixture);
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText('New Inbox conversation');
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText(text);
    await page.evaluate(async fixture=>{
      const cached=fixture.canonical_upserts.changes.find(row=>row.family==='message');
      await window.probe.applyPgRecordChanges(window.s,{...fixture.one_message_delta,changes:[{...cached,operation:'delete',version:'17',row:null}],next_cursor:'inbox-deleted'},{expectedCursor:'inbox-merged'});
    },fixture);
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).not.toContainText(text);
    await expect(page.locator('[data-deck-column="inbox"] .attention-card-list')).toContainText('New Inbox conversation');
    console.log('RETAINED_INBOX_TIMING',JSON.stringify({localReadyMs:timing,domReadyMs,networkDelayMs:20000}));
  }finally{
    await page.evaluate(()=>window.s?.stopAllLiveQueries()).catch(()=>{});
    for(const release of releases.splice(0))await release();
  }
});
