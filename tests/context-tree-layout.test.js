import { describe, expect, it } from 'vitest';
import { layoutContextTree, contextPath, fitContextTree } from '../src/context-tree-layout.js';
const row = (id, parent_id = null, sort_order = 0) => ({ id, title: id, parent_id, sort_order });

describe('automatic Context Tree forest layout', () => {
  it('places deterministic sibling order, separate roots and parent edges without overlap', () => {
    const rows = [row('b'), row('a'), row('z', 'a', 2), row('y', 'a', 1), row('leaf', 'y')];
    const tree = layoutContextTree(rows);
    expect(tree).toEqual(layoutContextTree(rows.slice().reverse()));
    expect(tree.nodes.map(n => n.id)).toEqual(['a', 'y', 'leaf', 'z', 'b']);
    const byId = new Map(tree.nodes.map(n => [n.id, n]));
    for (const edge of tree.edges) {
      const parent = byId.get(edge.parentId), child = byId.get(edge.id);
      expect(edge.x1).toBe(parent.x + parent.width / 2); expect(edge.y1).toBe(parent.y + parent.height);
      expect(edge.x2).toBe(child.x + child.width / 2); expect(edge.y2).toBe(child.y);
      expect(child.y).toBeGreaterThan(parent.y + parent.height);
    }
    for (const a of tree.nodes) for (const b of tree.nodes) if (a.id !== b.id) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(byId.get('b').x).toBeGreaterThan(byId.get('z').x + byId.get('z').width);
  });
  it('collapses descendants only and supports multiple parentless trees', () => {
    const tree = layoutContextTree([row('a'), row('a1', 'a'), row('a2', 'a1'), row('b'), row('b1', 'b')], ['a']);
    expect(tree.nodes.map(n => n.id)).toEqual(['a', 'b', 'b1']);
    expect(tree.nodes[0]).toMatchObject({ childCount: 1, expanded: false });
    expect(tree.edges.map(e => e.id)).toEqual(['b1']);
  });
  it('handles a 12,000-level chain iteratively and a 4,000-child wide root', () => {
    const deep = Array.from({ length: 12000 }, (_, i) => row(`n${i}`, i ? `n${i - 1}` : null));
    const start = performance.now(), layout = layoutContextTree(deep);
    expect(layout.nodes).toHaveLength(12000); expect(layout.edges).toHaveLength(11999);
    expect(contextPath(deep, 'n11999')).toHaveLength(12000);
    const wide = layoutContextTree([row('root'), ...Array.from({ length: 4000 }, (_, i) => row(`c${i}`, 'root', i))]);
    expect(wide.nodes).toHaveLength(4001);
    const children = wide.nodes.slice(1);
    for (let i = 1; i < children.length; i++) expect(children[i].x).toBeGreaterThanOrEqual(children[i - 1].x + children[i - 1].width);
    console.log('context layout 12000-deep + 4000-wide elapsed ms', Math.round(performance.now() - start));
  });
  it('ignores deleted, missing-parent and cycle-only records without inventing roots', () => {
    const tree = layoutContextTree([row('visible'), { ...row('deleted'), deleted_at: 'now' }, row('missing', 'absent'), row('a', 'b'), row('b', 'a')]);
    expect(tree.nodes.map(n => n.id)).toEqual(['visible']);
    expect(contextPath([row('a', 'b'), row('b', 'a')], 'a')).toHaveLength(2);
  });
  it('fits all ordinary bounds and yields finite empty/deep view transforms', () => {
    for (const rows of [[], [row('a')], [row('a'), row('b')]]) {
      const tree = layoutContextTree(rows), view = fitContextTree(tree, 700, 450);
      expect(view.x).toBeGreaterThanOrEqual(0); expect(view.y).toBeGreaterThanOrEqual(0);
      expect(tree.width * view.scale).toBeLessThanOrEqual(700);
      expect(tree.height * view.scale).toBeLessThanOrEqual(450);
    }
  });
});
