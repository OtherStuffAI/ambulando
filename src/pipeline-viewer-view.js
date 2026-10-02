import { renderPipelineConnections } from './pipeline-viewer-diagram.js';
import template from './pipeline-viewer.html?raw';
import { APP_NPUB } from './app-identity.js';
import { getWorkspaceDb, isWorkspaceDbOpenForKey } from './db.js';
import { storedPackage } from './autopilot-connection-refresh.js';
import { createPipelineViewerStore } from './pipeline-viewer-store.js';
import { createPipelineViewerSession } from './pipeline-viewer-service.js';
import { viewerContextKey } from './pipeline-viewer-contract.js';
import { pipelineNodes, flattenPipelineNodes, evidenceText, evidencePreview, portValue, portSelection, latestPortReference, wiringPortPath, wiringEndpoints, diagramPorts, matchingWires } from './pipeline-viewer-projection.js';
import { parsePipelineViewerRoute } from './pipeline-viewer-route.js';

const views = new WeakMap();
export function disposePipelineViewer(store) { views.get(store)?.suspend(); }
export function resumePipelineViewer(store) { views.get(store)?.resume(); }
export function createPipelineViewerView(deps = {}) {
  let shell, db, service, subscription, offValues, generation=0, queued=0, key='', destroyed=false;
  let selectedRef=null, returnFocus=null, routeKey='', restoringFocus=false, navigation=0, observer=null, mutations=null, geometryQueued=false;
  const database=deps.getDb || getWorkspaceDb;
  return {
    template, status:'unloaded', stale:false, definitions:[], runs:[], snapshot:null, selectedRunId:'', selectedDefinitionId:'',
    selectedConnectionId:'', parentTrail:[], pinned:false, inspector:null, inspectLabel:'', inspectPath:'', preview:'', search:'', notice:'',
    definitionsCursor:null, runsCursor:null, mode:'run', inspectSide:'', inspectExecutionId:'', inspectEvidenceId:'', previewRevision:0, edges:[], diagramWidth:0, diagramHeight:0,
    init() { shell=deps.store || this.$store.chat; views.set(shell,this); if(globalThis.ResizeObserver && this.$el){observer=new ResizeObserver(()=>this.queueGeometry());observer.observe(this.$el);mutations=new MutationObserver(records=>{if(records.some(record=>record.target.closest?.('.pipeline-viewer-steps')))this.queueGeometry();});mutations.observe(this.$el,{childList:true,subtree:true,characterData:true});} },
    queueGeometry() { if(geometryQueued || destroyed)return;geometryQueued=true;const measure=()=>{const run=()=>{geometryQueued=false;this.measureConnections();};if(globalThis.requestAnimationFrame)requestAnimationFrame(run);else run();};if(this.$nextTick)this.$nextTick(measure);else queueMicrotask(measure); },
    measureConnections() {
      const canvas=this.$el?.querySelector('.pipeline-viewer-canvas');if(!canvas)return;
      const rect=canvas.getBoundingClientRect(),ports=[...canvas.querySelectorAll('[data-port-node]')];
      const find=(node,side,path)=>ports.find(el=>el.dataset.portNode===node&&el.dataset.portSide===side&&el.dataset.portPath===path);
      this.diagramWidth=canvas.scrollWidth;this.diagramHeight=canvas.scrollHeight;
      this.edges=this.transformedWires.flatMap((wire,wireIndex)=>wiringEndpoints(wire).flatMap((endpoint,portIndex)=>{
        const index=wireIndex*100+portIndex;
        const source=find(wire.sourceStepKey,'outputs',endpoint.sourcePath),target=find(wire.targetStepKey,'inputs',endpoint.targetPath);if(!source||!target)return [];
        const a=source.getBoundingClientRect(),b=target.getBoundingClientRect(),mobile=globalThis.innerWidth<=850;
        const x1=a.right-rect.left,y1=a.top+a.height/2-rect.top,x2=mobile?b.right-rect.left:b.left-rect.left,y2=b.top+b.height/2-rect.top;
        const lane=mobile?Math.max(x1,x2)+16+(index%3)*10:Math.max(x1+20,(x1+x2)/2);
        return [{wire,index,path:mobile?`M ${x1} ${y1} H ${lane} V ${y2} H ${x2}`:`M ${x1} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${x2} ${y2}`,labelX:mobile?lane-4:(x1+x2)/2,labelY:mobile?(y1+y2)/2:Math.min(y1,y2)-10,label:(source.querySelector('span')?.textContent||wire.sourcePath)+' → '+(target.querySelector('span')?.textContent||wire.targetPath)}];
      }));
      renderPipelineConnections(canvas.querySelector('svg'),this.edges,this.diagramWidth,this.diagramHeight,wire=>this.wireSelected(wire));
    },
    queueSync(workspaceId, actorNpub, dbKey, backend, connections, enabled, routeParams) {
      const ticket=++queued;
      queueMicrotask(()=>{if(ticket===queued&&!destroyed) void this.sync(workspaceId,actorNpub,dbKey,backend,connections,enabled);});
    },
    async sync(workspaceId,actorNpub,dbKey,backend,connections,enabled) {
      if(!enabled||!workspaceId||!actorNpub||!(deps.isDbReady||isWorkspaceDbOpenForKey)(dbKey)) { if(key)this.suspend();return; }
      const search=globalThis.location?.search || '';
      const route=parsePipelineViewerRoute(search,connections);
      if(new URLSearchParams(search).has('service') && route.status!=='verified'){this.suspend();this.status='unavailable';return;}
      if(route.status==='verified') this.selectedConnectionId=route.connection.id;
      else if(!this.selectedConnectionId) this.selectedConnectionId=shell.selectedAgentConnection?.id || '';
      const connection=connections.find(row=>row.id===this.selectedConnectionId&&!row.archived_at&&row.installation_identity_verified!==false);
      if(!connection) {this.suspend();this.status='unavailable';return;}
      let verified,context,nextKey;
      try {
        verified=storedPackage(connection);
        const owner=verified.healthPath.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/health$/)?.[1];
        context={backend,workspaceId,actorNpub,serviceId:verified.installationId,serviceNpub:verified.installationNpub,
          agentNpub:shell.selectedWorkspaceAgent?.agent_npub||'',ownerNpub:owner?decodeURIComponent(owner):'',towerServiceNpub:shell.currentWorkspace?.towerServiceNpub||shell.currentWorkspace?.serviceNpub||shell.currentWorkspace?.tower_service_npub,appNpub:shell.currentWorkspace?.sourceAppNpub||APP_NPUB};
        nextKey=viewerContextKey(context)+JSON.stringify([dbKey,verified]);
      }catch{this.suspend();this.status='unavailable';return;}
      const nextRoute=JSON.stringify([route.serviceId,route.serviceNpub,route.runId,route.definitionId]);
      if(nextKey===key){
        if(nextRoute!==routeKey && route.status==='verified'){const ticket=++navigation;routeKey=nextRoute;this.closeInspector();this.parentTrail=[];const current=service;await current?.list('definitions');if(ticket!==navigation||current!==service)return;await current?.list('runs');if(ticket!==navigation||current!==service)return;if(route.runId){this.mode='run';await service?.selectRun(route.runId);}else if(route.definitionId){this.mode='definition';await service?.selectDefinition(route.definitionId);}}
        return;
      }
      this.suspend();this.selectedConnectionId=connection.id;key=nextKey;routeKey=nextRoute;this.status='loading';const epoch=generation;
      db=database();
      const store=(deps.createStore||createPipelineViewerStore)(db,context);
      service=createPipelineViewerSession({verified,context,store,deps});
      subscription=store.observe().subscribe({next:projection=>{
        if(epoch!==generation)return;
        this.status=projection.state.status;this.stale=projection.state.stale===true;this.definitions=projection.definitions;this.runs=projection.runs;this.snapshot=projection.snapshot;
        if(['denied','unavailable'].includes(this.status)){navigation++;this.closeInspector();this.parentTrail=[];}
        this.queueGeometry();this.selectedRunId=projection.state.selectedRunId||'';this.selectedDefinitionId=projection.state.selectedDefinitionId||'';
        this.definitionsCursor=projection.state.definitionsCursor;this.runsCursor=projection.state.runsCursor;
      },error:()=>{if(epoch===generation){this.status='unavailable';this.snapshot=null;}}});
      offValues=service.subscribeValues(()=>{
        if(epoch!==generation)return;
        this.previewRevision++;this.inspector=selectedRef?service.value(selectedRef.id):null;
        this.preview=this.inspector?.status==='ready'?evidencePreview(this.inspectPath?portValue(this.inspector.value,this.inspectPath):this.inspector.value):'';
      });
      {
        if(!await service.initialize()||epoch!==generation)return;
        if(route.status==='verified'&&route.connection.id===connection.id&&route.runId){this.mode='run';await service.list('definitions');if(epoch!==generation)return;await service.list('runs');if(epoch!==generation)return;await service.selectRun(route.runId);}
        else if(route.status==='verified'&&route.definitionId){this.mode='definition';await service.list('definitions');if(epoch!==generation)return;await service.selectDefinition(route.definitionId);}
        else await service.start();
      }
    },
    suspend() {
      generation++;navigation++;queued++;key='';subscription?.unsubscribe();subscription=null;offValues?.();offValues=null;
      service?.dispose();service=null;selectedRef=null;returnFocus=null;
      this.mode='run';this.edges=[];this.inspectSide='';this.inspectExecutionId='';this.inspectEvidenceId='';this.selectedConnectionId='';this.status='unloaded';this.selectedRunId='';this.selectedDefinitionId='';this.stale=false;this.definitions=[];this.runs=[];this.snapshot=null;this.inspector=null;this.preview='';this.pinned=false;this.search='';this.parentTrail=[];
    },
    resume(){this.queueSync(shell.currentWorkspace?.workspaceId,shell.signingNpub,shell.workspaceDbKey,shell.backendUrl,shell.agentConnections,shell.navSection==='agents'&&shell.pipelineViewerOpen);},
    destroy(){destroyed=true;observer?.disconnect();mutations?.disconnect();this.suspend();views.delete(shell);},
    get connections(){return shell?.agentConnections||[];},
    get definition(){return this.mode==='definition'?this.definitions.find(row=>row.id===this.selectedDefinitionId)||this.snapshot?.definition:this.snapshot?.definition;},
    get nodes(){return flattenPipelineNodes(pipelineNodes(this.definition,this.mode==='run'?this.snapshot:null));},
    get wires(){return this.definition?.wiring||[];},
    get transformedWires(){return this.wires.filter(wire=>!wire.carriedForward);},
    get carriedWires(){return this.wires.filter(wire=>wire.carriedForward);},
    get statusMessage(){return {unloaded:'Choose a verified Autopilot service.',loading:'Loading pipeline viewer…',empty:'No pipelines or runs available.',unavailable:'Pipeline viewer unavailable for this service, record or capability.',denied:'Pipeline viewer access denied.',disconnected:'Autopilot disconnected. Retained summaries may be stale.',ready:this.stale?'Showing stale summaries.':'Pipeline viewer ready.'}[this.status]||this.status;},
    get inspectedValue(){return this.inspectPath?portValue(this.inspector?.value,this.inspectPath):this.inspector?.value;},
    get fieldStatus(){return this.inspector?.status==='ready'&&this.inspectPath?portSelection(this.inspector.value,this.inspectPath).status:'present';},
    get valueText(){return evidenceText(this.inspectedValue);},
    get shownRecords(){const values=this.inspectedValue;if(!Array.isArray(values))return [];const term=this.search.toLocaleLowerCase();return values.map((value,index)=>({value,index,text:evidenceText(value)})).filter(row=>!term||row.text.toLocaleLowerCase().includes(term));},
    get valueMatches(){return !this.search||this.valueText.toLocaleLowerCase().includes(this.search.toLocaleLowerCase());},
    text:evidenceText,
    wireLabel(wire){const name=key=>this.nodes.find(node=>node.logicalKey===key)?.title||key;return `${name(wire.sourceStepKey)} · ${wire.sourcePath} → ${name(wire.targetStepKey)} · ${wire.targetPath}`;},
    wireSelected(wire){return matchingWires([wire],this.inspectLabel,this.inspectPath,this.inspectSide).length>0;},
    async inspectWire(wire,event){const node=this.nodes.find(row=>row.logicalKey===wire.sourceStepKey),port=node?this.ports(node,'outputs').find(row=>row.path===wiringEndpoints(wire)[0].sourcePath):null;if(port)await this.inspectPort(node,'outputs',port,event,true);},
    ports(node,side){return diagramPorts(node,side,this.wires);},
    outgoingWires(node){return this.transformedWires.filter(wire=>wire.sourceStepKey===node.logicalKey);},
    highlighted(node){return this.inspectPath&&matchingWires(this.wires,this.inspectLabel,this.inspectPath,this.inspectSide).some(wire=>wire.sourceStepKey===node.logicalKey||wire.targetStepKey===node.logicalKey);},
    setRoute(runId='',definitionId='') {
      const connection=this.connections.find(row=>row.id===this.selectedConnectionId);if(!connection)return;
      routeKey=JSON.stringify([connection.installation_id,connection.metadata?.installation_npub,runId,definitionId]);
      shell.pipelineViewerRoute={service:connection.installation_id,signer:connection.metadata?.installation_npub,run:runId,definition:definitionId};
      shell.syncRoute?.();
    },
    async chooseConnection(id){this.suspend();this.selectedConnectionId=id;this.setRoute();},
    async navigateSelection(id, mode, trail=[]) {
      const ticket=++navigation,epoch=generation,current=service;
      this.closeInspector();this.mode=mode;
      if(mode==='run')await current?.selectRun(id);else await current?.selectDefinition(id);
      if(ticket!==navigation||epoch!==generation||current!==service||destroyed||['denied','unavailable'].includes(this.status))return;
      this.parentTrail=trail;this.setRoute(mode==='run'?id:'',mode==='definition'?id:'');
    },
    async chooseDefinition(id){await this.navigateSelection(id,'definition');},
    async chooseRun(id){await this.navigateSelection(id,'run');},
    async openChild(step){if(!step.childRunId)return;await this.navigateSelection(step.childRunId,'run',[...this.parentTrail,{id:this.selectedRunId,title:this.snapshot?.run.name||'Parent run'}]);},
    async backToParent(){const trail=[...this.parentTrail],parent=trail.pop();if(parent)await this.navigateSelection(parent.id,'run',trail);},
    deliveryPreview(step){void this.previewRevision;const ref=step.evidence.filter(row=>row.kind==='side_effect_confirmation').at(-1);const preview=ref?service?.preview?.(ref.id):null;return preview?evidencePreview(preview.value)+(preview.truncated?' · bounded excerpt':' · bounded preview'):'';},
    deliveryLink(step){void this.previewRevision;const ref=step.evidence.filter(row=>row.kind==='side_effect_confirmation').at(-1),preview=ref?service?.preview?.(ref.id):null;if(!preview||preview.truncated)return '';try{const url=new URL(preview.value?.url||preview.value?.link);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}},
    async retry(){await service?.recover();},
    async moreRuns(){await service?.list('runs',this.runsCursor);},
    async moreDefinitions(){await service?.list('definitions',this.definitionsCursor);},
    portPreview(node,side,port){
      void this.previewRevision;
      const step=node.attempts.at(-1),ref=this.portReference(step,side,port),cached=ref?service?.value(ref.id):null;
      if(cached?.status==='ready'){const selected=portSelection(cached.value,port.path);return selected.status==='missing'?'Selected field is missing':selected.status==='null'?'Explicit null':evidencePreview(selected.value);}
      if(this.mode==='definition')return port.format||'Configured field';
      const preview=ref?service?.preview?.(ref.id):null;
      if(!preview)return ref?.availability==='not_captured'?'Not captured':'Bounded preview unavailable';
      const selected=portSelection(preview.value,port.path);
      if(selected.status==='missing')return preview.truncated?'Field outside bounded preview':'Selected field is missing';
      const path=port.path==='$'?'$':'$.'+port.path.replace(/^\$\.?/,'');
      const count=preview.counts?.[path]??(port.path==='$'?preview.count:null);
      return `${count!=null?count+' records · ':''}${selected.status==='null'?'Explicit null':evidenceText(selected.value).slice(0,180)}${preview.truncated?' · bounded excerpt':' · bounded preview'}`;
    },
    portReference:latestPortReference,
    async inspectPort(node,side,port,event,pin=false,execution=null){
      if(restoringFocus || (this.pinned&&!pin))return;
      this.inspectPath=port.path;this.inspectLabel=node.logicalKey;this.inspectSide=side;
      const step=execution||node.attempts.at(-1),ref=this.portReference(step,side,port);this.inspectExecutionId=step?.id||'';this.inspectEvidenceId=ref?.id||'';
      if(ref&&pin)await this.inspect(ref,event,true,true);else if(ref){selectedRef=null;this.inspector=null;this.preview=this.portPreview(node,side,port);returnFocus=event?.currentTarget||returnFocus;}else{this.inspector=null;selectedRef=null;this.preview=this.mode==='definition'?`Configured ${port.format||'value'} · ${port.path}`:'Not captured for this attempt.';this.pinned=pin;}
    },
    async inspect(ref,event,pin=true,port=false){if(restoringFocus || (this.pinned&&!pin))return;if(!port){this.inspectPath='';this.inspectLabel='';this.inspectSide='';this.inspectExecutionId=ref.stepId;this.inspectEvidenceId=ref.id;}selectedRef=ref;returnFocus=event?.currentTarget||returnFocus;this.pinned=pin;this.search='';this.notice='';this.inspector=service?.value(ref.id);await service?.evidence(ref);},
    async moreEvidence(){if(selectedRef)await service?.evidence(selectedRef,true);},
    closeInspector(){selectedRef=null;this.inspector=null;this.preview='';this.pinned=false;this.search='';this.inspectPath='';this.inspectLabel='';this.inspectSide='';this.inspectExecutionId='';this.inspectEvidenceId='';service?.clearValues();restoringFocus=true;returnFocus?.focus?.();restoringFocus=false;returnFocus=null;},
    async copyRecord(record){try{await (deps.clipboard||navigator.clipboard).writeText(record.text);this.notice='Loaded record copied.';}catch{this.notice='Copy unavailable. Select the exact text to copy.';}},
    async copy(){if(this.fieldStatus==='missing'){this.notice='Selected field is missing from retained evidence.';return;}if(!this.inspector?.complete){this.notice='Load the complete retained value before copying.';return;}try{await (deps.clipboard||navigator.clipboard).writeText(this.valueText);this.notice='Complete retained value copied.';}catch{this.notice='Copy unavailable. Select the exact text to copy.';}},
  };
}
