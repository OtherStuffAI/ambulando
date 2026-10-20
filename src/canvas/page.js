import Alpine from 'alpinejs';
import { tryAutoLoginFromStorage, pubkeyToNpub } from '../auth/nostr.js';
import { setActiveSessionNpub } from '../crypto/group-keys.js';
import { getSettings, openWorkspaceDb } from '../db.js';
import { initializeTowerTransports } from '../tower-transport.js';
import { normalizeWorkspaceEntry } from '../workspaces.js';
import { canvasContext, CANVAS_ACCESS_MESSAGE } from './projection.js';
import { buildCanvasHtmlDocument } from './sandbox.js';
import { CanvasSyncRuntime } from './sync-service.js';
import '../ambulando-tokens.css';
import './styles.css';

const text = value => String(value ?? '').trim();
function findWorkspace(settings, requestedKey) {
  return (settings?.knownWorkspaces || []).map(normalizeWorkspaceEntry).filter(Boolean)
    .find(workspace => workspace.workspaceKey === requestedKey || workspace.workspaceId === requestedKey) || null;
}

function canvasPageStore() {
  return {
    status: 'loading',
    error: '',
    workspace: null,
    session: null,
    currentWorkspace: null,
    currentWorkspaceKey: '',
    currentViewerNpub: '',
    currentPgActorId: '',
    canvas: null,
    naplets: [],
    syncRuntime: null,
    viewport: { x: 0, y: 0, scale: 1 },
    interaction: null,
    saving: false,
    viewportSaving: false,
    addDialog: { type: 'document', sourceId: '', title: '' },
    accessMessage: CANVAS_ACCESS_MESSAGE,

    get canvasId() { return text(new URLSearchParams(location.search).get('canvasid')); },
    get transformStyle() { return `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.scale})`; },

    async init() {
      try {
        await initializeTowerTransports();
        const params = new URLSearchParams(location.search);
        const settings = await getSettings();
        const workspace = findWorkspace(settings, text(params.get('workspacekey')) || text(settings?.currentWorkspaceKey));
        if (!workspace?.pgBackendMode || !workspace.workspaceId || !this.canvasId) throw new Error('This Canvas link is incomplete. Return to Ambulando and open it again.');
        const storedAuth = await tryAutoLoginFromStorage();
        if (!storedAuth?.pubkey) throw new Error('Open Ambulando and sign in, then reopen this canvas.');
        const npub = await pubkeyToNpub(storedAuth.pubkey);
        if (workspace.pgSessionNpub && workspace.pgSessionNpub !== npub) throw new Error('This canvas belongs to a different signed-in workspace identity.');
        this.workspace = workspace;
        this.currentWorkspace = workspace;
        this.currentWorkspaceKey = workspace.workspaceKey;
        this.currentViewerNpub = npub;
        this.currentPgActorId = text(workspace.pgMe?.actor?.actor_id);
        this.session = { pubkey: storedAuth.pubkey, npub, method: storedAuth.method };
        setActiveSessionNpub(npub);
        openWorkspaceDb(workspace.workspaceKey);
        const context = this.context();
        this.syncRuntime = new CanvasSyncRuntime(context, this.canvasId, {
          onSnapshot: snapshot => this.applySnapshot(snapshot),
          onError: error => this.applySyncError(error),
        });
        addEventListener('pagehide', () => this.syncRuntime?.stop(), { once: true });
        this.syncRuntime.start();
      } catch (error) {
        this.status = 'error';
        this.error = error?.message || 'Canvas could not be opened.';
      }
    },
    context() { return canvasContext(this); },
    applySnapshot(snapshot) {
      this.canvas = snapshot.canvas;
      this.naplets = snapshot.naplets;
      this.viewport = { ...snapshot.canvas.viewport };
      document.title = `${snapshot.canvas.title} · Canvas · Ambulando`;
      this.status = 'ready';
      this.error = '';
    },
    applySyncError(error) {
      this.canvas = null;
      this.naplets = [];
      this.status = 'error';
      this.error = error?.status === 403 || error?.status === 404 ? 'Canvas unavailable.' : (error?.message || 'Canvas could not be refreshed.');
    },
    async refresh() {
      this.status = 'loading';
      this.error = '';
      await this.syncRuntime?.refresh().catch(() => undefined);
    },
    zoomBy(delta, origin = null) {
      const previous = this.viewport.scale;
      const next = Math.max(0.2, Math.min(3, previous * delta));
      if (origin) {
        const rect = this.$refs.stage.getBoundingClientRect();
        const px = origin.clientX - rect.left, py = origin.clientY - rect.top;
        this.viewport.x = px - ((px - this.viewport.x) / previous) * next;
        this.viewport.y = py - ((py - this.viewport.y) / previous) * next;
      }
      this.viewport.scale = next;
      this.queueViewportSave();
    },
    resetViewport() { this.viewport = { x: 0, y: 0, scale: 1 }; this.queueViewportSave(); },
    handleWheel(event) { event.preventDefault(); this.zoomBy(event.deltaY < 0 ? 1.1 : 0.9, event); },
    startPan(event) {
      if (event.button !== 0 || event.target.closest('.canvas-naplet')) return;
      this.interaction = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.viewport.x, y: this.viewport.y };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    startNapletMove(naplet, event) {
      if (event.button !== 0 || naplet.access === 'denied' && !event.target.closest('.canvas-naplet-header')) return;
      event.stopPropagation();
      this.interaction = { type: 'naplet', pointerId: event.pointerId, id: naplet.id, startX: event.clientX, startY: event.clientY, x: naplet.layout.x, y: naplet.layout.y };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    movePointer(event) {
      const state = this.interaction;
      if (!state || state.pointerId !== event.pointerId) return;
      if (state.type === 'pan') {
        this.viewport.x = state.x + event.clientX - state.startX;
        this.viewport.y = state.y + event.clientY - state.startY;
      } else {
        const naplet = this.naplets.find(row => row.id === state.id);
        if (naplet) {
          naplet.layout.x = Math.round(state.x + (event.clientX - state.startX) / this.viewport.scale);
          naplet.layout.y = Math.round(state.y + (event.clientY - state.startY) / this.viewport.scale);
        }
      }
    },
    async endPointer(event) {
      const state = this.interaction;
      if (!state || state.pointerId !== event.pointerId) return;
      this.interaction = null;
      if (state.type === 'pan') return this.saveViewport();
      const naplet = this.naplets.find(row => row.id === state.id);
      if (!naplet) return;
      try {
        await this.syncRuntime.updateNapletLayout(naplet.id, { ...naplet.layout });
      } catch (error) { this.error = error?.message || 'Could not save naplet position.'; await this.refresh(); }
    },
    queueViewportSave() {
      clearTimeout(this._viewportTimer);
      this._viewportTimer = setTimeout(() => this.saveViewport(), 350);
    },
    async saveViewport() {
      if (!this.canvas || this.viewportSaving) return;
      this.viewportSaving = true;
      try {
        await this.syncRuntime.updateViewport({ ...this.viewport });
      } catch (error) {
        this.error = error?.message || 'Could not save canvas view.';
        await this.refresh();
      } finally {
        this.viewportSaving = false;
      }
    },
    openAddDialog() { this.addDialog = { type: 'document', sourceId: '', title: '' }; this.$nextTick(() => this.$refs.addDialog.showModal()); },
    async addNaplet() {
      const sourceId = text(this.addDialog.sourceId);
      if (!sourceId || this.saving) return;
      this.saving = true;
      try {
        await this.syncRuntime.addNaplet({
          source: { type: this.addDialog.type, id: sourceId },
          title: text(this.addDialog.title) || undefined,
          layout: { x: Math.round(-this.viewport.x / this.viewport.scale + 80), y: Math.round(-this.viewport.y / this.viewport.scale + 80), width: 380, height: 280, z: this.naplets.length + 1 },
        });
        this.$refs.addDialog.close();
      } catch (error) { this.error = error?.message || 'Could not add naplet.'; }
      finally { this.saving = false; }
    },
    napletStyle(naplet) { const layout = naplet.layout; return `left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;z-index:${layout.z}`; },
    htmlDocument(naplet) { return buildCanvasHtmlDocument(naplet?.content?.html); },
  };
}

Alpine.store('canvas', canvasPageStore());
window.Alpine = Alpine;
Alpine.start();
