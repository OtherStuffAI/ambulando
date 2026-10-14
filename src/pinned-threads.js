import { resolvePgReaderActorId } from './pg-reader-identity.js';
import { queueThreadPin, readThreadPinProjection, threadPinContext, threadPinSupportKey, threadPinMigrationKey } from './thread-pin-store.js';
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
      ? (!row.type || row.type === 'thread') && Boolean(this._unreadThreadItems?.[row.id] || this.inboxUnreadThreads?.[row.id])
      : Boolean(this._unreadChannels?.[row.channelId]))) }))
      .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || (a.key || a.id).localeCompare(b.key || b.id));
  },
  syncPinnedThreadsContext(partition) {
    const queryKey = JSON.stringify([partition, getCurrentWorkspaceDbKey(), resolvePgReaderActorId(this)]);
    if (subscriptions.get(this)?.key === queryKey) return;
    subscriptions.get(this)?.subscription?.unsubscribe();
    this.pinnedThreadRows = [];
    this.pinnedThreadsContext = partition;
    this.pinnedThreadsError = '';
    subscriptions.set(this, { key: queryKey });
    if (!partition || !getCurrentWorkspaceDbKey()) return;
    const db = getWorkspaceDb();
    const subscription = liveQuery(async () => {
      if (this.isTowerPgMode && resolveTowerPgWorkspaceContext(this).workspaceId) {
        return readThreadPinProjection(db, threadPinContext(this), partition);
      }
      return { rows: await getPinnedThreadRows(db, (await getSettings())?.threadPins?.[partition]), error: '' };
    }).subscribe({
      next: ({ rows, error }) => {
        if (this.pinnedThreadsPartition !== partition || subscriptions.get(this)?.key !== queryKey) return;
        const countChanged = this.pinnedThreadRows.length !== rows.length;
        this.pinnedThreadRows = rows;
        this.pinnedThreadsError = error;
        if (countChanged) this.syncPinnedThreadsLayout();
      },
      error: () => { if (this.pinnedThreadsPartition === partition) this.pinnedThreadsError = 'Could not load pinned threads. Switch workspace to retry.'; },
    });
    subscriptions.set(this, { key: queryKey, subscription });
  },
  syncPinnedThreadsLayout() {
    if (!this.deckMobileTrack || !this.deckMobileMediaQuery?.matches) return;
    const selected = this.deckMobileColumn === 'pinned' && !this.pinnedThreads.length ? 'inbox' : this.deckMobileColumn;
    this.deckMobileColumn = selected;
    requestAnimationFrame(() => { if (this.deckMobileMediaQuery?.matches) this.positionDeckMobileCard?.(selected); });
  },
  isPersonalPinned(type, id) { return this.pinnedThreads.some(row => (row.type || 'thread') === type && row.id === id); },
  isThreadPinned(id) { return this.isPersonalPinned('thread', id); },
  toggleThreadPin(thread) { return this.togglePersonalPin(thread, 'thread'); },
  async togglePersonalPin(resource, type = resource?.type || 'thread') {
    const thread = { ...resource, type, id: type === 'thread' ? resource?.id || resource?.recordId || resource?.record_id : resource?.recordId || resource?.record_id || resource?.id, channelId: resource?.channelId || resource?.pg_channel_id || resource?.channel_id || '' };
    const partition = this.pinnedThreadsPartition;
    const key = JSON.stringify([partition, type, thread.id]);
    if (this.threadPinSaving[key]) return;
    this.threadPinSaving = { ...this.threadPinSaving, [key]: true };
    const pinned = !this.isPersonalPinned(type, thread.id);
    try {
      if (this.isTowerPgMode && resolveTowerPgWorkspaceContext(this).workspaceId) {
        const db = getWorkspaceDb(), context = threadPinContext(this);
        if ((await db.sync_state.get(threadPinSupportKey(context)))?.value !== true) {
          if (type !== 'thread' || await db.sync_state.get(threadPinMigrationKey(partition))) await queueThreadPin(db, context, thread, pinned, type);
          else await saveThreadPin(partition, thread, pinned);
          this.pinnedThreadsError = 'Pins are saved on this device until Tower supports pin synchronization.';
          return;
        }
        await queueThreadPin(db, context, thread, pinned, type);
        void this.requestTowerSyncFamily?.('thread-pins').catch(error => {
          if (partition === this.pinnedThreadsPartition) this.pinnedThreadsError = error.message || 'Pin synchronization failed.';
        });
      } else {
        if (type !== 'thread') throw new Error('Pin tasks and documents from a connected Tower workspace.');
        await saveThreadPin(partition, thread, pinned);
      }
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
    const type = thread.type || 'thread';
    if (thread.unavailable || !this.isPersonalPinned(type, thread.id)) return false;
    if (type !== 'thread') return this.handleMentionNavigate(type === 'document' ? 'doc' : 'task', thread.id);
    return this.openAutopilotOverviewThread(thread);
  },
};
