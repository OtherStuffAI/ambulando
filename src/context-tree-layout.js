// Pure, iterative forest layout. Persisted parent pointers are the only hierarchy.
export function layoutContextTree(components, collapsed = [], { nodeWidth = 200, nodeHeight = 64, siblingGap = 28, levelGap = 48 } = {}) {
  const closed = new Set(collapsed);
  const rows = new Map(components.filter(row => !row.deleted_at).map(row => [row.id, row]));
  const children = new Map();
  for (const row of rows.values()) {
    const key = row.parent_id || null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(row);
  }
  const compare = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id.localeCompare(b.id);
  for (const list of children.values()) list.sort(compare);
  const roots = children.get(null) || [];
  const order = [], visited = new Set(), stack = roots.slice().reverse().map(row => ({ row, depth: 0 }));
  while (stack.length) {
    const item = stack.pop();
    if (visited.has(item.row.id)) continue;
    visited.add(item.row.id); order.push(item);
    if (!closed.has(item.row.id)) for (const row of (children.get(item.row.id) || []).slice().reverse()) stack.push({ row, depth: item.depth + 1 });
  }
  const spans = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const { row } = order[i];
    const visible = closed.has(row.id) ? [] : children.get(row.id) || [];
    spans.set(row.id, Math.max(nodeWidth, visible.reduce((sum, child) => sum + (spans.get(child.id) || 0), 0) + Math.max(0, visible.length - 1) * siblingGap));
  }
  const starts = new Map(); let cursor = 24;
  for (const root of roots) { starts.set(root.id, cursor); cursor += (spans.get(root.id) || nodeWidth) + siblingGap * 2; }
  const nodes = [], edges = [], positions = new Map();
  for (const { row, depth } of order) {
    const start = starts.get(row.id), span = spans.get(row.id);
    const node = { id: row.id, title: row.title, parentId: row.parent_id, depth, x: start + (span - nodeWidth) / 2, y: 24 + depth * (nodeHeight + levelGap), width: nodeWidth, height: nodeHeight,
      childCount: (children.get(row.id) || []).length, expanded: !closed.has(row.id) };
    nodes.push(node); positions.set(node.id, node);
    const parent = positions.get(row.parent_id);
    if (parent) {
      const x1 = parent.x + nodeWidth / 2, y1 = parent.y + nodeHeight, x2 = node.x + nodeWidth / 2, y2 = node.y;
      edges.push({ id: row.id, parentId: parent.id, x1, y1, x2, y2, path: `M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2}` });
    }
    let offset = start;
    if (node.expanded) for (const child of children.get(row.id) || []) { starts.set(child.id, offset); offset += spans.get(child.id) + siblingGap; }
  }
  return { nodes, edges, width: Math.max(48, cursor - siblingGap * 2 + 24), height: nodes.length ? nodes.reduce((max, node) => Math.max(max, node.y), 0) + nodeHeight + 24 : 48 };
}

export function contextPath(components, id) {
  const rows = new Map(components.map(row => [row.id, row])), seen = new Set(), path = [];
  let row = rows.get(id);
  while (row && !seen.has(row.id)) { seen.add(row.id); path.push({ id: row.id, title: row.title }); row = rows.get(row.parent_id); }
  return path.reverse();
}

// Bounded search rows share one index; collapsed nodes remain searchable.
export function contextSearchChoices(components, query = '', allowedIds = null, limit = 40) {
  const rows=new Map(components.map(row=>[row.id,row])), needle=query.trim().toLowerCase(), matches=[];
  for(const row of components) {
    if(allowedIds && !allowedIds.has(row.id))continue;
    const titles=[],seen=new Set();let part=row;
    while(part && !seen.has(part.id)){seen.add(part.id);titles.push(part.title);part=rows.get(part.parent_id);}
    const path=titles.reverse();
    if(path.join(' / ').toLowerCase().includes(needle))matches.push({...row,subtitle:path.slice(0,-1).join(' / ') || 'Top level',path:path.join(' / ')});
    if(matches.length>=limit)break;
  }
  return matches;
}

export function fitContextTree(layout, width, height) {
  const scale = Math.min(1, Math.max(Number.EPSILON, Math.min((width - 32) / layout.width, (height - 32) / layout.height)));
  return { scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 };
}
