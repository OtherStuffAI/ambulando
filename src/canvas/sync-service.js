import Dexie, { liveQuery } from 'dexie';
import {
  createTowerPgCanvas,
  createTowerPgCanvasElement,
  createTowerPgCanvasNaplet,
  deleteTowerPgCanvasElement,
  deleteTowerPgCanvasNaplet,
  getTowerPgCanvases,
  getTowerPgCanvasNapletHtml,
  getTowerPgCanvasSnapshot,
  getTowerPgFile,
  reorderTowerPgCanvases,
  updateTowerPgCanvas,
  updateTowerPgCanvasElement,
  updateTowerPgCanvasNaplet,
} from '../api.js';
import { getWorkspaceDb } from '../db.js';
import {
  assertIdentity,
  canvasDefinitionKey,
  canvasPartition,
  normalizeCanvasList,
  normalizeCanvasSnapshot,
  normalizeHtmlContent,
} from './projection.js';

const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const apiOptions = (context, signal) => ({ baseUrl: context.baseUrl, appNpub: context.appNpub, signal });

export async function hydrateCanvasList(context, { signal } = {}) {
  const partition = canvasPartition(context);
  const db = getWorkspaceDb();
  const payload = await getTowerPgCanvases(context.workspaceId, apiOptions(context, signal));
  const rows = normalizeCanvasList(payload, context);
  await db.transaction('rw', db.canvas_definitions, () => {
    return db.canvas_definitions.where('context').equals(partition).delete()
      .then(() => rows.length ? db.canvas_definitions.bulkPut(rows) : undefined);
  });
  return rows;
}

function canvasRefreshAbort() {
  return new DOMException('Canvas context changed', 'AbortError');
}

function commitCanvasProjection(db, snapshot, isCurrent) {
  return db.transaction('rw', db.canvas_snapshots, db.canvas_definitions, () => {
    if (!isCurrent()) throw canvasRefreshAbort();
    // Queue both IndexedDB requests before yielding. A native/non-Dexie async
    // gap between these writes can let the browser auto-commit the transaction.
    return Dexie.Promise.all([
      db.canvas_snapshots.put(snapshot),
      db.canvas_definitions.put(snapshot.canvas),
    ]).then(() => {
      if (!isCurrent()) throw canvasRefreshAbort();
      return snapshot;
    });
  });
}

export async function createCanvasRecord(context, body, options = {}) {
  const payload = await createTowerPgCanvas(context.workspaceId, body, apiOptions(context, options.signal));
  // Record acceptance before hydration: retrying a failed list must never POST again.
  options.onCreated?.(payload);
  return hydrateCanvasList(context, options);
}

export async function updateCanvasRecord(context, canvasId, body, options = {}) {
  await updateTowerPgCanvas(context.workspaceId, canvasId, body, apiOptions(context, options.signal));
  return hydrateCanvasList(context, options);
}

export async function reorderCanvasRecords(context, canvasIds, options = {}) {
  await reorderTowerPgCanvases(context.workspaceId, { canvas_ids: canvasIds }, apiOptions(context, options.signal));
  return hydrateCanvasList(context, options);
}

export class CanvasSyncRuntime {
  constructor(context, canvasId, { onSnapshot, onError } = {}) {
    this.context = Object.freeze({ ...context });
    this.canvasId = String(canvasId || '').trim();
    this.key = canvasDefinitionKey(this.context, this.canvasId);
    this.db = getWorkspaceDb();
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.authorized = false;
    this.generation = 0;
    this.lifecycle = 0;
    this.stopped = false;
    this.controller = null;
    this.subscription = null;
    this.mutationTail = Promise.resolve();
    this.refreshPending = null;
    this.lastPublishedRequest = null;
  }

