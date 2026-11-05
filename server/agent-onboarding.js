import { createHash, randomUUID } from 'node:crypto';
import { nip19, verifyEvent } from 'nostr-tools';
import { refuse } from './agent-stripe.js';
import { towerSignupUrl } from './hosted-signup.js';
export const AGENT_ONBOARDING_PATH = '/api/agent-onboarding';
export const AGENT_WEBHOOK_PATH = `${AGENT_ONBOARDING_PATH}/stripe/webhook`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_TOWER = 'https://nstack.otherstuff.ai/';
const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function boundedBody(request, max = 8192) {
  const chunks = []; let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { await reader.cancel(); refuse(413, 'body_too_large'); } chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function exactKeys(body, names) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).sort().join() !== [...names].sort().join()) refuse(400, 'invalid_body');
}
function name(value, max) { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /\p{C}/u.test(value)) refuse(400, 'invalid_name'); return value; }
export async function publicTowerOnboardingReady(fetchImpl = fetch) {
  const response = await fetchImpl(`${PUBLIC_TOWER}openapi.json`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) refuse(503, 'workspace_update_required');
  const document = JSON.parse((await boundedBody(response, 4 * 1024 * 1024)).toString('utf8'));
  if (!document.paths?.['/api/v4/flightdeck-pg/workspaces/{workspaceId}/general/ensure']?.post
    || !document.components?.schemas?.FlightDeckPgGeneralEnsureResponse) refuse(503, 'workspace_update_required');
  return true;
}
export function createAgentOnboarding({ store, stripe, cloud, signup, signupReady, towerReady = publicTowerOnboardingReady, origin, towerUrl = PUBLIC_TOWER, now = () => Date.now() }) {
  const publicOrigin = new URL(origin);
  towerUrl = new URL(towerUrl).href;
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== origin || publicOrigin.username || publicOrigin.password || towerUrl !== PUBLIC_TOWER) throw new Error('Invalid onboarding deployment origin');
  const rates = new Map(), inflight = new Map();
  function update(id, fn) { return store.transaction(() => { const o = store.get(id); fn(o); o.updatedAt = now(); store.save(o); return o; }); }
  async function exclusive(id, fn) {
    const previous = inflight.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn); inflight.set(id, run);
    try { return await run; } finally { if (inflight.get(id) === run) inflight.delete(id); }
  }
  function authenticate(request, bytes) {
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && requestOrigin !== origin) refuse(403, 'origin_invalid');
    let event;
    try {
      const header = request.headers.get('authorization');
      if (!header?.startsWith('Nostr ') || header.length > 6000) throw Error();
      event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
      const tag = key => { const t = event.tags.filter(t => t[0] === key); return t.length === 1 && t[0].length === 2 ? t[0][1] : null; };
      if (event.kind !== 27235 || !verifyEvent(event) || !Number.isInteger(event.created_at) || Math.abs(now() / 1000 - event.created_at) > 60
        || tag('u') !== new URL(new URL(request.url).pathname, origin).href || tag('method') !== request.method
        || (bytes.length ? tag('payload') !== createHash('sha256').update(bytes).digest('hex') : tag('payload') !== null)) throw Error();
    } catch { refuse(401, 'signature_invalid'); }
    const time = Math.floor(now() / 1000);
    if (!store.authenticate(event.id, time + 120, time)) refuse(409, 'signature_replayed');
    const owner = nip19.npubEncode(event.pubkey), bucket = Math.floor(time / 60);
    for (const [key, r] of rates) if (r.bucket !== bucket) rates.delete(key);
    const rate = rates.get(owner) || { bucket, count: 0 }; rate.count++; rates.set(owner, rate);
    if (rate.count > 90 || rates.size > 10000) refuse(429, 'rate_limited');
    return owner;
  }
  function view(o) {
    if (!o) return null;
    return { id: o.id, workspaceName: o.workspaceName, agentName: o.agentName, workspace: o.workspace || null,
      workspaceBody: o.workspaceBody, workspaceStarted: !!o.workspaceStarted, offer: o.offer || null, paid: !!o.paid, ready: !!o.ready, status: o.ready ? 'ready' : o.paid ? 'setting_up' : o.paymentState || 'workspace',
      checkoutUrl: !o.paid ? o.sessions.at(-1)?.url || null : null, agent: o.agent || null,
      channels: o.channels || null, connectionId: o.id, cloudOrigin: o.cloudOrigin || cloud.origin,
      attention: o.attention || null, updatedAt: o.updatedAt };
  }
  let readinessCache = null;
  async function readiness() {
    if (readinessCache && readinessCache.until > now()) return readinessCache.promise;
    const promise = checkReadiness(); readinessCache = { until: now() + 15000, promise }; return promise;
  }
  async function checkReadiness() {
    try {
      if (!await signupReady()) refuse(503, 'workspace_not_ready');
      if (!await towerReady()) refuse(503, 'workspace_update_required');
      await cloud.ready(); const offer = await stripe.offer();
      return { ready: true, offer, towerUrl, cloudOrigin: cloud.origin };
    } catch (e) { return { ready: false, error: e.code || 'setup_unavailable' }; }
  }
  async function reconcile(id, sessionId) {
    let o = store.get(id); if (!o || !o.offer) refuse(404, 'order_not_found');
    const knownAttempt = o.sessions.find(x => x.id === sessionId);
    const s = await stripe.session(sessionId, (knownAttempt?.offer || o.offer).merchantId);
    // Bind a webhook arriving before the create-session response was saved.
    if (!o.sessions.some(x => x.id === s.id)) {
      const attempt = Number(s.metadata?.attempt);
      const pending = o.sessions.find(x => x.attempt === attempt && x.id === null);
      if (!pending) refuse(409, 'payment_binding_mismatch');
      o = { ...o, sessions: o.sessions.map(x => x === pending ? { ...x, id: s.id } : x) };
    }
    const snapshot = o.sessions.find(x => x.id === s.id)?.offer || o.offer;
    const paid = stripe.validate(s, { ...o, offer: snapshot });
    return update(id, current => {
      if (!current.sessions.some(x => x.id === s.id)) {
        const pending = current.sessions.find(x => x.attempt === Number(s.metadata?.attempt) && x.id === null);
        if (!pending) refuse(409, 'payment_binding_mismatch'); pending.id = s.id;
      }
      if (paid && current.paid && current.receipt.sessionId !== s.id) {
        current.duplicateSettlements = [...new Set([...(current.duplicateSettlements || []), s.id])];
        current.attention = 'An additional payment needs a support review. Your original agent setup is retained.';
      } else if (paid) { current.offer = snapshot; current.paid = true; current.paymentState = 'paid'; current.outbox = !current.agent; current.receipt = { sessionId: s.id, paymentIntent: s.payment_intent, amount: s.amount_total, currency: s.currency, livemode: s.livemode }; }
      else if (!current.paid && current.sessions.at(-1).id === s.id) current.paymentState = current.sessions.find(x => x.id === s.id)?.failed ? 'failed' : s.status === 'expired' ? 'expired' : s.status === 'complete' ? 'pending' : 'awaiting_payment';
    });
  }
  async function fulfil(id) {
    let o = store.get(id); if (!o?.paid || o.agent) return o;
    if (o.cloudOrigin !== cloud.origin) refuse(409, 'cloud_target_changed');
    // A durable lease prevents multiple server processes issuing fulfilment concurrently.
    const lease = randomUUID();
    o = update(id, current => { if (current.leaseUntil > now()) refuse(409, 'setup_busy'); current.lease = lease; current.leaseUntil = now() + 60000; });
    try {
      const result = await cloud.fulfil(o);
      if (!result?.npub || nip19.decode(result.npub).type !== 'npub') refuse(502, 'cloud_receipt_invalid');
      return update(id, current => { if (current.lease !== lease) refuse(409, 'setup_busy'); current.agent = { npub: result.npub, name: current.agentName }; current.outbox = false; current.attention = null; });
    } catch { return update(id, current => { current.attention = 'Your payment is confirmed. Agent setup is waiting; retry without paying again.'; }); }
    finally { update(id, current => { if (current.lease === lease) { current.leaseUntil = 0; current.lease = null; } }); }
  }
  async function handle(request) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === `${AGENT_ONBOARDING_PATH}/config` && request.method === 'GET') return json(await readiness());
      if (path === AGENT_WEBHOOK_PATH) {
        if (request.method !== 'POST' || url.search) refuse(405, 'method_not_allowed');
        const event = stripe.webhook(await boundedBody(request, 262144), request.headers.get('stripe-signature'));
        if (!EVENTS.has(event.type)) return json({ received: true });
        if (event.account || event.object !== 'event' || !/^evt_/.test(event.id || '')) refuse(400, 'webhook_invalid');
        const raw = event.data?.object, id = raw?.metadata?.purchase_id;
        const order = store.get(id); if (!order) refuse(409, 'payment_binding_mismatch');
        if (event.livemode !== order.offer?.livemode) refuse(409, 'payment_binding_mismatch');
        await reconcile(id, raw.id);
        if (event.type === 'checkout.session.async_payment_failed') update(id, current => { if (!current.paid) { current.sessions.find(s => s.id === raw.id).failed = true; if (current.sessions.at(-1).id === raw.id) current.paymentState = 'failed'; } });
        // paid + outbox are committed before acknowledging. Background worker retries after restart.
        store.event(event.id, id);
        return json({ received: true });
      }
      if (url.search || !['GET', 'POST'].includes(request.method)) refuse(400, 'invalid_request');
      if (request.method === 'POST' && !/^application\/json(?:;.*)?$/i.test(request.headers.get('content-type') || '')) refuse(415, 'content_type_invalid');
      const bytes = await boundedBody(request, 32768), owner = authenticate(request, bytes);
      let body = {}; try { if (bytes.length) body = JSON.parse(bytes.toString('utf8')); } catch { refuse(400, 'invalid_body'); }
      if (path === `${AGENT_ONBOARDING_PATH}/order`) {
        if (request.method === 'GET') return json({ order: view(store.byOwner(owner)) });
        exactKeys(body, ['workspaceName', 'agentName']); name(body.workspaceName, 80); name(body.agentName, 40);
        const order = store.transaction(() => {
          const existing = store.byOwner(owner);
          if (existing) {
            if (existing.workspaceName !== body.workspaceName || existing.agentName !== body.agentName) {
              if (existing.workspaceStarted || existing.workspace || existing.sessions.length) refuse(409, 'journey_already_exists');
              existing.workspaceName = body.workspaceName; existing.agentName = body.agentName;
              existing.workspaceBody = JSON.stringify({ ...JSON.parse(existing.workspaceBody), workspace_name: body.workspaceName }); store.save(existing);
            } return existing;
          }
          const o = { id: randomUUID(), owner, workspaceName: body.workspaceName, agentName: body.agentName, sessions: [], attempt: 0, createdAt: now(), updatedAt: now(),
            cloudOrigin: cloud.origin, workspaceBody: JSON.stringify({ workspace_name: body.workspaceName, idempotency_key: randomUUID(), terms_version: 'hosted-usd-v1' }) };
          store.save(o); return o;
        }); return json({ order: view(order) });
      }
      const match = path.match(/^\/api\/agent-onboarding\/orders\/([0-9a-f-]+)\/(workspace|checkout|retry|verify)$/);
      if (!match || !UUID.test(match[1]) || request.method !== 'POST') refuse(404, 'not_found');
      const [, id, action] = match;
      const owned = store.get(id); if (!owned || owned.owner !== owner) refuse(404, 'order_not_found');
      return await exclusive(id, async () => {
        const operation = randomUUID();
        update(id, current => { if (current.operationUntil > now()) refuse(409, 'setup_busy'); current.operation = operation; current.operationUntil = now() + 120000; });
        try {
        let o = store.get(id);
        if (action === 'workspace') {
          exactKeys(body, ['authorization']);
          if (!o.workspace) {
            if (!await signupReady()) refuse(503, 'workspace_not_ready');
            let proof; try { proof = JSON.parse(Buffer.from(body.authorization.slice(6), 'base64').toString('utf8')); if (nip19.npubEncode(proof.pubkey) !== owner) throw Error(); } catch { refuse(401, 'owner_proof_invalid'); }
            update(id, current => { current.workspaceStarted = true; });
            const response = await signup(new Request(new URL('/api/hosted/workspaces', origin), { method: 'POST', headers: { 'content-type': 'application/json', authorization: body.authorization }, body: o.workspaceBody }));
            const result = await response.json();
            if (!response.ok) refuse(response.status, result.code || 'workspace_unavailable');
            const identity = result.descriptor?.identity, policy = result.policy;
            if (nip19.npubEncode(proof.pubkey) !== owner || !UUID.test(result.workspace_id || '')
              || identity?.workspace_id !== result.workspace_id || identity?.workspace_owner_npub !== owner
              || identity?.app_npub !== 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5'
              || policy?.terms_version !== 'hosted-usd-v1' || policy.plan !== 'hosted_free' || policy.allowance_bytes !== 1000000000
              || policy.billing_state !== 'usd_prepaid' || policy.billing_version !== 1 || policy.welcome_credit_usd !== '5'
              || policy.promo_expiry_days !== 30 || policy.payment_required !== false) refuse(502, 'workspace_receipt_invalid');
            o = update(id, current => { current.workspace = result; });
          }
        } else if (action === 'checkout') {
          exactKeys(body, []); if (!o.workspace) refuse(409, 'workspace_required');
          if (o.paid) return json({ order: view(await fulfil(id)) });
          const existing = o.sessions.at(-1);
          if (existing?.id) { o = await reconcile(id, existing.id); if (o.paid) return json({ order: view(await fulfil(id)) }); }
          if (o.paymentState === 'pending') return json({ order: view(o) });
          if (existing?.id && !['expired', 'failed'].includes(o.paymentState)) return json({ order: view(o) });
          const ready = await readiness(); if (!ready.ready) refuse(503, ready.error);
          if (!existing || existing.id) o = update(id, current => {
            if (current.paid || current.sessions.at(-1)?.id && !['expired', 'failed'].includes(current.paymentState)) refuse(409, 'order_changed');
            if (current.attempt >= 5) refuse(409, 'checkout_needs_support');
            current.offer = ready.offer; current.attempt++; current.checkoutExpires = Math.floor(now() / 1000) + 3600;
            current.sessions.push({ attempt: current.attempt, id: null, startedAt: now(), offer: ready.offer });
          });
          // Stripe idempotency keys may be pruned after 24h. Never repeat an uncertain creation beyond that window.
          if (now() - o.sessions.at(-1).startedAt > 23 * 3600000) refuse(409, 'checkout_needs_support');
          const session = await stripe.checkout(o, origin);
          o = update(id, current => { const a = current.sessions.at(-1); if (a.id && a.id !== session.id) refuse(409, 'payment_binding_mismatch'); Object.assign(a, session); if (!current.paid) current.paymentState = 'awaiting_payment'; });
        } else if (action === 'retry') {
          exactKeys(body, []);
          for (const s of o.sessions) if (s.id) o = await reconcile(id, s.id);
          if (o.paid) o = await fulfil(id);
        } else {
          // Backend proof, never browser claims, establishes final membership and connection readiness.
          exactKeys(body, ['generalAuthorization', 'meAuthorization', 'stateAuthorization', 'discoverAuthorization']);
          if (!o.paid || !o.agent) refuse(409, 'agent_required');
          const proof = await cloud.verify(o, body);
          if (!proof?.ready || !UUID.test(proof.generalId || '') || !UUID.test(proof.dmId || '')) refuse(409, 'setup_not_verified');
          o = update(id, current => { current.ready = true; current.channels = { generalId: proof.generalId, dmId: proof.dmId }; current.attention = null; });
        }
        return json({ order: view(o) });
        } finally { update(id, current => { if (current.operation === operation) { current.operation = null; current.operationUntil = 0; } }); }
      });
    } catch (error) { return json({ error: error.code || 'setup_unavailable', code: error.code || 'setup_unavailable' }, error.status || 503); }
  }
  return { handle, readiness, async resume() { for (const o of store.pending()) await fulfil(o.id).catch(() => {}); }, towerSignupTarget: towerSignupUrl(towerUrl) };
}
