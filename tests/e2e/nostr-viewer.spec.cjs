const { test, expect } = require('playwright/test');
const { generateSecretKey, getPublicKey, nip19, finalizeEvent, verifyEvent } = require('nostr-tools');
const { createHash } = require('node:crypto');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Simulated Tower HTTP transport with real NIP-98 signing, two independent browser
// contexts, production TowerSyncService, materialization worker, Dexie and liveQuery.
// Backend authorization/privacy is separately tested against real Postgres/API.
test('private viewer converges across browsers, reload, reconnect, conflict and reset', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const secret=generateSecretKey(),pubkey=getPublicKey(secret),fixture=buildGroupsAccessFixture();
  fixture.viewer.npub=nip19.npubEncode(pubkey);
  const server=new Map(),receipts=new Map(),offline=new Set(),writes=[];
  const contexts=await Promise.all([browser.newContext({baseURL}),browser.newContext({baseURL})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  for(const page of pages){
    await page.exposeFunction('signViewerEvent',event=>finalizeEvent(event,secret));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname.includes('/me/preferences/')){
        if(offline.has(page))return route.abort();
        const event=JSON.parse(Buffer.from(request.headers().authorization.slice(6),'base64').toString());
        if (!verifyEvent(event)) return route.fulfill({status:401,json:{error:'fixture_signer_not_ready'}});expect(event.tags).toContainEqual(['u',request.url()]);expect(event.tags).toContainEqual(['method',request.method()]);
        const workspace=url.pathname.split('/')[5],key=decodeURIComponent(url.pathname.split('/').at(-1)),partition=`${workspace}:${event.pubkey}:${key}`;
        let row=server.get(partition)||null;
        if(request.method()==='PUT'){
          const body=request.postDataJSON();writes.push(body);
          expect(event.tags).toContainEqual(['payload',createHash('sha256').update(request.postData()).digest('hex')]);
          const receiptKey=`${partition}:${body.mutation_id}`;
          if(receipts.has(receiptKey))return route.fulfill({json:receipts.get(receiptKey)});
          if(!(body.import_only&&row)){
            if(body.expected_row_version!==(row?.row_version||0))return route.fulfill({status:409,json:{error:'preference_conflict',code:'preference_conflict'}});
            row={id:'viewer-setting',workspace_id:workspace,actor_id:fixture.viewer.actor_id,preference_key:key,value:body.value,row_version:(row?.row_version||0)+1};server.set(partition,row);
          }
          receipts.set(receiptKey,{identity:{workspace_id:workspace},preference:row});
        }
        return route.fulfill({json:{identity:{workspace_id:workspace},preference:row}});
      }
      return serveBuiltFlightDeck(route);
    });
  }
  async function boot(page){
    await page.waitForFunction(() => window.Alpine?.store('chat'));
    await page.evaluate(() => { Alpine.store('chat').routeSyncPaused = false; Alpine.store('chat').runTowerPgWorkspaceSync = async () => ({}); });
    await seedGroupsAccess(page,fixture);
    await page.evaluate(async ({pubkey})=>{
      localStorage.setItem('nostr_secure_auth_recovery_v1',JSON.stringify({method:'extension',pubkey,createdAt:Date.now(),expiresAt:Date.now()+600000}));
      window.nostr={getPublicKey:async()=>pubkey,signEvent:event=>window.signViewerEvent(event)};
      const s=Alpine.store('chat');s.settingsTab='deck';await s.activateNostrViewer();await s.getTowerSyncService().ensureLoaded('private-preferences');
      window.__viewerOpened=[];window.open=(...args)=>window.__viewerOpened.push(args);
    },{pubkey});
    await expect(page.getByRole('status').filter({hasText:'Synchronized with your workspace'})).toBeVisible();
  }
  const refresh=page=>page.evaluate(()=>Alpine.store('chat').getTowerSyncService().ensureLoaded('private-preferences'));
  const value=page=>page.evaluate(()=>Alpine.store('chat').nostrViewerBaseUrl);
  async function save(page,url){await page.locator('#nostr-viewer-base-url').fill(url);await page.getByRole('button',{name:'Save Nostr viewer',exact:true}).click();}
  try {
    await Promise.all(pages.map(p=>p.goto('/',{waitUntil:'domcontentloaded'})));for(const p of pages)await boot(p);
    const [one,two]=pages;
    await save(one,'https://canopy.winn.cloud/event///');await expect.poll(()=>value(one)).toBe('https://canopy.winn.cloud/event/');
    await expect.poll(()=>server.values().next().value?.value).toBe('https://canopy.winn.cloud/event/');
    // Explicit refresh emulates the private SSE/fallback family trigger.
    await refresh(two);await expect.poll(()=>value(two)).toBe('https://canopy.winn.cloud/event/');
    const id=nip19.neventEncode({id:'cd'.repeat(32),author:'ab'.repeat(32),kind:1});
    await two.evaluate(id=>{const s=Alpine.store('chat');s.openFeedItem({url:`https://njump.me/${id}`});s.openFeedItem({url:'https://example.com/article'});},id);
    expect(await two.evaluate(()=>window.__viewerOpened)).toEqual([[`https://canopy.winn.cloud/event/${id}`,'_blank','noopener,noreferrer'],['https://example.com/article','_blank','noopener,noreferrer']]);
    await save(two,'javascript:alert(1)');await expect(two.locator('#nostr-viewer-error')).toBeVisible();expect(await value(two)).toBe('https://canopy.winn.cloud/event/');
    await two.reload({waitUntil:'domcontentloaded'});await boot(two);expect(await value(two)).toBe('https://canopy.winn.cloud/event/');
    offline.add(two);await save(two,'https://offline.example/event/');await expect.poll(()=>value(two)).toBe('https://offline.example/event/');
    offline.delete(two);await refresh(two);await refresh(one);await expect.poll(()=>value(one)).toBe('https://offline.example/event/');
    // Both read the same revision, then a stale offline edit races the winner.
    offline.add(two);await save(two,'https://stale.example/');
    await save(one,'https://winner.example/');await expect.poll(()=>server.values().next().value?.value).toBe('https://winner.example/');
    offline.delete(two);await refresh(two);await expect.poll(()=>value(two)).toBe('https://winner.example/');
    await two.getByRole('button',{name:'Reset to njump',exact:true}).click();await expect.poll(()=>server.values().next().value?.value).toBe('https://njump.me/');await refresh(one);await expect.poll(()=>value(one)).toBe('https://njump.me/');
    await save(one,'');await expect.poll(()=>value(one)).toBe('https://njump.me/');
    expect(writes.some(w=>w.expected_row_version>1)).toBe(true);
    await one.evaluate(async()=>{const s=Alpine.store('chat');s.session={npub:'another-reader'};await s.activateNostrViewer();});
    expect(await value(one)).toBe('https://njump.me/');
  } finally {await Promise.all(contexts.map(c=>c.close()));}
});
