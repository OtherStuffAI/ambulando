import { canonical, sha256 } from './generic-protocol.js';
import { accessExpansion, runtimeAccess } from './runtime-protocol.js';
const revoked=new Set();
export async function runtimeApprovalKey(context,nappletId) {
  const url=new URL(context.baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||[context.appNpub,context.workspaceId,context.viewer,nappletId].some(v=>typeof v!=='string'||!v))throw Error('Incomplete napplet approval context.');
  return 'napplet-approval-v3:'+await sha256(canonical([url.href.replace(/\/$/,''),context.tower||'',context.service||'',context.workspaceId,context.appNpub,context.viewer,nappletId]));
}
export function readRuntimeApproval(key,storage=globalThis.localStorage) {
  try{if(revoked.has(key))return null;const v=JSON.parse(storage.getItem(key));return v?.version===3&&typeof v.publisher==='string'&&v.access&&v.bundle?v:null;}catch{return null;}
}
export function approveRuntime(key,publisher,manifest,bundle,storage=globalThis.localStorage) {
  const value={version:3,publisher,access:runtimeAccess(manifest),manifest,bundle};
  try{const encoded=canonical(value);storage.setItem(key,encoded);if(storage.getItem(key)!==encoded)return false;revoked.delete(key);return true;}catch{return false;}
}
export function runtimeNeedsApproval(approval,publisher,manifest) {
  return !approval||approval.publisher!==publisher||accessExpansion(approval.access,runtimeAccess(manifest)).length>0;
}
export function revokeRuntimeApproval(key,storage=globalThis.localStorage) {
  revoked.add(key);try{storage.removeItem(key);return storage.getItem(key)===null;}catch{return false;}
}
