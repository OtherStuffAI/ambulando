import { liveQuery } from 'dexie';
import {
  completeStorageObject,
  createTowerPgChannelFile,
  createTowerPgFileVersion,
  getTowerPgFileVersionObjectBytes,
  getTowerPgFileVersions,
  prepareTowerPgStorageObject,
  uploadStorageObject,
} from '../api.js';
import { getWorkspaceDb } from '../db.js';
import { buildStoragePrepareBody } from '../storage-payloads.js';
import { canvasPartition } from './projection.js';
import {
  BOARD_CONTENT_TYPE,
  BOARD_LIMITS,
  boardFileName,
  boardSceneFingerprint,
  createEmptyBoardScene,
  parseBoardScene,
  serializeBoardScene,
} from './board-scene.js';

const text = value => String(value ?? '').trim();
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value)) ? text(value).toLowerCase() : '';
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const BOARD_DEFAULT_API = Object.freeze({
  completeStorageObject,
  createTowerPgChannelFile,
  createTowerPgFileVersion,
  getTowerPgFileVersionObjectBytes,
  getTowerPgFileVersions,
  prepareTowerPgStorageObject,
  uploadStorageObject,
});

export class BoardStaleError extends Error {
  constructor(currentVersion) {
    super('Someone saved a newer version of this board. Your changes are kept as an unsaved draft.');
    this.name = 'BoardStaleError';
    this.code = 'stale_base_version';
    this.status = 409;
    this.currentVersion = currentVersion;
  }
}

export function normalizeBoardVersion(row) {
  const id = uuid(row?.id);
  const number = Number(row?.version_number);
  if (!id || !Number.isSafeInteger(number) || number < 1) return null;
  return {
    id,
    version_number: number,
    created_at: text(row?.created_at),
    author_npub: text(row?.created_by_actor_npub),
    summary: text(row?.summary).slice(0, BOARD_LIMITS.summary),
    size_bytes: Number.isSafeInteger(Number(row?.size_bytes)) ? Number(row.size_bytes) : null,
    sha256: /^[0-9a-f]{64}$/.test(text(row?.sha256_hex).toLowerCase()) ? text(row.sha256_hex).toLowerCase() : '',
    content_type: text(row?.content_type).toLowerCase(),
  };
}

export function boardDraftKey(context, fileId) {
  return JSON.stringify([canvasPartition(context), text(fileId)]);
}

