import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

export const SIGNUP_PATH = '/api/hosted/workspaces';
export const TOWER_PATH = '/api/v4/flightdeck-pg/hosted/workspaces';
export const SITE_NPUB = 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5';
const MAX_BODY = 2048;
const MAX_RESPONSE = 65536;
const MAX_AGE = 60;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(status, code) {
  return Response.json({ error: code, code }, { status, headers: { 'cache-control': 'no-store' } });
}

export function towerSignupUrl(base) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Tower public base URL');
  return new URL(TOWER_PATH, url).href;
}

export function createSiteSigner(nsec, expectedNpub = SITE_NPUB) {
  if (!nsec) throw new Error('Flight Deck site signer is unavailable');
  let secret;
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) throw new Error();
    secret = decoded.data;
    if (nip19.npubEncode(getPublicKey(secret)) !== expectedNpub) throw new Error();
  } catch {
    throw new Error('Flight Deck site signer identity mismatch');
  }
  return (url, hash, userEventId, now) => finalizeEvent({
    kind: 27235, created_at: now, content: randomUUID(),
    tags: [['u', url], ['method', 'POST'], ['payload', hash], ['user_event_id', userEventId]],
  }, secret);
}

function exactTag(event, name) {
  const tags = event.tags.filter(tag => Array.isArray(tag) && tag[0] === name);
  return tags.length === 1 && tags[0].length === 2 && typeof tags[0][1] === 'string' ? tags[0][1] : null;
}

function userEvent(header, url, hash, now) {
  if (!/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(header || '')) return null;
  try {
    const encoded = header.slice(6);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 4096 || bytes.toString('base64') !== encoded) return null;
    const event = JSON.parse(decoder.decode(bytes));
    if (!event || event.kind !== 27235 || !verifyEvent(event)
      || !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{64}$/.test(event.id)
      || !Number.isInteger(event.created_at) || Math.abs(now - event.created_at) > MAX_AGE
      || exactTag(event, 'u') !== url || exactTag(event, 'method') !== 'POST'
      || exactTag(event, 'payload') !== hash || event.tags.some(tag => tag[0] === 'user_event_id')) return null;
    return event;
  } catch { return null; }
}

function validBody(bytes) {
  try {
    const body = JSON.parse(decoder.decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'idempotency_key,terms_version,workspace_name'
      || typeof body.workspace_name !== 'string' || body.workspace_name !== body.workspace_name.trim()
      || body.workspace_name.length < 1 || body.workspace_name.length > 80
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.idempotency_key)
      || body.terms_version !== 'hosted-free-v1') return false;
    return true;
  } catch { return false; }
}

export function createHostedSignupHandler({ towerUrl, siteOrigin, sign, siteNpub = SITE_NPUB, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) }) {
  const target = towerSignupUrl(towerUrl);
  const siteUrl = new URL(siteOrigin);
  const origin = siteUrl.origin;
  const loopback = siteUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(siteUrl.hostname);
  if (siteUrl.protocol !== 'https:' && !loopback) throw new Error('Site origin must use HTTPS or loopback HTTP');
  const recent = new Map();
  return async function hostedSignup(request) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== SIGNUP_PATH || incoming.search) return fail(404, 'not_found');
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');
    if (incoming.host !== new URL(origin).host || (request.headers.get('origin') && request.headers.get('origin') !== origin)) return fail(403, 'origin_forbidden');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) return fail(415, 'unsupported_media_type');
    const length = Number(request.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY) return fail(413, 'body_too_large');
    let bytes;
    try {
      const reader = request.body?.getReader();
      if (!reader) return fail(400, 'invalid_body');
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) { await reader.cancel(); return fail(413, 'body_too_large'); }
        chunks.push(value);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } catch { return fail(400, 'invalid_body'); }
    if (!validBody(bytes)) return fail(400, 'invalid_body');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const authorization = request.headers.get('authorization');
    const event = userEvent(authorization, target, hash, now());
    if (!event) return fail(401, 'nip98_invalid');
    const time = now();
    for (const [id, expiry] of recent) if (expiry < time) recent.delete(id);
    if (recent.has(`${event.pubkey}:${event.id}`)) return fail(409, 'signature_replayed');
    if (recent.size >= 10000) return fail(429, 'signup_rate_limited');
    const actorEntries = [...recent.keys()].filter(id => id.startsWith(`${event.pubkey}:`));
    if (actorEntries.length >= 12) return fail(429, 'signup_rate_limited');
    recent.set(`${event.pubkey}:${event.id}`, time + 120);
    let attestation;
    try { attestation = sign(target, hash, event.id, now()); }
    catch { return fail(503, 'site_signer_unavailable'); }
    if (!attestation || !verifyEvent(attestation) || nip19.npubEncode(attestation.pubkey) !== siteNpub) return fail(503, 'site_signer_unavailable');
    try {
      const upstream = await fetchImpl(target, {
        method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', authorization, 'x-flightdeck-site-attestation': Buffer.from(JSON.stringify(attestation)).toString('base64') },
      });
      const result = new Uint8Array(await upstream.arrayBuffer());
      if (result.length > MAX_RESPONSE) return fail(502, 'tower_response_invalid');
      const type = upstream.headers.get('content-type') || '';
      if (!type.toLowerCase().includes('application/json')) return fail(502, 'tower_response_invalid');
      return new Response(result, { status: upstream.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    } catch { return fail(502, 'tower_unavailable'); }
  };
}
