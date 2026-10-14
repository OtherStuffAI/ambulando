import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';
import { liveQuery } from 'dexie';
import { getSettings, getWorkspaceDb, getCurrentWorkspaceDbKey, getPinnedThreadRows, saveThreadPin } from './db.js';

const subscriptions = new WeakMap();
export const pinnedThreadsMixin = {
  pinnedThreadRows: [],
  pinnedThreadsContext: '',
  pinnedThreadsError: '',
  threadPinSaving: {},
  stopPinnedThreads() {
    subscriptions.get(this)?.subscription?.unsubscribe();
    subscriptions.delete(this);
    this.pinnedThreadRows = [];
    this.pinnedThreadsContext = '';
  },
  get pinnedThreadsPartition() {
    const workspace = this.currentWorkspaceKey;
    const reader = this.currentViewerNpub || this.session?.npub;
    const context = resolveTowerPgWorkspaceContext(this);
    return workspace && reader && this.session?.npub ? JSON.stringify([context.baseUrl, context.appNpub, workspace, this.session.npub, reader]) : '';
  },
  get pinnedThreads() {
    if (this.pinnedThreadsContext !== this.pinnedThreadsPartition) return [];
    return this.pinnedThreadRows.map(row => ({ ...row, isUnread: !row.unavailable && (row.persistedUnread ?? (this.isTowerPgMode
      ? Boolean(this._unreadThreadItems?.[row.id] || this.inboxUnreadThreads?.[row.id])
      : Boolean(this._unreadChannels?.[row.channelId]))) }))
      .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || a.id.localeCompare(b.id));
  },
  syncPinnedThreadsContext(partition) {
    const queryKey = JSON.stringify([partition, getCurrentWorkspaceDbKey()]);
    if (subscriptions.get(this)?.key === queryKey) return;
    subscriptions.get(this)?.subscription?.unsubscribe();
    this.pinnedThreadRows = [];
    this.pinnedThreadsContext = partition;
    this.pinnedThreadsError = '';
    subscriptions.set(this, { key: queryKey });
    if (!partition || !getCurrentWorkspaceDbKey()) return;
    const db = getWorkspaceDb();
    const subscription = liveQuery(async () => getPinnedThreadRows(db, (await getSettings())?.threadPins?.[partition])).subscribe({
      next: rows => { if (this.pinnedThreadsPartition === partition && subscriptions.get(this)?.key === queryKey) this.pinnedThreadRows = rows; },
      error: () => { if (this.pinnedThreadsPartition === partition) this.pinnedThreadsError = 'Could not load pinned threads. Switch workspace to retry.'; },
    });
    subscriptions.set(this, { key: queryKey, subscription });
  },
  isThreadPinned(id) { return this.pinnedThreads.some(row => row.id === id); },
  async toggleThreadPin(thread) {
    const partition = this.pinnedThreadsPartition;
    const key = JSON.stringify([partition, thread.id]);
    if (this.threadPinSaving[key]) return;
    this.threadPinSaving = { ...this.threadPinSaving, [key]: true };
    const pinned = !this.isThreadPinned(thread.id);
    try {
      await saveThreadPin(partition, thread, pinned);
      if (partition === this.pinnedThreadsPartition) this.pinnedThreadsError = '';
    } catch (error) {
      if (partition === this.pinnedThreadsPartition) this.pinnedThreadsError = error.message || 'Could not save pin. Try again.';
    } finally {
      const next = { ...this.threadPinSaving };
      delete next[key];
      this.threadPinSaving = next;
    }
  },
  async openPinnedThread(thread) {
    if (thread.unavailable || !this.isThreadPinned(thread.id)) return false;
    return this.openAutopilotOverviewThread(thread);
  },
};
