import '../../public/napplets/daily-tracker/v1/model.js';
import * as api from '../api.js';
import { buildStoragePrepareBody } from '../storage-payloads.js';

export const TRACKER_MODEL = globalThis.DailyTrackerModel;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export function parseFileNapplet(html, metadata) {
  const matches = [...String(html).matchAll(/<script\b[^>]*\bid\s*=\s*["']wingman-napplet-manifest["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (!matches.length && !metadata?.napplet) return null;
  const invalid = () => { throw new Error('Invalid or unsupported File napplet manifest.'); };
  if (matches.length !== 1) invalid();
  let m; try { m=JSON.parse(matches[0][1]); } catch { invalid(); }
  const b=m?.bindings?.tracker, n=metadata?.napplet;
  if (!exact(m,['version','app_id','bindings']) || m.version!==1 || m.app_id!=='daily-tracker' || !exact(m.bindings,['tracker'])
    || !exact(b,['format','operations','privacy']) || b.format!=='daily-tracker-v1' || b.privacy!=='self' || JSON.stringify(b.operations)!=='["read","save"]'
    || !exact(n,['version','app_id','bindings']) || n.version!==1 || n.app_id!==m.app_id || !exact(n.bindings,['tracker'])
    || !exact(n.bindings.tracker,['file_id']) || !UUID.test(n.bindings.tracker.file_id)) invalid();
  return Object.freeze({ appId:m.app_id, fileId:n.bindings.tracker.file_id });
}
export function validFileNappletRequest(event, frame, session) {
  const d=event?.data;
  if (!frame || event.source!==frame || event.origin!=='null' || !d || d.type!=='wingman-napplet-data' || d.version!==1 || d.session!==session || typeof d.requestId!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.requestId)) return false;
  const common=['type','version','session','requestId','operation'];
  if (d.operation==='dirty') return exact(d,[...common,'dirty']) && typeof d.dirty==='boolean';
  if (d.binding!=='tracker') return false;
  if (d.operation==='read') return exact(d,[...common,'binding']);
  if (d.operation!=='save' || !exact(d,[...common,'binding','baseVersionId','value']) || !UUID.test(d.baseVersionId)) return false;
  try { TRACKER_MODEL.validate(d.value); return true; } catch { return false; }
}

/** Memory-only, context-bound File command owner. Tower remains storage/ACL authority. */
export class FileNappletData {
  constructor(context, codeFileId, binding, { transport=api, current=()=>true }={}) {
    this.context=Object.freeze({...context});this.codeFileId=codeFileId;this.binding=binding;this.api=transport;this.current=current;this.codeVersion='';this.controller=new AbortController();this.stopped=false;this.base='';this.value=null;
  }
  grant(canWrite){
    this.assert();
    if(typeof canWrite!=='boolean'||this.approvedCanWrite!==undefined)throw new Error('Invalid napplet grant.');
    Object.defineProperty(this,'approvedCanWrite',{value:canWrite});
  }
  options(){return {baseUrl:this.context.baseUrl,appNpub:this.context.appNpub,signal:this.controller.signal};}
  assert(){if(this.stopped||!this.current())throw new Error('Napplet context changed.');}
  stop(){this.stopped=true;this.controller.abort();this.value=null;this.base='';}
  async authority(){
    this.assert();const c=this.context,o=this.options();
    const [code,data]=await Promise.all([this.api.getTowerPgFile(c.workspaceId,this.codeFileId,o),this.api.getTowerPgFile(c.workspaceId,this.binding.fileId,o)]);this.assert();
    for(const [payload,id] of [[code,this.codeFileId],[data,this.binding.fileId]])if(payload.file?.id!==id||payload.file.workspace_id!==c.workspaceId)throw new Error('Invalid File authority response.');
    if (this.codeVersion && code.file.current_version_id !== this.codeVersion) throw new Error('Napplet code changed. Reopen it.');
    this.codeVersion = code.file.current_version_id;
    if (!UUID.test(this.codeVersion)) throw new Error('Invalid napplet code version.');
    const n=code.file.metadata?.napplet;
    if(!exact(n,['version','app_id','bindings'])||!exact(n.bindings,['tracker'])||!exact(n.bindings.tracker,['file_id'])||n.version!==1||n.app_id!==this.binding.appId||n.bindings.tracker.file_id!==this.binding.fileId)throw new Error('Napplet binding changed. Reopen it.');
    const result=await this.api.getTowerPgChannel(c.workspaceId,data.file.channel_id,o);this.assert();
    const channel=result.channel;
    if(channel?.id!==data.file.channel_id||channel.workspace_id!==c.workspaceId||channel.kind!=='dm'||channel.participant_npubs?.length!==1||channel.participant_npubs[0]!==c.viewer||channel.archived_at)throw new Error('Tracker data must be in your private self conversation.');
    const canWrite=data.file.can_write===true||data.can_write===true;
    if(this.approvedCanWrite!==undefined&&canWrite!==this.approvedCanWrite){throw Object.assign(new Error('Tracker access changed. Reopen to review approval.'),{status:403});}
    return {file:data.file,canWrite};
  }
  async read({expectedVersion='',expectedValue=null}={}){
    const access=await this.authority(),c=this.context,o=this.options();
    const history=await this.api.getTowerPgFileVersions(c.workspaceId,this.binding.fileId,{...o,limit:1});this.assert();
    const version=history.versions?.find(v=>v.id===history.current_version_id);
    if(!version||!UUID.test(version.id)||version.content_type!=='application/json'||!Number.isSafeInteger(version.size_bytes)||version.size_bytes>1048576||!/^[a-f0-9]{64}$/.test(version.sha256_hex))throw new Error('Invalid tracker File version.');
    const object=await this.api.getTowerPgFileVersionObjectBytes(c.workspaceId,this.binding.fileId,version.id,o);this.assert();
    if(object.contentType!=='application/json'||object.bytes.byteLength!==version.size_bytes||await digest(object.bytes)!==version.sha256_hex)throw new Error('Tracker integrity check failed.');this.assert();
    const value=TRACKER_MODEL.validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(object.bytes)));
    if (expectedVersion && (version.id!==expectedVersion || JSON.stringify(value)!==JSON.stringify(expectedValue))) throw Object.assign(new Error('The tracker changed after saving. Reload to review.'),{status:409});
    await this.authority();
    this.base=version.id;this.value=value;return {baseVersionId:this.base,value,canWrite:access.canWrite,privacy:'self-channel'};
  }
  async save(base,value){
    this.assert();if(!this.base||base!==this.base)throw Object.assign(new Error('Reload before saving.'),{status:409});
    const next=TRACKER_MODEL.validateReplacement(this.value,value),access=await this.authority();
    if(!access.canWrite)throw Object.assign(new Error('Tracker is read only.'),{status:403});
    const bytes=new TextEncoder().encode(JSON.stringify(next)),c=this.context,o=this.options();
    const prepared=await this.api.prepareTowerPgStorageObject(c.workspaceId,buildStoragePrepareBody({ownerNpub:c.viewer,contentType:'application/json',sizeBytes:bytes.length,fileName:'daily-tracker.json'}),o);this.assert();
    if(prepared.is_public)throw new Error('Private storage required.');
    await this.api.uploadStorageObject(prepared,bytes,'application/json',o);this.assert();
    await this.api.completeStorageObject(prepared.object_id,{size_bytes:bytes.length,sha256_hex:await digest(bytes)},o);this.assert();
    const finalAccess = await this.authority();
    if (!finalAccess.canWrite) throw Object.assign(new Error('Tracker is read only.'),{status:403});
    const published = await this.api.createTowerPgFileVersion(c.workspaceId,this.binding.fileId,{base_version_id:base,storage_object_id:prepared.object_id,client_mutation_id:crypto.randomUUID()},o);this.assert();
    const committed = published?.version?.id;
    if (!UUID.test(committed)) throw new Error('Save acknowledgement was incomplete. Reload to confirm.');
    return this.read({expectedVersion:committed,expectedValue:next});
  }
}
