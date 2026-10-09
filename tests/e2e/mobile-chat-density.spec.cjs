const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers:'block', reducedMotion:'reduce' });
test.setTimeout(45000);
const draft = "against the mobile rendering of flight deck which is way cleaner there’s a lot that is the wrong size (too big) too much space, not enough space to work with things or scroll through messages";
const comparison = process.env.SOL_DENSITY_COMPARISON;
async function prepare(page, width, theme, height, offsetTop) {
  await page.setViewportSize({width,height:844});
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, {height:844,width:innerWidth,offsetTop:0,scale:1});
    Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
    window.mockViewport = (height, offsetTop=0, scale=1) => {
      Object.assign(viewport,{height,offsetTop,scale});
      viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
    };
  });
  if (comparison === 'classic') {
    const dist=process.env.FLIGHTDECK_TEST_DIST || 'dist';
    const classic=process.env.SOL_CLASSIC_DIR;
    const built = new JSDOM(await fs.readFile(path.join(dist,'index.html'),'utf8')).window.document;
    const old = new JSDOM(await fs.readFile(path.join(classic,'index.html'),'utf8')).window.document;
    const find=(n,sel)=>n.querySelector(sel)||[...n.querySelectorAll('template')].map(t=>find(t.content,sel)).find(Boolean);
    find(built,'.chat-thread-modal-backdrop').outerHTML=find(old,'.chat-thread-modal-backdrop').outerHTML;
    built.querySelectorAll('link[rel="stylesheet"]').forEach(n=>n.remove());
    const style=built.createElement('style'); style.textContent=await fs.readFile(path.join(classic,'styles.css'),'utf8'); built.head.append(style);
    await page.route('**/*',route => new URL(route.request().url()).pathname==='/' ? route.fulfill({contentType:'text/html',body:built.documentElement.outerHTML}) : serveBuiltFlightDeck(route));
  }
  await openFixture(page, comparison==='classic');
  await page.evaluate(({theme,draft})=>{
    const s=Alpine.store('chat'); Alpine.store('appearance').setTheme(theme);
    const parent=s.messages[0]; parent.title='we do need to review mobile sizing and layout this long conversation title';
    s.messages=[parent,...Array.from({length:24},(_,i)=>({...s.messages[1],record_id:`density-${i}`,body:`Message ${i}: Keep useful working space for reading and scrolling. A real conversation has several paragraphs and replies.`,created_at:new Date(Date.UTC(2026,9,9,1,i)).toISOString()}))];
    s.threadVisibleReplyCount=100;
    s.navSection='status';
    Object.defineProperty(s,'deckThreadNavigationRows',{get:()=>[{rootRecordId:'sol-thread'},{rootRecordId:'older-thread'}]});
    s.threadInput=draft;
  },{theme,draft});
  const editor=page.locator('[data-chat-composer="thread"]');
  await expect(editor).toHaveText(draft);
  await editor.focus();
  if(comparison==='classic') await page.setViewportSize({width,height});
  else await page.evaluate(({height,offsetTop})=>window.mockViewport(height,offsetTop),{height,offsetTop});
  await page.waitForTimeout(100);
  return editor;
}
async function geometry(page) {
  return page.evaluate(()=>{
    const rect=sel=>{const n=document.querySelector(sel),r=n.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight};};
    return {panel:rect('.chat-thread-panel'),header:rect('.chat-thread-panel .thread-header'),history:rect('.thread-replies'),composer:rect('.thread-input-bar'),editor:rect('[data-chat-composer="thread"]'),rootOverflow:document.documentElement.scrollWidth>innerWidth};
  });
}
async function evidence(page,name,data) {
  const dir=process.env.SOL_EVIDENCE_DIR; if(!dir)return;
  execFileSync('git',['check-ignore',dir]); expect(execFileSync('git',['ls-files',dir],{encoding:'utf8'}).trim()).toBe('');
  await fs.mkdir(dir,{recursive:true});
  const clip=await page.evaluate(()=>{const r=document.querySelector('.chat-thread-panel').getBoundingClientRect();return {x:0,y:Math.max(0,r.top-8),width:innerWidth,height:Math.ceil(r.height+16)};});
  await page.screenshot({path:path.join(dir,name+'.png'),clip,animations:'disabled'});
  await fs.writeFile(path.join(dir,name+'.json'),JSON.stringify(data,null,2));
}
for(const width of [320,375,390,430]) for(const theme of ['light','dark']) {
 test(`long draft reading space ${width} ${theme}`,async({page})=>{
  const editor=await prepare(page,width,theme,360,0);
  for(const height of [400,360,320]) {
    const offsetTop=height===320?37:0;
    if(comparison==='classic')await page.setViewportSize({width,height});
    else await page.evaluate(({height,offsetTop})=>window.mockViewport(height,offsetTop),{height,offsetTop});
    if(!comparison) await page.waitForFunction(({height,offsetTop})=>{
      const r=document.querySelector('.chat-thread-panel').getBoundingClientRect();
      return Math.abs(r.top-offsetTop-8)<1 && Math.abs(r.height-height+16)<1;
    },{height,offsetTop});
    else await page.waitForTimeout(250);
    await page.locator('.thread-replies').evaluate(n=>n.scrollTop=0);
    const g=await geometry(page);console.log('DENSITY',JSON.stringify({width,theme,height,offsetTop,...g}));
    await evidence(page,`${width}-${theme}-${height}`,g);
    const rows=page.locator('.thread-replies .thread-message');
    expect(await rows.count()).toBeGreaterThan(1);
    if(g.history.height>0){
      const first=await rows.first().boundingBox();
      await page.locator('.thread-replies').evaluate(n=>n.scrollTop=80);
      expect((await rows.first().boundingBox()).y).toBeLessThan(first.y);
    }
    if(comparison)continue;
    expect(g.history.height).toBeGreaterThanOrEqual(110);
    expect(g.header.height).toBeLessThanOrEqual(100);
    expect(g.composer.height).toBeLessThanOrEqual(105);
    expect(g.editor.height).toBeLessThanOrEqual(height*.25);
    expect(g.editor.scrollHeight).toBeGreaterThan(g.editor.clientHeight);
    expect(g.rootOverflow).toBe(false);
    expect(g.panel.top).toBeGreaterThanOrEqual(offsetTop);
    expect(g.panel.bottom).toBeLessThanOrEqual(offsetTop+height);
    expect(g.history.bottom).toBeLessThanOrEqual(g.composer.top+1);
    const controls=await page.locator('.chat-thread-panel .thread-header-actions button:visible').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,hit:n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};}));
    for(const r of controls){expect(r.width).toBeGreaterThanOrEqual(44);expect(r.height).toBeGreaterThanOrEqual(44);expect(r.left).toBeGreaterThanOrEqual(0);expect(r.right).toBeLessThanOrEqual(width);expect(r.hit).toBe(true);}
    await expect(editor).toHaveText(draft);
    await page.locator('.thread-replies').evaluate(n=>n.scrollTop=80);
    expect(await page.locator('.thread-replies').evaluate(n=>n.scrollTop)).toBeGreaterThan(0);

  }
  if(comparison)return;
  // Scroll and selection survive typing/IME while the bounded editor overflows.
  await editor.evaluate(n=>{n.focus();const range=document.createRange();range.selectNodeContents(n);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);});
  await page.keyboard.insertText('!');
  await expect(editor).toHaveText(draft+'!');
  const caret=await editor.evaluate(n=>{const c=getSelection().getRangeAt(0).getBoundingClientRect(),r=n.getBoundingClientRect();return {top:c.top,bottom:c.bottom,editorTop:r.top,editorBottom:r.bottom};});
  expect(caret.top).toBeGreaterThanOrEqual(caret.editorTop);expect(caret.bottom).toBeLessThanOrEqual(caret.editorBottom);
  await editor.evaluate(n=>{n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await expect(editor).toHaveText(draft+'!');
  await page.getByRole('button',{name:'Rename thread title',exact:true}).click();
  await expect(page.locator('#thread-title-input')).toBeVisible();
  await page.locator('#thread-title-input').fill('Edited title');
  await page.evaluate(()=>Alpine.store('chat').threadTitleError='Title save failed. Keep the existing title.');
  await expect(page.locator('.thread-title-editor .error-text')).toHaveText('Title save failed. Keep the existing title.');
  expect((await geometry(page)).header.height).toBeLessThanOrEqual(94);
  await page.locator('.thread-title-editor .btn-cancel').click();
  await page.getByRole('button',{name:'Thread menu',exact:true}).click();
  await expect(page.locator('.chat-thread-panel .thread-title-menu-popover')).toBeVisible();
  await page.getByRole('button',{name:'Thread menu',exact:true}).click();
  await page.evaluate(()=>{const s=Alpine.store('chat');s.openAutopilotOverviewThread=row=>{window.densityNavigation=row.rootRecordId;};});
  await page.getByRole('button',{name:'Open older visible chat',exact:true}).click();
  expect(await page.evaluate(()=>window.densityNavigation)).toBe('older-thread');
  await page.locator('.chat-thread-panel').getByRole('button',{name:'Full screen',exact:true}).click();
  await expect(page.locator('.chat-thread-panel').getByRole('button',{name:'Exit full screen',exact:true})).toBeVisible();
  await page.locator('.thread-input-actions .chat-composer-menu-trigger').click();
  await expect(page.getByRole('menuitem',{name:'Attach photo or file',exact:true})).toBeVisible();
  await page.locator('.thread-input-actions .chat-composer-menu-trigger').click();
  await page.evaluate(()=>{
    const s=Alpine.store('chat');
    s.threadFileDrafts=[{draft_id:'density-file',kind:'file',filename:'Review attachment.txt',size_bytes:100,status:'error',error:'Upload failed. Retry attachment.'}];
    s.messageEdit={...s.messageEdit,context:'thread',recordId:'density-0',draftBeforeEdit:document.querySelector('[data-chat-composer=thread]').textContent,mentionsBeforeEdit:[],error:'Save failed. Draft retained.',submitting:false};
  });
  await expect(page.locator('.chat-editing-banner:visible')).toContainText('Save failed. Draft retained.');
  await expect(page.locator('.chat-file-draft:visible')).toContainText('Review attachment.txt');
  const g=await geometry(page);
  expect(await page.locator('.thread-composer-region').evaluate(n=>n.scrollHeight>n.clientHeight)).toBe(true);
  await evidence(page,`${width}-${theme}-attachment-error`,g);
  expect(g.history.height).toBeGreaterThanOrEqual(100);
  await expect(page.locator('.thread-reply-btn')).toBeDisabled();
  await page.evaluate(()=>{const s=Alpine.store('chat');s.uploadChatFileDraft=id=>{window.densityRetry=id;s.threadFileDrafts=s.threadFileDrafts.map(d=>({...d,status:'ready'}));};});
  await page.locator('.chat-file-draft').getByRole('button',{name:'Retry',exact:true}).click();
  expect(await page.evaluate(()=>window.densityRetry)).toBe('density-file');
  await expect(page.locator('.thread-reply-btn')).toBeEnabled();
  await expect(page.getByRole('button',{name:'Remove attachment',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove attachment',exact:true}).click();
  await expect(editor).toHaveText(draft+'!');
  await page.locator('.chat-editing-banner').getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(editor).toHaveText(draft+'!');
  await page.evaluate(()=>{const s=Alpine.store('chat');s.sendThreadReply=()=>{s.commitMentionComposerDraft('thread');window.densitySent=s.threadInput;};});
  await page.locator('.thread-reply-btn').click();
  expect(await page.evaluate(()=>window.densitySent)).toBe(draft+'!');
  await page.evaluate(()=>{
    const s=Alpine.store('chat');s.getRecentMentionChips=()=>[{id:'npub1solagent',type:'agent',label:'Implementation agent',avatarUrl:''}];
  });
  await page.getByRole('button',{name:'Mention Implementation agent',exact:true}).click();
  await expect(editor.locator('.mention-composer-pill')).toContainText('Implementation agent');
  expect(await editor.textContent()).toContain(draft+'!');
  await page.evaluate(()=>window.mockViewport(160,55,2));
  expect((await geometry(page)).panel.height).toBe(g.panel.height);
  await page.setViewportSize({width,height:320});
  await page.evaluate(()=>window.mockViewport(320,0));
  await page.waitForFunction(()=>document.querySelector('.chat-thread-panel').getBoundingClientRect().bottom<=320);
  await editor.focus();
  await page.waitForFunction(()=>{
    const f=document.querySelector('.thread-composer-region').getBoundingClientRect();
    const e=document.querySelector('[data-chat-composer="thread"]').getBoundingClientRect();
    const a=document.querySelector('.thread-input-actions').getBoundingClientRect();
    return e.top>=f.top-1 && e.bottom<=f.bottom+1 && a.bottom<=f.bottom+1;
  },null,{timeout:5000});
  const visible=await page.locator('.thread-input-actions > .thread-reply-btn').boundingBox();
  expect(visible.y+visible.height).toBeLessThanOrEqual(320);
  const small=await geometry(page);expect(small.history.height).toBeGreaterThanOrEqual(100);expect(small.panel.bottom).toBeLessThanOrEqual(320);
  await evidence(page,`${width}-${theme}-layout-320`,small);
  await page.locator('.chat-thread-panel .thread-close-btn').click();await expect(page.locator('.chat-thread-panel')).toBeHidden();
 });
}
for(const width of [900,1440])for(const theme of ['light','dark'])test(`desktop tablet long draft ${width} ${theme}`,async({page})=>{
 const editor=await prepare(page,width,theme,844,0);const g=await geometry(page);
 expect(g.history.height).toBeGreaterThan(400);expect(g.rootOverflow).toBe(false);await expect(editor).toHaveText(draft);
 await evidence(page,`${width}-${theme}-desktop`,g);
});
