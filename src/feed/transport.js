import { createNip98AuthHeader } from '../auth/nostr.js';
import { getWorkspaceDb } from '../db.js';
import { feedEndpoint, safeFeedUrl, FEED_LIMITS } from './normalize.js';
import { boundedFeedText } from './source-service.js';
export async function signedReaderJson(url, signal, { sign = createNip98AuthHeader, fetchImpl = fetch } = {}) {
  const timer = new AbortController(); const timeout = setTimeout(() => timer.abort(), FEED_LIMITS.timeout);
  const joined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    const authorization = await sign(url, 'GET'); joined.throwIfAborted();
    const r = await fetchImpl(url, { headers: { Authorization: authorization }, signal: joined, method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors' });
    if (!r.ok) { const e = new Error(`feed_http_${r.status}`); e.status = r.status; throw e; }
    if (!/json/i.test(r.headers.get('content-type') || '')) throw new Error('unsupported_content_type');
    return JSON.parse(await boundedFeedText(r, joined));
  } finally { clearTimeout(timeout); }
}
export async function discoverFeedApps(connections, signal, options = {}) {
  const results = await Promise.allSettled(connections.filter(c => c.pg_backend && !c.archived_at).map(async c => {
    if (c.fips_endpoint && options.discoveryTransport !== 'https') throw new Error('unsupported_source_transport');
    const base = safeFeedUrl(c.https_endpoint);
    const payload = await signedReaderJson(new URL('/api/wapps', base).href, signal, options);
    if (!Array.isArray(payload.wapps)) throw new Error('invalid_registry');
    return payload.wapps.map(w => ({ connection: c, installation_id: w.wappInstallationId, title: w.title, launch_url: w.launchUrl, scope_id: w.scopeId, app_npub: w.appNpub, app_id: w.appId })).filter(w => /^[\da-f-]{36}$/i.test(w.installation_id) && w.launch_url);
  }));
  return { apps: results.flatMap(r => r.status === 'fulfilled' ? r.value : []), errors: results.flatMap((r, i) => r.status === 'rejected' ? [{ connection_id: connections.filter(c => c.pg_backend && !c.archived_at)[i].id, error: r.reason?.message || 'registry_unavailable', status: r.reason?.status }] : []) };
}
export function validateGraphTargets(targets, app, towerContext) {
  const result = {};
  for (const [name, label] of [['stories', 'Story'], ['history', 'Reference']]) {
    const raw = safeFeedUrl(targets?.[name]), u = new URL(raw), tower = new URL(towerContext.baseUrl);
    const q = u.searchParams;
    if (u.origin !== tower.origin || u.pathname !== `${tower.pathname.replace(/\/$/, '')}/api/v4/graph/nodes` || u.hash
      || [...q.keys()].some(k => !['workspace_owner_npub', 'source_app_npub', 'visibility', 'group_id', 'source', 'run_id', 'label', 'limit', 'offset'].includes(k))
      || q.get('workspace_owner_npub') !== towerContext.workspaceOwnerNpub || q.get('source_app_npub') !== app.app_npub
      || !['group', 'personal'].includes(q.get('visibility')) || (q.get('visibility') === 'group' && !towerContext.graphGroupIds?.includes(q.get('group_id'))) || (q.get('visibility') === 'personal' && q.has('group_id')) || q.get('label') !== label || q.get('limit') !== '200' || q.get('offset') !== '0') throw new Error('unsafe_graph_target');
    result[name] = raw;
  }
  return result;
}
async function resolveWappBinding(app, signal, towerContext, options = {}) {
  const base = new URL(safeFeedUrl(app.launch_url));
  // Never guess a feed base for a path-mounted installation.
  if (base.pathname !== '/') throw new Error('unsupported_source_transport');
  const origin = base.origin, sign = options.sign || createNip98AuthHeader;
  let targets = null;
  // This is W1's Book of Sand-specific signed graph-read extension.
  if (app.title?.toLowerCase().includes('book of sand')) {
    const bootstrap = await signedReaderJson(`${origin}/api/feed/read-targets`, signal, options);
    const db = options.db || getWorkspaceDb();
    const groups = await db.groups.toArray();
    targets = validateGraphTargets(bootstrap.graph_read_targets, app, { ...towerContext, graphGroupIds: groups.flatMap(g => [g.record_id, g.id, g.group_id, g.pg_group_id].filter(Boolean)) });
  }
  return { origin, headers: async url => {
    signal?.throwIfAborted();
    const headers = { Authorization: await sign(url, 'GET') };
    if (targets) { headers['X-Tower-Stories-Authorization'] = await sign(targets.stories, 'GET'); headers['X-Tower-History-Authorization'] = await sign(targets.history, 'GET'); }
    signal?.throwIfAborted(); return headers;
  } };
}
export async function listWappFeeds(app, signal, towerContext, options = {}) {
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), FEED_LIMITS.timeout);
  signal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
  const binding = await resolveWappBinding(app, signal, towerContext, options), initial = feedEndpoint(binding.origin, '/feed/list');
  const feeds = [], cursors = new Set(); let cursor = '';
  do {
    const u = new URL(initial); u.searchParams.set('limit', '100'); if (cursor) u.searchParams.set('cursor', cursor);
    const r = await (options.fetchImpl || fetch)(u.href, { headers: await binding.headers(u.href), method: 'GET', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors' });
    if (!r.ok) { const e = new Error(`feed_http_${r.status}`); e.status = r.status; throw e; }
    const p = JSON.parse(await boundedFeedText(r, signal));
    if (p.contract_version !== 1 || !Array.isArray(p.feeds) || p.feeds.length > 100 || !(p.next_cursor === null || typeof p.next_cursor === 'string')) throw new Error('unsupported_contract');
    for (const f of p.feeds) { if (f.format !== 'jsonfeed-1.1' || typeof f.title !== 'string' || !f.title.trim() || typeof f.description !== 'string' || feeds.some(x => x.id === f.id)) throw new Error('invalid_feed_list'); feedEndpoint(binding.origin, f.endpoint, f.id); feeds.push(f); }
    cursor = p.next_cursor; if (cursor && (cursors.has(cursor) || cursors.size >= 5)) throw new Error('pagination_loop'); cursors.add(cursor);
  } while (cursor);
  return feeds;
  } finally { clearTimeout(timer); }
}
export async function resolveSubscriptionSource(sub, signal, towerContext, options = {}) {
  if (sub.source.kind === 'public') return { url: safeFeedUrl(sub.source.url) };
  const db = options.db || getWorkspaceDb(), c = await db.autopilot_connections.get(sub.source.autopilot_connection_id);
  if (!c || !c.pg_backend || c.workspace_id !== towerContext.workspaceId || c.archived_at) throw new Error('registry_revoked');
  const partition = JSON.stringify([towerContext.baseUrl, towerContext.workspaceId, towerContext.readerActorId]);
  const preference = await db.feed_connection_transports.get(JSON.stringify([partition, c.id]));
  const result = await discoverFeedApps([c], signal, { ...options, discoveryTransport: preference?.transport }); if (result.errors.length) { const e = new Error(result.errors[0].error); e.status = result.errors[0].status; throw e; }
  const app = result.apps.find(a => a.installation_id === sub.source.installation_id); if (!app) throw new Error('registry_revoked');
  const binding = await resolveWappBinding(app, signal, towerContext, options);
  return { url: feedEndpoint(binding.origin, sub.source.endpoint, sub.source.feed_id), headers: binding.headers };
}
