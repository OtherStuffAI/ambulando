// Render Inbox templates and CSS with fixture data; optional served asset input.
import { chromium, webkit } from 'playwright';
import { JSDOM } from 'jsdom';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
const source = process.env.FLIGHTDECK_INBOX_SOURCE;
const servedBase = process.env.FLIGHTDECK_INBOX_SERVED_URL;
async function readServedAsset(url) {
 const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
 assert(response.ok, `Served asset is available: ${url}`);
 return response.text();
}
const html = servedBase ? await readServedAsset(servedBase) : await readFile(source ? path.join(source, 'index.html') : 'index.html', 'utf8');
const sourceCss = await readFile(source ? path.join(source, 'styles.css') : 'src/styles.css', 'utf8');
// Compile nesting/minification with the same Vite production CSS transform.
const { transformWithEsbuild } = await import('vite');
const css = servedBase ? (await Promise.all([...new JSDOM(html).window.document.querySelectorAll('link[rel="stylesheet"]')].map(async link => {
 return readServedAsset(new URL(link.getAttribute('href'), servedBase));
}))).join('\n') : (await transformWithEsbuild(sourceCss, 'styles.css', { loader: 'css', minify: true, target: ['chrome87', 'edge88', 'es2020', 'firefox78', 'safari14'] })).code;
const document = new JSDOM(html).window.document;
const find = (node, selector) => node && (node.querySelector(selector) || [...node.querySelectorAll('template')].map(t => find(t.content, selector)).find(Boolean));
const inbox = find(document, '[data-deck-column="inbox"] .attention-card-list').outerHTML
  + find(document, '.inbox-no-results').outerHTML;
