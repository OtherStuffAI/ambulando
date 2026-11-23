import { nappletRequest, nappletBundleRequest } from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { canvasContext, canvasPartition } from '../canvas/projection.js';
export const runtimeProjectionKey=(context,path)=>`napplet-v3:${canvasPartition(context)}:${path}`;
// All workspace requests, including mutations, run under the existing SyncService.
// Projection keys include backend/app/workspace/viewer; cached rows never grant access.
export async function readRuntimeTarget(store,path,{signal}={}) {
  const c=canvasContext(store),partition=canvasPartition(c),db=getWorkspaceDb(),service=store._towerSyncService;
  const controller=new AbortController(),signals=[signal,service?.readAbortController?.signal].filter(Boolean),abort=()=>controller.abort();
  for(const s of signals){if(s.aborted)abort();else s.addEventListener('abort',abort,{once:true});}
  const current=()=>{controller.signal.throwIfAborted();service?.assertActive();if(partition!==canvasPartition(canvasContext(store))||getWorkspaceDb()!==db)throw Error('Napplet context changed.');};
  try {
    current();if(globalThis.navigator?.onLine===false)throw Error('Napplets require an online connection.');
    const result=await nappletRequest(c.workspaceId,path,{baseUrl:c.baseUrl,appNpub:c.appNpub,signal:controller.signal});current();
    await db.sync_state.put({key:runtimeProjectionKey(c,path),value:result});current();return result;
  } catch(error) {try{current();await db.sync_state.delete(runtimeProjectionKey(c,path));}catch{/* superseded */}throw error;}
  finally{for(const s of signals)s.removeEventListener('abort',abort);}
}
export async function readRuntimeBundleTarget(store,id,{signal}={}) {
  const c=canvasContext(store),partition=canvasPartition(c),service=store._towerSyncService;
  const controller=new AbortController(),abort=()=>controller.abort(),signals=[signal,service?.readAbortController.signal].filter(Boolean);
  for(const s of signals){if(s.aborted)abort();else s.addEventListener('abort',abort,{once:true});}
  try{service?.assertActive();const result=await nappletBundleRequest(c.workspaceId,id,{baseUrl:c.baseUrl,appNpub:c.appNpub,signal:controller.signal});controller.signal.throwIfAborted();service?.assertActive();if(partition!==canvasPartition(canvasContext(store)))throw Error('Napplet context changed.');return result;}
  finally{for(const s of signals)s.removeEventListener('abort',abort);}
}
export function prepareRuntimeCommand(store,input) {
  const c=canvasContext(store),partition=canvasPartition(c),db=getWorkspaceDb(),service=store._towerSyncService;
  const current=()=>{service?.assertActive();if(partition!==canvasPartition(canvasContext(store))||getWorkspaceDb()!==db)throw Error('Napplet context changed.');};
  return {entityKey:`napplet:${input.path}`,execute:async()=>{
    current();if(globalThis.navigator?.onLine===false)throw Error('Napplets require an online connection.');
    const result=await nappletRequest(c.workspaceId,input.path,{baseUrl:c.baseUrl,appNpub:c.appNpub,signal:service?.readAbortController?.signal,method:input.method,body:input.body});
    current();return result;
  }};
}
export function runtimeTransport(store) {
  return {
    bundle:(id,signal)=>{const service=store.getTowerSyncService();if(!service)throw Error('Napplet sync service unavailable.');return service.ensureLoaded('napplet-runtime-bundle',id,{force:true,signal});},
    read:async(path,signal)=>{const service=store.getTowerSyncService();if(!service)throw Error('Napplet sync service unavailable.');const c=canvasContext(store),partition=canvasPartition(c),db=getWorkspaceDb();await service.ensureLoaded('napplet-runtime',path,{force:true,signal});service.assertActive();if(partition!==canvasPartition(canvasContext(store)))throw Error('Napplet context changed.');const row=await db.sync_state.get(runtimeProjectionKey(c,path));service.assertActive();if(partition!==canvasPartition(canvasContext(store))||!row)throw Error('Napplet projection unavailable.');return row.value;},
    command:(path,method,body)=>{const service=store.getTowerSyncService();if(!service)throw Error('Napplet sync service unavailable.');return service.command('napplet-runtime.write',{path,method,body});},
  };
}
