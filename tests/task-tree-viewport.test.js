import { expect, it, vi, afterEach } from 'vitest';
import { canvasTaskTreeStore } from '../src/canvas/task-tree-page.js';
import { stateColor } from '../src/translators/tasks.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('scales the scroll footprint and keeps the anchor world point stable at either bound',()=>{
  const store=canvasTaskTreeStore(),naplet={id:'view',layout:{task_tree:{viewport:{scale:1}}}};
  store.trees.view={graph:{positions:{a:{x:0,y:0},b:{x:3,y:4}}}};
  const node={clientWidth:400,clientHeight:300,scrollLeft:200,scrollTop:150};
  vi.stubGlobal('requestAnimationFrame',fn=>fn());store.scheduleTreeViewport=()=>{};
  store.setTreeScale(naplet,2,node,{x:100,y:50});
  expect(node.scrollLeft).toBe(500);expect(node.scrollTop).toBe(350);
  expect(store.treeExtentStyle(naplet)).toEqual({width:'2440px',height:'1880px'});
  store.setTreeScale(naplet,100,node);expect(store.treeViewport(naplet).scale).toBe(2);
  store.setTreeScale(naplet,0.01,node);expect(store.treeViewport(naplet).scale).toBe(0.2);
});
it('uses the task palette for every node and immediately follows status changes',()=>{
  const store=canvasTaskTreeStore(),naplet={id:'view'};store.trees.view={graph:{positions:{}}};
  const task={state:'review'};expect(store.treeNodeStyle(naplet,task)['--task-status-color']).toBe(stateColor('review'));
  task.state='done';expect(store.treeNodeStyle(naplet,task)['--task-status-color']).toBe('#60a5fa');
});
it('leaves ordinary wheel scrolling alone and scopes modifier-wheel to graph zoom',()=>{
  const store=canvasTaskTreeStore();store.setTreeScale=vi.fn();store.treeViewport=()=>({scale:1});
  const event={deltaY:-20,preventDefault:vi.fn(),stopPropagation:vi.fn(),currentTarget:{offsetWidth:400,getBoundingClientRect:()=>({left:0,top:0,width:400})},clientX:50,clientY:60};
  store.treeWheel({},event);expect(event.preventDefault).not.toHaveBeenCalled();
  event.ctrlKey=true;store.treeWheel({},event);expect(event.preventDefault).toHaveBeenCalled();expect(store.setTreeScale.mock.calls[0][1]).toBeGreaterThan(1);
});
it('keeps read-only zoom local without shared save attempts',async()=>{
  const store=canvasTaskTreeStore(),naplet={id:'view',layout:{task_tree:{viewport:{scale:0.8}}}};
  store.trees.view={};store.canvas={can_manage:false};store.saveTreeView=vi.fn();
  await store.saveTreeScroll(naplet,{scrollLeft:90,scrollTop:70});
  expect(store.treeViewport(naplet)).toEqual({scale:0.8,x:-90,y:-70});expect(store.saveTreeView).not.toHaveBeenCalled();
});
it('pans from a node, suppresses a gesture click, and permits the next deliberate tap',()=>{
  const store=canvasTaskTreeStore(),node={scrollLeft:100,scrollTop:100,offsetWidth:400,setPointerCapture:vi.fn(),getBoundingClientRect:()=>({width:400})};
  store.scheduleTreeViewport=()=>{};
  const event={pointerType:'touch',pointerId:1,clientX:100,clientY:100,currentTarget:node,preventDefault:vi.fn(),target:{closest:()=>true}};
  store.startTreeScroll({},event);store.moveTreeScroll({}, {...event,clientY:60});expect(node.scrollTop).toBe(140);
  store.endTreeScroll({},event);const click={currentTarget:node,preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()};store.treeClick(click);expect(click.preventDefault).toHaveBeenCalledOnce();
  node._treeSuppressClick=true;store.startTreeScroll({},event);store.endTreeScroll({},event);
  click.preventDefault.mockClear();store.treeClick(click);expect(click.preventDefault).not.toHaveBeenCalled();
});

it('a newer root action cancels the previous debounced viewport save',async()=>{
  vi.useFakeTimers();const store=canvasTaskTreeStore(),late=vi.fn(),save=vi.fn().mockResolvedValue({});
  const node={_treeSave:setTimeout(late,350)};store.treeScrollNode=()=>node;store.canvas={can_manage:true};
  store.startTaskTrees({}, {save});
  await store.saveTreeView({id:'view',layout:{}},{root_task_id:'60000000-0000-4000-8000-000000000001'});
  await vi.advanceTimersByTimeAsync(500);expect(late).not.toHaveBeenCalled();expect(save).toHaveBeenCalledOnce();
});
