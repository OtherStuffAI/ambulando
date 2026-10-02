import template from './pipeline-viewer.html?raw';
import { APP_NPUB } from './app-identity.js';
import { getWorkspaceDb, isWorkspaceDbOpenForKey } from './db.js';
import { storedPackage } from './autopilot-connection-refresh.js';
import { createAutopilotDiscoveryClient } from './autopilot-connect-client.js';
import { createPipelineViewerClient } from './pipeline-viewer-client.js';
import { createPipelineViewerStore } from './pipeline-viewer-store.js';
import { createPipelineViewerService } from './pipeline-viewer-service.js';
import { viewerContextKey, viewerFailure } from './pipeline-viewer-contract.js';
import { pipelineNodes, flattenPipelineNodes, evidenceText, evidencePreview, portValue, matchingWires } from './pipeline-viewer-projection.js';
import { parsePipelineViewerRoute } from './pipeline-viewer-route.js';

const views = new WeakMap();
export function disposePipelineViewer(store) { views.get(store)?.suspend(); }
export function resumePipelineViewer(store) { views.get(store)?.resume(); }
export function createPipelineViewerView(deps = {}) {
  let shell, db, service, connectionClient, subscription, offValues, healthController, generation=0, queued=0, key='', destroyed=false;
  let selectedRef=null, returnFocus=null, routeKey='', restoringFocus=false;
  const database=deps.getDb || getWorkspaceDb;
  return {
    template, status:'unloaded', stale:false, definitions:[], runs:[], snapshot:null, selectedRunId:'', selectedDefinitionId:'',
    selectedConnectionId:'', parentTrail:[], pinned:false, inspector:null, inspectLabel:'', inspectPath:'', preview:'', search:'', notice:'',
    definitionsCursor:null, runsCursor:null, mode:'run',
    init() { shell=deps.store || this.$store.chat; views.set(shell,this); },
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
        nextKey=viewerContextKey(context)+JSON.stringify([dbKey,connection.capabilities]);
      }catch{this.suspend();this.status='unavailable';return;}
      const nextRoute=JSON.stringify([route.serviceId,route.serviceNpub,route.runId,route.definitionId]);
      if(nextKey===key){
        if(nextRoute!==routeKey && route.status==='verified'){routeKey=nextRoute;this.closeInspector();this.parentTrail=[];if(route.runId){this.mode='run';await service?.selectRun(route.runId);}else if(route.definitionId){this.mode='definition';await service?.selectDefinition(route.definitionId);}}
        return;
      }
      this.suspend();key=nextKey;routeKey=nextRoute;this.status='loading';const epoch=generation;
      db=database();
      const store=(deps.createStore||createPipelineViewerStore)(db,context);
      connectionClient=(deps.createConnection||createAutopilotDiscoveryClient)(verified);
      const client=(deps.createClient||createPipelineViewerClient)(connectionClient,context);
      service=(deps.createService||createPipelineViewerService)({client,store});
      subscription=store.observe().subscribe({next:projection=>{
        if(epoch!==generation)return;
        this.status=projection.state.status;this.stale=projection.state.stale===true;this.definitions=projection.definitions;this.runs=projection.runs;this.snapshot=projection.snapshot;
        this.selectedRunId=projection.state.selectedRunId||'';this.selectedDefinitionId=projection.state.selectedDefinitionId||'';
        this.definitionsCursor=projection.state.definitionsCursor;this.runsCursor=projection.state.runsCursor;
      },error:()=>{if(epoch===generation){this.status='unavailable';this.snapshot=null;}}});
      offValues=service.subscribeValues(()=>{
        if(epoch!==generation)return;
        this.inspector=selectedRef?service.value(selectedRef.id):null;
        this.preview=this.inspector?.status==='ready'?evidencePreview(this.inspectPath?portValue(this.inspector.value,this.inspectPath):this.inspector.value):'';
      });
      try {
        healthController=new AbortController();await connectionClient.health(healthController.signal);if(epoch!==generation)return;
        if(route.status==='verified'&&route.connection.id===connection.id&&route.runId){this.mode='run';await service.list('definitions');await service.list('runs');await service.selectRun(route.runId);}
        else if(route.status==='verified'&&route.definitionId){this.mode='definition';await service.list('definitions');await service.selectDefinition(route.definitionId);}
        else await service.start();
      }catch(error){if(epoch===generation){await store.state({status:viewerFailure(error)});}}
    },
    suspend() {
      generation++;queued++;key='';healthController?.abort();healthController=null;subscription?.unsubscribe();subscription=null;offValues?.();offValues=null;
      service?.dispose();service=null;void connectionClient?.disconnect?.();connectionClient=null;selectedRef=null;returnFocus=null;
      this.status='unloaded';this.selectedRunId='';this.selectedDefinitionId='';this.stale=false;this.definitions=[];this.runs=[];this.snapshot=null;this.inspector=null;this.preview='';this.pinned=false;this.search='';this.parentTrail=[];
    },
    resume(){this.queueSync(shell.currentWorkspace?.workspaceId,shell.signingNpub,shell.workspaceDbKey,shell.backendUrl,shell.agentConnections,shell.navSection==='agents'&&shell.pipelineViewerOpen);},
    destroy(){destroyed=true;this.suspend();views.delete(shell);},
    get connections(){return shell?.agentConnections||[];},
    get definition(){return this.mode==='definition'?this.definitions.find(row=>row.id===this.selectedDefinitionId)||this.snapshot?.definition:this.snapshot?.definition;},
    get nodes(){return flattenPipelineNodes(pipelineNodes(this.definition,this.mode==='run'?this.snapshot:null));},
    get wires(){return this.definition?.wiring||[];},
    get transformedWires(){return this.wires.filter(wire=>!wire.carriedForward);},
    get carriedWires(){return this.wires.filter(wire=>wire.carriedForward);},
    get statusMessage(){return {unloaded:'Choose a verified Autopilot service.',loading:'Loading pipeline viewer…',empty:'No pipelines or runs available.',unavailable:'Pipeline viewer unavailable for this service, record or capability.',denied:'Pipeline viewer access denied.',disconnected:'Autopilot disconnected. Retained summaries may be stale.',ready:this.stale?'Showing stale summaries.':'Pipeline viewer ready.'}[this.status]||this.status;},
    get inspectedValue(){return this.inspectPath?portValue(this.inspector?.value,this.inspectPath):this.inspector?.value;},
    get valueText(){return evidenceText(this.inspectedValue);},
    get shownRecords(){const values=this.inspectedValue;if(!Array.isArray(values))return [];const term=this.search.toLocaleLowerCase();return values.map((value,index)=>({value,index,text:evidenceText(value)})).filter(row=>!term||row.text.toLocaleLowerCase().includes(term));},
    get valueMatches(){return !this.search||this.valueText.toLocaleLowerCase().includes(this.search.toLocaleLowerCase());},
    text:evidenceText,
    wireLabel(wire){const name=key=>this.nodes.find(node=>node.logicalKey===key)?.title||key;return `${name(wire.sourceStepKey)} · ${wire.sourcePath} → ${name(wire.targetStepKey)} · ${wire.targetPath}`;},
    outgoingWires(node){return this.transformedWires.filter(wire=>wire.sourceStepKey===node.logicalKey);},
    highlighted(node){return this.inspectPath&&matchingWires(this.wires,this.inspectLabel,this.inspectPath).some(wire=>wire.sourceStepKey===node.logicalKey||wire.targetStepKey===node.logicalKey);},
    setRoute(runId='',definitionId='') {
      const connection=this.connections.find(row=>row.id===this.selectedConnectionId);if(!connection)return;
      routeKey=JSON.stringify([connection.installation_id,connection.metadata?.installation_npub,runId,definitionId]);
      shell.pipelineViewerRoute={service:connection.installation_id,signer:connection.metadata?.installation_npub,run:runId,definition:definitionId};
      shell.syncRoute?.();
    },
    async chooseConnection(id){this.selectedConnectionId=id;this.suspend();this.setRoute();},
    async chooseDefinition(id){this.closeInspector();this.parentTrail=[];this.mode='definition';await service?.selectDefinition(id);this.setRoute('',id);},
    async chooseRun(id){this.closeInspector();this.parentTrail=[];this.mode='run';await service?.selectRun(id);this.setRoute(id);},
    async openChild(step){if(!step.childRunId)return;const trail=[...this.parentTrail,{id:this.selectedRunId,title:this.snapshot?.run.name||'Parent run'}];this.closeInspector();this.mode='run';await service?.selectRun(step.childRunId);this.parentTrail=trail;this.setRoute(step.childRunId);},
    async backToParent(){const trail=[...this.parentTrail];const parent=trail.pop();if(!parent)return;this.closeInspector();this.mode='run';await service?.selectRun(parent.id);this.parentTrail=trail;this.setRoute(parent.id);},
    async retry(){await service?.recover();},
    async moreRuns(){await service?.list('runs',this.runsCursor);},
    async moreDefinitions(){await service?.list('definitions',this.definitionsCursor);},
    portPreview(node,side,port){const step=node.attempts.at(-1);const ref=this.portReference(step,side);const cached=ref?service?.value(ref.id):null;return cached?.status==='ready'?evidencePreview(portValue(cached.value,port.path)):this.mode==='definition'?port.format||'Configured field':'Preview available on focus';},
    portReference(step,side){return step?.evidence.find(ref=>ref.kind===(side==='inputs'?'resolved_input':'returned_output'));},
    async inspectPort(node,side,port,event,pin=false){
      if(restoringFocus || (this.pinned&&!pin))return;
      this.inspectPath=port.path;this.inspectLabel=node.logicalKey;
      const step=node.attempts.at(-1),ref=this.portReference(step,side);
      if(ref)await this.inspect(ref,event,pin,true);else{this.inspector=null;selectedRef=null;this.preview=this.mode==='definition'?`Configured ${port.format||'value'} · ${port.path}`:'Not captured for this attempt.';this.pinned=pin;}
    },
    async inspect(ref,event,pin=true,port=false){if(restoringFocus || (this.pinned&&!pin))return;if(!port){this.inspectPath='';this.inspectLabel='';}selectedRef=ref;returnFocus=event?.currentTarget||returnFocus;this.pinned=pin;this.search='';this.notice='';this.inspector=service?.value(ref.id);await service?.evidence(ref);},
    async moreEvidence(){if(selectedRef)await service?.evidence(selectedRef,true);},
    closeInspector(){selectedRef=null;this.inspector=null;this.preview='';this.pinned=false;this.search='';this.inspectPath='';this.inspectLabel='';service?.clearValues();restoringFocus=true;returnFocus?.focus?.();restoringFocus=false;returnFocus=null;},
    async copy(){if(!this.inspector?.complete){this.notice='Load the complete retained value before copying.';return;}try{await (deps.clipboard||navigator.clipboard).writeText(this.valueText);this.notice='Complete retained value copied.';}catch{this.notice='Copy unavailable. Select the exact text to copy.';}},
  };
}
