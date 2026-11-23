import { canonical, sha256, UUID, validateJson } from './generic-protocol.js';
import { parseRuntimeManifest, runtimeSupport, validateRuntimeManifest } from './runtime-protocol.js';
export function validateInstallation(row,context,id) {
  if(!row || row.workspace_id!==context.workspaceId || row.app_npub!==context.appNpub || row.napplet_id!==id || row.removed!==false || !Number.isSafeInteger(row.revision) || row.revision<1 || typeof row.publisher_npub!=='string' || !row.publisher_npub || !Array.isArray(row.audience_npubs))throw Error('Napplet installation unavailable.');
  if(row.owner_npub!==context.viewer && row.publisher_npub!==context.viewer && !row.audience_npubs.includes(context.viewer))throw Error('Napplet audience access unavailable.');
  const manifest=validateRuntimeManifest(row.manifest);if(manifest.napplet_id!==id)throw Error('Installation manifest identity mismatch.');
  const b=row.bundle;
  if(!b || !UUID.test(b.file_id)||!UUID.test(b.file_version_id)||!/^[a-f0-9]{64}$/.test(b.sha256_hex))throw Error('Invalid authenticated bundle reference.');
  return row;
}
export async function loadRuntimeBundle(installation,context,files,signal) {
  const b=installation.bundle,options={baseUrl:context.baseUrl,appNpub:context.appNpub,signal};
  const object=files.bundle ? await files.bundle(installation.napplet_id,signal) : await files.getTowerPgFileVersionObjectBytes(context.workspaceId,b.file_id,b.file_version_id,options);
  if(object.contentType!=='text/html' || object.bytes.byteLength>2097152 || await sha256(object.bytes)!==b.sha256_hex)throw Error('Napplet bundle integrity check failed.');
  const html=new TextDecoder('utf-8',{fatal:true}).decode(object.bytes),manifest=parseRuntimeManifest(html);
  if(manifest.napplet_id!==installation.napplet_id || canonical(manifest)!==canonical(installation.manifest))throw Error('Bundle manifest does not match authenticated publication.');
  const unsupported=runtimeSupport(manifest);if(unsupported)throw Error(unsupported);
  return {manifest,content:{html,digest:b.sha256_hex,version_id:b.file_version_id,assets:[]}};
}
export class NappletRuntimeData {
  constructor(context,installation,{transport,current=()=>true}={}) {
    this.context=Object.freeze({...context});this.installation=installation;this.manifest=installation.manifest;this.transport=transport;this.current=current;this.controller=new AbortController();this.stopped=false;this.approved=false;this.collections=new Map();this.selection=new Map();
  }
  assert(){if(this.stopped||!this.current())throw Error('Napplet context changed.');if(globalThis.navigator?.onLine===false)throw Error('Napplets require an online connection.');}
  stop(){this.stopped=true;this.controller.abort();this.collections.clear();this.selection.clear();this.approved=false;}
  grant(){this.assert();this.approved=true;}
  async authority(){
    this.assert();const result=await this.transport.read(encodeURIComponent(this.installation.napplet_id),this.controller.signal);this.assert();
    const latest=validateInstallation(result.installation,this.context,this.installation.napplet_id);
    if(latest.publisher_npub!==this.installation.publisher_npub)throw Error('Publisher authority changed.');
    for(const [name,previous] of [...this.collections]){const fresh=await this.collection(name);if(canonical([fresh.id,fresh.owner_npub,fresh.read_npubs,fresh.write_npubs])!==canonical([previous.id,previous.owner_npub,previous.read_npubs,previous.write_npubs]))throw Error('Collection access changed.');}

    return {installation:latest,updateAvailable:latest.bundle.file_version_id!==this.installation.bundle.file_version_id};
  }
  async collection(name){
    this.assert();const declaration=this.manifest.collections[name];if(!declaration)throw Error('Undeclared collection.');
    const rows=[],seen=new Set();let after=null;
    do {
      const path=`${encodeURIComponent(this.installation.napplet_id)}/collections?limit=100${after?`&after=${encodeURIComponent(after)}`:''}`;
      const page=await this.transport.read(path,this.controller.signal);this.assert();
      if(!Array.isArray(page.collections)||page.collections.length>100||!(page.next_cursor===null||typeof page.next_cursor==='string'))throw Error('Invalid collection page.');
      rows.push(...page.collections);after=page.next_cursor;if(after){if(seen.has(after)||seen.size>=100)throw Error('Collection pagination did not complete.');seen.add(after);}
    }while(after);
    let matches=rows.filter(c=>c.workspace_id===this.context.workspaceId&&c.app_npub===this.context.appNpub&&c.napplet_id===this.installation.napplet_id&&c.name===name&&c.scope===declaration.scope&&c.schema_version===declaration.schema_version);
    const selected=this.selection.get(name);if(selected)matches=matches.filter(c=>c.id===selected);
    const own=matches.filter(c=>c.owner_npub===this.context.viewer);if(declaration.scope==='personal'&&own.length)matches=own;
    if(matches.length!==1)throw Error(matches.length?'Choose an unambiguous collection in Apps.':'Create or request access to this collection in Apps.');
    const c=matches[0];if(!UUID.test(c.id)||!Number.isSafeInteger(c.revision)||c.revision<1)throw Error('Invalid collection authority.');
    // Always resolve live grants; a cached collection ID never authorizes a request.
    this.collections.set(name,c);return c;
  }
  selectCollection(name,id){this.assert();if(!this.manifest.collections[name]||!UUID.test(id))throw Error('Invalid collection selection.');this.selection.set(name,id);}
  async execute(request){
    this.assert();if(!this.approved)throw Error('Approval required.');
    const d=request,declaration=this.manifest.collections[d.collection];if(!declaration?.operations.includes(d.operation))throw Error('Operation not approved.');
    const c=await this.collection(d.collection);this.assert();
    const path=`${encodeURIComponent(this.installation.napplet_id)}/collections/${c.id}/records`;
    const validateRecord=r=>{
      if(!r||r.collection_id!==c.id||!Number.isSafeInteger(r.revision)||r.revision<1||r.schema_version!==c.schema_version||typeof r.id!=='string'||typeof r.deleted!=='boolean')throw Error('Invalid collection record.');
      if(!r.deleted)validateJson(r.data);return r;
    };
    if(d.operation==='list'){
      const page=await this.transport.read(`${path}?limit=${d.limit}${d.cursor?`&after=${encodeURIComponent(d.cursor)}`:''}`,this.controller.signal);this.assert();
      if(!Array.isArray(page.records)||page.records.length>d.limit||!(page.next_cursor===null||typeof page.next_cursor==='string'))throw Error('Invalid record page.');
      page.records.forEach(validateRecord);return page;
    }
    const recordPath=`${path}/${encodeURIComponent(d.record_id)}`;
    if(d.operation==='get'){const result=await this.transport.read(recordPath,this.controller.signal);this.assert();validateRecord(result.record);if(result.record.id!==d.record_id)throw Error('Record identity mismatch.');return result;}
    const body=d.operation==='delete'?{expected_revision:d.base_revision}:{expected_revision:d.base_revision,schema_version:c.schema_version,data:validateJson(d.value)};
    if(d.operation!=='delete'&&new TextEncoder().encode(canonical(d.value)).length>262144)throw Error('Collection records are limited to 256 KiB.');
    const ack=await this.transport.command(recordPath,d.operation==='delete'?'DELETE':'PUT',body);this.assert();validateRecord(ack.record);
    if(ack.record.id!==d.record_id||ack.record.revision!==d.base_revision+1)throw Error('Write could not be confirmed. Reload before retrying.');
    // Read back through the local projection, never synthesize successful writes.
    const result=await this.transport.read(recordPath,this.controller.signal);this.assert();validateRecord(result.record);
    if(canonical(result.record)!==canonical(ack.record))throw Object.assign(Error('A newer revision exists.'),{status:409});
    return result;
  }
}
