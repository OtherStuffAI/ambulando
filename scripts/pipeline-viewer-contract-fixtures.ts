import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic illustration generator using the owning backend's actual public APIs.
// This is independent of its generator implementation; no source rewriting.
const backend=resolve(process.argv[2]),target=resolve(process.argv[3]);
const load=(file:string)=>import(pathToFileURL(join(backend,file)).href);
const [{PipelineStore},{viewerDefinition,viewerRunSummary,viewerSnapshot},{buildPipelineStepMetadata},{installationIdForIdentity}]=await Promise.all([
 load('src/pipelines/pipeline-store.ts'),load('src/pipelines/pipeline-viewer-dto.ts'),load('src/pipelines/pipeline-step-metadata.ts'),load('src/control-plane/connect-package.ts'),
]);
const definition=(name:string)=>{const spec=JSON.parse(readFileSync(join(backend,'src/pipelines/default-definitions',name+'.json'),'utf8'));return {id:spec.name,slug:spec.name,name:spec.name,scope:'shared',ownerAlias:null,path:'synthetic.json',spec};};
const chat=definition('bird.timeline.chat.v2'),retrieve=definition('bird.retrieve.v2');
const directory=mkdtempSync(join(tmpdir(),'flightdeck-viewer-fixtures-'));mkdirSync(target,{recursive:true});
const store=new PipelineStore(join(directory,'fixture.sqlite'));
const envelope={version:1,serviceId:installationIdForIdentity({pubkeyHex:'33'.repeat(32)})};
const save=(name:string,value:unknown)=>writeFileSync(join(target,name),JSON.stringify(value,null,2)+'\n');
const prompt='Retrieve 35 tweets from my Following feed.\n'+'Synthetic long request for exact-copy inspection.\n'.repeat(600);
const tweets=Array.from({length:35},(_,index)=>({id:String(1000+index),text:`Synthetic exact tweet ${index+1}\nSecond line.`,author:{username:'example',name:'Example'},url:`https://x.com/example/status/${1000+index}`}));
try {
 const run=store.createRun({definitionId:chat.id,name:chat.name,scope:'shared',ownerNpub:'synthetic-owner',input:{prompt}});store.composition.pin(run.id,chat,{});
 let collection;
 for(const [index,step] of chat.spec.steps.entries()){
  const input=index===0?{prompt}:index===1?{request:prompt}:index===2?{state:{tweets}}:{message:'Synthetic response'};
  const record=store.createStep({runId:run.id,stepIndex:index,name:step.name,kind:step.type,logicalKey:step.id??step.name,input,metadata:buildPipelineStepMetadata(step)});
  const output=index===0?{prompt}:index===1?{retrieval:{verdict:'complete',reason:'requested_count_reached',tweets}}:index===2?{message:tweets.map(tweet=>tweet.text+'\n'+tweet.url).join('\n\n')}:{delivered:true,messageId:'synthetic-message',threadId:'synthetic-thread',url:'https://example.invalid/thread/synthetic-thread#synthetic-message'};
  if(index===1){
   const child=store.createRun({definitionId:retrieve.id,name:retrieve.name,scope:'shared',ownerNpub:'synthetic-owner',input:{request:prompt}});store.composition.pin(child.id,retrieve,{});store.composition.link({parentRunId:run.id,parentStepId:record.id,childRunId:child.id,deadline:Date.now()+75000});
   const loop=retrieve.spec.steps.find((row:any)=>row.type==='loop');
   const parent=store.createStep({runId:child.id,stepIndex:0,name:loop.name,kind:'loop',logicalKey:loop.id,input:{},metadata:buildPipelineStepMetadata(loop)});
   for(const [i,stage] of loop.steps.entries()){
    const active=['choose','execute'].includes(stage.name);const node=store.createStep({runId:child.id,stepIndex:i+1,name:`${loop.name} #1 / ${stage.name}`,kind:stage.type,logicalKey:`${loop.id}/${stage.id}`,parentStepId:parent.id,input:{request:prompt},metadata:buildPipelineStepMetadata(stage)});
    if(stage.type==='classifier'&&active)store.evidence.capture({runId:child.id,stepId:node.id,kind:'executor_request',scope:'assembled_model_request',value:{model:'synthetic-model',state:{request:prompt},questions:stage.questions}});
    store.completeStep({id:node.id,status:active?'ok':'skipped',result:{},output:active?{verdict:'complete',reason:'requested_count_reached',tweets}:undefined});
   }
   store.completeStep({id:parent.id,status:'ok',result:{},output:{iterations:1}});store.completeRun(child.id,'ok',{retrieval:{verdict:'complete',tweets}});save('child-run.json',{...envelope,...viewerSnapshot(child.id,store,envelope.serviceId)});
  }
  if(index===3)store.evidence.capture({runId:run.id,stepId:record.id,kind:'side_effect_confirmation',scope:'delivery_adapter_confirmation',value:output});
  store.completeStep({id:record.id,status:'ok',output,result:output});
  // Separate evidence kind: the paging illustration must not supersede the winning output.
  if(index===1)collection=store.evidence.capture({runId:run.id,stepId:record.id,kind:'executor_request',scope:'synthetic_record_collection',value:tweets});
 }
 store.completeRun(run.id,'ok',{});store.compactCompletedRunPayloads({});
 const snapshot=viewerSnapshot(run.id,store,envelope.serviceId);
 save('definitions.json',{...envelope,definitions:[viewerDefinition(chat),viewerDefinition(retrieve)],nextCursor:null});save('completed-run.json',{...envelope,...snapshot});save('runs.json',{...envelope,runs:[viewerRunSummary(run,store,envelope.serviceId)],nextCursor:null});save('unchanged-updates.json',{...envelope,...snapshot,unchanged:true});
 for(const kind of ['resolved_input','side_effect_confirmation']){const ref=store.evidence.list(run.id).find((row:any)=>row.kind===kind);save(kind+'.json',{...envelope,...store.evidence.get(run.id,ref.id),nextOffset:null});}
 save('tweets-page-1.json',{...envelope,evidence:collection,value:tweets.slice(0,20),nextOffset:20});save('tweets-page-2.json',{...envelope,evidence:collection,value:tweets.slice(20),nextOffset:null});
 console.log('Generated synthetic contract fixtures through PipelineStore and viewer DTO APIs.');
}finally{rmSync(directory,{recursive:true,force:true});}
