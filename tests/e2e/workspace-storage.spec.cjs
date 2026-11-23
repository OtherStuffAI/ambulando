const {test,expect}=require('playwright/test');
const {execFileSync}=require('node:child_process');
const fixture=require('../fixtures/napplets/workspace-report-storage-v1.json');
const columns=require('../fixtures/napplets/workspace-storage-columns-v1.json');
for(const [name,storage] of [['historical JSON',fixture.value.storage],['stored columns',columns]]){
test(`${name} storage cartridge fits a phone, retains exact values and clears errors without fake zero`,async({page})=>{
 test.setTimeout(20000);await page.goto('/napplets/workspace-report/v1/index.html');await page.setViewportSize({width:320,height:844});
 const html=execFileSync('bun',['-e',"import {genericWorkspaceReportBundle} from './scripts/package-generic-workspace-report.mjs';process.stdout.write(await genericWorkspaceReportBundle({storage:true}));"],{encoding:'utf8'});
 const host=`<script>window.nappletSession='a'.repeat(32);window.replyMode='ready';addEventListener('message',e=>{if(e.data.type==='wingman-napplet-data'){const v=${JSON.stringify({...fixture.value,storage})};v.range=e.data.range;if(v.range!=='all')v.from=new Date(Date.parse(v.as_of)-parseInt(v.range)*86400000).toISOString();postMessage({type:'wingman-napplet-result',version:2,session:window.nappletSession,requestId:e.data.requestId,status:replyMode,code:replyMode==='error'?'forbidden':undefined,canWrite:false,privacy:'viewer-channels',value:v},'*')}});</script>`;
 await page.setContent(html.replace('<head>','<head>'+host));
 await expect(page.locator('#storage')).toBeVisible();await expect(page.locator('#storage')).toContainText(name==='stored columns'?'12,000 bytes':'18,668 bytes');await expect(page.locator('#storage')).toContainText('Unavailable');
 if(name==='stored columns'){
  await expect(page.locator('#storage')).toContainText('Stored column bytes');
  await expect(page.locator('#storage')).toContainText('Metadata column bytes (subset)');
  await expect(page.locator('#storage')).toContainText('History column bytes (subset)');
  await expect(page.locator('#storage')).toContainText('estimated · stored-column-size-subset');
  await expect(page.locator('#storage')).toContainText('12,000 bytes');
  await expect(page.locator('#storage-caveats')).toContainText('Metadata and history are subsets, not additional bytes');
 }
 expect(await page.evaluate(()=>document.body.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#range').selectOption('7d');await expect(page.locator('#storage')).toBeVisible();await expect(page.locator('#storage')).toContainText(name==='stored columns'?'12,000 bytes':'18,668 bytes');
 await page.screenshot({path:`tmp/docs/handoffs/storage-report-${name.replaceAll(' ','-')}-phone-ready.png`,fullPage:true});
 await page.evaluate(()=>window.replyMode='error');await page.locator('#refresh').click();await expect(page.locator('#storage')).toBeHidden();await expect(page.locator('#status')).toContainText('Workspace management permission');await expect(page.locator('#storage-groups')).toBeEmpty();
 await page.screenshot({path:`tmp/docs/handoffs/storage-report-${name.replaceAll(' ','-')}-phone-denial.png`,fullPage:true});
});
}
