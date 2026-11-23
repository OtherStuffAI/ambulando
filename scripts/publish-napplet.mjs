import { readFile } from 'node:fs/promises';
import { publishNapplet, installationForReinstall } from '../src/napplets/runtime-publisher.js';
import { parseRuntimeManifest } from '../src/napplets/runtime-protocol.js';
import { sha256 } from '../src/napplets/generic-protocol.js';
import { brokerSigner, towerClient } from './html-artifact/tower.mjs';
// The supported capability broker signs exact requests. This tool receives no
// keys or credentials and cannot bypass a denied management delegation.
const args=process.argv.slice(2),take=key=>{const i=args.indexOf('--'+key);return i<0?undefined:args[i+1];};
for(const key of ['tower','workspace','app','html'])if(!take(key))throw Error(`Missing --${key}. Use --tower <origin> --workspace <id> --app <npub> --html <bundle.html> --channel <id> --requester <npub> --publisher <npub> [--delegation <id>] [--expected-revision <N>] [--update]. Existing immutable bundle: --file-id <id> --version-id <id>.`);
const html=await readFile(take('html'),'utf8'),manifest=parseRuntimeManifest(html),bytes=new TextEncoder().encode(html);
const client=towerClient({baseUrl:take('tower'),workspaceId:take('workspace'),sign:brokerSigner()});
const base=`/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(take('workspace'))}/apps/${encodeURIComponent(take('app'))}/napplets/`;
let expectedRevision=Number(take('expected-revision')||0);
if(!args.includes('--update')){
  let existing=null;try{existing=(await client.request('GET',base+encodeURIComponent(manifest.napplet_id))).installation;}catch(error){if(error.status!==404)throw error;}
  const state=installationForReinstall(existing,{workspaceId:take('workspace'),appNpub:take('app'),nappletId:manifest.napplet_id,requesterNpub:take('requester'),publisherNpub:take('publisher')});
  if(state.alreadyInstalled){console.log(JSON.stringify({installation:existing,already_installed:true},null,2));process.exit(0);}
  if(take('expected-revision')&&expectedRevision!==state.expectedRevision)throw Error('Installation revision changed. Read the removed installation before retrying.');
  expectedRevision=state.expectedRevision;
}
let fileId=take('file-id'),versionId=take('version-id');
if(!versionId){
  if(!fileId&&!take('channel'))throw Error('--channel is required to publish a new bundle File.');
  if(fileId&&!take('base-file-version-id'))throw Error('--base-file-version-id is required to update a code File without overwriting concurrent work.');
  const storage=await client.uploadObject({bytes,contentType:'text/html',fileName:manifest.napplet_id+'.html'});
  if(fileId){const result=await client.createVersion(fileId,{base_version_id:take('base-file-version-id'),storage_object_id:storage,client_mutation_id:crypto.randomUUID()});versionId=result.version?.id;}
  else{const result=await client.createFile(take('channel'),{storage_object_id:storage,display_name:manifest.title+'.html',metadata:{html_artifact:true,napplet:{version:3,napplet_id:manifest.napplet_id}}});fileId=result.file?.id;versionId=result.file?.current_version_id; if(fileId&&!versionId)versionId=(await client.listVersions(fileId)).current_version_id;}
}

const result=await publishNapplet({request:(suffix,o)=>client.request(o.method,base+suffix,o.body),html,bundle:{file_id:fileId,file_version_id:versionId,sha256_hex:await sha256(bytes)},requesterNpub:take('requester'),publisherNpub:take('publisher'),expectedRevision,delegationId:take('delegation'),update:args.includes('--update')});
console.log(JSON.stringify(result,null,2));
