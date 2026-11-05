const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Real sol handler, SQLite, Stripe validation and signature checks. All external
// Stripe, wmcloud and Tower I/O below is controlled test transport.
async function onboardingBoundary(origin) {
  const moduleAt = file => require(path.resolve(__dirname, '../../..', file));
  const [{ openOnboardingStore }, { createAgentStripe }, { createAgentCloud }, { createAgentOnboarding }, nostr, { createHostedSignupHandler, SITE_NPUB: APP }] = await Promise.all([
    moduleAt('server/onboarding-store.js'), moduleAt('server/agent-stripe.js'), moduleAt('server/agent-cloud.js'), moduleAt('server/agent-onboarding.js'), require('nostr-tools'), moduleAt('server/hosted-signup.js'),
  ]);
  const store = openOnboardingStore(':memory:'), workspaceId = randomUUID(), generalId = randomUUID(), dmId = randomUUID();
  const publicNpub = () => nostr.nip19.npubEncode(nostr.getPublicKey(nostr.generateSecretKey()));
  const bot = publicNpub(), service = publicNpub(), siteKey = nostr.generateSecretKey();
  const tower = 'https://nstack.otherstuff.ai', cloudOrigin = 'https://cloud.fixture';
  const calls = [], sessions = new Map(), keys = new Map();
  let policy = null, failFulfil = false, owner = null;
  const descriptor = { type: 'wingman_workspace_locator', tower_base_url: `${tower}/`, identity: { workspace_id: workspaceId, app_npub: APP, tower_service_npub: service, workspace_service_npub: service, workspace_owner_npub: null }, label: 'Test home' };
  const general = () => ({ identity: { workspace_id: workspaceId, app_npub: APP }, scope: { id: generalId, workspace_id: workspaceId, name: 'Shared' }, channel: { id: generalId, workspace_id: workspaceId, scope_id: generalId, name: 'General', kind: 'channel' }, policy: { kind: 'all_workspace_members', version: 1, group_id: workspaceId, access_level: 'contribute' } });
  const price = { id: 'price_fixture', active: true, currency: 'aud', unit_amount: 2100, type: 'one_time', recurring: null, livemode: false, billing_scheme: 'per_unit', product: { id: 'prod_fixture', active: true, name: 'Cloud agent' } };
  const stripe = createAgentStripe({ secretKey: 'sk_test_fixture', priceId: price.id, webhookSecret: 'whsec_fixture', fetchImpl: async (url, req) => {
    if (url.includes('/prices/')) return Response.json(price);
    if (url.endsWith('/account')) return Response.json({ id: 'acct_fixture' });
    if (req.method === 'POST') {
      const key = req.headers['Idempotency-Key'];
      if (!keys.has(key)) {
        const p = Object.fromEntries(new URLSearchParams(req.body)), id = `cs_test_fixture${keys.size}`;
        const session = { id, object: 'checkout.session', mode: 'payment', livemode: false, status: 'open', payment_status: 'unpaid', client_reference_id: p.client_reference_id,
          metadata: { purchase_id: p['metadata[purchase_id]'], workspace_id: p['metadata[workspace_id]'], owner: p['metadata[owner]'], product_id: p['metadata[product_id]'], attempt: p['metadata[attempt]'] },
          url: `https://checkout.stripe.com/c/pay/${id}`, currency: 'aud', amount_total: 2100, amount_subtotal: 2100,
          line_items: { has_more: false, data: [{ quantity: 1, price: { ...price, product: price.product.id } }] } };
        keys.set(key, session); sessions.set(id, session); calls.push('checkout');
      }
      return Response.json(keys.get(key));
    }
    return Response.json(sessions.get(url.split('/sessions/')[1].split('?')[0]));
  } });
  const cloud = createAgentCloud({ origin: cloudOrigin, secret: 'fixture-service-authentication-secret', fetchImpl: async (url, req) => {
    if (url.endsWith('/readiness')) return Response.json({ enabled: true, ready: true, required: { ledger: true, signer: true, permittedTarget: true, connectionReady: true }, nstackOrigin: tower, appId: APP, creditGranted: false });
    if (url.endsWith('/fulfill')) {
      calls.push('fulfill'); if (failFulfil) return Response.json({}, { status: 503 });
      const body = JSON.parse(req.body); return Response.json({ ...body, status: 'provisioned', stage: 'completed', agent: { npub: bot, provisioned: true, connected: false, defaultAccess: 'private_to_creator' }, creditGranted: false, connection: 'owner_signature_required' });
    }
    if (url.endsWith('/general/ensure')) return Response.json(general());
    if (url.endsWith('/me')) return Response.json({ actor: { npub: owner }, identity: { workspace_id: workspaceId, app_npub: APP }, visible: { channels: [{ id: dmId, workspace_id: workspaceId, kind: 'dm', participant_npubs: [owner, bot] }] } });
    if (url.endsWith('/state')) return Response.json({ connections: policy ? [{ id: policy.connection_id, ownerNpub: owner, botNpub: bot, workspaceId, nstackUrl: tower, appNpub: APP, enabled: true, paused: false, commandUsers: policy.command_users, groupChannels: policy.group_channels, toolActions: policy.tool_actions, web: policy.web }] : [] });
    if (url.includes('/discover?')) return Response.json({ state: 'ok', botNpub: bot, nstackUrl: tower, namespace: APP, workspaces: [{ id: workspaceId, directMessages: [{ id: dmId, with: owner }], otherChannels: [{ id: generalId, name: 'General' }] }] });
    throw Error('Unexpected controlled boundary');
  } });
  const signup = createHostedSignupHandler({ towerUrl: `${tower}/`, siteNpub: nostr.nip19.npubEncode(nostr.getPublicKey(siteKey)),
    sign: (url, hash, id, time) => nostr.finalizeEvent({ kind: 27235, created_at: time, content: '', tags: [['u', url], ['method', 'POST'], ['payload', hash], ['user_event_id', id]] }, siteKey),
    fetchImpl: async (_, req) => {
      const e = JSON.parse(Buffer.from(req.headers.authorization.slice(6), 'base64').toString()); owner = nostr.nip19.npubEncode(e.pubkey); descriptor.identity.workspace_owner_npub = owner;
      calls.push('workspace'); return Response.json({ workspace_id: workspaceId, descriptor, policy: { terms_version: 'hosted-usd-v1', plan: 'hosted_free', allowance_bytes: 1000000000, billing_state: 'usd_prepaid', billing_version: 1, welcome_credit_usd: '5', promo_expiry_days: 30, payment_required: false } });
    } });
  const coordinator = createAgentOnboarding({ store, stripe, cloud, signup, signupReady: async () => true, towerReady: async () => true, origin });
  return {
    store, calls, workspaceId, generalId, dmId, bot, descriptor,
    order() { return store.byOwner(owner); },
    setCloudDown(value) { failFulfil = value; },
    async paid() { for (const s of sessions.values()) Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixture' }); },
    async route(route) {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname.startsWith('/api/agent-onboarding')) {
        const response = await coordinator.handle(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) }));
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      }
      if (url.origin === cloudOrigin && url.pathname === '/api/nstack/connection') {
        const e = JSON.parse(Buffer.from(req.headers().authorization.slice(6), 'base64').toString());
        if (!nostr.verifyEvent(e) || nostr.nip19.npubEncode(e.pubkey) !== owner) throw Error('Invalid owner policy proof');
        policy = JSON.parse(req.postData()); calls.push('connection'); return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      if (url.hostname === 'checkout.stripe.com') return route.fulfill({ contentType: 'text/html', body: '<h1>Controlled Stripe boundary — no payment</h1>' });
      return null;
    },
    command(name) { calls.push(name); if (name === 'general.ensure') return general(); return { actor: { npub: bot }, membership: { workspace_id: workspaceId } }; },
  };
}
module.exports = { onboardingBoundary };
