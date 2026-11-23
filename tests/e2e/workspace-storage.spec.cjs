const {test,expect}=require('playwright/test');
const {execFileSync}=require('node:child_process');
const fixture=require('../fixtures/napplets/workspace-report-storage-v1.json');
test('storage cartridge fits a phone, retains exact values and clears errors without fake zero',async({page})=>{
 test.setTimeout(20000);await page.goto('/napplets/workspace-report/v1/index.html');await page.setViewportSize({width:320,height:844});
 const html=execFileSync('bun',['-e',"import {genericWorkspaceReportBundle} from './scripts/package-generic-workspace-report.mjs';process.stdout.write(await genericWorkspaceReportBundle({storage:true}));"],{encoding:'utf8'});
 const host=`<script>window.nappletSession='a'.repeat(32);window.replyMode='ready';addEventListener('message',e=>{if(e.data.type==='wingman-napplet-data'){const v=${JSON.stringify(fixture.value)};v.range=e.data.range;if(v.range!=='all')v.from=new Date(Date.parse(v.as_of)-parseInt(v.range)*86400000).toISOString();postMessage({type:'wingman-napplet-result',version:2,session:window.nappletSession,requestId:e.data.requestId,status:replyMode,code:replyMode==='error'?'forbidden':undefined,canWrite:false,privacy:'viewer-channels',value:v},'*')}});</script>`;
 await page.setContent(html.replace('<head>','<head>'+host));
 await expect(page.locator('#storage')).toBeVisible();await expect(page.locator('#storage')).toContainText('18,668 bytes');await expect(page.locator('#storage')).toContainText('Unavailable');
 expect(await page.evaluate(()=>document.body.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#range').selectOption('7d');await expect(page.locator('#storage')).toBeVisible();await expect(page.locator('#storage')).toContainText('18,668 bytes');
 await page.screenshot({path:'tmp/docs/handoffs/storage-report-phone-ready.png',fullPage:true});
 await page.evaluate(()=>window.replyMode='error');await page.locator('#refresh').click();await expect(page.locator('#storage')).toBeHidden();await expect(page.locator('#status')).toContainText('Workspace management permission');await expect(page.locator('#storage-groups')).toBeEmpty();
 await page.screenshot({path:'tmp/docs/handoffs/storage-report-phone-denial.png',fullPage:true});
});
