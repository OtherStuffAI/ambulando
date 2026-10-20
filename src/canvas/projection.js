import { resolveTowerPgWorkspaceContext } from '../pg-workspace-context.js';

export const CANVAS_SOURCE_TYPES = Object.freeze(['document', 'task_list', 'chat_thread', 'html']);
export const CANVAS_ACCESS_MESSAGE = 'Ask your workspace owner for access.';

const text = value => String(value ?? '').trim();
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function canvasContext(store) {
  const context = resolveTowerPgWorkspaceContext(store);
  const identity = context.workspace?.pgDescriptor?.identity || {};
  return {
    ...context,
    tower: text(context.workspace?.towerServiceNpub || identity.tower_service_npub),
    service: text(context.workspace?.workspaceServiceNpub || identity.workspace_service_npub),
    viewer: text(store.currentViewerNpub || store.session?.npub || context.sessionNpub),
    actorId: text(store.currentPgActorId || context.workspace?.pgMe?.actor?.actor_id),
    dbKey: text(store.currentWorkspaceKey || store.workspaceDbKey),
  };
}
export function canvasPartition(context) {
  return JSON.stringify([
    text(context.baseUrl), text(context.tower), text(context.service), text(context.workspaceId),
    text(context.appNpub), text(context.viewer), text(context.actorId), text(context.dbKey),
  ]);
}

export function canvasDefinitionKey(context, canvasId) {
  return JSON.stringify([canvasPartition(context), text(canvasId)]);
}

function assertIdentity(payload, context) {
  if (text(payload?.workspace_id) !== text(context.workspaceId)) throw new Error('Invalid Canvas workspace response');
  const expected = {
    workspace_id: context.workspaceId,
    app_npub: context.appNpub,
    tower_service_npub: context.tower,
    workspace_service_npub: context.service,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value && text(payload?.identity?.[key]) !== text(value)) throw new Error('Invalid Canvas authority response');
  }
}

function normalizeVisibility(value) {
  const mode = value?.mode === 'restricted' ? 'restricted' : 'workspace';
  return {
    mode,
    actor_ids: [...new Set((Array.isArray(value?.actor_ids) ? value.actor_ids : []).map(text).filter(Boolean))],
    group_ids: [...new Set((Array.isArray(value?.group_ids) ? value.group_ids : []).map(text).filter(Boolean))],
  };
}

function normalizeViewport(value) {
  return {
    x: Math.round(finite(value?.x, 0)),
    y: Math.round(finite(value?.y, 0)),
    scale: Math.max(0.2, Math.min(3, finite(value?.scale, 1))),
  };
}

export function normalizeCanvasDefinition(row, context) {
  const canvasId = text(row?.id || row?.canvas_id);
  const title = text(row?.title);
  if (!canvasId || !title || !Number.isSafeInteger(Number(row?.row_version)) || Number(row.row_version) < 1) {
    throw new Error('Invalid Canvas definition');
  }
  return {
    key: canvasDefinitionKey(context, canvasId),
    context: canvasPartition(context),
    canvas_id: canvasId,
    workspace_id: text(context.workspaceId),
    title,
    position: Math.max(1, Math.floor(finite(row?.position, 1))),
    visibility: normalizeVisibility(row?.visibility),
    viewport: normalizeViewport(row?.viewport),
    can_manage: row?.can_manage === true,
    row_version: Number(row.row_version),
    updated_at: text(row?.updated_at),
  };
}

export function normalizeCanvasList(payload, context) {
  assertIdentity(payload, context);
  if (payload?.complete !== true || !Array.isArray(payload?.canvases)) throw new Error('Incomplete Canvas list');
  const seen = new Set();
  const rows = payload.canvases.map(row => {
    const normalized = normalizeCanvasDefinition(row, context);
    if (seen.has(normalized.canvas_id)) throw new Error('Duplicate Canvas definition');
    seen.add(normalized.canvas_id);
    return normalized;
  });
  return rows.sort((a, b) => a.position - b.position || a.canvas_id.localeCompare(b.canvas_id));
}

function normalizeLayout(value) {
  return {
    x: Math.round(finite(value?.x, 0)),
    y: Math.round(finite(value?.y, 0)),
    width: Math.max(220, Math.min(1200, Math.round(finite(value?.width, 360)))),
    height: Math.max(160, Math.min(1000, Math.round(finite(value?.height, 280)))),
    z: Math.max(1, Math.min(100000, Math.round(finite(value?.z, 1)))),
  };
}

function normalizeContent(type, value) {
  const content = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (type === 'document') return { title: text(content.title), body: String(content.body ?? ''), updated_at: text(content.updated_at) };
  if (type === 'task_list') return { tasks: (Array.isArray(content.tasks) ? content.tasks : []).slice(0, 200).map(task => ({ id: text(task?.id), title: text(task?.title), state: text(task?.state) })).filter(task => task.id && task.title) };
  if (type === 'chat_thread') return { messages: (Array.isArray(content.messages) ? content.messages : []).slice(0, 200).map(message => ({ id: text(message?.id), author: text(message?.author), body: String(message?.body ?? ''), created_at: text(message?.created_at) })).filter(message => message.id) };
  return { html: String(content.html ?? ''), version: text(content.version), digest: text(content.digest) };
}

function normalizeReadyNaplet(row) {
  const sourceType = text(row?.source?.type);
  const sourceId = text(row?.source?.id);
  if (!CANVAS_SOURCE_TYPES.includes(sourceType) || !sourceId) throw new Error('Invalid Canvas source');
  const content = normalizeContent(sourceType, row?.content);
  return {
    id: text(row.id),
    access: 'ready',
    layout: normalizeLayout(row.layout),
    source: { type: sourceType, id: sourceId },
    title: text(row.title || content.title) || 'Untitled naplet',
    content,
    row_version: Number(row.row_version),
  };
}

export function normalizeCanvasNaplet(row) {
  const id = text(row?.id || row?.naplet_id);
  if (!id || !Number.isSafeInteger(Number(row?.row_version)) || Number(row.row_version) < 1) throw new Error('Invalid Canvas naplet');
  if (row?.access === 'denied') {
    // Deliberately drop every server-supplied source/content/title field.
    return { id, access: 'denied', layout: normalizeLayout(row.layout), row_version: Number(row.row_version) };
  }
  if (row?.access !== 'ready') throw new Error('Invalid Canvas naplet access state');
  return normalizeReadyNaplet({ ...row, id });
}

export function normalizeCanvasSnapshot(payload, context, canvasId, requestId) {
  assertIdentity(payload, context);
  if (payload?.complete !== true || text(payload?.canvas?.id || payload?.canvas?.canvas_id) !== text(canvasId)
    || !Array.isArray(payload?.naplets) || !text(requestId)) throw new Error('Incomplete Canvas snapshot');
  const definition = normalizeCanvasDefinition(payload.canvas, context);
  const seen = new Set();
  const naplets = payload.naplets.map(row => {
    const normalized = normalizeCanvasNaplet(row);
    if (seen.has(normalized.id)) throw new Error('Duplicate Canvas naplet');
    seen.add(normalized.id);
    return normalized;
  });
  return {
    key: canvasDefinitionKey(context, canvasId),
    context: canvasPartition(context),
    canvas_id: text(canvasId),
    request_id: text(requestId),
    authorized_at: new Date().toISOString(),
    canvas: definition,
    naplets,
  };
}
