import { applyCommentOperation, boardComments, followCommentAnchors, mergeBoardComments, withBoardComments } from './board-comments.js';
import { boardSceneFingerprint, rebaseBoardScene, restoreBoardScene } from './board-scene.js';
import { BoardStaleError } from './board-sync.js';

const text = value => String(value ?? '').trim();
const sessionId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const FLUSH_TIMEOUT_MS = 3000;

/** An attached editor did not confirm its pending changes; Save must not publish. */
export class BoardFlushError extends Error {
  constructor(message = 'An open board editor did not confirm its latest changes. Your draft is kept; try Save again.') {
    super(message);
    this.name = 'BoardFlushError';
  }
}

function unavailable(error) {
  return [401, 403, 404].includes(Number(error?.status));
}

/**
 * One controller per board File on a Canvas page. Every naplet that references
 * the board, inline or full screen, shares its working draft. The draft is the
 * local Dexie row; editors only send changes to the controller, never to Tower.
 * Only `save()` publishes, and only against the version the draft started from.
 */
export class BoardController {
  constructor(runtime, fileId, { onState, writerId = sessionId(), confirmDiscard = () => true, flushTimeoutMs = FLUSH_TIMEOUT_MS } = {}) {
    this.runtime = runtime;
    this.flushTimeoutMs = flushTimeoutMs;
    this.fileId = fileId;
    this.onState = onState;
    this.writerId = writerId;
    this.confirmDiscard = confirmDiscard;
    this.sessions = new Map();
    this.meta = null;
    this.base = null; // { version_id, version_number, scene, fingerprint }
    this.working = null;
    this.viewing = null; // { version_id, version_number, scene }
    this.loadKey = '';
    this.draftSubscription = null;
    this.generation = 0;
    this.state = {
      file_id: fileId, status: 'loading', save_state: 'saved', dirty: false, error: '', notice: '',
      can_write: false, base_version_id: '', base_version_number: null, latest_version_id: '', latest_version_number: null,
      newer_available: false, viewing_version_id: '', viewing_version_number: null, versions: [], versions_loading: false, conflicts: 0,
    };
  }

  emit(patch = {}) {
    Object.assign(this.state, patch);
    this.state.newer_available = Boolean(this.state.dirty && this.state.latest_version_id && this.state.base_version_id && this.state.latest_version_id !== this.state.base_version_id);
    this.onState?.(this.fileId, { ...this.state });
  }

  /** Snapshot metadata for the board (Tower-authorized `access: ready` content). */
  async sync(meta) {
    const previous = this.meta;
    this.meta = { ...meta };
    this.emit({ can_write: meta.can_write === true, latest_version_id: meta.current_version_id, latest_version_number: meta.current_version_number });
    if (!this.draftSubscription) this.observeDraft();
    if (!this.base) return this.initialLoad();
    if (previous?.can_write !== meta.can_write) this.broadcastLoad();
    if (previous?.current_version_id !== meta.current_version_id && !this.state.dirty && meta.current_version_id !== this.base.version_id) {
      return this.loadLatest({ force: true, head: { id: meta.current_version_id, number: meta.current_version_number, sha256: meta.sha256 } });
    }
    return undefined;
  }

  observeDraft() {
    this.draftSubscription = this.runtime.observeDraft(this.fileId, {
      next: row => this.applyDraftRow(row),
      error: error => this.emit({ error: error?.message || 'Local board draft could not be read.' }),
    });
  }

