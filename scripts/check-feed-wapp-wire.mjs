// Source-only integration probe. Runs W1 in process; no listener, deployment,
// runtime state, upstream service or real reader credentials are involved.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
const sourceModule = process.env.FEED_WAPP_SOURCE_MODULE;
if (!sourceModule) throw new Error('Set FEED_WAPP_SOURCE_MODULE to the reviewed W1 src/feed.ts module; run with Bun.');
globalThis.__FLIGHT_DECK_PG_APP_NPUB__ = 'npub1syntheticwiretest';
const { createFeedHandler, feedGraphTargets } = await import(pathToFileURL(sourceModule).href);
const { discoverFeedApps, listWappFeeds, resolveSubscriptionSource } = await import('../src/feed/transport.js');
const { normalizeFeed } = await import('../src/feed/normalize.js');
const { FeedSourceService } = await import('../src/feed/source-service.js');
const { feedContextKey } = await import('../src/feed/store.js');
const { openWorkspaceDb } = await import('../src/db.js');
const reader = generateSecretKey(), readerNpub = nip19.npubEncode(getPublicKey(reader));
const other = generateSecretKey();
const base = 'https://book.example.invalid', tower = 'https://tower.example.invalid';
const scope = { workspace_owner_npub: 'workspace', source_app_npub: 'source-app', visibility: 'group', group_id: 'group' };
const targets = feedGraphTargets(tower, scope), signed = [], requests = [], graphRequests = [];
let denied = false;
const appId = '00000000-0000-4000-8000-000000000001', connectionId = '00000000-0000-4000-8000-000000000002', workspaceId = '00000000-0000-4000-8000-000000000003';
const stories = [{ external_id: 'story:exact headline & question?', labels: ['Story'], properties: { title: 'Exact headline', summary: 'Verified summary', article_body: 'One.\n\nTwo.\n\nThree.\n\nFour.', source_url: 'https://source.example.invalid/news', verification_state: 'verified', category: 'AI', story_role: 'headline', article_length: 'full', edition_run_id: 'edition-1' } }];
const history = [{ external_id: 'report-history:edition-1', labels: ['Reference'], properties: { status: 'published', report_type: 'news', delivery_surface: 'flightdeck_feed', material_update: true, edition_run_id: 'edition-1', report_run: 'edition-1', canonical_story_external_id: stories[0].external_id, reported_at: '2026-10-01T00:00:00Z', feed_external_id: 'book-of-sand:feed:edition-1' } }];
const handler = createFeedHandler({ publicBaseUrl: base, towerUrl: tower, graphScope: () => scope, allowedReaders: () => new Set([readerNpub]), corsOrigins: ['https://flight.example.invalid'], fetchImpl: async (url, init) => {
  graphRequests.push(String(url)); const e = JSON.parse(Buffer.from(init.headers.authorization.slice(6), 'base64').toString());
  assert.equal(verifyEvent(e), true); assert.equal(e.pubkey, getPublicKey(reader)); assert.equal(e.tags.find(t => t[0] === 'u')[1], url); assert.equal(init.redirect, 'error');
  if (denied) return Response.json({ error: 'denied' }, { status: 403 });
  return Response.json({ nodes: url === targets.stories ? stories : history, total: 1, has_more: false });
} });
const sign = async (url, method) => { signed.push(url); return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', method]], content: '' }, reader))).toString('base64')}`; };
const connection = { id: connectionId, pg_backend: true, workspace_id: workspaceId, https_endpoint: 'https://autopilot.example.invalid', display_name: 'Fixture instance' };
const fetchImpl = async (url, init) => {
  requests.push(String(url)); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  if (String(url).startsWith(connection.https_endpoint)) return Response.json({ wapps: [{ wappInstallationId: appId, title: 'Book of Sand', launchUrl: base, appNpub: 'source-app' }] });
  return handler(new Request(url, init));
};
const db = openWorkspaceDb(`feed-wire-${crypto.randomUUID()}`); await db.open();
await db.groups.put({ group_id: 'group' }); await db.autopilot_connections.put(connection);
const c = { baseUrl: tower, workspaceId, workspaceOwnerNpub: 'workspace', readerActorId: 'fixture-reader' }, context = feedContextKey(c);
let service;
try {
  const options = { sign, fetchImpl, db };
  const discovered = await discoverFeedApps([connection], undefined, options); assert.equal(discovered.apps.length, 1);
  const feeds = await listWappFeeds(discovered.apps[0], undefined, c, options); assert.equal(feeds[0].id, 'editions');
  const sub = { id: 'fixture-sub', status: 'active', source: { kind: 'wapp', autopilot_connection_id: connectionId, installation_id: appId, feed_id: feeds[0].id, endpoint: feeds[0].endpoint, format: feeds[0].format } };
  service = new FeedSourceService({ db, context, resolve: (s, signal) => resolveSubscriptionSource(s, signal, c, options), fetchImpl, parse: async (...args) => normalizeFeed(...args) });
  await service.update([sub]); await service.refresh(sub.id);
  const items = await db.feed_items.toArray(); assert.equal(items.length, 1); assert.equal(items[0].id, 'book-of-sand:feed:edition-1'); assert.equal(new URL(items[0].url).searchParams.get('story'), 'exact headline & question?');
  assert.equal(requests.includes(items[0].url), false); assert.equal(signed.includes(items[0].url), false);
  denied = true; await assert.rejects(service.refresh(sub.id), /feed_http_403/); assert.equal(await db.feed_items.count(), 0);
  const forbiddenEvent = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', `${base}/feed/list`], ['method', 'GET']], content: '' }, other);
  const forbidden = await handler(new Request(`${base}/feed/list`, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(forbiddenEvent)).toString('base64')}` } })); assert.equal(forbidden.status, 403);
  console.log(JSON.stringify({ passed: true, actualW1Handler: true, registeredDiscovery: true, exactSameReaderGraphSignatures: true, exactHeadline: true, denialPurge: true, destinationRequests: 0, requests: requests.length, graphRequests: graphRequests.length }));
} finally { await service?.dispose(); db.close(); await db.delete(); }
