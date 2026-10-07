import { saveAppPlacement } from './db.js';

// The bundled napplet and existing personal WApps use the supported home stack.
// Missing preferences migrate implicitly to shown without rewriting registrations.
export const toolboxMixin = {
  appPlacementPreferences: {},
  appPlacementSaving: false,
  appPlacementError: '',
  appPlacementNotice: '',
  personalAppEditingType: 'WApp',
  personalAppEditingPlacementId: '',
  personalAppEditingPartition: '',
  personalAppFormShown: true,
  personalAppFormVisibility: 'everywhere',
  personalAppFormScopeId: '',
  personalAppFormChannelId: '',
  personalAppFormPosition: 1,

  appPlacement(entry) {
    const value = this.appPlacementPreferences?.[this.appPlacementPartition]?.[entry?.placementId];
    return typeof value === 'boolean' ? { shown: value, visibility: 'everywhere' } : (value || { shown: true, visibility: 'everywhere' });
  },

  get appPlacementScopes() {
    return (this.scopes || []).filter(row => row.record_id && row.record_state !== 'deleted' && row.record_state !== 'archived' && row.status !== 'archived');
  },

  get appPlacementChannelGroups() {
    const scopeIds = new Set(this.appPlacementScopes.map(row => row.record_id));
    return (this.wappPublishingDestinationGroups || []).filter(group => scopeIds.has(group.scope_id));
  },

  prepareAppPlacementEditor(entry) {
    const placement = this.appPlacement(entry);
    this.personalAppEditingType = entry?.appType || 'WApp';
    this.personalAppEditingPlacementId = entry?.placementId || '';
    this.personalAppEditingPartition = this.appPlacementPartition;
    this.personalAppFormShown = placement.shown !== false;
    this.personalAppFormVisibility = placement.visibility || 'everywhere';
    this.personalAppFormScopeId = placement.scopeId || '';
    this.personalAppFormChannelId = placement.channelId || '';
    this.personalAppFormPosition = this.toolboxApps.findIndex(app => app.placementId === entry?.placementId) + 1 || this.toolboxApps.length + 1;
  },

  appEditorPlacementDraft() {
    return {
      shown: this.personalAppFormShown,
      visibility: this.personalAppFormVisibility,
      scopeId: this.personalAppFormScopeId,
      channelId: this.personalAppFormChannelId,
      position: Math.max(1, Number(this.personalAppFormPosition) || 1),
      ...(this.personalAppEditingType === 'Napplet' ? { iconUrl: this.personalWappFormIconUrl.trim(), displayTitle: String(this.personalWappFormTitle || '').trim() } : {}),
    };
  },

  async saveAppEditorPlacement(entryId, partition = this.personalAppEditingPartition, draft = this.appEditorPlacementDraft(), orderedIds = this.toolboxApps.map(app => app.placementId)) {
    if (!partition) return;
    if (entryId.startsWith('napplet:') && !String(draft.displayTitle || '').trim()) throw new Error('Title is required. Enter a display name.');
    const ids = orderedIds.filter(id => id !== entryId);
    ids.splice(Math.min(ids.length, draft.position - 1), 0, entryId);
    this.appPlacementPreferences = await saveAppPlacement(partition, entryId, draft, ids);
  },

  openToolboxAppEditor(entry) {
    this.openPersonalWappEditor(entry);
  },

  async moveToolboxApp(entry, direction) {
    const rows = this.toolboxApps;
    const index = rows.findIndex(app => app.placementId === entry.placementId);
    const target = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || target < 0 || target >= rows.length) return;
    const partition = this.appPlacementPartition;
    const placement = this.appPlacement(entry);
    if (!partition || this.appPlacementSaving) return;
    this.appPlacementSaving = true;
    try {
      // Normalize positions before swapping; preserve existing WApp server ordering.
      [rows[index], rows[target]] = [rows[target], rows[index]];
      await this.savePersonalWappOrder?.(rows.filter(app => app.appType === 'WApp').map(app => app.record_id));
      this.appPlacementPreferences = await saveAppPlacement(partition, entry.placementId, placement, rows.map(app => app.placementId));
    } catch (error) { this.appPlacementError = error.message; }
    finally { this.appPlacementSaving = false; }
  },

  get appPlacementPartition() {
    const workspace = String(this.currentWorkspaceKey || '').trim();
    const viewer = String(this.currentPgActorId || this.currentViewerNpub || '').trim();
    return workspace && viewer ? JSON.stringify([workspace, viewer]) : '';
  },

  get toolboxApps() {
    const wapps = this.visiblePersonalWapps || [];
    const seen = new Set();
    return [
      ...wapps.filter(wapp => {
        if (!wapp.record_id || seen.has(wapp.record_id)) return false;
        seen.add(wapp.record_id); return true;
      }).map(wapp => ({ ...wapp, placementId: 'wapp:' + wapp.record_id, appType: 'WApp' })),
      { placementId: 'napplet:message-activity', title: 'Message activity',
        description: 'Messages by channel and scope', appType: 'Napplet' },
      { placementId: 'napplet:tower-usage', title: 'Tower Usage',
        description: 'Stored bytes in the selected Tower workspace', appType: 'Napplet' },
    ].map((app, index) => {
      const placement = this.appPlacement(app);
      return { ...app, ...(app.appType === 'Napplet' ? { icon_url: placement.iconUrl || '', title: String(placement.displayTitle || '').trim() || app.title } : {}), launcherPosition: placement.position ?? index + 1 };
    }).sort((a, b) => a.launcherPosition - b.launcherPosition);
  },

  get messageActivityDisplayTitle() {
    return this.toolboxApps.find(app => app.placementId === 'napplet:message-activity')?.title || 'Message activity';
  },

  isAppPlaced(entry) {
    return this.appPlacement(entry).shown !== false;
  },

  get visibleApps() {
    if (!this.appPlacementPartition) return [];
    return this.toolboxApps.filter(entry => {
      const placement = this.appPlacement(entry);
      if (placement.shown === false) return false;
      if (placement.visibility === 'everywhere' || !placement.visibility) return true;
      if (placement.visibility === 'scope') return this.appPlacementScopes.some(scope => scope.record_id === placement.scopeId)
        && this.pgContextScopeId === placement.scopeId;
      if (placement.visibility === 'channel') return this.appPlacementChannelGroups.some(group => group.channels.some(channel => channel.channel_id === placement.channelId))
        && this.pgContextSelectedChannelId === placement.channelId;
      return false;
    });
  },

  async setAppPlacement(entry, shown) {
    const partition = this.appPlacementPartition;
    if (!partition || this.appPlacementSaving || !this.toolboxApps.some(app => app.placementId === entry?.placementId)) return;
    this.appPlacementSaving = true;
    this.appPlacementError = ''; this.appPlacementNotice = '';
    try {
      const preferences = await saveAppPlacement(partition, entry.placementId, { ...this.appPlacement(entry), shown });
      // Rendering always selects the current workspace/viewer partition.
      this.appPlacementPreferences = preferences;
      if (partition === this.appPlacementPartition) {
        this.appPlacementNotice = 'Placement saved.';
        this.closePersonalWappsOverlay();
      }
    } catch (error) {
      if (partition === this.appPlacementPartition) this.appPlacementError = error?.message || 'Could not save placement. Try again.';
    } finally {
      this.appPlacementSaving = false;
    }
  },

  openApp(entry) {
    if (!this.visibleApps.some(app => app.placementId === entry?.placementId)) return;
    if (entry.appType === 'Napplet') {
      // The expanded napplet pill will hide when the stack closes. Restore focus
      // to its visible stack control instead of an inaccessible hidden pill.
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const opener = this.visibleApps.length > 1 && active?.closest('[data-testid="apps-stack"]')
        ? document.querySelector('[data-testid="apps-stack"] .wapps-stack-hitbox') : active;
      this.closePersonalWappsOverlay();
      if (entry.placementId === 'napplet:tower-usage') this.openTowerUsage({ opener });
      else this.openMessageActivity({ opener });
    } else this.openPersonalWapp(entry);
  },
};
