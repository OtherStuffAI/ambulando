import { liveQuery } from 'dexie';
import { getCurrentWorkspaceDbKey, getWorkspaceDb } from '../db.js';
import { canvasContext, canvasPartition } from './projection.js';
import { createCanvasRecord, hydrateCanvasList, reorderCanvasRecords, updateCanvasRecord } from './sync-service.js';

const runtimes = new WeakMap();
const text = value => String(value ?? '').trim();
const RAW_IDENTITY = /^(npub1|nprofile1|[0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f]{32,})/i;

export function truncateCanvasIdentity(value) {
  const clean = text(value);
  if (!clean) return '';
  if (clean.length <= 18) return clean;
  return `${clean.slice(0, 10)}…${clean.slice(-6)}`;
}

function readableCanvasLabel(value) {
  const clean = text(value);
  return clean && !RAW_IDENTITY.test(clean) && !/^(unknown|unnamed)(\s|$)/i.test(clean) ? clean : '';
}

export function buildCanvasPrincipalOptions({ members = [], groups = [], getSenderName, getSenderAvatar } = {}) {
  const options = [];
  const seen = new Set();
  for (const member of members || []) {
    const id = text(member?.actor_id || member?.id);
    if (!id || seen.has(`actor:${id}`)) continue;
    seen.add(`actor:${id}`);
    const npub = text(member?.npub || member?.actor_npub);
    const kind = text(member?.kind || member?.actor_kind || member?.actor?.kind).toLowerCase() === 'agent' ? 'agent' : 'person';
    const profileName = npub ? readableCanvasLabel(getSenderName?.(npub)) : '';
    const label = readableCanvasLabel(member?.display_name || member?.label || member?.name)
      || profileName
      || `Unnamed ${kind}`;
    const role = readableCanvasLabel(member?.role);
    const fallbackIdentity = !readableCanvasLabel(label) ? truncateCanvasIdentity(npub || id) : '';
    options.push({
      key: `actor:${id}`,
      type: 'actor',
      kind,
      kindLabel: kind === 'agent' ? 'Agent' : 'Person',
      id,
      npub,
      label,
      subtitle: role || fallbackIdentity || (kind === 'agent' ? 'Workspace agent' : 'Workspace member'),
      avatarUrl: npub ? text(getSenderAvatar?.(npub)) : '',
      searchText: [label, role, npub, id, kind].map(text).join(' ').toLowerCase(),
    });
  }
  for (const group of groups || []) {
    const id = text(group?.group_id || group?.groupId || group?.id);
    if (!id || seen.has(`group:${id}`)) continue;
    seen.add(`group:${id}`);
    const label = readableCanvasLabel(group?.name || group?.label) || 'Unnamed group';
    const membersCount = (group?.effective_member_npubs || group?.member_npubs || group?.members || []).length;
    const described = readableCanvasLabel(group?.subtitle || group?.description);
    const fallbackIdentity = !readableCanvasLabel(label) ? truncateCanvasIdentity(id) : '';
    options.push({
      key: `group:${id}`,
      type: 'group',
      kind: 'group',
      kindLabel: 'Group',
      id,
      label,
      subtitle: described || (membersCount ? `${membersCount} ${membersCount === 1 ? 'member' : 'members'}` : fallbackIdentity || 'Workspace group'),
      avatarUrl: '',
      searchText: [label, described, id, 'group'].map(text).join(' ').toLowerCase(),
    });
  }
  return options.sort((left, right) => left.label.localeCompare(right.label) || left.kindLabel.localeCompare(right.kindLabel));
}

function scheduleUiNextTick(callback) {
  const nextTick = globalThis.Alpine?.nextTick;
  if (typeof nextTick === 'function') {
    nextTick(callback);
    return;
  }
  queueMicrotask(callback);
}

