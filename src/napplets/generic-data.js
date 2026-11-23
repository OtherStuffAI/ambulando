import { buildStoragePrepareBody } from '../storage-payloads.js';
import { UUID, canonical, decodeJson, validateJson, parseGenericNapplet, sha256 } from './generic-protocol.js';
import { REPORT_MODEL } from './aggregate-capability.js';
const conflict=message=>Object.assign(Error(message),{status:409});
export class GenericNappletData {
  constructor(context,codeFileId,binding,{transport,current=()=>true,query}={}){this.context=Object.freeze({...context});this.codeFileId=codeFileId;this.binding=binding;this.api=transport;this.current=current;this.query=query;this.controller=new AbortController();this.stopped=false;this.codeVersion='';this.base='';this.value=null;}
  options(){return {baseUrl:this.context.baseUrl,appNpub:this.context.appNpub,signal:this.controller.signal};}
  assert(){if(this.stopped||!this.current())throw Error('Napplet context changed.');}
  stop(){this.stopped=true;this.controller.abort();this.value=null;this.base='';}
  grant(canWrite){this.assert();if(typeof canWrite!=='boolean'||this.approvedCanWrite!==undefined)throw Error('Invalid napplet grant.');this.approvedCanWrite=canWrite;}
  async authority(){
    this.assert();const c=this.context,o=this.options(),b=this.binding;
    const code=await this.api.getTowerPgFile(c.workspaceId,this.codeFileId,o);this.assert();const f=code.file;
    if(f?.id!==this.codeFileId||f.workspace_id!==c.workspaceId||f.archived_at||f.deleted_at||!UUID.test(f.current_version_id)||this.codeVersion&&this.codeVersion!==f.current_version_id)throw Error('Napplet code changed or unavailable. Reopen.');
    this.codeVersion=f.current_version_id;
    const codeChannel=(await this.api.getTowerPgChannel(c.workspaceId,f.channel_id,o)).channel;this.assert();
    if(codeChannel?.id!==f.channel_id||codeChannel.workspace_id!==c.workspaceId||codeChannel.archived_at||codeChannel.deleted_at)throw Error('Code channel unavailable.');
    // Parse metadata against approved manifest, without executing or reading code again.
    const fresh=parseGenericNapplet('<script id="wingman-napplet-manifest">'+canonical(b.manifest)+'</script>',f.metadata);
    if(canonical(fresh.resources)!==canonical(b.resources))throw Error('Napplet binding changed. Reopen.');
    let file,canWrite=false;
    if(b.capability==='private-json-file'){
      const data=await this.api.getTowerPgFile(c.workspaceId,b.fileId,o);this.assert();file=data.file;
      if(file?.id!==b.fileId||file.workspace_id!==c.workspaceId||file.archived_at||file.deleted_at||!UUID.test(file.current_version_id))throw Error('Data File unavailable.');
      const channel=(await this.api.getTowerPgChannel(c.workspaceId,file.channel_id,o)).channel;this.assert();
      if(channel?.id!==file.channel_id||channel.workspace_id!==c.workspaceId||channel.kind!=='dm'||channel.archived_at||channel.deleted_at||channel.participant_npubs?.length!==1||channel.participant_npubs[0]!==c.viewer)throw Error('Private data requires your self conversation.');
      const liveWrite=Object.hasOwn(data,'can_write')?data.can_write:file.can_write;
      if(typeof liveWrite!=='boolean')throw Error('Missing authoritative File write access.');
      canWrite=liveWrite && b.manifest.bindings[b.name].operations.includes('save');
    }else if(b.workspaceId!==c.workspaceId)throw Error('Workspace binding mismatch.');
    if(this.approvedCanWrite!==undefined&&this.approvedCanWrite!==canWrite)throw Object.assign(Error('Napplet access changed.'),{status:403});
    return {file,canWrite};
  }
  async read(range,{expectedVersion='',expectedValue=null}={}){
    if(this.approvedCanWrite===undefined)throw Error('Approval required.');
    const access=await this.authority(),c=this.context,b=this.binding,o=this.options();
    if(b.capability==='workspace-aggregate'){
      if(typeof this.query!=='function'||!REPORT_MODEL.ranges.includes(range))throw Error('Aggregate unavailable.');
      const value=REPORT_MODEL.validate(await this.query(range,this.controller.signal));
      if(value.workspace_id!==c.workspaceId||value.range!==range||value.channels.length!==Math.min(10,value.ranking.total_channels))throw Error('Aggregate scope mismatch.');
      this.assert();await this.authority();return {value,canWrite:false,privacy:'viewer-channels'};
    }
    const history=await this.api.getTowerPgFileVersions(c.workspaceId,b.fileId,o);this.assert();
    const v=history.versions?.find(v=>v.id===history.current_version_id);
    if(!v||v.file_id!==b.fileId||!UUID.test(v.id)||v.id!==access.file.current_version_id||v.content_type!=='application/json'||!Number.isSafeInteger(v.size_bytes)||v.size_bytes<2||v.size_bytes>1048576||!/^[a-f0-9]{64}$/.test(v.sha256_hex))throw Error('Invalid JSON File version.');
    const object=await this.api.getTowerPgFileVersionObjectBytes(c.workspaceId,b.fileId,v.id,o);this.assert();
    if(object.contentType!=='application/json'||object.bytes.byteLength!==v.size_bytes||await sha256(object.bytes)!==v.sha256_hex)throw Error('JSON integrity check failed.');this.assert();
    const value=decodeJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(object.bytes));
    if(expectedVersion&&(v.id!==expectedVersion||canonical(value)!==canonical(expectedValue)))throw conflict('Save readback changed.');
    const final=await this.authority();if(final.file.current_version_id!==v.id)throw conflict('Data changed while reading.');
    this.base=v.id;this.value=value;return {baseVersionId:v.id,value,canWrite:final.canWrite,privacy:'self-channel'};
  }
  async save(base,value){
    this.assert();if(this.binding.capability!=='private-json-file'||this.approvedCanWrite!==true)throw Error('Read only.');
    if(!this.base||base!==this.base)throw conflict('Reload before saving.');
    const next=validateJson(value),access=await this.authority();if(!access.canWrite)throw Error('Read only.');
    const bytes=new TextEncoder().encode(canonical(next)),c=this.context,o=this.options();
    const prepared=await this.api.prepareTowerPgStorageObject(c.workspaceId,buildStoragePrepareBody({ownerNpub:c.viewer,contentType:'application/json',sizeBytes:bytes.length,fileName:'napplet-data.json'}),o);this.assert();
    if(prepared.is_public)throw Error('Private storage required.');
    await this.api.uploadStorageObject(prepared,bytes,'application/json',o);this.assert();
    await this.api.completeStorageObject(prepared.object_id,{size_bytes:bytes.length,sha256_hex:await sha256(bytes)},o);this.assert();
    await this.authority();
    let result;
    try { result=await this.api.createTowerPgFileVersion(c.workspaceId,this.binding.fileId,{base_version_id:base,storage_object_id:prepared.object_id,client_mutation_id:crypto.randomUUID()},o); } catch (error) { this.base=''; throw error; }
    this.assert();
    if(!UUID.test(result?.version?.id)){this.base='';throw Error('Save could not be confirmed. Reload.');}
    return this.read(undefined,{expectedVersion:result.version.id,expectedValue:next});
  }
}
