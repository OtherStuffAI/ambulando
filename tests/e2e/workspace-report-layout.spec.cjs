const {test,expect}=require('playwright/test');
const fs=require('node:fs');
const {packageWorkspaceReport}=require('../../src/napplets/workspace-report-bundle.js');
const id='00000000-0000-4000-8000-000000000001';
const html=packageWorkspaceReport(Object.fromEntries(Object.entries({html:'index.html',style:'style.css',model:'model.js',app:'app.js'}).map(([k,n])=>[k,fs.readFileSync(`public/napplets/workspace-report/v1/${n}`,'utf8')])));
test('320px large safe counts preserve exact accessible values and fit long labels',async({page})=>{
 test.setTimeout(15000);await page.goto('/napplets/workspace-report/v1/index.html');
 await page.setViewportSize({width:320,height:844});
 const max=Number.MAX_SAFE_INTEGER;
 const value={format:'workspace-report-v1',workspace_id:id,range:'30d',from:'2026-10-23T12:00:00.000Z',to:'2026-11-22T12:00:00.000Z',as_of:'2026-11-22T12:00:00.000Z',timezone:'UTC',complete:true,channel_policy:'active-project-channels',channels:[{channel_id:id,scope_id:id,name:'LongUnbrokenChannel'.repeat(15),scope_name:'LongScope'.repeat(30),messages:max,conversations:0}],activity:{messages:max,conversations:0},ranking:{total_channels:1,returned_channels:1,has_more:false,other_messages:0,other_conversations:0},coverage:{tasks_channels:1,documents_channels:1,files_channels:1},inventory:{channels:1,conversations:max,tasks:{total:max,open:max,completed:0,archived:0,by_state:{new:max,ready:0,in_progress:0,review:0,done:0,backlog:0,blocked:0,archive:0,archived:0}},documents:max,files:max}};
 const host=`<script>window.nappletSession='layout';addEventListener('message',e=>{if(e.data.operation==='read')postMessage({type:'wingman-napplet-result',version:1,session:'layout',requestId:e.data.requestId,status:'ready',canWrite:false,privacy:'viewer-channels',value:${JSON.stringify(value)}},'*')});</script>`;
 await page.setContent(html.replace('<head>','<head>'+host));
 await expect(page.locator('#report')).toBeVisible();await expect(page.locator('#messages')).toHaveAttribute('aria-label',max.toLocaleString());await expect(page.locator('#messages')).toHaveAttribute('title',max.toLocaleString());expect(await page.evaluate(()=>document.body.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'tmp/docs/handoffs/workspace-report-large320.png',fullPage:true});
});
