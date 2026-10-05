// Pure, iterative forest layout. Persisted parent pointers are the only hierarchy.
export function layoutContextTree(components, collapsed = [], { nodeWidth = 240, nodeHeight = 80, siblingGap = 16, levelGap = 48 } = {}) {
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
  const order = [], visited = new Set(), stack = roots.map((row, i) => ({ row, depth: 0, position: i + 1, siblingCount: roots.length })).reverse();
  while (stack.length) {
    const item = stack.pop();
    if (visited.has(item.row.id)) continue;
    visited.add(item.row.id); order.push(item);
    if (!closed.has(item.row.id)) {
      const list = children.get(item.row.id) || [];
      for (let i = list.length - 1; i >= 0; i--) stack.push({ row: list[i], depth: item.depth + 1, position: i + 1, siblingCount: list.length });
    }
  }
  // Reserve room for icons/counts/disclosure and wrap long words too. A
  // conservative character budget keeps visual labels inside their cards.
  const heights = new Map();
  const charactersPerLine = Math.max(8, Math.floor((nodeWidth - 96) / 9));
  for (const { row } of order) {
    let lines = 1, used = 0;
    for (const word of String(row.title || '').split(/\s+/)) {
      if (used && used + 1 + word.length > charactersPerLine) { lines++; used = 0; }
      lines += Math.floor(Math.max(0, word.length - 1) / charactersPerLine);
      used += (used ? 1 : 0) + (word.length % charactersPerLine || charactersPerLine);
    }
    heights.set(row.id, Math.max(nodeHeight, lines * 21 + 24));
  }
  // Subtree height stacks siblings vertically; breadth never increases chart width.
  const spans = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const { row } = order[i];
    const visible = closed.has(row.id) ? [] : children.get(row.id) || [];
    spans.set(row.id, Math.max(heights.get(row.id), visible.reduce((sum, child) => sum + (spans.get(child.id) || 0), 0) + Math.max(0, visible.length - 1) * siblingGap));
  }
  const starts = new Map(); let cursor = 24;
  for (const root of roots) { starts.set(root.id, cursor); cursor += (spans.get(root.id) || nodeHeight) + siblingGap * 2; }
  const nodes = [], edges = [], positions = new Map();
  let width = 48;
  for (const { row, depth, position, siblingCount } of order) {
    const start = starts.get(row.id);
    const node = { id: row.id, title: row.title, parentId: row.parent_id, depth, position, siblingCount,
      x: 24 + depth * (nodeWidth + levelGap), y: start, width: nodeWidth, height: heights.get(row.id),
      childCount: (children.get(row.id) || []).length, expanded: !closed.has(row.id) };
    nodes.push(node); positions.set(node.id, node); width = Math.max(width, node.x + nodeWidth + 24);
    const parent = positions.get(row.parent_id);
    if (parent) {
      const x1 = parent.x + nodeWidth, y1 = parent.y + parent.height / 2, x2 = node.x, y2 = node.y + node.height / 2;
      edges.push({ id: row.id, parentId: parent.id, x1, y1, x2, y2, path: `M ${x1} ${y1} H ${(x1 + x2) / 2} V ${y2} H ${x2}` });
    }
    let offset = start;
    if (node.expanded) for (const child of children.get(row.id) || []) { starts.set(child.id, offset); offset += spans.get(child.id) + siblingGap; }
  }
  return { nodes, edges, width, height: Math.max(48, cursor - siblingGap * 2 + 24) };
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

export function fitContextTree(layout, width, height, minimumScale = 0.85) {
  const scale = Math.min(1, Math.max(minimumScale, Math.min((width - 32) / layout.width, (height - 32) / layout.height)));
  return { scale, x: Math.max(8, (width - layout.width * scale) / 2), y: Math.max(8, (height - layout.height * scale) / 2) };
}
