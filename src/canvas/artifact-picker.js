import {
  getTowerPgChannelFiles, getTowerPgFileVersionObjectBytes, getTowerPgFileVersions,
  getTowerPgScopeChannels, getTowerPgWorkspaceScopes,
} from '../api.js';
import { BOARD_CONTENT_TYPE, BOARD_FILE_EXTENSION } from './board-scene.js';
import { CanvasHtmlAssetStore } from './html-assets.js';
import { CANVAS_HTML_ASSET_LIMITS, CANVAS_HTML_ASSET_NAME, CANVAS_HTML_ASSET_TYPES } from './projection.js';

const text = value => String(value ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
const MANIFEST_ID = 'wingman-artifact-assets';
// Matches Tower's HTML artefact byte limit; larger Files are not renderable on a canvas.
const ARTIFACT_PREVIEW_MAX_HTML_BYTES = 2 * 1024 * 1024;
const CHANNEL_CONCURRENCY = 4;
// Tower's list routes clamp `limit` to 200 and return no cursor, so a full
// page means older rows may exist that cannot be listed.
export const ARTIFACT_LIST_LIMIT = 200;
// Rows the picker renders before "Show more"; the merged list is never cut silently.
const ARTIFACT_LIST_PAGE = 200;

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const byTitle = (a, b) => a.title.localeCompare(b.title);

/**
 * Which canvas naplet type an existing File can become, from the metadata a
 * channel File list carries. That list omits content types, so HTML artefacts
 * are recognised by Tower's `html_artifact` marker or their file name.
 */
export function artifactKind(file) {
  if (!file?.id || file.deleted_at || file.archived_at || file.record_state === 'archived') return null;
  const metadata = file.metadata && typeof file.metadata === 'object' ? file.metadata : {};
  const type = text(file.object?.storage_object?.content_type).toLowerCase();
  const name = text(file.display_name || file.object?.storage_object?.file_name).toLowerCase();
  if (metadata.kind === 'excalidraw_board' || type === BOARD_CONTENT_TYPE || name.endsWith(BOARD_FILE_EXTENSION)) return 'excalidraw';
  if (metadata.html_artifact === true || HTML_TYPES.includes(type) || /\.x?html?$/.test(name)) return 'html';
  return null;
}

export function artifactTitle(file, kind = artifactKind(file)) {
  const name = text(file?.display_name || file?.object?.storage_object?.file_name);
  if (kind === 'excalidraw') return text(file?.metadata?.title) || name.replace(/\.excalidraw$/i, '') || 'Board';
  return name || 'HTML artefact';
}

/** Client mirror of Tower's manifest parser: invalid manifests resolve no assets. */
export function parseArtifactManifest(html) {
  const pattern = new RegExp(`<script\\b[^>]*\\bid\\s*=\\s*["']${MANIFEST_ID}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'gi');
  const matches = [...String(html || '').matchAll(pattern)];
  if (matches.length !== 1) return [];
  let parsed;
  try { parsed = JSON.parse(matches[0][1]); } catch { return []; }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.assets) || parsed.assets.length > CANVAS_HTML_ASSET_LIMITS.count) return [];
  const names = new Set(), entries = [];
  for (const row of parsed.assets) {
    const entry = { name: String(row?.name ?? ''), file_id: String(row?.file_id ?? '').toLowerCase(), version_id: String(row?.version_id ?? '').toLowerCase(), sha256: String(row?.sha256 ?? '').toLowerCase() };
    if (!CANVAS_HTML_ASSET_NAME.test(entry.name) || names.has(entry.name) || !UUID.test(entry.file_id) || !UUID.test(entry.version_id) || !SHA256.test(entry.sha256)) return [];
    names.add(entry.name); entries.push(entry);
  }
  return entries;
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await task(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const defaultApi = {
  getTowerPgWorkspaceScopes, getTowerPgScopeChannels, getTowerPgChannelFiles,
  getTowerPgFileVersions, getTowerPgFileVersionObjectBytes,
};

/**
 * Discovers existing artefact Files through Tower's visibility-filtered scope,
 * scope-channel and channel-file routes. Nothing here is persisted: Tower
 * stays the authority on every open, and no workspace-wide channel list or
 * byte download is involved.
 */
export class ArtifactCatalog {
  constructor(context, api = defaultApi) {
    this.context = Object.freeze({ ...context });
    this.api = { ...defaultApi, ...api };
  }

  options(extra = {}) { return { baseUrl: this.context.baseUrl, appNpub: this.context.appNpub, ...extra }; }

  /** Visible scopes; `truncated` when Tower returned a full page. */
  async scopes() {
    const result = await this.api.getTowerPgWorkspaceScopes(this.context.workspaceId, this.options({ limit: ARTIFACT_LIST_LIMIT }));
    const rows = Array.isArray(result?.scopes) ? result.scopes : [];
    const scopes = rows.filter(scope => scope?.id && !scope.archived_at && scope.record_state !== 'archived')
      .map(scope => ({ id: scope.id, title: text(scope.name || scope.title) || 'Untitled scope' })).sort(byTitle);
    return { scopes, truncated: rows.length >= ARTIFACT_LIST_LIMIT };
  }

  async channels(scopeId) {
    const result = await this.api.getTowerPgScopeChannels(this.context.workspaceId, scopeId, this.options({ limit: ARTIFACT_LIST_LIMIT }));
    const rows = Array.isArray(result?.channels) ? result.channels : [];
    const channels = rows.filter(channel => channel?.id && (!channel.scope_id || channel.scope_id === scopeId) && !channel.archived_at)
      .map(channel => ({ id: channel.id, title: text(channel.name || channel.title) || 'Channel' })).sort(byTitle);
    return { channels, truncated: rows.length >= ARTIFACT_LIST_LIMIT };
  }

  /**
   * Artefacts of `kind` in the given channels. A channel whose Files cannot
   * be read is reported as unavailable instead of failing the whole list. A
   * channel whose list filled Tower's limit is reported in `truncated`: only
   * its most recently updated Files were returned.
   */
  async files(channels, kind) {
    const unavailable = [], truncated = [];
    const lists = await mapLimited(channels, CHANNEL_CONCURRENCY, async channel => {
      try {
        const result = await this.api.getTowerPgChannelFiles(this.context.workspaceId, channel.id, this.options({ limit: ARTIFACT_LIST_LIMIT }));
        const rows = Array.isArray(result?.files) ? result.files : [];
        if (rows.length >= ARTIFACT_LIST_LIMIT) truncated.push({ id: channel.id, title: channel.title });
        return rows.filter(file => artifactKind(file) === kind && (!file.channel_id || file.channel_id === channel.id))
          .map(file => ({ id: file.id, kind, title: artifactTitle(file, kind), channelId: channel.id, channelTitle: channel.title, currentVersionId: text(file.current_version_id), updatedAt: text(file.updated_at) }));
      } catch (error) {
        unavailable.push({ id: channel.id, title: channel.title, status: error?.status || null });
        return [];
      }
    });
    return { files: lists.flat().sort(byTitle), unavailable, truncated };
  }

  /** Newest-first version metadata, up to Tower's list limit. */
  async versions(fileId, signal) {
    const result = await this.api.getTowerPgFileVersions(this.context.workspaceId, fileId, this.options({ signal, limit: ARTIFACT_LIST_LIMIT }));
    const rows = Array.isArray(result?.versions) ? result.versions : [];
    return { rows: rows.filter(row => row?.file_id === fileId), full: rows.length >= ARTIFACT_LIST_LIMIT };
  }

  async version(fileId, versionId, signal) {
    return (await this.versions(fileId, signal)).rows.find(row => row.id === versionId) || null;
  }

  /**
   * Content for the sandboxed preview of one selected HTML File, in the same
   * shape as a ready HTML naplet. Bytes come from the signed File-version
   * route and must match the version digest. Each manifest image is checked
   * the way Tower checks it for a naplet: readable, same digest, allowed type
   * and within the size limits; anything else is `unavailable`.
   */
  async preview(file, { signal } = {}) {
    if (file?.kind !== 'html' || !file.currentVersionId) throw Object.assign(new Error('This artefact has no published version.'), { status: 404 });
    const version = await this.version(file.id, file.currentVersionId, signal);
    const type = text(version?.content_type).toLowerCase();
    if (!version || !HTML_TYPES.includes(type) || !(Number(version.size_bytes) <= ARTIFACT_PREVIEW_MAX_HTML_BYTES)) {
      throw Object.assign(new Error('This File cannot be previewed as an HTML artefact.'), { status: 415 });
    }
    const { bytes } = await this.api.getTowerPgFileVersionObjectBytes(this.context.workspaceId, file.id, version.id, this.options({ signal }));
    const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (bytes.byteLength > ARTIFACT_PREVIEW_MAX_HTML_BYTES || digest !== text(version.sha256_hex).toLowerCase()) throw new Error('Artefact bytes did not match their version.');
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { html, version_id: version.id, version_number: Number(version.version_number) || null, digest, assets: await this.assets(parseArtifactManifest(html), signal) };
  }

  async assets(entries, signal) {
    const versions = new Map();
    for (const fileId of new Set(entries.map(entry => entry.file_id))) {
      versions.set(fileId, this.versions(fileId, signal).catch(() => ({ rows: [], full: false })));
    }
    let total = 0;
    const assets = [];
    for (const entry of entries) {
      const list = await versions.get(entry.file_id);
      let version = list.rows.find(row => row.id === entry.version_id);
      // An older image version beyond the newest-200 metadata page: describe
      // it from its exact, access-checked version object instead.
      if (!version && list.full) version = await this.exactVersion(entry, signal);
      const type = text(version?.content_type).toLowerCase(), size = Number(version?.size_bytes);
      if (!version || text(version.sha256_hex).toLowerCase() !== entry.sha256 || !CANVAS_HTML_ASSET_TYPES.includes(type)
        || !Number.isSafeInteger(size) || size < 1 || size > CANVAS_HTML_ASSET_LIMITS.assetBytes || total + size > CANVAS_HTML_ASSET_LIMITS.totalBytes) {
        assets.push({ name: entry.name, status: 'unavailable' });
        continue;
      }
      total += size;
      assets.push({ name: entry.name, status: 'ready', file_id: entry.file_id, version_id: entry.version_id, sha256: entry.sha256, size_bytes: size, content_type: type });
    }
    return assets;
  }

  /**
   * Version metadata for one manifest image read from the exact File-version
   * object route (the same `file.read` check as the naplet). Bytes are only
   * measured and hashed here; the preview asset store fetches them again.
   */
  async exactVersion(entry, signal) {
    try {
      const { bytes, contentType } = await this.api.getTowerPgFileVersionObjectBytes(this.context.workspaceId, entry.file_id, entry.version_id, this.options({ signal }));
      if (bytes.byteLength > CANVAS_HTML_ASSET_LIMITS.assetBytes) return null;
      return { id: entry.version_id, file_id: entry.file_id, content_type: contentType, size_bytes: bytes.byteLength, sha256_hex: hex(await crypto.subtle.digest('SHA-256', bytes)) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }
}

const emptyPreview = () => ({ fileId: '', status: 'idle', content: null, error: '' });
const emptyPicker = () => ({
  kind: '', scopes: [], scopeId: '', channels: [], channelId: '', files: [], unavailable: [],
  // Tower list pages that came back full: older rows exist that were not listed.
  limits: { scopes: false, channels: false, files: [] },
  status: 'idle', error: '', query: '', shown: ARTIFACT_LIST_PAGE, preview: emptyPreview(),
});

/**
 * Canvas page state for choosing an existing HTML artefact or board: scope
 * first, then all channels in it or one of them, then a named File with a
 * sandboxed preview. Previews use their own memory-only asset store, cleared
 * whenever the selection changes or the picker closes.
 */
export function canvasArtifactPickerStore({ createCatalog = context => new ArtifactCatalog(context), createAssetStore = context => new CanvasHtmlAssetStore(context) } = {}) {
  let catalog = null, previewAssets = null, sequence = 0, previewSequence = 0, previewAbort = null;
  const current = token => token === sequence;
  return {
    artifactPicker: emptyPicker(),

    // Methods, not getters: the page store spreads this mixin.
    artifactMatches() {
      const query = text(this.artifactPicker.query).toLowerCase();
      return this.artifactPicker.files.filter(file => !query || file.title.toLowerCase().includes(query));
    },
    artifactFileList() { return this.artifactMatches().slice(0, this.artifactPicker.shown); },
    artifactHiddenCount() { return Math.max(0, this.artifactMatches().length - this.artifactPicker.shown); },
    showMoreArtifacts() { this.artifactPicker = { ...this.artifactPicker, shown: this.artifactPicker.shown + ARTIFACT_LIST_PAGE }; },
    selectedArtifact() { return this.artifactPicker.files.find(file => file.id === this.addDialog?.sourceId) || null; },
    previewAssetStore() { return previewAssets; },

    async openArtifactPicker(kind) {
      this.resetArtifactPicker();
      catalog = createCatalog(this.context());
      const token = sequence;
      this.artifactPicker = { ...emptyPicker(), kind, status: 'loading-scopes' };
      try {
        const { scopes, truncated } = await catalog.scopes();
        if (!current(token)) return;
        this.artifactPicker = { ...this.artifactPicker, scopes, limits: { ...this.artifactPicker.limits, scopes: truncated }, status: scopes.length ? 'choose-scope' : 'empty' };
      } catch {
        if (current(token)) this.artifactPicker = { ...this.artifactPicker, status: 'error', error: 'Scopes could not be loaded. Close this picker and try again.' };
      }
    },

    async chooseArtifactScope(scopeId) {
      const token = this.bumpArtifactPicker();
      this.artifactPicker = {
        ...this.artifactPicker, scopeId, channelId: '', channels: [], files: [], unavailable: [], error: '', shown: ARTIFACT_LIST_PAGE,
        limits: { ...this.artifactPicker.limits, channels: false, files: [] }, status: scopeId ? 'loading-channels' : 'choose-scope',
      };
      if (!scopeId) return;
      try {
        const { channels, truncated } = await catalog.channels(scopeId);
        if (!current(token)) return;
        this.artifactPicker = { ...this.artifactPicker, channels, limits: { ...this.artifactPicker.limits, channels: truncated } };
        await this.loadArtifactFiles(token);
      } catch {
        if (current(token)) this.artifactPicker = { ...this.artifactPicker, status: 'error', error: 'Channels in this scope could not be loaded.' };
      }
    },

    async chooseArtifactChannel(channelId) {
      const token = this.bumpArtifactPicker();
      const known = this.artifactPicker.channels.some(channel => channel.id === channelId);
      this.artifactPicker = { ...this.artifactPicker, channelId: known ? channelId : '', files: [], unavailable: [], error: '', shown: ARTIFACT_LIST_PAGE, limits: { ...this.artifactPicker.limits, files: [] } };
      await this.loadArtifactFiles(token);
    },

    async loadArtifactFiles(token) {
      const { channels, channelId, kind } = this.artifactPicker;
      const targets = channelId ? channels.filter(channel => channel.id === channelId) : channels;
      if (!targets.length) { this.artifactPicker = { ...this.artifactPicker, status: 'empty' }; return; }
      this.artifactPicker = { ...this.artifactPicker, status: 'loading-files' };
      const { files, unavailable, truncated } = await catalog.files(targets, kind);
      if (!current(token)) return;
      const failed = unavailable.length === targets.length;
      this.artifactPicker = {
        ...this.artifactPicker, files, unavailable, limits: { ...this.artifactPicker.limits, files: truncated },
        status: failed ? 'error' : (files.length ? 'ready' : 'empty'),
        error: failed ? (channelId ? 'Files in this channel are unavailable to you.' : 'Files in this scope are unavailable to you.') : '',
      };
    },

    /** Changing scope or channel drops the selection and any preview bytes. */
    bumpArtifactPicker() {
      sequence += 1;
      this.clearArtifactPreview();
      if (this.addDialog && ['html', 'excalidraw'].includes(this.addDialog.type)) { this.addDialog.sourceId = ''; this.addDialog.title = ''; }
      return sequence;
    },

    async selectArtifact(file) {
      if (!this.artifactPicker.files.some(row => row.id === file?.id)) return;
      this.clearArtifactPreview();
      this.addDialog.sourceId = file.id; this.addDialog.title = file.title;
      if (file.kind !== 'html') return;
      const token = ++previewSequence;
      previewAbort = new AbortController();
      const signal = previewAbort.signal;
      this.artifactPicker = { ...this.artifactPicker, preview: { fileId: file.id, status: 'loading', content: null, error: '' } };
      try {
        const content = await catalog.preview(file, { signal });
        if (token !== previewSequence || signal.aborted) return;
        previewAssets = createAssetStore(this.context());
        previewAssets.retain(content.assets);
        this.artifactPicker = { ...this.artifactPicker, preview: { fileId: file.id, status: 'ready', content, error: '' } };
      } catch (error) {
        if (token !== previewSequence || signal.aborted) return;
        const message = [403, 404].includes(error?.status) ? 'This artefact is unavailable to you.' : (error?.status === 415 ? error.message : 'Preview could not be loaded.');
        this.artifactPicker = { ...this.artifactPicker, preview: { fileId: file.id, status: 'error', content: null, error: message } };
      }
    },

    clearArtifactPreview() {
      previewSequence += 1;
      previewAbort?.abort(); previewAbort = null;
      previewAssets?.clear(); previewAssets = null;
      if (this.artifactPicker) this.artifactPicker = { ...this.artifactPicker, preview: emptyPreview() };
    },

    /** Follows the add dialog: HTML artefacts and "link existing board" use this picker. */
    syncArtifactPicker(type, boardMode) {
      const kind = type === 'html' ? 'html' : (type === 'excalidraw' && boardMode === 'link' ? 'excalidraw' : '');
      if (kind === this.artifactPicker.kind) return;
      if (kind) void this.openArtifactPicker(kind); else this.resetArtifactPicker();
    },

    artifactStatusText() {
      const picker = this.artifactPicker, noun = picker.kind === 'excalidraw' ? 'boards' : 'HTML artefacts';
      const where = picker.channelId ? 'this channel' : 'this scope';
      if (picker.status === 'loading-scopes') return 'Loading scopes…';
      if (picker.status === 'choose-scope') return `Choose a scope to see its ${noun}.`;
      if (['loading-channels', 'loading-files'].includes(picker.status)) return `Loading ${noun}…`;
      if (picker.status === 'error') return picker.error;
      if (picker.status === 'empty') {
        if (!picker.scopes.length) return 'No scopes are available to you.';
        if (!picker.channels.length) return 'This scope has no channels you can open.';
      }
      const skipped = picker.unavailable.length ? ` ${picker.unavailable.length} channel${picker.unavailable.length === 1 ? '' : 's'} unavailable.` : '';
      if (!picker.files.length) return `No ${noun} in ${where}.${skipped}`;
      const shown = this.artifactFileList().length;
      return `${shown} of ${picker.files.length} ${noun} in ${where}.${skipped}`;
    },

    /** Plain warning when Tower's 200-row list limit may have hidden older rows. */
    artifactLimitText() {
      const { limits } = this.artifactPicker, notes = [];
      if (limits.scopes) notes.push('Only the first 200 scopes are listed.');
      if (limits.channels) notes.push('Only the first 200 channels in this scope are listed.');
      if (limits.files.length) {
        const where = limits.files.length === 1 ? limits.files[0].title : `${limits.files.length} channels`;
        notes.push(`Only the 200 most recently updated Files in ${where} are listed; older artefacts there are not shown.`);
      }
      return notes.join(' ');
    },

    artifactPreviewText() {
      const { preview } = this.artifactPicker;
      if (preview.status === 'loading') return 'Loading preview…';
      if (preview.status === 'error') return preview.error;
      if (preview.status === 'ready') {
        const selected = this.selectedArtifact();
        return `${selected?.title || 'Preview'}${preview.content?.version_number ? ` · v${preview.content.version_number}` : ''} · adds as latest`;
      }
      return this.artifactPicker.kind === 'html' ? 'Select an artefact to preview it.' : '';
    },

    /** The add command accepts only a File the current scope/channel listing returned. */
    artifactSelectionValid() {
      return !this.artifactPicker.kind || !!this.selectedArtifact();
    },

    resetArtifactPicker() {
      sequence += 1;
      this.clearArtifactPreview();
      // Drop only a selection this picker made; other naplet sources are untouched.
      if (this.addDialog && this.selectedArtifact()) { this.addDialog.sourceId = ''; this.addDialog.title = ''; }
      catalog = null;
      this.artifactPicker = emptyPicker();
    },
  };
}
