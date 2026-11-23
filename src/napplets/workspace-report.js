import * as api from '../api.js';
import { REPORT_MODEL } from './aggregate-capability.js';
export { REPORT_MODEL, normalizeWorkspaceReport } from './aggregate-capability.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
export function parseWorkspaceReport(html, metadata) {
  const matches = [...String(html).matchAll(/<script\b[^>]*\bid\s*=\s*["']wingman-napplet-manifest["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  let manifest; try { manifest = matches.length === 1 ? JSON.parse(matches[0][1]) : null; } catch { /* strict rejection below */ }
  if (metadata?.napplet?.app_id !== 'workspace-report' && manifest?.app_id !== 'workspace-report') return null;
  const b=manifest?.bindings?.report,n=metadata?.napplet;
  if(matches.length!==1 || !exact(manifest,['version','app_id','bindings']) || manifest.version!==1 || manifest.app_id!=='workspace-report' || !exact(manifest.bindings,['report']) || !exact(b,['format','operations','privacy']) || b.format!=='workspace-report-v1' || b.privacy!=='viewer' || JSON.stringify(b.operations)!=='["read"]' || !exact(n,['version','app_id','bindings']) || n.version!==1 || n.app_id!=='workspace-report' || !exact(n.bindings,['report']) || !exact(n.bindings.report,['workspace_id']) || !UUID.test(n.bindings.report.workspace_id)) throw Error('Invalid Workspace Report manifest.');
  return Object.freeze({appId:'workspace-report',workspaceId:n.bindings.report.workspace_id});
}
export function validWorkspaceReportRequest(event,frame,session) {
  const d=event?.data;
  return Boolean(frame && event.source===frame && event.origin==='null' && exact(d,['type','version','session','requestId','operation','binding','range']) && d.type==='wingman-napplet-data' && d.version===1 && d.session===session && typeof d.requestId==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.requestId) && d.operation==='read' && d.binding==='report' && REPORT_MODEL.ranges.includes(d.range));
}
export class WorkspaceReportData {
  constructor(context,codeFileId,binding,{transport=api,current=()=>true,query}={}){this.query=query;this.context=Object.freeze({...context});this.codeFileId=codeFileId;this.binding=binding;this.api=transport;this.current=current;this.stopped=false;this.controller=new AbortController();this.codeVersion='';}
  assert(){if(this.stopped||!this.current())throw Error('Workspace Report context changed.');}
  options(){return {baseUrl:this.context.baseUrl,appNpub:this.context.appNpub,signal:this.controller.signal};}
  stop(){this.stopped=true;this.controller.abort();}
  grant(canWrite){if(canWrite!==false||this.granted)throw Error('Workspace Report is read only.');this.granted=true;}
  async authority(){
    this.assert();const c=this.context;
    if(this.binding.workspaceId!==c.workspaceId)throw Error('Workspace Report binding changed.');
    const p=await this.api.getTowerPgFile(c.workspaceId,this.codeFileId,this.options());this.assert();const f=p.file;
    if(f?.id!==this.codeFileId||f.workspace_id!==c.workspaceId||f.archived_at||f.deleted_at||!UUID.test(f.current_version_id))throw Error('Workspace Report File unavailable.');
    if(this.codeVersion&&f.current_version_id!==this.codeVersion)throw Error('Workspace Report code changed.');this.codeVersion=f.current_version_id;
    const n=f.metadata?.napplet;
    if(!exact(n,['version','app_id','bindings'])||n.version!==1||n.app_id!=='workspace-report'||!exact(n.bindings,['report'])||!exact(n.bindings.report,['workspace_id'])||n.bindings.report.workspace_id!==c.workspaceId)throw Error('Workspace Report binding changed.');
    if(Object.hasOwn(p,'can_write')&&typeof p.can_write!=='boolean')throw Error('Invalid File authority.');
    const access=Object.hasOwn(p,'can_write')?p.can_write:f.can_write===true;
    if(this.codeAccess!==undefined&&this.codeAccess!==access)throw Error('Workspace Report access changed.');this.codeAccess=access;
    const channel=(await this.api.getTowerPgChannel(c.workspaceId,f.channel_id,this.options())).channel;this.assert();
    if(channel?.id!==f.channel_id||channel.workspace_id!==c.workspaceId||channel.kind!=='dm'||channel.archived_at||channel.participant_npubs?.length!==1||channel.participant_npubs[0]!==c.viewer)throw Error('Workspace Report requires your private self conversation.');
    return {canWrite:false,codeAccess:access};
  }
  async read(range){
    if(!this.granted||!REPORT_MODEL.ranges.includes(range))throw Error('Workspace Report read unavailable.');
    await this.authority();
    if(typeof this.query!=='function')throw Error('Workspace Report query service unavailable.');
    const value=await this.query(range,this.controller.signal);this.assert();
    REPORT_MODEL.validate(value);
    await this.authority();this.assert();return {value,canWrite:false,privacy:'viewer-channels'};
  }
}
export class WorkspaceReportFrame {
  constructor(data,{onRevoke=()=>{}}={}){this.data=data;this.onRevoke=onRevoke;this.active=null;}
  attach(frame,session){
    this.detach();const s={frame,session,used:new Set(),busy:false,checking:false};this.active=s;
    const current=()=>this.active===s&&!this.data.stopped;
    const revoke=()=>{if(!current())return;this.stop();this.onRevoke();};
    s.listener=async e=>{
      if(!current()||s.busy||!validWorkspaceReportRequest(e,frame.contentWindow,session)||s.used.has(e.data.requestId))return;
      if(s.checking){s.queued=e;return;}
      if(s.used.size>=10000){revoke();return;}s.used.add(e.data.requestId);s.busy=true;
      const timer=setTimeout(revoke,45000),d=e.data;
      try{let value=await this.data.read(d.range);if(s.checkRequested){s.checkRequested=false;value=await this.data.read(d.range);if(s.checkRequested){revoke();return;}}s.last={requestId:d.requestId,range:d.range};if(current())frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:1,session,requestId:d.requestId,status:'ready',...value},'*');}
      catch{revoke();}finally{clearTimeout(timer);s.busy=false;}
    };
    s.check=async()=>{if(!current()||s.checking)return;if(s.busy){s.checkRequested=true;return;}s.checking=true;frame.inert=true;const timer=setTimeout(revoke,45000);try{if(s.last){const value=await this.data.read(s.last.range);if(current()&&!s.queued)frame.contentWindow?.postMessage({type:'wingman-napplet-result',version:1,session,requestId:s.last.requestId,status:'ready',...value},'*');}else await this.data.authority();}catch{revoke();}finally{clearTimeout(timer);s.checking=false;if(current()){frame.inert=false;const next=s.queued;s.queued=null;if(next)void s.listener(next);}}};
    s.visibility=()=>{if(document.visibilityState==='visible')void s.check();};
    addEventListener('message',s.listener);addEventListener('focus',s.check);addEventListener('visibilitychange',s.visibility);s.timer=setInterval(s.check,30000);
  }
  async check(){await this.active?.check();}
  detach(){const s=this.active;this.active=null;if(!s)return;removeEventListener('message',s.listener);removeEventListener('focus',s.check);removeEventListener('visibilitychange',s.visibility);clearInterval(s.timer);}
  stop(){this.detach();this.data.stop();}
}
