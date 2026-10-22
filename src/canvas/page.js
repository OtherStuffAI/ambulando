import './task-tree.css';
import { canvasTaskTreeStore } from './task-tree-page.js';
import Alpine from 'alpinejs';
import { canvasChatStore } from './chat-page.js';
import { registerCanvasChatFrame } from './chat-frame.js';
import { registerCanvasCommentPopover } from './comment-popover.js';
import { registerCanvasWindow } from './window.js';
import { registerCanvasDocument } from './document.js';
import { registerCanvasHtml } from './html-naplet.js';
import { CanvasHtmlAssetStore } from './html-assets.js';
import { registerCanvasBoard } from './board-naplet.js';
import { canvasBoardStore } from './board-page.js';
import { canvasArtifactPickerStore } from './artifact-picker.js';
import { HtmlViewSequencer, htmlDisplayedAssets, htmlPolicyKey, reconcileHtmlViews } from './html-views.js';
import { buildSectionUrl } from '../route-helpers.js';
import '../docs/editor/document-typography.css';
import { tryAutoLoginFromStorage, pubkeyToNpub } from '../auth/nostr.js';
import { setActiveSessionNpub } from '../crypto/group-keys.js';
import { getSettings, openWorkspaceDb } from '../db.js';
import { initializeTowerTransports } from '../tower-transport.js';
import { normalizeWorkspaceEntry } from '../workspaces.js';
import { canvasContext, CANVAS_ACCESS_MESSAGE } from './projection.js';
import {
  CANVAS_REFERENCE_UNAVAILABLE, CANVAS_REFERENCE_WORKSPACE_MISSING, canvasNapletReference, canvasReferenceTarget,
  centredViewport, copyCanvasReference, findReferenceWorkspace, parseCanvasReference,
} from './references.js';
import { CanvasSyncRuntime, hydrateCanvasList } from './sync-service.js';
import {
  arrowGeometry, arrowPoints, arrowPath, canvasItemKey, canvasWheelIntent, cloneCanvasValue, enclosedItemKeys,
  groupBounds, groupDelta, moveArrowEndpoint, movementItems, selectionRect, worldPoint, zoomViewport,
} from './interactions.js';
import '../ambulando-tokens.css';
import './styles.css';

