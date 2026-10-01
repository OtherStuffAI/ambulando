import { createFeedSubscription, patchFeedSubscription, patchFeedItemState } from '../tower-command-intents.js';
import { getWorkspaceDb } from '../db.js';
import { readerContext } from './tower.js';
import { feedContextKey, feedProjection, feedRowKey, purgePrivateFeedBodies } from './store.js';
import { FeedSourceService } from './source-service.js';
import { FeedParser } from './parser.js';
import { discoverFeedApps, listWappFeeds, resolveSubscriptionSource } from './transport.js';
import { publicFeedUrl, safeFeedUrl } from './normalize.js';
const RUNTIMES = new WeakMap();
export const subscribedReaderMixin = {
  subscribedFeedView: 'legacy', subscribedFeedItems: [], subscribedFeedSources: [], subscribedFeedStatus: [], subscribedFeedError: '',
  feedDiscoveryHttps: false, feedAddOpen: false, feedAddBusy: false, feedApps: [], feedDiscoveryErrors: [], feedChoices: [], feedSelectedApp: '', publicFeedDraft: '', publicFeedFormat: 'jsonfeed-1.1', showDismissedFeeds: false,
  get visibleSubscribedFeedItems() { return this.subscribedFeedItems.filter(i => this.showDismissedFeeds || !i.dismissed).slice(0, 500); },
  startSubscribedReader() {
    const c = readerContext(this); if (!c.workspaceId || !c.readerActorId || !this.session) return;
    const context = feedContextKey(c), prior = RUNTIMES.get(this);
    if (prior?.context === context && prior.generation === c.generation && prior.sessionNpub === c.sessionNpub && !prior.disposed) return;
    this.disposeSubscribedReader();
    const db = getWorkspaceDb(), parser = new FeedParser();
    const runtime = { context, generation: c.generation, sessionNpub: c.sessionNpub, db, parser, disposed: false, discovery: null, subscription: null, registry: new Map() };
    const current = () => RUNTIMES.get(this) === runtime && !runtime.disposed && feedContextKey(readerContext(this)) === context && readerContext(this).generation === c.generation && this.session?.npub === c.sessionNpub;
    runtime.source = new FeedSourceService({ db, context, resolve: (sub, signal) => resolveSubscriptionSource(sub, signal, c, { db }), parse: (...args) => parser.parse(...args) });
    runtime.onLock = () => this.disposeSubscribedReader();
    window.addEventListener('pagehide', runtime.onLock);
    RUNTIMES.set(this, runtime);
    // No private offline archive: each activation starts with fresh authorization.
    runtime.ready = purgePrivateFeedBodies(db, context).then(() => {
      if (!current()) return;
      runtime.subscription = this.createLiveSubscription(async () => {
        const p = await feedProjection(db, context);
        const connections = await db.autopilot_connections.where('workspace_id').equals(c.workspaceId).toArray();
        return { ...p, connections };
      }, async p => {
        if (!current()) return;
        this.subscribedFeedItems = p.items; this.subscribedFeedSources = p.subscriptions; this.subscribedFeedStatus = p.statuses;
        for (const con of p.connections) {
          const fingerprint = JSON.stringify([con.https_endpoint, con.fips_endpoint, con.archived_at, con.row_version]);
          if (runtime.registry.has(con.id) && runtime.registry.get(con.id) !== fingerprint) for (const sub of p.subscriptions.filter(s => s.source.kind === 'wapp' && s.source.autopilot_connection_id === con.id)) await runtime.source.revoke(sub.id);
          runtime.registry.set(con.id, fingerprint);
        }
        for (const sub of p.subscriptions.filter(s => s.status === 'active' && s.source.kind === 'wapp')) {
          if (!p.connections.some(con => con.id === sub.source.autopilot_connection_id && con.pg_backend && !con.archived_at)) await runtime.source.revoke(sub.id);
        }
        if (current()) await runtime.source.update(p.subscriptions);
      });
    }).catch(e => { if (current()) this.subscribedFeedError = e.message; });
  },
  lockSubscribedReader() { this.disposeSubscribedReader(); },
  disposeSubscribedReader() {
    const runtime = RUNTIMES.get(this); if (runtime) { runtime.disposed = true; window.removeEventListener('pagehide', runtime.onLock); runtime.discovery?.abort(); runtime.subscription?.unsubscribe(); void runtime.source.dispose(); runtime.parser.dispose(); RUNTIMES.delete(this); }
    this.subscribedFeedItems = []; this.subscribedFeedSources = []; this.subscribedFeedStatus = []; this.feedApps = []; this.feedChoices = []; this.feedAddOpen = false;
  },
  async selectSubscribedFeedView(view) {
    this.subscribedFeedView = view; if (view !== 'subscribed') return;
    this.startSubscribedReader(); await this.runFeedIntent(() => this.requestTowerSyncFamily('feed-reader', '', { force: true }));
  },
  async runFeedIntent(run) { this.subscribedFeedError = ''; try { return await run(); } catch (e) { if ([401, 403].includes(e.status)) this.disposeSubscribedReader(); this.subscribedFeedError = e.status === 404 ? 'Feed reader APIs are unavailable on this Tower source build.' : e.status === 401 || e.status === 403 ? 'Feed access denied. Sign in with an authorised reader.' : e.message === 'unsupported_source_transport' ? 'This source transport is not supported by the feed reader yet.' : e.message === 'unsafe_graph_target' ? 'The source graph target does not match this workspace registration.' : e.message || 'Feed unavailable.'; return null; } },
  async openFeedAdd() {
    this.startSubscribedReader(); this.feedAddOpen = true; this.feedAddBusy = true; this.feedChoices = []; this.feedSelectedApp = '';
    await this.runFeedIntent(async () => {
      const runtime = RUNTIMES.get(this); if (!runtime) throw new Error('reader_identity_required'); runtime.discovery?.abort(); const controller = new AbortController(); runtime.discovery = controller;
      const connections = await runtime.db.autopilot_connections.where('workspace_id').equals(readerContext(this).workspaceId).toArray();
      const result = await discoverFeedApps(connections, controller.signal, { discoveryTransport: this.feedDiscoveryHttps ? 'https' : undefined });
      if (RUNTIMES.get(this) !== runtime || controller.signal.aborted) return;
      this.feedApps = result.apps.map(a => ({ ...a, key: JSON.stringify([a.connection.id, a.installation_id]) })); this.feedDiscoveryErrors = result.errors;
    }); this.feedAddBusy = false;
  },
  async chooseFeedApp(key) {
    this.feedSelectedApp = key; this.feedChoices = []; this.feedAddBusy = true;
    await this.runFeedIntent(async () => { const runtime = RUNTIMES.get(this), app = this.feedApps.find(a => a.key === key); if (!runtime || !app) return;
      runtime.discovery?.abort(); const controller = new AbortController(); runtime.discovery = controller;
      let choices; try { choices = await listWappFeeds(app, controller.signal, readerContext(this)); } catch (e) {
        if ([401, 403, 404].includes(e.status)) for (const sub of this.subscribedFeedSources.filter(s => s.source.kind === 'wapp' && s.source.installation_id === app.installation_id && s.source.autopilot_connection_id === app.connection.id)) await runtime.source.revoke(sub.id);
        throw e;
      }
      if (RUNTIMES.get(this) === runtime && !controller.signal.aborted && this.feedSelectedApp === key) this.feedChoices = choices;
    }); this.feedAddBusy = false;
  },
  async subscribeSelectedFeed(feed) {
    const app = this.feedApps.find(a => a.key === this.feedSelectedApp); if (!app) return;
    const runtime = RUNTIMES.get(this);
    if (runtime && this.feedDiscoveryHttps) await runtime.db.feed_connection_transports.put({ key: JSON.stringify([runtime.context, app.connection.id]), context: runtime.context, connection_id: app.connection.id, transport: 'https' });
    await this.subscribeFeedSource({ kind: 'wapp', autopilot_connection_id: app.connection.id, installation_id: app.installation_id, feed_id: feed.id, endpoint: feed.endpoint, format: feed.format }, feed.title);
  },
  async subscribePublicFeed() { await this.runFeedIntent(() => this.subscribeFeedSource({ kind: 'public', url: publicFeedUrl(this.publicFeedDraft.trim()), format: this.publicFeedFormat }, '')); },
  async subscribeFeedSource(source, title) {
    this.feedAddBusy = true;
    await this.runFeedIntent(async () => {
      const mutation_id = crypto.randomUUID();
      const result = await createFeedSubscription(this, { clientMutationId: mutation_id, body: { mutation_id, expected_row_version: 0, source, ...(title ? { title } : {}) } });
      if (result && !result.stale) { this.feedAddOpen = false; this.subscribedFeedView = 'subscribed'; }
    }); this.feedAddBusy = false;
  },
  async setFeedSubscriptionStatus(sub, status) {
    await this.runFeedIntent(async () => {
      const runtime = RUNTIMES.get(this); if (status === 'unsubscribed') await runtime?.source.revoke(sub.id);
      const mutation_id = crypto.randomUUID();
      await patchFeedSubscription(this, { subscriptionId: sub.id, clientMutationId: mutation_id, body: { mutation_id, expected_row_version: sub.row_version, patch: { status } } });
    });
  },
  async setFeedFlag(item, field, value) {
    if (!['read', 'dismissed', 'saved'].includes(field)) return;
    await this.runFeedIntent(async () => {
      const runtime = RUNTIMES.get(this); if (!runtime) throw new Error('reader_identity_required');
      const row = await runtime.db.feed_item_states.get(feedRowKey(runtime.context, item.subscription_id, item.id));
      const mutation_id = crypto.randomUUID();
      await patchFeedItemState(this, { subscriptionId: item.subscription_id, clientMutationId: mutation_id, body: { mutation_id, expected_row_version: row?.row_version || 0, item_id: item.id, patch: { [field]: value } } });
    });
  },
  openFeedItem(item) {
    if (!item.url) return; let url; try { url = safeFeedUrl(item.url); } catch { return; }
    // Exactly one window open, synchronously within the intentional click.
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  async refreshSubscribedFeed() {
    await this.runFeedIntent(async () => { await this.requestTowerSyncFamily('feed-reader', '', { force: true }); const runtime = RUNTIMES.get(this); if (!runtime) return; await Promise.allSettled(this.subscribedFeedSources.filter(s => s.status === 'active').map(s => runtime.source.refresh(s.id, { revalidate: true }))); });
  },
  feedSourceStatus(id) { const status = this.subscribedFeedStatus.find(s => s.subscription_id === id); return status?.error || (status?.stale ? 'Stale' : status?.last_success ? `Updated ${new Date(status.last_success).toLocaleTimeString()}` : 'Waiting for source'); },
};
