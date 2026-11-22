const {test,expect}=require('playwright/test');
test.setTimeout(90000);
test.use({hasTouch:true,actionTimeout:15000});
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../../public/napplets/daily-tracker/v1');
const parts=Object.fromEntries([['html','index.html'],['style','style.css'],['model','model.js'],['app','app.js']].map(([k,n])=>[k,fs.readFileSync(path.join(root,n),'utf8')]));
test('phone check-in saves false/zero, edits earlier days, reopens and retains stale draft',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.routeWebSocket('**',socket=>socket.close());
 await page.route('**/api/**',r=>r.fulfill({status:503,json:{}}));
 await page.goto('/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!!window.Alpine?.store('chat'));
 await page.evaluate(async parts=>{
  const {FileNappletData}=await import('/src/napplets/file-data.js');const {FileNappletFrame}=await import('/src/napplets/file-frame.js');const {buildCanvasHtmlDocument}=await import('/src/canvas/sandbox.js');const {packageTrackerBundle}=await import('/src/napplets/tracker-bundle.js');
  window.Alpine.store('chat').stopBackgroundSync();
  const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const fixture=window.trackerFixture={version:10,model:{format:'daily-tracker-v1',metrics:[{id:id(1),label:'Ate well',type:'boolean',unit:'',archived:false},{id:id(2),label:'Weight',type:'number',unit:'kg',archived:false}],days:{}},uploads:new Map(),denied:false,writes:0};
  const bytes=()=>new TextEncoder().encode(JSON.stringify(fixture.model));
  const api={getTowerPgFile:async(_w,file)=>{if(fixture.denied)throw Object.assign(Error(),{status:403});return {file:{id:file,workspace_id:id(20),channel_id:id(30),current_version_id:file===id(40)?id(41):id(fixture.version),can_write:true,metadata:{napplet:{version:1,app_id:'daily-tracker',bindings:{tracker:{file_id:id(50)}}}}}};},getTowerPgChannel:async()=>({channel:{id:id(30),workspace_id:id(20),kind:'dm',participant_npubs:['viewer']}}),getTowerPgFileVersions:async()=>({current_version_id:id(fixture.version),versions:[{id:id(fixture.version),content_type:'application/json',size_bytes:bytes().length,sha256_hex:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes()))].map(b=>b.toString(16).padStart(2,'0')).join('')}]}),getTowerPgFileVersionObjectBytes:async()=>({bytes:bytes(),contentType:'application/json'}),prepareTowerPgStorageObject:async()=>({object_id:'upload'}),uploadStorageObject:async(_p,b)=>fixture.uploads.set('upload',b),completeStorageObject:async()=>{},createTowerPgFileVersion:async(_w,_f,b)=>{if(b.base_version_id!==id(fixture.version))throw Object.assign(Error(),{status:409});fixture.model=JSON.parse(new TextDecoder().decode(fixture.uploads.get('upload')));fixture.version++;fixture.writes++;return {version:{id:id(fixture.version)}};}};
  const frame=document.createElement('iframe');frame.id='tracker-test';frame.setAttribute('sandbox','allow-scripts');frame.style='position:fixed;inset:0;width:100%;height:100%;border:0;z-index:999999;background:white';document.body.append(frame);
  window.mountTracker=()=>{fixture.host?.stop();const data=new FileNappletData({workspaceId:id(20),viewer:'viewer'},id(40),{appId:'daily-tracker',fileId:id(50)},{transport:api});fixture.host=new FileNappletFrame(data,{onRevoke:()=>{frame.srcdoc='<p>Access unavailable</p>';}});const session=crypto.randomUUID();fixture.host.attach(frame,session);frame.srcdoc=buildCanvasHtmlDocument(packageTrackerBundle(parts),{nappletSession:session});};window.mountTracker();
 },parts);
 const f=page.frameLocator('#tracker-test');
 await expect(f.getByRole('button',{name:'Save to NStack'})).toBeDisabled();
 for(const width of [320,390,430,1280]){
  await page.setViewportSize({width,height:844});
  await f.getByRole('button',{name:'No',exact:true}).tap();
  await expect(f.getByRole('button',{name:'No',exact:true})).toHaveAttribute('aria-pressed','true');
  // Taps must retain the exact node and keyboard focus, not rebuild the form.
  const no=await f.getByRole('button',{name:'No',exact:true}).elementHandle();
  await no.evaluate(el=>{window.retainedNo=el;});
  await no.press('Space');
  expect(await no.evaluate(el=>el===window.retainedNo&&el.isConnected&&document.activeElement===el)).toBe(true);
  await f.getByRole('spinbutton').fill('72.4');
  expect(await f.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  const small=await f.locator('button,input,select').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&!n.disabled).map(n=>({text:n.textContent||n.id,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})).filter(r=>r.width<40||r.height<44));
  expect(small).toEqual([]);
  await page.screenshot({animations:'disabled',path:`tmp/docs/handoffs/tracker-ui-checkin-${width}.png`});
  await f.getByRole('button',{name:'Metrics',exact:true}).tap();
  await f.getByLabel('Label',{exact:true}).first().fill('Ate well');
  expect(await f.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({animations:'disabled',path:`tmp/docs/handoffs/tracker-ui-metrics-${width}.png`});
  await f.getByRole('button',{name:'Check in',exact:true}).tap();
 }
 await page.setViewportSize({width:390,height:844});
 const number=f.getByRole('spinbutton');await expect(number).toHaveAttribute('inputmode','decimal');
 await number.fill('');await number.evaluate(el=>{
  window.keptInput=el;window.measurements={input:[],render:[],long:[]};
  try{new PerformanceObserver(list=>window.measurements.long.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});}catch{}
  let start;el.addEventListener('keydown',()=>{start=performance.now();});
  el.addEventListener('input',()=>{window.measurements.input.push(performance.now()-start);const keyStart=start;requestAnimationFrame(()=>window.measurements.render.push(performance.now()-keyStart));});
 });
 await number.pressSequentially('72.40',{delay:12});await expect(number).toHaveValue('72.40');
 expect(await number.evaluate(el=>el===window.keptInput&&document.activeElement===el)).toBe(true);
 await f.getByRole('button',{name:'No',exact:true}).tap();
 await f.getByRole('button',{name:'Yes',exact:true}).evaluate(el=>{
  el.addEventListener('pointerdown',()=>{window.tapStart=performance.now();});
  el.addEventListener('click',()=>requestAnimationFrame(()=>window.measurements.tapRender=performance.now()-window.tapStart));
 });
 await f.getByRole('button',{name:'Yes',exact:true}).tap();
 await expect(f.getByRole('button',{name:'Yes',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect.poll(()=>number.evaluate(()=>window.measurements.tapRender)).toBeGreaterThan(0);
 const measured=await number.evaluate(()=>window.measurements);console.log('TRACKER_PHONE_PERF',JSON.stringify(measured));
 expect(measured.input).toHaveLength(5);expect(measured.long).toEqual([]);expect(Math.max(...measured.input)).toBeLessThan(50);expect(Math.max(...measured.render)).toBeLessThan(200);
 await f.getByRole('button',{name:'No',exact:true}).tap();await number.fill('0');
 await f.getByRole('button',{name:'Save to NStack'}).tap();await expect(f.getByRole('status')).toContainText('Saved in NStack');
 await page.evaluate(()=>window.mountTracker());await expect(f.getByRole('spinbutton')).toHaveValue('0');await expect(f.getByRole('button',{name:'No',exact:true})).toHaveAttribute('aria-pressed','true');
 await f.getByLabel('Day',{exact:true}).fill('2026-01-01');await f.getByRole('spinbutton').fill('70');await f.getByRole('button',{name:'Save to NStack'}).tap();await expect(f.getByRole('status')).toContainText('Saved in NStack');
 await f.getByRole('button',{name:'History',exact:true}).tap();await f.getByRole('button',{name:'2026-01-01 · 1 answered'}).tap();await expect(f.getByRole('spinbutton')).toHaveValue('70');
 await f.getByRole('spinbutton').fill('71');await page.evaluate(()=>window.trackerFixture.version++);await f.getByRole('button',{name:'Save to NStack'}).tap();await expect(f.getByRole('status')).toContainText('Another device');await expect(f.getByRole('spinbutton')).toHaveValue('71');
 await f.getByRole('button',{name:'Reload saved'}).tap();await f.getByRole('button',{name:'Discard edits and reload'}).tap();await expect(f.getByRole('spinbutton')).toHaveValue('70');
 await f.getByRole('spinbutton').fill('');await f.getByRole('spinbutton').pressSequentially('e');await expect(f.getByRole('button',{name:'Save to NStack'})).toBeDisabled();await expect(f.getByRole('button',{name:'Metrics',exact:true})).toBeDisabled();await f.getByRole('button',{name:'Clear answer'}).focus();await expect.poll(()=>page.locator('#tracker-test').evaluate(el=>el.inert)).toBe(false);await f.getByRole('button',{name:'Clear answer'}).press('Enter');
 await f.getByRole('button',{name:'Metrics',exact:true}).tap();
 await f.getByLabel('Metric label',{exact:true}).fill('Custom neutral metric');await f.getByRole('button',{name:'Add metric',exact:true}).tap();
 await expect(f.getByLabel('Label',{exact:true})).toHaveCount(3);
 await f.getByLabel('Label',{exact:true}).first().fill('Renamed metric');await f.getByRole('button',{name:'↓ Move down',exact:true}).first().tap();
 await expect(f.getByLabel('Label',{exact:true}).nth(1)).toHaveValue('Renamed metric');
 await f.getByRole('button',{name:'Archive',exact:true}).first().tap();await expect(f.getByRole('button',{name:'Restore',exact:true})).toHaveCount(1);
 await f.getByRole('button',{name:'Save to NStack'}).tap();await expect(f.getByRole('status')).toContainText('Saved in NStack');
 await page.screenshot({animations:'disabled',path:'tmp/docs/handoffs/daily-tracker-phone.png'});
 await page.evaluate(()=>{window.trackerFixture.denied=true;window.dispatchEvent(new Event('focus'));});await expect(f.getByText('Access unavailable')).toBeVisible();
});
