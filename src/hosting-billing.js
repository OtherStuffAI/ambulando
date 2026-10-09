import { liveQuery } from 'dexie';
import { hostingBillingRequest } from './api.js';
import { getWorkspaceDb } from './db.js';
import { messageActivityContext, messageActivityPartition } from './message-activity/projection.js';
const billingSubscriptions = new WeakMap();
export function normalizeHostingBilling(status, usage, ledger, workspaceId) {
  if (status?.workspace_id !== workspaceId || status.version !== 1) throw new Error('Invalid hosting billing response');
  if (status.billing_mode === 'legacy_unlinked') return { status, usage: [], ledger: [] };
  if (status.billing_mode !== 'usd_prepaid' || status.currency !== 'USD' || !/^-?\d+(\.\d+)?$/.test(status.balance_usd)
    || !Array.isArray(usage?.entries) || !Array.isArray(ledger?.entries)
    || [usage, ledger].some(r => r.workspace_id !== workspaceId || r.account_id !== status.account_id)) throw new Error('Invalid hosting billing response');
  return { status, usage: usage.entries, ledger: ledger.entries };
}
// Registered read family: TowerSyncService owns requests and atomic materialization.
export async function hydrateHostingBilling(store, options = {}, deps = {}) {
  const c = messageActivityContext(store), key = messageActivityPartition(c), db = deps.db || getWorkspaceDb();
  const service = store._towerSyncService;
  const signal = options.signal || service?.readAbortController?.signal;
  const read = deps.read || hostingBillingRequest;
  const request = op => read(c.workspaceId, op, { baseUrl: c.baseUrl, appNpub: c.appNpub, signal });
  let status;
  try { status = await request('status'); } catch (error) {
    if ([401, 403].includes(error?.status)) await db.hosting_billing.delete(key);
    throw error;
  }
  const [usage, ledger] = status.billing_mode === 'usd_prepaid' ? await Promise.all([request('usage'), request('ledger')]) : [null, null];
  const snapshot = normalizeHostingBilling(status, usage, ledger, c.workspaceId);
  const current = () => { signal?.throwIfAborted(); service?.assertActive(); if (messageActivityPartition(messageActivityContext(store)) !== key || (!deps.db && getWorkspaceDb() !== db)) throw new Error('Billing context changed'); };
  await db.transaction('rw', db.hosting_billing, async () => { current(); await db.hosting_billing.put({ key, ...snapshot, fetched_at: new Date().toISOString() }); current(); });
  return { complete: true };
}
export const hostingBillingMixin = {
  hostingBillingSnapshot: null, hostingBillingError: '', hostingBillingBusy: false, hostingCheckoutBusy: false, hostingTopupCents: 1000,
  get hostingBillingCurrentSnapshot() { return this._hostingBillingKey === messageActivityPartition(messageActivityContext(this)) ? this.hostingBillingSnapshot : null; },
  hostingFormatUsd(value) { return value === null || value === undefined ? 'Unavailable' : `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })} USD`; },
  hostingLedgerUsd(units) { return this.hostingFormatUsd(Number(units) / 144000000000); },
  async refreshHostingBilling() {
    if (this.hostingBillingBusy) return;
    this.hostingBillingBusy = true; this.hostingBillingError = ''; this.hostingBillingSnapshot = null;
    billingSubscriptions.get(this)?.unsubscribe();
    const c = messageActivityContext(this), key = messageActivityPartition(c), db = getWorkspaceDb();
    this._hostingBillingKey = key;
    const subscription = liveQuery(() => db.hosting_billing.get(key)).subscribe({
      next: row => { if (this.towerUsageOpen && this._hostingBillingKey === key && messageActivityPartition(messageActivityContext(this)) === key) this.hostingBillingSnapshot = row || null; },
      error: () => { this.hostingBillingError = 'Local billing view is unavailable.'; },
    });
    billingSubscriptions.set(this, subscription);
    try { await this.getTowerSyncService().ensureLoaded('hosting-billing', key, { force: true }); }
    catch (e) { if (this._hostingBillingKey === key) this.hostingBillingError = e?.message || 'Hosting billing is unavailable.'; }
    finally { this.hostingBillingBusy = false; }
  },
  closeHostingBilling() { billingSubscriptions.get(this)?.unsubscribe(); billingSubscriptions.delete(this); this._hostingBillingKey = ''; this.hostingBillingSnapshot = null; },
  async topUpHostingBilling() {
    if (this.hostingCheckoutBusy) return;
    const c = messageActivityContext(this), key = messageActivityPartition(c);
    const amount = Number(this.hostingTopupCents), returnUrl = `${location.origin}${location.pathname}`;
    const intentKey = JSON.stringify([key, amount, returnUrl]);
    if (this._hostingCheckoutIntent?.key !== intentKey) this._hostingCheckoutIntent = { key: intentKey, idempotencyKey: crypto.randomUUID() };
    this.hostingCheckoutBusy = true; this.hostingBillingError = '';
    try {
      // Command response stays separate from materialized billing state. Redirect never grants credit.
      const response = await hostingBillingRequest(c.workspaceId, 'checkout', { baseUrl: c.baseUrl, appNpub: c.appNpub, method: 'POST', body: {
        amount_cents: amount, idempotency_key: this._hostingCheckoutIntent.idempotencyKey, return_url: returnUrl,
      } });
      if (messageActivityPartition(messageActivityContext(this)) !== key) return;
      const target = new URL(response.checkout_url);
      if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') throw new Error('Invalid Stripe Checkout URL');
      location.assign(target.href);
    } catch (e) { this.hostingBillingError = e?.message || 'Stripe Checkout is unavailable.'; }
    finally { this.hostingCheckoutBusy = false; }
  },
};