async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * The only network/update owner for Excalidraw boards on a Canvas page. Boards
 * are Tower Files: every byte read and every save is a signed typed File route,
 * re-authorized by Tower (`file.read` / `file.write` on the board's channel).
 * Unsaved drafts live in the viewer/workspace/authority-partitioned
 * `canvas_board_drafts` Dexie table and render through liveQuery; saved scene
 * bytes are cached in memory only, so revocation leaves nothing on disk.
 */
export class CanvasBoardRuntime {
  constructor(context, { api = BOARD_DEFAULT_API, db = null, maxCachedScenes = 24, maxCacheBytes = 64 * 1024 * 1024 } = {}) {
    this.context = Object.freeze({ ...context });
    this.api = api;
    this.db = db || getWorkspaceDb();
    this.partition = canvasPartition(this.context);
    this.scenes = new Map();
    this.maxCachedScenes = maxCachedScenes;
    this.maxCacheBytes = maxCacheBytes;
    this.cacheBytes = 0;
    this.controller = new AbortController();
  }

  options(extra = {}) {
    return { baseUrl: this.context.baseUrl, appNpub: this.context.appNpub, signal: this.controller.signal, ...extra };
  }

  /** Exact, digest-verified scene of one immutable version. */
  async readVersion(fileId, versionId, { sha256 = '' } = {}) {
    const key = `${fileId}:${versionId}`;
    const cached = this.scenes.get(key);
    if (cached && (!sha256 || cached.sha256 === sha256)) {
      this.scenes.delete(key); this.scenes.set(key, cached);
      return cached;
    }
    const { bytes } = await this.api.getTowerPgFileVersionObjectBytes(this.context.workspaceId, fileId, versionId, this.options());
    if (bytes.byteLength > BOARD_LIMITS.bytes) throw new Error('This board is larger than the supported size.');
    const digest = await sha256Hex(bytes);
    if (sha256 && digest !== sha256) throw new Error('Board version integrity check failed.');
    const scene = parseBoardScene(bytes);
    const entry = { file_id: fileId, version_id: versionId, sha256: digest, scene, fingerprint: boardSceneFingerprint(scene), bytes: bytes.byteLength };
    this.forget(key);
    this.scenes.set(key, entry);
    this.cacheBytes += entry.bytes;
    // Bounded by entries and by bytes; the newest entry is always kept.
    while (this.scenes.size > 1 && (this.scenes.size > this.maxCachedScenes || this.cacheBytes > this.maxCacheBytes)) this.forget(this.scenes.keys().next().value);
    return entry;
  }

  forget(key) {
    const entry = this.scenes.get(key);
    if (!entry) return;
    this.scenes.delete(key);
    this.cacheBytes -= entry.bytes || 0;
  }

  async listVersions(fileId) {
    const payload = await this.api.getTowerPgFileVersions(this.context.workspaceId, fileId, this.options());
    if (text(payload?.file_id) && text(payload.file_id) !== text(fileId)) throw new Error('Invalid board version response');
    const versions = (Array.isArray(payload?.versions) ? payload.versions : []).map(normalizeBoardVersion).filter(Boolean)
      .sort((a, b) => b.version_number - a.version_number);
    return { current_version_id: uuid(payload?.current_version_id), versions };
  }

  async uploadScene(scene, { title, summary = '', baseVersionId = '' }) {
    const { bytes } = serializeBoardScene(scene, { summary, baseVersionId });
    const digest = await sha256Hex(bytes);
    const body = buildStoragePrepareBody({ ownerNpub: this.context.viewer, contentType: BOARD_CONTENT_TYPE, sizeBytes: bytes.byteLength, fileName: boardFileName(title) });
    const prepared = await this.api.prepareTowerPgStorageObject(this.context.workspaceId, body, this.options());
    if (prepared?.is_public) throw new Error('Tower prepared a public object for a private board; refusing to upload.');
    await this.api.uploadStorageObject(prepared, bytes, BOARD_CONTENT_TYPE, this.options());
    await this.api.completeStorageObject(prepared.object_id, { size_bytes: bytes.byteLength, sha256_hex: digest }, this.options());
    return { objectId: prepared.object_id, sha256: digest, size: bytes.byteLength };
  }

  /** Creates the persistent board (version 1) in a channel the viewer can write. */
  async createBoard({ channelId, title, scene = createEmptyBoardScene(), summary = '' }) {
    const name = text(title).slice(0, BOARD_LIMITS.title) || 'Untitled board';
    if (!uuid(channelId)) throw new Error('Choose a channel for the new board.');
    const upload = await this.uploadScene(scene, { title: name, summary });
    const payload = await this.api.createTowerPgChannelFile(this.context.workspaceId, channelId, {
      storage_object_id: upload.objectId,
      display_name: boardFileName(name),
      metadata: { kind: 'excalidraw_board', title: name },
      ...(text(summary) ? { summary: text(summary).slice(0, BOARD_LIMITS.summary) } : {}),
    }, this.options());
    const fileId = uuid(payload?.file?.id);
    if (!fileId) throw new Error('Tower did not return the new board.');
    return { file_id: fileId, version_id: uuid(payload?.file?.current_version_id), title: name };
  }

  /**
   * Publishes the draft as a new immutable version against `baseVersionId`.
   * Tower rejects a stale base atomically; the draft is never touched here.
   */
  async saveVersion({ fileId, baseVersionId, scene, summary = '', title = '' }) {
    if (!uuid(fileId) || !uuid(baseVersionId)) throw new Error('This board has no saved version to save against. Refresh and try again.');
    const upload = await this.uploadScene(scene, { title, summary, baseVersionId });
    try {
      const payload = await this.api.createTowerPgFileVersion(this.context.workspaceId, fileId, {
        base_version_id: baseVersionId,
        storage_object_id: upload.objectId,
        client_mutation_id: globalThis.crypto?.randomUUID?.() || `${Date.now()}`,
        ...(text(summary) ? { summary: text(summary).slice(0, BOARD_LIMITS.summary) } : {}),
      }, this.options());
      const version = normalizeBoardVersion(payload?.version);
      if (!version) throw new Error('Tower did not return the saved version.');
      return { version: { ...version, sha256: version.sha256 || upload.sha256 } };
    } catch (error) {
      if (Number(error?.status) === 409 && (error?.code === 'stale_base_version' || /stale/i.test(String(error?.message)))) {
        throw new BoardStaleError(normalizeBoardVersion(error?.payload?.current_version || error?.payload?.details?.current_version));
      }
      throw error;
    }
  }

  getDraft(fileId) { return this.db.canvas_board_drafts.get(boardDraftKey(this.context, fileId)); }

  putDraft(fileId, draft) {
    const row = {
      key: boardDraftKey(this.context, fileId),
      context: this.partition,
      file_id: text(fileId),
      base_version_id: text(draft.base_version_id),
      base_version_number: Number(draft.base_version_number) || null,
      base_fingerprint: text(draft.base_fingerprint),
      scene: draft.scene,
      fingerprint: boardSceneFingerprint(draft.scene),
      writer: text(draft.writer),
      updated_at: new Date().toISOString(),
    };
    return this.db.transaction('rw', this.db.canvas_board_drafts, () => this.db.canvas_board_drafts.put(row).then(() => row));
  }

  deleteDraft(fileId) { return this.db.canvas_board_drafts.delete(boardDraftKey(this.context, fileId)); }

  observeDraft(fileId, { next, error }) {
    const key = boardDraftKey(this.context, fileId);
    return liveQuery(() => this.db.canvas_board_drafts.get(key)).subscribe({ next, error });
  }

  /** Denial or workspace switch: drop cached bytes and the local draft. */
  async purge(fileId) {
    for (const key of [...this.scenes.keys()]) if (key.startsWith(`${fileId}:`)) this.forget(key);
    await this.deleteDraft(fileId).catch(() => undefined);
  }

  stop() {
    this.controller.abort();
    this.controller = new AbortController();
    this.scenes.clear();
    this.cacheBytes = 0;
  }
}
