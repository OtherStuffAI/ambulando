// App authoring only: no host registration, template lookup or runtime dispatch.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageWorkspaceReport } from '../src/napplets/workspace-report-bundle.js';
const root = new URL('../public/napplets/workspace-report/v1/', import.meta.url);
export async function genericWorkspaceReportBundle({storage=false}={}) {
  const [html,style,model,app] = await Promise.all(['index.html','style.css','model.js','app.js'].map(name=>readFile(new URL(name,root),'utf8')));
  const manifest={version:2,app_id:'workspace-report-generic',title:'Workspace Report',icon:'📊',bindings:{summary:{capability:'workspace-aggregate',version:storage?2:1,operations:['read']}}};
  let source=html.replace(/(<script[^>]*id="wingman-napplet-manifest"[^>]*>)[\s\S]*?(<\/script>)/,()=>`<script id="wingman-napplet-manifest" type="application/json">${JSON.stringify(manifest)}</script>`);
  let extraStyle='',extraApp='';
  if(storage){
    extraStyle=await readFile(new URL('../public/napplets/workspace-report/storage-v1/style.css',import.meta.url),'utf8');
    extraApp=await readFile(new URL('../public/napplets/workspace-report/storage-v1/view.js',import.meta.url),'utf8');
    source=source.replace('<footer>', '<section id="storage" class="panel" aria-labelledby="storage-heading" hidden><p class="eyebrow">Current workspace · administrator</p><h2 id="storage-heading">Storage and retained data</h2><p class="muted">Current retained totals across this workspace, including retained history. Independent of the activity period; these are not cumulative upload traffic or billing totals.</p><p id="storage-asof" class="muted"></p><div id="storage-groups"></div><ul id="storage-caveats" class="muted"></ul></section><footer>');
  }
  let script=app.replace('version:1,session','version:2,session').replace("binding:'report'","binding:'summary'").replace('d.version!==1','d.version!==2');
  if(storage)script=script.replace('function clear(message) {','function clear(message) { globalThis.WorkspaceStorageView.clear();').replace('model.validate(d.value)','model.validateWithStorage(d.value)').replace('render(v);','render(v);globalThis.WorkspaceStorageView.render(v.storage);').replace("clear('Counts are unavailable. Refresh to check your current access.');", "clear(d.code==='forbidden'?'Workspace management permission is required to read storage.':'Storage and activity are unavailable. Refresh to check the service and your current access.');");
  return packageWorkspaceReport({html:source,style:extraStyle+ style+'\n@media(max-width:400px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.cards article:first-child{grid-column:1/-1}.cards strong{white-space:nowrap;overflow-wrap:normal}.cards article:not(:first-child) strong{font-size:24px}}',model,app:extraApp+'\n'+script});
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname))void (async()=>{
  const output=process.argv[2];if(!output)throw Error('Usage: bun scripts/package-generic-workspace-report.mjs <output.html>');
  const result=await genericWorkspaceReportBundle({storage:process.argv.includes('--storage')});await writeFile(resolve(output),result);
  console.log(JSON.stringify({path:resolve(output),bytes:Buffer.byteLength(result),sha256:createHash('sha256').update(result).digest('hex')}));
})().catch(error=>{console.error(error);process.exitCode=1;});
