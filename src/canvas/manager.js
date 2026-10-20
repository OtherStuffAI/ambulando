import { liveQuery } from 'dexie';
import { getCurrentWorkspaceDbKey, getWorkspaceDb } from '../db.js';
import { canvasContext, canvasPartition } from './projection.js';
import { createCanvasRecord, hydrateCanvasList, reorderCanvasRecords, updateCanvasRecord } from './sync-service.js';

const runtimes = new WeakMap();
const text = value => String(value ?? '').trim();

function scheduleUiNextTick(callback) {
  const nextTick = globalThis.Alpine?.nextTick;
  if (typeof nextTick === 'function') {
    nextTick(callback);
    return;
  }
  queueMicrotask(callback);
}

export const canvasManagerMixin = {
  canvasRows: [],
  canvasContextKey: '',
  canvasLoading: false,
  canvasError: '',
  canvasSaving: false,
  canvasDraggedId: '',
  canvasDialog: { open: false, mode: 'create', id: '', rowVersion: null, title: '', visibilityMode: 'workspace', actorIds: [], groupIds: [] },

  get canvasPartition() {
    const context = canvasContext(this);
    return context.workspaceId && context.viewer && getCurrentWorkspaceDbKey() ? canvasPartition(context) : '';
  },
  get visibleCanvases() {
    return this.canvasContextKey === this.canvasPartition
      ? [...this.canvasRows].sort((a, b) => a.position - b.position || a.canvas_id.localeCompare(b.canvas_id))
      : [];
  },
  stopCanvases() {
    const runtime = runtimes.get(this);
    runtime?.controller?.abort();
    runtime?.subscription?.unsubscribe();
    runtimes.delete(this);
    this.canvasRows = [];
    this.canvasContextKey = '';
  },
  syncCanvasContext(partition) {
    const dbKey = getCurrentWorkspaceDbKey();
    const key = JSON.stringify([partition, dbKey]);
    if (runtimes.get(this)?.key === key) return;
    this.stopCanvases();
    this.canvasContextKey = partition;
    this.canvasError = '';
    if (!partition || !dbKey) return;
    const db = getWorkspaceDb();
    const controller = new AbortController();
    const subscription = liveQuery(() => db.canvas_definitions.where('context').equals(partition).toArray()).subscribe({
      next: rows => {
        if (this.canvasPartition === partition && runtimes.get(this)?.key === key) this.canvasRows = rows;
      },
      error: () => { if (this.canvasPartition === partition) this.canvasError = 'Could not load Canvas.'; },
    });
    runtimes.set(this, { key, controller, subscription });
    void this.refreshCanvases({ partition, key, controller });
  },
  async refreshCanvases(runtime = runtimes.get(this)) {
    if (!runtime || runtime.key !== runtimes.get(this)?.key) return;
    const context = canvasContext(this);
    const partition = canvasPartition(context);
    this.canvasLoading = true;
    this.canvasError = '';
    try {
      const rows = await hydrateCanvasList(context, { signal: runtime.controller.signal });
      if (runtime.key !== runtimes.get(this)?.key || partition !== this.canvasPartition) return;
      this.canvasRows = rows;
    } catch (error) {
      if (error?.name !== 'AbortError' && partition === this.canvasPartition) {
        this.canvasRows = [];
        this.canvasError = error?.status === 404 ? 'Canvas is not available on this NStack.' : (error?.message || 'Could not refresh Canvas.');
      }
    } finally {
      if (partition === this.canvasPartition) this.canvasLoading = false;
    }
  },
  openCanvasCreateDialog() {
    this.canvasDialog = { open: true, mode: 'create', id: '', rowVersion: null, title: '', visibilityMode: 'workspace', actorIds: [], groupIds: [] };
    scheduleUiNextTick(() => document.getElementById('canvas-settings-dialog')?.showModal());
  },
  openCanvasSettingsDialog(canvas) {
    if (!canvas?.can_manage) return;
    this.canvasDialog = {
      open: true,
      mode: 'edit',
      id: canvas.canvas_id,
      rowVersion: canvas.row_version,
      title: canvas.title,
      visibilityMode: canvas.visibility?.mode || 'workspace',
      actorIds: [...(canvas.visibility?.actor_ids || [])],
      groupIds: [...(canvas.visibility?.group_ids || [])],
    };
    scheduleUiNextTick(() => document.getElementById('canvas-settings-dialog')?.showModal());
  },
  closeCanvasSettingsDialog() {
    document.getElementById('canvas-settings-dialog')?.close();
    this.canvasDialog = { ...this.canvasDialog, open: false };
  },
  toggleCanvasVisibilityPrincipal(kind, id, checked) {
    const field = kind === 'group' ? 'groupIds' : 'actorIds';
    const values = new Set(this.canvasDialog[field]);
    if (checked) values.add(id); else values.delete(id);
    this.canvasDialog = { ...this.canvasDialog, [field]: [...values] };
  },
  async saveCanvasDialog() {
    const title = text(this.canvasDialog.title);
    if (!title || this.canvasSaving) return;
    const context = canvasContext(this);
    const body = {
      title,
      visibility: {
        mode: this.canvasDialog.visibilityMode === 'restricted' ? 'restricted' : 'workspace',
        actor_ids: this.canvasDialog.visibilityMode === 'restricted' ? this.canvasDialog.actorIds : [],
        group_ids: this.canvasDialog.visibilityMode === 'restricted' ? this.canvasDialog.groupIds : [],
      },
    };
    this.canvasSaving = true;
    this.canvasError = '';
    try {
      if (this.canvasDialog.mode === 'edit') {
        await updateCanvasRecord(context, this.canvasDialog.id, {
          ...body,
          expected_row_version: this.canvasDialog.rowVersion,
        });
      } else {
        await createCanvasRecord(context, body);
      }
      this.closeCanvasSettingsDialog();
      await this.refreshCanvases();
    } catch (error) {
      this.canvasError = error?.message || 'Could not save canvas.';
    } finally { this.canvasSaving = false; }
  },
  openCanvas(canvas) {
    if (!canvas?.canvas_id || !this.currentWorkspaceKey) return;
    const url = new URL('/canvas.html', window.location.origin);
    url.searchParams.set('workspacekey', this.currentWorkspaceKey);
    url.searchParams.set('canvasid', canvas.canvas_id);
    window.open(url.toString(), '_blank');
  },
  beginCanvasDrag(canvas, event) {
    this.canvasDraggedId = canvas?.canvas_id || '';
    event?.dataTransfer?.setData('text/plain', this.canvasDraggedId);
    if (event?.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  },
  async dropCanvasBefore(target) {
    const dragged = this.canvasDraggedId;
    this.canvasDraggedId = '';
    if (!dragged || !target?.canvas_id || dragged === target.canvas_id) return;
    const ordered = this.visibleCanvases.map(row => row.canvas_id).filter(id => id !== dragged);
    ordered.splice(ordered.indexOf(target.canvas_id), 0, dragged);
    const context = canvasContext(this), partition = this.canvasPartition, db = getWorkspaceDb();
    await db.transaction('rw', db.canvas_definitions, async () => {
      for (const [index, id] of ordered.entries()) {
        const row = this.canvasRows.find(value => value.canvas_id === id);
        if (row) await db.canvas_definitions.put({ ...row, position: index + 1 });
      }
    });
    try {
      await reorderCanvasRecords(context, ordered);
    } catch (error) {
      this.canvasError = error?.message || 'Could not reorder canvases.';
      if (partition === this.canvasPartition) await this.refreshCanvases();
    }
  },
};
