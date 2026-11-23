// App authoring only: no host registration, template lookup or runtime dispatch.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageWorkspaceReport } from '../src/napplets/workspace-report-bundle.js';
const root = new URL('../public/napplets/workspace-report/v1/', import.meta.url);
export async function genericWorkspaceReportBundle() {
  const [html,style,model,app] = await Promise.all(['index.html','style.css','model.js','app.js'].map(name=>readFile(new URL(name,root),'utf8')));
  const manifest={version:2,app_id:'workspace-report-generic',title:'Workspace Report',icon:'📊',bindings:{summary:{capability:'workspace-aggregate',version:1,operations:['read']}}};
  const source=html.replace(/(<script[^>]*id="wingman-napplet-manifest"[^>]*>)[\s\S]*?(<\/script>)/,()=>`<script id="wingman-napplet-manifest" type="application/json">${JSON.stringify(manifest)}</script>`);
  return packageWorkspaceReport({html:source,style,model,app:app.replace('version:1,session','version:2,session').replace("binding:'report'","binding:'summary'").replace('d.version!==1','d.version!==2')});
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  const output=process.argv[2];if(!output)throw Error('Usage: bun scripts/package-generic-workspace-report.mjs <output.html>');
  const result=await genericWorkspaceReportBundle();await writeFile(resolve(output),result);
  console.log(JSON.stringify({path:resolve(output),bytes:Buffer.byteLength(result),sha256:createHash('sha256').update(result).digest('hex')}));
}
