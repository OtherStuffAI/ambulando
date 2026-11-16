import { nip19, verifyEvent } from 'nostr-tools';

export const WORKSPACE_CONNECTION_PREFIX = 'nstack:workspace:v3:';
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw Error('invalid_connection_shape');
}
function npub(value) {
  if (typeof value !== 'string') throw Error('invalid_npub');
  const decoded = nip19.decode(value);
  if (decoded.type !== 'npub' || nip19.npubEncode(decoded.data) !== value) throw Error('invalid_npub');
}
function canonical(raw) {
  const value = JSON.parse(raw);
  if (JSON.stringify(value) !== raw) throw Error('noncanonical_or_duplicate_json');
  return value;
}
function signed(event, kind, tag, now) {
  keys(event, ['kind', 'created_at', 'tags', 'content', 'pubkey', 'id', 'sig']);
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > now + 300
    || !/^[0-9a-f]{64}$/.test(event.id) || !/^[0-9a-f]{64}$/.test(event.pubkey)
    || !/^[0-9a-f]{128}$/.test(event.sig) || event.kind !== kind
    || JSON.stringify(event.tags) !== JSON.stringify([['d', tag]]) || !verifyEvent(event)) throw Error('invalid_connection_proof');
  return canonical(event.content);
}
export function parseWorkspaceConnection(envelope, now = Math.floor(Date.now() / 1000)) {
  if (typeof envelope !== 'string' || new TextEncoder().encode(envelope).length > 8192
    || !envelope.startsWith(WORKSPACE_CONNECTION_PREFIX)) throw Error('unsupported_connection_envelope');
  const encoded = envelope.slice(WORKSPACE_CONNECTION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error('invalid_encoding');
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) throw Error('invalid_encoding');
  const event = canonical(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const value = signed(event, 30383, 'nstack-workspace-connection-v3', now);
  keys(value, ['type', 'version', 'service_npub', 'workspace_id', 'workspace_service_npub', 'name', 'transports', 'policy'], ['type', 'version', 'service_npub', 'workspace_id', 'workspace_service_npub', 'transports', 'policy']);
  if (value.type !== 'nstack-workspace' || value.version !== 3) throw Error('unsupported_connection_version');
  npub(value.service_npub); npub(value.workspace_service_npub);
  if (nip19.npubEncode(event.pubkey) !== value.service_npub) throw Error('service_identity_mismatch');
  if (typeof value.workspace_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.workspace_id)) throw Error('invalid_workspace_uuid');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 128)) throw Error('invalid_name');
  keys(value.transports, ['https', 'fips'], []);
  if (!Object.keys(value.transports).length) throw Error('transport_required');
  if (Object.hasOwn(value.transports, 'https')) {
    keys(value.transports.https, ['url']);
    const url = new URL(value.transports.https.url);
    if (typeof value.transports.https.url !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value.transports.https.url) throw Error('invalid_https_origin');
  }
  if (Object.hasOwn(value.transports, 'fips')) {
    const f = value.transports.fips; keys(f, ['peer_npub', 'host', 'port']); npub(f.peer_npub);
    if (f.host !== `${f.peer_npub}.fips` || !Number.isInteger(f.port) || f.port < 1 || f.port > 65535) throw Error('invalid_fips_binding');
  }
  keys(value.policy, ['preferred', 'fallback']);
  if (!['https', 'fips'].includes(value.policy.preferred) || !value.transports[value.policy.preferred] || value.policy.fallback !== 'none') throw Error('invalid_transport_policy');
  return value;
}
export function connectionOrigin(payload, mode = payload.policy.preferred) {
  if (!['https', 'fips'].includes(mode) || !payload.transports[mode]) throw Error('unsupported_transport');
  return mode === 'https' ? payload.transports.https.url : new URL(`http://${payload.transports.fips.host}:${payload.transports.fips.port}`).origin;
}
export function verifyConnectionChallenge(proof, payload, nonce, requestUrl, now = Math.floor(Date.now() / 1000)) {
  const p = signed(proof, 30384, 'nstack-connection-challenge-v1', now);
  keys(p, ['nonce', 'service_npub', 'workspace_id', 'workspace_service_npub', 'request_url', 'expires_at']);
  if (!/^[0-9a-f]{64}$/.test(nonce) || p.nonce !== nonce || p.request_url !== requestUrl
    || p.service_npub !== payload.service_npub || nip19.npubEncode(proof.pubkey) !== payload.service_npub
    || p.workspace_id !== payload.workspace_id || p.workspace_service_npub !== payload.workspace_service_npub
    || !Number.isSafeInteger(p.expires_at) || p.expires_at <= now || p.expires_at > now + 60
    || proof.created_at > now || proof.created_at < now - 60 || p.expires_at !== proof.created_at + 60) throw Error('connection_challenge_mismatch');
  return p;
}
export async function challengeWorkspaceConnection(payload, origin, { auth, fetch, random = globalThis.crypto }) {
  const nonce = Array.from(random.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const requestUrl = `${origin}/api/v4/flightdeck-pg/workspaces/${payload.workspace_id}/connection-proof?nonce=${nonce}`;
  const response = await fetch(requestUrl, { method: 'GET', credentials: 'omit', redirect: 'error',
    headers: { Authorization: await auth(requestUrl, 'GET', null, { useWorkspaceKey: false }) }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`Workspace access denied or proof unavailable (${response.status})`);
  const body = canonical(await response.text());
  keys(body, ['proof']);
  verifyConnectionChallenge(body.proof, payload, nonce, requestUrl);
}