  async initialLoad() {
    const generation = ++this.generation;
    try {
      const draft = await this.runtime.getDraft(this.fileId);
      const baseVersionId = draft?.base_version_id || this.meta.current_version_id;
      const baseVersionNumber = draft?.base_version_id ? draft.base_version_number : this.meta.current_version_number;
      const loaded = await this.runtime.readVersion(this.fileId, baseVersionId, { sha256: baseVersionId === this.meta.current_version_id ? this.meta.sha256 : '' });
      if (generation !== this.generation) return;
      this.base = { version_id: baseVersionId, version_number: baseVersionNumber, scene: loaded.scene, fingerprint: loaded.fingerprint };
      const dirty = Boolean(draft?.scene) && draft.fingerprint !== loaded.fingerprint;
      this.working = dirty ? draft.scene : loaded.scene;
      this.lastDraftFingerprint = dirty ? draft.fingerprint : '';
      this.loadKey = `${baseVersionId}:${sessionId()}`;
      this.emit({
        status: 'ready', dirty, save_state: dirty ? 'unsaved' : 'saved', error: '',
        notice: dirty ? 'Unsaved draft restored from this browser.' : '',
        base_version_id: baseVersionId, base_version_number: baseVersionNumber,
      });
      this.broadcastLoad();
    } catch (error) {
      if (generation !== this.generation) return;
      await this.fail(error);
    }
  }

  async fail(error) {
    if (unavailable(error)) {
      await this.runtime.purge(this.fileId);
      this.base = null; this.working = null;
      this.emit({ status: 'denied', dirty: false, save_state: 'saved', error: 'Ask your workspace owner for access.' });
      for (const session of this.sessions.values()) session.send({ type: 'clear' });
      return;
    }
    this.emit({ status: this.base ? 'ready' : 'error', error: error?.message || 'Board could not be loaded.' });
  }

  editorContent() {
    if (this.viewing) return { scene: this.viewing.scene, readOnly: true, key: `history:${this.viewing.version_id}` };
    return { scene: this.working, readOnly: !this.state.can_write || Boolean(this.draftConflict), key: this.loadKey };
  }

  broadcastLoad() {
    for (const session of this.sessions.values()) this.sendLoad(session);
  }

  sendLoad(session) {
    if (!this.working && !this.viewing) return;
    const content = this.editorContent();
    session.lastFingerprint = boardSceneFingerprint(content.scene);
    session.send({ type: 'load', ...content });
  }

  /** An editor surface (an iframe port) joins the shared draft. */
  attach(napletId, send) {
    const session = { id: `${this.writerId}:${napletId}`, napletId, send, lastFingerprint: '' };
    this.sessions.set(napletId, session);
    if (this.state.status === 'ready') this.sendLoad(session);
    return session;
  }

  detach(napletId) {
    const session = this.sessions.get(napletId);
    this.sessions.delete(napletId);
    // A closing editor can no longer confirm pending changes: fail its flushes.
    for (const fail of session?.flushes?.values() || []) fail.reject(new BoardFlushError('A board editor closed before confirming its latest changes. Your draft is kept; try Save again.'));
    session?.flushes?.clear();
  }

  /** Change from one editor: persist the local draft and mirror it to sibling editors. */
  editorChanged(napletId, scene) {
    this.changeChain = (this.changeChain || Promise.resolve()).then(() => this.applyEditorChange(napletId, scene)).catch(error => this.emit({ error: error?.message || 'Local draft could not be stored.' }));
    return this.changeChain;
  }

  async applyEditorChange(napletId, scene) {
    const session = this.sessions.get(napletId);
    if (!session || this.draftConflict || this.viewing || !this.base || !this.state.can_write) return;
    scene = withBoardComments(scene, followCommentAnchors(boardComments(this.working), scene.elements || []));
    const fingerprint = boardSceneFingerprint(scene);
    session.lastFingerprint = fingerprint;
    if (fingerprint === boardSceneFingerprint(this.working)) return;
    this.working = { ...scene, files: { ...(this.working?.files || {}), ...(scene.files || {}) } };
    for (const other of this.sessions.values()) {
      if (other !== session && other.lastFingerprint !== fingerprint) { other.lastFingerprint = fingerprint; other.send({ type: 'patch', scene: this.working }); }
    }
    const dirty = fingerprint !== this.base.fingerprint;
    this.emit({ dirty, save_state: dirty ? 'unsaved' : 'saved', error: '', notice: '' });
    this.lastDraftFingerprint = dirty ? fingerprint : '';
    if (dirty) await this.persistDraft(session.id);
    else await this.runtime.deleteDraft(this.fileId);
  }

