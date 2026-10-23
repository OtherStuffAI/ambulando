import { getTowerPgFileVersionObjectBytes } from '../api.js';
import { CANVAS_HTML_ASSET_LIMITS, CANVAS_HTML_ASSET_TYPES } from './projection.js';

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Viewer-scoped, memory-only cache of private HTML artifact image bytes. Bytes
 * are fetched through the signed typed File-version route, verified against the
 * server-authorized manifest (size, type, sha256) and never persisted to Dexie,
 * so revocation and workspace switches leave nothing on disk.
 */
export class CanvasHtmlAssetStore {
  constructor(context, { fetchBytes = getTowerPgFileVersionObjectBytes, maxCacheBytes = 96 * 1024 * 1024 } = {}) {
    this.context = Object.freeze({ ...context });
    this.fetchBytes = fetchBytes;
    this.maxCacheBytes = maxCacheBytes;
    this.blobs = new Map();
    this.pending = new Map();
    this.bytes = 0;
    // Keys the latest authorized projections still display; null until the
    // first retain(). Loads outside this set are refused and in-flight fetches
    // for keys dropped meanwhile are discarded rather than cached or returned.
    this.allowed = null;
    this.controller = new AbortController();
  }

  isAllowed(key) { return !this.allowed || this.allowed.has(key); }

  key(asset) { return `${asset.file_id}:${asset.version_id}:${asset.sha256}`; }

  async load(asset) {
    const key = this.key(asset);
    if (!this.isAllowed(key)) throw new Error('Asset is no longer authorized');
    const cached = this.blobs.get(key);
    if (cached) {
      this.blobs.delete(key); this.blobs.set(key, cached);
      return cached;
    }
    if (!this.pending.has(key)) {
      const request = this.fetchVerified(asset).finally(() => this.pending.delete(key));
      this.pending.set(key, request);
    }
    return this.pending.get(key);
  }

  async fetchVerified(asset) {
    if (asset.status !== 'ready' || !CANVAS_HTML_ASSET_TYPES.includes(asset.content_type) || asset.size_bytes > CANVAS_HTML_ASSET_LIMITS.assetBytes) {
      throw new Error('Asset is not deliverable');
    }
    const signal = this.controller.signal;
    const { bytes } = await this.fetchWithRetry(asset, signal);
    if (bytes.byteLength !== asset.size_bytes) throw new Error('Asset size mismatch');
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== asset.sha256) throw new Error('Asset digest mismatch');
    signal.throwIfAborted();
    if (!this.isAllowed(this.key(asset))) throw new Error('Asset is no longer authorized');
    const blob = new Blob([bytes], { type: asset.content_type });
    this.blobs.set(this.key(asset), blob);
    this.bytes += blob.size;
    for (const [key, value] of this.blobs) {
      if (this.bytes <= this.maxCacheBytes) break;
      if (value === blob) continue;
      this.blobs.delete(key); this.bytes -= value.size;
    }
    return blob;
  }

  // One retry for proxy/network failures (e.g. a transient 502); never for
  // authority answers (4xx) or aborts.
  async fetchWithRetry(asset, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fetchBytes(this.context.workspaceId, asset.file_id, asset.version_id, {
          baseUrl: this.context.baseUrl, appNpub: this.context.appNpub, signal,
        });
      } catch (error) {
        const transient = error?.name !== 'AbortError' && (!error?.status || error.status >= 500);
        if (attempt >= 1 || !transient || signal.aborted) throw error;
      }
    }
  }

  /** Resolve every ready asset; failures are omitted rather than substituted. */
  async resolve(assets) {
    const ready = (assets || []).filter(asset => asset.status === 'ready');
    const settled = await Promise.allSettled(ready.map(asset => this.load(asset)));
    return ready.flatMap((asset, index) => settled[index].status === 'fulfilled' ? [{ name: asset.name, blob: settled[index].value }] : []);
  }

  /** Drop bytes that no longer appear in any authorized projection. */
  retain(assets) {
    const keep = new Set((assets || []).filter(asset => asset.status === 'ready').map(asset => this.key(asset)));
    this.allowed = keep;
    for (const [key, blob] of this.blobs) {
      if (!keep.has(key)) { this.blobs.delete(key); this.bytes -= blob.size; }
    }
    for (const key of [...this.pending.keys()]) if (!keep.has(key)) this.pending.delete(key);
  }

  clear() {
    this.controller.abort();
    this.controller = new AbortController();
    this.blobs.clear(); this.pending.clear(); this.bytes = 0;
    this.allowed = new Set();
  }
}
