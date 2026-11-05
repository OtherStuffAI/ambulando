import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createAgentStripe } from '../server/agent-stripe.js';
import { openOnboardingStore } from '../server/onboarding-store.js';
import { createAgentOnboarding } from '../server/agent-onboarding.js';
import { createAgentCloud } from '../server/agent-cloud.js';
import { SITE_NPUB as APP } from '../server/hosted-signup.js';
const ORIGIN = 'https://ambulando.example', CLOUD = 'https://cloud.example', TOWER = 'https://nstack.otherstuff.ai';
const ROOT = '/api/agent-onboarding', TIME = 1793849206000;
const KEY = generateSecretKey(), OTHER = generateSecretKey(), BOT = nip19.npubEncode(getPublicKey(generateSecretKey()));
const OWNER = nip19.npubEncode(getPublicKey(KEY));
const WORKSPACE = randomUUID(), GENERAL = randomUUID(), DM = randomUUID();
const resources = [];
afterEach(() => { for (const f of resources.splice(0)) f(); });
function auth(url, method, body, key = KEY, time = TIME) {
  const tags = [['u', url], ['method', method]];
  if (body) tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(time / 1000), content: randomUUID(), tags }, key))).toString('base64')}`;
}
function fixture(options = {}) {
  let clock = TIME;
  const dir = mkdtempSync(join(tmpdir(), 'agent-orders-'));
  const storePath = join(dir, 'orders.sqlite');
  const store = openOnboardingStore(storePath);
  resources.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let price = { id: 'price_agent', active: true, unit_amount: 2100, currency: 'aud', type: 'one_time', billing_scheme: 'per_unit', recurring: null, livemode: false, product: { id: 'prod_agent', active: true, name: 'Cloud agent' } };
  const account = { id: 'acct_fixture' };
  const sessions = new Map(), stripeCalls = [], checkoutKeys = new Map();
  const stripe = createAgentStripe({ secretKey: 'sk_test_fixture', priceId: 'price_agent', webhookSecret: 'whsec_fixture', now: () => clock,
    fetchImpl: async (url, init) => {
      stripeCalls.push([url, init]);
      if (url.includes('/prices/')) return Response.json(price);
      if (url.endsWith('/account')) return Response.json(account);
      if (init.method === 'POST') {
        if (options.beforeCheckoutResponse) await options.beforeCheckoutResponse();
        const params = Object.fromEntries(new URLSearchParams(init.body));
        const key = init.headers['Idempotency-Key'];
        if (!checkoutKeys.has(key)) {
          const id = `cs_test_${checkoutKeys.size + 1}`;
          const s = { id, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', livemode: false,
            client_reference_id: params.client_reference_id, metadata: { purchase_id: params['metadata[purchase_id]'], owner: params['metadata[owner]'], workspace_id: params['metadata[workspace_id]'], product_id: params['metadata[product_id]'], attempt: params['metadata[attempt]'] },
            url: `https://checkout.stripe.com/c/pay/${id}`, amount_total: 2100, amount_subtotal: 2100, currency: price.currency,
            line_items: { has_more: false, data: [{ quantity: 1, price: { ...price, product: 'prod_agent' } }] }, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 } };
          checkoutKeys.set(key, s); sessions.set(id, s);
        }
        if (options.afterCreateSession) await options.afterCreateSession(checkoutKeys.get(key));
        if (options.loseCheckoutResponse && !options.lost) { options.lost = true; throw Error('lost response'); }
        return Response.json(checkoutKeys.get(key));
      }
      const id = url.split('/sessions/')[1].split('?')[0]; return Response.json(sessions.get(id));
    } });
  const cloud = { origin: CLOUD, ready: vi.fn(async () => {}), fulfil: vi.fn(async () => { if (options.cloudDown) throw Error(); return { npub: BOT }; }), verify: vi.fn(async () => ({ ready: true, generalId: GENERAL, dmId: DM })) };
  const signup = vi.fn(async () => Response.json({ workspace_id: WORKSPACE, descriptor: { identity: { workspace_id: WORKSPACE, workspace_owner_npub: OWNER, app_npub: APP } }, policy: { terms_version: 'hosted-usd-v1', plan: 'hosted_free', allowance_bytes: 1000000000, billing_state: 'usd_prepaid', billing_version: 1, welcome_credit_usd: '5', promo_expiry_days: 30, payment_required: false } }));
  const coordinator = createAgentOnboarding({ store, stripe, cloud, signup, signupReady: async () => true, towerReady: async () => true, origin: ORIGIN, now: () => clock });
  async function call(path = '/order', body, key = KEY, extra = {}) {
    const raw = body === undefined ? null : JSON.stringify(body), method = raw === null ? 'GET' : 'POST';
    const req = new Request(`${ORIGIN}${ROOT}${path}`, { method, headers: { Authorization: auth(`${ORIGIN}${ROOT}${path}`, method, raw, key, clock), ...(raw ? { 'content-type': 'application/json' } : {}), ...extra }, ...(raw ? { body: raw } : {}) });
    const response = await coordinator.handle(req); return { status: response.status, ...await response.json() };
  }
  async function begin() {
    const { order } = await call('/order', { workspaceName: 'Home', agentName: 'Scout' });
    const proof = auth(`${TOWER}/api/v4/flightdeck-pg/hosted/workspaces`, 'POST', order.workspaceBody);
    await call(`/orders/${order.id}/workspace`, { authorization: proof });
    return (await call(`/orders/${order.id}/checkout`, {})).order;
  }
  async function webhook(order, type = 'checkout.session.completed', change = {}, sessionIdOverride) {
    const id = sessionIdOverride || store.get(order.id).sessions.at(-1).id || [...sessions.keys()].at(-1);
    const s = sessions.get(id); Object.assign(s, change);
    const raw = JSON.stringify({ object: 'event', id: `evt_${randomUUID()}`, type, livemode: false, data: { object: s } });
    const timestamp = Math.floor(clock / 1000), sig = createHmac('sha256', 'whsec_fixture').update(`${timestamp}.${raw}`).digest('hex');
    return coordinator.handle(new Request(`${ORIGIN}${ROOT}/stripe/webhook`, { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${timestamp},v1=${sig}` } }));
  }
  return { coordinator, store, storePath, account, stripe, cloud, signup, sessions, stripeCalls, checkoutKeys, call, begin, webhook, price, setTime: v => { clock = v; } };
}
describe('real Stripe adapter with controlled transport (no live payment)', () => {
  it('uses server Price currency and declines recurring, wrong amounts, inactive products and modes', async () => {
    const f = fixture(); expect(await f.stripe.offer()).toMatchObject({ amount: 2100, currency: 'aud', cadence: 'one_time', merchantId: 'acct_fixture' });
    for (const patch of [{ unit_amount: 2000 }, { type: 'recurring' }, { recurring: { interval: 'month' } }, { currency: 'jpy' }, { active: false }, { livemode: true }, { product: { id: 'prod_agent', active: false } }]) {
      const old = { ...f.price }; Object.assign(f.price, patch); await expect(f.stripe.offer()).rejects.toMatchObject({ code: 'agent_price_unsupported' }); Object.assign(f.price, old);
    }
  });
  it('requires raw webhook bytes, fresh timestamp and a valid signature', () => {
    const f = fixture();
    expect(() => f.stripe.webhook(Buffer.from('{}'), 't=1,v1=' + '0'.repeat(64))).toThrow();
    expect(() => f.stripe.webhook(Buffer.from('{}'), null)).toThrow();
    const ts = TIME / 1000, sig = createHmac('sha256', 'whsec_fixture').update(`${ts}.{}`).digest('hex');
    expect(f.stripe.webhook(Buffer.from('{}'), `t=${ts},v1=${sig}`)).toEqual({});
    expect(() => f.stripe.webhook(Buffer.from('{ }'), `t=${ts},v1=${sig}`)).toThrow();
  });
  it('rejects substituted owner/workspace/product/quantity/total/merchant and payment state', async () => {
    const f = fixture(), order = await f.begin(), o = f.store.get(order.id), s = f.sessions.values().next().value;
    for (const patch of [{ metadata: { ...s.metadata, owner: BOT } }, { metadata: { ...s.metadata, workspace_id: randomUUID() } }, { currency: 'usd' }, { amount_total: 2000 }, { client_reference_id: randomUUID() }, { livemode: true }, { mode: 'subscription' }, { account: 'acct_other' }, { line_items: { data: [{ quantity: 2, price: f.price }] } }, { payment_status: 'paid', status: 'open' }]) {
      expect(() => f.stripe.validate({ ...s, ...patch }, o)).toThrow();
    }
  });
});
describe('durable owner-bound onboarding orchestration', () => {
  it('reuses workspace and Checkout across parallel calls, cancel/reload and lost responses', async () => {
    const f = fixture({ loseCheckoutResponse: true });
    await f.begin();
    const order = (await f.call()).order;
    const [a, b] = await Promise.all([f.call(`/orders/${order.id}/checkout`, {}), f.call(`/orders/${order.id}/checkout`, {})]);
    expect(a.order.checkoutUrl).toBe(b.order.checkoutUrl); expect(f.checkoutKeys.size).toBe(1); expect(f.signup).toHaveBeenCalledTimes(1);
    const parameters = new URLSearchParams(f.stripeCalls.find(([, req]) => req.method === 'POST')[1].body);
    expect(parameters.get('adaptive_pricing[enabled]')).toBe('false');
    expect(parameters.get('automatic_tax[enabled]')).toBe('false');
    expect(parameters.get('allow_promotion_codes')).toBe('false');
    expect((await f.call()).order.id).toBe(order.id);
    expect((await f.call(`/orders/${order.id}/workspace`, { authorization: 'unneeded after durable receipt' })).status).toBe(200);
    expect(f.signup).toHaveBeenCalledTimes(1);
  });
  it('commits paid outbox before webhook response, recovers cloud outage and never buys again', async () => {
    const opts = { cloudDown: true }, f = fixture(opts), order = await f.begin();
    const response = await f.webhook(order, undefined, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_paid' });
    expect(response.status).toBe(200); expect(f.store.get(order.id)).toMatchObject({ paid: true, outbox: true });
    await f.coordinator.resume(); expect(f.store.get(order.id).agent).toBeUndefined();
    opts.cloudDown = false; await f.coordinator.resume(); expect(f.store.get(order.id).agent.npub).toBe(BOT);
    await f.call(`/orders/${order.id}/checkout`, {}); expect(f.checkoutKeys.size).toBe(1);
    await f.webhook(order, 'checkout.session.async_payment_failed', { status: 'complete', payment_status: 'unpaid' });
    expect(f.store.get(order.id).paid).toBe(true);
  });
  it('retains each attempt Price snapshot and ignores an older failed event after a newer Checkout', async () => {
    const f = fixture(), order = await f.begin(), first = f.store.get(order.id).sessions[0].id;
    await f.webhook(order, 'checkout.session.async_payment_failed', { status: 'complete', payment_status: 'unpaid' });
    f.price.currency = 'eur'; f.setTime(TIME + 20000);
    await f.call(`/orders/${order.id}/checkout`, {});
    expect(f.store.get(order.id).offer.currency).toBe('eur');
    await f.webhook(order, 'checkout.session.async_payment_failed', {}, first);
    expect(f.store.get(order.id).paymentState).toBe('awaiting_payment');
    await f.webhook(order, 'checkout.session.async_payment_succeeded', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_original' }, first);
    expect(f.store.get(order.id)).toMatchObject({ paid: true, offer: { currency: 'aud' }, receipt: { sessionId: first } });
  });
  it('publishes the ready contract only after server completion verification', async () => {
    const f = fixture(), order = await f.begin();
    expect(order.ready).toBe(false);
    await f.webhook(order, undefined, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_ready' });
    await f.coordinator.resume();
    const response = await f.call(`/orders/${order.id}/verify`, { generalAuthorization: 'controlled', meAuthorization: 'controlled', stateAuthorization: 'controlled', discoverAuthorization: 'controlled' });
    expect(response.order).toMatchObject({ ready: true, paid: true, status: 'ready', channels: { generalId: GENERAL, dmId: DM } });
    expect((await f.call()).order.ready).toBe(true);
  });
  it('handles asynchronous failure then a new terminal-unpaid attempt and late success monotonically', async () => {
    const f = fixture(), order = await f.begin();
    await f.webhook(order, 'checkout.session.completed', { status: 'complete', payment_status: 'unpaid' });
    expect((await f.call(`/orders/${order.id}/checkout`, {})).order.status).toBe('pending'); expect(f.checkoutKeys.size).toBe(1);
    await f.webhook(order, 'checkout.session.async_payment_failed');
    expect(f.store.get(order.id).paymentState).toBe('failed');
    await f.call(`/orders/${order.id}/checkout`, {}); expect(f.checkoutKeys.size).toBe(2);
    await f.webhook(order, 'checkout.session.async_payment_succeeded', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_late' });
    expect(f.store.get(order.id).paid).toBe(true);
  });
  it('refuses cross-owner proofs before signup and cross-owner orders, paid flags, arbitrary targets, and replay', async () => {
    const f = fixture(), { order } = await f.call('/order', { workspaceName: 'Home', agentName: 'Scout' });
    const badProof = auth(`${TOWER}/api/v4/flightdeck-pg/hosted/workspaces`, 'POST', order.workspaceBody, OTHER);
    expect((await f.call(`/orders/${order.id}/workspace`, { authorization: badProof })).status).toBe(401); expect(f.signup).not.toHaveBeenCalled();
    expect((await f.call(`/orders/${order.id}/checkout`, {}, OTHER)).status).toBe(404);
    expect((await f.call('/order', { workspaceName: 'x', agentName: 'y', paid: true })).status).toBe(400);
    expect((await f.call('/order', { workspaceName: 'x', agentName: 'y' }, KEY, { origin: 'https://evil.example' })).status).toBe(403);
    const request = new Request(`${ORIGIN}${ROOT}/order`, { headers: { authorization: auth(`${ORIGIN}${ROOT}/order`, 'GET', null) } });
    expect((await f.coordinator.handle(request.clone())).status).toBe(200); expect((await f.coordinator.handle(request.clone())).status).toBe(409);
  });
  it('does not offer Checkout after an invalid workspace receipt and retries the same signup intent', async () => {
    const f = fixture(), { order } = await f.call('/order', { workspaceName: 'Home', agentName: 'Scout' });
    f.signup.mockResolvedValueOnce(Response.json({ workspace_id: WORKSPACE, descriptor: { identity: { workspace_id: randomUUID() } }, policy: { terms_version: 'hosted-usd-v1' } }));
    const authorization = auth(`${TOWER}/api/v4/flightdeck-pg/hosted/workspaces`, 'POST', order.workspaceBody);
    expect((await f.call(`/orders/${order.id}/workspace`, { authorization })).code).toBe('workspace_receipt_invalid');
    expect((await f.call(`/orders/${order.id}/checkout`, {})).code).toBe('workspace_required');
    expect((await f.call()).order.workspaceBody).toBe(order.workspaceBody); expect(f.checkoutKeys.size).toBe(0);
  });
  it('allows typo repair before workspace request and locks names after a potentially committed request', async () => {
    const f = fixture(); const original = (await f.call('/order', { workspaceName: 'Home', agentName: 'Scuot' })).order;
    expect((await f.call('/order', { workspaceName: 'Home', agentName: 'Scout' })).order.id).toBe(original.id);
    await f.begin(); expect((await f.call('/order', { workspaceName: 'Elsewhere', agentName: 'Scout' })).status).toBe(409);
    expect((await f.call('/order', { workspaceName: 'x', agentName: 'a'.repeat(41) })).status).toBe(400);
    expect((await f.call('/order', { workspaceName: 'x', agentName: 'a\nb' })).status).toBe(400);
  });
  it('handles a paid webhook before the Checkout response without downgrading payment', async () => {
    const options = {}, f = fixture(options);
    options.afterCreateSession = async () => {
      options.afterCreateSession = null;
      expect((await f.webhook(f.store.byOwner(OWNER), 'checkout.session.completed', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_race' })).status).toBe(200);
    };
    const order = await f.begin();
    expect(order.paid).toBe(true); expect(order.checkoutUrl).toBeNull(); expect(f.store.get(order.id).paymentState).toBe('paid');
    await f.call(`/orders/${order.id}/checkout`, {}); expect(f.checkoutKeys.size).toBe(1);
  });
  it('serializes competing server processes with durable leases', async () => {
    let release, entered;
    const waiting = new Promise(r => { entered = r; });
    const gate = new Promise(r => { release = r; });
    const options = { beforeCheckoutResponse: async () => { entered(); await gate; } }, f = fixture(options);
    const first = f.begin(); await waiting;
    const secondStore = openOnboardingStore(f.storePath);
    try {
      const otherServer = createAgentOnboarding({ store: secondStore, stripe: f.stripe, cloud: f.cloud, signup: f.signup, signupReady: async () => true, towerReady: async () => true, origin: ORIGIN, now: () => TIME });
      const order = secondStore.byOwner(OWNER), url = `${ORIGIN}${ROOT}/orders/${order.id}/checkout`;
      const response = await otherServer.handle(new Request(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: auth(url, 'POST', '{}') } }));
      expect(response.status).toBe(409); expect((await response.json()).code).toBe('setup_busy');
      release(); await first; expect(f.checkoutKeys.size).toBe(1);
      expect(secondStore.get(order.id).sessions[0].id).toBe('cs_test_1');
    } finally { release(); secondStore.close(); }
  });
  it('refuses a changed merchant after a stored Checkout', async () => {
    const f = fixture(), order = await f.begin(); f.account.id = 'acct_other';
    expect((await f.call(`/orders/${order.id}/retry`, {})).code).toBe('merchant_mismatch');
    expect(f.store.get(order.id).paid).toBeUndefined();
  });
  it('keeps uncertain Checkout beyond Stripe idempotency retention blocked for support', async () => {
    const f = fixture({ loseCheckoutResponse: true }); await f.begin(); const order = (await f.call()).order;
    f.setTime(TIME + 24 * 3600000);
    expect((await f.call(`/orders/${order.id}/checkout`, {})).code).toBe('checkout_needs_support'); expect(f.checkoutKeys.size).toBe(1);
  });
});

describe('wmcloud service auth and completion proofs', () => {
  it('signs the exact fixed service request and verifies receipt identity', async () => {
    const calls = [], secret = 'x'.repeat(64);
    const cloud = createAgentCloud({ origin: CLOUD, secret, now: () => TIME, fetchImpl: async (url, req) => {
      calls.push([url, req]); return Response.json({ enabled: true, ready: true, required: { ledger: true, signer: true, permittedTarget: true, connectionReady: true }, nstackOrigin: TOWER, appId: APP, creditGranted: false });
    } });
    await cloud.ready(); const [url, req] = calls[0], timestamp = String(TIME / 1000);
    expect(url).toBe(`${CLOUD}/api/integrations/ambulando/readiness`);
    expect(req.headers['x-wmcloud-signature']).toBe(createHmac('sha256', secret).update(`${timestamp}\nGET\n/api/integrations/ambulando/readiness\n`).digest('hex'));
    expect(req.headers.Origin).toBeUndefined();
  });
  it('requires canonical General, exact private pair, owner-only connection, and actual bot visibility', async () => {
    const order = { id: randomUUID(), owner: OWNER, workspace: { workspace_id: WORKSPACE }, agent: { npub: BOT } };
    const general = { identity: { workspace_id: WORKSPACE, app_npub: APP }, channel: { id: GENERAL, workspace_id: WORKSPACE }, policy: { kind: 'all_workspace_members', version: 1, access_level: 'contribute', group_id: randomUUID() } };
    const me = { actor: { npub: OWNER }, identity: { workspace_id: WORKSPACE, app_npub: APP }, visible: { channels: [{ id: DM, workspace_id: WORKSPACE, kind: 'dm', participant_npubs: [OWNER, BOT] }] } };
    const state = { connections: [{ id: order.id, ownerNpub: OWNER, botNpub: BOT, workspaceId: WORKSPACE, nstackUrl: TOWER, appNpub: APP, enabled: true, paused: false, commandUsers: [OWNER], groupChannels: [], toolActions: [], web: false }] };
    const discovery = { state: 'ok', botNpub: BOT, nstackUrl: TOWER, namespace: APP, workspaces: [{ id: WORKSPACE, directMessages: [{ id: DM, with: OWNER }], otherChannels: [{ id: GENERAL }] }] };
    const cloud = createAgentCloud({ origin: CLOUD, secret: 'x'.repeat(64), now: () => TIME, fetchImpl: async url => Response.json(url.endsWith('/general/ensure') ? general : url.endsWith('/me') ? me : url.endsWith('/state') ? state : discovery) });
    const root = `${TOWER}/api/v4/flightdeck-pg/workspaces/${WORKSPACE}`;
    const proofs = () => ({ generalAuthorization: auth(`${root}/general/ensure`, 'POST', '{}'), meAuthorization: auth(`${root}/me`, 'GET'), stateAuthorization: auth(`${CLOUD}/api/nstack/state`, 'GET'), discoverAuthorization: auth(`${CLOUD}/api/nstack/discover?bot=${encodeURIComponent(BOT)}&origin=${encodeURIComponent(TOWER)}`, 'GET') });
    expect(await cloud.verify(order, proofs())).toEqual({ ready: true, generalId: GENERAL, dmId: DM });
    state.connections[0].commandUsers.push(BOT); await expect(cloud.verify(order, proofs())).rejects.toMatchObject({ code: 'setup_not_verified' }); state.connections[0].commandUsers.pop();
    me.visible.channels[0].participant_npubs.push('third'); await expect(cloud.verify(order, proofs())).rejects.toMatchObject({ code: 'setup_not_verified' }); me.visible.channels[0].participant_npubs.pop();
    discovery.workspaces[0].directMessages = []; await expect(cloud.verify(order, proofs())).rejects.toMatchObject({ code: 'setup_not_verified' });
    const wrong = proofs(); wrong.meAuthorization = auth(`${root}/me`, 'GET', null, OTHER); await expect(cloud.verify(order, wrong)).rejects.toMatchObject({ code: 'owner_proof_invalid' });
  });
});
