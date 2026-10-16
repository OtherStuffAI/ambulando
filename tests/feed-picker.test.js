import { beforeEach, afterEach, it, expect, vi } from 'vitest';
vi.mock('../src/feed/parser.js', async () => {
  const { normalizeFeed } = await import('../src/feed/normalize.js');
  return { FeedParser: class { parse(text, format) { return Promise.resolve(normalizeFeed(text, format)); } dispose() {} } };
});
import { openWorkspaceDb } from '../src/db.js';
import { subscribedReaderMixin } from '../src/feed/reader-manager.js';
let db, s;
const json = { version: 'https://jsonfeed.org/version/1.1', title: 'Example', items: [{ id: 'one', content_text: 'Hello' }] };
beforeEach(async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  db = await openWorkspaceDb(`feeds-url-${crypto.randomUUID()}`);
  s = { ...subscribedReaderMixin, session: { npub: 'reader' }, backendUrl: 'https://tower.example', currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', pgSessionNpub: 'reader', pgMe: { actor: { actor_id: 'actor', npub: 'reader' } } }, createLiveSubscription: vi.fn(() => ({ unsubscribe: vi.fn() })), requestTowerSyncFamily: vi.fn(async () => {}), subscribeFeedSource: vi.fn() };
});
afterEach(async () => { await s.disposeSubscribedReader(); await db.delete(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('opens a URL-only form without network, discovery or transport configuration', () => {
  vi.stubGlobal('fetch', vi.fn()); s.openFeedAdd(); expect(s.feedAddOpen).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(s.requestTowerSyncFamily).not.toHaveBeenCalled();
  expect(s).not.toHaveProperty('feedApps'); expect(s).not.toHaveProperty('subscribedFeedView');
});
it.each(['jsonfeed-1.1', 'rss'])('validates accessible %s without app registration or credentials', async format => {
  const body = format === 'rss' ? '<rss version="2.0"><channel><title>Example</title><item><guid>one</guid><title>Hello</title></item></channel></rss>' : JSON.stringify(json);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': format === 'rss' ? 'application/rss+xml' : 'application/feed+json' } })));
  s.openFeedAdd(); s.publicFeedDraft = 'https://example.org/feed?edition=1#ignored'; await s.subscribePublicFeed();
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledWith('https://example.org/feed?edition=1', expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {} }));
  expect(s.subscribeFeedSource).toHaveBeenCalledWith({ kind: 'public', url: 'https://example.org/feed?edition=1', format }, 'Example', expect.any(Function)); expect(s.requestTowerSyncFamily).not.toHaveBeenCalled();
});
it.each([401, 403, 404])('does not save an inaccessible HTTP %s source', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
  s.openFeedAdd(); s.publicFeedDraft = 'https://example.org/feed'; await s.subscribePublicFeed();
  expect(s.subscribeFeedSource).not.toHaveBeenCalled(); expect(s.subscribedFeedError).toBeTruthy(); expect(s.feedAddOpen).toBe(true); expect(s.feedManualBusy).toBe(false);
});
it.each(['html', 'invalid-json', 'invalid-rss', 'redirect', 'cors'])('rejects %s before subscription creation', async kind => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (kind === 'redirect' || kind === 'cors') throw new TypeError('Failed to fetch');
    return new Response(kind === 'invalid-json' ? '{}' : '<html>not a feed</html>', { headers: { 'content-type': kind === 'html' ? 'text/html' : kind === 'invalid-rss' ? 'application/rss+xml' : 'application/json' } });
  }));
  s.openFeedAdd(); s.publicFeedDraft = 'https://example.org/feed'; await s.subscribePublicFeed(); expect(s.subscribeFeedSource).not.toHaveBeenCalled(); expect(s.subscribedFeedError).toBeTruthy();
});
it('rejects malformed or credential-bearing URLs before identity or network work', async () => {
  vi.stubGlobal('fetch', vi.fn()); s.openFeedAdd(); s.publicFeedDraft = 'https://user:secret@example.org/feed'; await s.subscribePublicFeed(); expect(fetch).not.toHaveBeenCalled(); expect(s.subscribeFeedSource).not.toHaveBeenCalled();
});
it.each(['close', 'workspace', 'signer'])('discards validation after %s changes', async kind => {
  let resolve; vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r; })));
  s.openFeedAdd(); s.publicFeedDraft = 'https://example.org/feed'; const pending = s.subscribePublicFeed(); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  if (kind === 'close') s.closeFeedAdd(); if (kind === 'workspace') s.currentWorkspace.workspaceId = 'other'; if (kind === 'signer') s.session = { npub: 'other' };
  resolve(Response.json(json)); await pending; expect(s.subscribeFeedSource).not.toHaveBeenCalled();
});
it('automatically starts and hydrates the reader regardless of an obsolete persisted view', async () => {
  s.subscribedFeedView = 'legacy'; await s.activateFeeds(); await vi.waitFor(() => expect(s.createLiveSubscription).toHaveBeenCalled()); expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('feed-reader');
});
