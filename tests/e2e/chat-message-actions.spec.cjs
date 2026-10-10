const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
test.use({ serviceWorkers:'block', reducedMotion:'reduce' });
const prose='Got it—I misunderstood. **One persistent agent session per app**, with every follow-up routed back to that session. That retains the app’s working context and conversation.\n\nThe pipeline can be very simple: one send build instruction function.\n\n'+'Long multiline prose remains readable and selectable. '.repeat(18);
for (const width of [320,390,430,768,1440]) for (const theme of ['light','dark']) {
 test(`message actions clear prose ${width} ${theme}`, async ({page}) => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height:900});
  if(process.env.SOL_ACTIONS_LIVE==='1')await page.route('**/*',route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname))return route.abort();if(u.pathname.startsWith('/api/'))return route.fulfill({status:503,contentType:'application/json',body:'{}'});return route.continue();});
  await openFixture(page,process.env.SOL_ACTIONS_LIVE==='1');
  console.log("ACTIONS fixture ready",width,theme);
  errors.length=0;
  await page.evaluate(({theme,prose})=>{
   const s=Alpine.store('chat'); Alpine.store('appearance').setTheme(theme);
   s.messages=s.messages.map(m=>({...m,body:prose}));
   s.messages[0].title='A conversation about persistent agent sessions and working context';
   s.messages=[...s.messages,...Array.from({length:6},(_,i)=>({...s.messages[1],record_id:`actions-reply-${i}`}))];
   s.getSenderName=()=> 'A long sender name that wraps safely';
   s.copyMessageRawText=id=>{window.copiedMessage=id;s.closeMessageActionsMenu();};
  },{theme,prose});
  const history=page.locator('.thread-replies');
  await history.evaluate(n=>n.scrollTop=0);
  const row=page.locator('.thread-message').first();
  const toggle=row.getByRole('button',{name:'Message actions',exact:true});
  const menu=row.locator('.chat-msg-actions-popover');
  for(const scale of [1,1.5,2]) {
   await page.evaluate(scale=>{document.documentElement.style.fontSize=`${16*scale}px`;document.querySelector('.thread-msg-text').style.fontSize=`${16*scale}px`;},scale);
   await history.evaluate(n=>n.scrollTop=0);
   const g=await row.evaluate(n=>{
    const r=sel=>{const b=n.querySelector(sel).getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
    return {button:r('.chat-msg-actions-toggle'),text:r('.thread-msg-text'),body:r('.thread-msg-body'),overflow:document.documentElement.scrollWidth>innerWidth};
   });
   console.log("ACTIONS",JSON.stringify({width,theme,scale,...g}));
   expect(g.button.width).toBeGreaterThanOrEqual(44);expect(g.button.height).toBeGreaterThanOrEqual(44);
   expect(g.button.bottom).toBeLessThanOrEqual(g.text.top);
   expect(g.button.right).toBeLessThanOrEqual(width);
   expect(g.text.width).toBeCloseTo(g.body.width,0);expect(g.overflow).toBe(false);
   await toggle.focus(); await page.keyboard.press('Enter');
   await expect(menu).toBeVisible();await expect(toggle).toHaveAttribute('aria-expanded','true');
   await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(toggle).toBeFocused();
   await toggle.click();await toggle.click();await expect(menu).toBeHidden();
   await toggle.click();await row.locator('.thread-msg-metadata').click({position:{x:5,y:5}});await expect(menu).toBeHidden();
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize='16px';document.querySelector('.thread-msg-text').style.fontSize='';});
  await history.evaluate(n=>n.scrollTop=0);
  // Native selection covers all prose without an invisible action hit area.
  const selection=await row.locator('.chat-post-markdown').evaluate(n=>{const r=document.createRange();r.selectNodeContents(n);getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString();});
  expect(selection).toContain('working context and conversation');
  await toggle.click();await menu.getByRole('button',{name:'Copy message',exact:true}).click();
  expect(await page.evaluate(()=>window.copiedMessage)).toBe('sol-thread');await expect(menu).toBeHidden();
  const readOnly=page.locator('[data-thread-reply]').first();
  await page.evaluate(()=>{const s=Alpine.store('chat');s.messages=s.messages.map(m=>m.parent_message_id?{...m,read_only:true}:m);});
  await readOnly.getByRole('button',{name:'Message actions',exact:true}).click();
  await expect(readOnly.getByRole('button',{name:'Edit',exact:true})).toBeHidden();
  await expect(readOnly.getByRole('button',{name:'Delete message',exact:true})).toBeHidden();
  await expect(readOnly.getByRole('button',{name:'Copy message',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await history.evaluate(n=>n.scrollTop=0);
  await history.evaluate(n=>n.scrollTop=100);
  expect(await history.evaluate(n=>n.scrollTop)).toBeGreaterThan(0);
  await toggle.focus();await page.keyboard.press('Enter');
  const scroll=await history.evaluate(n=>n.scrollTop);
  await page.keyboard.press('Escape');expect(await history.evaluate(n=>n.scrollTop)).toBe(scroll);
  await history.evaluate(n=>n.scrollTop=0);
  if(width<768)expect((await page.locator('.chat-thread-panel .thread-header').boundingBox()).height).toBeLessThanOrEqual(49);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  expect(await page.evaluate(()=>visualViewport.scale)).toBe(2);
  const zoomClear=await row.evaluate(n=>n.querySelector('.chat-msg-actions-toggle').getBoundingClientRect().bottom<=n.querySelector('.thread-msg-text').getBoundingClientRect().top);
  expect(zoomClear).toBe(true);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  const dir=process.env.SOL_EVIDENCE_DIR;
  if(dir){await page.evaluate(()=>{getSelection().removeAllRanges();document.activeElement?.blur();});execFileSync('git',['check-ignore',dir]);expect(execFileSync('git',['ls-files',dir],{encoding:'utf8'}).trim()).toBe('');await fs.mkdir(dir,{recursive:true});await page.screenshot({path:path.join(dir,`actions-${width}-${theme}.png`)});await toggle.click();await page.screenshot({path:path.join(dir,`actions-${width}-${theme}-open.png`)});await page.keyboard.press('Escape');}
  // Channel card heading also reserves its closed target, with keyboard events isolated.
  await page.evaluate(()=>Alpine.store('chat').closeThread());
  const card=page.locator('.channel-thread-card').first();
  await expect(card).toBeVisible();
  await card.hover();
  const clear=await card.evaluate(n=>{const b=n.querySelector('.chat-msg-actions-toggle').getBoundingClientRect(), h=n.querySelector('.channel-thread-card-heading h3').getBoundingClientRect();return b.left>=h.right || b.bottom<=h.top || b.top>=h.bottom;});
  expect(clear).toBe(true);
  await card.getByRole('button',{name:'Message actions',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(card.locator('.chat-msg-actions-popover')).toBeVisible();
  await expect(page.locator('.chat-thread-panel')).toBeHidden();await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
 });
}
