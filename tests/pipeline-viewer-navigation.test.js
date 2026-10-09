import { expect,it,vi } from 'vitest';
import { createShellState } from '../src/shell-state.js';
import { pipelineViewerManagerMixin } from '../src/pipeline-viewer-manager.js';
import { parseRouteLocation } from '../src/route-helpers.js';
it('opens a definition under Agents and preserves verified service/run route parameters',()=>{
  const store={...pipelineViewerManagerMixin,agentsEnabled:true,pipelineViewerEnabled:true,selectedAgentConnection:{installation_id:'service',metadata:{installation_npub:'signer'}},syncRoute:vi.fn()};
  store.openPipelineViewer({definitionId:'bird.timeline.chat.v2'});expect(store).toMatchObject({navSection:'agents',agentSpaceView:'pipelines',pipelineViewerOpen:true,pipelineViewerRoute:{service:'service',signer:'signer',definition:'bird.timeline.chat.v2'}});
  const route=parseRouteLocation('https://flightdeck.invalid/workspace/agents?viewer=1&service=service&signer=signer&run=historical');expect(route.params).toMatchObject({viewer:'1',service:'service',signer:'signer',run:'historical'});
  store.closePipelineViewer();expect(store.pipelineViewerOpen).toBe(false);expect(store.pipelineViewerRoute).toEqual({});
});
it('shell URL retains viewer identities independently of endpoint and clears them outside Agents',()=>{
  const shell=createShellState();const store={agentsEnabled:true,navSection:'agents',currentWorkspaceSlug:'workspace',currentWorkspaceKey:'key',selectedBoardId:null,selectedWorkspaceAgentId:'agent',agentSpaceView:'pipelines',pipelineViewerEnabled:true,pipelineViewerOpen:true,pipelineViewerRoute:{service:'installation',signer:'verified-signer',run:'run'},getRoutePath:()=>'/workspace/agents'};
  const previous=globalThis.window;globalThis.window={location:{href:'https://flightdeck.invalid/workspace/agents'}};
  try{const path=shell.buildRouteUrl.call(store);expect(path).toContain('service=installation');expect(path).toContain('signer=verified-signer');expect(path).toContain('run=run');expect(path).not.toContain('endpoint');store.navSection='chat';expect(shell.buildRouteUrl.call(store)).not.toContain('viewer=');}finally{globalThis.window=previous;}
});

