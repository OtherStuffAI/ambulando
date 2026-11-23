import { getTowerPgWorkspaceReport } from '../api.js';
import { canvasContext,canvasPartition } from '../canvas/projection.js';
import { normalizeWorkspaceReport } from './workspace-report.js';
// TowerSyncService owns this bounded on-demand query; no persistent count cache.
export async function queryWorkspaceReport(store,range,{signal,storage=false}={},deps={}) {
  const context=canvasContext(store),partition=canvasPartition(context),service=store._towerSyncService;
  const controller=new AbortController(),signals=[signal,service?.readAbortController?.signal].filter(Boolean);
  const abort=()=>controller.abort();for(const s of signals){if(s.aborted)abort();else s.addEventListener('abort',abort,{once:true});}
  const current=()=>{controller.signal.throwIfAborted();service?.assertActive();if(canvasPartition(canvasContext(store))!==partition)throw Error('Report context changed.');};
  try{current();const payload=await (deps.read||getTowerPgWorkspaceReport)(context.workspaceId,range,{baseUrl:context.baseUrl,appNpub:context.appNpub,signal:controller.signal,storage});current();return normalizeWorkspaceReport(payload,context,range,{storage});}
  finally{for(const s of signals)s.removeEventListener('abort',abort);}
}
