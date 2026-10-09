import { createFeedSubscription, patchFeedSubscription, patchFeedItemState } from '../tower-command-intents.js';
import { getWorkspaceDb } from '../db.js';
import { readerContext, ensureFeedReaderIdentity } from './tower.js';
import { feedContextKey, feedProjection, feedRowKey, purgePrivateFeedBodies } from './store.js';
import { FeedSourceService, validateFeedSource } from './source-service.js';
import { FeedParser } from './parser.js';
import { resolveSubscriptionSource, resolveFeedUrlSource } from './transport.js';
import { publicFeedUrl, safeFeedUrl } from './normalize.js';
const RUNTIMES = new WeakMap();
export const subscribedReaderMixin = {
  subscribedFeedItems: [], subscribedFeedSources: [], subscribedFeedStatus: [], subscribedFeedError: '',
  feedManualGeneration: 0, feedAddOpen: false, feedManualBusy: false, feedManualStatus: '', publicFeedDraft: '', showDismissedFeeds: false,
  get visibleSubscribedFeedItems() { return this.subscribedFeedItems.filter(i => this.showDismissedFeeds || !i.dismissed).slice(0, 500); },
  startSubscribedReader() {
    const c = readerContext(this); if (!c.workspaceId || !c.readerActorId || !this.session) return;
    const context = feedContextKey(c), prior = RUNTIMES.get(this);
    if (prior?.context === context && prior.generation === c.generation && prior.sessionNpub === c.sessionNpub && !prior.disposed) return;
    this.disposeSubscribedReader({ preserveAddForm: true });
    const db = getWorkspaceDb(), parser = new FeedParser();
    const runtime = { context, generation: c.generation, sessionNpub: c.sessionNpub, db, parser, disposed: false, validation: null, subscription: null, registry: new Map() };
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
        const bindings = await db.wapps.toArray();
        return { ...p, connections, bindings };
      }, async p => {
        if (!current()) return;
        this.subscribedFeedItems = p.items; this.subscribedFeedSources = p.subscriptions; this.subscribedFeedStatus = p.statuses;
        const bindingFingerprint = JSON.stringify(p.bindings.filter(w => w.metadata?.feed_binding).map(w => [w.record_id, w.app_id, w.launch_url, w.status, w.record_state, w.metadata.feed_binding]));
        if (runtime.bindingFingerprint && runtime.bindingFingerprint !== bindingFingerprint) for (const sub of p.subscriptions.filter(s => s.source.kind === 'wapp')) await runtime.source.revoke(sub.id);
        runtime.bindingFingerprint = bindingFingerprint;
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
  disposeSubscribedReader({ preserveAddForm = false } = {}) {
    const runtime = RUNTIMES.get(this); if (runtime) { runtime.disposed = true; window.removeEventListener('pagehide', runtime.onLock); runtime.validation?.abort(); runtime.subscription?.unsubscribe(); runtime.cleanup = runtime.source.dispose().catch(() => {}); runtime.parser.dispose(); RUNTIMES.delete(this); }
    this.subscribedFeedItems = []; this.subscribedFeedSources = []; this.subscribedFeedStatus = []; if (!preserveAddForm) this.closeFeedAdd();
    return runtime ? Promise.allSettled([runtime.ready, runtime.cleanup]) : Promise.resolve();
  },
  async activateFeeds() {
    if (!this.session || !readerContext(this).workspaceId) return;
    const initial = readerContext(this), current = () => {
      const c = readerContext(this);
      return c.baseUrl === initial.baseUrl && c.workspaceId === initial.workspaceId && c.sessionNpub === initial.sessionNpub && c.generation === initial.generation;
    };
    await this.runFeedIntent(async () => {
      await ensureFeedReaderIdentity(this); if (!current()) return;
      this.startSubscribedReader();
      await this.requestTowerSyncFamily?.('feed-reader');
    }, current);
  },
  async runFeedIntent(run, current = () => true) { this.subscribedFeedError = ''; try { return await run(); } catch (e) { if (!current()) return null;  this.subscribedFeedError = e.status === 404 ? (e.feedSource ? 'This app does not expose feeds. Check the feed URL or contact its maintainer.' : 'Feed reader APIs are unavailable on this Tower source build.') : e.status === 401 || e.status === 403 ? (e.feedSource ? 'This source denied feed access to your signed-in identity. Check its reader access, then retry.' : 'Feed access denied. Sign in with an authorised reader.') : e.message === 'reader_identity_pending' ? 'Your reader identity is still connecting. Retry when signed in to this workspace.' : e.message === 'feed_disposed' ? 'Your workspace or identity changed. Open Feeds again to continue.' : e.message === 'unsupported_source_transport' ? 'This app has no registered FIPS feed endpoint. Choose HTTPS for this connection to read its feeds.' : e.message === 'unsafe_graph_target' ? 'The source graph target does not match this workspace registration.' : e.message === 'authenticated_feed_unavailable' ? 'This private source has no available authorization binding for this URL. Check source access with its maintainer.' : e.message === 'feed_http_401' || e.message === 'feed_http_403' ? 'The source denied access. Sign in with an authorized reader or check its permissions.' : e.message === 'unsupported_content_type' ? 'This URL did not return a JSON Feed or RSS document.' : e instanceof TypeError ? 'Cannot reach this feed. Check the source connection and its browser CORS settings, then retry.' : e.name === 'AbortError' || e.name === 'TimeoutError' ? 'The feed request timed out. Retry to reconnect.' : e.message || 'Feed unavailable.'; return null; } },
  closeFeedAdd() { this.feedManualGeneration++; RUNTIMES.get(this)?.validation?.abort(); this.feedAddOpen = false; this.feedManualBusy = false; this.feedManualStatus = ''; },
  openFeedAdd() { this.feedAddOpen = true; this.subscribedFeedError = ''; },
  async subscribePublicFeed() {
    if (this.feedManualBusy) return;
    const generation = ++this.feedManualGeneration, initial = readerContext(this);
    const current = () => {
      const c = readerContext(this);
      return this.feedAddOpen && this.feedManualGeneration === generation && c.baseUrl === initial.baseUrl && c.workspaceId === initial.workspaceId && c.sessionNpub === initial.sessionNpub && c.generation === initial.generation;
    };
    this.feedManualBusy = true; this.feedManualStatus = 'Checking feed access…';
    try { await this.runFeedIntent(async () => {
      let url; try { url = publicFeedUrl(this.publicFeedDraft.trim()); } catch { throw new Error('Enter an absolute HTTP(S) feed URL without credentials.'); }
      await ensureFeedReaderIdentity(this); if (!current()) return; this.startSubscribedReader();
      const runtime = RUNTIMES.get(this); if (!runtime) throw new Error('reader_identity_pending');
      runtime.validation?.abort(); const controller = new AbortController(); runtime.validation = controller;
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const resolved = await resolveFeedUrlSource(url, controller.signal, readerContext(this), { db: runtime.db });
        if (!current()) return;
        const validated = await validateFeedSource(resolved.source, resolved.binding, controller.signal, (...args) => runtime.parser.parse(...args));
        if (!current() || RUNTIMES.get(this) !== runtime) return;
        this.feedManualStatus = 'Saving feed…';
        await this.subscribeFeedSource({ ...resolved.source, format: validated.format }, validated.title, current);
      } finally { clearTimeout(timer); }
    }, current); } finally { if (this.feedManualGeneration === generation) { this.feedManualBusy = false; this.feedManualStatus = ''; } }
  },
  async subscribeFeedSource(source, title, current = () => true) {
    await this.runFeedIntent(async () => {
      await ensureFeedReaderIdentity(this); if (!current()) return; this.startSubscribedReader();
      const mutation_id = crypto.randomUUID();
      const result = await createFeedSubscription(this, { clientMutationId: mutation_id, body: { mutation_id, expected_row_version: 0, source, ...(title ? { title } : {}) } });
      if (result && !result.stale && current()) this.closeFeedAdd();
    }, current);
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
    await this.runFeedIntent(async () => { await this.activateFeeds(); await this.requestTowerSyncFamily('feed-reader', '', { force: true }); const runtime = RUNTIMES.get(this); if (!runtime) return; await Promise.allSettled(this.subscribedFeedSources.filter(s => s.status === 'active').map(s => runtime.source.refresh(s.id, { revalidate: true }))); });
  },
  feedSourceStatus(id) { const status = this.subscribedFeedStatus.find(s => s.subscription_id === id); const errors = { unsafe_graph_target: 'The source graph binding does not match this workspace registration. Ask the app maintainer to check its feed setup.', unsupported_source_transport: 'This app has no registered FIPS feed endpoint. Choose HTTPS for this connection.', registry_revoked: 'This app or Autopilot connection is no longer available. Reconnect in Agents, then retry.', feed_http_401: 'The source needs fresh reader authentication. Sign in and refresh.', feed_http_403: 'The source denied access to your reader identity. Check its reader permissions.', feed_http_404: 'This app does not expose the selected feed.', source_unavailable: 'The source is unavailable. Check its connection and retry.', feed_timeout: 'The source request timed out. Refresh to retry.' }; return (errors[status?.error] || status?.error) || (status?.stale ? 'Stale' : status?.last_success ? `Updated ${new Date(status.last_success).toLocaleTimeString()}` : 'Waiting for source'); },
};
