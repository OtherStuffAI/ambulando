import { liveQuery } from 'dexie';
import {
  createTowerPgCanvas,
  createTowerPgCanvasNaplet,
  getTowerPgCanvases,
  getTowerPgCanvasSnapshot,
  reorderTowerPgCanvases,
  updateTowerPgCanvas,
  updateTowerPgCanvasNaplet,
} from '../api.js';
import { getWorkspaceDb } from '../db.js';
import {
  canvasDefinitionKey,
  canvasPartition,
  normalizeCanvasList,
  normalizeCanvasSnapshot,
} from './projection.js';

const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const apiOptions = (context, signal) => ({ baseUrl: context.baseUrl, appNpub: context.appNpub, signal });

export async function hydrateCanvasList(context, { signal } = {}) {
  const partition = canvasPartition(context);
  const db = getWorkspaceDb();
  const payload = await getTowerPgCanvases(context.workspaceId, apiOptions(context, signal));
  const rows = normalizeCanvasList(payload, context);
  await db.transaction('rw', db.canvas_definitions, async () => {
    await db.canvas_definitions.where('context').equals(partition).delete();
    if (rows.length) await db.canvas_definitions.bulkPut(rows);
  });
  return rows;
}

export async function createCanvasRecord(context, body, options = {}) {
  await createTowerPgCanvas(context.workspaceId, body, apiOptions(context, options.signal));
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
    this.controller = null;
    this.subscription = null;
    this.mutationTail = Promise.resolve();
  }

  start() {
    if (this.subscription) return;
    this.subscription = liveQuery(() => this.db.canvas_snapshots.get(this.key)).subscribe({
      next: snapshot => {
        if (this.authorized && snapshot) this.onSnapshot?.(snapshot);
      },
      error: error => this.onError?.(error),
    });
    void this.refresh().catch(() => undefined);
  }

  stop() {
    this.generation += 1;
    this.authorized = false;
    this.controller?.abort();
    this.controller = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  async refresh() {
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
      if (generation !== this.generation) return null;
      await this.db.transaction('rw', this.db.canvas_snapshots, this.db.canvas_definitions, async () => {
        if (generation !== this.generation) throw new DOMException('Canvas context changed', 'AbortError');
        await this.db.canvas_snapshots.put(snapshot);
        await this.db.canvas_definitions.put(snapshot.canvas);
      });
      if (generation !== this.generation) return null;
      this.authorized = true;
      this.onSnapshot?.(snapshot);
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
    const run = this.mutationTail.catch(() => undefined).then(operation);
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
      return this.refresh();
    });
  }

  updateNapletLayout(napletId, layout) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const naplet = snapshot?.naplets?.find(row => row.id === napletId);
      if (!this.authorized || !naplet) throw new Error('Canvas naplet authorization must be refreshed.');
      await updateTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, napletId, {
        layout,
        expected_row_version: naplet.row_version,
      }, apiOptions(this.context));
      return this.refresh();
    });
  }

  addNaplet(body) {
    return this.enqueueMutation(async () => {
      if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
      await createTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, body, apiOptions(this.context));
      return this.refresh();
    });
  }
}