const text = value => String(value ?? '').trim();
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const pointDistance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const pointCenter = (a, b) => ({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
const canvasDom = Object.freeze({
  stage: '.canvas-stage',
  addDialog: '.canvas-add-dialog',
  commentDialog: '.canvas-comment-dialog',
  commentPanel: '.canvas-comment-panel',
  versionsDialog: '.canvas-versions-dialog',
  referenceDialog: '.canvas-reference-dialog',
});

function canvasElement(name) {
  const element = document.querySelector(canvasDom[name]);
  if (!element) throw new Error(`Canvas ${name} is unavailable.`);
  return element;
}

function openCanvasDialog(name) {
  Alpine.nextTick(() => {
    const dialog = canvasElement(name);
    if (name === 'addDialog') { if (!dialog.open) dialog.showModal(); }
    else dispatchEvent(new CustomEvent('canvas-comment-open', { detail: name }));
  });
}

function sourceTitle(row, fallback) { return text(row?.title || row?.name || row?.subject || row?.file_name || fallback); }
// HTML artefacts are Files; older cached rows may only carry a version id.
function isHtmlFile(row) {
  return row?.pg_record_type === 'file' && (/html/i.test(row.content_storage_content_type || row.content_type || row.mime_type || '') || /\.x?html?$/i.test(text(row.title)));
}

export function canvasPageStore() {
  let syncRuntime = null, assetStore = null, htmlAuthority = '';
  const htmlSequencer = new HtmlViewSequencer(), versionLoads = new Map();
  const pointers = new Map(), undo = [], redo = [];
  let keydown = null, noticeTimer = 0, highlightTimer = 0;
  return {
    status: 'loading', error: '', workspace: null, session: null, currentWorkspace: null,
    currentWorkspaceKey: '', currentViewerNpub: '', currentPgActorId: '', canvas: null,
    naplets: [], elements: [], comments: [], viewport: { x: 0, y: 0, scale: 1 },
    interaction: null, tool: 'select', selectedKeys: [], selectionBox: null, saving: false, viewportSaving: false,
    editingTextId: '', editingText: '', sourceOptions: [], sourceSearch: '', canvasChoicesError: '',
    addDialog: { type: 'document', sourceId: '', title: '' },
    commentDialog: { anchor: null, parentCommentId: null, body: '' }, activeCommentId: '',
    commentDelete: null, linkDrag: null, subjectPicker: false, suppressLinkClick: false,
    accessMessage: CANVAS_ACCESS_MESSAGE, historyTick: 0, htmlViews: {},
    // A naplet reference (`napletid`) is focused once per page load. Its centred
    // view is viewer-local until the viewer pans or zooms.
    reference: { napletId: '', requested: false, handled: false }, referenceHighlightId: '', viewportLocal: false,
    notice: '', referenceDialog: { napletId: '', markdown: '', url: '', message: '' }, versionsDialog: { napletId: '', returnFocus: null },
    ...canvasTaskTreeStore(),
    ...canvasBoardStore(),
    ...canvasChatStore(),
    ...canvasArtifactPickerStore(),

    get canvasId() { return text(new URLSearchParams(location.search).get('canvasid')); },
    get transformStyle() { return `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.scale})`; },
    get canUndo() { return this.historyTick >= 0 && undo.length > 0; },
    get canRedo() { return this.historyTick >= 0 && redo.length > 0; },
    get selected() {
      const [key] = this.selectedKeys;
      if (!key) return null;
      const separator = key.indexOf(':');
      return { type: key.slice(0, separator), id: key.slice(separator + 1) };
    },
    get canGroup() { return this.selectedKeys.length >= 2; },
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
        const link = parseCanvasReference(location.search), settings = await getSettings();
        const known = (settings?.knownWorkspaces || []).map(normalizeWorkspaceEntry).filter(Boolean);
        const incomplete = new Error('This Canvas link is incomplete. Return to Ambulando and open it again.');
        this.reference = { napletId: link.napletId, versionId: link.versionId, sourceId: link.sourceId, requested: link.napletRequested, handled: false };
        // References name the Tower workspace id; ordinary links keep the local key.
        let workspace = link.workspaceId ? null : findReferenceWorkspace(known, { workspaceKey: link.workspaceKey || text(settings?.currentWorkspaceKey) });
        if (link.workspaceIdMalformed || !this.canvasId || (!link.workspaceId && (!workspace?.pgBackendMode || !workspace.workspaceId))) throw incomplete;
        const storedAuth = await tryAutoLoginFromStorage();
        if (!storedAuth?.pubkey) throw new Error('Open Ambulando and sign in, then reopen this canvas.');
        const npub = await pubkeyToNpub(storedAuth.pubkey);
        if (link.workspaceId) workspace = findReferenceWorkspace(known, { workspaceId: link.workspaceId, sessionNpub: npub });
        if (!workspace) throw new Error(CANVAS_REFERENCE_WORKSPACE_MISSING);
        if (workspace.pgSessionNpub && workspace.pgSessionNpub !== npub) throw new Error('This canvas belongs to a different signed-in workspace identity.');
        Object.assign(this, { workspace, currentWorkspace: workspace, currentWorkspaceKey: workspace.workspaceKey, currentViewerNpub: npub, currentPgActorId: text(workspace.pgMe?.actor?.actor_id), session: { pubkey: storedAuth.pubkey, npub, method: storedAuth.method } });
        setActiveSessionNpub(npub);
        const db = openWorkspaceDb(workspace.workspaceKey); await db.open();
        assetStore = new CanvasHtmlAssetStore(this.context());
        syncRuntime = new CanvasSyncRuntime(this.context(), this.canvasId, { onSnapshot: snapshot => this.applySnapshot(snapshot), onError: error => this.applySyncError(error) });
        this.startTaskTrees(this.context(),{add:body=>syncRuntime.addNaplet(body),save:(id,body)=>syncRuntime.updateTaskTreeView(id,body),refresh:()=>syncRuntime.refresh()});
        this.startBoards(this.context());
        this.startChats(this.context(), { persist: body => syncRuntime.addNaplet(body), refresh: () => syncRuntime.refresh() });
        keydown = event => this.handleKeydown(event); addEventListener('keydown', keydown);
        addEventListener('pagehide', () => {
          syncRuntime?.stop(); assetStore?.clear(); this.stopTaskTrees(); this.stopBoards(); this.stopChats(); this.resetArtifactPicker(); removeEventListener('keydown', keydown);
          // A browser-history cache is not fresh authorization.
          this.status = 'loading'; this.canvas = null; this.naplets = []; this.elements = []; this.comments = [];
          this.clearHtmlViews(); this.closeNapletDialogs(); this.clearReferenceFeedback(); document.title = 'Canvas · Ambulando';
        });
        addEventListener('pageshow', event => {
          if (!event.persisted) return;
          this.startTaskTrees(this.context(),{add:body=>syncRuntime.addNaplet(body),save:(id,body)=>syncRuntime.updateTaskTreeView(id,body),refresh:()=>syncRuntime.refresh()});
          this.startBoards(this.context()); this.resumeChats(); addEventListener('keydown', keydown); syncRuntime?.start();
        });
        syncRuntime.start();
      } catch (error) { this.status = 'error'; this.error = error?.message || 'Canvas could not be opened.'; }
    },
    context() { return canvasContext(this); },
    applySnapshot(snapshot) {
      this.canvas = snapshot.canvas; this.naplets = this.mergeTreeNaplets(this.mergeChatNaplets(snapshot.naplets)); this.elements = snapshot.elements || []; this.comments = snapshot.comments || [];
      this.reconcileHtmlViews(snapshot.request_id);
      this.syncBoards(this.naplets);
      void this.syncTaskTrees(this.naplets);
      if (!this.viewportLocal) this.viewport = { ...snapshot.canvas.viewport };
      const available = new Set(this.allCanvasItems().map(row => row.key));
      this.selectedKeys = this.selectedKeys.filter(key => available.has(key));
      if (this.activeCommentId && !this.activeComment) { canvasElement('commentPanel').close(); this.activeCommentId = ''; }
      if (this.commentDialog.parentCommentId && !this.comments.some(row => row.id === this.commentDialog.parentCommentId)) canvasElement('commentDialog').close();
      if (this.versionsDialog.napletId && !this.versionsNaplet) document.querySelector(canvasDom.versionsDialog)?.close();
      // A copy fallback never outlives read access to the naplet it describes.
      if (this.referenceDialog.napletId && !canvasReferenceTarget(this.naplets, this.referenceDialog.napletId)) this.closeReferenceDialog();
      document.title = `${snapshot.canvas.title} · Canvas · Ambulando`; this.status = 'ready';
      this.focusReferenceTarget();
    },
    applySyncError(error) {
      this.syncBoards([]);
      this.canvas = null; this.naplets = []; this.elements = []; this.comments = []; this.status = 'error';
      this.clearHtmlViews(); this.closeNapletDialogs(); this.clearReferenceFeedback();
      this.error = error?.status === 403 || error?.status === 404 ? 'Canvas unavailable.' : (error?.message || 'Canvas could not be refreshed.');
    },
    refreshBoardsSnapshot() { return syncRuntime?.refresh().catch(() => undefined); },
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
      if (this.tool !== 'hand' && event.target.closest?.('.canvas-naplet,.canvas-element')) return;
      event.preventDefault();
      if (canvasWheelIntent(event) === 'zoom') this.viewport = zoomViewport(this.viewport, Math.exp(-event.deltaY * 0.005), event, this.stageRect());
      else { this.viewport.x -= event.deltaX; this.viewport.y -= event.deltaY; }
      this.queueViewportSave();
    },
    setTool(tool) { this.tool = tool; if (tool !== 'select') this.selectedKeys = []; },
    select(type, id, { additive = false, toggle = false } = {}) {
      if (this.tool === 'comment') return;
      const key = canvasItemKey(type, id), selected = new Set(additive ? this.selectedKeys : []);
      if (toggle && selected.has(key)) selected.delete(key); else selected.add(key);
      this.tool = 'select'; this.selectedKeys = [...selected];
    },
    selectionHas(type, id) { return this.selectedKeys.includes(canvasItemKey(type, id)); },
    allCanvasItems() {
      return [
        ...this.naplets.map(item => ({ key: canvasItemKey('naplet', item.id), type: 'naplet', item })),
        ...this.elements.map(item => ({ key: canvasItemKey('element', item.id), type: 'element', item })),
      ];
    },
    findSelected() { return this.selected?.type === 'naplet' ? this.naplets.find(row => row.id === this.selected.id) : this.elements.find(row => row.id === this.selected?.id); },
    selectionBoxStyle() {
      const box = this.selectionBox;
      return box ? `left:${box.left}px;top:${box.top}px;width:${box.right - box.left}px;height:${box.bottom - box.top}px` : '';
    },
    handleStagePointerDown(event) {
      pointers.set(event.pointerId, event); event.currentTarget.setPointerCapture?.(event.pointerId);
      if (event.pointerType === 'touch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()]; this.interaction = { type: 'pinch', distance: pointDistance(a, b), viewport: { ...this.viewport }, center: pointCenter(a, b) }; return;
      }
      if (event.button !== 0) return;
      const point = this.toWorld(event);
      if (this.tool === 'comment') return this.openCommentDialog({ type: 'canvas', x: point.x, y: point.y });
      if (this.tool === 'hand' || (event.pointerType === 'touch' && this.tool === 'select')) { this.interaction = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.viewport.x, y: this.viewport.y }; return; }
      if (this.tool === 'select') {
        this.selectedKeys = []; this.selectionBox = null;
        this.interaction = { type: 'select', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
        return;
      }
      if (this.tool === 'text') return this.createTextAt(point);
      if (this.tool === 'embed') return this.openAddDialog(point);
      if (this.tool === 'chat') return this.placeChat(point);
      if (this.tool === 'task_tree') return this.placeTaskTree(point);
      const kind = this.tool;
      const element = { kind, layout: { x: Math.round(point.x), y: Math.round(point.y), width: 8, height: 8, z: this.highestZ() + 1 }, data: kind === 'draw' ? { points: [[0, 0]] } : {} };
      this.interaction = { type: 'create', pointerId: event.pointerId, start: point, element };
    },
    startItemInteraction(type, item, event, action = 'move') {
      if (this.tool === 'comment') {
        if (item._chatDraft || item._treeDraft) return;
        event.stopPropagation();
        return type === 'naplet' && item.access === 'ready'
          ? this.openCommentDialog({ type: 'naplet', naplet_id: item.id })
          : this.openCommentDialog({ type: 'canvas', x: item.layout.x, y: item.layout.y });
      }
      if (this.tool === 'eraser') { event.stopPropagation(); return this.deleteItem(type, item); }
      if (this.tool !== 'select' || event.button !== 0 || this.editingTextId) return;
      event.stopPropagation();
      const key = canvasItemKey(type, item.id), additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (additive && action === 'move') this.select(type, item.id, { additive: true, toggle: true });
      else if (!this.selectedKeys.includes(key)) this.select(type, item.id);
      if (!this.selectedKeys.includes(key)) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const moving = action === 'move' ? movementItems(this.allCanvasItems(), this.selectedKeys) : [];
      this.interaction = { type: action, pointerId: event.pointerId, itemType: type, id: item.id, startX: event.clientX, startY: event.clientY, before: cloneCanvasValue(item.layout), beforeData: cloneCanvasValue(item.data || {}), moving };
    },
    movePointer(event) {
      pointers.set(event.pointerId, event); const state = this.interaction; if (!state) return;
      if (state.type === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()], center = pointCenter(a, b), factor = pointDistance(a, b) / Math.max(1, state.distance);
        this.viewport = zoomViewport(state.viewport, factor, center, this.stageRect()); this.viewport.x += center.clientX - state.center.clientX; this.viewport.y += center.clientY - state.center.clientY; return;
      }
      if (state.pointerId !== event.pointerId) return;
      if (state.type === 'pan') { this.viewport.x = state.x + event.clientX - state.startX; this.viewport.y = state.y + event.clientY - state.startY; return; }
      if (state.type === 'select') {
        const rect = this.stageRect(), box = selectionRect({ x: state.startX, y: state.startY }, { x: event.clientX, y: event.clientY });
        this.selectionBox = { left: box.left - rect.left, top: box.top - rect.top, right: box.right - rect.left, bottom: box.bottom - rect.top };
        const nodes = [...canvasElement('stage').querySelectorAll('[data-canvas-key]')].map(node => {
          const bounds = node.getBoundingClientRect();
          return { key: node.dataset.canvasKey, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
        });
        this.selectedKeys = enclosedItemKeys(nodes, box); return;
      }
      if (state.type === 'create') {
        const point = this.toWorld(event), dx = point.x - state.start.x, dy = point.y - state.start.y;
        if (state.element.kind === 'arrow' || state.element.kind === 'line') {
          const geometry = arrowGeometry(state.start, point);
          state.element.layout = { ...state.element.layout, ...geometry.layout }; state.element.data = geometry.data;
        } else state.element.layout = { ...state.element.layout, x: Math.round(Math.min(point.x, state.start.x)), y: Math.round(Math.min(point.y, state.start.y)), width: Math.max(8, Math.round(Math.abs(dx))), height: Math.max(8, Math.round(Math.abs(dy))) };
        if (state.element.kind === 'draw') state.element.data.points.push([Math.round(point.x - state.start.x), Math.round(point.y - state.start.y)]); return;
      }
      const item = state.itemType === 'naplet' ? this.naplets.find(row => row.id === state.id) : this.elements.find(row => row.id === state.id); if (!item) return;
      const dx = (event.clientX - state.startX) / this.viewport.scale, dy = (event.clientY - state.startY) / this.viewport.scale;
      if (state.type === 'move') {
        const delta = groupDelta(state.moving, dx, dy);
        for (const original of state.moving) original.item.layout = { ...original.item.layout, x: Math.round(original.before.x + delta.x), y: Math.round(original.before.y + delta.y) };
      } else if (state.type === 'arrow-start' || state.type === 'arrow-end' || state.type === 'arrow-middle') {
        const next = moveArrowEndpoint(state.before, state.beforeData, state.type.slice(6), this.toWorld(event));
        item.layout = next.layout; item.data = next.data;
      } else item.layout = state.type === 'resize'
        ? { ...item.layout, width: Math.max(state.itemType === 'naplet' ? 220 : 8, Math.round(state.before.width + dx)), height: Math.max(state.itemType === 'naplet' ? 160 : 8, Math.round(state.before.height + dy)) }
        : { ...item.layout, x: Math.round(state.before.x + dx), y: Math.round(state.before.y + dy) };
    },
    async endPointer(event) {
      pointers.delete(event.pointerId); const state = this.interaction;
      if (!state || state.type === 'pinch') { if (pointers.size < 2 && state?.type === 'pinch') { this.interaction = null; this.queueViewportSave(); } return; }
      if (state.pointerId !== event.pointerId) return; this.interaction = null;
      if (state.type === 'pan') return this.saveViewport();
      if (state.type === 'select') { this.selectionBox = null; return; }
      if (state.type === 'create') {
        const element = state.element; if (element.kind === 'arrow' || element.kind === 'line') element.data = { ...element.data, direction: 'forward' };
        const previous = new Set(this.elements.map(row => row.id));
        await this.mutate(() => syncRuntime.createElement(element)); this.tool = 'select'; const created = this.elements.find(row => !previous.has(row.id)); if (created) this.selectedKeys = [canvasItemKey('element', created.id)]; return;
      }
      if (state.type === 'move') {
        this.saveChatRecovery();
        const changes = state.moving.filter(original => !original.item._chatDraft && JSON.stringify(original.before) !== JSON.stringify(original.item.layout)).map(original => ({ itemType: original.type, id: original.item.id, before: original.before, after: cloneCanvasValue(original.item.layout) }));
        if (!changes.length) return;
        return this.mutate(async () => {
          for (const change of changes) {
            if (change.itemType === 'naplet') await syncRuntime.updateNapletLayout(change.id, change.after);
            else await syncRuntime.updateElement(change.id, { layout: change.after });
          }
        }, { type: 'layouts', changes });
      }
      const item = state.itemType === 'naplet' ? this.naplets.find(row => row.id === state.id) : this.elements.find(row => row.id === state.id);
      if (!item || (JSON.stringify(state.before) === JSON.stringify(item.layout) && JSON.stringify(state.beforeData) === JSON.stringify(item.data || {}))) return;
      if (item._chatDraft || item._treeDraft) { this.saveChatRecovery(); return; }
      const after = cloneCanvasValue(item.layout);
      const afterData = cloneCanvasValue(item.data || {});
      await this.mutate(() => state.itemType === 'naplet' ? syncRuntime.updateNapletLayout(item.id, after) : syncRuntime.updateElement(item.id, { layout: after, ...(JSON.stringify(state.beforeData) !== JSON.stringify(afterData) ? { data: afterData } : {}) }), { type: 'layout', itemType: state.itemType, id: item.id, before: state.before, after, beforeData: state.beforeData, afterData });
    },
    cancelPointer(event) { pointers.delete(event.pointerId); this.interaction = null; this.selectionBox = null; void this.refresh(); },
    queueViewportSave() { clearTimeout(this._viewportTimer); this._viewportTimer = setTimeout(() => this.saveViewport(), 350); },
    async saveViewport() {
      if (!this.canvas || this.viewportSaving) return; this.viewportSaving = true; this.viewportLocal = false;
      try { await syncRuntime.updateViewport({ ...this.viewport }); } catch (error) { this.error = error?.message || 'Could not save canvas view.'; await this.refresh(); } finally { this.viewportSaving = false; }
    },
    highestZ() { return Math.max(0, ...this.naplets.map(row => row.layout.z), ...this.elements.map(row => row.layout.z)); },
    async createTextAt(point) {
      await this.mutate(() => syncRuntime.createElement({ kind: 'text', layout: { x: Math.round(point.x), y: Math.round(point.y), width: 240, height: 120, z: this.highestZ() + 1 }, data: { text: 'Text' } }));
      const created = this.elements.at(-1); if (created) { this.selectedKeys = [canvasItemKey('element', created.id)]; this.beginTextEdit(created); } this.tool = 'select';
    },
    beginTextEdit(element) { if (element.kind !== 'text') return; this.editingTextId = element.id; this.editingText = String(element.data.text || ''); Alpine.nextTick(() => document.querySelector(`[data-text-editor="${element.id}"]`)?.focus()); },
    async saveTextEdit(element) {
      const next = this.editingText.trim() || 'Text', before = String(element.data.text || ''); this.editingTextId = ''; if (next === before) return;
      const beforeData = cloneCanvasValue({ ...element.data, text: before });
      const afterData = cloneCanvasValue({ ...element.data, text: next });
      await this.mutate(() => syncRuntime.updateElement(element.id, { data: afterData }), { type: 'data', id: element.id, before: beforeData, after: afterData });
    },
    async mutate(operation, history = null) {
      if (this.saving) return; this.saving = true; this.error = '';
      try { await operation(); if (history) { undo.push(history); redo.length = 0; this.historyTick += 1; } }
      catch (error) { const message = error?.message || 'Canvas change could not be saved.'; await syncRuntime?.refresh().catch(() => undefined); this.error = message; return false; }
      finally { this.saving = false; }
      return true;
    },
    async deleteItem(type = this.selected?.type, item = this.findSelected()) { if (!item) return; if (item._treeDraft) { this.removeTreeDraft(item); return; } if (item._chatDraft) { this.removeChatDraft(item); return; } await this.mutate(() => type === 'naplet' ? syncRuntime.deleteNaplet(item.id) : syncRuntime.deleteElement(item.id)); this.selectedKeys = this.selectedKeys.filter(key => key !== canvasItemKey(type, item.id)); },
    async createGroup() {
      const selected = this.allCanvasItems().filter(row => this.selectedKeys.includes(row.key)); if (selected.length < 2) return;
      if (selected.some(row => row.item._chatDraft)) { this.error = 'Send the first chat message before grouping its naplet.'; return; }
      const bounds = groupBounds(selected.map(row => row.item)), previous = new Set(this.elements.map(row => row.id));
      await this.mutate(() => syncRuntime.createElement({
        kind: 'frame',
        layout: { ...bounds, z: Math.max(1, Math.min(...selected.map(row => row.item.layout.z)) - 1) },
        data: { role: 'group', label: 'Group', members: selected.map(row => row.key) },
      }));
      const created = this.elements.find(row => !previous.has(row.id)); if (created) this.selectedKeys = [canvasItemKey('element', created.id)];
    },
    async duplicateSelected() {
      const item = this.findSelected(); if (!item || item._chatDraft || item._treeDraft) return;
      if (this.selected.type === 'naplet' && item.access !== 'ready') { this.error = 'Restricted items cannot be duplicated.'; return; }
      const layout = cloneCanvasValue({ ...item.layout, x: item.layout.x + 24, y: item.layout.y + 24, z: this.highestZ() + 1 });
      if(item.source?.type==='task_tree')layout.task_tree={...layout.task_tree,instance_id:crypto.randomUUID()};
      if (this.selected.type === 'naplet') return this.mutate(() => syncRuntime.addNaplet({ source: cloneCanvasValue(item.source), title: item.access === 'ready' ? item.title : undefined, layout }));
      await this.mutate(() => syncRuntime.createElement({ kind: item.kind, data: cloneCanvasValue(item.data), layout }));
    },
    async orderSelected(delta) { const item = this.findSelected(); if (!item) return; const layout = { ...item.layout, z: clamp(item.layout.z + delta, 1, 100000) }; if (item._chatDraft || item._treeDraft) { item.layout = layout; this.saveChatRecovery(); return; } await this.mutate(() => this.selected.type === 'naplet' ? syncRuntime.updateNapletLayout(item.id, layout) : syncRuntime.updateElement(item.id, { layout })); },
    async applyLayoutHistory(changes, side) { for (const change of changes) { if (change.itemType === 'naplet') await syncRuntime.updateNapletLayout(change.id, change[side]); else await syncRuntime.updateElement(change.id, { layout: change[side] }); } },
    async undoChange() { const action = undo.pop(); if (!action) return; if (action.type === 'layout') await this.mutate(() => action.itemType === 'naplet' ? syncRuntime.updateNapletLayout(action.id, action.before) : syncRuntime.updateElement(action.id, { layout: action.before, ...(action.beforeData ? { data: action.beforeData } : {}) })); if (action.type === 'layouts') await this.mutate(() => this.applyLayoutHistory(action.changes, 'before')); if (action.type === 'data') await this.mutate(() => syncRuntime.updateElement(action.id, { data: action.before })); redo.push(action); this.historyTick -= 1; },
    async redoChange() { const action = redo.pop(); if (!action) return; if (action.type === 'layout') await this.mutate(() => action.itemType === 'naplet' ? syncRuntime.updateNapletLayout(action.id, action.after) : syncRuntime.updateElement(action.id, { layout: action.after, ...(action.afterData ? { data: action.afterData } : {}) })); if (action.type === 'layouts') await this.mutate(() => this.applyLayoutHistory(action.changes, 'after')); if (action.type === 'data') await this.mutate(() => syncRuntime.updateElement(action.id, { data: action.after })); undo.push(action); this.historyTick += 1; },
    handleKeydown(event) {
      if (event.key === 'Escape' && this.linkDrag) { event.preventDefault(); this.linkDrag = null; return; }
      if (event.defaultPrevented || document.querySelector('dialog:modal, :popover-open') || event.target.closest?.('.canvas-comment-panel,.canvas-comment-dialog')) return;
      if (event.target?.matches('input,textarea,select,button,[contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); return event.shiftKey ? this.redoChange() : this.undoChange(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); return this.duplicateSelected(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); return this.createGroup(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); return this.deleteItem(); }
      const keys = { v: 'select', h: 'hand', r: 'rectangle', d: 'diamond', o: 'ellipse', a: 'arrow', l: 'line', p: 'draw', t: 'text', e: 'eraser', f: 'frame', c: 'comment' };
      if (keys[event.key.toLowerCase()]) this.setTool(keys[event.key.toLowerCase()]);
    },
    async openAddDialog(point = null) {
      const rect = this.stageRect(); this.addDialog = { type: 'document', sourceId: '', title: '', point: point || this.toWorld({ clientX: rect.left + 80, clientY: rect.top + 80 }) };
      this.sourceSearch = ''; this.boardCreate = { ...this.boardCreate, title: '', mode: 'create' };
      await this.loadSourceOptions(); openCanvasDialog('addDialog');
    },
    async loadSourceOptions() {
      const db = openWorkspaceDb(this.currentWorkspaceKey);
      const [documents, channels, messages] = await Promise.all([db.documents.toArray(), db.channels.toArray(), db.chat_messages.toArray()]);
      this.canvasChoicesError = '';
      let canvases = [];
      try { canvases = await hydrateCanvasList(this.context()); }
      catch { this.canvasChoicesError = 'Canvas choices unavailable. Close this picker and try again.'; }
      const active = row => !['deleted', 'archived'].includes(row.record_state);
      this.sourceOptions = [
        ...canvases.filter(row => row.canvas_id !== this.canvasId).map(row => ({ type: 'canvas', id: row.canvas_id, title: row.title })),
        ...documents.filter(row => active(row) && !row.pg_storage_version_id && row.pg_record_type !== 'file').map(row => ({ type: 'document', id: row.record_id, title: sourceTitle(row, 'Untitled document') })),
        ...channels.filter(active).map(row => ({ type: 'task_list', id: row.record_id, title: `${sourceTitle(row, 'Channel')} tasks` })),
        ...messages.filter(row => active(row) && (row.pg_record_type === 'thread' || row.record_type === 'thread')).map(row => ({ type: 'chat_thread', id: row.record_id, title: sourceTitle(row, 'Chat thread') })),
        ...documents.filter(row => active(row) && isHtmlFile(row)).map(row => ({ type: 'html', id: row.record_id, title: sourceTitle(row, 'HTML artefact') })),
        ...(await this.loadBoardChoices(db)),
        ...documents.filter(row => active(row) && row.pg_storage_version_id && !isHtmlFile(row) && /html/i.test(row.content_type || row.mime_type || '')).map(row => ({ type: 'html', id: row.pg_storage_version_id, title: sourceTitle(row, 'HTML artefact') })),
      ].filter(row => row.id && row.title).sort((a, b) => a.title.localeCompare(b.title));
    },
    chooseSource(option) { if (option.type === 'canvas' && option.id === this.canvasId) return; this.addDialog.sourceId = option.id; this.addDialog.title = option.type === 'canvas' ? '' : option.title; },
    async addNaplet() {
      const point = this.addDialog.point || { x: 80, y: 80 }, board = this.addDialog.type === 'excalidraw';
      if(this.addDialog.type==='task_tree'){canvasElement('addDialog').close();return this.placeTaskTree(point);}
      const layout = { x: Math.round(point.x), y: Math.round(point.y), width: board ? 640 : 380, height: board ? 460 : 280, z: this.highestZ() + 1 };
      if (board && this.boardCreate.mode === 'create') {
        if (this.saving || this.boardCreating) return;
        this.boardCreating = true; this.error = '';
        try { if (await this.createBoardNaplet(layout, body => this.mutate(() => syncRuntime.addNaplet(body)))) canvasElement('addDialog').close(); }
        finally { this.boardCreating = false; }
        return;
      }
      const sourceId = text(this.addDialog.sourceId); if (!sourceId || this.saving) return;
      if (!this.artifactSelectionValid()) { this.error = 'Choose an artefact from the list.'; return; }
      if (this.addDialog.type === 'canvas' && !this.sourceOptions.some(row => row.type === 'canvas' && row.id === sourceId && row.id !== this.canvasId)) { this.error = 'Choose another accessible canvas.'; return; }
      await this.mutate(() => syncRuntime.addNaplet({ source: { type: this.addDialog.type, id: sourceId }, title: text(this.addDialog.title) || undefined, layout }));
      if (!this.error) canvasElement('addDialog').close();
    },
    openCommentDialog(anchor, parentCommentId = null) { if (anchor.type === 'naplet' && !anchor.naplet_id) return; if (anchor.type === 'naplet' && !parentCommentId && !Number.isFinite(anchor.x)) { const point = this.commentPoint({ anchor }); if (point) anchor = { ...anchor, ...point }; } this.commentDialog = { anchor, parentCommentId, body: '' }; openCanvasDialog('commentDialog'); },
    async submitComment() { const body = text(this.commentDialog.body); if (!body) return; await this.mutate(() => syncRuntime.createComment({ anchor: this.commentDialog.anchor, parent_comment_id: this.commentDialog.parentCommentId || undefined, body })); if (!this.error) canvasElement('commentDialog').close(); },
    openCommentThread(comment) { this.activeCommentId = comment.id; this.commentDelete = null; this.subjectPicker = false; this.suppressLinkClick = false; openCanvasDialog('commentPanel'); },
    async setCommentResolved(comment, resolved) { if (comment?.can_resolve !== false) await this.mutate(() => syncRuntime.setCommentResolved(comment.id, resolved)); },
    requestCommentDelete(comment) {
      if (!comment?.can_delete || this.saving) return;
      const replies = this.comments.filter(row => row.parent_comment_id === comment.id);
      this.commentDelete = { id: comment.id, expected_row_version: comment.row_version, expected_reply_versions: Object.fromEntries(replies.map(row => [row.id, row.row_version])), replyCount: replies.length, isRoot: !comment.parent_comment_id };
    },
    async confirmCommentDelete() {
      const request = this.commentDelete;
      if (!request || this.saving) return;
      const success = await this.mutate(() => syncRuntime.deleteComment(request.id, request));
      this.commentDelete = null;
      if (success && request.id === this.activeCommentId) canvasElement('commentPanel').close();
    },
    commentPoint(comment) {
      if (Number.isFinite(comment?.anchor.x) && Number.isFinite(comment?.anchor.y)) return { x: comment.anchor.x, y: comment.anchor.y };
      if (comment?.anchor.type === 'naplet') {
        const naplet = this.naplets.find(row => row.id === comment.anchor.naplet_id && row.access === 'ready');
        return naplet ? { x: naplet.layout.x + naplet.layout.width, y: naplet.layout.y } : null;
      }
      return comment ? { x: comment.anchor.x, y: comment.anchor.y } : null;
    },
    get commentConnector() {
      const comment = this.activeComment, start = this.commentPoint(comment);
      if (!start) return null;
      const target = this.naplets.find(row => row.id === comment.anchor.naplet_id && row.access === 'ready');
      const end = this.linkDrag?.point || (target ? { x: target.layout.x + target.layout.width / 2, y: target.layout.y + target.layout.height / 2 } : null);
      return end ? { x1: start.x, y1: start.y, x2: end.x, y2: end.y } : null;
    },
    commentTime(comment) {
      const date = new Date(comment?.created_at);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    toggleCommentTargets(event) {
      if (event?.detail === 0) this.suppressLinkClick = false;
      if (this.suppressLinkClick) { this.suppressLinkClick = false; return; }
      this.subjectPicker = !this.subjectPicker;
    },
    startCommentLink(event) {
      if (!this.activeComment?.can_retarget || this.saving || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId);
      this.suppressLinkClick = false;
      this.linkDrag = { pointerId: event.pointerId, origin: { x: event.clientX, y: event.clientY }, point: this.toWorld(event), moved: false };
    },
    moveCommentLink(event) {
      if (this.linkDrag?.pointerId !== event.pointerId) return;
      this.linkDrag.point = this.toWorld(event);
      if (Math.hypot(event.clientX - this.linkDrag.origin.x, event.clientY - this.linkDrag.origin.y) > 5) this.linkDrag.moved = true;
    },
    async finishCommentLink(event) {
      if (this.linkDrag?.pointerId !== event.pointerId) return;
      const moved = this.linkDrag.moved;
      this.linkDrag = null;
      if (!moved) return;
      this.suppressLinkClick = true;
      const node = document.elementsFromPoint(event.clientX, event.clientY).map(node => node.closest?.('[data-canvas-key]')).find(Boolean);
      const id = node?.dataset.canvasKey?.replace(/^naplet:/, '');
      const target = this.naplets.find(row => row.id === id && row.access === 'ready');
      if (target) await this.setCommentSubject(target.id);
      else this.error = 'Drop the link on a readable naplet. The subject was not changed.';
    },
    async setCommentSubject(napletId) {
      const comment = this.activeComment;
      if (!comment?.can_retarget || this.saving) return;
      const target = this.naplets.find(row => row.id === napletId && row.access === 'ready');
      if (napletId && !target) return;
      const point = this.commentPoint(comment);
      const anchor = target ? { type: 'naplet', naplet_id: target.id, ...point } : { type: 'canvas', ...point };
      if (await this.mutate(() => syncRuntime.retargetComment(comment.id, anchor))) { this.subjectPicker = false; }
    },
    commentCountForNaplet(id) { return this.unresolvedComments.filter(row => row.anchor.type === 'naplet' && row.anchor.naplet_id === id).length; },
    commentStyle(comment) { const point = this.commentPoint(comment); return point ? `left:${point.x - 14}px;top:${point.y - 14}px` : 'display:none'; },
    napletStyle(naplet) { const layout = naplet.layout; return `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;z-index:${layout.z}`; },
    elementStyle(element) { const layout = element.layout; return `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;z-index:${layout.z}`; },
    isGroup(element) { return element.kind === 'frame' && element.data?.role === 'group'; },
    vectorViewBox(element) { return `0 0 ${element.layout.width} ${element.layout.height}`; },
    vectorStart(element) { return Array.isArray(element.data?.start) ? element.data.start : [0, element.layout.height]; },
    vectorEnd(element) { return Array.isArray(element.data?.end) ? element.data.end : [element.layout.width, 0]; },
    arrowHandleStyle(element, endpoint) { const point = arrowPoints(element.layout, element.data)[endpoint]; return `left:${point[0]}px;top:${point[1]}px`; },
    vectorPath(element) { return arrowPath(element.layout, element.data); },
    vectorDash(element) { return ({ dotted: '1 7', dashed: '10 7' })[element.data?.lineStyle] || ''; },
    arrowhead(element, endpoint) { return element.data?.[endpoint + 'Arrowhead'] || (endpoint === 'end' && element.kind === 'arrow' ? 'triangle' : 'none'); },
    arrowMarker(element, endpoint) { return this.arrowhead(element, endpoint) === 'none' ? '' : `url(#${endpoint}-arrow-${element.id})`; },
    arrowheadPath(element, endpoint) { return ({ arrow: 'M1,1 L7,4 L1,7', triangle: 'M1,1 L7,4 L1,7 Z', diamond: 'M0,4 L4,1 L8,4 L4,7 Z', circle: 'M7,4 A3,3 0 1,1 1,4 A3,3 0 1,1 7,4' })[this.arrowhead(element, endpoint)] || ''; },
    textSize(element) { const size = Number(element?.data?.fontSize); return Number.isInteger(size) && size >= 12 && size <= 144 ? size : 16; },
    get selectedVector() { const item = this.findSelected(); return this.selectedKeys.length === 1 && ['arrow', 'line'].includes(item?.kind) ? item : null; },
    get selectedText() { const item = this.findSelected(); return this.selectedKeys.length === 1 && item?.kind === 'text' ? item : null; },
    async setElementOption(field, value) {
      const item = this.findSelected(); if (!this.canvas?.can_manage || !item || this.selected?.type !== 'element') return;
      if (field === 'fontSize') { value = Number(value); if (item.kind !== 'text' || !Number.isInteger(value) || value < 12 || value > 144) return; }
      else if (!['arrow', 'line'].includes(item.kind)) return;
      else if (field === 'lineStyle' ? !['solid', 'dotted', 'dashed'].includes(value) : !['startArrowhead', 'endArrowhead'].includes(field) || !['none', 'arrow', 'triangle', 'diamond', 'circle'].includes(value)) return;
      const before = cloneCanvasValue(item.data), after = { ...before, [field]: value };
      await this.mutate(() => syncRuntime.updateElement(item.id, { data: after }), { type: 'data', id: item.id, before, after });
    },
    async straightenArrow() {
      const item = this.selectedVector; if (!item || !this.canvas?.can_manage) return;
      const before = cloneCanvasValue(item.data), after = { ...before }; delete after.curve;
      await this.mutate(() => syncRuntime.updateElement(item.id, { data: after }), { type: 'data', id: item.id, before, after });
    },
    drawPoints(element) { return (element.data.points || []).map(point => point.join(',')).join(' '); },
    canvasLinkUrl(naplet) {
      if (naplet.access !== 'ready' || naplet.source?.type !== 'canvas' || !naplet.source.id || naplet.source.id === this.canvasId) return null;
      return '/canvas.html?' + new URLSearchParams({ workspacekey: this.currentWorkspaceKey, canvasid: naplet.source.id });
    },
    documentUrl(naplet) {
      if (naplet.access !== 'ready' || naplet.source?.type !== 'document') return null;
      return buildSectionUrl({ section: 'docs', params: { workspacekey: this.currentWorkspaceKey, docid: naplet.source.id } });
    },
    assetStore() { return assetStore; },
    // Viewer-local HTML version browsing. The naplet's shared policy changes only
    // through pin/follow, which are manager mutations re-authorized by Tower.
    htmlView(naplet) { return this.htmlViews[naplet?.id] || null; },
    htmlContent(naplet) { return this.htmlView(naplet)?.content || naplet?.content || {}; },
    htmlVersions(naplet) { return this.htmlView(naplet)?.versions || []; },
    htmlIsBrowsing(naplet) { const view = this.htmlView(naplet); return Boolean(view?.content && view.content.version_id !== naplet?.content?.version_id); },
    htmlVersionLabel(naplet) {
      const content = this.htmlContent(naplet), base = naplet?.content || {};
      const number = content.version_number ? `v${content.version_number}` : (content.version ? `v${content.version}` : '');
      const latest = base.current_version_number ? `v${base.current_version_number}` : '';
      if (this.htmlIsBrowsing(naplet)) return `Viewing ${number}${content.version_id === base.current_version_id ? ' (latest)' : ''}`;
      if (base.follows_latest) return `Latest · ${number}`;
      return `Pinned · ${number}${latest && latest !== number ? ` (latest ${latest})` : ''}`;
    },
    htmlAssetSummary(naplet) {
      const assets = this.htmlContent(naplet).assets || [], missing = assets.filter(row => row.status !== 'ready').length;
      return missing ? `${missing} image${missing === 1 ? '' : 's'} unavailable` : '';
    },
    // Called for every snapshot; `authority` is the snapshot's request id.
    reconcileHtmlViews(authority) {
      if (authority !== htmlAuthority) { htmlAuthority = authority; htmlSequencer.advance(); }
      const { views, revalidate, keep } = reconcileHtmlViews(this.htmlViews, this.naplets, authority);
      this.htmlViews = views;
      assetStore?.retain(keep);
      for (const row of revalidate) void this.showHtmlVersion(this.readyHtmlNaplet(row.napletId), row.versionId, { revalidate: true });
      // A new policy resets the version list; refill it while the Versions dialog shows it.
      const open = this.versionsNaplet;
      if (open?.source.type === 'html' && !this.htmlVersions(open).length) void this.loadHtmlVersions(open);
    },
    clearHtmlViews() { htmlAuthority = ''; htmlSequencer.advance(); versionLoads.clear(); this.htmlViews = {}; assetStore?.clear(); },
    retainHtmlAssets() { assetStore?.retain(htmlDisplayedAssets(this.naplets, this.htmlViews)); },
    readyHtmlNaplet(id) { return this.naplets.find(row => row.id === id && row.access === 'ready' && row.source?.type === 'html') || null; },
    patchHtmlView(id, patch) {
      const naplet = this.readyHtmlNaplet(id);
      if (!naplet) return;
      const view = this.htmlViews[id] || { versions: [], policyKey: htmlPolicyKey(naplet), content: null, authority: htmlAuthority };
      this.htmlViews = { ...this.htmlViews, [id]: { ...view, ...patch } };
    },
    /**
     * Browse read guarded against reordering: only the newest request per key
     * applies, only while the naplet keeps its policy, and a read that raced a
     * fresh snapshot is repeated under the new authority.
     */
    async readHtmlGuarded(key, napletId, versionId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const naplet = this.readyHtmlNaplet(napletId);
        if (!naplet || !syncRuntime) return { skipped: 'gone' };
        const ticket = htmlSequencer.begin(key), policyKey = htmlPolicyKey(naplet);
        let result = null, failure = null;
        try { result = await syncRuntime.readNapletHtml(napletId, versionId); } catch (error) { failure = error; }
        if (htmlSequencer.superseded(ticket)) return { skipped: 'superseded' };
        const current = this.readyHtmlNaplet(napletId);
        if (!current || htmlPolicyKey(current) !== policyKey) return { skipped: 'gone' };
        if (htmlSequencer.authorityMoved(ticket)) continue;
        if (failure) throw failure;
        return { result };
      }
      return { skipped: 'gone' };
    },
    loadHtmlVersions(naplet) {
      const view = this.htmlView(naplet);
      if (!naplet?.id || view?.versions?.length) return Promise.resolve(view?.versions || []);
      if (!versionLoads.has(naplet.id)) {
        this.patchHtmlView(naplet.id, { versionsLoading: true });
        const load = this.readHtmlGuarded(`${naplet.id}:versions`, naplet.id, '')
          .then(({ result }) => { if (result) this.patchHtmlView(naplet.id, { versions: result.versions }); return this.htmlVersions(naplet); })
          .catch(error => { this.error = error?.status === 404 ? 'This artefact version is unavailable.' : (error?.message || 'Versions could not be loaded.'); return []; })
          .finally(() => { if (versionLoads.get(naplet.id) === load) { versionLoads.delete(naplet.id); this.patchHtmlView(naplet.id, { versionsLoading: false }); } });
        versionLoads.set(naplet.id, load);
      }
      return versionLoads.get(naplet.id);
    },
    async showHtmlVersion(naplet, versionId, { revalidate = false } = {}) {
      if (!versionId || naplet?.access !== 'ready' || naplet.source?.type !== 'html') return;
      if (versionId === naplet.content.version_id && !revalidate) {
        htmlSequencer.begin(naplet.id);
        this.patchHtmlView(naplet.id, { content: null, loading: false });
        this.retainHtmlAssets();
        return;
      }
      this.patchHtmlView(naplet.id, { loading: true });
      try {
        const { result, skipped } = await this.readHtmlGuarded(naplet.id, naplet.id, versionId);
        if (skipped === 'superseded') return;
        const content = result && result.content.version_id !== this.readyHtmlNaplet(naplet.id)?.content.version_id ? result.content : null;
        this.patchHtmlView(naplet.id, { content, loading: false, authority: htmlAuthority, ...(result ? { versions: result.versions } : {}) });
      } catch (error) {
        // A browsed version that cannot be re-authorized is closed, not kept.
        this.patchHtmlView(naplet.id, revalidate ? { content: null, loading: false } : { loading: false });
        this.error = error?.status === 404 ? 'This artefact version is unavailable.' : (error?.message || 'Version could not be opened.');
      }
      this.retainHtmlAssets();
    },
    htmlStepTarget(naplet, delta) {
      const versions = this.htmlVersions(naplet), current = this.htmlContent(naplet).version_id;
      const index = versions.findIndex(row => row.id === current);
      // Versions are newest first: "previous" (-1) moves to an older version.
      return index < 0 ? null : versions[index - delta] || null;
    },
    async stepHtmlVersion(naplet, delta) {
      await this.loadHtmlVersions(naplet);
      const target = this.htmlStepTarget(naplet, delta);
      if (target) await this.showHtmlVersion(naplet, target.id);
    },
    async pinHtmlVersion(naplet) {
      const versionId = this.htmlContent(naplet).version_id;
      if (!versionId || !this.canvas?.can_manage) return;
      if (await this.mutate(() => syncRuntime.setNapletVersionPolicy(naplet.id, versionId))) this.htmlViews = { ...this.htmlViews, [naplet.id]: { ...this.htmlView(naplet), content: null } };
    },
    async followLatestHtml(naplet) {
      if (!this.canvas?.can_manage) return;
      if (await this.mutate(() => syncRuntime.setNapletVersionPolicy(naplet.id, null))) this.htmlViews = { ...this.htmlViews, [naplet.id]: { ...this.htmlView(naplet), content: null } };
    },
    // Versions: the cog menu opens one dialog for HTML and board naplets; the
    // title bar keeps the current version and unsaved/read-only state visible.
    hasVersions(naplet) { return naplet?.access === 'ready' && ['html', 'excalidraw'].includes(naplet.source?.type); },
    napletStatus(naplet) {
      if (!this.hasVersions(naplet)) return '';
      return naplet.source.type === 'html' ? this.htmlVersionLabel(naplet) : this.boardHeaderStatus(naplet);
    },
    napletStatusState(naplet) {
      if (naplet?.source?.type === 'html') return this.htmlIsBrowsing(naplet) ? 'viewing' : 'saved';
      const state = this.boardState(naplet);
      if (state.viewing_version_id) return 'viewing';
      if (state.save_state === 'stale' || state.newer_available) return 'stale';
      if (state.status === 'ready' && !state.can_write) return 'viewing';
      return state.dirty && state.save_state === 'saved' ? 'unsaved' : state.save_state;
    },
    napletStatusTitle(naplet) {
      if (naplet?.source?.type === 'html') return [this.htmlVersionLabel(naplet), this.htmlAssetSummary(naplet)].filter(Boolean).join(' · ');
      return [this.boardStatusLabel(naplet), this.boardVersionLabel(naplet)].filter(Boolean).join(' · ');
    },
    get versionsNaplet() { return this.naplets.find(row => row.id === this.versionsDialog.napletId && this.hasVersions(row)) || null; },
    openVersions(naplet, returnFocus = null) {
      if (!this.hasVersions(naplet)) return;
      this.versionsDialog = { napletId: naplet.id, returnFocus };
      if (naplet.source.type === 'html') void this.loadHtmlVersions(naplet); else void this.loadBoardVersions(naplet);
      Alpine.nextTick(() => {
        const dialog = canvasElement('versionsDialog');
        if (!dialog.open) dialog.showModal();
        dialog.querySelector('[aria-current="true"], .canvas-versions-step button:not(:disabled), .canvas-dialog-actions button')?.focus();
      });
    },
    versionsClosed() {
      const target = this.versionsDialog.returnFocus;
      this.versionsDialog = { napletId: '', returnFocus: null };
      if (target?.isConnected) target.focus({ preventScroll: true });
    },
    versionsLoading(naplet) {
      if (naplet?.source?.type === 'html') return Boolean(this.htmlView(naplet)?.versionsLoading);
      return Boolean(this.boardState(naplet).versions_loading);
    },
    versionRows(naplet) {
      if (naplet?.source?.type === 'html') {
        const current = this.htmlContent(naplet).version_id;
        return this.htmlVersions(naplet).map(version => ({
          id: version.id, current: version.id === current, label: `v${version.version_number}`,
          detail: [version.id === naplet.content.current_version_id ? 'latest' : '', version.id === naplet.source.version_id ? 'pinned' : ''].filter(Boolean).join(' · '), summary: '',
        }));
      }
      const state = this.boardState(naplet), current = state.viewing_version_id || state.base_version_id;
      return (state.versions || []).map(version => ({
        id: version.id, current: version.id === current, label: `v${version.version_number}`,
        detail: [this.boardVersionTime(version), this.boardVersionAuthor(version)].filter(Boolean).join(' · '), summary: text(version.summary),
      }));
    },
    canStepVersion(naplet, delta) {
      if (naplet?.source?.type === 'html') {
        const number = this.htmlContent(naplet).version_number, loading = Boolean(this.htmlView(naplet)?.loading);
        return !loading && (delta < 0 ? number > 1 : number < naplet.content.current_version_number);
      }
      const state = this.boardState(naplet), number = state.viewing_version_number || state.base_version_number;
      return state.status === 'ready' && (delta < 0 ? number > 1 : Boolean(state.viewing_version_id));
    },
    stepVersion(naplet, delta) {
      if (!this.canStepVersion(naplet, delta)) return undefined;
      return naplet.source.type === 'html' ? this.stepHtmlVersion(naplet, delta) : this.stepBoardVersion(naplet, delta);
    },
    openVersion(naplet, versionId) {
      return naplet?.source?.type === 'html' ? this.showHtmlVersion(naplet, versionId) : this.viewBoardVersion(naplet, versionId);
    },
    // References: copy a link that opens this canvas and focuses one naplet.
    napletReference(naplet) {
      return canvasNapletReference({ origin: location.origin, workspaceId: this.workspace?.workspaceId, canvas: this.canvas, naplet });
    },
    // A manual popover, so the notice also shows above a full-screen naplet.
    showNotice(message) {
      clearTimeout(noticeTimer); this.notice = message;
      const node = document.querySelector('.canvas-notice');
      if (node && !node.matches(':popover-open')) node.showPopover();
      noticeTimer = setTimeout(() => this.clearNotice(), 4000);
    },
    clearNotice() {
      this.notice = '';
      const node = document.querySelector('.canvas-notice');
      if (node?.matches(':popover-open')) node.hidePopover();
    },
    async copyNapletReference(naplet) {
      const reference = this.napletReference(naplet);
      if (!reference) { this.error = 'This item has no reference to copy.'; return false; }
      const result = await copyCanvasReference(reference.markdown);
      if (result.ok) { this.closeReferenceDialog(); this.showNotice('Reference copied. Paste it into chat or a document.'); return true; }
      this.referenceDialog = { napletId: naplet.id, markdown: reference.markdown, url: reference.url, message: result.reason === 'unsupported' ? 'This browser cannot copy automatically. Select the link below and copy it.' : 'The browser blocked copying. Select the link below and copy it.' };
      Alpine.nextTick(() => {
        const dialog = canvasElement('referenceDialog');
        if (!dialog.open) dialog.showModal();
        const field = dialog.querySelector('textarea'); field?.focus(); field?.select();
      });
      return false;
    },
    async retryReferenceCopy() {
      const result = await copyCanvasReference(this.referenceDialog.markdown);
      if (result.ok) { this.closeReferenceDialog(); this.showNotice('Reference copied. Paste it into chat or a document.'); return true; }
      this.referenceDialog = { ...this.referenceDialog, message: 'Copying is still blocked. Select the link and copy it with your keyboard or the context menu.' };
      return false;
    },
    closeReferenceDialog() {
      document.querySelector(canvasDom.referenceDialog)?.close();
      this.referenceDialog = { napletId: '', markdown: '', url: '', message: '' };
    },
    /** Lost authority: no versions panel or copy fallback keeps naplet metadata on screen. */
    closeNapletDialogs() {
      document.querySelector(canvasDom.versionsDialog)?.close();
      this.closeReferenceDialog();
    },
    clearReferenceFeedback() {
      clearTimeout(noticeTimer); clearTimeout(highlightTimer);
      this.clearNotice(); this.referenceHighlightId = '';
    },
    /** Once per page load, after an authorized snapshot: select, centre and highlight the target. */
    focusReferenceTarget() {
      const reference = this.reference;
      if (!reference.requested || reference.handled) return;
      reference.handled = true;
      const target = canvasReferenceTarget(this.naplets, reference.napletId);
      if (!target || (reference.sourceId && reference.sourceId !== target.source?.id)) { this.error = CANVAS_REFERENCE_UNAVAILABLE; return; }
      if (reference.versionId) {
        if (target.source.type === 'html') void this.showHtmlVersion(target, reference.versionId);
        else if (target.source.type === 'excalidraw') {
          const deadline = performance.now() + 5000;
          const openVersion = () => {
            if (this.boardState(target).status === 'ready') void this.viewBoardVersion(target, reference.versionId).catch(() => { this.error = CANVAS_REFERENCE_UNAVAILABLE; });
            else if (performance.now() < deadline && canvasReferenceTarget(this.naplets, target.id)) requestAnimationFrame(openVersion);
            else this.error = CANVAS_REFERENCE_UNAVAILABLE;
          };
          openVersion();
        }
      }
      this.tool = 'select'; this.selectedKeys = [canvasItemKey('naplet', target.id)];
      const deadline = performance.now() + 5000;
      const reveal = () => {
        const current = canvasReferenceTarget(this.naplets, target.id);
        if (!current) return;
        const node = document.querySelector(`[data-canvas-key="naplet:${CSS.escape(target.id)}"]`), stage = this.stageRect();
        // A fresh load can apply the snapshot before the canvas stylesheet: an
        // unstyled naplet dialog is not rendered, cannot take focus, and the
        // stage has no size to centre in. Wait (bounded) for real layout.
        if ((!node?.getClientRects().length || !stage.width || !stage.height) && performance.now() < deadline) { requestAnimationFrame(reveal); return; }
        // Viewer-local: opening a link never writes the shared viewport.
        this.viewport = centredViewport(current.layout, stage, this.viewport); this.viewportLocal = true;
        this.referenceHighlightId = target.id;
        clearTimeout(highlightTimer); highlightTimer = setTimeout(() => { this.referenceHighlightId = ''; }, 2600);
        if (!node) return;
        node.dispatchEvent(new CustomEvent('canvas-reference-focus'));
        // Never take focus from something the viewer has already chosen.
        if (document.activeElement && document.activeElement !== document.body) return;
        node.tabIndex = -1; node.focus({ preventScroll: true });
      };
      Alpine.nextTick(reveal);
    },
  };
}

registerCanvasCommentPopover(Alpine);
registerCanvasChatFrame(Alpine);
registerCanvasWindow(Alpine);
registerCanvasDocument(Alpine);
registerCanvasHtml(Alpine, { assetStore: () => Alpine.store('canvas').assetStore() });
registerCanvasHtml(Alpine, { name: 'canvas-html-preview', assetStore: () => Alpine.store('canvas').previewAssetStore() });
registerCanvasBoard(Alpine, {
  controllerFor: fileId => Alpine.store('canvas').boardController(fileId),
  actionFor: naplet => Alpine.store('canvas').boardSaveAction(naplet),
  runAction: (naplet, action) => Alpine.store('canvas').runBoardAction(naplet, action),
});
Alpine.store('canvas', canvasPageStore());
window.Alpine = Alpine;
Alpine.start();
