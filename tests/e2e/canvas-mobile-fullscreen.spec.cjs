const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.setTimeout(30000);
test.use({ serviceWorkers:'block', reducedMotion:'reduce' });
for (const [width,height] of [[320,568],[375,667],[390,844],[568,320],[667,375],[844,390],[1440,900]]) {
 test(`Canvas fullscreen fits ${width}x${height} with long content`,async({page,baseURL},testInfo)=>{
  await page.setViewportSize({width,height});
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(process.env.SOL_RUNTIME_ASSETS==='1' && url.origin===new URL(baseURL).origin && !url.pathname.startsWith('/api/'))return route.continue();
   return serveBuiltFlightDeck(route);
  });
  await page.goto('/canvas.html');await page.waitForFunction(()=>Alpine.store('canvas')?.status==='error');
  await page.evaluate(()=>{const s=Alpine.store('canvas');s.status='ready';s.error='';s.canvas={title:'Phone fullscreen',can_manage:true};s.viewport={x:0,y:0,scale:.8};s.napletStatus=()=> 'Long save status '.repeat(10);s.orderSelected=()=>{};});
  for(const type of ['document','task_list','chat_thread','html']){
   await page.evaluate(type=>{Alpine.store('canvas').naplets=[{id:'phone',title:'LongUnbrokenNappletTitle'.repeat(20),access:'ready',source:{type,id:'source'},content:{body:'WideUnbrokenContent'.repeat(300),tasks:[],messages:[],html:'<input aria-label="Retained draft"><div style="width:2000px">Wide embedded content</div>'},layout:{x:0,y:0,width:300,height:260,z:1}}];},type);
   const naplet=page.locator('.canvas-naplet');
   await naplet.getByRole('button',{name:'Open full screen',exact:true}).click();
   await expect(naplet).toHaveJSProperty('open',true);
   // Simulate a phone home-indicator inset as well as ordinary zero-inset browsers.
   await naplet.evaluate(el=>el.style.paddingBottom='24px');
   const check=async locator=>{const r=await locator.boundingBox();expect(r.x).toBeGreaterThanOrEqual(0);expect(r.y).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(width+1);expect(r.y+r.height).toBeLessThanOrEqual(height+1);return r;};
   const box=await check(naplet);expect(box.width).toBe(width);expect(box.height).toBe(height);
   await check(naplet.locator('.canvas-naplet-header'));
   const exit=naplet.getByRole('button',{name:'Restore from full screen',exact:true});await check(exit);
   await check(naplet.locator('.canvas-window-content'));
   if(await naplet.locator('iframe').count())await check(naplet.locator('iframe'));
   await naplet.getByRole('button',{name:'Window options',exact:true}).click();
   const menu=naplet.getByRole('menu');
   await menu.locator('[role=menuitem]').first().evaluate(el=>el.textContent='LongUnbrokenMenuAction'.repeat(20));
   const menuBox=await check(menu);expect(menuBox.y+menuBox.height).toBeLessThanOrEqual(height-24-8);expect(menuBox.y).toBeGreaterThanOrEqual((await exit.boundingBox()).y+(await exit.boundingBox()).height);expect(await menu.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:'Remove from Canvas'})).toBeInViewport();
   await check(exit);
   console.log('CANVAS_PHONE_GEOMETRY',JSON.stringify({width,height,type,dialog:box,menu:menuBox,exit:await exit.boundingBox()}));
   if(type==='document')await page.screenshot({path:testInfo.outputPath('fullscreen-menu.png')});
   await page.keyboard.press('Escape');await expect(menu).not.toBeVisible();
   await naplet.getByRole('button',{name:'Window options',exact:true}).click();
   await exit.click();await expect(naplet).toHaveJSProperty('open',false);
   await naplet.getByRole('button',{name:'Open full screen',exact:true}).click();
   await page.keyboard.press('Escape');await expect(naplet).toHaveJSProperty('open',false);
  }
 });
}