  start() {
    if (this.subscription) return;
    this.stopped = false;
    this.subscription = liveQuery(() => this.db.canvas_snapshots.get(this.key)).subscribe({
      next: snapshot => {
        if (this.authorized && snapshot) this.publish(snapshot);
      },
      error: error => this.onError?.(error),
    });
    void this.refresh().catch(() => undefined);
  }

  stop() {
    this.stopped = true;
    this.refreshPending = null;
    this.lastPublishedRequest = null;
    this.lifecycle += 1;
    this.generation += 1;
    this.authorized = false;
    this.controller?.abort();
    this.controller = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  publish(snapshot) {
    if (snapshot.request_id && this.lastPublishedRequest === snapshot.request_id) return;
    this.lastPublishedRequest = snapshot.request_id;
    this.onSnapshot?.(snapshot);
  }

  // Reads share the write queue so a pre-save full snapshot cannot overtake
  // an accepted write or invalidate the revision needed by the next save.
  refresh() {
    if (this.refreshPending) {
      const lifecycle = this.lifecycle;
      return this.refreshPending.then(snapshot => {
        if (this.stopped || lifecycle !== this.lifecycle) throw canvasRefreshAbort();
        return snapshot;
      });
    }
    const pending = this.enqueueMutation(() => this.refreshProjection());
    this.refreshPending = pending;
    pending.finally(() => { if (this.refreshPending === pending) this.refreshPending = null; }).catch(() => undefined);
    return pending;
  }

  async refreshProjection() {
    if (this.stopped) throw canvasRefreshAbort();
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const payload = await getTowerPgCanvasSnapshot(
        this.context.workspaceId,
        this.canvasId,
        apiOptions(this.context, controller.signal),
      );
      const snapshot = normalizeCanvasSnapshot(payload, this.context, this.canvasId, uuid());
      // Legacy naplet display_title overrides must not mask a renamed board File.
      const boardIds = [...new Set(snapshot.naplets.filter(row => row.access === 'ready' && row.source?.type === 'excalidraw').map(row => row.source.id))];
      await Promise.all(boardIds.map(async fileId => {
        try {
          const result = await getTowerPgFile(this.context.workspaceId, fileId, apiOptions(this.context, controller.signal));
          if (result?.file?.id !== fileId || !String(result.file.display_name || '').trim()) throw new Error('Board title could not be refreshed.');
          for (const naplet of snapshot.naplets) if (naplet.access === 'ready' && naplet.source?.type === 'excalidraw' && naplet.source.id === fileId) naplet.title = result.file.display_name;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          // A failed File recheck must neither expose its old title nor remove
          // unrelated canvas content. Retry the board on the next refresh.
          snapshot.naplets = snapshot.naplets.map(naplet => naplet.access === 'ready' && naplet.source?.type === 'excalidraw' && naplet.source.id === fileId
            ? { id: naplet.id, access: 'denied', layout: naplet.layout, row_version: naplet.row_version }
            : naplet);
        }
      }));
      if (generation !== this.generation) return null;
      await commitCanvasProjection(this.db, snapshot, () => generation === this.generation);
      if (generation !== this.generation) return null;
      this.authorized = true;
      this.publish(snapshot);
      return snapshot;
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== this.generation) return null;
      this.authorized = false;
      if ([401, 403, 404].includes(Number(error?.status))) {
        await this.db.canvas_snapshots.delete(this.key).catch(() => undefined);
      }
      this.onError?.(error);
      throw error;
    }
  }

  enqueueMutation(operation) {
    this.refreshPending = null;
    const lifecycle = this.lifecycle;
    const run = this.mutationTail.catch(() => undefined).then(() => {
      if (this.stopped || lifecycle !== this.lifecycle) throw canvasRefreshAbort();
      return operation();
    });
    this.mutationTail = run;
    return run;
  }

  updateViewport(viewport) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      if (!this.authorized || !snapshot?.canvas) throw new Error('Canvas authorization must be refreshed.');
      await updateTowerPgCanvas(this.context.workspaceId, this.canvasId, {
        viewport,
        expected_row_version: snapshot.canvas.row_version,
      }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  updateTaskTreeView(napletId, body) {
    return this.enqueueMutation(async () => {
      const snapshot=await this.db.canvas_snapshots.get(this.key);
      const naplet=snapshot?.naplets?.find(row=>row.id===napletId);
      if(!this.authorized || naplet?.access!=='ready' || naplet.source?.type!=='task_tree') throw new Error('Task Tree authorization must be refreshed.');
      await updateTowerPgCanvasNaplet(this.context.workspaceId,this.canvasId,napletId,{...body,expected_row_version:naplet.row_version},apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  updateNapletLayout(napletId, layout) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const naplet = snapshot?.naplets?.find(row => row.id === napletId);
      if (!this.authorized || naplet?.access !== 'ready') throw new Error('Canvas naplet authorization must be refreshed.');
      await updateTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, napletId, {
        layout: { ...naplet.layout, ...layout },
        expected_row_version: naplet.row_version,
      }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  // Pin an HTML naplet to one File version, or pass null to follow latest.
  setNapletVersionPolicy(napletId, versionId) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const naplet = snapshot?.naplets?.find(row => row.id === napletId);
      if (!this.authorized || naplet?.access !== 'ready' || naplet.source?.type !== 'html') throw new Error('Canvas naplet authorization must be refreshed.');
      await updateTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, napletId, {
        source_version_id: versionId || null,
        expected_row_version: naplet.row_version,
      }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  /**
   * Viewer-local version browsing: a command read that never changes the
   * naplet or the Dexie projection. Tower re-authorizes the File first.
   */
  async readNapletHtml(napletId, versionId = '', { signal } = {}) {
    if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
    const payload = await getTowerPgCanvasNapletHtml(this.context.workspaceId, this.canvasId, napletId, { versionId, ...apiOptions(this.context, signal) });
    assertIdentity(payload, this.context);
    if (String(payload?.naplet_id || '') !== String(napletId)) throw new Error('Invalid Canvas HTML response');
    const content = normalizeHtmlContent(payload.content);
    const versions = (Array.isArray(payload.versions) ? payload.versions : [])
      .map(row => ({ id: String(row?.id || '').trim(), version_number: Number(row?.version_number), created_at: String(row?.created_at || ''), content_type: String(row?.content_type || '') }))
      .filter(row => row.id && Number.isSafeInteger(row.version_number) && row.version_number > 0)
      .sort((a, b) => b.version_number - a.version_number);
    return { content, versions };
  }

  addNaplet(body) {
    return this.enqueueMutation(async () => {
      if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
      await createTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, body, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  createElement(body) {
    return this.enqueueMutation(async () => {
      if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
      await createTowerPgCanvasElement(this.context.workspaceId, this.canvasId, body, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  updateElement(elementId, patch) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const element = snapshot?.elements?.find(row => row.id === elementId);
      if (!this.authorized || !element) throw new Error('Canvas element authorization must be refreshed.');
      await updateTowerPgCanvasElement(this.context.workspaceId, this.canvasId, elementId, {
        ...patch,
        ...(patch.layout ? { layout: { ...element.layout, ...patch.layout } } : {}),
        expected_row_version: element.row_version,
      }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  deleteElement(elementId) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const element = snapshot?.elements?.find(row => row.id === elementId);
      if (!this.authorized || !element) throw new Error('Canvas element authorization must be refreshed.');
      await deleteTowerPgCanvasElement(this.context.workspaceId, this.canvasId, elementId, { expected_row_version: element.row_version }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

  deleteNaplet(napletId) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const naplet = snapshot?.naplets?.find(row => row.id === napletId);
      if (!this.authorized || !naplet) throw new Error('Canvas naplet authorization must be refreshed.');
      await deleteTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, napletId, { expected_row_version: naplet.row_version }, apiOptions(this.context));
      return this.refreshProjection();
    });
  }

}
