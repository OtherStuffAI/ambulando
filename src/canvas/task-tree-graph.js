// Pure, iterative graph projection. Task storage remains canonical Dexie/Tower.
const id = value => String(value || '').trim();
const order = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id);

export function indexTasks(rows) {
  const tasks = new Map(), outgoing = new Map();
  for (const row of rows) {
    const key = id(row.id || row.record_id);
    if (!key || row.deleted_at || row.record_state === 'deleted') continue;
    const metadata = row.record_id ? row : row.metadata || row.pg_metadata || row;
    const previous = tasks.get(key);
    if (previous && Number(previous.row_version || previous.version) > Number(row.row_version || row.version)) continue;
    tasks.set(key, { ...row, id: key, parent: id(metadata.parent_task_id), predecessors: [...new Set((Array.isArray(metadata.predecessor_task_ids) ? metadata.predecessor_task_ids : []).map(id).filter(Boolean))] });
  }
  const edge = (from, to, kind) => {
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push({ from, to, kind });
  };
  for (const task of [...tasks.values()].sort(order)) {
    if (task.parent) edge(task.parent, task.id, 'child');
    for (const predecessor of task.predecessors) edge(predecessor, task.id, 'successor');
  }
  return { tasks, outgoing };
}

// Only already-authorized rows enter this function. Completeness is owned by
// the loader; an absent row is an unavailable reference, never a cached title.
export function projectTree(index, root, { collapsed = [], upstream = [], limit = 100, previous = {} } = {}) {
  const closed = new Set(collapsed), visited = new Set(), queued = new Set([root, ...upstream]);
  const queue = [root, ...upstream], nodes = [], positions = {}, occupied = new Set();
  const budget = Math.max(1, Math.min(2000, Math.floor(limit) || 100));
  const reserve = (key, target) => {
    const prior = previous[key];
    let x = prior && Number.isFinite(prior.x) ? Math.max(0, Math.round(prior.x)) : target.x;
    let y = prior && Number.isFinite(prior.y) ? Math.max(0, Math.round(prior.y)) : target.y;
    while (occupied.has(`${x}:${y}`)) y += 1;
    occupied.add(`${x}:${y}`); positions[key] = { x, y };
  };
  let cursor = 0;
  while (cursor < queue.length && nodes.length < budget) {
    const key = queue[cursor++];
    if (visited.has(key)) continue;
    visited.add(key);
    const task = index.tasks.get(key);
    if (!task) continue;
    nodes.push(task);
    if (closed.has(key)) continue;
    for (const link of index.outgoing.get(key) || []) {
      if (queued.has(link.to)) continue;
      queued.add(link.to); queue.push(link.to);
    }
  }
  const visible = new Set(nodes.map(row => row.id)), edges = [], references = [];
  // Placement follows dependency direction before hierarchy. A child successor
  // has both edges; discovering it through its parent must not place it below
  // the parent instead of to the right of its predecessor.
  if (visible.has(root)) reserve(root,{x:0,y:0});
  for(const task of nodes)if(task.id!==root && previous[task.id])reserve(task.id,{x:0,y:0});
  let pending=nodes.filter(row=>!positions[row.id]);
  while(pending.length) {
    const deferred=[];let progressed=false;
    for(const task of pending) {
      const predecessors=task.predecessors.filter(key=>visible.has(key)&&key!==task.id);
      const predecessor=predecessors.find(key=>positions[key]);
      if(!previous[task.id] && predecessors.length && !predecessor){deferred.push(task);continue;}
      if(!previous[task.id] && !predecessors.length && visible.has(task.parent) && !positions[task.parent]){deferred.push(task);continue;}
      const origin=predecessor?positions[predecessor]:positions[task.parent];
      reserve(task.id,origin?predecessor?{x:origin.x+1,y:origin.y}:{x:origin.x,y:origin.y+1}:{x:0,y:nodes.indexOf(task)});
      progressed=true;
    }
    if(!progressed && deferred.length){const task=deferred.shift();reserve(task.id,{x:0,y:nodes.indexOf(task)});}
    pending=deferred;
  }

  for (const task of nodes) {
    for (const link of index.outgoing.get(task.id) || []) {
      if (visible.has(link.to)) edges.push(link);
    }
    if (task.parent && !visible.has(task.parent)) references.push({ taskId: task.id, targetId: task.parent, kind: 'parent', available: index.tasks.has(task.parent) });
    for (const predecessor of task.predecessors) {
      if (!visible.has(predecessor)) references.push({ taskId: task.id, targetId: predecessor, kind: 'predecessor', available: index.tasks.has(predecessor) });
    }
  }
  return { nodes, edges, references, positions, remaining: queue.length - cursor, bounded: cursor < queue.length };
}
