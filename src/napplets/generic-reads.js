import * as api from '../api.js';
import { canvasContext, canvasPartition } from '../canvas/projection.js';
import { mapPgFileToLocalDocument, mapPgChannelToLocal } from '../pg-read-hydrator.js';
import { getWorkspaceDb } from '../db.js';
import { UUID, parseGenericNapplet, sha256 } from './generic-protocol.js';
const methods = ['getTowerPgFile','getTowerPgChannel','getTowerPgFileVersions','getTowerPgFileVersionObjectBytes'];
// Targeted SyncService read ownership. JSON values/code bytes remain memory only.
export async function readNappletTarget(store, _key, {method,args,signal}) {
  if(!methods.includes(method)||!Array.isArray(args))throw Error('Unsupported napplet read.');
  const c=canvasContext(store),partition=canvasPartition(c),service=store._towerSyncService,db=getWorkspaceDb();
  if(args[0]!==c.workspaceId)throw Error('Napplet workspace mismatch.');
  const controller=new AbortController(),signals=[signal,service?.readAbortController?.signal].filter(Boolean),abort=()=>controller.abort();
  for(const s of signals){if(s.aborted)abort();else s.addEventListener('abort',abort,{once:true});}
  const current=()=>{controller.signal.throwIfAborted();service?.assertActive();if(partition!==canvasPartition(canvasContext(store)))throw Error('Napplet context changed.');};
  try{current();const result=await api[method](...args,{baseUrl:c.baseUrl,appNpub:c.appNpub,signal:controller.signal,...(method==='getTowerPgFileVersions'?{limit:200}:{})});current();
    if(method==='getTowerPgFile'&&result.file?.id===args[1]&&result.file.workspace_id===c.workspaceId){await db.documents.put(mapPgFileToLocalDocument(result.file));current();}
    if(method==='getTowerPgChannel'&&result.channel?.id===args[1]&&result.channel.workspace_id===c.workspaceId){await db.channels.put(mapPgChannelToLocal(result.channel));current();}
    return result;
  }finally{for(const s of signals)s.removeEventListener('abort',abort);}
}
export function nappletTransport(store) {
  const transport={...api};
  for(const method of methods)transport[method]=(...input)=>{
    const options=input.pop(),args=input,service=store.getTowerSyncService();if(!service)throw Error('Napplet read service unavailable.');
    return service.ensureLoaded('napplet-read',JSON.stringify([method,...args]),{force:true,method,args,signal:options?.signal});
  };
  return transport;
}
export async function loadGenericCode(context,id,transport,signal) {
  if(!UUID.test(id))throw Error('Invalid code File ID.');
  const o={baseUrl:context.baseUrl,appNpub:context.appNpub,signal};
  const payload=await transport.getTowerPgFile(context.workspaceId,id,o),file=payload.file;
  if(file?.id!==id||file.workspace_id!==context.workspaceId||file.archived_at||file.deleted_at||!UUID.test(file.current_version_id))throw Error('Code File unavailable.');
  const history=await transport.getTowerPgFileVersions(context.workspaceId,id,o),v=history.versions?.find(v=>v.id===file.current_version_id);
  if(!v||v.file_id!==id||v.content_type!=='text/html'||!Number.isSafeInteger(v.size_bytes)||v.size_bytes<1||v.size_bytes>2097152||!/^[a-f0-9]{64}$/.test(v.sha256_hex))throw Error('Code version unavailable.');
  const object=await transport.getTowerPgFileVersionObjectBytes(context.workspaceId,id,v.id,o);
  if(object.bytes.byteLength!==v.size_bytes||await sha256(object.bytes)!==v.sha256_hex)throw Error('Code integrity check failed.');
  const html=new TextDecoder('utf-8',{fatal:true}).decode(object.bytes),binding=parseGenericNapplet(html,file.metadata);
  if(!binding)throw Error('This File is not a supported v2 napplet.');
  return {file,binding,content:{html,version_id:v.id,digest:v.sha256_hex,assets:[]},history};
}
