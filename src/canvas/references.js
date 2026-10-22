// Canvas naplet references: a shareable link that names a workspace, canvas
// and naplet by their Tower ids. The link carries no local workspace key,
// session, token or source identity. Opening it is an ordinary authorized
// canvas load; it never grants access.

const text = value => String(value ?? '').trim();
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const validId = value => ID.test(text(value));
const MIN_SCALE = 0.2; // Canvas zoom minimum (interactions.js zoomViewport).

export const CANVAS_REFERENCE_UNAVAILABLE = 'The referenced item is unavailable. It may have been removed, or you may not have access.';
export const CANVAS_REFERENCE_WORKSPACE_MISSING = 'Open this workspace in Ambulando with the signed-in identity it belongs to, then open the link again.';

/** Full browser URL for one naplet: `/canvas.html?workspaceid=…&canvasid=…&napletid=…`. */
export function canvasReferenceUrl({ origin, workspaceId, canvasId, napletId }) {
  if (![workspaceId, canvasId, napletId].every(validId) || !/^https?:\/\//.test(text(origin))) return '';
  const url = new URL('/canvas.html', text(origin));
  url.searchParams.set('workspaceid', text(workspaceId));
  url.searchParams.set('canvasid', text(canvasId));
  url.searchParams.set('napletid', text(napletId));
  return url.href;
}

const markdownLabel = value => text(value).replace(/\s+/g, ' ').replace(/[\\[\]]/g, match => `\\${match}`);

/**
 * Copyable reference for a readable naplet. Restricted placeholders have no
 * reference: the copy would only describe what the viewer cannot read.
 */
export function canvasNapletReference({ origin, workspaceId, canvas, naplet }) {
  if (naplet?.access !== 'ready') return null;
  const url = canvasReferenceUrl({ origin, workspaceId, canvasId: canvas?.id || canvas?.canvas_id, napletId: naplet.id });
  if (!url) return null;
  const label = [text(naplet.title) || 'Untitled naplet', text(canvas?.title)].filter(Boolean).join(' · ');
  return { url, label, markdown: `[${markdownLabel(label)}](${url})` };
}

/** Reads the canvas page query. `napletId` is '' when absent; malformed ids are reported, never echoed. */
export function parseCanvasReference(search) {
  const params = new URLSearchParams(search || '');
  const workspaceId = text(params.get('workspaceid'));
  const workspaceKey = text(params.get('workspacekey'));
  const canvasId = text(params.get('canvasid'));
  const napletParam = params.has('napletid') ? text(params.get('napletid')) : null;
  return {
    workspaceId: validId(workspaceId) ? workspaceId : '',
    workspaceIdMalformed: Boolean(workspaceId) && !validId(workspaceId),
    workspaceKey,
    canvasId: validId(canvasId) ? canvasId : '',
    napletId: napletParam && validId(napletParam) ? napletParam : '',
    napletRequested: napletParam !== null,
    ...(validId(params.get('versionid')) ? { versionId: text(params.get('versionid')) } : {}),
    ...(validId(params.get('sourceid')) ? { sourceId: text(params.get('sourceid')) } : {}),
  };
}

/**
 * The local workspace entry for a reference. Workspace keys are local to one
 * browser profile and identity, so references name the Tower workspace id; an
 * entry for another signed-in identity is never chosen.
 */
export function findReferenceWorkspace(workspaces, { workspaceId, workspaceKey, sessionNpub }) {
  const rows = (workspaces || []).filter(Boolean);
  if (workspaceId) {
    const matching = rows.filter(row => row.pgBackendMode && text(row.workspaceId) === workspaceId);
    return matching.find(row => text(row.pgSessionNpub) === text(sessionNpub))
      || matching.find(row => !text(row.pgSessionNpub))
      || null;
  }
  return rows.find(row => row.workspaceKey === workspaceKey || row.workspaceId === workspaceKey) || null;
}

/** The referenced naplet when it is readable on this canvas; missing and restricted look the same. */
export function canvasReferenceTarget(naplets, napletId) {
  const naplet = napletId ? (naplets || []).find(row => row.id === napletId) : null;
  return naplet?.access === 'ready' ? naplet : null;
}

/**
 * Viewer-local viewport that centres a layout in the stage. A target larger
 * than the stage is zoomed out to fit, never in, and never below `minScale`
 * (the canvas zoom floor); if it still cannot fit, its top-left (title bar)
 * stays in view.
 */
export function centredViewport(layout, stage, viewport, margin = 24, minScale = MIN_SCALE) {
  const current = Number(viewport?.scale) > 0 ? Number(viewport.scale) : 1;
  const width = Number(stage?.width) || 0, height = Number(stage?.height) || 0;
  const fit = Math.min((width - margin * 2) / Math.max(1, layout.width), (height - margin * 2) / Math.max(1, layout.height));
  const scale = Math.min(current, Math.max(minScale, fit));
  const axis = (start, size, available) => (size * scale > available - margin * 2
    ? margin - start * scale
    : available / 2 - (start + size / 2) * scale);
  return {
    x: Math.round(axis(layout.x, layout.width, width)),
    y: Math.round(axis(layout.y, layout.height, height)),
    scale,
  };
}

/** Writes text to the clipboard. Resolves `{ ok: false }` instead of claiming success. */
export async function copyCanvasReference(value, clipboard = globalThis.navigator?.clipboard) {
  if (!value) return { ok: false, reason: 'unavailable' };
  if (typeof clipboard?.writeText !== 'function') return { ok: false, reason: 'unsupported' };
  try { await clipboard.writeText(value); return { ok: true }; } catch { return { ok: false, reason: 'denied' }; }
}