  commentOperation(napletId, operation) {
    this.changeChain = (this.changeChain || Promise.resolve()).then(async () => {
      if (this.draftConflict || !this.sessions.has(napletId) || this.viewing || !this.base || !this.state.can_write) return;
      this.working = applyCommentOperation(this.working, operation, this.runtime.context.viewer);
      this.lastDraftFingerprint = boardSceneFingerprint(this.working);
      await this.persistDraft();
      this.emit({ dirty: true, save_state: 'unsaved', error: '' });
      for (const session of this.sessions.values()) session.send({ type: 'comments', comments: boardComments(this.working) });
    }).catch(error => this.emit({ error: error.message }));
    return this.changeChain;
  }

  persistDraft(writer = this.writerId) {
    return this.runtime.putDraft(this.fileId, {
      base_version_id: this.base.version_id, base_version_number: this.base.version_number,
      base_fingerprint: this.base.fingerprint, scene: this.working, writer,
    });
  }

  /** Another tab (or a restored draft) changed the shared Dexie row. */
  applyDraftRow(row) {
    if (!this.base || this.viewing) return;
    if (!row) return;
    if (row.fingerprint === this.lastDraftFingerprint || row.base_version_id !== this.base.version_id) return;
    // Rows this page wrote were already applied; only other tabs patch editors.
    if (String(row.writer).startsWith(this.writerId)) return;
    this.lastDraftFingerprint = row.fingerprint;
    const discussion = mergeBoardComments(this.base.scene, this.working, row.scene);
    if (discussion.conflicts.length) {
      this.draftConflict = true;
      this.emit({ conflicts: discussion.conflicts.length, dirty: true, save_state: 'error', error: 'Another tab has conflicting comment data. Your draft is kept read-only. Discard unsaved changes to load the saved board before editing again.' });
      this.broadcastLoad();
      return;
    }
    this.working = withBoardComments(row.scene, discussion.comments);
    const mergedFingerprint = boardSceneFingerprint(this.working);
    if (mergedFingerprint !== row.fingerprint) {
      this.lastDraftFingerprint = mergedFingerprint;
      void this.persistDraft().catch(error => this.emit({ error: error.message }));
    }
    for (const session of this.sessions.values()) { session.lastFingerprint = row.fingerprint; session.send({ type: 'patch', scene: this.working }); }
    this.emit({ dirty: true, save_state: 'unsaved' });
  }

