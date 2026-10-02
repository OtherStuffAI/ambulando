import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { PIPELINE_VIEWER_STORES, createPipelineViewerStore } from '../src/pipeline-viewer-store.js';
import { createPipelineViewerService } from '../src/pipeline-viewer-service.js';
import { pipelineViewerRequestPath } from '../src/pipeline-viewer-client.js';
import { parsePipelineViewerRoute, pipelineViewerRoute } from '../src/pipeline-viewer-route.js';
import { snapshotDto } from '../src/pipeline-viewer-contract.js';
import { viewerContext, birdSnapshot, evidenceReference, tweetRecords } from './fixtures/pipeline-viewer.js';
const databases = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
async function setup(read) {
  const db = new Dexie('pipeline-test-'+crypto.randomUUID()); db.version(1).stores(PIPELINE_VIEWER_STORES); databases.push(db); await db.open();
  const store = createPipelineViewerStore(db, viewerContext);
  const client = { read: vi.fn(read || (async (_op,options) => ({...birdSnapshot(),run:{...birdSnapshot().run,id:options.id||'run'}}))) };
  const service = createPipelineViewerService({ client, store, schedule: vi.fn(), unschedule: vi.fn() });
  return { db, store, client, service };
}
it('preserves immutable definition/status/actual attempts and excludes private inputs/outputs from persistence', async () => {
  const {db, store,service} = await setup();
  await service.selectRun('run');
  expect((await store.read()).snapshot.definition.hash).toBe('fixture-sha256');
  expect(JSON.stringify(await db.pipeline_viewer_snapshots.toArray())).not.toContain('must never persist');
  const older = birdSnapshot(0); older.steps=[]; await store.snapshot(older);
  expect((await store.read()).snapshot.steps).toHaveLength(4);
  const latest=birdSnapshot(2); latest.steps.push({...latest.steps[1],id:'retry',attempt:2,evidence:[],status:'failed',exitReason:'attempt budget'});
  await store.snapshot(latest); await store.snapshot(latest);
  expect((await store.read()).snapshot.steps).toHaveLength(5);
  service.dispose();
});
it('uses actual native statuses and explicitly missing snapshots', () => {
  const payload=birdSnapshot(); payload.run.status='needs_input';payload.definition=null;
  expect(snapshotDto(payload,'installation')).toMatchObject({run:{status:'needs_input'},definition:null});
  payload.steps.push(payload.steps[0]);expect(()=>snapshotDto(payload,'installation')).toThrow();
});
it('retrieves every retained array page in session cache without persisting full values',async()=>{
  const reference=evidenceReference();
  const {db,service}=await setup(async(op,options)=>op==='evidence'?{version:1,serviceId:'installation',evidence:reference,value:tweetRecords.slice(options.offset,options.offset+100),nextOffset:options.offset+100<tweetRecords.length?options.offset+100:null}:{...birdSnapshot(),run:{...birdSnapshot().run,id:options.id||'run'}});
  await service.selectRun('run');await service.evidence(reference);expect(service.value(reference.id).complete).toBe(false);
  await service.evidence(reference,true);await service.evidence(reference,true);
  expect(service.value(reference.id).value).toEqual(tweetRecords);expect(service.value(reference.id).complete).toBe(true);
  expect(JSON.stringify(await db.pipeline_viewer_snapshots.toArray())).not.toContain('Exact synthetic tweet');
  await service.selectRun('other');expect(service.value(reference.id)).toBeNull();service.dispose();
});
it('aborts delayed evidence on run change and rejects late results',async()=>{
  let release, signal;
  const reference=evidenceReference();
  const {service}=await setup(async(op,options,s)=>{if(op!=='evidence')return {...birdSnapshot(),run:{...birdSnapshot().run,id:options.id||'run'}};signal=s;return new Promise(resolve=>{release=resolve})});
  await service.selectRun('run');const pending=service.evidence(reference);await Promise.resolve();await service.selectRun('other');
  expect(signal.aborted).toBe(true);release({version:1,serviceId:'installation',evidence:reference,value:'private late',nextOffset:null});await pending;
  expect(service.value(reference.id)).toBeNull();service.dispose();
});
it('separates disconnected stale summaries from access denial, clearing private evidence',async()=>{
  let error;
  const {service,store}=await setup(async()=>{if(error)throw error;return birdSnapshot()});
  await service.selectRun('run');error=Error('private backend details');await service.recover();
  expect((await store.read()).state).toMatchObject({status:'disconnected',stale:true});expect((await store.read()).snapshot).not.toBeNull();
  error=Object.assign(Error('foreign'),{status:403});await service.recover();expect((await store.read()).state.status).toBe('denied');expect((await store.read()).snapshot).toBeNull();service.dispose();
});
it('isolates rows by workspace, actor, backend and verified service identity',async()=>{
  const {db,store,service}=await setup();await service.selectRun('run');
  for(const field of ['workspaceId','actorNpub','backend','serviceId','serviceNpub']) expect((await createPipelineViewerStore(db,{...viewerContext,[field]:'other'}).read()).snapshot).toBeNull();
  expect((await store.read()).state.selectedRunId).toBe('run');service.dispose();
});
it('builds only owner-scoped GET reads, requires signed capability/context and validates bounds',()=>{
  const verified={healthPath:'/api/owners/owner/control-plane/v1/health',capabilities:['pipelines.viewer.read.v1'],pipelineViewerPath:'/api/owners/owner/control-plane/v1/pipeline-viewer'};
  expect(pipelineViewerRequestPath(verified,viewerContext,'evidence',{id:'run/a',evidenceId:'value',offset:200})).toContain('/runs/run%2Fa/evidence/value?workspace_id=workspace');
  expect(()=>pipelineViewerRequestPath({...verified,capabilities:[]},viewerContext,'runs')).toThrow(/advertise/);
  expect(()=>pipelineViewerRequestPath(verified,{...viewerContext,ownerNpub:'foreign'},'runs')).toThrow(/context/);
  expect(()=>pipelineViewerRequestPath(verified,viewerContext,'runs',{limit:101})).toThrow(/pagination/);
});
it('deep links resolve verified service+signer and never infer a connection from URL',()=>{
  const route=pipelineViewerRoute({...viewerContext,runId:'run'});
  const connection={installation_id:'installation',metadata:{installation_npub:'signer'}};
  expect(parsePipelineViewerRoute(route.split('?')[1],[connection])).toMatchObject({status:'verified',runId:'run'});
  expect(parsePipelineViewerRoute('service=installation&signer=foreign&run=run',[connection]).status).toBe('unavailable');
});
it('rejects a successful snapshot from a different requested run',async()=>{
  const {service,store}=await setup(async()=>birdSnapshot());await service.selectRun('foreign');expect((await store.read()).state.status).toBe('unavailable');expect((await store.read()).snapshot).toBeNull();service.dispose();
});
it('coalesces recovery requests and stops polling on native terminal status',async()=>{
  let release;const schedule=vi.fn();const {store,client}=await setup(async()=>new Promise(resolve=>release=resolve));
  const service=createPipelineViewerService({client,store,schedule,unschedule:vi.fn()});const first=service.selectRun('run');
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));const second=service.recover();const snapshot=birdSnapshot();snapshot.run.status='ok';release(snapshot);await first;await second;
  expect(client.read).toHaveBeenCalledTimes(1);expect(schedule).not.toHaveBeenCalled();service.dispose();
});
it('preserves executor retry evidence attempts separately from the logical node attempt',()=>{
  const snapshot=birdSnapshot();snapshot.steps[1].evidence.push({...snapshot.steps[1].evidence[0],id:'executor-retry',kind:'executor_request',attempt:2});
  const dto=snapshotDto(snapshot,'installation');expect(dto.steps[1].attempt).toBe(1);expect(dto.steps[1].evidence.at(-1).attempt).toBe(2);
});
it('rejects pagination that silently skips retained records and missing complete values',async()=>{
  const ref=evidenceReference();let page={version:1,serviceId:'installation',evidence:ref,value:[{id:'1'}],nextOffset:100};
  const {service,store}=await setup(async(op)=>op==='evidence'?page:birdSnapshot());await service.selectRun('run');await service.evidence(ref);expect(service.value(ref.id)).toBeNull();expect((await store.read()).state.status).toBe('unavailable');
  page={version:1,serviceId:'installation',evidence:ref,nextOffset:null};await service.selectRun('run');await service.evidence(ref);expect(service.value(ref.id)).toBeNull();service.dispose();
});
it('an access failure aborts outstanding evidence before it can repopulate the private cache',async()=>{
  let release,signal,denied=false;const ref=evidenceReference();
  const {service}=await setup(async(op,_options,s)=>{if(op==='evidence'){signal=s;return new Promise(resolve=>release=resolve);}if(denied)throw Object.assign(Error('denied'),{status:403});return birdSnapshot();});
  await service.selectRun('run');const pending=service.evidence(ref);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));denied=true;await service.recover();expect(signal.aborted).toBe(true);release({version:1,serviceId:'installation',evidence:ref,value:'late private',nextOffset:null});await pending;expect(service.value(ref.id)).toBeNull();service.dispose();
});
