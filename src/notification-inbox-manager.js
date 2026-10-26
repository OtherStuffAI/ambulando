import { liveQuery } from 'dexie';
import { getWorkspaceDb } from './db.js';
import { buildSectionUrl } from './route-helpers.js';
import {
  notificationInboxContext, notificationInboxContextOrNull, projectNotificationInbox, queueNotificationBulk,
  queueNotificationPatch, unreadCount,
} from './notification-inbox-store.js';
import { hydrateArchivedNotifications } from './notification-inbox-sync.js';
import { buildCategoryRows, fetchNotificationPreferences, saveInboxRule } from './notification-rules.js';

const subscriptions = new WeakMap();
export const NOTIFICATION_BADGE_CAP = 99;

function trimText(value) { return String(value ?? '').trim(); }

/**
 * Typed target -> app route. Targets are ids only (never paths or URLs); unknown
 * kinds return null so the inbox keeps showing the card instead of guessing.
 */
export function notificationTargetRoute(item) {
  const target = item?.target;
  if (!target || item.unavailable) return null;
  // Typed target first; the item's subject ids fill in what the target omits.
  const id = key => trimText(target[key]) || trimText(item.subject?.[key]);
  const scopeid = id('scope_id');
  const kind = trimText(target.kind);
  if (['thread', 'message', 'channel', 'dm'].includes(kind)) {
    if (!id('channel_id')) return null;
    return { section: 'chat', scopeid, params: { channelid: id('channel_id'), threadid: id('thread_id') || id('message_id') }, ensure: { family: 'channel-messages', id: id('channel_id') } };
  }
  if (kind === 'task' || kind === 'task_comment') {
    const taskId = id('task_id') || id('id');
    return taskId ? { section: 'tasks', scopeid, params: { taskid: taskId, commentid: id('comment_id') } } : null;
  }
  if (kind === 'doc' || kind === 'doc_comment') {
    const docId = id('doc_id') || id('document_id') || id('id');
    return docId ? { section: 'docs', scopeid, params: { docid: docId, commentid: id('comment_id') } } : null;
  }
  if (kind === 'workroom') return id('workroom_id') ? { section: 'workroom', scopeid, params: { workroomid: id('workroom_id') } } : null;
  if (kind === 'approval') return { section: 'status', scopeid, params: {} };
  return null;
}

