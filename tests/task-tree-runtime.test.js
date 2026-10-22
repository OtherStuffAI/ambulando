import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { getWorkspaceDb, openWorkspaceDb } from '../src/db.js';
import { TaskTreeRuntime } from '../src/canvas/task-tree-runtime.js';
import { indexTasks, projectTree } from '../src/canvas/task-tree-graph.js';

let runtime;
const identity={workspace_id:'workspace',app_npub:'app',tower_service_npub:'tower',workspace_service_npub:'service'};
const context={workspaceId:'workspace',workspaceOwnerNpub:'owner',appNpub:'app',tower:'tower',service:'service',baseUrl:'http://127.0.0.1:3100',dbKey:'test',viewer:'reader'};
const row=(id,metadata={})=>({id,workspace_id:'workspace',channel_id:'channel',title:id,state:'new',row_version:1,metadata,created_at:'2026-10-01T00:00:00Z'});
const projector=()=>({terminate:vi.fn(),postMessage(data){queueMicrotask(()=>this.onmessage({data:{...data,graph:projectTree(indexTasks(data.rows),data.root,data.options)}}));}});
const page=(task,tasks=[],extra={})=>({identity,task,tasks,has_more:false,next_cursor:null,...extra});
async function setup(api){const db=openWorkspaceDb(`tree-${crypto.randomUUID()}`);await db.open();const states=[];runtime=new TaskTreeRuntime(context,{api,projector:projector(),onState:(key,state)=>states.push({key,...state})});return {db,states};}
afterEach(async()=>{runtime?.close();await getWorkspaceDb().delete();});

it('loads every adjacency page, renders shared successors once and persists canonical task rows',async()=>{
  const root=row('root'),a=row('a',{parent_task_id:'root'}),b=row('b',{parent_task_id:'root'}),s=row('shared',{predecessor_task_ids:['a','b']});
  const read=vi.fn(async(_w,id,{cursor})=>id==='root'?cursor?page(root,[b]):page(root,[a],{has_more:true,next_cursor:'page2'}):id==='a'?page(a,[s]):id==='b'?page(b,[s]):page(s));
  const {db,states}=await setup({getTowerPgTaskRelationships:read});runtime.bind('view','root');
  await vi.waitFor(()=>expect(states.at(-1)?.graph?.nodes).toHaveLength(4));
  expect(await db.tasks.count()).toBe(4);expect(states.at(-1).graph.edges).toHaveLength(4);
  expect(read.mock.calls.filter(([,id])=>id==='shared')).toHaveLength(1);
});
it('observes edits from another view through the shared Dexie task table',async()=>{
  const {db,states}=await setup({getTowerPgTaskRelationships:async()=>page(row('root'))});runtime.bind('view','root');
  await vi.waitFor(()=>expect(states.at(-1)?.graph?.nodes).toHaveLength(1));
  await db.tasks.update('root',{title:'Changed through task board',state:'done'});
  await vi.waitFor(()=>expect(states.at(-1).graph.nodes[0]).toMatchObject({title:'Changed through task board',state:'done'}));
});
it('keeps a partial frontier retryable and exposes repeated cursors without hanging',async()=>{
  let failing=true;
  const read=vi.fn(async(_w,id)=>{if(id==='child'&&failing)throw new Error('offline');return id==='root'?page(row('root'),[row('child',{parent_task_id:'root'})]):page(row('child',{parent_task_id:'root'}));});
  const {states}=await setup({getTowerPgTaskRelationships:read});runtime.bind('view','root');
  await vi.waitFor(()=>expect(states.at(-1).error).toMatch(/partially/));expect(states.at(-1).partial).toBe(true);
  failing=false;await runtime.advance('view');await vi.waitFor(()=>expect(states.at(-1).partial).toBe(false));
});
it('drops rendered cached titles on authorization loss while preserving shared records for their owner',async()=>{
  let revoked=false;
  const {db,states}=await setup({getTowerPgTaskRelationships:async()=>{if(revoked)throw Object.assign(new Error('denied'),{status:403});return page(row('secret'));}});
  runtime.bind('view','secret');await vi.waitFor(()=>expect(states.at(-1)?.graph?.nodes).toHaveLength(1));
  revoked=true;await runtime.refresh('view');expect(states.at(-1).graph).toBe(null);expect(states.at(-1).unavailable).toBe(true);
  expect(await db.tasks.count()).toBe(1);
});
it('uses captured request identity for creation retries and rejects a foreign authority response',async()=>{
  const create=vi.fn(async()=>({identity,task:row('new-task')}));
  const {db}=await setup({createTowerPgChannelTask:create});const request={title:'New',client_request_id:'stable-request',metadata:{parent_task_id:'parent',predecessor_task_ids:[]}};
  await runtime.create('channel',request);await runtime.create('channel',request);expect(create.mock.calls[0][2]).toBe(request);expect(create.mock.calls[1][2]).toBe(request);expect(await db.tasks.count()).toBe(1);
  create.mockResolvedValue({identity:{...identity,workspace_id:'foreign'},task:row('wrong')});await expect(runtime.create('channel',request)).rejects.toThrow(/workspace/);expect(await db.tasks.count()).toBe(1);
});

it('stages refresh without blanking cards or moving their stable positions',async()=>{
  let release, delayed=false;
  const api={getTowerPgTaskRelationships:async()=>{if(delayed)await new Promise(resolve=>{release=resolve;});return page(row('root'));}};
  const {states}=await setup(api);runtime.bind('view','root');await vi.waitFor(()=>expect(states.at(-1)?.graph?.nodes).toHaveLength(1));
  const positions=states.at(-1).graph.positions;delayed=true;const refreshing=runtime.refresh('view');
  expect(states.at(-1).graph.nodes).toHaveLength(1);expect(states.at(-1).loading).toBe(true);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));release();await refreshing;
  await vi.waitFor(()=>expect(states.at(-1).loading).toBe(false));expect(states.at(-1).graph.positions).toEqual(positions);
});

it('fences late reads after rebind and preserves an existing pending task edit',async()=>{
  let release;
  const {db,states}=await setup({getTowerPgTaskRelationships:async(_w,id)=>id==='late'?new Promise(resolve=>{release=()=>resolve(page(row('late')));}):page(row('current'))});
  runtime.bind('view','late');await vi.waitFor(()=>expect(release).toBeTypeOf('function'));runtime.bind('view','current');release();
  await vi.waitFor(()=>expect(states.at(-1)?.graph?.nodes[0]?.record_id).toBe('current'));expect(await db.tasks.get('late')).toBeUndefined();
  await db.tasks.update('current',{title:'Unsaved user edit',sync_status:'pending'});await runtime.refresh('view');
  expect((await db.tasks.get('current')).title).toBe('Unsaved user edit');
});
