import { BoardController } from './board-controller.js';
import { CanvasBoardRuntime } from './board-sync.js';
import { BOARD_LIMITS, isBoardFileRow } from './board-scene.js';

const text = value => String(value ?? '').trim();

/**
 * Canvas page state for Excalidraw board naplets. All board network work goes
 * through CanvasBoardRuntime (the board sync boundary) via one BoardController
 * per board File; this mixin only renders controller state and routes actions.
 */
export function canvasBoardStore() {
  let runtime = null;
  const controllers = new Map();
  const napletBoards = new Map();
  let beforeUnload = null;
  return {
    boards: {},
    boardCreate: { title: '', channelId: '', mode: 'create' },
    boardChannels: [],
    boardSave: { fileId: '', summary: '' },
    boardRename: { fileId: '', title: '', saving: false, error: '' },
    boardCreating: false,

    startBoards(context, { confirm = message => window.confirm(message) } = {}) {
      runtime = new CanvasBoardRuntime(context);
      this.boardConfirm = confirm;
      beforeUnload = event => {
        if (!Object.values(this.boards).some(state => state.dirty)) return;
        // Drafts persist locally, but leaving still deserves the browser warning.
        event.preventDefault();
        event.returnValue = '';
      };
      globalThis.addEventListener?.('beforeunload', beforeUnload);
    },
    stopBoards() {
      for (const controller of controllers.values()) controller.stop();
      controllers.clear(); napletBoards.clear();
      runtime?.stop();
      if (beforeUnload) globalThis.removeEventListener?.('beforeunload', beforeUnload);
      beforeUnload = null;
    },
    boardController(fileId) {
      const id = text(fileId);
      if (!id || !runtime) return null;
      if (!controllers.has(id)) {
        controllers.set(id, new BoardController(runtime, id, {
          onState: (key, state) => { this.boards = { ...this.boards, [key]: state }; },
          confirmDiscard: message => this.boardConfirm(message),
        }));
      }
      return controllers.get(id);
    },
    /** Called with every authorized snapshot. Tower is the authority for board metadata. */
    syncBoards(naplets) {
      if (!runtime) return;
      const seen = new Set();
      for (const naplet of naplets) {
        const previousFile = napletBoards.get(naplet.id);
        if (naplet.access === 'denied' && previousFile) {
          // Access to a board we were showing was revoked: drop its bytes and draft.
          void controllers.get(previousFile)?.fail({ status: 403 });
          napletBoards.delete(naplet.id);
          continue;
        }
        if (naplet.access !== 'ready' || naplet.source?.type !== 'excalidraw') continue;
        const fileId = naplet.source.id;
        napletBoards.set(naplet.id, fileId);
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        void this.boardController(fileId)?.sync({ ...naplet.content, title: naplet.title });
      }
      // Boards no longer on this canvas stop; an unsaved draft stays in Dexie.
      for (const [fileId, controller] of controllers) {
        if (!seen.has(fileId)) { controller.stop(); controllers.delete(fileId); }
      }
    },
    boardState(naplet) { return this.boards[naplet?.source?.id] || { status: 'loading', save_state: 'saved', dirty: false, versions: [] }; },
    boardStatusLabel(naplet) {
      const state = this.boardState(naplet);
      if (state.status === 'loading') return 'Loading…';
      if (state.status === 'denied') return 'No access';
      if (state.status === 'error') return 'Error';
      if (state.viewing_version_id) return 'Read-only';
      return { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Save failed', stale: 'Newer version saved' }[state.save_state] || 'Saved';
    },
    boardVersionLabel(naplet) {
      const state = this.boardState(naplet);
      if (state.viewing_version_id) return `Viewing v${state.viewing_version_number || '?'}`;
      const base = state.base_version_number ? `v${state.base_version_number}` : '';
      if (state.newer_available || state.save_state === 'stale') return `Draft on ${base} · latest v${state.latest_version_number}`;
      return base ? `Latest · ${base}` : '';
    },
    async saveBoard(naplet, summary = '') {
      const controller = this.boardController(naplet?.source?.id);
      if (!controller) return false;
      const saved = await controller.save({ summary: text(summary).slice(0, BOARD_LIMITS.summary) });
      // Re-read the authorized snapshot so every naplet and viewer sees the new latest.
      if (saved) await this.refreshBoardsSnapshot?.();
      return saved;
    },
    openBoardSave(naplet) {
      this.boardSave = { fileId: naplet.source.id, napletId: naplet.id, summary: '' };
      queueMicrotask(() => document.querySelector('.canvas-board-save-dialog')?.showModal());
    },
    async submitBoardSave() {
      const naplet = this.naplets.find(row => row.id === this.boardSave.napletId);
      const dialog = document.querySelector('.canvas-board-save-dialog');
      if (!naplet) { dialog?.close(); return; }
      if (await this.saveBoard(naplet, this.boardSave.summary)) dialog?.close();
    },
    openBoardRename(naplet) {
      if (naplet?.access !== 'ready' || naplet.source?.type !== 'excalidraw' || !this.boardState(naplet).can_write || this.boardRename.saving) return;
      this.boardRename = { fileId: naplet.source.id, title: naplet.title, saving: false, error: '' };
      queueMicrotask(() => {
        const dialog = document.querySelector('.canvas-board-rename-dialog');
        dialog?.showModal();
        dialog?.querySelector('input')?.select();
      });
    },
    async submitBoardRename() {
      const form = this.boardRename;
      if (form.saving) return false;
      form.error = '';
      const name = text(form.title);
      if (!name || name.length > BOARD_LIMITS.title) { form.error = 'Enter a board name of 1–200 characters.'; return false; }
      const naplet = this.naplets.find(row => row.access === 'ready' && row.source?.type === 'excalidraw' && row.source.id === form.fileId);
      if (!naplet || !this.boardState(naplet).can_write || !runtime) { form.error = 'You cannot rename this board.'; return false; }
      form.saving = true;
      try {
        await runtime.renameBoard(form.fileId, name);
        for (const row of this.naplets) if (row.access === 'ready' && row.source?.type === 'excalidraw' && row.source.id === form.fileId) row.title = name;
        const controller = controllers.get(form.fileId);
        if (controller?.meta) controller.meta.title = name;
        // Keep cached File pickers consistent; Tower remains authoritative on reopen.
        await runtime.db.documents.where('record_id').equals(form.fileId).modify({ title: name, file_name: name }).catch(() => undefined);
        this.sourceOptions = this.sourceOptions?.map(row => row.type === 'excalidraw' && row.id === form.fileId ? { ...row, title: name } : row) || [];
        document.querySelector('.canvas-board-rename-dialog')?.close();
        await this.refreshBoardsSnapshot?.();
        return true;
      } catch (error) {
        form.error = error?.status === 403 ? 'You cannot rename this board.' : (error?.message || 'The board could not be renamed.');
        return false;
      } finally { form.saving = false; }
    },
    loadLatestBoard(naplet) { return this.boardController(naplet?.source?.id)?.loadLatest(); },
    mergeLatestBoard(naplet) { return this.boardController(naplet?.source?.id)?.mergeLatest(); },
    loadBoardVersions(naplet) { return this.boardController(naplet?.source?.id)?.loadVersions(); },
    /** Compact title-bar status that replaces the board version strip. */
    boardHeaderStatus(naplet) {
      const state = this.boardState(naplet);
      if (state.status !== 'ready') return state.status === 'loading' ? '' : this.boardStatusLabel(naplet);
      const base = state.base_version_number ? `v${state.base_version_number}` : '';
      if (state.viewing_version_id) return `Viewing v${state.viewing_version_number || '?'} · read-only`;
      if (state.save_state === 'saving') return 'Saving…';
      if (state.save_state === 'error') return 'Save failed';
      if (state.save_state === 'stale' || state.newer_available) return `Unsaved · newer v${state.latest_version_number || '?'} saved`;
      if (state.dirty) return base ? `Unsaved · ${base}` : 'Unsaved changes';
      if (!state.can_write) return base ? `Read-only · ${base}` : 'Read-only';
      return base;
    },
    /**
     * Save, floated over the drawing area. Plain data: it is posted to the
     * editor iframe, which renders it in Excalidraw's top-right slot. History,
     * merge and restore stay in the cog menu; read-only views get no Save.
     */
    boardSaveAction(naplet) {
      const state = this.boardState(naplet);
      if (state.status !== 'ready' || state.viewing_version_id || !state.can_write) return { action: '', label: '', title: '', disabled: true };
      if (state.save_state === 'saving') return { action: 'save', label: 'Saving…', title: 'Saving a new board version', disabled: true };
      if (state.dirty) return { action: 'save', label: 'Save', title: 'Save a new board version', disabled: false };
      return { action: 'save', label: 'Saved', title: 'No unsaved changes', disabled: true };
    },
    /** Runs the floated Save only if the current state still offers it. */
    runBoardAction(naplet, action) {
      const current = this.boardSaveAction(naplet);
      if (action !== 'save' || current.action !== 'save' || current.disabled) return false;
      return this.saveBoard(naplet);
    },
    viewBoardVersion(naplet, versionId) { return this.boardController(naplet?.source?.id)?.viewVersion(versionId); },
    stepBoardVersion(naplet, delta) { return this.boardController(naplet?.source?.id)?.stepVersion(delta); },
    returnBoardToLatest(naplet) { return this.boardController(naplet?.source?.id)?.returnToLatest(); },
    restoreBoardVersion(naplet) { return this.boardController(naplet?.source?.id)?.restoreViewedVersion(); },
    boardVersionAuthor(version) { const npub = text(version?.author_npub); return npub ? `${npub.slice(0, 12)}…` : ''; },
    boardVersionTime(version) { const date = new Date(version?.created_at); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); },
    async loadBoardChoices(db) {
      const [documents, channels] = await Promise.all([db.documents.toArray(), db.channels.toArray()]);
      const active = row => !['deleted', 'archived'].includes(row.record_state);
      this.boardChannels = channels.filter(row => active(row) && row.record_id)
        .map(row => ({ id: row.record_id, title: text(row.title || row.name) || 'Channel' }))
        .sort((a, b) => a.title.localeCompare(b.title));
      if (!this.boardChannels.some(row => row.id === this.boardCreate.channelId)) this.boardCreate.channelId = this.boardChannels[0]?.id || '';
      const choices = new Map();
      for (const row of documents) if (active(row) && isBoardFileRow(row) && row.record_id) choices.set(row.record_id, text(row.title || row.file_name).replace(/\.excalidraw$/i, '') || 'Board');
      // Boards already readable on this canvas can be linked again (one canonical board).
      for (const naplet of this.naplets || []) if (naplet.access === 'ready' && naplet.source?.type === 'excalidraw') choices.set(naplet.source.id, naplet.title);
      return [...choices].map(([id, title]) => ({ type: 'excalidraw', id, title }));
    },
    /** Create a persistent board File, then link this naplet to it immediately. */
    async createBoardNaplet(layout, addNaplet) {
      if (!runtime) return false;
      const title = text(this.boardCreate.title) || 'Untitled board';
      let board;
      try {
        board = await runtime.createBoard({ channelId: this.boardCreate.channelId, title });
      } catch (error) {
        this.error = error?.status === 403 ? 'You cannot create files in that channel.' : (error?.message || 'The board could not be created.');
        return false;
      }
      const linked = await addNaplet({ source: { type: 'excalidraw', id: board.file_id }, title, layout });
      if (!linked && !this.error) this.error = 'The board was saved but could not be added to this canvas.';
      if (!linked) this.error = `${this.error} The board “${title}” was saved; link it with Link existing board.`;
      return linked;
    },
    boardRuntime() { return runtime; },
  };
}
