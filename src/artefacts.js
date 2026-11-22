import { getTowerPgFile, getTowerPgFileVersions, getTowerPgFileVersionObjectBytes, createTowerPgChannelFile, createTowerPgFileVersion, prepareTowerPgStorageObject, uploadStorageObject, completeStorageObject } from './api.js';
import { upsertDocument } from './db.js';
import { mapPgFileToLocalDocument } from './pg-read-hydrator.js';
import { canvasContext, canvasPartition } from './canvas/projection.js';
import { CanvasBoardRuntime } from './canvas/board-sync.js';
import { BoardController } from './canvas/board-controller.js';
import { ArtifactCatalog } from './canvas/artifact-picker.js';
import { CanvasHtmlAssetStore } from './canvas/html-assets.js';
import { buildStoragePrepareBody } from './storage-payloads.js';
import { artefactType, artefactLabel } from './artefact-registry.js';

const sessions = new WeakMap();
let unloadInstalled = false;
let activeStore = null;
const text = value => String(value ?? '').trim();
const empty = () => ({ id: '', title: '', kind: '', status: 'loading', error: '', can_write: false, html: null, source: '', editing: false, dirty: false, base: '', versions: [], viewing: '', board: { versions: [] } });
const htmlDraftKey = session => `artefact-html-draft:${session.partition}:${session.id}`;
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

