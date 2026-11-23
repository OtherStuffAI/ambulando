import { KNOWN_PAGES } from '../route-helpers.js';
import { canvasContext, canvasPartition } from '../canvas/projection.js';
import { getWorkspaceDb } from '../db.js';
import { threadPinContext, queueThreadPin } from '../thread-pin-store.js';
import { UUID } from './generic-protocol.js';
import { loadGenericCode, nappletTransport } from './generic-reads.js';
import { GenericNappletData } from './generic-data.js';
export function nappletFileInput(input,context,origin,path) {
  const text=String(input||'').trim();if(UUID.test(text))return text;
  const u=new URL(text,origin),segments=u.pathname.split('/').filter(Boolean);
  const supportedPath=[path,'/flight-deck'].includes(u.pathname)||segments.length===1&&KNOWN_PAGES.has(segments[0])||segments.length===2&&KNOWN_PAGES.has(segments[1]);
  if(u.origin!==origin||!supportedPath||u.username||u.password||u.searchParams.get('workspaceid')!==context.workspaceId)throw Error('Use a File link from this app and workspace, or its File ID.');
  const id=u.searchParams.get('nappletFile')||u.searchParams.get('artefactid')||u.searchParams.get('fileid');
  if(!UUID.test(id))throw Error('The link has no valid File ID.');return id;
}
export const genericAppsMixin={
  nappletInstall:{input:'',busy:false,error:''},
  nappletFileChoices(){return (this.documents||[]).filter(r=>r.pg_record_type==='file'&&r.pg_file_metadata?.napplet?.version===2&&!['deleted','archived'].includes(r.record_state));},
  openAddNapplet(){this.nappletInstall={input:'',busy:false,error:''};document.querySelector('#add-napplet-dialog')?.showModal();},
  closeAddNapplet(){if(this.nappletInstall.busy)return;document.querySelector('#add-napplet-dialog')?.close();},
  async projectGenericNapplet(id,binding,content){
    const context=threadPinContext(this);
    await getWorkspaceDb().sync_state.put({key:`napplet-projection:${context.key}:${id}`,value:{title:binding.title,icon:binding.icon,appId:binding.appId,digest:content.digest,versionId:content.version_id}});
  },
  async installNapplet(){
    if(this.nappletInstall.busy)return;this.nappletInstall.busy=true;this.nappletInstall.error='';
    const context=canvasContext(this),partition=canvasPartition(context),current=()=>partition===canvasPartition(canvasContext(this));let data;
    try{
      const id=nappletFileInput(this.nappletInstall.input,context,location.origin,location.pathname),transport=nappletTransport(this);
      const code=await loadGenericCode(context,id,transport);if(!current())throw Error('Workspace changed.');
      data=new GenericNappletData(context,id,code.binding,{transport,current});data.codeVersion=code.content.version_id;
      await data.authority();if(!current())throw Error('Workspace changed.');
      await this.projectGenericNapplet(id,code.binding,code.content);
      // Idempotent installation from canonical pin/outbox state, not a toggle.
      const db=getWorkspaceDb(),pinContext=threadPinContext(this);
      const rows=await db.thread_pins.where('[context+resource_type+resource_id]').equals([pinContext.key,'file',id]).toArray();
      const pending=await db.thread_pin_outbox.where('[context+targetKey]').equals([pinContext.key,`file:${id}`]).sortBy('seq');
      if(!(pending.length?pending.at(-1).body.pinned:rows.some(r=>r.pinned)))await queueThreadPin(db,pinContext,{id,channelId:code.file.channel_id},true,'file');
      void this.requestTowerSyncFamily?.('thread-pins').catch(()=>{});
      this.nappletInstall.busy=false;this.closeAddNapplet();
      await this.openGenericNapplet(id);
    }catch(error){if(current())this.nappletInstall.error=error.message;}finally{data?.stop();this.nappletInstall.busy=false;}
  },
  async openGenericNapplet(id){
    try{
      if(!UUID.test(id))throw Error('Invalid napplet File ID.');
      await this.openArtefact({record_id:id,pg_record_type:'file',content_type:'text/html',title:'Napplet'}, {appMode:true,generic:true});
    }catch(error){this.error=error.message;}
  },
  async checkNappletUpdate(){const id=this.artefact.id;if(this.artefact.generic&&id)await this.openGenericNapplet(id);},
  async uninstallNapplet(entry){
    if(!entry?.codeFileId)return;
    if(this.artefact.id===entry.codeFileId&&!await this.closeArtefact())return;
    const db=getWorkspaceDb(),context=threadPinContext(this);
    await queueThreadPin(db,context,{id:entry.codeFileId},false,'file');
    void this.requestTowerSyncFamily?.('thread-pins').catch(()=>{});
  },
};
