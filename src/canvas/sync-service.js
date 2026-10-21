import Dexie, { liveQuery } from 'dexie';
import {
  createTowerPgCanvas,
  createTowerPgCanvasComment,
  createTowerPgCanvasElement,
  createTowerPgCanvasNaplet,
  deleteTowerPgCanvasComment,
  deleteTowerPgCanvasElement,
  deleteTowerPgCanvasNaplet,
  getTowerPgCanvases,
  getTowerPgCanvasSnapshot,
  reorderTowerPgCanvases,
  updateTowerPgCanvas,
  updateTowerPgCanvasComment,
  updateTowerPgCanvasElement,
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
      await commitCanvasProjection(this.db, snapshot, () => generation === this.generation);
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

  createElement(body) {
    return this.enqueueMutation(async () => {
      if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
      await createTowerPgCanvasElement(this.context.workspaceId, this.canvasId, body, apiOptions(this.context));
      return this.refresh();
    });
  }

  updateElement(elementId, patch) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const element = snapshot?.elements?.find(row => row.id === elementId);
      if (!this.authorized || !element) throw new Error('Canvas element authorization must be refreshed.');
      await updateTowerPgCanvasElement(this.context.workspaceId, this.canvasId, elementId, {
        ...patch,
        expected_row_version: element.row_version,
      }, apiOptions(this.context));
      return this.refresh();
    });
  }

  deleteElement(elementId) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const element = snapshot?.elements?.find(row => row.id === elementId);
      if (!this.authorized || !element) throw new Error('Canvas element authorization must be refreshed.');
      await deleteTowerPgCanvasElement(this.context.workspaceId, this.canvasId, elementId, { expected_row_version: element.row_version }, apiOptions(this.context));
      return this.refresh();
    });
  }

  deleteNaplet(napletId) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const naplet = snapshot?.naplets?.find(row => row.id === napletId);
      if (!this.authorized || !naplet) throw new Error('Canvas naplet authorization must be refreshed.');
      await deleteTowerPgCanvasNaplet(this.context.workspaceId, this.canvasId, napletId, { expected_row_version: naplet.row_version }, apiOptions(this.context));
      return this.refresh();
    });
  }

  createComment(body) {
    return this.enqueueMutation(async () => {
      if (!this.authorized) throw new Error('Canvas authorization must be refreshed.');
      await createTowerPgCanvasComment(this.context.workspaceId, this.canvasId, body, apiOptions(this.context));
      return this.refresh();
    });
  }

  deleteComment(commentId, confirmation) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const comment = snapshot?.comments?.find(row => row.id === commentId);
      if (!this.authorized || !comment?.can_delete) throw new Error('You cannot delete this comment. Refresh Canvas permissions.');
      await deleteTowerPgCanvasComment(this.context.workspaceId, this.canvasId, commentId, {
        expected_row_version: confirmation.expected_row_version,
        ...(comment.parent_comment_id ? {} : { expected_reply_versions: confirmation.expected_reply_versions }),
      }, apiOptions(this.context));
      return this.refresh();
    });
  }

  retargetComment(commentId, anchor) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const comment = snapshot?.comments?.find(row => row.id === commentId);
      if (!this.authorized || !comment?.can_retarget || comment.parent_comment_id) throw new Error('You cannot change this comment subject.');
      await updateTowerPgCanvasComment(this.context.workspaceId, this.canvasId, commentId, { anchor, expected_row_version: comment.row_version }, apiOptions(this.context));
      return this.refresh();
    });
  }

  setCommentResolved(commentId, resolved) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.db.canvas_snapshots.get(this.key);
      const comment = snapshot?.comments?.find(row => row.id === commentId);
      if (!this.authorized || !comment) throw new Error('Canvas comment authorization must be refreshed.');
      await updateTowerPgCanvasComment(this.context.workspaceId, this.canvasId, commentId, {
        resolved,
        expected_row_version: comment.row_version,
      }, apiOptions(this.context));
      return this.refresh();
    });
  }
}
