import { createHmac, timingSafeEqual } from 'node:crypto';

export class OnboardingError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const refuse = (status, code) => { throw new OnboardingError(status, code); };
const CURRENCIES = new Set(['usd', 'aud', 'eur', 'gbp', 'cad', 'nzd']);
export function createAgentStripe({ secretKey, priceId, webhookSecret, fetchImpl = fetch, now = () => Date.now() }) {
  async function api(path, body, key) {
    if (!secretKey) refuse(503, 'payment_not_configured');
    const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2025-02-24.acacia',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    });
    const value = await response.json();
    if (!response.ok) refuse(503, 'payment_service_unavailable');
    return value;
  }
  function validPrice(p) {
    const live = /^(?:sk|rk)_live_/.test(secretKey || '');
    if (!/^(?:sk|rk)_(?:test|live)_/.test(secretKey || '') || !webhookSecret || p.id !== priceId
      || !p.active || p.livemode !== live || p.type !== 'one_time' || p.recurring
      || p.unit_amount !== 2100 || !CURRENCIES.has(p.currency) || p.billing_scheme !== 'per_unit'
      || !p.product || typeof p.product !== 'object' || !p.product.active || p.product.deleted) refuse(503, 'agent_price_unsupported');
    return { priceId: p.id, productId: p.product.id, productName: p.product.name,
      amount: p.unit_amount, currency: p.currency, livemode: p.livemode, cadence: 'one_time' };
  }
  return {
    async offer() {
      if (!priceId || !webhookSecret) refuse(503, 'payment_not_configured');
      const offer = validPrice(await api(`prices/${encodeURIComponent(priceId)}?expand[]=product`));
      const account = await api('account');
      if (!/^acct_/.test(account.id || '')) refuse(503, 'merchant_unverified');
      return { ...offer, merchantId: account.id };
    },
    async checkout(order, origin) {
      const offer = order.offer;
      const body = { mode: 'payment', 'adaptive_pricing[enabled]': 'false', 'automatic_tax[enabled]': 'false', allow_promotion_codes: 'false', 'line_items[0][price]': offer.priceId, 'line_items[0][quantity]': '1',
        client_reference_id: order.id, 'metadata[purchase_id]': order.id, 'metadata[owner]': order.owner,
        'metadata[workspace_id]': order.workspace.workspace_id, 'metadata[product_id]': offer.productId, 'metadata[attempt]': String(order.attempt),
        success_url: `${origin}/?agent_order=${order.id}`, cancel_url: `${origin}/?agent_order=${order.id}&checkout=cancelled`,
        expires_at: String(order.checkoutExpires), 'payment_intent_data[metadata][purchase_id]': order.id };
      const session = await api('checkout/sessions', body, `ambulando:${order.id}:${order.attempt}`);
      if (!session.id || session.client_reference_id !== order.id || session.livemode !== offer.livemode) refuse(502, 'checkout_invalid');
      let url; try { url = new URL(session.url); } catch { refuse(502, 'checkout_invalid'); }
      if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) refuse(502, 'checkout_invalid');
      return { id: session.id, url: url.href };
    },
    async session(id, merchantId) {
      const account = await api('account'); if (account.id !== merchantId) refuse(409, 'merchant_mismatch');
      return api(`checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items.data.price.product`);
    },
    validate(session, order) {
      const o = order.offer, m = session.metadata, lines = session.line_items;
      const line = lines?.data?.[0], price = line?.price;
      if (!order.sessions.some(s => s.id === session.id) || session.object !== 'checkout.session' || session.mode !== 'payment'
        || session.client_reference_id !== order.id || session.livemode !== o.livemode || session.account
        || m?.purchase_id !== order.id || m.owner !== order.owner || m.workspace_id !== order.workspace.workspace_id || m.product_id !== o.productId
        || session.amount_total !== o.amount || session.amount_subtotal !== o.amount || session.currency !== o.currency
        || session.subscription || lines?.has_more || lines?.data?.length !== 1 || line.quantity !== 1
        || price?.id !== o.priceId || price.unit_amount !== o.amount || price.currency !== o.currency
        || (typeof price.product === 'object' ? price.product.id : price.product) !== o.productId
        || (session.total_details && Object.values(session.total_details).some(v => v !== 0))) refuse(409, 'payment_binding_mismatch');
      if (session.payment_status === 'paid' && (session.status !== 'complete' || typeof session.payment_intent !== 'string' || !/^pi_/.test(session.payment_intent))) refuse(409, 'payment_binding_mismatch');
      return session.payment_status === 'paid' && session.status === 'complete';
    },
    webhook(bytes, header) {
      if (!webhookSecret || !header) refuse(400, 'webhook_signature_invalid');
      const fields = header.split(',').map(s => s.split('='));
      const timestamps = fields.filter(([k]) => k === 't');
      if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1])) refuse(400, 'webhook_signature_invalid');
      const timestamp = timestamps[0][1];
      if (Math.abs(now() / 1000 - Number(timestamp)) > 300) refuse(400, 'webhook_signature_invalid');
      const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(bytes).digest();
      if (!fields.some(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v || '') && timingSafeEqual(expected, Buffer.from(v, 'hex')))) refuse(400, 'webhook_signature_invalid');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { refuse(400, 'webhook_invalid'); }
    },
  };
}
