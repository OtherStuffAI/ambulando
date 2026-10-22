import { expect, it, vi } from 'vitest';
const {requests,control}=vi.hoisted(()=>({requests:[],control:{wait:null}}));
vi.mock('../src/canvas/task-tree-runtime.js',()=>({TaskTreeRuntime:class {
  bind(){} remove(){}
  async create(channel,request){requests.push(request);if(control.wait)await control.wait;return {id:'canonical-task',title:request.title,channel_id:channel,scope_id:'scope',metadata:request.metadata};}
}}));
vi.mock('../src/canvas/artifact-picker.js',()=>({ArtifactCatalog:class {async channels(){return {channels:[{id:'new-channel',title:'New channel'}]};}}}));
import { canvasTaskTreeStore } from '../src/canvas/task-tree-page.js';

it('retains the canonical creation identity when saving its root view conflicts',async()=>{
  const originalDocument=globalThis.document;
  globalThis.document={querySelector:()=>null};
  try {
    const store=canvasTaskTreeStore();store.canvas={can_manage:true};
    const naplet={id:'view',source:{id:'channel',type:'task_tree'},content:{scope_id:'scope',channel_id:'channel',can_create:true},layout:{}};
    const save=vi.fn().mockRejectedValueOnce(Object.assign(new Error('Conflict'),{status:409})).mockResolvedValue({});
    store.startTaskTrees({}, {save});
    store.trees.view={scopeId:'scope',channelId:'channel',mode:'root',entry:'One task',busy:false};
    await store.submitTreeEntry(naplet);
    expect(store.trees.view.error).toMatch(/Task saved/);
    expect(store.trees.view.entry).toBe('One task');
    expect(store.trees.view.lastCreated.record_id).toBe('canonical-task');
    await store.submitTreeEntry(naplet);
    expect(requests).toHaveLength(2);expect(requests[0]).toBe(requests[1]);
    expect(store.trees.view.entry).toBe('');expect(save).toHaveBeenCalledTimes(2);
  }finally{globalThis.document=originalDocument;}
});


it('refreshes an externally rebound destination without overwriting a local unfinished selection on ordinary refresh',async()=>{
  const store=canvasTaskTreeStore();store.canvas={can_manage:true};store.startTaskTrees({},{});
  const original={id:'view',access:'ready',source:{id:'channel',type:'task_tree'},content:{scope_id:'scope',channel_id:'channel'},layout:{}};
  store.trees.view={binding:'scope:channel',scopeId:'unfinished-scope',channelId:'',entry:'',scopes:[]};
  await store.syncTaskTrees([original]);expect(store.trees.view.scopeId).toBe('unfinished-scope');
  const rebound={...original,source:{id:'new-channel',type:'task_tree'},content:{scope_id:'new-scope',channel_id:'new-channel'}};
  await store.syncTaskTrees([rebound]);
  expect(store.treeDestinationReady(rebound)).toBe(true);expect(store.trees.view.channels[0].id).toBe('new-channel');
});

it('does not attach an in-flight task to a tree that was rebound during creation',async()=>{
  const originalDocument=globalThis.document;globalThis.document={querySelector:()=>null};
  let release;control.wait=new Promise(resolve=>{release=resolve;});
  try {
    const store=canvasTaskTreeStore(),save=vi.fn();store.canvas={can_manage:true};store.startTaskTrees({},{save});
    const naplet={id:'view',source:{id:'channel',type:'task_tree'},content:{scope_id:'scope',channel_id:'channel',can_create:true},layout:{}};
    store.naplets=[naplet];store.trees.view={scopeId:'scope',channelId:'channel',mode:'root',entry:'Keep original',busy:false};
    const pending=store.submitTreeEntry(naplet);
    store.naplets=[{...naplet,source:{id:'different-channel'},content:{scope_id:'other-scope'}}];
    release();await pending;
    expect(save).not.toHaveBeenCalled();expect(store.trees.view.error).toMatch(/original destination/);
    expect(store.trees.view.request).toBe(null);
  }finally{globalThis.document=originalDocument;control.wait=null;}
});

it('retains a failed channel choice as unbound rather than creating through the prior channel',async()=>{
  const store=canvasTaskTreeStore();store.startTaskTrees({}, {save:vi.fn().mockRejectedValue(new Error('Save failed'))});
  const naplet={id:'view',source:{type:'task_tree',id:'old'},content:{scope_id:'scope',channel_id:'old'},layout:{}};
  store.trees.view={scopeId:'scope',channelId:'old',channels:[{id:'new'}],entry:'',busy:false};
  await store.chooseTreeChannel(naplet,'new');
  expect(store.trees.view.channelId).toBe('new');expect(store.treeDestinationReady(naplet)).toBe(false);
  expect(store.trees.view.error).toMatch(/Save failed/);
});
