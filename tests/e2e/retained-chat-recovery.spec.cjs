const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');

// Real IndexedDB, Alpine and production local navigation/detail subscriptions.
// The synthetic Tower delays updates; it never supplies cached presentation.
test('cached chats hydrate before delayed updates and stay live through reload, reconnect and repair', async ({ page, baseURL }) => {
  page.on('pageerror', error => console.log('HARNESS_ERROR', error.message));
  const root = path.resolve(__dirname, '../..');
  const bundle = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', loader: { '.html': 'text' },
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': JSON.stringify({ VITE_FLIGHT_DECK_BACKEND_MODE: 'tower-pg' }) },
    stdin: { resolveDir: root, contents: `
      import Alpine from 'alpinejs'; import {liveQuery} from 'dexie';
      import {openWorkspaceDb,getChannelsByOwner,getScopesByOwner} from './src/db.js';
      import {applyPgRecordChanges,resetPgRecordAuthority,recordDeltaCursorKey} from './src/pg-record-delta.js';
      import {sectionLiveQueryMixin,readPgNavigationProjection,applyPgNavigationProjection} from './src/section-live-queries.js';
      import {channelsManagerMixin} from './src/channels-manager.js';
      import {createShellState} from './src/shell-state.js';
      window.probe={Alpine,liveQuery,openWorkspaceDb,getChannelsByOwner,getScopesByOwner,applyPgRecordChanges,resetPgRecordAuthority,recordDeltaCursorKey,sectionLiveQueryMixin,readPgNavigationProjection,applyPgNavigationProjection,channelsManagerMixin,createShellState};
    ` } });
  const origin = new URL(baseURL).origin;
  let release, requested = false, denied = false, response;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (url.pathname === '/api/updates') {
      requested = true;
      await new Promise(resolve => { release = resolve; });
      return route.fulfill(denied ? { status: 403, json: { error: 'denied' } } : { json: response });
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="module" src="/harness.js"></script><main x-data><div data-chat-feed><template x-for="row in $store.cache.messages" :key="row.record_id"><p x-text="row.body"></p></template></div><textarea x-model="$store.cache.messageInput"></textarea></main>` });
  });
  const setup = async () => {
    await page.goto(`${origin}/fixture`); await page.waitForFunction(() => window.probe);
    await page.evaluate(async fixture => {
      const m=window.probe, key='retained-chat-browser', db=m.openWorkspaceDb(key); await db.open();
      const shell=m.createShellState();
      const store=m.Alpine.reactive({ ...m.sectionLiveQueryMixin,
        workspaceOwnerNpub:'owner', currentWorkspaceKey:key, workspaceDbKey:key, _workspaceSelectionGeneration:1,
        currentWorkspace:{workspaceId:fixture.one_message_delta.changes[0].workspace_id,workspaceOwnerNpub:'owner',pgBackendMode:true},
        session:{npub:'reader'}, backendUrl:location.origin, navSection:'chat', selectedBoardId:'all',
        selectedChannelId:null, activeThreadId:null, messages:[], channels:[], scopes:[], messageInput:'unsent',threadInput:'reply',
        MAIN_FEED_PAGE_SIZE:80, mainFeedVisibleCount:80, THREAD_REPLY_PAGE_SIZE:6, threadVisibleReplyCount:6,
        async applyMessages(rows,options={}) { if(!options.isCurrent || options.isCurrent()) this.messages=rows; },
        async applyScopes(rows){this.scopes=rows;}, async applyChannels(rows){this.channels=rows;},
        createLiveSubscription(query,onNext){return m.liveQuery(query).subscribe({next:rows=>Promise.resolve(onNext(rows)).catch(e=>window.probeError=String(e)),error:e=>window.probeError=String(e)});},
        stopLiveSubscription(sub){sub.unsubscribe();}, startSharedLiveQueries(){}, validateSelectedBoardId(){},
        applyAudioNotes(){},applyReactions(){},scheduleChatFeedScrollToBottom(){},
        closeThread(){this.activeThreadId=null;}, ensureBackgroundSync(){}, ensureChatMentionRoster(){},
        async loadLocalWorkspaceCoreData(){this.scopes=await m.getScopesByOwner('owner');this.channels=await m.getChannelsByOwner('owner');},
        readStoredTaskBoardId(){return 'all';},readStoredCollapsedSections(){return {};},refreshSyncStatus(){},
        async applyRouteFromLocation(){await this.selectChannel(fixture.one_message_delta.changes[0].channel_id,{syncRoute:false,scrollToLatest:false});},
        async requestTowerSyncFamily(family){if(family!=='channel-messages')return {};const r=await fetch('/api/updates'); if(!r.ok){window.readDenied=true;throw Error('denied');}return r.json();},
        // Exercise the real shell bootstrap without an unrelated descriptor read.
        bootstrapSelectedWorkspace:shell.bootstrapSelectedWorkspace, ensureWorkspaceSessionKey(){},
        selectedWorkspaceKey:key, currentWorkspaceOwnerNpub:'owner',
      });
      for(const name of ['selectChannel','loadChannelMessagesForSelection','getChatPresentationKey','saveCurrentChatPresentation','applyChatPresentation']) store[name]=m.channelsManagerMixin[name];
      window.Alpine=m.Alpine; m.Alpine.store('cache',store);m.Alpine.start();window.db=db;window.store=store;
      if(!await db.chat_messages.count()) await m.applyPgRecordChanges(store,fixture.canonical_upserts,{expectedCursor:null});
      const projection=await m.readPgNavigationProjection(store);await m.applyPgNavigationProjection(store,projection);
      window.started=performance.now();await store.bootstrapSelectedWorkspace();window.localReady=performance.now()-window.started;
      window.repair=async()=>{await m.resetPgRecordAuthority(store,{preserveViews:true});await m.applyPgNavigationProjection(store,await m.readPgNavigationProjection(store));store.startWorkspaceLiveQueries();};
      window.merge=async page=>m.applyPgRecordChanges(store,page,{expectedCursor:(await db.sync_state.get(m.recordDeltaCursorKey(store)))?.value?.cursor||null});
      window.reconnect=()=>{store.stopWorkspaceLiveQueries();store.startWorkspaceLiveQueries();};
    }, fixture);
  };
  response = { ok: true };
  await setup();
  await expect.poll(() => requested).toBe(true);
  const cached = fixture.canonical_upserts.changes.find(row => row.family === 'message');
  await expect(page.locator('[data-chat-feed]')).toContainText(cached.row.body);
  const domReadyMs=await page.evaluate(()=>performance.now()-window.started);
  expect(await page.evaluate(() => window.localReady)).toBeLessThan(1000);
  const before = await page.evaluate(() => window.db.chat_messages.count());
  await page.evaluate(() => window.repair());
  await page.evaluate(() => window.reconnect());
  await expect(page.locator('[data-chat-feed]')).toContainText(cached.row.body);
  // Match the reported 20-second delay, sampling throughout instead of only after convergence.
  for(let i=0;i<20;i++) { await expect(page.locator('[data-chat-feed]')).toContainText(cached.row.body); await page.waitForTimeout(1000); }
  expect(await page.evaluate(() => window.db.chat_messages.count())).toBe(before);
  release();
  await page.evaluate(() => window.store.stopWorkspaceLiveQueries());
  requested=false; await setup();
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('[data-chat-feed]')).toContainText(cached.row.body);
  const remote={...cached,id:'50000000-0000-4000-8000-000000000099',version:'16',row:{...cached.row,id:'50000000-0000-4000-8000-000000000099',body:'New remote conversation',client_request_id:'new-chat-command',row_version:2}};
  await page.evaluate(async ({fixture,remote}) => {
    await window.merge({...fixture.one_message_delta,changes:[remote],next_cursor:'remote-merged'});
  },{fixture,remote});
  await expect(page.locator('[data-chat-feed]')).toContainText('New remote conversation');
  await expect(page.locator('[data-chat-feed]')).toContainText(cached.row.body);
  await page.evaluate(async ({fixture,cached})=>{
    await window.merge({...fixture.one_message_delta,changes:[{...cached,operation:'delete',version:'17',row:null}],next_cursor:'deleted'});
  },{fixture,cached});
  await expect(page.locator('[data-chat-feed]')).not.toContainText(cached.row.body);
  await expect(page.locator('[data-chat-feed]')).toContainText('New remote conversation');
  denied=true; release();
  await page.waitForFunction(()=>window.readDenied===true);
  await expect.poll(()=>page.evaluate(()=>window.store.messages.length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>window.store.messageInput)).toBe('unsent');
  expect(await page.evaluate(()=>window.probeError||null)).toBeNull();
  console.log('RETAINED_CHAT_TIMING',JSON.stringify({localReadyMs:await page.evaluate(()=>window.localReady),domReadyMs,networkDelayMs:20000}));
});
