import { getTowerPgWorkspaceGroups, getTowerPgWorkspaceMembers } from '../api.js';
import { canvasManagerMixin } from './manager.js';
import { assertIdentity, canvasPartition } from './projection.js';
import { createCanvasRecord, hydrateCanvasList } from './sync-service.js';

const text = value => String(value ?? '').trim();

export function attachCanvasLinkCreation(store) {
  // Preserve the manager's reactive getters; object spread would evaluate them.
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(canvasManagerMixin));
  Object.assign(store, {
    pgWorkspaceMembers: [], groups: [], canvasCreateAttempt: null, canvasAttemptLoaded: false, canvasAttemptPersistenceError: false,
    getInitials: label => text(label).split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(),
    canvasAttemptKey() { return `canvas-link-create:${canvasPartition(this.context())}:${this.canvasId}`; },
    rememberCanvasAttempt(attempt) {
      this.canvasCreateAttempt = attempt;
      this.canvasAttemptLoaded = true;
      try {
        if (attempt) sessionStorage.setItem(this.canvasAttemptKey(), JSON.stringify(attempt));
        else sessionStorage.removeItem(this.canvasAttemptKey());
      } catch { this.canvasAttemptPersistenceError = true; }
    },
    openLinkedCanvasCreate() {
      if (!this.canvas?.can_manage || this.saving || this.canvasSaving || this.addDialog.type !== 'canvas') return;
      if (!this.canvasAttemptLoaded) {
        try { this.canvasCreateAttempt = JSON.parse(sessionStorage.getItem(this.canvasAttemptKey()) || 'null'); } catch { this.canvasAttemptPersistenceError = true; }
        this.canvasAttemptLoaded = true;
      }
      canvasManagerMixin.openCanvasCreateDialog.call(this);
      if (this.canvasCreateAttempt) {
        this.canvasDialog.title = this.canvasCreateAttempt.body.title;
        this.canvasDialog.visibilityMode = this.canvasCreateAttempt.body.visibility.mode;
        this.canvasDialog.actorIds = this.canvasCreateAttempt.body.visibility.actor_ids;
        this.canvasDialog.groupIds = this.canvasCreateAttempt.body.visibility.group_ids;
        this.canvasDialogError = 'A previous creation needs checking. Check the canvas list, then select an existing canvas to resolve it before creating another.';
      }
    },
    closeCanvasSettingsDialog() {
      // Keep the original link dialog mounted and inert underneath this modal.
      if (this.canvasSaving) return;
      canvasManagerMixin.closeCanvasSettingsDialog.call(this);
    },
    async refreshCanvasPrincipals() {
      this.canvasPrincipalBusy = true; this.canvasPrincipalError = '';
      const context = this.context(), options = { baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 200, reason: 'manual' };
      const results = await Promise.allSettled([getTowerPgWorkspaceMembers(context.workspaceId, options), getTowerPgWorkspaceGroups(context.workspaceId, options)]);
      const fields = ['members', 'groups'];
      results.forEach((result, index) => {
        try {
          if (result.status === 'rejected') throw result.reason;
          assertIdentity({ ...result.value, workspace_id: result.value.identity?.workspace_id }, context);
          const rows = result.value[fields[index]];
          if (!Array.isArray(rows) || result.value.next_cursor || result.value.has_more) throw new Error('Incomplete directory');
          if (index === 0) this.pgWorkspaceMembers = rows.map(row => { const actor = row.actor || row; return { ...actor, actor_id: actor.actor_id || actor.id }; });
          else this.groups = rows.map(row => ({ ...row, group_id: row.group_id || row.id }));
        } catch { this.canvasPrincipalError = 'Workspace choices could not be fully refreshed. Close and reopen to retry.'; }
      });
      this.canvasPrincipalBusy = false;
    },
    setLinkedCanvasChoices(rows) {
      this.canvasChoicesError = '';
      this.sourceOptions = [
        ...this.sourceOptions.filter(row => row.type !== 'canvas'),
        ...rows.filter(row => row.canvas_id !== this.canvasId).map(row => ({ type: 'canvas', id: row.canvas_id, title: row.title })),
      ].sort((a, b) => a.title.localeCompare(b.title));
    },
    async saveCanvasDialog() {
      if (!this.canvas?.can_manage || this.addDialog.type !== 'canvas' || !this.canvasDialogCanSave) return;
      const context = this.context();
      const body = {
        title: text(this.canvasDialog.title),
        visibility: { mode: this.canvasDialog.visibilityMode, actor_ids: this.canvasDialog.visibilityMode === 'restricted' ? [...this.canvasDialog.actorIds] : [], group_ids: this.canvasDialog.visibilityMode === 'restricted' ? [...this.canvasDialog.groupIds] : [] },
      };
      this.canvasSaving = true; this.canvasDialogError = '';
      let rows;
      try {
        if (this.canvasCreateAttempt) {
          rows = await hydrateCanvasList(context);
        } else {
          // Store before sending so reload/cancel cannot turn an uncertain send into a second POST.
          this.rememberCanvasAttempt({ body, id: '', accepted: false });
          rows = await createCanvasRecord(context, body, { onCreated: payload => {
            assertIdentity(payload, context);
            this.rememberCanvasAttempt({ body, id: text(payload.canvas?.id), accepted: true });
          } });
        }
        this.setLinkedCanvasChoices(rows);
        const attempt = this.canvasCreateAttempt;
        const created = attempt?.id && rows.find(row => row.canvas_id === attempt.id);
        if (attempt?.id && !created) throw new Error('The created canvas is not visible. Check again or ask the workspace owner for access.');
        if (created) {
          // Preserve search, label, insertion point and every other pending field.
          this.addDialog.sourceId = created.canvas_id;
          this.rememberCanvasAttempt(null);
          this.canvasLinkNotice = `Selected ${created.title}. Choose Add to link it.`;
        } else {
          this.canvasLinkNotice = 'Creation could not be confirmed. Choose the canvas from the refreshed list; no second creation was sent.';
        }
        this.canvasSaving = false;
        this.closeCanvasSettingsDialog();
      } catch (error) {
        // Explicit client rejection is safe to retry. Network/5xx errors may follow a committed write.
        if (!this.canvasCreateAttempt?.accepted && [400, 401, 403, 404, 409, 422, 429].includes(Number(error?.status))) this.rememberCanvasAttempt(null);
        this.canvasDialogError = `${error?.message || 'Could not create canvas.'}${this.canvasCreateAttempt ? ` Check the canvas list, then select an existing canvas to resolve this attempt.${this.canvasAttemptPersistenceError ? ' Keep this tab open: recovery cannot be saved in this browser.' : ''}` : ' You can correct the details and retry.'}`;
      } finally { this.canvasSaving = false; }
    },
    canvasLinkNotice: '',
  });
  Object.defineProperties(store, {
    canvasDialogCanSave: { configurable: true, get() { return !this.canvasSaving && (Boolean(this.canvasCreateAttempt) || (Boolean(text(this.canvasDialog.title)) && (this.canvasDialog.visibilityMode !== 'restricted' || this.canvasDialogSelectionCount > 0))); } },
    canvasDialogSubmitLabel: { configurable: true, get() { return this.canvasSaving ? 'Saving…' : this.canvasCreateAttempt ? 'Check canvas list' : 'Create canvas'; } },
  });
  return store;
}
