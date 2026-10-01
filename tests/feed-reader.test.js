import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { normalizeFeed, safeFeedUrl, publicFeedUrl, feedEndpoint, nextFeedUrl, FEED_LIMITS } from '../src/feed/normalize.js';
import { FeedSourceService, boundedFeedText } from '../src/feed/source-service.js';
import { feedContextKey, feedRowKey, feedProjection } from '../src/feed/store.js';
import { hydrateFeedReader, prepareFeedCommand } from '../src/feed/tower.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { subscribedReaderMixin } from '../src/feed/reader-manager.js';
import { discoverFeedApps, listWappFeeds, validateGraphTargets, signedReaderJson } from '../src/feed/transport.js';
import { materializeFeedReaderEvent } from '../src/feed/materialize.js';
import { applyPgRecordChanges } from '../src/pg-record-delta.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';
const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const store = () => ({ backendUrl: 'https://tower.example', session: { npub: 'npub-reader' }, currentWorkspace: { workspaceId, workspaceOwnerNpub: 'owner', pgSessionNpub: 'npub-reader', pgMe: { actor: { actor_id: 'reader', npub: 'npub-reader' } } } });
const context = feedContextKey({ baseUrl: 'https://tower.example', workspaceId, readerActorId: 'reader' });
const sub = (id = 'sub', kind = 'public') => ({ schema_version: 1, id, workspace_id: workspaceId, reader_actor_id: 'reader', source: kind === 'public' ? { kind, url: `https://feeds.example/${id}`, format: 'jsonfeed-1.1' } : { kind, autopilot_connection_id: 'connection', installation_id: 'installation', feed_id: 'editions', endpoint: '/feed/editions', format: 'jsonfeed-1.1' }, status: 'active', row_version: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const item = (id = 'item') => ({ id, title: 'Headline', url: 'https://book.example/?story=exact%20headline', content_html: '<script>danger()</script><b>Hello</b><img src="https://tracking.example/pixel">', date_published: '2026-10-01T00:00:00Z' });
const json = (items = [item()], next = '') => ({ version: 'https://jsonfeed.org/version/1.1', title: 'Feed', feed_url: 'https://feeds.example/sub', items, ...(next ? { next_url: next } : {}) });
const response = p => Response.json(p, { headers: { 'content-type': 'application/feed+json' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let db, services;
beforeEach(async () => { db = await openWorkspaceDb(`feed-test-${crypto.randomUUID()}`); services = []; });
afterEach(async () => { for (const s of services) await s.dispose(); vi.restoreAllMocks(); });
const source = opts => { const s = new FeedSourceService({ db, context, resolve: async s => ({ url: s.source.url || 'https://feeds.example/sub', headers: async () => ({ Authorization: 'actual-reader' }) }), parse: async (...a) => normalizeFeed(...a), random: () => 0.5, ...opts }); services.push(s); return s; };
describe('bounded feed normalisation', () => {
  it('keeps exact source links, stable edited IDs and inert text', () => {
    const row = normalizeFeed(JSON.stringify(json()), 'jsonfeed-1.1').items[0]; expect(row.url).toBe(item().url); expect(row.text).toBe('Hello'); expect(row.id).toBe('item');
    expect(normalizeFeed(JSON.stringify(json([{ ...item(), title: 'Edited' }])), 'jsonfeed-1.1').items[0].id).toBe(row.id);
  });
  it.each(['javascript:alert(1)', 'data:text/html,a', 'file:///a', 'https://user:pass@a.example', 'https://a.example/\\b', '//evil.example'])('rejects unsafe URL %s', url => expect(() => safeFeedUrl(url)).toThrow());
  it('preserves public query order and drops fragments only', () => expect(publicFeedUrl('https://a.example/feed?b=2&a=1#fragment')).toBe('https://a.example/feed?b=2&a=1'));
  it('rejects endpoint escapes and authenticated pagination origin/path escapes', () => {
    for (const path of ['//evil.example/feed/editions', '/feed/%2e%2e/a', '/feed/editions#secret']) expect(() => feedEndpoint('https://a.example', path, 'editions')).toThrow();
    expect(() => feedEndpoint('https://a.example/mounted', '/feed/editions', 'editions')).toThrow();
    for (const u of ['https://b.example/feed/editions?cursor=x', 'https://a.example/other?cursor=x', 'https://a.example/feed/editions?token=x']) expect(() => nextFeedUrl(u, 'https://a.example/feed/editions', true)).toThrow();
  });
  it('rejects duplicate/missing IDs, wrong types and large JSON', () => {
    for (const p of [json([item(), item()]), json([{ title: 'no ID' }]), { ...json(), items: {} }, json([{ ...item(), attachments: [{ url: item().url, mime_type: 'audio/mpeg', duration_in_seconds: -1 }] }])]) expect(() => normalizeFeed(JSON.stringify(p), 'jsonfeed-1.1')).toThrow();
    expect(() => normalizeFeed(' '.repeat(FEED_LIMITS.bytes + 1), 'jsonfeed-1.1')).toThrow('feed_too_large');
  });
  it('normalises direct RSS podcast enclosures without loading media', () => {
    const xml = '<rss version="2.0"><channel><title>Podcast</title><item><guid>episode-1</guid><title>Episode</title><link>https://pod.example/1</link><description><![CDATA[<b>Listen</b><script>bad()</script>]]></description><enclosure url="https://media.example/1.mp3" type="audio/mpeg" length="123"/></item></channel></rss>';
    const p = normalizeFeed(xml, 'rss'); expect(p.items[0].attachments).toEqual([{ url: 'https://media.example/1.mp3', mime_type: 'audio/mpeg', title: '', size_in_bytes: 123 }]); expect(p.items[0].text).toBe('Listen');
  });
  it.each(['<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>', '<rss><channel></rss>', '<rss><channel><item><title>No identity</title></item></channel></rss>', '<rss><channel>&secret;</channel></rss>', '<rss><channel><xi:include href="https://evil.example"/></channel></rss>'])('rejects unsafe/malformed RSS', xml => expect(() => normalizeFeed(xml, 'rss')).toThrow());
  it('bounds streaming bytes before parsing', async () => { await expect(boundedFeedText(new Response(new Uint8Array(FEED_LIMITS.bytes + 1)))).rejects.toThrow('feed_too_large'); });
});
describe('source isolation and lifecycle', () => {
  it('coalesces overlapping refreshes, deduplicates pages and sends no public credentials', async () => {
    const calls = []; const s = source({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response(url.includes('cursor') ? json([item('older'), item()]) : json([item()], 'https://feeds.example/sub?cursor=older')); } });
    await s.update([sub()]); const first = s.refresh('sub'); expect(s.refresh('sub')).toBe(first); await first;
    expect(await db.feed_items.count()).toBe(2); expect(calls).toHaveLength(2); expect(calls[0].options.headers).toEqual({}); expect(calls[0].options.credentials).toBe('omit'); expect(calls[0].options.redirect).toBe('error'); expect(calls.map(c => c.url)).not.toContain(item().url);
  });
  it('rejects pagination loops without partial commits', async () => { const s = source({ fetchImpl: async () => response(json([item()], 'https://feeds.example/sub')) }); await s.update([sub()]); await expect(s.refresh('sub')).rejects.toThrow('pagination_loop'); expect(await db.feed_items.count()).toBe(0); });
  it('limits global concurrency to four and isolates an outage', async () => {
    let active = 0, max = 0; const gate = deferred(); const s = source({ fetchImpl: async url => { active++; max = Math.max(max, active); await gate.promise; active--; if (url.endsWith('/0')) return new Response('', { status: 503 }); return response(json()); } });
    await s.update(Array.from({ length: 8 }, (_, i) => sub(String(i)))); const jobs = [...s.sources.keys()].map(id => s.refresh(id)); await vi.waitFor(() => expect(max).toBe(4), { timeout: 3000 }); gate.resolve(); await Promise.allSettled(jobs); expect(await db.feed_items.count()).toBe(7); expect((await db.feed_source_status.toArray()).find(r => r.subscription_id === '0').error).toBe('feed_http_503');
  });
  it('purges bodies on 401/403/404 and does not spin forbidden retries', async () => {
    for (const status of [401, 403, 404]) {
      const id = `s${status}`; await db.feed_items.put({ key: feedRowKey(context, id, 'item'), context, subscription_id: id, private: true });
      const fetchImpl = vi.fn(async () => new Response('', { status })); const s = source({ fetchImpl }); await s.update([sub(id, 'wapp')]); await expect(s.refresh(id)).rejects.toThrow(); expect(await db.feed_items.get(feedRowKey(context, id, 'item'))).toBeUndefined(); await s.refresh(id); expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects late success after revocation, unsubscribe, account switch and disposal', async () => {
    for (const mode of ['revocation', 'unsubscribe', 'dispose']) { const gate = deferred(), s = source({ fetchImpl: () => gate.promise }); await s.update([sub('sub', 'wapp')]); const running = s.refresh('sub'); await new Promise(r => setTimeout(r, 0)); if (mode === 'revocation') await s.revoke('sub'); else if (mode === 'unsubscribe') await s.update([{ ...sub('sub', 'wapp'), status: 'unsubscribed' }]); else await s.dispose(); gate.resolve(response(json())); await running; expect(await db.feed_items.count()).toBe(0); }
  });
  it('upserts edits and keeps reader flags, partitions reader projections', async () => {
    let title = 'Headline'; const s = source({ fetchImpl: async () => response(json([{ ...item(), title }])) }); await s.update([sub()]); await s.refresh('sub');
    await db.feed_subscriptions.put({ ...sub(), key: feedRowKey(context, 'sub'), context }); await db.feed_item_states.put({ key: feedRowKey(context, 'sub', 'item'), context, subscription_id: 'sub', item_id: 'item', read: true, saved: true, dismissed: false });
    title = 'Edited'; await s.refresh('sub'); const p = await feedProjection(db, context); expect(p.items).toHaveLength(1); expect(p.items[0]).toMatchObject({ title: 'Edited', read: true, saved: true }); expect((await feedProjection(db, 'different-reader')).items).toEqual([]);
  });
  it('opens the exact headline only once on deliberate click and flags do not open it', () => { const open = vi.fn(); vi.stubGlobal('window', { open }); subscribedReaderMixin.openFeedItem(item()); expect(open).toHaveBeenCalledExactlyOnceWith(item().url, '_blank', 'noopener,noreferrer'); subscribedReaderMixin.openFeedItem({ url: 'javascript:bad()' }); expect(open).toHaveBeenCalledTimes(1); vi.unstubAllGlobals(); });
});
describe('T1 adapters, reader convergence and CAS', () => {
  it('applies actor-isolated SSE state events without starting another Tower request', async () => {
    const c = store(); const row = { schema_version: 1, id: 'state', workspace_id: workspaceId, reader_actor_id: 'reader', subscription_id: 'sub', item_id: 'item', row_version: 3, read: true, saved: true, dismissed: false };
    c.requestTowerSyncFamily = vi.fn(); await materializeFeedReaderEvent(c, { entity_type: 'feed_item_state', payload: row });
    expect((await db.feed_item_states.get(feedRowKey(context, 'sub', 'item'))).saved).toBe(true); expect(c.requestTowerSyncFamily).not.toHaveBeenCalled();
    await expect(materializeFeedReaderEvent(c, { entity_type: 'feed_item_state', payload: { ...row, reader_actor_id: 'other' } })).rejects.toThrow('invalid_reader_row');
  });

  it('hydrates real T1 route shapes, pages and rejects another reader', async () => {
    const request = vi.fn(async (_w, suffix, options) => suffix.endsWith('item-states') ? { item_states: [], next_cursor: null } : { subscriptions: [sub(options.cursor ? 'two' : 'one')], next_cursor: options.cursor ? null : 'next' });
    await hydrateFeedReader(store(), { request, db }); expect(await db.feed_subscriptions.count()).toBe(2); expect(request.mock.calls.map(c => c[1])).toEqual(['', '', '/one/item-states', '/two/item-states']);
    await expect(hydrateFeedReader(store(), { request: async () => ({ subscriptions: [{ ...sub(), reader_actor_id: 'other' }], next_cursor: null }), db })).rejects.toThrow('invalid_reader_row');
  });
  it('uses CAS field patches to converge two clients without overwriting saved, including unread', async () => {
    let row = { schema_version: 1, id: 'state', workspace_id: workspaceId, reader_actor_id: 'reader', subscription_id: 'sub', item_id: 'item', row_version: 1, read: false, saved: false, dismissed: false };
    const mutations = new Map(); const request = vi.fn(async (_w, suffix, options) => {
      if (!options.method || options.method === 'GET') return suffix.endsWith('item-states') ? { item_states: [row], next_cursor: null } : { subscriptions: [sub()], next_cursor: null };
      const body = options.body; if (mutations.has(body.mutation_id)) return mutations.get(body.mutation_id); if (body.expected_row_version !== row.row_version) throw Object.assign(new Error('state_conflict'), { status: 409, code: 'state_conflict' });
      row = { ...row, ...body.patch, row_version: row.row_version + 1 }; const result = { item_state: row }; mutations.set(body.mutation_id, result); return result;
    });
    const one = new TowerSyncService({ workspaceKey: 'one', ports: { prepareCommand: (n, i) => prepareFeedCommand(store(), n, i, { request, db }) } });
    const two = new TowerSyncService({ workspaceKey: 'two', ports: { prepareCommand: (n, i) => prepareFeedCommand(store(), n, i, { request, db }) } });
    const input = patch => ({ subscriptionId: 'sub', clientMutationId: crypto.randomUUID(), body: { mutation_id: crypto.randomUUID(), expected_row_version: 1, item_id: 'item', patch } });
    await one.command('feed-state.patch', input({ saved: true })); await two.command('feed-state.patch', input({ read: true })); expect(row).toMatchObject({ saved: true, read: true, row_version: 3 });
    await two.command('feed-state.patch', input({ read: false })); expect(row).toMatchObject({ saved: true, read: false }); expect(await db.feed_commands.count()).toBe(0);
  });
  it('rejects changed mutation-ID reuse and reuses identical acknowledgement', async () => {
    const execute = vi.fn(async () => ({ ok: true })); const s = new TowerSyncService({ workspaceKey: 'reader', ports: { prepareCommand: () => ({ execute }) } });
    const input = { clientMutationId: 'fixed', body: { mutation_id: 'fixed', patch: { read: true } } }; await s.command('feed-state.patch', input); await s.command('feed-state.patch', input); expect(execute).toHaveBeenCalledTimes(1); await expect(s.command('feed-state.patch', { ...input, body: { patch: { saved: true } } })).rejects.toThrow('mutation_id_reused');
  });
  it('keeps offline intents in original reader partition and refuses replay over unsubscribe', async () => {
    const c = store(), input = { subscriptionId: 'sub', body: { mutation_id: 'offline', expected_row_version: 0, item_id: 'item', patch: { read: true } } };
    const d = prepareFeedCommand(c, 'feed-state.patch', input, { db, request: async () => { throw new TypeError('offline'); } }); await d.optimistic(); await expect(d.execute()).rejects.toThrow('offline'); expect((await db.feed_commands.get('offline')).context).toBe(context);
    const commandTowerWorkspace = vi.fn(); await hydrateFeedReader({ ...c, commandTowerWorkspace }, { db, request: async (_w, suffix) => suffix ? { item_states: [], next_cursor: null } : { subscriptions: [{ ...sub(), status: 'unsubscribed' }], next_cursor: null } }); expect(commandTowerWorkspace).not.toHaveBeenCalled(); expect(await db.feed_commands.count()).toBe(0);
  });
  it('rejects late hydration after account switch before writes', async () => { const c = store(), gate = deferred(); const running = hydrateFeedReader(c, { db, request: () => gate.promise }); c.session = { npub: 'other' }; gate.resolve({ subscriptions: [sub()], next_cursor: null }); await expect(running).rejects.toThrow('feed_disposed'); expect(await db.feed_subscriptions.count()).toBe(0); });
  it('materializes T1 feed families through the existing record-delta worker path', async () => {
    const rows = [sub(), { schema_version: 1, id: 'state', workspace_id: workspaceId, reader_actor_id: 'reader', subscription_id: 'sub', item_id: 'item', row_version: 1, read: true, saved: true, dismissed: false }];
    const page = { ...fixture.one_message_delta, families: [...fixture.one_message_delta.families, 'feed_subscription', 'feed_item_state'], changes: rows.map((r, i) => ({ family: i ? 'feed_item_state' : 'feed_subscription', id: r.id, workspace_id: workspaceId, version: '1', operation: 'upsert', row: r })), next_cursor: 'feed-delta' };
    await applyPgRecordChanges(store(), page); expect(await db.feed_subscriptions.count()).toBe(1); expect(await db.feed_item_states.count()).toBe(1);
    const bad = { ...page, changes: [{ ...page.changes[0], version: '2', row: { ...sub(), row_version: 2, reader_actor_id: 'other' } }], next_cursor: 'bad' }; await expect(applyPgRecordChanges(store(), bad)).rejects.toThrow('invalid_reader_row');
  });
});
describe('existing registry and exact reader signing', () => {
  it('uses the selected pinned FIPS service without HTTPS fallback and permits explicit HTTPS', async () => {
    const connections = [{ id: 'dual', pg_backend: true, fips_transport_npub: 'npub-node', fips_endpoint: 'http://npub-node.fips:8000', https_endpoint: 'https://registered.example' }];
    const fetchImpl = vi.fn(async () => response({ wapps: [] })), sign = vi.fn(async () => 'reader');
    const disconnect = vi.fn(), readFeedAppRegistry = vi.fn(async () => { throw new Error('FIPS connection unavailable'); });
    const createClient = vi.fn(() => ({ readFeedAppRegistry, disconnect }));
    expect((await discoverFeedApps(connections, undefined, { sign, fetchImpl, createClient })).errors[0].error).toBe('FIPS connection unavailable');
    expect(fetchImpl).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledTimes(1);
    expect((await discoverFeedApps(connections, undefined, { sign, fetchImpl, connectionTransports: { dual: 'https' } })).errors).toEqual([]); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('discovers authorised installations across shared PG connections, isolates failures', async () => {
    const connections = ['one', 'two', 'denied'].map(id => ({ id, pg_backend: true, https_endpoint: `https://${id}.example` }));
    const signed = [], requested = []; const result = await discoverFeedApps(connections, undefined, { sign: async url => { signed.push(url); return 'reader-signature'; }, fetchImpl: async (url, init) => { requested.push({ url, init }); if (url.includes('denied')) return new Response('', { status: 403 }); return response({ wapps: [{ wappInstallationId: '00000000-0000-4000-8000-000000000001', title: 'WApp', launchUrl: 'https://app.example/', appNpub: 'app' }] }); } });
    expect(result.apps).toHaveLength(2); expect(result.errors).toHaveLength(1); expect(result.apps.map(a => a.connection.id)).toEqual(['one', 'two']); expect(signed).toEqual(requested.map(r => r.url)); expect(requested.every(r => r.init.credentials === 'omit' && r.init.redirect === 'error')).toBe(true);
  });
  it('lists signed permitted feeds with version and endpoint validation', async () => {
    const app = { title: 'Other WApp', launch_url: 'https://app.example/' }, signed = [];
    const feeds = await listWappFeeds(app, undefined, {}, { sign: async url => { signed.push(url); return 'reader'; }, fetchImpl: async () => response({ contract_version: 1, feeds: [{ id: 'editions', title: 'Editions', description: '', endpoint: '/feed/editions', format: 'jsonfeed-1.1' }], next_cursor: null }) }); expect(feeds).toHaveLength(1); expect(signed).toEqual(['https://app.example/feed/list?limit=100']);
  });
  it('validates W1 fixed graph reads before giving separate reader signatures', () => {
    const q = label => `https://tower.example/api/v4/graph/nodes?workspace_owner_npub=owner&source_app_npub=app&visibility=group&group_id=allowed&label=${label}&limit=200&offset=0`;
    const targets = { stories: q('Story'), history: q('Reference') }, app = { app_npub: 'app' }, c = { baseUrl: 'https://tower.example', workspaceOwnerNpub: 'owner', graphGroupIds: ['allowed'] };
    expect(validateGraphTargets(targets, app, c)).toEqual(targets); for (const replacement of ['https://evil.example/api/v4/graph/nodes', q('Story').replace('source_app_npub=app', 'source_app_npub=other'), q('Story').replace('group_id=allowed', 'group_id=other')]) expect(() => validateGraphTargets({ ...targets, stories: replacement }, app, c)).toThrow('unsafe_graph_target');
  });
  it('does not follow authenticated redirects or expose a bot/owner fallback', async () => { const fetchImpl = vi.fn(async () => new Response('', { status: 403 })); const sign = vi.fn(async () => 'reader'); await expect(signedReaderJson('https://app.example/feed/list', undefined, { fetchImpl, sign })).rejects.toMatchObject({ status: 403 }); expect(sign).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' }); });
});
