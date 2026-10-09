const {test,expect}=require('playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {JSDOM}=require('jsdom');
const {openFixture}=require('./fixtures/mobile-chat.cjs');
const {serveBuiltFlightDeck}=require('./fixtures/serve-built-flightdeck.cjs');
test.use({serviceWorkers:'block',reducedMotion:'reduce'});
test.setTimeout(15000);
const comparison=process.env.SOL_DENSITY_COMPARISON;
for(const width of [320,375,390,430,900,1440])for(const theme of ['light','dark'])test(`Inbox working density ${width} ${theme}`,async({page})=>{
 await page.setViewportSize({width,height:744});
 if(comparison==='classic'){
  const built=new JSDOM(await fs.readFile(path.join(process.env.FLIGHTDECK_TEST_DIST||'dist','index.html'),'utf8')).window.document;
  const old=new JSDOM(await fs.readFile(path.join(process.env.SOL_CLASSIC_DIR,'index.html'),'utf8')).window.document;
  const find=(n,sel)=>n.querySelector(sel)||[...n.querySelectorAll('template')].map(t=>find(t.content,sel)).find(Boolean);
  find(built,'.flightdeck-summary-panel-inbox').outerHTML=find(old,'.flightdeck-summary-panel-inbox').outerHTML;
  built.querySelectorAll('link[rel="stylesheet"]').forEach(n=>n.remove());
  const style=built.createElement('style');style.textContent=await fs.readFile(path.join(process.env.SOL_CLASSIC_DIR,'styles.css'),'utf8');built.head.append(style);
  await page.route('**/*',route=>new URL(route.request().url()).pathname==='/'?route.fulfill({contentType:'text/html',body:built.documentElement.outerHTML}):serveBuiltFlightDeck(route));
 }
 await openFixture(page,comparison==='classic');
 await page.evaluate(({width,theme})=>{
  const s=Alpine.store('chat');Alpine.store('appearance').setTheme(theme);
  s.closeThread({syncRoute:false});s.navigateTo('status',{syncRoute:false});s.deckInboxEnabled=true;s.pgNavigationRecoveryPending=false;s.navCollapsed=width<769;
  s.scopes=[{record_id:'density-scope',title:'Sovereign teams',record_state:'active'}];s.selectedBoardId='density-scope';s.isTowerPgMode=true;s.pgBackendMode=true;
  s.channels=s.channels.map(c=>({...c,pg_scope_id:'density-scope',scope_id:'density-scope'}));
  const items=Array.from({length:12},(_,i)=>({id:`inbox-${i}`,recordId:`inbox-${i}`,inboxKind:i%2?'task':'chat',title:i%2?'Investigate phone layout and draft persistence with keyboard open':'Review mobile sizing and useful reading space in the conversation',subtitle:'Review',reason:'Ready for review · Preserve readable previews',latestMessage:'Keep useful space to work and scroll through messages.',messageCount:4,channelId:'sol-channel',channelLabel:'Implementation',isUnread:true,taskState:i%2?'review':null,inboxActivityAt:new Date().toISOString()}));
  Object.defineProperty(s,'visibleAutopilotOverviewInbox',{get:()=>items});
  Object.defineProperty(s,'filteredAutopilotOverviewInbox',{get:()=>items});
  s.markDeckResourceRead=(family,id)=>window.inboxRead={family,id};s.markDeckReviewTaskDone=id=>window.inboxDone=id;
  s.openAutopilotOverviewThread=item=>window.inboxOpened=item.id;
 },{width,theme});
 const cards=page.locator('[data-deck-column="inbox"] .attention-card');await expect(cards).toHaveCount(12);
 const metrics=await page.evaluate(()=>{
  const r=sel=>{const b=document.querySelector(sel).getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height};};
  const scroll=document.querySelector('[data-deck-column="inbox"] .deck-card-scroll').getBoundingClientRect();
  return {header:r('.page-header'),scope:r('.mobile-scope-switcher'),channel:r('.global-pg-channel-bar'),toolbar:r('.inbox-panel-heading'),reading:scroll.height,card:r('[data-deck-column="inbox"] .attention-card'),fullRows:[...document.querySelectorAll('[data-deck-column="inbox"] .attention-card')].filter(n=>{const b=n.getBoundingClientRect();return b.top>=scroll.top&&b.bottom<=scroll.bottom;}).length,overflow:document.documentElement.scrollWidth>innerWidth};
 });console.log('INBOX_DENSITY',JSON.stringify({width,theme,...metrics}));
 if(process.env.SOL_EVIDENCE_DIR){const dir=process.env.SOL_EVIDENCE_DIR;execFileSync('git',['check-ignore',dir]);expect(execFileSync('git',['ls-files',dir],{encoding:'utf8'}).trim()).toBe('');await fs.mkdir(dir,{recursive:true});await page.screenshot({path:path.join(dir,`${width}-${theme}-inbox.png`),animations:'disabled'});await fs.writeFile(path.join(dir,`${width}-${theme}-inbox.json`),JSON.stringify(metrics,null,2));}
 if(comparison)return;
 expect(metrics.overflow).toBe(false);
 if(width<769){expect(metrics.card.height).toBeLessThanOrEqual(84);expect(metrics.fullRows).toBeGreaterThanOrEqual(4);expect(metrics.toolbar.height).toBeLessThanOrEqual(width>360?64:110);
  for(const button of await page.locator('.inbox-panel-heading button:visible').all()){const b=await button.boundingBox();expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);expect(b.x).toBeGreaterThanOrEqual(0);expect(b.x+b.width).toBeLessThanOrEqual(width);}
  const actions=cards.nth(1).locator('.attention-card-mark-read');for(const action of await actions.all()){const b=await action.boundingBox();expect(b.width).toBe(44);expect(b.height).toBe(44);expect(await action.evaluate(n=>getComputedStyle(n,'::before').width)).toBe('24px');}
  const search=page.locator('#deck-inbox-search');
  if(width>360)expect(await search.evaluate(n=>getComputedStyle(n).backgroundImage)).not.toBe('none');
  await search.focus();await expect(search).toBeFocused();expect((await search.boundingBox()).width).toBeGreaterThan(width*.6);
  await search.fill('working draft');await search.press('Enter');await search.blur();
  await cards.nth(1).getByRole('button',{name:'Mark done',exact:true}).click();expect(await page.evaluate(()=>window.inboxDone)).toBe('inbox-1');
  await cards.nth(1).getByRole('button',{name:'Mark read',exact:true}).click();expect(await page.evaluate(()=>window.inboxRead)).toEqual({family:'task',id:'inbox-1'});
  await cards.first().focus();await page.keyboard.press('Enter');expect(await page.evaluate(()=>window.inboxOpened)).toBe('inbox-0');
  const before=await cards.first().boundingBox();await page.locator('[data-deck-column="inbox"] .deck-card-scroll').evaluate(n=>n.scrollTop=80);expect((await cards.first().boundingBox()).y).toBeLessThan(before.y);
 }
});