function relativeTime(iso, nowMs = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const STATUS_COPY = {
  unsupported: 'This Tower does not provide the shared notification inbox yet. Existing alerts and Needs You keep working.',
  forbidden: 'You no longer have access to notifications in this workspace.',
};

export const notificationInboxMixin = {
  notificationInboxOpen: false,
  notificationInboxView: 'inbox',
  notificationInboxCategory: '',
  notificationInboxItems: [],
  notificationInboxCategories: [],
  notificationInboxUnread: 0,
  notificationInboxReady: false,
  notificationInboxStatus: 'unknown',
  notificationInboxMessage: '',
  notificationInboxNotice: '',
  notificationInboxCounts: null,
  notificationInboxActivatedAt: '',
  notificationInboxPending: 0,
  notificationInboxBusy: false,
  notificationInboxContextKey: '',
  notificationInboxAnnouncement: '',
  notificationPrefsRows: [],
  notificationPrefsLoaded: false,
  notificationPrefsLoading: false,
  notificationPrefsError: '',

  get notificationInboxBadge() {
    const count = this.notificationInboxUnread;
    return count > NOTIFICATION_BADGE_CAP ? `${NOTIFICATION_BADGE_CAP}+` : String(count);
  },
  get notificationInboxEmptyText() {
    if (this.notificationInboxStatus === 'unsupported' || this.notificationInboxStatus === 'forbidden') return STATUS_COPY[this.notificationInboxStatus];
    if (!this.notificationInboxReady) return 'Connect to Tower to load notifications.';
    if (this.notificationInboxView === 'unread') return 'You are all caught up.';
    if (this.notificationInboxView === 'archived') return 'No archived notifications.';
    return this.notificationInboxActivatedAt
      ? `No notifications yet. Your inbox started ${new Date(this.notificationInboxActivatedAt).toLocaleDateString()}; earlier activity is not imported.`
      : 'No notifications yet.';
  },

  disposeNotificationInbox() {
    subscriptions.get(this)?.subscription?.unsubscribe();
    subscriptions.delete(this);
    // Rows are context-keyed in Dexie, but rendered state must never outlive a workspace switch.
    this.notificationInboxItems = [];
    this.notificationInboxCategories = [];
    this.notificationInboxUnread = 0;
    this.notificationInboxReady = false;
    this.notificationInboxStatus = 'unknown';
    this.notificationInboxMessage = '';
    this.notificationInboxNotice = '';
    this.notificationInboxCounts = null;
    this.notificationInboxActivatedAt = '';
    this.notificationInboxPending = 0;
    this.notificationInboxContextKey = '';
    this.notificationInboxOpen = false;
    this.notificationPrefsRows = [];
    this.notificationPrefsLoaded = false;
    this.notificationPrefsError = '';
  },

  activateNotificationInbox() {
    const context = notificationInboxContextOrNull(this);
    if (!context) { this.disposeNotificationInbox(); return; }
    if (subscriptions.get(this)?.key === context.key) return;
    this.disposeNotificationInbox();
    this.notificationInboxContextKey = context.key;
    const entry = { key: context.key };
    subscriptions.set(this, entry);
    const db = getWorkspaceDb();
    entry.subscription = liveQuery(async () => ({
      rows: await db.notification_items.where('context').equals(context.key).toArray(),
      state: await db.notification_inbox.get(context.key),
    })).subscribe({
      next: latest => {
        if (subscriptions.get(this) !== entry) return;
        if (notificationInboxContextOrNull(this)?.key !== context.key) return;
        entry.latest = latest;
        this.projectNotificationInbox(latest);
      },
      error: () => { if (subscriptions.get(this) === entry) this.notificationInboxMessage = 'Could not load saved notifications.'; },
    });
    void this.requestTowerSyncFamily?.('notification-inbox').catch(() => {});
  },

  projectNotificationInbox({ rows, state } = subscriptions.get(this)?.latest || {}) {
    if (!rows) return;
    const view = this.notificationInboxView;
    const projected = projectNotificationInbox(rows, state, { view, category: this.notificationInboxCategory });
    // Offer the categories present in the unfiltered view so a stale filter can always be cleared.
    this.notificationInboxCategories = [...new Set(projectNotificationInbox(rows, state, { view }).map(item => item.category))].sort();
    this.notificationInboxItems = projected.map(item => ({ ...item, ageLabel: relativeTime(item.occurred_at), route: notificationTargetRoute(item) }));
    this.notificationInboxUnread = unreadCount(rows, state);
    this.notificationInboxReady = Boolean(state?.ready);
    this.notificationInboxStatus = state?.status || 'unknown';
    this.notificationInboxCounts = state?.counts || null;
    this.notificationInboxActivatedAt = state?.activated_at || '';
    this.notificationInboxPending = state?.pending?.length || 0;
    this.notificationInboxNotice = state?.notice || '';
    this.notificationInboxMessage = STATUS_COPY[state?.status] || state?.error || '';
  },

  toggleNotificationInbox(open = !this.notificationInboxOpen) {
    this.notificationInboxOpen = Boolean(open);
    if (open) {
      this.activateNotificationInbox();
      void this.requestTowerSyncFamily?.('notification-inbox').catch(() => {});
    }
  },

  async setNotificationInboxView(view) {
    if (!['inbox', 'unread', 'archived'].includes(view)) return;
    this.notificationInboxView = view;
    this.notificationInboxCategory = '';
    this.projectNotificationInbox();
    if (view === 'archived') {
      try { await hydrateArchivedNotifications(this); } catch { this.notificationInboxMessage = 'Could not load archived notifications. Try again when connected.'; }
    }
  },
  setNotificationInboxCategory(category) {
    this.notificationInboxCategory = trimText(category);
    this.projectNotificationInbox();
  },

  async mutateNotification(item, patch, announcement) {
    try {
      const context = notificationInboxContext(this);
      // The versions the user saw rendered, not whatever a later sync stored.
      await queueNotificationPatch(getWorkspaceDb(), context, item.id, patch, { row_version: item.row_version, change_seq: item.change_seq });
      if (announcement) this.notificationInboxAnnouncement = announcement;
      void this.requestTowerSyncFamily?.('notification-inbox').catch(() => {});
      return true;
    } catch (error) {
      this.notificationInboxMessage = error.message;
      return false;
    }
  },
  markNotificationRead: function (item) { return this.mutateNotification(item, { read: true }, 'Marked read'); },
  markNotificationUnread: function (item) { return this.mutateNotification(item, { read: false }, 'Marked unread'); },
  dismissNotification: function (item) { return this.mutateNotification(item, { dismissed: true }, 'Notification dismissed'); },
  archiveNotification: function (item) { return this.mutateNotification(item, { archived: true }, 'Notification archived'); },
  unarchiveNotification: function (item) { return this.mutateNotification(item, { archived: false }, 'Notification restored to inbox'); },

  async markAllNotificationsRead() {
    try {
      const context = notificationInboxContext(this);
      await queueNotificationBulk(getWorkspaceDb(), context, 'mark_read', { category: this.notificationInboxCategory, view: this.notificationInboxView === 'unread' ? 'unread' : undefined });
      this.notificationInboxAnnouncement = 'Notifications marked read';
      void this.requestTowerSyncFamily?.('notification-inbox').catch(() => {});
    } catch (error) { this.notificationInboxMessage = error.message; }
  },

  /**
   * Opening navigates first and marks only this notification read afterwards. A failed load never
   * clears the notification: the route still opens from saved data (the resource-view bridge will
   * derive read once the resource is viewed), but the item stays unread with an explanation.
   */
  async openNotification(item) {
    if (!item || this.notificationInboxBusy) return;
    this.notificationInboxBusy = true;
    try {
      const route = item.route;
      if (!route) {
        // A generic card has nothing to load; the explicit click is the acknowledgement.
        if (!item.read && !item.unavailable) await this.mutateNotification(item, { read: true });
        return;
      }
      let loaded = true;
      if (route.ensure) {
        try { await this.requestTowerSyncFamily?.(route.ensure.family, route.ensure.id, { force: true }); } catch { loaded = false; }
      }
      const url = buildSectionUrl({ workspaceSlug: this.currentWorkspaceSlug || null, section: route.section, scopeid: route.scopeid || null, params: route.params });
      window.history.pushState({ source: 'notification-inbox' }, '', url);
      await this.applyRouteFromLocation?.();
      this.notificationInboxOpen = false;
      if (loaded) { if (!item.read) await this.mutateNotification(item, { read: true }); }
      else this.notificationInboxMessage = 'Opened from saved data because the latest could not be loaded. The notification stays unread.';
    } finally { this.notificationInboxBusy = false; }
  },

  async loadNotificationInboxPreferences() {
    const key = notificationInboxContextOrNull(this)?.key;
    if (!key) return;
    this.notificationPrefsLoading = true; this.notificationPrefsError = '';
    try {
      const result = await fetchNotificationPreferences(this);
      if (notificationInboxContextOrNull(this)?.key !== key) return; // workspace changed while loading
      this.notificationPrefsRows = buildCategoryRows(result.registry, result.rules);
      this.notificationPrefsLoaded = true;
    } catch (error) {
      if (notificationInboxContextOrNull(this)?.key !== key) return;
      this.notificationPrefsError = [404, 405, 501].includes(error.status) ? STATUS_COPY.unsupported : (error.message || 'Could not load notification preferences.');
    } finally { if (notificationInboxContextOrNull(this)?.key === key) this.notificationPrefsLoading = false; }
  },
  async setNotificationInboxRule(row, on, options = {}) {
    const key = notificationInboxContextOrNull(this)?.key;
    this.notificationPrefsError = '';
    try {
      const result = await saveInboxRule(this, row, on, options);
      if (notificationInboxContextOrNull(this)?.key !== key) return;
      this.notificationPrefsRows = this.notificationPrefsRows.map(item => item.key === row.key ? { ...item, inboxOn: item.mandatory ? true : on, explicit: true } : item);
      // A rule changes which items the server shows and counts: rebuild the local inbox from the authority.
      await this.getTowerSyncService()?.materialize('workspace-bundle', { notification_inbox_operation: { action: 'needs_snapshot', context: { key: result.contextKey, workspaceId: notificationInboxContext(this).workspaceId, actorId: notificationInboxContext(this).actorId } } }, { workspaceDbKey: this.workspaceDbKey, store: this.buildTowerPgMaterializationStoreSnapshot() });
      void this.requestTowerSyncFamily?.('notification-inbox').catch(() => {});
    } catch (error) {
      this.notificationPrefsError = error.message || 'Could not save this preference.';
      await this.loadNotificationInboxPreferences(); // show the server's truth again
    }
  },

  clearNotificationInboxNotice() {
    void this.getTowerSyncService()?.materialize('workspace-bundle', { notification_inbox_operation: { action: 'clear_notice', context: (() => { const c = notificationInboxContext(this); return { key: c.key, workspaceId: c.workspaceId, actorId: c.actorId }; })() } }, { workspaceDbKey: this.workspaceDbKey, store: this.buildTowerPgMaterializationStoreSnapshot() }).catch(() => {});
  },
};
