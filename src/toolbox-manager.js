import { saveAppPlacement } from './db.js';

// The bundled napplet and existing personal WApps use the supported home stack.
// Missing preferences migrate implicitly to shown without rewriting registrations.
export const toolboxMixin = {
  appPlacementPreferences: {},
  appPlacementSaving: false,
  appPlacementError: '',
  appPlacementNotice: '',

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
    ];
  },

  isAppPlaced(entry) {
    return this.appPlacementPreferences?.[this.appPlacementPartition]?.[entry?.placementId] !== false;
  },

  get visibleApps() {
    return this.toolboxApps.filter(entry => this.isAppPlaced(entry));
  },

  async setAppPlacement(entry, shown) {
    const partition = this.appPlacementPartition;
    if (!partition || this.appPlacementSaving || !this.toolboxApps.some(app => app.placementId === entry?.placementId)) return;
    this.appPlacementSaving = true;
    this.appPlacementError = ''; this.appPlacementNotice = '';
    try {
      const preferences = await saveAppPlacement(partition, entry.placementId, shown);
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
      const opener = this.visibleApps.length > 1 && typeof document !== 'undefined'
        ? document.querySelector('[data-testid="apps-stack"] .wapps-stack-hitbox') : null;
      this.closePersonalWappsOverlay();
      this.openMessageActivity({ opener });
    } else this.openPersonalWapp(entry);
  },
};
