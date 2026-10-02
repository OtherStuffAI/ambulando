import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import Dexie from 'dexie';
import { expect,it } from 'vitest';
import { assertViewerEnvelope, snapshotDto } from '../src/pipeline-viewer-contract.js';
import { createPipelineViewerStore,PIPELINE_VIEWER_STORES } from '../src/pipeline-viewer-store.js';
import { createPipelineViewerService } from '../src/pipeline-viewer-service.js';
import { pipelineNodes,flattenPipelineNodes } from '../src/pipeline-viewer-projection.js';
import { viewerContext } from './fixtures/pipeline-viewer.js';
const fixture=async name=>JSON.parse(await readFile(new URL(`./fixtures/pipeline-viewer-contract/${name}.json`,import.meta.url),'utf8'));
it('consumes backend-generated Bird snapshots, real loop attempts and complete retained pages',async()=>{
  const [parent,child,page1,page2]=await Promise.all(['completed-run','child-run','tweets-page-1','tweets-page-2'].map(fixture));
  const context={...viewerContext,serviceId:parent.serviceId};
  const db=new Dexie('contract-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();
  const store=createPipelineViewerStore(db,context);
  const service=createPipelineViewerService({store,client:{async read(op,options){
    const payload=op==='evidence'?(options.offset?page2:page1):options.id===child.run.id?child:parent;
    return assertViewerEnvelope(payload,context.serviceId);
  }}});
  try {
    await service.selectRun(parent.run.id);expect((await store.read()).snapshot.run.status).toBe('ok');
    const projection=flattenPipelineNodes(pipelineNodes(snapshotDto(child,context.serviceId).definition,snapshotDto(child,context.serviceId)));
    expect(projection.some(node=>node.type==='loop'&&node.children.length)).toBe(true);
    const ref=parent.steps.flatMap(step=>step.evidence).find(ref=>ref.id===page1.evidence.id);
    expect(ref).toBeTruthy();await service.evidence(ref);expect(service.value(ref.id).complete).toBe(false);
    await service.evidence(ref,true);expect(service.value(ref.id).complete).toBe(true);expect(service.value(ref.id).value).toHaveLength(page1.value.length+page2.value.length);
    expect(service.value(ref.id).value.at(-1).text).toBe(page2.value.at(-1).text);
    await service.selectRun(child.run.id);expect((await store.read()).snapshot.run.parentRunId).toBe(parent.run.id);expect(service.value(ref.id)).toBeNull();
    expect(JSON.stringify(await db.pipeline_viewer_snapshots.toArray())).not.toContain('Synthetic exact tweet');
  }finally{service.dispose();await db.delete();}
});
it('backend revision tokens replace snapshots with compare-and-swap and duplicate recovery adds no attempts',async()=>{
  const parent=await fixture('completed-run');const db=new Dexie('revision-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();
  const store=createPipelineViewerStore(db,{...viewerContext,serviceId:parent.serviceId});
  try{await store.snapshot(parent,null);await store.state({selectedRunId:parent.run.id});const changed={...parent,revision:'f'.repeat(64),steps:parent.steps.slice(0,1)};
    await store.snapshot(changed,parent.revision);await store.snapshot(parent,parent.revision);
    expect((await store.read()).snapshot.revision).toBe(changed.revision);expect((await store.read()).snapshot.steps).toHaveLength(1);
    await store.snapshot(changed,changed.revision);expect((await store.read()).snapshot.steps).toHaveLength(1);
  }finally{await db.delete();}
});
it('backend catalogue refresh cannot overwrite historical structure, and exact input/delivery stay distinct',async()=>{
  const [parent,definitions,runs,input,delivery,updates]=await Promise.all(['completed-run','definitions','runs','resolved_input','side_effect_confirmation','unchanged-updates'].map(fixture));
  const db=new Dexie('history-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();const store=createPipelineViewerStore(db,{...viewerContext,serviceId:parent.serviceId});
  const service=createPipelineViewerService({store,client:{async read(operation,options){return operation==='definitions'?definitions:operation==='runs'?runs:operation==='evidence'?(options.evidenceId===input.evidence.id?input:delivery):operation==='updates'?updates:parent;}}});
  try{await service.start();await service.selectRun(parent.run.id);const definitionHash=parent.definition.hash;
    await store.page('definitions',{...definitions,definitions:definitions.definitions.map(row=>({...row,version:999,hash:'changed-current-catalogue'}))},true);
    expect((await store.read()).snapshot.definition.hash).toBe(definitionHash);expect((await store.read()).snapshot.definition.version).toBe(2);
    const inputRef=parent.steps.flatMap(step=>step.evidence).find(ref=>ref.id===input.evidence.id);const deliveryRef=parent.steps.flatMap(step=>step.evidence).find(ref=>ref.id===delivery.evidence.id);expect(inputRef).toBeTruthy();expect(deliveryRef.kind).toBe('side_effect_confirmation');
    await service.evidence(inputRef);expect(service.value(inputRef.id).value).toEqual(input.value);expect(JSON.stringify(input.value).length).toBeGreaterThan(20000);
    await service.evidence(deliveryRef);expect(service.value(deliveryRef.id).value).toEqual(delivery.value);
    await service.recover();expect((await store.read()).snapshot.steps.length).toBe(parent.steps.length);
  }finally{service.dispose();await db.delete();}
});
it('keeps bounded preview text session-only and does not fetch full evidence for summaries',async()=>{
 const parent=await fixture('completed-run');const ref=parent.steps[0].evidence[0];
 ref.preview={value:{request:'PRIVATE_BOUNDED_EXCERPT'},truncated:true,count:null,counts:{}};
 const db=new Dexie('previews-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();
 const store=createPipelineViewerStore(db,{...viewerContext,serviceId:parent.serviceId}),calls=[];
 const service=createPipelineViewerService({store,client:{async read(operation){calls.push(operation);return parent;}}});
 try{await service.selectRun(parent.run.id);expect(service.preview(ref.id).value.request).toBe('PRIVATE_BOUNDED_EXCERPT');expect(calls).toEqual(['run']);
  expect(JSON.stringify(await db.pipeline_viewer_snapshots.toArray())).not.toContain('PRIVATE_BOUNDED_EXCERPT');
  service.dispose();expect(service.preview(ref.id)).toBeNull();
 }finally{service.dispose();await db.delete();}
});

it('clears cached same-context summaries on mount health denial without catalogue reads',async()=>{
 const parent=await fixture('completed-run');const db=new Dexie('health-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();
 const store=createPipelineViewerStore(db,{...viewerContext,serviceId:parent.serviceId});await store.snapshot(parent,null);await store.state({selectedRunId:parent.run.id});let reads=0;
 const service=createPipelineViewerService({store,connection:{health:async()=>{throw {status:403}},disconnect(){}},client:{read(){reads++;}}});
 try{expect(await service.initialize()).toBe(false);const state=await store.read();expect(state.state.status).toBe('denied');expect(state.snapshot).toBeNull();expect(state.runs).toEqual([]);expect(state.definitions).toEqual([]);expect(reads).toBe(0);}finally{service.dispose();await db.delete();}
});
it('preserves exact declared-field safe previews session-only, with absent, null and truncated fields',async()=>{
 const {portPreviewSelection}=await import('../src/pipeline-viewer-projection.js');const parent=await fixture('completed-run');const ref=parent.steps[0].evidence[0];
 ref.preview={value:{unrelated:'generic'},truncated:true,count:null,counts:{},fields:{'$.retrieval.tweets':{present:true,value:[{text:'PRIVATE_DECLARED_SAMPLE'}],truncated:true,count:5000},'$.delivery.delivered':{present:true,value:false,truncated:false,count:null},'$.nullable':{present:true,value:null,truncated:false,count:null},'$.absent':{present:false,truncated:false,count:null}}};
 const parsed=snapshotDto(parent,parent.serviceId).steps[0].evidence[0].preview;
 expect(portPreviewSelection(parsed,'$.retrieval.tweets')).toMatchObject({status:'present',count:5000,truncated:true,value:[{text:'PRIVATE_DECLARED_SAMPLE'}]});
 expect(portPreviewSelection({fields:{'$.large':{present:true,value:null,truncated:true,count:null}}},'$.large').status).toBe('outside');
 expect(portPreviewSelection(parsed,'$.delivery.delivered')).toMatchObject({status:'present',value:false,truncated:false});expect(portPreviewSelection(parsed,'$.nullable').status).toBe('null');expect(portPreviewSelection(parsed,'$.absent').status).toBe('missing');expect(portPreviewSelection(parsed,'$.delivered').status).toBe('outside');
 const db=new Dexie('declared-previews-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();const store=createPipelineViewerStore(db,{...viewerContext,serviceId:parent.serviceId}),calls=[];
 const service=createPipelineViewerService({store,client:{async read(operation){calls.push(operation);return parent;}}});
 try{await service.selectRun(parent.run.id);expect(service.preview(ref.id).fields['$.retrieval.tweets'].count).toBe(5000);expect(calls).toEqual(['run']);expect(JSON.stringify(await db.pipeline_viewer_snapshots.toArray())).not.toContain('PRIVATE_DECLARED_SAMPLE');service.dispose();expect(service.preview(ref.id)).toBeNull();}finally{service.dispose();await db.delete();}
 ref.preview.fields['$.retrieval.tweets'].value='x'.repeat(2048);expect(()=>snapshotDto(parent,parent.serviceId)).toThrow('invalid read contract');
 ref.preview={value:null,truncated:false,fields:{'$.bad':{present:true,truncated:false}}};expect(()=>snapshotDto(parent,parent.serviceId)).toThrow('invalid read contract');
});
for(const role of ['wrapper','child'])for(const outcome of ['complete','partial','clarification','blocked','noresults'])it(`actual runner ${role}/${outcome} keeps declared previews lazy and copies exact retained ports`,async()=>{
 const {portPreviewSelection,portSelection,latestPortReference}=await import('../src/pipeline-viewer-projection.js');const {createPipelineViewerView}=await import('../src/pipeline-viewer-view.js');
 const snapshot=await fixture('runtime/bird-'+role+'-'+outcome),retained=await fixture('runtime/evidence/bird-'+role+'-'+outcome);expect(retained.runId).toBe(snapshot.run.id);
 const parsed=snapshotDto(snapshot,snapshot.serviceId);const db=new Dexie('actual-ports-'+crypto.randomUUID());db.version(1).stores(PIPELINE_VIEWER_STORES);await db.open();const store=createPipelineViewerStore(db,{...viewerContext,serviceId:snapshot.serviceId}),calls=[];
 const service=createPipelineViewerService({store,client:{async read(operation,options){calls.push(operation);if(operation!=='evidence')return snapshot;const reference=parsed.steps.flatMap(s=>s.evidence).find(r=>r.id===options.evidenceId);expect(Object.hasOwn(retained.values,reference.id)).toBe(true);return {version:1,serviceId:snapshot.serviceId,evidence:reference,value:retained.values[reference.id],nextOffset:null};}}});
 const copied=[],view=createPipelineViewerView({clipboard:{writeText:async value=>copied.push(value)}});
 try{
  await service.selectRun(snapshot.run.id);expect(calls).toEqual(['run']);
  const persisted=await db.pipeline_viewer_snapshots.toArray();for(const step of persisted[0].dto.steps)for(const ref of step.evidence)expect(Object.hasOwn(ref,'preview')).toBe(false);
  const nodes=flattenPipelineNodes(pipelineNodes(parsed.definition,parsed));expect(nodes.flatMap(node=>node.attempts)).toHaveLength(parsed.steps.length);
  let ports=0;for(const step of parsed.steps)for(const side of ['inputs','outputs'])for(const port of step[side]){
   ports++;const ref=latestPortReference(step,side,port);expect(ref).toBeTruthy();
   if(ref.availability==='not_captured'){const before=calls.length;await service.evidence(ref);expect(service.value(ref.id)).toMatchObject({status:'unavailable',complete:false});expect(calls).toHaveLength(before);continue;}
   const preview=service.preview(ref.id);expect(new TextEncoder().encode(JSON.stringify(ref.preview)).length).toBeLessThanOrEqual(2048);
   const selected=portSelection(retained.values[ref.id],port.path),safe=portPreviewSelection(preview,port.path);if(step.status!=='skipped')expect(selected.status).toBe('present');expect(safe.status).toBe(selected.status);
   if(Array.isArray(selected.value))expect(safe.count).toBe(selected.value.length);if(!safe.truncated)expect(safe.value).toEqual(selected.value);
   await service.evidence(ref);view.inspectPath=port.path;view.inspector=service.value(ref.id);expect(view.fieldStatus).toBe(selected.status);const copiedBefore=copied.length;await view.copy();if(selected.status==='missing'){expect(copied).toHaveLength(copiedBefore);continue;}expect(copied.at(-1)).toBe(typeof selected.value==='string'?selected.value:JSON.stringify(selected.value,null,2));
  }
  expect(ports).toBeGreaterThan(5);
  if(role==='wrapper'){const reply=parsed.steps.find(s=>s.logicalKey==='reply');expect(reply.outputs.find(p=>p.label==='Delivered').path).toBe('$.delivery.delivered');expect(portSelection(retained.values[latestPortReference(reply,'outputs').id],'$.delivered').status).toBe('missing');}
  service.dispose();for(const step of parsed.steps)for(const ref of step.evidence){expect(service.value(ref.id)).toBeNull();expect(service.preview(ref.id)).toBeNull();}
 }finally{view.closeInspector();service.dispose();await db.delete();}
});
