import Alpine from 'alpinejs';
import { tryAutoLoginFromStorage, pubkeyToNpub } from '../auth/nostr.js';
import { setActiveSessionNpub } from '../crypto/group-keys.js';
import { getSettings, openWorkspaceDb } from '../db.js';
import { initializeTowerTransports } from '../tower-transport.js';
import { normalizeWorkspaceEntry } from '../workspaces.js';
import { canvasContext, CANVAS_ACCESS_MESSAGE } from './projection.js';
import { buildCanvasHtmlDocument } from './sandbox.js';
import { CanvasSyncRuntime } from './sync-service.js';
import { canvasWheelIntent, worldPoint, zoomViewport } from './interactions.js';
import '../ambulando-tokens.css';
import './styles.css';

const text = value => String(value ?? '').trim();
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const clone = value => structuredClone(value);
const pointDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const pointCenter = (a, b) => ({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
const canvasDom = Object.freeze({
  stage: '.canvas-stage',
  addDialog: '.canvas-add-dialog',
  commentDialog: '.canvas-comment-dialog',
  commentPanel: '.canvas-comment-panel',
});

function canvasElement(name) {
  const element = document.querySelector(canvasDom[name]);
  if (!element) throw new Error(`Canvas ${name} is unavailable.`);
  return element;
}

function openCanvasDialog(name) {
  Alpine.nextTick(() => {
    const dialog = canvasElement(name);
    if (!dialog.open) dialog.showModal();
  });
}

function findWorkspace(settings, requestedKey) {
  return (settings?.knownWorkspaces || []).map(normalizeWorkspaceEntry).filter(Boolean)
    .find(workspace => workspace.workspaceKey === requestedKey || workspace.workspaceId === requestedKey) || null;
}
function sourceTitle(row, fallback) { return text(row?.title || row?.name || row?.subject || row?.file_name || fallback); }

export function canvasPageStore() {
  let syncRuntime = null;
  const pointers = new Map(), undo = [], redo = [];
  let keydown = null;
  return {
    status: 'loading', error: '', workspace: null, session: null, currentWorkspace: null,
    currentWorkspaceKey: '', currentViewerNpub: '', currentPgActorId: '', canvas: null,
    naplets: [], elements: [], comments: [], viewport: { x: 0, y: 0, scale: 1 },
    interaction: null, tool: 'select', selected: null, saving: false, viewportSaving: false,
    editingTextId: '', editingText: '', sourceOptions: [], sourceSearch: '',
    addDialog: { type: 'document', sourceId: '', title: '' },
    commentDialog: { anchor: null, parentCommentId: null, body: '' }, activeCommentId: '',
    accessMessage: CANVAS_ACCESS_MESSAGE, historyTick: 0,

    get canvasId() { return text(new URLSearchParams(location.search).get('canvasid')); },
    get transformStyle() { return `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.scale})`; },
    get canUndo() { return this.historyTick >= 0 && undo.length > 0; },
    get canRedo() { return this.historyTick >= 0 && redo.length > 0; },
    get unresolvedComments() { return this.comments.filter(row => !row.parent_comment_id && !row.resolved_at); },
    get activeComment() { return this.comments.find(row => row.id === this.activeCommentId) || null; },
    get activeReplies() { return this.comments.filter(row => row.parent_comment_id === this.activeCommentId); },
    get filteredSourceOptions() {
      const query = text(this.sourceSearch).toLowerCase();
      return this.sourceOptions.filter(row => row.type === this.addDialog.type && (!query || row.title.toLowerCase().includes(query))).slice(0, 100);
    },

    async init() {
      try {
        await initializeTowerTransports();
        const params = new URLSearchParams(location.search), settings = await getSettings();
        const workspace = findWorkspace(settings, text(params.get('workspacekey')) || text(settings?.currentWorkspaceKey));
        if (!workspace?.pgBackendMode || !workspace.workspaceId || !this.canvasId) throw new Error('This Canvas link is incomplete. Return to Ambulando and open it again.');
        const storedAuth = await tryAutoLoginFromStorage();
        if (!storedAuth?.pubkey) throw new Error('Open Ambulando and sign in, then reopen this canvas.');
        const npub = await pubkeyToNpub(storedAuth.pubkey);
        if (workspace.pgSessionNpub && workspace.pgSessionNpub !== npub) throw new Error('This canvas belongs to a different signed-in workspace identity.');
        Object.assign(this, { workspace, currentWorkspace: workspace, currentWorkspaceKey: workspace.workspaceKey, currentViewerNpub: npub, currentPgActorId: text(workspace.pgMe?.actor?.actor_id), session: { pubkey: storedAuth.pubkey, npub, method: storedAuth.method } });
        setActiveSessionNpub(npub);
        const db = openWorkspaceDb(workspace.workspaceKey); await db.open();
        syncRuntime = new CanvasSyncRuntime(this.context(), this.canvasId, { onSnapshot: snapshot => this.applySnapshot(snapshot), onError: error => this.applySyncError(error) });
        keydown = event => this.handleKeydown(event); addEventListener('keydown', keydown);
        addEventListener('pagehide', () => { syncRuntime?.stop(); removeEventListener('keydown', keydown); }, { once: true });
        syncRuntime.start();
      } catch (error) { this.status = 'error'; this.error = error?.message || 'Canvas could not be opened.'; }
    },
    context() { return canvasContext(this); },
    applySnapshot(snapshot) {
      this.canvas = snapshot.canvas; this.naplets = snapshot.naplets; this.elements = snapshot.elements || []; this.comments = snapshot.comments || [];
      this.viewport = { ...snapshot.canvas.viewport };
      if (this.selected && !this.findSelected()) this.selected = null;
      document.title = `${snapshot.canvas.title} · Canvas · Ambulando`; this.status = 'ready'; this.error = '';
    },
    applySyncError(error) {
      this.canvas = null; this.naplets = []; this.elements = []; this.comments = []; this.status = 'error';
      this.error = error?.status === 403 || error?.status === 404 ? 'Canvas unavailable.' : (error?.message || 'Canvas could not be refreshed.');
    },
    async refresh() { this.status = 'loading'; this.error = ''; await syncRuntime?.refresh().catch(() => undefined); },
    stageRect() { return canvasElement('stage').getBoundingClientRect(); },
    toWorld(event) { return worldPoint(this.viewport, event, this.stageRect()); },
    zoomBy(factor, origin = null) {
      const rect = this.stageRect(), point = origin || { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      this.viewport = zoomViewport(this.viewport, factor, point, rect); this.queueViewportSave();
    },
    resetViewport() { this.viewport = { x: 0, y: 0, scale: 1 }; this.queueViewportSave(); },
    fitToContent() {
      const items = [...this.naplets, ...this.elements]; if (!items.length) return this.resetViewport();
      const bounds = items.reduce((box, item) => ({ minX: Math.min(box.minX, item.layout.x), minY: Math.min(box.minY, item.layout.y), maxX: Math.max(box.maxX, item.layout.x + item.layout.width), maxY: Math.max(box.maxY, item.layout.y + item.layout.height) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const rect = this.stageRect(), padding = 80;
      const scale = clamp(Math.min((rect.width - padding) / Math.max(1, bounds.maxX - bounds.minX), (rect.height - padding) / Math.max(1, bounds.maxY - bounds.minY)), 0.2, 3);
      this.viewport = { x: (rect.width - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale, y: (rect.height - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale, scale }; this.queueViewportSave();
    },
    handleWheel(event) {
      event.preventDefault();
      if (canvasWheelIntent(event) === 'zoom') this.viewport = zoomViewport(this.viewport, Math.exp(-event.deltaY * 0.002), event, this.stageRect());
      else { this.viewport.x -= event.deltaX; this.viewport.y -= event.deltaY; }
      this.queueViewportSave();
    },
    setTool(tool) { this.tool = tool; if (tool !== 'select') this.selected = null; },
    select(type, id) { if (this.tool === 'comment') return; this.tool = 'select'; this.selected = { type, id }; },
    findSelected() { return this.selected?.type === 'naplet' ? this.naplets.find(row => row.id === this.selected.id) : this.elements.find(row => row.id === this.selected?.id); },
    handleStagePointerDown(event) {
      pointers.set(event.pointerId, event); event.currentTarget.setPointerCapture?.(event.pointerId);
      if (event.pointerType === 'touch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()]; this.interaction = { type: 'pinch', distance: pointDistance(a, b), viewport: { ...this.viewport }, center: pointCenter(a, b) }; return;
      }
      if (event.button !== 0) return;
      const point = this.toWorld(event);
      if (this.tool === 'comment') return this.openCommentDialog({ type: 'canvas', x: point.x, y: point.y });
      if (this.tool === 'hand' || (event.pointerType === 'touch' && this.tool === 'select')) { this.interaction = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.viewport.x, y: this.viewport.y }; return; }
      if (this.tool === 'select') { this.selected = null; return; }
      if (this.tool === 'text') return this.createTextAt(point);
      if (this.tool === 'embed') return this.openAddDialog(point);
      const kind = this.tool;
      const element = { kind, layout: { x: Math.round(point.x), y: Math.round(point.y), width: 8, height: 8, z: this.highestZ() + 1 }, data: kind === 'draw' ? { points: [[0, 0]] } : {} };
      this.interaction = { type: 'create', pointerId: event.pointerId, start: point, element };
    },
    startItemInteraction(type, item, event, action = 'move') {
      if (this.tool === 'comment') {
        event.stopPropagation();
        return type === 'naplet' && item.access === 'ready'
          ? this.openCommentDialog({ type: 'naplet', naplet_id: item.id })
          : this.openCommentDialog({ type: 'canvas', x: item.layout.x, y: item.layout.y });
      }
      if (this.tool === 'eraser') { event.stopPropagation(); return this.deleteItem(type, item); }
      if (this.tool !== 'select' || event.button !== 0 || this.editingTextId) return;
      event.stopPropagation(); this.select(type, item.id); event.currentTarget.setPointerCapture?.(event.pointerId);
      this.interaction = { type: action, pointerId: event.pointerId, itemType: type, id: item.id, startX: event.clientX, startY: event.clientY, before: clone(item.layout) };
    },
    movePointer(event) {
      pointers.set(event.pointerId, event); const state = this.interaction; if (!state) return;
      if (state.type === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()], center = pointCenter(a, b), factor = pointDistance(a, b) / Math.max(1, state.distance);
        this.viewport = zoomViewport(state.viewport, factor, center, this.stageRect()); this.viewport.x += center.clientX - state.center.clientX; this.viewport.y += center.clientY - state.center.clientY; return;
      }
      if (state.pointerId !== event.pointerId) return;
      if (state.type === 'pan') { this.viewport.x = state.x + event.clientX - state.startX; this.viewport.y = state.y + event.clientY - state.startY; return; }
      if (state.type === 'create') {
        const point = this.toWorld(event), dx = point.x - state.start.x, dy = point.y - state.start.y;
        state.element.layout = { ...state.element.layout, x: Math.round(Math.min(point.x, state.start.x)), y: Math.round(Math.min(point.y, state.start.y)), width: Math.max(8, Math.round(Math.abs(dx))), height: Math.max(8, Math.round(Math.abs(dy))) };
        if (state.element.kind === 'draw') state.element.data.points.push([Math.round(point.x - state.start.x), Math.round(point.y - state.start.y)]); return;
      }
      const item = state.itemType === 'naplet' ? this.naplets.find(row => row.id === state.id) : this.elements.find(row => row.id === state.id); if (!item) return;
      const dx = (event.clientX - state.startX) / this.viewport.scale, dy = (event.clientY - state.startY) / this.viewport.scale;
      item.layout = state.type === 'resize'
        ? { ...item.layout, width: Math.max(state.itemType === 'naplet' ? 220 : 8, Math.round(state.before.width + dx)), height: Math.max(state.itemType === 'naplet' ? 160 : 8, Math.round(state.before.height + dy)) }
        : { ...item.layout, x: Math.round(state.before.x + dx), y: Math.round(state.before.y + dy) };
    },
    async endPointer(event) {
      pointers.delete(event.pointerId); const state = this.interaction;
      if (!state || state.type === 'pinch') { if (pointers.size < 2 && state?.type === 'pinch') { this.interaction = null; this.queueViewportSave(); } return; }
      if (state.pointerId !== event.pointerId) return; this.interaction = null;
      if (state.type === 'pan') return this.saveViewport();
      if (state.type === 'create') {
        const element = state.element; if (element.kind === 'arrow' || element.kind === 'line') element.data = { ...element.data, direction: 'forward' };
        await this.mutate(() => syncRuntime.createElement(element)); this.tool = 'select'; const created = this.elements.at(-1); if (created) this.selected = { type: 'element', id: created.id }; return;
      }
      const item = state.itemType === 'naplet' ? this.naplets.find(row => row.id === state.id) : this.elements.find(row => row.id === state.id);
      if (!item || JSON.stringify(state.before) === JSON.stringify(item.layout)) return;
      const after = clone(item.layout);
      await this.mutate(() => state.itemType === 'naplet' ? syncRuntime.updateNapletLayout(item.id, after) : syncRuntime.updateElement(item.id, { layout: after }), { type: 'layout', itemType: state.itemType, id: item.id, before: state.before, after });
    },
    cancelPointer(event) { pointers.delete(event.pointerId); this.interaction = null; void this.refresh(); },
    queueViewportSave() { clearTimeout(this._viewportTimer); this._viewportTimer = setTimeout(() => this.saveViewport(), 350); },
    async saveViewport() {
      if (!this.canvas || this.viewportSaving) return; this.viewportSaving = true;
      try { await syncRuntime.updateViewport({ ...this.viewport }); } catch (error) { this.error = error?.message || 'Could not save canvas view.'; await this.refresh(); } finally { this.viewportSaving = false; }
    },
    highestZ() { return Math.max(0, ...this.naplets.map(row => row.layout.z), ...this.elements.map(row => row.layout.z)); },
    async createTextAt(point) {
      await this.mutate(() => syncRuntime.createElement({ kind: 'text', layout: { x: Math.round(point.x), y: Math.round(point.y), width: 240, height: 120, z: this.highestZ() + 1 }, data: { text: 'Text' } }));
      const created = this.elements.at(-1); if (created) { this.selected = { type: 'element', id: created.id }; this.beginTextEdit(created); } this.tool = 'select';
    },
    beginTextEdit(element) { if (element.kind !== 'text') return; this.editingTextId = element.id; this.editingText = String(element.data.text || ''); Alpine.nextTick(() => document.querySelector(`[data-text-editor="${element.id}"]`)?.focus()); },
    async saveTextEdit(element) {
      const next = this.editingText.trim() || 'Text', before = String(element.data.text || ''); this.editingTextId = ''; if (next === before) return;
      await this.mutate(() => syncRuntime.updateElement(element.id, { data: { ...element.data, text: next } }), { type: 'data', id: element.id, before: { ...element.data, text: before }, after: { ...element.data, text: next } });
    },
    async mutate(operation, history = null) {
      if (this.saving) return; this.saving = true; this.error = '';
      try { await operation(); if (history) { undo.push(history); redo.length = 0; this.historyTick += 1; } }
      catch (error) { this.error = error?.message || 'Canvas change could not be saved.'; await this.refresh(); }
      finally { this.saving = false; }
    },
    async deleteItem(type = this.selected?.type, item = this.findSelected()) { if (!item) return; await this.mutate(() => type === 'naplet' ? syncRuntime.deleteNaplet(item.id) : syncRuntime.deleteElement(item.id)); this.selected = null; },
    async duplicateSelected() {
      const item = this.findSelected(); if (!item) return;
      if (this.selected.type === 'naplet' && item.access !== 'ready') { this.error = 'Restricted items cannot be duplicated.'; return; }
      if (this.selected.type === 'naplet') return this.mutate(() => syncRuntime.addNaplet({ source: item.source, title: item.access === 'ready' ? item.title : undefined, layout: { ...item.layout, x: item.layout.x + 24, y: item.layout.y + 24, z: this.highestZ() + 1 } }));
      await this.mutate(() => syncRuntime.createElement({ kind: item.kind, data: clone(item.data), layout: { ...item.layout, x: item.layout.x + 24, y: item.layout.y + 24, z: this.highestZ() + 1 } }));
    },
    async orderSelected(delta) { const item = this.findSelected(); if (!item) return; const layout = { ...item.layout, z: clamp(item.layout.z + delta, 1, 100000) }; await this.mutate(() => this.selected.type === 'naplet' ? syncRuntime.updateNapletLayout(item.id, layout) : syncRuntime.updateElement(item.id, { layout })); },
    async undoChange() { const action = undo.pop(); if (!action) return; if (action.type === 'layout') await this.mutate(() => action.itemType === 'naplet' ? syncRuntime.updateNapletLayout(action.id, action.before) : syncRuntime.updateElement(action.id, { layout: action.before })); if (action.type === 'data') await this.mutate(() => syncRuntime.updateElement(action.id, { data: action.before })); redo.push(action); this.historyTick -= 1; },
    async redoChange() { const action = redo.pop(); if (!action) return; if (action.type === 'layout') await this.mutate(() => action.itemType === 'naplet' ? syncRuntime.updateNapletLayout(action.id, action.after) : syncRuntime.updateElement(action.id, { layout: action.after })); if (action.type === 'data') await this.mutate(() => syncRuntime.updateElement(action.id, { data: action.after })); undo.push(action); this.historyTick += 1; },
    handleKeydown(event) {
      if (event.target?.matches('input,textarea,[contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); return event.shiftKey ? this.redoChange() : this.undoChange(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); return this.duplicateSelected(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); return this.deleteItem(); }
      const keys = { v: 'select', h: 'hand', r: 'rectangle', d: 'diamond', o: 'ellipse', a: 'arrow', l: 'line', p: 'draw', t: 'text', e: 'eraser', f: 'frame', c: 'comment' };
      if (keys[event.key.toLowerCase()]) this.setTool(keys[event.key.toLowerCase()]);
    },
    async openAddDialog(point = null) {
      const rect = this.stageRect(); this.addDialog = { type: 'document', sourceId: '', title: '', point: point || this.toWorld({ clientX: rect.left + 80, clientY: rect.top + 80 }) };
      this.sourceSearch = ''; await this.loadSourceOptions(); openCanvasDialog('addDialog');
    },
    async loadSourceOptions() {
      const db = openWorkspaceDb(this.currentWorkspaceKey);
      const [documents, channels, messages] = await Promise.all([db.documents.toArray(), db.channels.toArray(), db.chat_messages.toArray()]);
      const active = row => !['deleted', 'archived'].includes(row.record_state);
      this.sourceOptions = [
        ...documents.filter(row => active(row) && !row.pg_storage_version_id && row.pg_record_type !== 'file').map(row => ({ type: 'document', id: row.record_id, title: sourceTitle(row, 'Untitled document') })),
        ...channels.filter(active).map(row => ({ type: 'task_list', id: row.record_id, title: `${sourceTitle(row, 'Channel')} tasks` })),
        ...messages.filter(row => active(row) && (row.pg_record_type === 'thread' || row.record_type === 'thread')).map(row => ({ type: 'chat_thread', id: row.record_id, title: sourceTitle(row, 'Chat thread') })),
        ...documents.filter(row => active(row) && row.pg_storage_version_id && /html/i.test(row.content_type || row.mime_type || '')).map(row => ({ type: 'html', id: row.pg_storage_version_id, title: sourceTitle(row, 'HTML artefact') })),
      ].filter(row => row.id && row.title).sort((a, b) => a.title.localeCompare(b.title));
    },
    chooseSource(option) { this.addDialog.sourceId = option.id; this.addDialog.title = option.title; },
    async addNaplet() {
      const sourceId = text(this.addDialog.sourceId); if (!sourceId || this.saving) return; const point = this.addDialog.point || { x: 80, y: 80 };
      await this.mutate(() => syncRuntime.addNaplet({ source: { type: this.addDialog.type, id: sourceId }, title: text(this.addDialog.title) || undefined, layout: { x: Math.round(point.x), y: Math.round(point.y), width: 380, height: 280, z: this.highestZ() + 1 } }));
      if (!this.error) canvasElement('addDialog').close();
    },
    openCommentDialog(anchor, parentCommentId = null) { if (anchor.type === 'naplet' && !anchor.naplet_id) return; this.commentDialog = { anchor, parentCommentId, body: '' }; openCanvasDialog('commentDialog'); },
    async submitComment() { const body = text(this.commentDialog.body); if (!body) return; await this.mutate(() => syncRuntime.createComment({ anchor: this.commentDialog.anchor, parent_comment_id: this.commentDialog.parentCommentId || undefined, body })); if (!this.error) canvasElement('commentDialog').close(); },
    openCommentThread(comment) { this.activeCommentId = comment.id; openCanvasDialog('commentPanel'); },
    async setCommentResolved(comment, resolved) { await this.mutate(() => syncRuntime.setCommentResolved(comment.id, resolved)); },
    commentCountForNaplet(id) { return this.unresolvedComments.filter(row => row.anchor.type === 'naplet' && row.anchor.naplet_id === id).length; },
    commentStyle(comment) { if (comment.anchor.type === 'naplet') { const naplet = this.naplets.find(row => row.id === comment.anchor.naplet_id); if (!naplet) return 'display:none'; return `left:${naplet.layout.x + naplet.layout.width - 14}px;top:${naplet.layout.y - 14}px`; } return `left:${comment.anchor.x - 14}px;top:${comment.anchor.y - 14}px`; },
    napletStyle(naplet) { const layout = naplet.layout; return `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;z-index:${layout.z}`; },
    elementStyle(element) { const layout = element.layout; return `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;z-index:${layout.z}`; },
    drawPoints(element) { return (element.data.points || []).map(point => point.join(',')).join(' '); },
    htmlDocument(naplet) { return buildCanvasHtmlDocument(naplet?.content?.html); },
  };
}

Alpine.store('canvas', canvasPageStore());
window.Alpine = Alpine;
Alpine.start();