export const canvasManagerMixin = {
  canvasRows: [],
  canvasContextKey: '',
  canvasLoading: false,
  canvasError: '',
  canvasSaving: false,
  canvasDialogError: '',
  canvasDraggedId: '',
  canvasDialog: { open: false, mode: 'create', id: '', rowVersion: null, title: '', visibilityMode: 'workspace', actorIds: [], groupIds: [] },
  canvasPrincipalQuery: '',
  canvasPrincipalPickerOpen: false,
  canvasPrincipalPickerIndex: 0,
  canvasPrincipalBusy: false,
  canvasPrincipalError: '',

  get canvasPartition() {
    const context = canvasContext(this);
    return context.workspaceId && context.viewer && getCurrentWorkspaceDbKey() ? canvasPartition(context) : '';
  },
  get visibleCanvases() {
    return this.canvasContextKey === this.canvasPartition
      ? [...this.canvasRows].sort((a, b) => a.position - b.position || a.canvas_id.localeCompare(b.canvas_id))
      : [];
  },
  get canvasPrincipalOptions() {
    const sourceGroups = Array.isArray(this.currentWorkspaceGroups) && this.currentWorkspaceGroups.length
      ? this.currentWorkspaceGroups
      : this.groups;
    return buildCanvasPrincipalOptions({
      members: this.pgWorkspaceMembers,
      groups: sourceGroups,
      getSenderName: npub => this.getSenderName?.(npub),
      getSenderAvatar: npub => this.getSenderAvatar?.(npub),
    });
  },
  get canvasSelectedPrincipalKeys() {
    return new Set([
      ...(this.canvasDialog.actorIds || []).map(id => `actor:${id}`),
      ...(this.canvasDialog.groupIds || []).map(id => `group:${id}`),
    ]);
  },
  get canvasPrincipalSearchResults() {
    const query = text(this.canvasPrincipalQuery).toLowerCase();
    const selected = this.canvasSelectedPrincipalKeys;
    return this.canvasPrincipalOptions
      .filter(option => !selected.has(option.key) && (!query || option.searchText.includes(query)))
      .slice(0, 30);
  },
  get canvasSelectedPrincipals() {
    const byKey = new Map(this.canvasPrincipalOptions.map(option => [option.key, option]));
    return [
      ...(this.canvasDialog.actorIds || []).map(id => byKey.get(`actor:${id}`) || {
        key: `actor:${id}`, type: 'actor', kind: 'person', kindLabel: 'Person', id,
        label: 'Unavailable person', subtitle: truncateCanvasIdentity(id), avatarUrl: '',
      }),
      ...(this.canvasDialog.groupIds || []).map(id => byKey.get(`group:${id}`) || {
        key: `group:${id}`, type: 'group', kind: 'group', kindLabel: 'Group', id,
        label: 'Unavailable group', subtitle: truncateCanvasIdentity(id), avatarUrl: '',
      }),
    ];
  },
  get canvasDialogSelectionCount() {
    return (this.canvasDialog.actorIds || []).length + (this.canvasDialog.groupIds || []).length;
  },
  get canvasDialogCanSave() {
    return Boolean(text(this.canvasDialog.title))
      && !this.canvasSaving
      && (this.canvasDialog.visibilityMode !== 'restricted' || this.canvasDialogSelectionCount > 0);
  },
  stopCanvases() {
    const runtime = runtimes.get(this);
    runtime?.controller?.abort();
    runtime?.subscription?.unsubscribe();
    runtimes.delete(this);
    this.canvasRows = [];
    this.canvasContextKey = '';
  },
  syncCanvasContext(partition) {
    const dbKey = getCurrentWorkspaceDbKey();
    const key = JSON.stringify([partition, dbKey]);
    if (runtimes.get(this)?.key === key) return;
    this.stopCanvases();
    this.canvasContextKey = partition;
    this.canvasError = '';
    if (!partition || !dbKey) return;
    const db = getWorkspaceDb();
    const controller = new AbortController();
    const subscription = liveQuery(() => db.canvas_definitions.where('context').equals(partition).toArray()).subscribe({
      next: rows => {
        if (this.canvasPartition === partition && runtimes.get(this)?.key === key) this.canvasRows = rows;
      },
      error: () => { if (this.canvasPartition === partition) this.canvasError = 'Could not load Canvas.'; },
    });
    runtimes.set(this, { key, controller, subscription });
    void this.refreshCanvases({ partition, key, controller });
  },
  async refreshCanvases(runtime = runtimes.get(this)) {
    if (!runtime || runtime.key !== runtimes.get(this)?.key) return;
    const context = canvasContext(this);
    const partition = canvasPartition(context);
    this.canvasLoading = true;
    this.canvasError = '';
    try {
      const rows = await hydrateCanvasList(context, { signal: runtime.controller.signal });
      if (runtime.key !== runtimes.get(this)?.key || partition !== this.canvasPartition) return;
      this.canvasRows = rows;
    } catch (error) {
      if (error?.name !== 'AbortError' && partition === this.canvasPartition) {
        this.canvasRows = [];
        this.canvasError = error?.status === 404 ? 'Canvas is not available on this NStack.' : (error?.message || 'Could not refresh Canvas.');
      }
    } finally {
      if (partition === this.canvasPartition) this.canvasLoading = false;
    }
  },
  openCanvasCreateDialog() {
    this.canvasDialogOpener = globalThis.document?.activeElement;
    this.canvasDialog = { open: true, mode: 'create', id: '', rowVersion: null, title: '', visibilityMode: 'workspace', actorIds: [], groupIds: [] };
    this.canvasDialogError = '';
    this.resetCanvasPrincipalPicker();
    scheduleUiNextTick(() => {
      const dialog = globalThis.document?.getElementById('canvas-settings-dialog');
      if (!dialog?.open) dialog?.showModal();
      dialog?.querySelector?.('[data-canvas-title-input]')?.focus();
    });
    void this.refreshCanvasPrincipals();
  },
  openCanvasSettingsDialog(canvas) {
    if (!canvas?.can_manage) return;
    this.canvasDialogOpener = globalThis.document?.activeElement;
    this.canvasDialogError = '';
    this.canvasDialog = {
      open: true,
      mode: 'edit',
      id: canvas.canvas_id,
      rowVersion: canvas.row_version,
      title: canvas.title,
      visibilityMode: canvas.visibility?.mode || 'workspace',
      actorIds: [...(canvas.visibility?.actor_ids || [])],
      groupIds: [...(canvas.visibility?.group_ids || [])],
    };
    this.resetCanvasPrincipalPicker();
    scheduleUiNextTick(() => {
      const dialog = globalThis.document?.getElementById('canvas-settings-dialog');
      if (!dialog?.open) dialog?.showModal();
      dialog?.querySelector?.('[data-canvas-title-input]')?.focus();
    });
    void this.refreshCanvasPrincipals();
  },
  closeCanvasSettingsDialog() {
    globalThis.document?.getElementById('canvas-settings-dialog')?.close();
    this.canvasDialog = { ...this.canvasDialog, open: false };
    this.resetCanvasPrincipalPicker();
    scheduleUiNextTick(() => this.canvasDialogOpener?.focus?.());
  },
  resetCanvasPrincipalPicker() {
    this.canvasPrincipalQuery = '';
    this.canvasPrincipalPickerOpen = false;
    this.canvasPrincipalPickerIndex = 0;
    this.canvasPrincipalError = '';
  },
  async refreshCanvasPrincipals() {
    const loaders = [
      typeof this.refreshTowerPgWorkspaceMembers === 'function'
        ? this.refreshTowerPgWorkspaceMembers({ force: false, limit: 200 })
        : null,
      typeof this.refreshGroups === 'function'
        ? this.refreshGroups({ force: false })
        : null,
    ].filter(Boolean);
    if (!loaders.length) return;
    this.canvasPrincipalBusy = true;
    this.canvasPrincipalError = '';
    try {
      await Promise.all(loaders);
    } catch {
      this.canvasPrincipalError = 'Some workspace choices could not be refreshed. You can use the choices already loaded or try again.';
    } finally {
      this.canvasPrincipalBusy = false;
    }
  },
  changeCanvasPrincipalQuery(value) {
    this.canvasPrincipalQuery = value;
    this.canvasPrincipalPickerIndex = 0;
    this.canvasPrincipalPickerOpen = true;
  },
  openCanvasPrincipalPicker() {
    this.canvasPrincipalPickerOpen = true;
    this.canvasPrincipalPickerIndex = Math.min(this.canvasPrincipalPickerIndex, Math.max(0, this.canvasPrincipalSearchResults.length - 1));
  },
  closeCanvasPrincipalPicker({ restoreFocus = false } = {}) {
    this.canvasPrincipalPickerOpen = false;
    if (restoreFocus) scheduleUiNextTick(() => globalThis.document?.getElementById('canvas-principal-search')?.focus());
  },
  moveCanvasPrincipalPicker(index) {
    const count = this.canvasPrincipalSearchResults.length;
    this.canvasPrincipalPickerIndex = count ? Math.max(0, Math.min(index, count - 1)) : 0;
    scheduleUiNextTick(() => globalThis.document?.getElementById(`canvas-principal-option-${this.canvasPrincipalPickerIndex}`)?.scrollIntoView?.({ block: 'nearest' }));
  },
  handleCanvasPrincipalKeydown(event) {
    const count = this.canvasPrincipalSearchResults.length;
    if (event.key === 'Escape' && this.canvasPrincipalPickerOpen) {
      event.preventDefault(); event.stopPropagation(); this.closeCanvasPrincipalPicker(); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); this.openCanvasPrincipalPicker();
      if (event.key === 'Home') this.moveCanvasPrincipalPicker(0);
      else if (event.key === 'End') this.moveCanvasPrincipalPicker(count - 1);
      else this.moveCanvasPrincipalPicker(this.canvasPrincipalPickerIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' && this.canvasPrincipalPickerOpen) {
      event.preventDefault(); event.stopPropagation();
      const option = this.canvasPrincipalSearchResults[this.canvasPrincipalPickerIndex];
      if (option) this.selectCanvasPrincipal(option);
    }
  },
  selectCanvasPrincipal(option) {
    if (!option?.id || !['actor', 'group'].includes(option.type)) return;
    const field = option.type === 'group' ? 'groupIds' : 'actorIds';
    if (!(this.canvasDialog[field] || []).includes(option.id)) {
      this.canvasDialog = { ...this.canvasDialog, [field]: [...(this.canvasDialog[field] || []), option.id] };
    }
    this.canvasPrincipalQuery = '';
    this.canvasPrincipalPickerIndex = 0;
    this.canvasPrincipalPickerOpen = false;
    scheduleUiNextTick(() => globalThis.document?.getElementById('canvas-principal-search')?.focus());
  },
  removeCanvasPrincipal(option) {
    if (!option?.id || !['actor', 'group'].includes(option.type)) return;
    const field = option.type === 'group' ? 'groupIds' : 'actorIds';
    this.canvasDialog = { ...this.canvasDialog, [field]: (this.canvasDialog[field] || []).filter(id => id !== option.id) };
  },
  toggleCanvasVisibilityPrincipal(kind, id, checked) {
    const field = kind === 'group' ? 'groupIds' : 'actorIds';
    const values = new Set(this.canvasDialog[field]);
    if (checked) values.add(id); else values.delete(id);
    this.canvasDialog = { ...this.canvasDialog, [field]: [...values] };
  },
  async saveCanvasDialog() {
    const title = text(this.canvasDialog.title);
    if (!this.canvasDialogCanSave) return;
    const context = canvasContext(this);
    const body = {
      title,
      visibility: {
        mode: this.canvasDialog.visibilityMode === 'restricted' ? 'restricted' : 'workspace',
        actor_ids: this.canvasDialog.visibilityMode === 'restricted' ? this.canvasDialog.actorIds : [],
        group_ids: this.canvasDialog.visibilityMode === 'restricted' ? this.canvasDialog.groupIds : [],
      },
    };
    this.canvasSaving = true;
    this.canvasDialogError = '';
    try {
      if (this.canvasDialog.mode === 'edit') {
        await updateCanvasRecord(context, this.canvasDialog.id, {
          ...body,
          expected_row_version: this.canvasDialog.rowVersion,
        });
      } else {
        await createCanvasRecord(context, body);
      }
      this.closeCanvasSettingsDialog();
      await this.refreshCanvases();
    } catch (error) {
      this.canvasDialogError = error?.message || 'Could not save canvas.';
    } finally { this.canvasSaving = false; }
  },
  openCanvas(canvas) {
    if (!canvas?.canvas_id || !this.currentWorkspaceKey) return;
    const url = new URL('/canvas.html', window.location.origin);
    url.searchParams.set('workspacekey', this.currentWorkspaceKey);
    url.searchParams.set('canvasid', canvas.canvas_id);
    window.open(url.toString(), '_blank');
  },
  beginCanvasDrag(canvas, event) {
    this.canvasDraggedId = canvas?.canvas_id || '';
    event?.dataTransfer?.setData('text/plain', this.canvasDraggedId);
    if (event?.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  },
  async dropCanvasBefore(target) {
    const dragged = this.canvasDraggedId;
    this.canvasDraggedId = '';
    if (!dragged || !target?.canvas_id || dragged === target.canvas_id) return;
    const ordered = this.visibleCanvases.map(row => row.canvas_id).filter(id => id !== dragged);
    ordered.splice(ordered.indexOf(target.canvas_id), 0, dragged);
    const context = canvasContext(this), partition = this.canvasPartition, db = getWorkspaceDb();
    await db.transaction('rw', db.canvas_definitions, async () => {
      for (const [index, id] of ordered.entries()) {
        const row = this.canvasRows.find(value => value.canvas_id === id);
        if (row) await db.canvas_definitions.put({ ...row, position: index + 1 });
      }
    });
    try {
      await reorderCanvasRecords(context, ordered);
    } catch (error) {
      this.canvasError = error?.message || 'Could not reorder canvases.';
      if (partition === this.canvasPartition) await this.refreshCanvases();
    }
  },
};
