import { canvasContext, canvasPartition } from '../canvas/projection.js';
import { getTowerPgChannel, getTowerPgChannelFiles, createTowerPgChannelFile } from '../api.js';
import { mapPgFileToLocalDocument } from '../pg-read-hydrator.js';
import { upsertDocument } from '../db.js';
import { loadWorkspaceReport } from './workspace-report-bundle.js';
const closed = () => ({status:'closed',candidates:[],partition:'',error:''});
export const workspaceReportMixin = {
  workspaceReport: closed(),
  workspaceReportPartition(){return canvasPartition(canvasContext(this));},
  closeWorkspaceReport(){this.workspaceReport=closed();document.querySelector('#workspace-report-dialog')?.close();this.syncRoute?.(true);},
  async openWorkspaceReport(){
    if(!this.isTowerPgMode||this.workspaceReport.status==='loading'||this.artefactCreating)return;
    if(!await this.closeArtefact())return;
    const context=canvasContext(this), partition=canvasPartition(context),requestId=crypto.randomUUID();
    const current=()=>this.workspaceReport.requestId===requestId&&canvasPartition(canvasContext(this))===partition;
    this.workspaceReport={status:'loading',candidates:[],partition,requestId,error:''};this.syncRoute?.(true);
    (this.$nextTick||globalThis.Alpine?.nextTick||queueMicrotask)(()=>document.querySelector('#workspace-report-dialog')?.showModal());
    const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();if(current())this.workspaceReport={...this.workspaceReport,status:'error',error:'Private app discovery timed out. Try again.'};},45000);
    try{
      const channel=await this.ensureTowerPgDmChannel(context.viewer);if(!current())return;
      const options={baseUrl:context.baseUrl,appNpub:context.appNpub,signal:controller.signal};
      const remote=(await getTowerPgChannel(context.workspaceId,channel.record_id,options)).channel;if(!current())return;
      if(remote?.id!==channel.record_id||remote.workspace_id!==context.workspaceId||remote.kind!=='dm'||remote.participant_npubs?.length!==1||remote.participant_npubs[0]!==context.viewer||remote.archived_at)throw Error('A verified private self conversation is required.');
      const payload=await getTowerPgChannelFiles(context.workspaceId,channel.record_id,{...options,limit:200});if(!current())return;
      if(!Array.isArray(payload.files)||payload.files.length>=200||payload.has_more||payload.next_cursor||payload.partial)throw Error('The complete private File list could not be checked. Open your existing report from Files.');
      const ids=new Set();for(const f of payload.files){if(!f.id||ids.has(f.id)||f.workspace_id!==context.workspaceId||f.channel_id!==channel.record_id)throw Error('Invalid private File list.');ids.add(f.id);}
      const candidates=payload.files.filter(f=>!f.archived_at&&!f.deleted_at&&f.metadata?.napplet?.app_id==='workspace-report');
      this.workspaceReport={...this.workspaceReport,status:candidates.length?'choose':'setup',candidates};
      if(candidates.length===1)await this.openWorkspaceReportFile(candidates[0]);
    }catch(error){if(current())this.workspaceReport={...this.workspaceReport,status:'error',error:error.message,candidates:[]};}finally{clearTimeout(timer);}
  },
  async openWorkspaceReportFile(file){
    if(this.workspaceReport.partition!==this.workspaceReportPartition()||!this.workspaceReport.candidates.some(f=>f.id===file.id))return;
    this.closeWorkspaceReport();await this.openArtefact(mapPgFileToLocalDocument(file),{appMode:true,appId:'workspace-report'});
  },
  async setupWorkspaceReport(){
    if(this.workspaceReport.status!=='setup'||this.artefactCreating)return;
    await this.openWorkspaceReport();if(this.workspaceReport.status!=='setup')return;
    this.artefactCreating=true;
    const context=canvasContext(this),partition=canvasPartition(context),current=()=>partition===this.workspaceReportPartition()&&this.workspaceReport.status!=='closed';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
    try{
      const source=await loadWorkspaceReport({signal:controller.signal});if(!current())return;
      const channel=await this.ensureTowerPgDmChannel(context.viewer);if(!current())return;
      const options={baseUrl:context.baseUrl,appNpub:context.appNpub,signal:controller.signal};
      const remote=(await getTowerPgChannel(context.workspaceId,channel.record_id,options)).channel;if(!current())return;
      if(remote?.id!==channel.record_id||remote.workspace_id!==context.workspaceId||remote.kind!=='dm'||remote.participant_npubs?.length!==1||remote.participant_npubs[0]!==context.viewer||remote.archived_at)throw Error('A private self conversation is required.');
      const objectId=await this.uploadArtefactHtml(context,source,'Workspace Report.html');if(!current())return;
      const result=await createTowerPgChannelFile(context.workspaceId,channel.record_id,{storage_object_id:objectId,display_name:'Workspace Report.html',metadata:{html_artifact:true,artefact:{schema_version:1,type:'html',format_version:1,editor_id:'builtin.html'},napplet:{version:1,app_id:'workspace-report',bindings:{report:{workspace_id:context.workspaceId}}}}},options);if(!current())return;
      if(!result.file?.id||result.file.workspace_id!==context.workspaceId||result.file.channel_id!==channel.record_id)throw Error('Report File creation could not be confirmed. Reopen to check existing Files before retrying.');
      const row=mapPgFileToLocalDocument(result.file,{workspaceOwnerNpub:this.activeWorkspaceOwnerNpub});await upsertDocument(row);if(!current())return;
      this.closeWorkspaceReport();await this.openArtefact(row,{appMode:true,appId:'workspace-report'});
    }catch(error){if(current())this.workspaceReport={...this.workspaceReport,status:'error',error:error.message};}finally{clearTimeout(timer);this.artefactCreating=false;}
  },
};
