import { nip19 } from 'nostr-tools';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { registeredFeedApps, manualFeedApp, resolveSubscriptionSource, validateGraphTargets } from '../src/feed/transport.js';
import { feedContextKey, feedRowKey } from '../src/feed/store.js';
const npub = nip19.npubEncode('11'.repeat(32));
const c = { baseUrl: 'https://tower.example', workspaceId: 'workspace', readerActorId: 'reader', workspaceOwnerNpub: 'owner' };
const connection = { id: 'connection', workspace_id: 'workspace', pg_backend: true, https_endpoint: 'https://agents.example' };
const row = { record_id: 'launcher', pg_backend: true, pg_workspace_id: 'workspace', title: 'Book of Sand', app_id: 'app-id', launch_url: 'https://book.example/', status: 'active', metadata: { feed_binding: { protocol: 'book-of-sand-v1', installation_id: '00000000-0000-4000-8000-000000000001', autopilot_connection_id: 'connection', graph_source_app_npub: npub } } };
const source = { kind: 'wapp', autopilot_connection_id: 'connection', installation_id: row.metadata.feed_binding.installation_id, feed_id: 'editions', endpoint: '/feed/editions', format: 'jsonfeed-1.1' };
const target = label => `https://tower.example/api/v4/graph/nodes?workspace_owner_npub=owner&source_app_npub=${npub}&visibility=group&group_id=group&label=${label}&limit=200&offset=0`;
let db;
beforeEach(async () => { db = await openWorkspaceDb(`manual-${crypto.randomUUID()}`); await db.autopilot_connections.put(connection); await db.wapps.put(structuredClone(row)); await db.groups.put({ group_id: 'group' }); });
afterEach(async () => { await db.delete(); });
it('accepts only the exact registered home/edition link and portable Tower binding', async () => {
  const apps = await registeredFeedApps([connection], c, { db });
  for (const link of ['https://book.example', 'https://book.example/feed/editions', 'https://book.example/feed/']) expect(manualFeedApp(link, apps).installation_id).toBe(source.installation_id);
  for (const link of ['https://book.example/feed/editions?owner=other', 'https://book.example/#story', 'https://book.example/other']) expect(() => manualFeedApp(link, apps)).toThrow('invalid_manual_feed_url');
  expect(() => manualFeedApp('https://evil.example/', apps)).toThrow('manual_feed_unregistered');
  expect(() => manualFeedApp('https://book.example/', [...apps, ...apps])).toThrow('manual_feed_unregistered');
});
it('rejects archived launchers/connections, workspace changes and malformed pins', async () => {
  for (const replacement of [{ status: 'archived' }, { pg_workspace_id: 'other' }, { metadata: { feed_binding: { ...row.metadata.feed_binding, graph_source_app_npub: 'untrusted' } } }]) {
    await db.wapps.put({ ...row, ...replacement }); expect(await registeredFeedApps([connection], c, { db })).toEqual([]);
  }
  await db.wapps.put(row); expect(await registeredFeedApps([{ ...connection, archived_at: 'now' }], c, { db })).toEqual([]);
});
it('reloads the Tower tuple and source pin without contacting a failed Autopilot registry; signs the pinned graph identity', async () => {
  const sign = vi.fn(async () => 'Nostr reader');
  const fetchImpl = vi.fn(async url => { expect(url).toBe('https://book.example/api/feed/read-targets'); return Response.json({ graph_read_targets: { stories: target('Story'), history: target('Reference') } }); });
  const sub = { id: 'sub', source };
  await db.feed_subscriptions.put({ ...sub, key: feedRowKey(feedContextKey(c), 'sub'), context: feedContextKey(c), status: 'active' });
  const saved = await db.feed_subscriptions.get(feedRowKey(feedContextKey(c), 'sub'));
  const binding = await resolveSubscriptionSource(saved, undefined, c, { db, sign, fetchImpl });
  expect(binding.url).toBe('https://book.example/feed/editions'); expect(binding.tower_binding_id).toBe('launcher');
  const headers = await binding.headers(binding.url); expect(Object.keys(headers)).toHaveLength(3);
  expect(sign.mock.calls.map(call => call[0])).toEqual(['https://book.example/api/feed/read-targets', binding.url, target('Story'), target('Reference')]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('never signs a mismatched Tower/app/group target or duplicate scope query', async () => {
  const app = (await registeredFeedApps([connection], c, { db }))[0];
  for (const bad of [target('Story').replace('tower.example', 'evil.example'), target('Story').replace(npub, 'publisher'), target('Story').replace('group_id=group', 'group_id=other'), target('Story') + '&label=Story']) expect(() => validateGraphTargets({ stories: bad, history: target('Reference') }, app, { ...c, graphGroupIds: ['group'] })).toThrow('unsafe_graph_target');
});
it('removal of a formerly pinned launcher denies reload rather than reverting to registry discovery', async () => {
  await db.feed_source_status.put({ key: feedRowKey(feedContextKey(c), 'sub'), context: feedContextKey(c), subscription_id: 'sub', tower_binding_id: 'launcher' });
  await db.wapps.delete('launcher'); const fetchImpl = vi.fn();
  await expect(resolveSubscriptionSource({ id: 'sub', source }, undefined, c, { db, fetchImpl })).rejects.toThrow('registry_revoked'); expect(fetchImpl).not.toHaveBeenCalled();
});
it('preserves selected native FIPS instead of signing or fetching registered HTTPS', async () => {
  await db.feed_connection_transports.put({ key: JSON.stringify([feedContextKey(c), connection.id]), transport: 'fips' }); const sign = vi.fn(), fetchImpl = vi.fn();
  await expect(resolveSubscriptionSource({ id: 'sub', source }, undefined, c, { db, sign, fetchImpl })).rejects.toThrow('unsupported_source_transport'); expect(sign).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});
