import { accessExpansion, runtimeAccess, runtimeSupport, parseRuntimeManifest } from './runtime-protocol.js';
import { reviewLegacySnapshot, legacySnapshotMigration } from './runtime-migration.js';
import { publishNapplet, installationForReinstall } from './runtime-publisher.js';
import { liveQuery } from 'dexie';
import { getWorkspaceDb } from '../db.js';
import { canvasContext, canvasPartition } from '../canvas/projection.js';
import { nappletTransport } from './generic-reads.js';
import { canonical } from './generic-protocol.js';
import { runtimeProjectionKey, runtimeTransport } from './runtime-sync.js';
import { loadRuntimeBundle, NappletRuntimeData, validateInstallation } from './runtime-data.js';
import { NappletRuntimeFrame } from './runtime-frame.js';
import { approveRuntime, readRuntimeApproval, runtimeApprovalKey, runtimeNeedsApproval, revokeRuntimeApproval } from './runtime-consent.js';
const HOSTS=new WeakMap(),LISTS=new WeakMap();
const closed=()=>({id:'',title:'Napplet',status:'closed',error:'',html:null,consent:false,notice:'',collections:[],audience:'',dataReaders:'',dataWriters:'',selectedCollection:'',migrationFile:'',migrationPreview:'',publisher:'',pending:false,pendingDetails:''});
const npubs=s=>{const values=String(s).split(/[\s,]+/).filter(Boolean);if(values.some(n=>!/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(n)))throw Error('Enter user or agent npubs separated by spaces or commas.');return [...new Set(values)];};
export const runtimeManagerMixin={
  runtimeApps:[],runtimeAppsPartition:'',runtimeApiStatus:'unknown',runtimeApp:closed(),
  get runtimeContextKey(){return canvasPartition(canvasContext(this));},
  runtimePublisher:'',
  runtimeDataHost(){return HOSTS.get(this)?.frame||null;},
  initNappletRuntime(){
    window.addEventListener('pagehide',()=>{this.closeRuntimeNapplet(true);this.disposeRuntimeApps();});
    window.addEventListener('offline',()=>{this.closeRuntimeNapplet(true);this.disposeRuntimeApps();});
    // Context dependency is read synchronously; network/state mutations run outside
    // the reactive effect. A private frame disappears immediately on identity switch.
    let previous=this.runtimeContextKey;
    globalThis.Alpine?.effect(()=>{const next=this.runtimeContextKey;if(next!==previous){previous=next;queueMicrotask(()=>{this.closeRuntimeNapplet(true);this.disposeRuntimeApps();void this.loadRuntimeApps();});}});
    void this.loadRuntimeApps();
  },
  disposeRuntimeApps(){const r=LISTS.get(this);r?.controller.abort();r?.subscription.unsubscribe();LISTS.delete(this);this.runtimeApps=[];this.runtimeAppsPartition='';this.runtimeApiStatus='unknown';},
  async loadRuntimeApps({force=false}={}){
    if(this.canvasChatEmbedded||!this.isTowerPgMode)return;
    const c=canvasContext(this),partition=this.runtimeContextKey;if(!c.workspaceId||!c.viewer||!c.dbKey)return;
    let runtime=LISTS.get(this);
    if(runtime?.partition!==partition){this.disposeRuntimeApps();runtime=null;}
    if(runtime?.pending)return runtime.pending;
    if(!force&&runtime?.authorizedAt&&Date.now()-runtime.authorizedAt<30000)return;
    let db;try{db=getWorkspaceDb();}catch{return;}
    if(!runtime){
      runtime={partition,controller:new AbortController(),authorizedAt:0};LISTS.set(this,runtime);
      runtime.subscription=liveQuery(()=>db.sync_state.get(runtimeProjectionKey(c,'apps'))).subscribe({next:row=>{if(LISTS.get(this)===runtime&&runtime.authorizedAt&&this.runtimeContextKey===partition){this.runtimeApps=row?.value||[];this.runtimeAppsPartition=partition;}},error:()=>this.disposeRuntimeApps()});
    }
    const current=()=>LISTS.get(this)===runtime&&this.runtimeContextKey===partition&&!runtime.controller.signal.aborted;
    runtime.pending=(async()=>{
      try{
        const transport=runtimeTransport(this),rows=[],seen=new Set();let cursor=null;
        do{const page=await transport.read(`?limit=100${cursor?`&after=${encodeURIComponent(cursor)}`:''}`,runtime.controller.signal);if(!current())return;
          if(!Array.isArray(page.installations)||page.installations.length>100||!(page.next_cursor===null||typeof page.next_cursor==='string'))throw Error('Invalid Apps page.');
          for(const row of page.installations){validateInstallation(row,c,row.napplet_id);if(rows.some(r=>r.napplet_id===row.napplet_id))throw Error('Duplicate installation.');rows.push(row);}
          cursor=page.next_cursor;if(cursor){if(seen.has(cursor)||seen.size>=100)throw Error('Apps pagination did not complete.');seen.add(cursor);}
        }while(cursor);
        if(!current())return;await db.sync_state.put({key:runtimeProjectionKey(c,'apps'),value:rows});if(!current())return;
        runtime.authorizedAt=Date.now();this.runtimeApps=rows;this.runtimeAppsPartition=partition;this.runtimeApiStatus='ready';
      }catch(error){if(current()){runtime.authorizedAt=0;this.runtimeApps=[];this.runtimeAppsPartition='';this.runtimeApiStatus=error.status===404?'unsupported':'unavailable';await db.sync_state.delete(runtimeProjectionKey(c,'apps'));}}
      finally{if(current())runtime.pending=null;}
    })();return runtime.pending;
  },
  async openRuntimeNapplet(id,{previous=false}={}){
    if(!this.closeRuntimeNapplet())return;
    const c=canvasContext(this),partition=this.runtimeContextKey,transport=runtimeTransport(this),controller=new AbortController();
    const host={id,partition,transport,controller,previous};HOSTS.set(this,host);
    const current=()=>HOSTS.get(this)===host&&this.runtimeContextKey===partition&&!controller.signal.aborted;
    host.current=current;
    this.runtimeApp={...closed(),id,status:'loading'};
    (this.$nextTick||globalThis.Alpine?.nextTick||queueMicrotask)(()=>document.querySelector('#napplet-runtime-dialog')?.showModal());
    const service=this.getTowerSyncService();host.abort=()=>{if(HOSTS.get(this)===host)this.closeRuntimeNapplet(true);};service?.readAbortController.signal.addEventListener('abort',host.abort,{once:true});host.service=service;
    try{
      let installation=validateInstallation((await transport.read(encodeURIComponent(id),controller.signal)).installation,c,id);if(!current())return;
      const key=await runtimeApprovalKey(c,id),approval=readRuntimeApproval(key);if(!current())return;
      if(previous){
        if(!approval||approval.publisher!==installation.publisher_npub)throw Error('No previously approved compatible bundle is available.');
        // The authenticated installation retains publisher identity; immutable prior
        // bundle references come only from this viewer’s earlier confirmed approval.
        installation={...installation,bundle:approval.bundle,manifest:approval.manifest||installation.manifest};
      }
      const loaded=await loadRuntimeBundle(installation,c,previous?nappletTransport(this):{bundle:transport.bundle},controller.signal);if(!current())return;
      host.installation=installation;host.content=loaded.content;host.key=key;host.storage=event=>{if(event.key===key&&host.current()){host.frame?.stop();host.data?.stop();host.migration=null;host.content=null;host.controller.abort();this.runtimeApp={...closed(),id:host.id,status:'error',error:'Personal approval changed. Reopen to review access.'};}};window.addEventListener('storage',host.storage);
      host.data=new NappletRuntimeData(c,installation,{transport,current});
      const access=await host.data.authority();if(!current())return;
      this.runtimeApp={...this.runtimeApp,title:installation.display_name||loaded.manifest.title,status:'ready',audience:installation.audience_npubs.join('\n'),pending:!!access.installation.pending_release,pendingDetails:access.installation.pending_release ? JSON.stringify(runtimeAccess(access.installation.pending_release.manifest),null,2) : ''};
      host.needsApproval=runtimeNeedsApproval(approval,installation.publisher_npub,loaded.manifest);
      this.runtimeApp.permissionText=Object.entries(loaded.manifest.collections).map(([name,d])=>`${name}: ${d.scope}, ${d.operations.join(', ')}, schema ${d.schema_version}`).join('\n')||'This napplet requests no collection access.';
      if(host.needsApproval){this.runtimeApp.consent=true;return;}
      await this.enableRuntimeNapplet(false);
    }catch(error){if(current()){host.data?.stop();this.runtimeApp.status='error';this.runtimeApp.error=error.message;this.runtimeApp.html=null;}}
  },
  async enableRuntimeNapplet(explicit=true){
    const h=HOSTS.get(this);if(!h?.current()||!h.data||h.approving)return;h.approving=true;
    try{
      const access=await h.data.authority();if(!h.current())return;
      if(canonical(access.installation.bundle)!==canonical(h.installation.bundle)&&!h.previous)throw Error('An updated bundle is available. Reopen to review it.');
      const saved=explicit?approveRuntime(h.key,h.installation.publisher_npub,h.installation.manifest,h.installation.bundle):true;

      h.data.grant();
      h.frame=new NappletRuntimeFrame(h.data,{onDirty:value=>{h.dirty=value;},onBusy:value=>{h.busy=value;},onRevoke:()=>{if(h.current()){h.migration=null;h.content=null;h.controller.abort();this.runtimeApp={...closed(),id:h.id,status:'error',error:'Napplet access is no longer available. Reopen to recheck.'};}},onUpdate:()=>{if(h.current()&&h.previous){this.runtimeApp.notice='Using your previously approved version. Reopen the latest version when ready to review new access.';return;}if(h.current()&&!h.dirty&&!h.busy&&!h.updating){h.updating=true;queueMicrotask(()=>{if(h.current())void this.openRuntimeNapplet(h.id);});}}});
      this.runtimeApp.consent=false;this.runtimeApp.html=h.content;this.runtimeApp.notice=saved?'Updates within your approved access load automatically.':'Approval could not be saved; you will be asked again next time.';
      await this.loadRuntimeCollections();
    }catch(error){if(h.current()){h.data.stop();this.runtimeApp.html=null;this.runtimeApp.error=error.message;this.runtimeApp.status='error';}}finally{h.approving=false;}
  },
  closeRuntimeNapplet(force=false){
    const h=HOSTS.get(this);if(!force&&(h?.busy||h?.approving))return false;
    if(!force&&h?.dirty&&!window.confirm('Discard unsaved napplet changes?'))return false;
    HOSTS.delete(this);if(h?.storage)window.removeEventListener('storage',h.storage);h?.controller.abort();h?.frame?.stop();h?.data?.stop();if(h?.abort)h.service?.readAbortController.signal.removeEventListener('abort',h.abort);
    this.runtimeApp=closed();document.querySelector('#napplet-runtime-dialog')?.close();return true;
  },
  async refreshRuntimeAuthority(){await HOSTS.get(this)?.frame?.check();},
  async forgetRuntimeApproval(){const h=HOSTS.get(this);if(!h?.key)return;const key=h.key;if(this.closeRuntimeNapplet())revokeRuntimeApproval(key);},
  async runtimeAction(action){const h=HOSTS.get(this);if(!h?.current()||h.busy)return;h.busy=true;this.runtimeApp.error='';try{await action(h);if(h.current())await this.loadRuntimeCollections();}catch(error){if(h.current())this.runtimeApp.error=error.status===409?'A newer revision exists. Reopen before trying again.':error.message;}finally{h.busy=false;}},
  async loadRuntimeCollections(){
    const h=HOSTS.get(this);if(!h?.current())return;const rows=[];let cursor=null;const seen=new Set();
    do{const page=await h.transport.read(`${encodeURIComponent(h.id)}/collections?limit=100${cursor?`&after=${encodeURIComponent(cursor)}`:''}`,h.controller.signal);if(!h.current())return;
      if(!Array.isArray(page.collections))throw Error('Collections unavailable.');rows.push(...page.collections);cursor=page.next_cursor;if(cursor){if(seen.has(cursor)||seen.size>=100)throw Error('Collection pagination did not complete.');seen.add(cursor);}
    }while(cursor);
    if(h.current())this.runtimeApp.collections=rows;
  },
  createRuntimeCollection(name){return this.runtimeAction(async h=>{const d=h.installation.manifest.collections[name];if(!d)throw Error('Undeclared collection.');await h.transport.command(`${encodeURIComponent(h.id)}/collections`,'POST',{name,scope:d.scope,schema_version:d.schema_version,read_npubs:[],write_npubs:[]});});},
  get runtimeCollectionDeclarations(){if(this.runtimeApp.status!=='ready')return [];const h=HOSTS.get(this);return h?.current()?Object.entries(h.installation?.manifest.collections||{}).map(([name,d])=>({name,...d})):[];},
  shareRuntimeAudience(){return this.runtimeAction(async h=>{const latest=(await h.transport.read(encodeURIComponent(h.id),h.controller.signal)).installation;await h.transport.command(encodeURIComponent(h.id),'PATCH',{expected_revision:latest.revision,audience_npubs:npubs(this.runtimeApp.audience)});});},
  shareRuntimeData(){return this.runtimeAction(async h=>{const c=this.runtimeApp.collections.find(c=>c.id===this.runtimeApp.selectedCollection);if(!c)throw Error('Choose a collection.');await h.transport.command(`${encodeURIComponent(h.id)}/collections/${c.id}`,'PATCH',{expected_revision:c.revision,read_npubs:npubs(this.runtimeApp.dataReaders),write_npubs:npubs(this.runtimeApp.dataWriters)});});},
  async approveRuntimeUpdate(){await this.runtimeAction(async h=>{const latest=(await h.transport.read(encodeURIComponent(h.id),h.controller.signal)).installation;if(!latest.pending_release)throw Error('No pending update.');const unsupported=runtimeSupport(latest.pending_release.manifest);if(unsupported)throw Error(unsupported);const changes=accessExpansion(runtimeAccess(latest.manifest),runtimeAccess(latest.pending_release.manifest));if(!window.confirm('Approve expanded access: '+changes.join(', ')+'. Review the declared operations and scope before continuing. Personal host permissions remain separate.'))return;await h.transport.command(`${encodeURIComponent(h.id)}/releases/approve`,'POST',{expected_revision:latest.revision});});const h=HOSTS.get(this);if(h?.current())await this.openRuntimeNapplet(h.id);},
  selectRuntimeCollection(){const h=HOSTS.get(this),c=this.runtimeApp.collections.find(c=>c.id===this.runtimeApp.selectedCollection);try{if(!h?.current()||!c)return;h.frame?.detach();this.runtimeApp.html=null;h.data.collections.delete(c.name);h.data.selectCollection(c.name,c.id);(this.$nextTick||globalThis.Alpine?.nextTick||queueMicrotask)(()=>{if(h.current())this.runtimeApp.html=h.content;});this.runtimeApp.notice=`Using ${c.name} owned by ${c.owner_npub}. Access is rechecked on each operation.`;}catch(error){this.runtimeApp.error=error.message;}},
  reviewRuntimeMigration(){return this.runtimeAction(async h=>{h.migration=await reviewLegacySnapshot(canvasContext(this),this.runtimeApp.migrationFile,nappletTransport(this),h.controller.signal);if(!h.current())return;this.runtimeApp.migrationPreview=`Import the complete JSON snapshot from ${h.migration.displayName || h.migration.source.file_id}, immutable version ${h.migration.source.file_version_id}, as record legacy-snapshot. The app must support that record format. Original File and all history remain unchanged.`;});},
  importRuntimeMigration(){return this.runtimeAction(async h=>{const c=this.runtimeApp.collections.find(c=>c.id===this.runtimeApp.selectedCollection);if(!h.migration||!c)throw Error('Review a legacy File and choose your personal target collection.');const body=legacySnapshotMigration(c,h.installation.manifest,canvasContext(this).viewer,h.migration);if(!window.confirm(this.runtimeApp.migrationPreview + ' Confirm this app supports the complete snapshot format?'))return;const result=await h.transport.command(`${encodeURIComponent(h.id)}/collections/${c.id}/migrations`,'POST',body);if(result.source_preserved!==true||result.imported!==1)throw Error('Migration could not be confirmed. Check collection before retrying.');h.migration=null;this.runtimeApp.migrationPreview='';this.runtimeApp.notice='Legacy snapshot imported. Original File and history preserved; the old app remains usable.';});},
  async installRuntimeFile(){
    if(this.nappletInstall.busy)return;this.nappletInstall.busy=true;this.nappletInstall.error='';const context=canvasContext(this),partition=this.runtimeContextKey;
    try{const id=String(this.nappletInstall.input).trim(),files=nappletTransport(this),options={baseUrl:context.baseUrl,appNpub:context.appNpub};
      const f=(await files.getTowerPgFile(context.workspaceId,id,options)).file;if(f?.workspace_id!==context.workspaceId||f.id!==id||!f.current_version_id)throw Error('Code File unavailable.');
      const history=await files.getTowerPgFileVersions(context.workspaceId,id,options),v=history.versions?.find(v=>v.id===f.current_version_id);if(!v||v.file_id!==id||v.content_type!=='text/html'||v.size_bytes>2097152)throw Error('Readable HTML version required.');
      const object=await files.getTowerPgFileVersionObjectBytes(context.workspaceId,id,v.id,options),html=new TextDecoder('utf-8',{fatal:true}).decode(object.bytes);
      if(partition!==this.runtimeContextKey)throw Error('Workspace changed.');
      const publisher=npubs(this.runtimePublisher||context.viewer);if(publisher.length!==1)throw Error('One registered publisher npub is required.');
      const transport=runtimeTransport(this),manifest=parseRuntimeManifest(html);let existing=null;
      try{existing=(await transport.read(encodeURIComponent(manifest.napplet_id))).installation;}catch(error){if(error.status!==404)throw error;}
      if(partition!==this.runtimeContextKey)throw Error('Workspace changed.');
      const state=installationForReinstall(existing,{workspaceId:context.workspaceId,appNpub:context.appNpub,nappletId:manifest.napplet_id,requesterNpub:context.viewer,publisherNpub:publisher[0]});
      if(state.alreadyInstalled){this.nappletInstall.busy=false;this.closeAddNapplet();await this.openRuntimeNapplet(manifest.napplet_id);return;}
      const result=await publishNapplet({request:(path,o)=>transport.command(path,o.method,o.body),html,bundle:{file_id:id,file_version_id:v.id,sha256_hex:v.sha256_hex},requesterNpub:context.viewer,publisherNpub:publisher[0],expectedRevision:state.expectedRevision});
      if(partition!==this.runtimeContextKey)return;validateInstallation(result.installation,context,result.installation.napplet_id);await this.loadRuntimeApps({force:true});this.nappletInstall.busy=false;this.closeAddNapplet();await this.openRuntimeNapplet(result.installation.napplet_id);
    }catch(error){if(partition===this.runtimeContextKey)this.nappletInstall.error=error.message;}finally{this.nappletInstall.busy=false;}
  },
  async removeRuntimeNapplet(entry,data){
    const id=entry.nappletId||entry.napplet_id;if(!id)return;
    if(data==='delete'&&!window.confirm('Delete all collection records and collection history for this napplet? Source Files and their history remain. This requires ownership of every collection.'))return;
    if(data==='keep'&&!window.confirm('Remove this napplet and retain its collections and history for reinstall?'))return;
    if(HOSTS.get(this)?.id===id&&!this.closeRuntimeNapplet())return;
    try{const t=runtimeTransport(this),latest=(await t.read(encodeURIComponent(id))).installation;await t.command(encodeURIComponent(id),'DELETE',{expected_revision:latest.revision,data,...(data==='delete'?{confirm_napplet_id:id}:{})});await this.loadRuntimeApps({force:true});}catch(error){this.error=error.message;}
  },
};
