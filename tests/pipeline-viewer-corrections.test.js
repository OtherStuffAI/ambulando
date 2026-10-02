import { readFileSync, readdirSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { snapshotDto } from '../src/pipeline-viewer-contract.js';
import { pipelineNodes, flattenPipelineNodes, matchingWires, latestPortReference, portSelection, wiringEndpoints } from '../src/pipeline-viewer-projection.js';
import { createPipelineViewerView } from '../src/pipeline-viewer-view.js';

it('selects the side and latest durable capture independently of execution ordinal',()=>{
 const wires=[{sourceStepKey:'before',sourcePath:'value',targetStepKey:'node',targetPath:'value'},{sourceStepKey:'node',sourcePath:'value',targetStepKey:'after',targetPath:'value'}];
 expect(matchingWires(wires,'node','value','inputs')).toEqual([wires[0]]);
 expect(matchingWires(wires,'node','value','outputs')).toEqual([wires[1]]);
 const evidence=[{id:'old',kind:'returned_output',attempt:1},{id:'winning',kind:'returned_output',attempt:3}];
 expect(latestPortReference({attempt:7,evidence},'outputs').id).toBe('winning');
 expect(portSelection({nested:{values:[null,'exact']}},'nested.values.0')).toEqual({status:'null',value:null});
 expect(portSelection({nested:{values:[null,'exact']}},'nested.missing')).toEqual({status:'missing',value:undefined});
 expect(portSelection({nested:{values:[null,'exact']},sibling:'private'},'nested.values.1').value).toBe('exact');
});

const connection=id=>({id,installation_id:id,capabilities:['pipelines.viewer.read.v1'],fips_endpoint:'http://peer.fips:43101',fips_transport_npub:'peer',metadata:{installation_npub:'signer',health_path:'/api/owners/owner/control-plane/v1/health',pipeline_viewer_path:'/api/owners/owner/control-plane/v1/pipeline-viewer'}});
async function harness(){
 const connections=[connection('one'),connection('two')],pending=new Map(),routes=[];let projection;
 const shell={agentConnections:connections,currentWorkspace:{towerServiceNpub:'tower'},syncRoute(){routes.push({...this.pipelineViewerRoute})}};
 const service={initialize:async()=>true,subscribeValues:()=>()=>{},clearValues(){},list:vi.fn(async()=>{}),selectRun:vi.fn(id=>new Promise(resolve=>pending.set(id,resolve))),selectDefinition:vi.fn(id=>new Promise(resolve=>pending.set(id,resolve))),start:async()=>{},dispose:vi.fn()};
 const view=createPipelineViewerView({enabled:true,store:shell,isDbReady:()=>true,getDb:()=>({}),createStore:()=>({observe:()=>({subscribe:o=>{projection=o.next;return {unsubscribe(){}}}}),state:vi.fn(),clear:vi.fn()}),createConnection:()=>({health:async()=>{},disconnect:vi.fn()}),createClient:()=>({}),createService:()=>service});view.init();
 const previous=globalThis.location;globalThis.location={search:'?service=one&signer=signer'};await view.sync('workspace','actor','db','backend',connections,true);globalThis.location=previous;
 return {view,service,pending,routes,deny(){projection({state:{status:'denied'},definitions:[],runs:[],snapshot:null})}};
}
for(const action of ['chooseRun','chooseDefinition','openChild','backToParent'])it(`guards stale ${action} route/trail after a fast selection`,async()=>{
 const h=await harness();h.view.selectedRunId='parent';h.view.parentTrail=[{id:'old-parent',title:'Old'}];
 const old=action==='openChild'?h.view.openChild({childRunId:'slow'}):action==='backToParent'?h.view.backToParent():h.view[action]('slow');
 const slowId=action==='backToParent'?'old-parent':'slow';
 const fast=h.view.chooseRun('fast');h.pending.get('fast')();await fast;
 h.pending.get(slowId)();await old;
 expect(h.routes.at(-1).run).toBe('fast');expect(h.view.parentTrail).toEqual([]);h.view.destroy();
});
for(const invalidate of ['suspend','destroy','deny','chooseConnection'])it(`does not navigate after ${invalidate}`,async()=>{
 const h=await harness();const old=h.view.openChild({childRunId:'slow'});
 if(invalidate==='deny')h.deny();else if(invalidate==='chooseConnection')await h.view.chooseConnection('two');else h.view[invalidate]();
 const count=h.routes.length;h.pending.get('slow')();await old;expect(h.routes).toHaveLength(count);expect(h.view.parentTrail).toEqual([]);h.view.destroy();
});

const runtime=new URL('./fixtures/pipeline-viewer-contract/runtime/',import.meta.url);
for(const file of readdirSync(runtime).filter(name=>name.endsWith('.json')))it(`parses and projects every actual executed row: ${file}`,()=>{
 const payload=JSON.parse(readFileSync(new URL(file,runtime),'utf8'));const snapshot=snapshotDto(payload,payload.serviceId);
 const nodes=flattenPipelineNodes(pipelineNodes(snapshot.definition,snapshot));
 if(snapshot.definition?.availability==='complete'){const defined=flattenPipelineNodes(pipelineNodes(snapshot.definition,null)).map(node=>node.logicalKey);expect(snapshot.steps.every(step=>defined.includes(step.logicalKey))).toBe(true);}
 const ids=nodes.flatMap(node=>node.attempts.map(step=>step.id));
 expect([...ids].sort()).toEqual(snapshot.steps.map(step=>step.id).sort());expect(new Set(ids).size).toBe(ids.length);
 for(const step of snapshot.steps){expect(nodes.find(node=>node.logicalKey===step.logicalKey)).toBeTruthy();for(const ref of step.evidence){expect(ref.stepId).toBe(step.id);expect(ref.runId).toBe(snapshot.run.id);}}
});
it('port inspection preserves node, side, path, execution and latest evidence identity',async()=>{
 const h=await harness();h.service.value=()=>({status:'ready',complete:true,value:{value:null}});h.service.evidence=vi.fn(async()=>{});
 const node={logicalKey:'same-path',attempts:[{id:'execution-7',attempt:7,evidence:[{id:'input',stepId:'execution-7',kind:'resolved_input'},{id:'first',stepId:'execution-7',kind:'returned_output',attempt:1},{id:'winning',stepId:'execution-7',kind:'returned_output',attempt:3}]}]};
 await h.view.inspectPort(node,'inputs',{path:'value'},null,true);expect(h.view).toMatchObject({inspectLabel:'same-path',inspectSide:'inputs',inspectPath:'value',inspectExecutionId:'execution-7',inspectEvidenceId:'input'});
 await h.view.inspectPort(node,'outputs',{path:'value'},null,true);expect(h.view.inspectEvidenceId).toBe('winning');expect(h.view.inspectSide).toBe('outputs');h.view.destroy();
});
it('copies explicit null and refuses a missing path without whole-value substitution',async()=>{
 const clipboard={writeText:vi.fn()},view=createPipelineViewerView({clipboard});view.inspector={complete:true,status:'ready',value:{value:null,sibling:'private'}};view.inspectPath='value';expect(view.fieldStatus).toBe('null');await view.copy();expect(clipboard.writeText).toHaveBeenCalledWith('null');
 view.inspectPath='missing';expect(view.fieldStatus).toBe('missing');await view.copy();expect(clipboard.writeText).toHaveBeenCalledTimes(1);expect(view.notice).toContain('missing');
});
it('connects every transformed selector from actual Bird definition without invented nodes',()=>{
 const payload=JSON.parse(readFileSync(new URL('./fixtures/pipeline-viewer-contract/completed-run.json',import.meta.url),'utf8'));
 const snapshot=snapshotDto(payload,payload.serviceId),nodes=flattenPipelineNodes(pipelineNodes(snapshot.definition,snapshot));
 const view=createPipelineViewerView();view.snapshot=snapshot;
 for(const wire of snapshot.definition.wiring.filter(wire=>!wire.carriedForward)){
  const source=nodes.find(node=>node.logicalKey===wire.sourceStepKey),target=nodes.find(node=>node.logicalKey===wire.targetStepKey);
  expect(source).toBeTruthy();expect(target).toBeTruthy();for(const pair of wiringEndpoints(wire)){expect(view.ports(source,'outputs').some(port=>port.path===pair.sourcePath)).toBe(true);expect(view.ports(target,'inputs').some(port=>port.path===pair.targetPath)).toBe(true);}
 }
 expect(nodes.map(node=>node.logicalKey)).toEqual(flattenPipelineNodes(pipelineNodes(snapshot.definition,null)).map(node=>node.logicalKey));
});

it('reloads catalogues before a same-context history route selects its run',async()=>{
 const h=await harness(),previous=globalThis.location;globalThis.location={search:'?service=one&signer=signer&run=history'};
 try{const read=h.view.sync('workspace','actor','db','backend',h.view.connections,true);await new Promise(resolve=>setTimeout(resolve,0));expect(h.service.list.mock.calls.slice(-2)).toEqual([['definitions'],['runs']]);h.pending.get('history')();await read;expect(h.service.selectRun).toHaveBeenCalledWith('history');}finally{globalThis.location=previous;h.view.destroy();}
});
