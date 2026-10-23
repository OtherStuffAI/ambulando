import { test } from 'vitest';
import assert from 'node:assert/strict';
import { indexTasks, projectTree } from '../src/canvas/task-tree-graph.js';
const task = (id, parent = '', predecessors = []) => ({ id, title: id, metadata: { parent_task_id: parent, predecessor_task_ids: predecessors } });
test('shared successors have one card and all connectors', () => {
  const tree = projectTree(indexTasks([task('r'), task('a','r'), task('b','r'),task('s','',['a','b'])]),'r');
  assert.equal(tree.nodes.length,4);assert.equal(tree.edges.length,4);
  assert.equal(new Set(Object.values(tree.positions).map(p=>JSON.stringify(p))).size,4);
});
test('cycles terminate; collapse and bounds preserve explicit reachability', () => {
  const graph = indexTasks([task('r','b'),task('a','r'),task('b','a')]);
  assert.equal(projectTree(graph,'r').nodes.length,3);
  assert.equal(projectTree(graph,'r',{collapsed:['r']}).nodes.length,1);
  assert.equal(projectTree(graph,'r',{limit:2}).bounded,true);
});
test('stable placement across append and root keeps upstream references', () => {
  const graph = indexTasks([task('p'),task('r','p'),task('a','r')]);
  const initial = projectTree(graph,'r');
  assert.equal(initial.nodes[0].id,'r');assert.equal(initial.references[0].targetId,'p');
  const grown=projectTree(indexTasks([...graph.tasks.values(), task('b','r')]),'r',{previous:initial.positions});
  assert.deepEqual(grown.positions.r,initial.positions.r);assert.deepEqual(grown.positions.a,initial.positions.a);
});
test('ten thousand records use bounded iterative traversal',()=>{
 const rows=Array.from({length:10000},(_,i)=>task(String(i),i?String(i-1):''));
 const start=performance.now();const graph=indexTasks(rows);const tree=projectTree(graph,'0');
 assert.equal(tree.nodes.length,100);assert.equal(tree.bounded,true);
 console.log(JSON.stringify({scenario:'pure graph projection; not browser',records:rows.length,visible:tree.nodes.length,ms:performance.now()-start}));
});

test('child successors stay right of predecessors while retaining the same parent hierarchy',()=>{
 const tree=projectTree(indexTasks([task('r'),task('a','r'),task('b','r'),task('next','r',['a']),task('chain','r',['next'])]),'r');
 assert.ok(tree.positions.a.y>tree.positions.r.y);assert.ok(tree.positions.next.x>tree.positions.a.x);assert.ok(tree.positions.chain.x>tree.positions.next.x);
 assert.equal(tree.nodes.find(row=>row.id==='next').parent,'r');
});

test('earlier-dated incoming tasks do not displace already positioned cards',()=>{
 const root={...task('r'),created_at:'2020-01-01'},child={...task('existing','r'),created_at:'2021-01-01'};
 const initial=projectTree(indexTasks([root,child]),'r');const incoming={...task('new','r'),created_at:'2019-01-01'};
 const grown=projectTree(indexTasks([root,child,incoming]),'r',{previous:initial.positions});assert.deepEqual(grown.positions.existing,initial.positions.existing);assert.notDeepEqual(grown.positions.new,grown.positions.existing);
});