export const artefactsMixin = {
  artefactTypeFilter: 'all', artefact: empty(), artefactCreating: false,
  artefactType, artefactLabel,
  artefactSession() { return sessions.get(this); },
  toggleArtefactSource() {
    this.artefact.editing = !this.artefact.editing;
    if (!this.artefact.editing && this.artefact.html) {
      this.artefact.html = { ...this.artefact.html, html: this.artefact.source, digest: `draft:${Date.now()}` };
    }
  },
  async persistArtefactHtmlDraft() {
    const session = sessions.get(this);
    if (!session || this.artefact.kind !== 'html' || !this.artefact.dirty || !this.artefact.can_write) return;
    await session.runtime.db.sync_state.put({ key: htmlDraftKey(session), source: this.artefact.source, base: this.artefact.base });
  },
  async revokeArtefact(session) {
    if (!this.artefactCurrent(session)) return;
    this.artefact.dirty = false;
    await session.runtime.db.sync_state.delete(htmlDraftKey(session));
    await this.closeArtefact({ force: true, preserve: false });
    this.error = 'Artefact access is no longer available.';
  },
  async copyArtefactLink() { const url = new URL(location.href); url.searchParams.set('artefactid', this.artefact.id); url.searchParams.set('workspaceid', canvasContext(this).workspaceId); await navigator.clipboard.writeText(url.href); },
  artefactBoardController(id) { const session = sessions.get(this); return session?.id === id ? session.board : null; },
  artefactAssetStore() { return sessions.get(this)?.assets || null; },
  artefactCurrent(session) { return Boolean(session) && sessions.get(this) === session && session.partition === canvasPartition(canvasContext(this)); },
  async openArtefact(row) {
    if (!row || !artefactType(row) || artefactType(row) === 'document') return false;
    if (!await this.closeArtefact()) return false;
    activeStore = this;
    if (!unloadInstalled && typeof addEventListener === 'function') {
      unloadInstalled = true;
      addEventListener('beforeunload', event => { if (activeStore?.artefact?.dirty || activeStore?.artefact?.board?.dirty) { event.preventDefault(); event.returnValue = ''; } });
      addEventListener('pagehide', () => { void activeStore?.closeArtefact({ force: true, preserve: false }); });
    }
    const context = canvasContext(this), id = row.record_id;
    const session = { id, context, partition: canvasPartition(context), runtime: new CanvasBoardRuntime(context), assets: new CanvasHtmlAssetStore(context) };
    sessions.set(this, session);
    this.artefact = { ...empty(), id, kind: artefactType(row), title: row.title || 'Artefact' };
    this.$nextTick(() => document.querySelector('#artefact-dialog')?.showModal());
    try {
      const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
      const [payload, history] = await Promise.all([getTowerPgFile(context.workspaceId, id, options), getTowerPgFileVersions(context.workspaceId, id, options)]);
      if (!this.artefactCurrent(session)) return false;
      const file = payload.file;
      if (file?.id !== id || file.workspace_id !== context.workspaceId) throw new Error('Invalid artefact response.');
      const versions = history.versions || [], latest = versions.find(v => v.id === history.current_version_id);
      if (!latest) throw new Error('This artefact has no readable saved version.');
      this.artefact = { ...this.artefact, title: file.display_name, can_write: file.can_write === true || payload.can_write === true, base: latest.id, versions, status: 'ready' };
      if (this.artefact.kind === 'excalidraw') {
        session.board = new BoardController(session.runtime, id, { confirmDiscard: message => window.confirm(message), onState: (_id, state) => { if (this.artefactCurrent(session)) this.artefact.board = state; } });
        await session.board.loadVersions();
        await session.board.sync({ can_write: this.artefact.can_write, current_version_id: latest.id, current_version_number: latest.version_number, sha256: latest.sha256_hex, title: file.display_name });
      } else {
        await this.loadArtefactHtml(latest.id);
        const draft = await session.runtime.db.sync_state.get(htmlDraftKey(session));
        if (this.artefactCurrent(session) && draft && this.artefact.can_write) {
          Object.assign(this.artefact, { source: draft.source, base: draft.base, dirty: true, editing: true });
        }
      }
      return true;
    } catch (error) { if (this.artefactCurrent(session)) this.artefact.error = error?.message || 'Artefact unavailable.'; return false; }
  },
  async closeArtefact({ force = false, preserve = true } = {}) {
    const session = sessions.get(this);
    if (preserve && session?.board) {
      try { await session.board.flushEditors(); }
      catch (error) { this.artefact.error = error.message; return false; }
    }
    if (!force && (this.artefact.dirty || this.artefact.board?.dirty) && !window.confirm('Close this artefact? Unsaved drafts stay on this device.')) return false;
    if (preserve) await this.persistArtefactHtmlDraft();
    session?.board?.stop(); session?.runtime?.stop(); session?.assets?.clear();
    sessions.delete(this); if (activeStore === this) activeStore = null; this.artefact = empty();
    document.querySelector('#artefact-dialog')?.close();
    return true;
  },
  async loadArtefactHtml(versionId) {
    const session = sessions.get(this);
    if (!session || !this.artefactCurrent(session)) return;
    try {
      const content = await new ArtifactCatalog(session.context).preview({ id: session.id, kind: 'html', currentVersionId: versionId });
      if (!this.artefactCurrent(session)) return;
      session.assets.retain(content.assets);
      this.artefact.html = content; this.artefact.source = content.html; this.artefact.dirty = false;
      this.artefact.viewing = versionId === this.artefact.base ? '' : versionId;
    } catch (error) { if (this.artefactCurrent(session)) { if ([401, 403, 404].includes(error.status)) return this.revokeArtefact(session); this.artefact.html = null; this.artefact.error = error.message; } }
  },
  async artefactBoardAction(action) {
    const session = sessions.get(this);
    if (!session?.board || !this.artefactCurrent(session)) return;
    if (action === 'save' && await session.board.save()) {
      await session.board.loadVersions();
      if (this.artefactCurrent(session)) this.artefact.versions = session.board.state.versions;
    }
    if (action === 'merge') await session.board.mergeLatest();
    if (action === 'latest') await session.board.returnToLatest();
    if (action === 'restore') await session.board.restoreViewedVersion();
  },
  async viewArtefactVersion(id) {
    if (!id) return;
    const session = sessions.get(this);
    if (session?.board) await session.board.viewVersion(id);
    else {
      if (this.artefact.dirty && !window.confirm('Discard unsaved HTML changes to view this version?')) return;
      this.artefact.editing = false; await this.loadArtefactHtml(id);
      await session?.runtime.db.sync_state.delete(htmlDraftKey(session));
    }
  },
  async uploadArtefactHtml(context, source, title) {
    const bytes = new TextEncoder().encode(source);
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('HTML must contain 1 byte to 2 MiB.');
    const options = { baseUrl: context.baseUrl, appNpub: context.appNpub };
    const prepared = await prepareTowerPgStorageObject(context.workspaceId, buildStoragePrepareBody({ ownerNpub: context.viewer, contentType: 'text/html', sizeBytes: bytes.length, fileName: title.endsWith('.html') ? title : `${title}.html` }), options);
    if (prepared.is_public) throw new Error('Private storage required.');
    await uploadStorageObject(prepared, bytes, 'text/html', options);
    await completeStorageObject(prepared.object_id, { size_bytes: bytes.length, sha256_hex: await digest(bytes) }, options);
    return prepared.object_id;
  },
  async saveArtefactHtml() {
    const session = sessions.get(this), draft = { ...this.artefact };
    if (!session || !this.artefactCurrent(session) || !draft.can_write || !draft.dirty || draft.status === 'saving') return;
    this.artefact.status = 'saving'; this.artefact.error = '';
    try {
      const objectId = await this.uploadArtefactHtml(session.context, draft.source, draft.title);
      if (!this.artefactCurrent(session)) return;
      await createTowerPgFileVersion(session.context.workspaceId, session.id, { base_version_id: draft.base, storage_object_id: objectId, client_mutation_id: crypto.randomUUID() }, { baseUrl: session.context.baseUrl, appNpub: session.context.appNpub });
      if (!this.artefactCurrent(session)) return;
      this.artefact.dirty = false;
      await session.runtime.db.sync_state.delete(htmlDraftKey(session));
      await this.openArtefact({ record_id: session.id, title: draft.title, pg_record_type: 'file', content_type: 'text/html' });
    } catch (error) { if (this.artefactCurrent(session)) { if ([401, 403, 404].includes(error.status)) return this.revokeArtefact(session); this.artefact.status = 'ready'; this.artefact.error = error.status === 409 ? 'A newer version was saved. Your source is kept here. Copy it before loading the latest version and reconciling your changes.' : error.message; } }
  },
  async createChannelArtefact(kind) {
    if (this.artefactCreating) return;
    const channelId = this.pgContextSelectedChannelId || this.selectedChannelId;
    if (!channelId) { this.error = 'Choose a channel before creating an artefact.'; return; }
    const title = text(window.prompt(kind === 'excalidraw' ? 'Whiteboard title' : 'Interactive HTML title'));
    if (!title) return;
    this.artefactCreating = true;
    const context = canvasContext(this), runtime = new CanvasBoardRuntime(context);
    try {
      let id;
      if (kind === 'excalidraw') id = (await runtime.createBoard({ channelId, title })).file_id;
      else if (kind === 'html') {
        const source = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;padding:2rem}button{font:inherit}</style></head><body><h1>Explore an idea</h1><p>Edit this source or ask your AI to expand it.</p><button onclick="this.textContent=\'An idea starts here\'">Try it</button></body></html>';
        const objectId = await this.uploadArtefactHtml(context, source, title);
        const payload = await createTowerPgChannelFile(context.workspaceId, channelId, { storage_object_id: objectId, display_name: title, metadata: { html_artifact: true, artefact: { schema_version: 1, type: 'html', format_version: 1, editor_id: 'builtin.html' } } }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        id = payload.file?.id;
      } else throw new Error('Unsupported artefact type.');
      const payload = await getTowerPgFile(context.workspaceId, id, { baseUrl: context.baseUrl, appNpub: context.appNpub });
      if (canvasPartition(canvasContext(this)) !== canvasPartition(context)) return;
      const row = mapPgFileToLocalDocument(payload.file, { workspaceOwnerNpub: this.activeWorkspaceOwnerNpub });
      await upsertDocument(row); await this.openArtefact(row);
    } catch (error) { this.error = error.message || 'Artefact could not be created.'; }
    finally { runtime.stop(); this.artefactCreating = false; }
  },
};
