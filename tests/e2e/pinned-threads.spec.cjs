const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers:'block', reducedMotion:'reduce' });
let bundle;
test.beforeAll(async () => {
  bundle = (await build({ bundle:true, write:false, format:'esm', logLevel:'silent',
    define:{__FLIGHT_DECK_PG_APP_NPUB__:JSON.stringify('npub1test')},
    stdin:{resolveDir:path.resolve(__dirname,'../..'), contents:`export { openWorkspaceDb, upsertMessage } from './src/db.js'; export { pinnedThreadsMixin } from './src/pinned-threads.js';`} })).outputFiles[0].text;
});
async function setup(page) {
  await page.route('**/*', route => new URL(route.request().url()).pathname === '/__pins.js'
    ? route.fulfill({contentType:'text/javascript',body:bundle}) : serveBuiltFlightDeck(route));
  await openFixture(page,true);
  await page.evaluate(async () => {
    try {
    const m=await import('/__pins.js');
    const db=m.openWorkspaceDb('pinned-browser'); await db.open();
    window.pinProbeDb=db;
    const s=window.Alpine.store('chat');
    s.closeThread({syncRoute:false});
    s.selectedWorkspaceKey='pinned-browser';
    const descriptors=Object.getOwnPropertyDescriptors(m.pinnedThreadsMixin);
    Object.defineProperties(s,descriptors);
    s.isTowerPgMode=true;
    s.fileMessages=[
      {record_id:'source-a',pg_thread_id:'thread-a',parent_message_id:null,channel_id:'sol-channel',title:'Return to this conversation',body:'First conversation',record_state:'active',updated_at:'2026-10-10T01:00:00Z'},
      {record_id:'source-b',pg_thread_id:'thread-b',parent_message_id:null,channel_id:'other-channel',title:'Conversation in another scope',body:'Second conversation',record_state:'active',updated_at:'2026-10-09T01:00:00Z'},
    ];
    s.channels=[...s.channels,{record_id:'other-channel',title:'Another scope channel',scope_id:'other-scope',record_state:'active'}];
    await db.channels.bulkPut(JSON.parse(JSON.stringify(s.channels)));
    for (const source of s.fileMessages) {
      await m.upsertMessage(source);
      await m.upsertMessage({...source,record_id:source.pg_thread_id,pg_record_type:'thread',pg_source_message_id:source.record_id});
    }
    s.openDeckThread=async (channel,id,options) => {window.pinOpened={channel,id,options};return true;};
    s.pgContextSelectedChannelId='all'; s.selectedBoardId='__all__';
    s.deckInboxEnabled=true; s.navSection='status';
    s.syncPinnedThreadsContext(s.pinnedThreadsPartition);
    } catch(error) { throw new Error(JSON.stringify({name:error.name,message:error.message,stack:error.stack})); }
  });
  await expect(page.locator('[data-deck-column="inbox"] .flightdeck-summary-card-chat')).toHaveCount(2,{timeout:3000});
}
async function screenshot(page,name) {
  if(!process.env.SOL_EVIDENCE_DIR) return;
  execFileSync('git',['check-ignore',process.env.SOL_EVIDENCE_DIR]);
  expect(execFileSync('git',['ls-files',process.env.SOL_EVIDENCE_DIR],{encoding:'utf8'}).trim()).toBe('');
  await fs.mkdir(process.env.SOL_EVIDENCE_DIR,{recursive:true});
  await page.screenshot({path:`${process.env.SOL_EVIDENCE_DIR}/${name}.png`,animations:'disabled'});
}
for(const width of [375,1440]) for(const theme of ['light','dark']) test(`personal pins, persistence and Deck controls at ${width}px ${theme}`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await setup(page);
  await page.evaluate(theme=>window.Alpine.store('appearance').setTheme(theme),theme);
  const inbox=page.locator('[data-deck-column="inbox"]');
  const pins=page.locator('[data-deck-column="pinned"]');
  const inboxOrder=await inbox.locator('.attention-card-title').allTextContents();
  await expect(pins).toContainText('Pin threads from Inbox');
  const button=inbox.locator('.flightdeck-summary-card-chat').filter({hasText:'Return to this conversation'}).locator('.thread-pin-button');
  await button.focus(); await button.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed','true');
  await expect(pins.locator('.pinned-thread-row')).toHaveCount(1);
  expect(await page.evaluate(()=>Boolean(window.Alpine.store('chat').activeThreadId))).toBe(false);
  await page.getByRole('button',{name:'Pin Conversation in another scope',exact:true}).click();
  await expect(pins.locator('.pinned-thread-row')).toHaveCount(2);
  expect(await inbox.locator('.attention-card-title').allTextContents()).toEqual(inboxOrder);
  if(width<769) {
    await page.getByRole('button',{name:'Show Pinned threads',exact:true}).click();
    await expect(page.getByRole('button',{name:'Show Pinned threads',exact:true})).toHaveAttribute('aria-current','page');
    await expect.poll(()=>pins.evaluate(el=>Math.abs(el.getBoundingClientRect().left-document.querySelector('[data-deck-columns-track]').getBoundingClientRect().left)<2)).toBe(true);
  } else {
    const p=await pins.boundingBox(), f=await page.locator('[data-deck-column="wapp-updates"]').boundingBox();
    expect(p.y+p.height).toBeLessThanOrEqual(f.y); expect(p.x).toBe(f.x);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const targets=await pins.locator('button').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
  targets.forEach(r=>{expect(r.width).toBeGreaterThanOrEqual(44);expect(r.height).toBeGreaterThanOrEqual(44);});
  await page.evaluate(async()=>{
    const s=window.Alpine.store('chat'); s.selectedBoardId='unrelated-scope'; s.fileMessages=[];
    await window.pinProbeDb.chat_messages.update('thread-b',{title:'Renamed across scopes',updated_at:'2026-10-14T08:00:00Z'});
    await window.pinProbeDb.pg_resource_attention.put({record_id:'thread:thread-b',unread:1});
  });
  await expect(pins).toContainText('Renamed across scopes');
  await expect(pins.locator('.pinned-thread-row').first()).toHaveClass(/inbox-unread/);
  expect(await pins.locator('.pinned-thread-row').first().evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await pins.getByRole('button',{name:/Renamed across scopes/}).first().click();
  expect(await page.evaluate(()=>window.pinOpened)).toMatchObject({channel:'other-channel',id:'source-b',options:{towerThreadId:'thread-b'}});
  await page.evaluate(async()=>window.pinProbeDb.pg_resource_attention.update('thread:thread-b',{unread:0}));
  await expect(pins.locator('.pinned-thread-row').first()).not.toHaveClass(/inbox-unread/);
  await screenshot(page,`pinned-${width}-${theme}`);
  await page.reload();
  // Reinstall the fixture without clearing browser IndexedDB; persistence is real.
  await setup(page);
  await expect(pins.locator('.pinned-thread-row')).toHaveCount(2);
  if(width<769) await page.getByRole('button',{name:'Show Pinned threads',exact:true}).click();
  await page.evaluate(async()=>window.pinProbeDb.channels.update('other-channel',{record_state:'deleted'}));
  await expect(pins).toContainText('Thread unavailable');
  await expect(pins.getByRole('button',{name:'Thread unavailable',exact:true})).toBeDisabled();
  await pins.getByRole('button',{name:'Unpin Thread unavailable',exact:true}).click();
  await expect(pins.locator('.pinned-thread-row')).toHaveCount(1);
  await pins.getByRole('button',{name:'Unpin Return to this conversation',exact:true}).press('Space');
  await expect(pins.locator('.pinned-thread-row')).toHaveCount(0);
  await expect(pins).toContainText('Pin threads from Inbox');
  if(width<769) {
    await page.getByRole('button',{name:'Show Feed',exact:true}).click();
    await expect.poll(()=>page.locator('[data-deck-column="wapp-updates"]').evaluate(el=>Math.abs(el.getBoundingClientRect().left-document.querySelector('[data-deck-columns-track]').getBoundingClientRect().left)<2)).toBe(true);
    await page.getByRole('button',{name:'Show Inbox',exact:true}).click();
  }
  console.log('PINNED_THREADS_EVIDENCE',JSON.stringify({width,theme,localIndexedDBReload:true,unreadUpdates:true,crossScopeRouting:true,inboxOrderPreserved:true,unavailableUnpin:true}));
});
