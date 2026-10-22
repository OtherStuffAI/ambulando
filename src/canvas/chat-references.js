// Canvas references are visible Markdown links in the signed message body.
// Labels are presentation; IDs name records, and Tower authorizes every open.
const text = value => String(value ?? '').trim();
const id = value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text(value));
export const canvasQuery = value => /^canvas(?::.*)?$/i.test(String(value || ''));
const labelText = value => text(value).replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&');

export function canvasChatReference({ origin, workspaceId, canvasId, title, napletId = '', sourceId = '', versionId = '', from = false }) {
  if (![workspaceId, canvasId].every(id) || !/^https?:\/\//.test(text(origin)) || (napletId && !id(napletId))) return null;
  const url = new URL('/canvas.html', origin);
  url.searchParams.set('workspaceid', workspaceId);
  url.searchParams.set('canvasid', canvasId);
  if (napletId) url.searchParams.set('napletid', napletId);
  if (sourceId && id(sourceId)) url.searchParams.set('sourceid', sourceId);
  if (versionId && id(versionId)) url.searchParams.set('versionid', versionId);
  if (from) url.searchParams.set('context', 'origin');
  const label = `${from ? 'From: ' : ''}${text(title) || 'Canvas'}`;
  return { type: napletId ? 'canvas-item' : 'canvas', id: napletId || canvasId, label, url: url.href, token: `[${labelText(label)}](${url.href})` };
}

export function parseCanvasChatReference(href) {
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/canvas.html'
      || !id(url.searchParams.get('workspaceid')) || !id(url.searchParams.get('canvasid'))
      || (url.searchParams.has('napletid') && !id(url.searchParams.get('napletid')))) return null;
    return { url: url.href, from: url.searchParams.get('context') === 'origin' };
  } catch { return null; }
}

// Small projection of an already-authorized Canvas; never carry document, HTML,
// scene or conversation bytes through the composer bridge.
export function canvasChatProjection(store, origin) {
  const workspaceId = store.currentWorkspace?.workspaceId;
  const canvasId = store.canvasId;
  const canvas = store.canvas;
  if (!canvas || store.status !== 'ready') return null;
  const reference = canvasChatReference({ origin, workspaceId, canvasId, title: canvas.title });
  if (!reference) return null;
  return { workspaceId, canvasId, title: canvas.title, items: (store.naplets || []).filter(row => row.access === 'ready' && !row._chatDraft).map(row => {
    const content = row.source?.type === 'html' ? store.htmlContent?.(row) || row.content : row.content;
    const board = row.source?.type === 'excalidraw' ? store.boardState?.(row) : null;
    const versionId = board?.viewing_version_id || board?.base_version_id || row.source?.version_id || content?.version_id || content?.current_version_id || '';
    const version = board?.viewing_version_number || board?.base_version_number || content?.version_number || content?.current_version_number;
    return canvasChatReference({ origin, workspaceId, canvasId, title: `${row.title}${version ? ` · v${version}` : ''}`, napletId: row.id, sourceId: row.source?.id, versionId });
  }).filter(Boolean) };
}

export function canvasChatSuggestions(query, canvases, current, origin, workspaceId) {
  if (!canvasQuery(query)) return [];
  const filter = String(query).replace(/^canvas:?/i, '').trim().toLowerCase();
  const thisAlias = ['this', 'thiscanvas'].includes(filter.replace(/\s/g, ''));
  const rows = [];
  if (current?.workspaceId === workspaceId) {
    const ref = canvasChatReference({ origin, workspaceId, canvasId: current.canvasId, title: current.title });
    if (ref && (!filter || thisAlias || `this canvas ${current.title}`.toLowerCase().includes(filter))) rows.push({ ...ref, label: 'This Canvas', referenceLabel: ref.label, sublabel: current.title });
  }
  if (thisAlias) return rows;
  for (const canvas of canvases || []) {
    const ref = canvasChatReference({ origin, workspaceId, canvasId: canvas.canvas_id, title: canvas.title });
    if (ref && canvas.canvas_id !== current?.canvasId && (!filter || ref.label.toLowerCase().includes(filter))) rows.push({ ...ref, sublabel: 'Canvas' });
  }
  if (current?.workspaceId === workspaceId) for (const item of current.items || []) {
    if (!filter || item.label.toLowerCase().includes(filter)) rows.push({ ...item, sublabel: 'Item on this Canvas' });
  }
  return rows;
}

export function withCanvasChatOrigin(body, current, origin, workspaceId) {
  if (!current || current.workspaceId !== workspaceId) return body;
  const ref = canvasChatReference({ origin, workspaceId, canvasId: current.canvasId, title: current.title, from: true });
  return ref && !String(body).startsWith(`${ref.token}\n\n`) ? `${ref.token}\n\n${body}` : body;
}

export function createCanvasReferencePill(doc, reference) {
  const pill = doc.createElement('a');
  pill.className = 'mention-composer-pill canvas-reference-pill';
  pill.contentEditable = 'false';
  pill.dataset.mentionToken = reference.token;
  pill.href = reference.url;
  pill.target = '_blank'; pill.rel = 'noopener noreferrer';
  pill.textContent = reference.referenceLabel || reference.label;
  pill.setAttribute('aria-label', `Canvas reference ${pill.textContent}`);
  return pill;
}

// Coalesce typing lookups and briefly reuse the authorized list for this exact
// backend/workspace/viewer partition. Never carry a result into another identity.
export class CanvasReferenceCatalog {
  read(partition, load, now = Date.now()) {
    if (this.current?.partition === partition && (this.current.pending || this.current.expires > now)) return this.current.promise;
    const entry = { partition, pending: true, expires: 0, promise: null };
    entry.promise = Promise.resolve().then(load).then(rows => {
      entry.pending = false; entry.expires = Date.now() + 5000;
      return rows;
    }, error => {
      if (this.current === entry) this.current = null;
      throw error;
    });
    this.current = entry;
    return entry.promise;
  }
}