  /**
   * Ask every editor to send its debounced change now, then wait for it to be
   * applied. Rejects with BoardFlushError when an editor does not acknowledge
   * in time or detaches first; the caller must then not publish.
   */
  async flushEditors(timeoutMs = this.flushTimeoutMs) {
    const waits = [...this.sessions.values()].map(session => new Promise((resolve, reject) => {
      const token = sessionId();
      session.flushes ||= new Map();
      const timer = setTimeout(() => { session.flushes.delete(token); reject(new BoardFlushError()); }, timeoutMs);
      session.flushes.set(token, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      session.send({ type: 'flush', token });
    }));
    await Promise.all(waits);
    await this.changeChain;
  }

  editorFlushed(napletId, token) {
    const session = this.sessions.get(napletId);
    const waiter = session?.flushes?.get(token);
    if (waiter) { session.flushes.delete(token); waiter.resolve(); }
  }

  async save(options = {}) {
    if (this.saveInFlight) return false;
    this.saveInFlight = true;
    try { return await this.saveNow(options); } finally { this.saveInFlight = false; }
  }

  async saveNow({ summary = '' } = {}) {
    if (this.draftConflict || !this.base || this.state.save_state === 'saving') return false;
    try { await this.flushEditors(); } catch (error) {
      // Unconfirmed editor changes: publish nothing and keep the draft.
      this.emit({ save_state: 'error', error: error?.message || new BoardFlushError().message, notice: '' });
      return false;
    }
    if (this.viewing) { this.emit({ error: 'Return to the latest version before saving.' }); return false; }
    if (!this.state.can_write) { this.emit({ error: 'You can view this board but not save it.' }); return false; }
    if (!this.state.dirty) { this.emit({ notice: 'No unsaved changes.' }); return false; }
    const scene = this.working, fingerprint = boardSceneFingerprint(scene);
    this.emit({ save_state: 'saving', error: '', notice: '' });
    try {
      const { version } = await this.runtime.saveVersion({ fileId: this.fileId, baseVersionId: this.base.version_id, scene, summary, title: this.meta?.title });
      this.base = { version_id: version.id, version_number: version.version_number, scene, fingerprint };
      const stillDirty = boardSceneFingerprint(this.working) !== fingerprint;
      if (stillDirty) await this.persistDraft(); else { this.lastDraftFingerprint = ''; await this.runtime.deleteDraft(this.fileId); }
      this.emit({
        dirty: stillDirty, save_state: stillDirty ? 'unsaved' : 'saved', conflicts: 0,
        base_version_id: version.id, base_version_number: version.version_number,
        latest_version_id: version.id, latest_version_number: version.version_number,
        notice: `Saved version ${version.version_number}.`, versions: [],
      });
      return true;
    } catch (error) {
      if (error instanceof BoardStaleError) {
        const current = error.currentVersion;
        this.emit({ save_state: 'stale', error: error.message, ...(current ? { latest_version_id: current.id, latest_version_number: current.version_number } : {}) });
        return false;
      }
      if (unavailable(error)) { await this.fail(error); return false; }
      this.emit({ save_state: 'error', error: error?.message || 'Board could not be saved. Your draft is kept.' });
      return false;
    }
  }

  /** Rebase the draft onto the newest saved version; the result stays unsaved for review. */
  async mergeLatest() {
    if (!this.base) return;
    try {
      await this.fetchHead();
      const latest = await this.runtime.readVersion(this.fileId, this.state.latest_version_id);
      const { scene, conflicts } = rebaseBoardScene({ base: this.base.scene, draft: this.working, latest: latest.scene });
      this.base = { version_id: latest.version_id, version_number: this.state.latest_version_number, scene: latest.scene, fingerprint: latest.fingerprint };
      this.working = scene;
      const dirty = boardSceneFingerprint(scene) !== latest.fingerprint;
      this.loadKey = `${latest.version_id}:${sessionId()}`;
      this.lastDraftFingerprint = dirty ? boardSceneFingerprint(scene) : '';
      if (dirty) await this.persistDraft(); else await this.runtime.deleteDraft(this.fileId);
      this.emit({
        dirty, save_state: dirty ? 'unsaved' : 'saved', error: '', conflicts: conflicts.length,
        base_version_id: latest.version_id, base_version_number: this.state.latest_version_number,
        notice: conflicts.length ? `Merged with version ${this.state.latest_version_number}; ${conflicts.length} element${conflicts.length === 1 ? '' : 's'} kept your edit. Review, then save.` : `Merged with version ${this.state.latest_version_number}. Review, then save.`,
      });
      this.broadcastLoad();
    } catch (error) { await this.fail(error); }
  }

  /** Load the newest saved version. Dirty drafts are discarded only after confirmation. */
  /** Tower's current head, read now (canvas snapshot metadata may be older). */
  async fetchHead() {
    const { current_version_id: id, versions } = await this.runtime.listVersions(this.fileId);
    const row = versions.find(version => version.id === id);
    if (!id || !row) throw new Error('This board has no current version.');
    this.emit({ versions, latest_version_id: id, latest_version_number: row.version_number });
    return { id, number: row.version_number, sha256: row.sha256 };
  }

  /**
   * Load the newest saved version. Explicit refreshes ask Tower for the head;
   * snapshot sync passes the already-authorized head. Dirty drafts are
   * discarded only after confirmation.
   */
  async loadLatest({ force = false, head = null } = {}) {
    if (this.state.dirty && !force && !this.confirmDiscard('Discard your unsaved board changes and load the latest saved version?')) return false;
    try {
      const target = head || await this.fetchHead();
      const versionId = target.id, number = target.number;
      const latest = await this.runtime.readVersion(this.fileId, versionId, { sha256: target.sha256 || '' });
      this.base = { version_id: versionId, version_number: number, scene: latest.scene, fingerprint: latest.fingerprint };
      this.draftConflict = false;
      this.working = latest.scene; this.viewing = null; this.lastDraftFingerprint = '';
      await this.runtime.deleteDraft(this.fileId);
      this.loadKey = `${versionId}:${sessionId()}`;
      this.emit({ dirty: false, save_state: 'saved', error: '', notice: '', conflicts: 0, base_version_id: versionId, base_version_number: number, latest_version_id: versionId, latest_version_number: number, viewing_version_id: '', viewing_version_number: null });
      this.broadcastLoad();
      return true;
    } catch (error) { await this.fail(error); return false; }
  }

  async loadVersions() {
    if (this.state.versions_loading) return this.state.versions;
    this.emit({ versions_loading: true });
    try {
      const { current_version_id: current, versions } = await this.runtime.listVersions(this.fileId);
      const head = versions.find(version => version.id === current);
      this.emit({ versions, versions_loading: false, ...(head ? { latest_version_id: head.id, latest_version_number: head.version_number } : {}) });
      return versions;
    } catch (error) {
      this.emit({ versions_loading: false });
      await this.fail(error);
      return [];
    }
  }

  /** Viewer-local, read-only history browsing. The draft stays untouched. */
  async viewVersion(versionId) {
    if (!versionId) return;
    if (versionId === this.base?.version_id && !this.state.dirty) return this.returnToLatest();
    try {
      const entry = await this.runtime.readVersion(this.fileId, versionId);
      const version = this.state.versions.find(row => row.id === versionId);
      this.viewing = { version_id: versionId, version_number: version?.version_number || null, scene: entry.scene };
      this.emit({ viewing_version_id: versionId, viewing_version_number: this.viewing.version_number, error: '' });
      this.broadcastLoad();
    } catch (error) { await this.fail(error); }
  }

  async stepVersion(delta) {
    const versions = this.state.versions.length ? this.state.versions : await this.loadVersions();
    const current = this.viewing?.version_id || this.base?.version_id;
    const index = versions.findIndex(row => row.id === current);
    // Newest first: "older" (-1) moves to a higher index.
    const target = index < 0 ? null : versions[index - delta];
    if (!target) return;
    if (target.id === this.base?.version_id) return this.returnToLatest();
    return this.viewVersion(target.id);
  }

  /**
   * Leave history. With unsaved changes this returns to the draft (still based
   * on its original version); without, it loads Tower's newest version.
   */
  async returnToLatest() {
    this.viewing = null;
    this.emit({ viewing_version_id: '', viewing_version_number: null });
    if (!this.state.dirty && this.state.latest_version_id && this.state.latest_version_id !== this.base?.version_id) return this.loadLatest({ force: true });
    this.broadcastLoad();
    return true;
  }

  /** Start a draft from an older version, on top of the current base. */
  async restoreViewedVersion() {
    if (!this.viewing || !this.base || !this.state.can_write) return;
    if (this.state.dirty && !this.confirmDiscard('Replace your unsaved board changes with this older version?')) return;
    this.working = restoreBoardScene({ target: this.viewing.scene, latest: this.base.scene });
    this.viewing = null;
    this.loadKey = `${this.base.version_id}:${sessionId()}`;
    this.lastDraftFingerprint = boardSceneFingerprint(this.working);
    await this.persistDraft();
    this.emit({ dirty: true, save_state: 'unsaved', viewing_version_id: '', viewing_version_number: null, notice: 'Older version restored as an unsaved draft. Save to make it the latest version.' });
    this.broadcastLoad();
  }

  async discardDraft() {
    return this.loadLatest();
  }

  stop() {
    this.generation += 1;
    this.draftSubscription?.unsubscribe();
    this.draftSubscription = null;
    this.sessions.clear();
  }
}
