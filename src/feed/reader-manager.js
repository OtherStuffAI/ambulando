import { createFeedSubscription, patchFeedSubscription, patchFeedItemState } from '../tower-command-intents.js';
import { getWorkspaceDb } from '../db.js';
import { readerContext, ensureFeedReaderIdentity } from './tower.js';
import { feedContextKey, feedProjection, feedRowKey, purgePrivateFeedBodies } from './store.js';
import { FeedSourceService } from './source-service.js';
import { FeedParser } from './parser.js';
import { defaultFeedConnectionTransport, discoverFeedApps, listWappFeeds, resolveSubscriptionSource } from './transport.js';
import { publicFeedUrl, safeFeedUrl } from './normalize.js';
const RUNTIMES = new WeakMap();
export const subscribedReaderMixin = {
  subscribedFeedView: 'legacy', subscribedFeedItems: [], subscribedFeedSources: [], subscribedFeedStatus: [], subscribedFeedError: '',
  feedPickerGeneration: 0, feedConnections: [], feedConnectionChoices: {}, feedAddStatus: '', feedAddOpen: false, feedAddBusy: false, feedApps: [], feedDiscoveryErrors: [], feedChoices: [], feedSelectedApp: '', publicFeedDraft: '', publicFeedFormat: 'jsonfeed-1.1', showDismissedFeeds: false,
  get visibleSubscribedFeedItems() { return this.subscribedFeedItems.filter(i => this.showDismissedFeeds || !i.dismissed).slice(0, 500); },
  startSubscribedReader() {
    const c = readerContext(this); if (!c.workspaceId || !c.readerActorId || !this.session) return;
    const context = feedContextKey(c), prior = RUNTIMES.get(this);
    if (prior?.context === context && prior.generation === c.generation && prior.sessionNpub === c.sessionNpub && !prior.disposed) return;
    this.disposeSubscribedReader({ preservePicker: true });
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
  disposeSubscribedReader({ preservePicker = false } = {}) {
    const runtime = RUNTIMES.get(this); if (runtime) { runtime.disposed = true; window.removeEventListener('pagehide', runtime.onLock); runtime.discovery?.abort(); runtime.subscription?.unsubscribe(); runtime.cleanup = runtime.source.dispose().catch(() => {}); runtime.parser.dispose(); RUNTIMES.delete(this); }
    this.subscribedFeedItems = []; this.subscribedFeedSources = []; this.subscribedFeedStatus = []; if (!preservePicker) { this.closeFeedAdd(); this.feedApps = []; this.feedChoices = []; this.feedDiscoveryErrors = []; this.feedConnectionChoices = {}; this.feedConnections = []; }
    return runtime ? Promise.allSettled([runtime.ready, runtime.cleanup]) : Promise.resolve();
  },
  async selectSubscribedFeedView(view) {
    this.subscribedFeedView = view; if (view !== 'subscribed') return;
    await this.runFeedIntent(async () => { await ensureFeedReaderIdentity(this); this.startSubscribedReader(); await this.requestTowerSyncFamily('feed-reader', '', { force: true }); });
  },
  async runFeedIntent(run, current = () => true) { this.subscribedFeedError = ''; try { return await run(); } catch (e) { if (!current()) return null;  this.subscribedFeedError = e.status === 404 ? (e.feedSource ? 'This app does not expose feeds. Choose another app or ask its maintainer to enable feeds.' : 'Feed reader APIs are unavailable on this Tower source build.') : e.status === 401 || e.status === 403 ? (e.feedSource ? 'This app denied feed access to your signed-in identity. Check its reader access, then retry.' : 'Feed access denied. Sign in with an authorised reader.') : e.message === 'reader_identity_pending' ? 'Your reader identity is still connecting. Retry when signed in to this workspace.' : e.message === 'feed_disposed' ? 'Your workspace or identity changed. Open Feed again to continue.' : e.message === 'unsupported_source_transport' ? 'This app has no registered FIPS feed endpoint. Choose HTTPS for this connection to read its feeds.' : e.message === 'unsafe_graph_target' ? 'The source graph target does not match this workspace registration.' : e instanceof TypeError ? 'Cannot reach this feed. Check the source connection and its browser CORS settings, then retry.' : e.name === 'AbortError' || e.name === 'TimeoutError' ? 'The feed request timed out. Retry to reconnect.' : e.message || 'Feed unavailable.'; return null; } },
  closeFeedAdd() { this.feedPickerGeneration++; RUNTIMES.get(this)?.discovery?.abort(); this.feedAddOpen = false; this.feedAddBusy = false; this.feedAddStatus = ''; },
  async openFeedAdd() {
    const generation = ++this.feedPickerGeneration, current = () => this.feedPickerGeneration === generation && this.feedAddOpen;
    this.feedAddOpen = true; this.feedAddBusy = true; this.feedAddStatus = 'Connecting your reader…'; this.feedApps = []; this.feedDiscoveryErrors = []; this.feedChoices = []; this.feedSelectedApp = '';
    await this.runFeedIntent(async () => {
      await ensureFeedReaderIdentity(this); if (!current()) return; this.startSubscribedReader();
      const runtime = RUNTIMES.get(this); if (!runtime) throw new Error('reader_identity_pending'); runtime.discovery?.abort(); const controller = new AbortController(); runtime.discovery = controller;
      let connections = await runtime.db.autopilot_connections.where('workspace_id').equals(readerContext(this).workspaceId).toArray();
      if (!connections.length && this.requestTowerSyncFamily) {
        await this.requestTowerSyncFamily('workspace-bootstrap', '', { force: true });
        connections = await runtime.db.autopilot_connections.where('workspace_id').equals(readerContext(this).workspaceId).toArray();
      }
      if (!current() || RUNTIMES.get(this) !== runtime) return;
      this.feedConnections = connections.filter(c => c.pg_backend && !c.archived_at);
      for (const connection of this.feedConnections) {
        const preference = await runtime.db.feed_connection_transports.get(JSON.stringify([runtime.context, connection.id]));
        this.feedConnectionChoices[connection.id] ||= preference?.transport || defaultFeedConnectionTransport(connection);
      }
      this.feedAddStatus = 'Finding apps from your Agents connections…';
      const result = await discoverFeedApps(connections, controller.signal, { connectionTransports: this.feedConnectionChoices });
      if (!current() || RUNTIMES.get(this) !== runtime || controller.signal.aborted) return;
      this.feedApps = result.apps.map(a => ({ ...a, key: JSON.stringify([a.connection.id, a.installation_id]) })); this.feedDiscoveryErrors = result.errors;
    }, current); if (current()) { this.feedAddBusy = false; this.feedAddStatus = ''; }
  },
  async setFeedConnectionTransport(connectionId, transport) {
    if (!['https', 'fips'].includes(transport)) return;
    this.feedConnectionChoices[connectionId] = transport;
    const runtime = RUNTIMES.get(this);
    if (runtime) await runtime.db.feed_connection_transports.put({ key: JSON.stringify([runtime.context, connectionId]), context: runtime.context, connection_id: connectionId, transport });
    await this.openFeedAdd();
  },
  async chooseFeedApp(key) {
    const generation = ++this.feedPickerGeneration, current = () => this.feedPickerGeneration === generation && this.feedAddOpen;
    this.feedSelectedApp = key; this.feedChoices = []; this.feedAddBusy = true; this.feedAddStatus = 'Loading available feeds…';
    await this.runFeedIntent(async () => { const runtime = RUNTIMES.get(this), app = this.feedApps.find(a => a.key === key); if (!runtime || !app) return;
      runtime.discovery?.abort(); const controller = new AbortController(); runtime.discovery = controller;
      let choices; try { choices = await listWappFeeds(app, controller.signal, readerContext(this)); } catch (e) {
        if ([401, 403, 404].includes(e.status)) for (const sub of this.subscribedFeedSources.filter(s => s.source.kind === 'wapp' && s.source.installation_id === app.installation_id && s.source.autopilot_connection_id === app.connection.id)) await runtime.source.revoke(sub.id);
        throw e;
      }
      if (current() && RUNTIMES.get(this) === runtime && !controller.signal.aborted && this.feedSelectedApp === key) this.feedChoices = choices;
    }, current); if (current()) { this.feedAddBusy = false; this.feedAddStatus = ''; }
  },
  async subscribeSelectedFeed(feed) {
    const app = this.feedApps.find(a => a.key === this.feedSelectedApp); if (!app) return;
    const runtime = RUNTIMES.get(this);
    if (runtime) await runtime.db.feed_connection_transports.put({ key: JSON.stringify([runtime.context, app.connection.id]), context: runtime.context, connection_id: app.connection.id, transport: app.transport });
    await this.subscribeFeedSource({ kind: 'wapp', autopilot_connection_id: app.connection.id, installation_id: app.installation_id, feed_id: feed.id, endpoint: feed.endpoint, format: feed.format }, feed.title);
  },
  async subscribePublicFeed() { await this.runFeedIntent(() => this.subscribeFeedSource({ kind: 'public', url: publicFeedUrl(this.publicFeedDraft.trim()), format: this.publicFeedFormat }, '')); },
  async subscribeFeedSource(source, title) {
    this.feedAddBusy = true; this.feedAddStatus = 'Saving your subscription…';
    await this.runFeedIntent(async () => {
      await ensureFeedReaderIdentity(this); this.startSubscribedReader();
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
      const runtime = RUNTIMES.get(this); if (!runtime) throw new Error('reader_identity_pending');
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
  feedSourceStatus(id) { const status = this.subscribedFeedStatus.find(s => s.subscription_id === id); const errors = { unsafe_graph_target: 'The source graph binding does not match this workspace registration. Ask the app maintainer to check its feed setup.', unsupported_source_transport: 'This app has no registered FIPS feed endpoint. Choose HTTPS for this connection.', registry_revoked: 'This app or Autopilot connection is no longer available. Reconnect in Agents, then retry.', feed_http_401: 'The source needs fresh reader authentication. Sign in and refresh.', feed_http_403: 'The source denied access to your reader identity. Check its reader permissions.', feed_http_404: 'This app does not expose the selected feed.', source_unavailable: 'The source is unavailable. Check its connection and retry.', feed_timeout: 'The source request timed out. Refresh to retry.' }; return (errors[status?.error] || status?.error) || (status?.stale ? 'Stale' : status?.last_success ? `Updated ${new Date(status.last_success).toLocaleTimeString()}` : 'Waiting for source'); },
};
