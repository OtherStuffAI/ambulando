// Author a cartridge after a host release, without rebuilding the host.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { canonical } from '../src/napplets/generic-protocol.js';
import { validateRuntimeManifest } from '../src/napplets/runtime-protocol.js';
export function collectionCartridge({id,title,version='1.0.0',scope='personal'}) {
  const manifest=validateRuntimeManifest({version:3,napplet_id:id,bundle_version:version,title,icon:'🌱',runtime:{protocol:3,min_host:3},collections:{entries:{scope,schema_version:1,operations:['list','get','create','update','delete']}},capabilities:{}});
  const escapeText=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),escaped=escapeText(title);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:1rem;overflow-wrap:anywhere}textarea{display:block;box-sizing:border-box;width:100%;min-height:6rem}button{min-height:44px}pre{white-space:pre-wrap}</style></head><body><h1>${escaped}</h1><p>Bundle ${escapeText(manifest.bundle_version)}</p><textarea aria-label="Note"></textarea><button id="save" disabled>Save</button><button id="reload">Reload notes</button><button id="next" hidden>Next page</button><pre role="status"></pre><script id="wingman-napplet-manifest" type="application/json">${canonical(manifest).replaceAll('<','\\u003c')}</script><script>
let revision=0,cursor=null;const pending=new Set();
const send=(operation,extra={})=>{const requestId=crypto.randomUUID();pending.add(requestId);parent.postMessage({type:'wingman-napplet-data',version:3,session:window.nappletSession,requestId,operation,collection:'entries',...extra},'*');};
addEventListener('message',event=>{const d=event.data;if(event.source!==parent||d?.type!=='wingman-napplet-result'||d.version!==3||d.session!==window.nappletSession||!pending.delete(d.requestId))return;document.querySelector('pre').textContent=JSON.stringify(d,null,2);if(d.result?.record){revision=d.result.record.revision;document.querySelector('#save').disabled=false;}if(d.result?.records){const entry=d.result.records.find(r=>r.id==='note');if(entry){revision=entry.revision;document.querySelector('textarea').value=entry.data.text||'';}cursor=d.result.next_cursor;document.querySelector('#next').hidden=!cursor;document.querySelector('#save').disabled=!!cursor&&!entry;}});
document.querySelector('#save').onclick=()=>{document.querySelector('#save').disabled=true;send(revision?'update':'create',{record_id:'note',base_revision:revision,value:{text:document.querySelector('textarea').value}});};
document.querySelector('#reload').onclick=()=>{document.querySelector('#save').disabled=true;revision=0;send('list',{limit:50,cursor:null});};
document.querySelector('#next').onclick=()=>send('list',{limit:50,cursor});send('list',{limit:50,cursor:null});
</script></body></html>`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),take=key=>{const i=args.indexOf('--'+key);return i<0?undefined:args[i+1];};
 const output=take('output');if(!output)throw Error('Use --id <stable-id> --title <title> --output <file.html> [--version <version>] [--scope personal|team].');
 await writeFile(output,collectionCartridge({id:take('id'),title:take('title'),version:take('version'),scope:take('scope')}));
}