const header = find(document, '.inbox-panel-heading').outerHTML;
const evidenceDir = path.resolve('tmp/docs/handoffs');
execFileSync('git', ['check-ignore', evidenceDir]);
assert.equal(execFileSync('git', ['ls-files', evidenceDir], { encoding: 'utf8' }).trim(), '', 'Evidence must be untracked');
const app = await readFile('src/app.js', 'utf8');
const iconMethod = app.match(/getAttentionIconSvg\(icon\) \{([\s\S]*?)\n    \},/)[1];
const guard = app.match(/shouldOpenDeckCard\(event\) \{([\s\S]*?)\n    \},/)[1];
const temporary = await mkdtemp(path.join(tmpdir(), 'fd-compact-'));
const fixture = [
 { inboxKind: 'task', id: 'task:1', recordId: '1', title: 'Restore Plant Item-first Plan Production modal', subtitle: 'Done', taskState: 'done', reason: 'Task updated' },
 { inboxKind: 'file', object_id: '2', sourceTypeLabel: 'Task attachment', source_label: 'Restore Plant Item-first Plan Production modal', name: 'production-plan.pdf', reason: 'Edited file', sourceActionLabel: 'Open task', sourceAriaLabel: 'Open attachment task' },
 { inboxKind: 'chat', id: '3', channelId: 'implementation', title: 'I can’t currently save a production plan after filling the form', latestMessage: 'I can’t currently save a production plan after filling the form', channelLabel: 'Implementation', messageCount: 2, isUnread: true },
 { inboxKind: 'chat', id: '4', channelId: 'features', title: 'Mobile inbox improvements', latestMessage: 'The new preview should keep the useful latest reply visible.', channelLabel: 'Features and feedback from the mobile team', messageCount: 128, isUnread: true },
 { inboxKind: 'task', id: 'task:5', recordId: '5', title: 'Review compact cards', subtitle: 'Review', taskState: 'review', reason: '3 recent comments', isUnread: true },
 { inboxKind: 'document', id: 'doc:6', recordId: '6', title: 'Implementation notes', reason: '2 recent comments', isUnread: true },
];
const entry = `import Alpine from '${process.cwd()}/node_modules/alpinejs/dist/module.esm.js';
import { autopilotOverviewManagerMixin as inboxMethods, filterAutopilotOverviewInbox } from '${process.cwd()}/src/autopilot-overview-manager.js';
window.calls=[];
Alpine.store('chat', {
 deckInboxType: 'all', deckInboxSearchDraft: '', deckInboxSearchQuery: '', unreadTasks: 1, unreadDocs: 1, unreadChat: 1, unreadDeck: 3,
 deckInboxTypes: inboxMethods.deckInboxTypes,
 isDeckInboxTypeVisible: inboxMethods.isDeckInboxTypeVisible,
 toggleDeckInboxType: inboxMethods.toggleDeckInboxType,
 startWorkspaceLiveQueries() {},
 setDeckInboxSearchDraft(value) { this.deckInboxSearchDraft=value; },
 applyDeckInboxSearch() { inboxMethods.applyDeckInboxSearch.call(this); window.calls.push(['search',this.deckInboxSearchDraft]); },
 openDeckThreadComposer() { window.calls.push(['new']); },
 runInboxReadAction(kinds,label) { window.calls.push(['bulk',kinds,label]); },
 rows: ${JSON.stringify(fixture)},
 get filteredAutopilotOverviewInbox() { return filterAutopilotOverviewInbox(this.rows, this.deckInboxSearchQuery, this.deckInboxType); },
 get visibleAutopilotOverviewInbox() { return this.filteredAutopilotOverviewInbox; },
 hasMoreAutopilotOverviewInbox: false,
 renderDeckCardText: text => String(text || '').replaceAll('<', '&lt;'),
 isLongTaskTitle: () => false, getTaskTitleLengthClass: () => '',
 getAttentionIconSvg(icon) {${iconMethod}},
 formatRelativeTime: () => '2m ago', resolveTaskBoardColumnColor: () => '#28785e',
 shouldOpenDeckCard(event) {${guard}},
 openAutopilotOverviewTask: item => window.calls.push(['task',item.recordId]),
 openAutopilotOverviewThread: item => window.calls.push(['chat',item.id,item.channelId]),
 openAutopilotOverviewDocument: item => window.calls.push(['document',item.recordId]),
 openFileBrowserSource: item => window.calls.push(['file',item.object_id]),
 markDeckResourceRead(kind,id) { window.calls.push(['read',kind,id]); this.visibleAutopilotOverviewInbox.find(i => i.id===id || i.recordId===id).isUnread=false; },
 markDeckReviewTaskDone(id) { window.calls.push(['done',id]); this.visibleAutopilotOverviewInbox.find(i => i.recordId===id).isUnread=false; },
}); window.probeStore=Alpine.store('chat'); Alpine.start();`;
await writeFile(path.join(temporary,'entry.js'),entry);
execFileSync('bun',['build',path.join(temporary,'entry.js'),'--target=browser','--define', '__FLIGHT_DECK_PG_APP_NPUB__="npub1inboxfixture"',`--outfile=${temporary}/probe.js`]);
const browser = await (process.env.FLIGHTDECK_VERIFY_BROWSER === 'webkit' ? webkit.launch({timeout:15000}) : chromium.launch({channel:'chrome'}));
const results=[];
try {
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/probe.js') return route.fulfill({contentType:'text/javascript',body:await readFile(path.join(temporary,'probe.js'))});
  if(url.pathname!=='/') return route.abort();
  return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{display:block}main{width:100%;margin:auto}[x-cloak]{display:none!important}</style></head><body x-data><main><div class="flightdeck-summary-overview flightdeck-summary-overview-deck"><div class="deck-columns-track" data-deck-ready><section class="flightdeck-summary-panel flightdeck-summary-panel-inbox deck-column" data-deck-column="inbox" style="height:700px;min-height:0">${header}<div class="deck-card-scroll" aria-label="Inbox cards" tabindex="0">${inbox}<div style="height:1200px;flex-shrink:0" aria-hidden="true"></div></div></section><div class="deck-right-stack"></div></div></div></main><script type="module" src="/probe.js"></script></body></html>`});
 });
 const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 for(const width of [320,375,390,430,1440]) {
  await page.setViewportSize({width,height:1000}); await page.goto('http://inbox-fixture.test/');
  const cards=page.locator('.attention-card'); await cards.nth(5).waitFor().catch(error => { console.error(errors); throw error; });
  const geometry=await cards.evaluateAll(cards=>cards.map(c=>({height:c.getBoundingClientRect().height,width:c.getBoundingClientRect().width,overflow:c.scrollWidth>c.clientWidth+1})));
  assert(geometry.every(c=>!c.overflow));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const screenshot=path.join(evidenceDir, `flightdeck-inbox-${servedBase?'served':source?'before':'after'}-${process.env.FLIGHTDECK_VERIFY_BROWSER || 'chrome'}-${width}.png`);
  await page.screenshot({path:screenshot,fullPage:true});
  const controls = page.locator('.inbox-panel-heading').locator('h3, .inbox-type-toggle, input, .inbox-search-submit, .deck-new-thread-button, .doc-actions-toggle');
  const toolbar = await controls.evaluateAll(nodes => nodes.map(n => { const r=n.getBoundingClientRect(); return {tag:n.tagName, x:r.x,y:r.y,width:r.width,height:r.height,center:r.y+r.height/2}; }));
  assert.equal(toolbar.length,9);
  const visibleToolbar = toolbar.filter(r=>r.width>0);
  assert(visibleToolbar.every(r=>r.x>=0 && r.x+r.width<=width), 'Every control fits viewport');
  assert(toolbar[5].width>=44, 'Collapsed Search remains accessible');
  if(width<768) {
    assert(visibleToolbar.slice(1).every(r=>r.height>=44 && r.width>=44));
    const box = selector => page.locator(selector).boundingBox();
    const title = await box('h3'), create = await box('.deck-new-thread-button'), menu = await box('.doc-actions-toggle');
    const search = await box('input'), submit = await box('.inbox-search-submit'), filters = await box('.inbox-type-toggles');
    assert(Math.abs(create.y-menu.y)<1 && menu.x-create.x-create.width<=9, 'Heading actions are grouped');
    assert(title.y < search.y && Math.abs(search.y-filters.y)<1, 'Compact Search shares the filters row');
    assert(search.width===44 && submit===null, 'Search collapses to one accessible icon');
    assert((await box('.inbox-panel-heading')).height<=120, 'Default toolbar is two rows');
  }
  const types = ['chats', 'tasks', 'documents', 'files'];
  for (const name of types) assert.equal(await page.getByRole('button',{name:`Show ${name}`,exact:true}).getAttribute('aria-pressed'), 'true');
  const fileToggle = page.getByRole('button',{name:'Show files',exact:true});
  await fileToggle.focus(); await page.keyboard.press('Space');
  assert.equal(await fileToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await fileToggle.evaluate(n=>getComputedStyle(n).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({path:screenshot.replace('.png','-hidden.png'),fullPage:true});
  assert.equal(await cards.count(),5);
  for (const name of types.slice(0,3)) await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();
  assert.equal(await cards.count(),0);
  await page.getByRole('status').filter({hasText:'All record types are hidden.'}).waitFor();
  for (const name of types) { const button=page.getByRole('button',{name:`Show ${name}`,exact:true}); await button.focus(); await page.keyboard.press('Enter'); }
  assert.equal(await cards.count(),6);
  await page.evaluate(() => { window.probeStore.deckInboxSearchDraft='production'; window.probeStore.applyDeckInboxSearch(); window.calls=[]; });
  assert.equal(await cards.count(),3);
  await fileToggle.click(); assert.equal(await cards.count(),2);
  assert.equal(await page.evaluate(()=>window.probeStore.deckInboxSearchQuery),'production');
  await fileToggle.click(); assert.equal(await cards.count(),3);
  await page.evaluate(() => { window.probeStore.deckInboxSearchDraft=''; window.probeStore.applyDeckInboxSearch(); window.calls=[]; });
  assert.equal(await cards.count(),6);
  const search=page.getByRole('searchbox',{name:'Search Inbox'});
  await search.fill('release');
  if(width<768) {
    const expanded=await search.boundingBox();
    assert(expanded.width>=200, 'Focused Search expands for typing and native clear');
    assert((await page.locator('.inbox-type-toggles').boundingBox()).y>expanded.y, 'Filters remain available below expanded Search');
  }
  await page.screenshot({path:screenshot.replace('.png','-search.png'),fullPage:true});
  await search.press('Enter');
  await search.blur();
  assert.equal(await search.inputValue(), 'release', 'Blur retains draft');
  assert.equal(await page.evaluate(()=>window.probeStore.deckInboxSearchQuery), 'release', 'Enter submits query');
  if(width<768) assert.equal((await search.boundingBox()).width,44,'Blur collapses Search');
  await search.focus();
  await page.getByRole('button',{name:'Search Inbox',exact:true}).click();
  await page.getByRole('button',{name:'New thread',exact:true}).click();
  const menu=page.getByRole('button',{name:'Inbox read actions'});
  await menu.focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem',{name:'Mark all tasks as read'}).waitFor();
  const popover=await page.getByRole('menu',{name:'Mark Inbox as read'}).boundingBox();
  assert(popover.x>=0 && popover.x+popover.width<=width);
  assert(await page.getByRole('menuitem',{name:'Mark all tasks as read'}).evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}), 'Menu is not clipped or covered');
  await page.screenshot({path:screenshot.replace('.png','-menu.png'),fullPage:true});
  await page.keyboard.press('Escape');
  assert.equal(await menu.getAttribute('aria-expanded'),'false');
  await menu.click(); await page.getByRole('menuitem',{name:'Mark all tasks as read'}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[['search','release'],['search','release'],['new'],['bulk',['task'],'tasks']]);
  await page.evaluate(()=>{ window.probeStore.deckInboxSearchDraft=''; window.probeStore.applyDeckInboxSearch(); window.calls=[]; });
  await cards.nth(5).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.attention-card').length === 6);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let sticky;
  if(width<768) {
    const heading=page.locator('.inbox-panel-heading');
    await page.locator('[data-deck-column="inbox"] .deck-card-scroll').evaluate(n=>n.scrollTop=250);
    const first=await heading.boundingBox();
    await page.locator('[data-deck-column="inbox"] .deck-card-scroll').evaluate(n=>n.scrollTop=350);
    const second=await heading.boundingBox();
    assert(Math.abs(first.y-second.y)<1,'Header stays sticky while cards scroll');
    sticky={firstY:first.y,secondY:second.y};
    await page.locator('[data-deck-column="inbox"] .deck-card-scroll').evaluate(n=>n.scrollTop=0);
  }
  results.push({width,geometry,toolbar,popover,sticky,screenshot});
  if(source) continue;
  if(width<768) {
   assert(geometry.every(c=>c.height<=100),'Ordinary items should fit three compact content lines');
   for(const button of await page.locator('.attention-card-mark-read:visible').all()) {const box=await button.boundingBox();assert(box.width>=44 && box.height>=44);}
  }
  await cards.nth(0).focus(); await page.keyboard.press('Enter');
  await cards.nth(1).focus(); await page.keyboard.press('Space');
  await cards.nth(2).focus(); await page.keyboard.press('Space');
  const read=cards.nth(2).getByRole('button',{name:'Mark read',exact:true}); await read.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!window.probeStore.visibleAutopilotOverviewInbox[2].isUnread);
  assert(!(await cards.nth(2).getAttribute('class')).includes('inbox-unread'));
  const review = cards.nth(4);
  assert.equal(await review.getByRole('button', {name:'Mark done',exact:true}).count(), 1);
  const reviewRead = review.getByRole('button', {name:'Mark read',exact:true});
  await reviewRead.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(()=>!window.probeStore.visibleAutopilotOverviewInbox[4].isUnread);
  assert.equal(await page.evaluate(()=>window.probeStore.visibleAutopilotOverviewInbox[4].taskState), 'review');
  assert(!(await review.getAttribute('class')).includes('inbox-unread'));
  await page.evaluate(()=>window.probeStore.visibleAutopilotOverviewInbox[4].isUnread=true);
  await review.getByRole('button',{name:'Mark done',exact:true}).focus();
  await page.keyboard.press('Enter');
  await cards.nth(5).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[['task','1'],['file','2'],['chat','3','implementation'],['read','thread','3'],['read','task','5'],['done','5'],['document','6']]);
 }
 assert.deepEqual(errors,[]); console.log(JSON.stringify({browser:browser.version(),results,errors},null,2));
} finally {await browser.close();await rm(temporary,{recursive:true,force:true});}
