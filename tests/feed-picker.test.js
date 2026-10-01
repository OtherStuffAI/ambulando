import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const sign = vi.hoisted(() => vi.fn(async () => 'Nostr test-reader'));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: sign, createNip98AuthHeaderForSecret: vi.fn() }));
vi.mock('../src/feed/parser.js', () => ({ FeedParser: class { dispose() {} } }));
import { openWorkspaceDb } from '../src/db.js';
import { subscribedReaderMixin } from '../src/feed/reader-manager.js';
let db, s;
const connection = { id: 'connection', workspace_id: 'workspace', pg_backend: true, display_name: 'Agents connection', fips_endpoint: 'http://npub-node.fips:3601', fips_transport_npub: 'npub-node', https_endpoint: 'https://autopilot.example' };
const registry = { wapps: [{ wappInstallationId: '00000000-0000-4000-8000-000000000001', title: 'Book of Sand', launchUrl: 'https://book.example', appNpub: 'app' }, { wappInstallationId: '00000000-0000-4000-8000-000000000002', title: 'Removed app', launchUrl: 'https://removed.example', recordState: 'deleted' }] };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  db = await openWorkspaceDb(`picker-${crypto.randomUUID()}`);
  s = { ...subscribedReaderMixin, feedConnectionChoices: {}, session: { npub: 'reader' }, backendUrl: 'https://tower.example', currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', pgSessionNpub: 'reader', pgMe: { actor: { actor_id: 'actor', npub: 'reader' } } }, createLiveSubscription: vi.fn(() => ({ unsubscribe: vi.fn() })) };
  await db.autopilot_connections.put(connection);
});
afterEach(async () => { await s.disposeSubscribedReader(); await db.delete(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('Feed picker canonical cache/session flow', () => {
  it('discovers existing Agents connections with registered HTTPS in the browser, selects Editions and saves the shared connection tuple', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push([url, init]);
      if (url.endsWith('/api/wapps')) return Response.json(registry);
      if (url.endsWith('/api/feed/read-targets')) return Response.json({ graph_read_targets: { stories: 'https://tower.example/api/v4/graph/nodes?workspace_owner_npub=owner&source_app_npub=app&visibility=personal&label=Story&limit=200&offset=0', history: 'https://tower.example/api/v4/graph/nodes?workspace_owner_npub=owner&source_app_npub=app&visibility=personal&label=Reference&limit=200&offset=0' } });
      return Response.json({ contract_version: 1, feeds: [{ id: 'editions', title: 'Editions', description: 'Completed editions', endpoint: '/feed/editions', format: 'jsonfeed-1.1' }], next_cursor: null });
    }));
    await s.openFeedAdd(); expect(s.feedAddOpen).toBe(true); expect(s.feedApps).toHaveLength(1); expect(s.feedAddBusy).toBe(false);
    expect(s.feedConnectionChoices.connection).toBe('https'); expect(requests[0][0]).toBe('https://autopilot.example/api/wapps');
    await s.chooseFeedApp(s.feedApps[0].key); expect(s.feedChoices[0].id).toBe('editions');
    expect(sign).toHaveBeenCalledTimes(5); expect(requests.at(-1)[1].headers['X-Tower-Stories-Authorization']).toBe('Nostr test-reader');
    s.subscribeFeedSource = vi.fn(); await s.subscribeSelectedFeed(s.feedChoices[0]);
    expect(s.subscribeFeedSource).toHaveBeenCalledWith({ kind: 'wapp', autopilot_connection_id: 'connection', installation_id: registry.wapps[0].wappInstallationId, feed_id: 'editions', endpoint: '/feed/editions', format: 'jsonfeed-1.1' }, 'Editions');
  });
  it('recovers a discovery network/CORS failure without discarding the reader or closing the dialog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await s.openFeedAdd(); expect(s.feedAddOpen).toBe(true); expect(s.feedDiscoveryErrors[0].error).toContain('CORS'); expect(s.feedAddBusy).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(registry))); await s.openFeedAdd(); expect(s.feedApps).toHaveLength(1); expect(s.feedDiscoveryErrors).toEqual([]);
  });
  it('preserves selected FIPS and reports the missing app mesh binding without HTTPS requests', async () => {
    vi.stubGlobal('fetch', vi.fn()); s.feedApps = [{ key: 'book', transport: 'fips', connection, installation_id: registry.wapps[0].wappInstallationId, launch_url: 'https://book.example' }];
    s.feedAddOpen = true; s.startSubscribedReader(); await s.chooseFeedApp('book');
    expect(fetch).not.toHaveBeenCalled(); expect(s.subscribedFeedError).toContain('no registered FIPS feed endpoint'); expect(s.feedAddOpen).toBe(true);
  });
  it('explains graph-binding and selected transport errors in the subscribed reader', () => {
    s.subscribedFeedStatus = [{ subscription_id: 'book', error: 'unsafe_graph_target' }];
    expect(s.feedSourceStatus('book')).toContain('graph binding');
    s.subscribedFeedStatus[0].error = 'unsupported_source_transport'; expect(s.feedSourceStatus('book')).toContain('registered FIPS feed endpoint');
  });
  it('does not repopulate a closed picker from a late app response', async () => {
    const pending = gate(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const running = s.openFeedAdd(); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    s.closeFeedAdd(); pending.resolve(Response.json(registry)); await running;
    expect(s.feedApps).toEqual([]); expect(s.feedAddOpen).toBe(false); expect(s.feedAddBusy).toBe(false);
  });
  it('hydrates missing actor from actual /me before registry access and discards it after an identity switch', async () => {
    delete s.currentWorkspace.pgMe; const pending = gate();
    vi.stubGlobal('fetch', vi.fn(url => url.includes('/me') ? pending.promise : Promise.resolve(Response.json(registry))));
    const running = s.openFeedAdd(); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(s.feedAddStatus).toContain('reader'); s.session = { npub: 'other' }; s.disposeSubscribedReader();
    pending.resolve(Response.json({ actor: { npub: 'reader', actor_id: 'actor' } })); await running;
    expect(s.feedAddOpen).toBe(false); expect(s.currentWorkspace.pgMe).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
