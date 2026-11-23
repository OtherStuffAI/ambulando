// System Flow is a private versioned File, retaining the legacy editable schema.
import { validateEditableFlow } from './system-flow-schema.js';
export const FLOW_CONTENT_TYPE = 'application/vnd.ambulando.system-flow+json';
export const FLOW_MAX_BYTES = 32 * 1024 * 1024;
export function readSystemFlow(source) {
  if (new TextEncoder().encode(source).length > FLOW_MAX_BYTES) throw Error('System Flow exceeds 32 MiB.');
  return validateEditableFlow(JSON.parse(source));
}
export function flowDiagrams(flow) { return flow?.schemaVersion === 1 ? [{ id: 'root', title: flow.title || 'Flow', nodes: flow.nodes, edges: flow.edges }] : flow?.diagrams || []; }
export function updateFlowEntity(flow, diagramId, entity, id, patch) {
  const next = JSON.parse(JSON.stringify(flow));
  const diagram = next.schemaVersion === 1 ? next : next.diagrams.find(d => d.id === diagramId);
  const row = diagram?.[entity]?.find(n => n.id === id);
  if (!row || !['nodes', 'edges'].includes(entity)) throw Error('Choose an existing flow item.');
  if (entity === 'nodes') {
    if (patch.data) row.data = { ...row.data, ...patch.data };
    if (patch.position) row.position = { ...row.position, ...patch.position };
  } else Object.assign(row, patch);
  validateEditableFlow(next); return next;
}
const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderFlowSvg(flow, diagramId) {
  const d = flowDiagrams(flow).find(d => d.id === diagramId) || flowDiagrams(flow)[0];
  if (!d) return '';
  const byId = new Map(d.nodes.map(n => [n.id, n]));
  const position = n => { let x = n.position.x, y = n.position.y, parent = n.parentId; const seen = new Set([n.id]); while (parent && !seen.has(parent)) { seen.add(parent); const p = byId.get(parent); if (!p) break; x += p.position.x; y += p.position.y; parent = p.parentId; } return { x, y }; };
  const boxes = d.nodes.map(n => ({ ...n, ...position(n), w: n.width || 180, h: n.height || 90 }));
  const index = new Map(boxes.map(n => [n.id, n]));
  const x = Math.min(0, ...boxes.map(n => n.x)) - 30, y = Math.min(0, ...boxes.map(n => n.y)) - 30;
  const w = Math.max(600, ...boxes.map(n => n.x + n.w)) - x + 30, h = Math.max(300, ...boxes.map(n => n.y + n.h)) - y + 30;
  const nodes = boxes.sort((a,b) => (a.data.kind !== 'system') - (b.data.kind !== 'system')).map(n => `<g><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.data.kind === 'decision' ? 30 : 6}" fill="${n.data.kind === 'system' ? 'none' : 'var(--background,white)'}" stroke="currentColor"/><text x="${n.x + 12}" y="${n.y + 22}" fill="currentColor" font-size="12">${escapeMarkup(n.data.kind)}${n.data.owner ? ' · '+escapeMarkup(n.data.owner) : ''}</text><text x="${n.x + 12}" y="${n.y + 48}" fill="currentColor" font-size="15">${escapeMarkup(n.data.label)}</text><title>${escapeMarkup(n.data.label)}\n${escapeMarkup(n.data.description)}</title></g>`).join('');
  const edges = d.edges.map(e => { const a = index.get(e.source), b = index.get(e.target); if (!a || !b) return ''; const sx=a.x+a.w, sy=a.y+a.h/2, tx=b.x, ty=b.y+b.h/2; return `<g><path d="M${sx},${sy} L${(sx+tx)/2},${sy} L${(sx+tx)/2},${ty} L${tx},${ty}" fill="none" stroke="currentColor" marker-end="url(#flow-arrow)"/><text x="${(sx+tx)/2+4}" y="${(sy+ty)/2-6}" fill="currentColor" font-size="12">${escapeMarkup(e.label || e.relationship)}</text></g>`; }).join('');
  return `<svg role="img" aria-label="System Flow diagram" xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" style="width:100%;min-height:300px"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>${nodes}${edges}</svg>`;
}
