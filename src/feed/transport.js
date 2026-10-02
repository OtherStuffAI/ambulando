import { createAutopilotDiscoveryClient } from '../autopilot-connect-client.js';
import { storedPackage } from '../autopilot-connection-refresh.js';
import { createNip98AuthHeader } from '../auth/nostr.js';
import { getWorkspaceDb } from '../db.js';
import { feedEndpoint, safeFeedUrl, FEED_LIMITS } from './normalize.js';
import { boundedFeedText } from './source-service.js';
async function sourceHttpError(response, signal) {
  let payload;
  try { payload = JSON.parse(await boundedFeedText(response, signal)); } catch { /* Status remains authoritative. */ }
  const code = payload?.error?.code || payload?.code;
  const message = payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '');
  const error = new Error(message || `Feed source returned HTTP ${response.status}.`);
  error.status = response.status; error.code = code; error.feedSource = true;
  return error;
}
export function defaultFeedConnectionTransport(connection) {
  const native = globalThis.window?.fipsTransport;
  return native?.available !== false && native?.version >= 2 ? 'fips' : connection.https_endpoint ? 'https' : 'fips';
}
export async function signedReaderJson(url, signal, { sign = createNip98AuthHeader, fetchImpl = fetch } = {}) {
  const timer = new AbortController(); const timeout = setTimeout(() => timer.abort(), FEED_LIMITS.timeout);
  const joined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    const authorization = await sign(url, 'GET'); joined.throwIfAborted();
    const r = await fetchImpl(url, { headers: { Authorization: authorization }, signal: joined, method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors' });
    if (!r.ok) throw await sourceHttpError(r, joined);
    if (!/json/i.test(r.headers.get('content-type') || '')) throw new Error('unsupported_content_type');
    return JSON.parse(await boundedFeedText(r, joined));
  } finally { clearTimeout(timeout); }
}
export async function discoverFeedApps(connections, signal, options = {}) {
  const eligible = connections.filter(c => c.pg_backend && !c.archived_at);
  const results = await Promise.allSettled(eligible.map(async c => {
    const transport = options.connectionTransports?.[c.id] || options.discoveryTransport || (c.fips_endpoint ? 'fips' : 'https');
    let payload;
    if (transport === 'fips') {
      const client = (options.createClient || createAutopilotDiscoveryClient)(storedPackage(c));
      try { payload = await client.readFeedAppRegistry(signal); } finally { await client.disconnect(); }
    } else {
      const base = safeFeedUrl(c.https_endpoint);
      payload = await signedReaderJson(new URL('/api/wapps', base).href, signal, options);
    }
    if (!Array.isArray(payload.wapps)) throw new Error('invalid_registry');
    return payload.wapps.filter(w => w.recordState !== 'deleted' && w.recordState !== 'archived')
      .map(w => ({ connection: c, transport, installation_id: w.wappInstallationId, title: w.title, launch_url: w.launchUrl, scope_id: w.scopeId, app_npub: w.appNpub, app_id: w.appId }))
      .filter(w => /^[\da-f-]{36}$/i.test(w.installation_id) && w.launch_url);
  }));
  return { apps: results.flatMap(r => r.status === 'fulfilled' ? r.value : []), errors: results.flatMap((r, i) => r.status === 'rejected' ? [{ connection_id: eligible[i].id, connection_name: eligible[i].display_name || eligible[i].https_endpoint || 'Autopilot', error: feedDiscoveryError(r.reason), status: r.reason?.status }] : []) };
}
export function feedDiscoveryError(error) {
  if ([401, 403].includes(error?.status)) return 'App discovery access denied. Check this Autopilot’s access for your signed-in identity.';
  if (error?.message === 'invalid_registry') return 'This Autopilot returned an unsupported app registry response. Retry or update the Autopilot.';
  if (error?.status === 404) return 'This Autopilot does not expose its app registry.';
  if (error?.code === 'fips_unavailable') return 'FIPS requires a supported, unlocked Wingman app. Choose registered HTTPS to connect in this browser.';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'App discovery timed out. Retry this connection.';
  if (error instanceof TypeError) return 'Cannot reach this Autopilot. Check the connection and its browser CORS settings, then retry.';
  return error?.message || 'App discovery unavailable. Retry this connection.';
}
// Tower launcher metadata is an independent, portable source binding. It is
// read through the normal materializer, never learned from feed content.
export async function registeredFeedApps(connections, towerContext, options = {}) {
  const db = options.db || getWorkspaceDb();
  const rows = await db.wapps.toArray();
  return rows.flatMap(row => {
    const pin = row.metadata?.feed_binding;
    const connection = connections.find(c => c.id === pin?.autopilot_connection_id && c.pg_backend && !c.archived_at);
    if (!connection || connection.workspace_id !== towerContext.workspaceId || !row.pg_backend || row.pg_workspace_id !== towerContext.workspaceId
      || row.status === 'archived' || row.record_state === 'deleted' || row.record_state === 'archived'
      || pin?.protocol !== 'book-of-sand-v1' || !/^[\da-f-]{36}$/i.test(pin.installation_id || '')
      || !/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(pin.graph_source_app_npub || '') || !row.app_id) return [];
    let launch; try { launch = new URL(safeFeedUrl(row.launch_url)); } catch { return []; }
    if (launch.pathname !== '/' || launch.search || launch.hash) return [];
    return [{ connection, installation_id: pin.installation_id, app_id: row.app_id, title: row.title,
      launch_url: launch.href, graph_source_app_npub: pin.graph_source_app_npub, feed_protocol: pin.protocol,
      tower_binding_id: row.record_id }];
  });
}
export function manualFeedApp(url, apps) {
  const input = new URL(safeFeedUrl(url));
  if (input.search || input.hash || !['/', '/feed/', '/feed/editions'].includes(input.pathname)) throw new Error('invalid_manual_feed_url');
  const matches = apps.filter(app => new URL(app.launch_url).origin === input.origin);
  if (matches.length !== 1) throw new Error('manual_feed_unregistered');
  return matches[0];
}
async function applyTowerFeedBinding(app, towerContext, options) {
  if (!app.connection || !towerContext.workspaceId) return app;
  const pins = await registeredFeedApps([app.connection], towerContext, options);
  const pin = pins.find(p => p.installation_id === app.installation_id);
  if (!pin) return app;
  if (pin.app_id !== app.app_id || new URL(pin.launch_url).origin !== new URL(safeFeedUrl(app.launch_url)).origin) throw new Error('unsafe_graph_target');
  return { ...app, ...pin, transport: app.transport };
}
export function validateGraphTargets(targets, app, towerContext) {
  const result = {};
  for (const [name, label] of [['stories', 'Story'], ['history', 'Reference']]) {
    const raw = safeFeedUrl(targets?.[name]), u = new URL(raw), tower = new URL(towerContext.baseUrl);
    const q = u.searchParams;
    if (u.origin !== tower.origin || u.pathname !== `${tower.pathname.replace(/\/$/, '')}/api/v4/graph/nodes` || u.hash
      || [...q.keys()].some(k => !['workspace_owner_npub', 'source_app_npub', 'visibility', 'group_id', 'source', 'run_id', 'label', 'limit', 'offset'].includes(k))
      || q.get('workspace_owner_npub') !== towerContext.workspaceOwnerNpub || q.get('source_app_npub') !== (app.graph_source_app_npub || app.app_npub)
      || [...q.keys()].some(k => q.getAll(k).length !== 1)
      || !['group', 'personal'].includes(q.get('visibility')) || (q.get('visibility') === 'group' && !towerContext.graphGroupIds?.includes(q.get('group_id'))) || (q.get('visibility') === 'personal' && q.has('group_id')) || q.get('label') !== label || q.get('limit') !== '200' || q.get('offset') !== '0') throw new Error('unsafe_graph_target');
    result[name] = raw;
  }
  return result;
}
async function resolveWappBinding(app, signal, towerContext, options = {}) {
  // Registry currently has no independently pinned WApp mesh endpoint.
  if (app.transport === 'fips') throw new Error('unsupported_source_transport');
  const base = new URL(safeFeedUrl(app.launch_url));
  // Never guess a feed base for a path-mounted installation.
  if (base.pathname !== '/') throw new Error('unsupported_source_transport');
  const origin = base.origin, sign = options.sign || createNip98AuthHeader;
  let targets = null;
  // This is W1's Book of Sand-specific signed graph-read extension.
  app = await applyTowerFeedBinding(app, towerContext, options);
  if (app.feed_protocol === 'book-of-sand-v1' || app.title?.toLowerCase().includes('book of sand')) {
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
    if (!r.ok) throw await sourceHttpError(r, signal);
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
  const pinned = (await registeredFeedApps([c], towerContext, { ...options, db })).find(a => a.installation_id === sub.source.installation_id);
  if (pinned) {
    const binding = await resolveWappBinding({ ...pinned, transport: preference?.transport || defaultFeedConnectionTransport(c) }, signal, towerContext, { ...options, db });
    return { url: feedEndpoint(binding.origin, sub.source.endpoint, sub.source.feed_id), headers: binding.headers, tower_binding_id: pinned.tower_binding_id };
  }
  const status = await db.feed_source_status.get(JSON.stringify([partition, sub.id, '']));
  if (status?.tower_binding_id) throw new Error('registry_revoked');
  const result = await discoverFeedApps([c], signal, { ...options, discoveryTransport: preference?.transport || defaultFeedConnectionTransport(c) }); if (result.errors.length) { const e = new Error(result.errors[0].error); e.status = result.errors[0].status; throw e; }
  const app = result.apps.find(a => a.installation_id === sub.source.installation_id); if (!app) throw new Error('registry_revoked');
  const binding = await resolveWappBinding(app, signal, towerContext, options);
  return { url: feedEndpoint(binding.origin, sub.source.endpoint, sub.source.feed_id), headers: binding.headers };
}