it('pins historical structure and copies only the exact named port',async()=>{
  const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');const clipboard={writeText:vi.fn()};
  const view=createPipelineViewerView({clipboard});view.definitions=[{id:'latest',steps:[{logicalKey:'new'}]}];view.selectedDefinitionId='latest';
  expect(view.definition).toBeUndefined();expect(view.nodes).toEqual([]);
  view.inspector={complete:true,value:{response:'exact\ntext',sibling:'private sibling'}};view.inspectPath='response';
  expect(view.valueText).toBe('exact\ntext');await view.copy();expect(clipboard.writeText).toHaveBeenCalledWith('exact\ntext');
  view.inspectPath='missing';expect(view.valueText).toBe('');
});
it('child and parent navigation always select run mode',async()=>{
  const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');const view=createPipelineViewerView({store:{agentConnections:[]}});view.init();
  view.mode='definition';view.selectedRunId='parent';await view.openChild({childRunId:'child'});expect(view.mode).toBe('run');expect(view.parentTrail[0].id).toBe('parent');
  view.mode='definition';await view.backToParent();expect(view.mode).toBe('run');expect(view.parentTrail).toEqual([]);view.destroy();
});
it('a changed verified deep link adopts its service and aborts the prior client',async()=>{
  const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');const connection=id=>({id,installation_id:id,capabilities:['pipelines.viewer.read.v1'],fips_endpoint:'http://peer.fips:43101',fips_transport_npub:'peer',metadata:{installation_npub:'signer',health_path:'/api/owners/owner/control-plane/v1/health',pipeline_viewer_path:'/api/owners/owner/control-plane/v1/pipeline-viewer'}});
  const connections=[connection('one'),connection('two')],clients=[];const services=[];
  const shell={agentConnections:connections,selectedAgentConnection:connections[0],currentWorkspace:{towerServiceNpub:'tower'}};
  const view=createPipelineViewerView({enabled:true,store:shell,isDbReady:()=>true,getDb:()=>({}),createStore:()=>({observe:()=>({subscribe:()=>({unsubscribe(){}})}),state:vi.fn()}),createConnection:()=>{const client={health:async()=>{},disconnect:vi.fn()};clients.push(client);return client;},createClient:()=>({}),createService:({connection})=>{const service={initialize:async()=>{await connection.health();return true},subscribeValues:()=>()=>{},list:async()=>{},selectRun:vi.fn(),start:async()=>{},dispose:vi.fn(()=>connection.disconnect())};services.push(service);return service;}});view.init();
  const previous=globalThis.location;try{
    globalThis.location={search:'?service=one&signer=signer&run=first'};await view.sync('workspace','actor','db','backend',connections,true);
    view.mode='definition';globalThis.location={search:'?service=two&signer=signer&run=second'};await view.sync('workspace','actor','db','backend',connections,true);
    expect(view.mode).toBe('run');expect(view.selectedConnectionId).toBe('two');expect(clients[0].disconnect).toHaveBeenCalled();expect(services[0].dispose).toHaveBeenCalled();expect(services[1].selectRun).toHaveBeenCalledWith('second');
  }finally{globalThis.location=previous;view.destroy();}
});
it('bounds rendered records while searching and copying any of 5000 exact records',async()=>{
 const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');const clipboard={writeText:vi.fn()};const view=createPipelineViewerView({clipboard});
 const values=Array.from({length:5000},(_,index)=>({text:`Exact record ${index+1}`,nested:{index}}));view.inspectPath='tweets';view.inspector={status:'ready',complete:true,value:{tweets:values,privateSibling:'excluded'}};
 expect(view.shownRecords).toHaveLength(50);expect(view.recordPageSummary).toBe('1–50 of 5000 loaded records · Page 1 of 100');
 view.changeRecordPage(100);expect(view.shownRecords.at(-1).index).toBe(4999);expect(view.shownRecords).toHaveLength(50);
 view.searchRecords('Exact record 5000');expect(view.currentRecordPage).toBe(1);expect(view.shownRecords).toHaveLength(1);
 await view.copyRecord(view.shownRecords[0]);expect(clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify(values[4999],null,2));
 await view.copy();expect(clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify(values,null,2));
 view.searchRecords('no such record');expect(view.shownRecords).toEqual([]);expect(view.recordPageSummary).toContain('0–0 of 0 matching');
 view.searchRecords('');view.changeRecordPage(9999);expect(view.currentRecordPage).toBe(100);view.inspector.value.tweets=values.slice(0,52);expect(view.currentRecordPage).toBe(2);expect(view.shownRecords).toHaveLength(2);
 view.closeInspector();expect(view.recordPage).toBe(1);expect(view.matchingRecords).toEqual([]);
});
it('blocks disabled open attempts, route publication and initialization before any viewer read',async()=>{
 const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');const syncRoute=vi.fn(),store={...pipelineViewerManagerMixin,agentsEnabled:true,pipelineViewerEnabled:false,selectedAgentConnection:{installation_id:'service'},syncRoute};
 store.openPipelineViewer({runId:'private-run'});expect(store.pipelineViewerOpen).toBe(false);expect(store.pipelineViewerActivationPending).toBe(true);expect(store.pipelineViewerRoute).toEqual({});expect(syncRoute).not.toHaveBeenCalled();
 const createConnection=vi.fn(),getDb=vi.fn();const view=createPipelineViewerView({enabled:false,createConnection,getDb});await view.sync('workspace','actor','db','backend',[],true);expect(view.status).toBe('pending');expect(getDb).not.toHaveBeenCalled();expect(createConnection).not.toHaveBeenCalled();
 const previous=globalThis.window;globalThis.window={location:{href:'https://flightdeck.invalid/workspace/agents'}};
 try{const shell=createShellState();expect(shell.buildRouteUrl.call({pipelineViewerEnabled:false,pipelineViewerOpen:true,pipelineViewerRoute:{service:'service',run:'private-run'},navSection:'agents',getRoutePath:()=>'/workspace/agents'})).not.toContain('viewer=');}finally{globalThis.window=previous;}
});
