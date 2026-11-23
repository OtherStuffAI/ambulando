import { parseRuntimeManifest } from './runtime-protocol.js';
import { sha256,UUID } from './generic-protocol.js';
// Reusable bot/client helper. request is the existing authenticated NStack
// client bound to the acting identity, workspace and application. Never keys.
export async function publishNapplet({request,html,bundle,requesterNpub,publisherNpub,expectedRevision=0,delegationId,update=false}) {
  const manifest=parseRuntimeManifest(html);
  if(!UUID.test(bundle?.file_id)||!UUID.test(bundle?.file_version_id)||await sha256(html)!==bundle.sha256_hex)throw Error('Completed immutable bundle reference and matching HTML are required.');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('Exact installation revision required.');
  const path=encodeURIComponent(manifest.napplet_id);
  if(update)return request(`${path}/releases`,{method:'POST',body:{expected_revision:expectedRevision,bundle,manifest}});
  if(typeof requesterNpub!=='string'||!requesterNpub||typeof publisherNpub!=='string'||!publisherNpub)throw Error('Requester and registered publisher required.');
  // The server requires manager/delegation authority and creates requester-only
  // audience. This cannot grant personal capabilities or any collection access.
  return request(path,{method:'PUT',body:{expected_revision:expectedRevision,requester_npub:requesterNpub,publisher_npub:publisherNpub,display_name:manifest.title,bundle,manifest,...(delegationId?{delegation_id:delegationId}:{})}});
}

export function installationForReinstall(existing,{workspaceId,appNpub,nappletId,requesterNpub,publisherNpub}) {
  if(!existing)return {expectedRevision:0,alreadyInstalled:false};
  if(existing.workspace_id!==workspaceId||existing.app_npub!==appNpub||existing.napplet_id!==nappletId||existing.owner_npub!==requesterNpub||existing.publisher_npub!==publisherNpub||!Number.isSafeInteger(existing.revision)||existing.revision<1||typeof existing.removed!=='boolean')throw Error('Existing napplet identity cannot be rebound.');
  return {expectedRevision:existing.revision,alreadyInstalled:!existing.removed};
}
