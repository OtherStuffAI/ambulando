import { withNostrActorName } from './nostr-display.js';
import { getWorkspaceDb, isWorkspaceDbOpenForKey, getSharedDb } from '../db.js';
import { nip19 } from 'nostr-tools';
const RUNTIMES = new WeakMap();
const partition = (store) => JSON.stringify([store.currentWorkspaceKey, store.session?.npub]);
export async function persistNostrNotification(db, context, row, current = () => true) {
  await db.transaction('rw', db.nostr_notifications, db.nostr_notification_states, async () => {
    if (!current()) return;
    const key = JSON.stringify([context, row.id]),
      prior = await db.nostr_notification_states.get(key);
    await db.nostr_notifications.put({
      ...row,
      key,
      context,
      read: prior?.read || false,
      saved: prior?.saved || false,
      dismissed: prior?.dismissed || false,
    });
    const rows = await db.nostr_notifications.where('context').equals(context).toArray();
    const flags = new Map(
      (await db.nostr_notification_states.where('context').equals(context).toArray()).map(
        (state) => [state.key, state],
      ),
    );
    const evict = rows
      .sort(
        (a, b) =>
          Number(flags.get(b.key)?.saved || false) - Number(flags.get(a.key)?.saved || false) ||
          b.published.localeCompare(a.published),
      )
      .slice(500);
    if (evict.length) await db.nostr_notifications.bulkDelete(evict.map((r) => r.key));
  });
}
export const nostrNotificationsMixin = {
  nostrNotificationItems: [],
  nostrNotificationStatus: '',
  nostrNotificationContext: '',
  feedSourceFilter: 'all',
  startNostrNotifications() {
    let recipient;
    try {
      const decoded = nip19.decode(this.session?.npub || '');
      if (decoded.type !== 'npub') {
        this.disposeNostrNotifications();
        return;
      }
      recipient = decoded.data;
    } catch {
      this.disposeNostrNotifications();
      return;
    }
    if (!this.currentWorkspaceKey || !isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) {
      this.disposeNostrNotifications();
      return;
    }
    const context = partition(this);
    const db = getWorkspaceDb();
    const existing = RUNTIMES.get(this);
    if (existing?.context === context && existing.db === db) return;
    this.disposeNostrNotifications();
    let worker;
    try {
      worker = new Worker(new URL('../worker/nostr-notifications-worker.js', import.meta.url), {
        type: 'module',
      });
    } catch {
      this.nostrNotificationStatus = 'Nostr worker unavailable. Refresh to retry.';
      return;
    }
    const runtime = { context, db, worker },
      current = () =>
        RUNTIMES.get(this) === runtime &&
        partition(this) === context &&
        isWorkspaceDbOpenForKey(this.currentWorkspaceKey) &&
        getWorkspaceDb() === db;
    RUNTIMES.set(this, runtime);
    this.nostrNotificationContext = context;
    this.nostrNotificationStatus = 'Loading recent Nostr notifications…';
    runtime.subscription = this.createLiveSubscription(
      async () => {
        const [rows, states] = await Promise.all([
          db.nostr_notifications.where('context').equals(context).toArray(),
          db.nostr_notification_states.where('context').equals(context).toArray(),
        ]);
        const flags = new Map(states.map((row) => [row.key, row]));
        return rows.map((row) => ({ ...row, ...flags.get(row.key) }));
      },
      (rows) => {
        if (current())
          this.nostrNotificationItems = rows.sort((a, b) => b.published.localeCompare(a.published));
      },
    );
    const fail = (message) => {
      if (!current() || runtime.failed) return;
      runtime.failed = true;
      clearTimeout(runtime.startupDeadline);
      worker.terminate();
      // Keep the live cache and flag writer attached until explicit retry/logout.
      this.nostrNotificationStatus = message;
    };
    runtime.startupDeadline = setTimeout(() => {
      fail('Nostr worker did not start. Cached notifications remain; refresh to retry.');
    }, 10000);
    worker.onmessage = async ({ data }) => {
      if (!current() || runtime.failed) return;
      if (data.phase === 'discovery') {
        clearTimeout(runtime.startupDeadline);
        runtime.startupDeadline = setTimeout(() => {
          fail('Nostr relay discovery timed out. Cached notifications remain; refresh to retry.');
        }, 10000);
      } else if (data.phase === 'listening') clearTimeout(runtime.startupDeadline);
      if (data.status) this.nostrNotificationStatus = data.status;
      if (data.row?.recipient === recipient) {
        let row = data.row;
        if (!row.actorName) {
          const cached = await getSharedDb()
            .profiles.get(row.actorNpub)
            .catch(() => null);
          if (!current()) return;
          const profile =
            cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000
              ? cached.profile
              : this.chatProfiles?.[row.actorNpub];
          row = withNostrActorName(row, profile?.display_name || profile?.name);
        }
        void persistNostrNotification(db, context, row, current).catch(() => {
          if (current())
            this.nostrNotificationStatus = 'Nostr cache unavailable. Refresh to retry.';
        });
      }
    };
    worker.onerror = () =>
      fail('Nostr worker unavailable. Cached notifications remain; refresh to retry.');
    worker.onmessageerror = () =>
      fail('Nostr worker message unavailable. Cached notifications remain; refresh to retry.');
    runtime.stop = (event) => {
      this.disposeNostrNotifications();
      if (event?.persisted)
        window.addEventListener('pageshow', () => this.startNostrNotifications(), { once: true });
    };
    window.addEventListener('pagehide', runtime.stop);
    runtime.identityWatch = setInterval(() => {
      if (!current()) runtime.stop();
    }, 250);
    try {
      // Alpine wraps persisted workspace arrays in proxies. postMessage cannot
      // clone those, even an empty relay array; send a plain transport snapshot.
      const configuredRelays = this.currentWorkspace?.relayUrls;
      const relays = Array.isArray(configuredRelays)
        ? Array.from(configuredRelays).filter((relay) => typeof relay === 'string')
        : [];
      worker.postMessage({ action: 'start', recipient, relays });
    } catch {
      fail('Could not start Nostr worker. Cached notifications remain; refresh to retry.');
    }
  },
  disposeNostrNotifications() {
    const runtime = RUNTIMES.get(this);
    RUNTIMES.delete(this);
    if (runtime) {
      clearTimeout(runtime.startupDeadline);
      clearInterval(runtime.identityWatch);
      runtime.subscription?.unsubscribe();
      runtime.worker.terminate();
      window.removeEventListener('pagehide', runtime.stop);
    }
    this.nostrNotificationItems = [];
    this.nostrNotificationContext = '';
    this.nostrNotificationStatus = '';
  },
  refreshNostrNotifications() {
    this.disposeNostrNotifications();
    this.startNostrNotifications();
  },
  async setNostrFeedFlag(item, field, value) {
    const runtime = RUNTIMES.get(this);
    if (
      !runtime ||
      runtime.context !== partition(this) ||
      item.context !== runtime.context ||
      !['read', 'saved', 'dismissed'].includes(field) ||
      typeof value !== 'boolean'
    )
      return;
    try {
      await runtime.db.transaction(
        'rw',
        runtime.db.nostr_notifications,
        runtime.db.nostr_notification_states,
        async () => {
          if (RUNTIMES.get(this) !== runtime || runtime.context !== partition(this)) return;
          const row = await runtime.db.nostr_notifications.get(item.key);
          if (row?.context === runtime.context) {
            const prior = await runtime.db.nostr_notification_states.get(item.key);
            await runtime.db.nostr_notification_states.put({
              ...prior,
              key: item.key,
              context: runtime.context,
              [field]: value,
            });
          }
        },
      );
    } catch {
      if (RUNTIMES.get(this) === runtime)
        this.nostrNotificationStatus = 'Could not save notification state. Refresh to retry.';
    }
  },
  get visibleNostrNotifications() {
    return this.nostrNotificationContext === partition(this) ? this.nostrNotificationItems : [];
  },
};
