import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getWorkspaceDb } from '../src/db.js';
import { hydrateHostingBilling, normalizeHostingBilling, hostingBillingMixin } from '../src/hosting-billing.js';
import { messageActivityContext, messageActivityPartition } from '../src/message-activity/projection.js';
const makeStore = () => ({ session: { npub: 'reader' }, signingNpub: 'reader', workspaceDbKey: 'hosting-tests', selectedBoardId: 'scope',
  currentWorkspace: { workspaceId: 'workspace', workspaceOwnerNpub: 'owner', directHttpsUrl: 'http://localhost:3100', appNpub: 'app', towerServiceNpub: 'tower', workspaceServiceNpub: 'service' } });
const status = { version: 1, workspace_id: 'workspace', account_id: 'account', billing_mode: 'usd_prepaid', currency: 'USD', balance_usd: '5.000000000000', promo_usd: '5', promo_expires_at: '2026-11-01T00:00:00Z', stripe: { configured: false } };
const entries = { workspace_id: 'workspace', account_id: 'account', entries: [] };
beforeEach(async () => { await openWorkspaceDb(`hosting-tests-${crypto.randomUUID()}`).open(); });
afterEach(async () => { await getWorkspaceDb().delete(); });
it('materializes authenticated status/history into workspace-and-viewer partition', async () => {
  const store = makeStore(), read = vi.fn(async (_id, op) => op === 'status' ? status : entries);
  await hydrateHostingBilling(store, {}, { read });
  expect(read).toHaveBeenCalledTimes(3);
  const row = await getWorkspaceDb().hosting_billing.get(messageActivityPartition(messageActivityContext(store)));
  expect(row.status.balance_usd).toBe('5.000000000000'); expect(row.ledger).toEqual([]);
});
it('existing workspaces remain explicitly unlinked without fetching account financial history', async () => {
  const store = makeStore(), read = vi.fn(async () => ({ ...status, billing_mode: 'legacy_unlinked' }));
  await hydrateHostingBilling(store, {}, { read }); expect(read).toHaveBeenCalledTimes(1);
});
it('rejects mismatched account/workspace data before committing', () => {
  expect(() => normalizeHostingBilling(status, { ...entries, account_id: 'someone-else' }, entries, 'workspace')).toThrow();
  expect(() => normalizeHostingBilling({ ...status, balance_usd: 'NaN' }, entries, entries, 'workspace')).toThrow();
});
it('permission and transport failures do not write false balance or success state', async () => {
  const store = makeStore();
  await expect(hydrateHostingBilling(store, {}, { read: async () => { throw new Error('Permission denied'); } })).rejects.toThrow('Permission denied');
  expect(await getWorkspaceDb().hosting_billing.count()).toBe(0);
});
it('late responses cannot materialize into a switched workspace', async () => {
  const store = makeStore(); let release;
  const pending = hydrateHostingBilling(store, {}, { read: async (_id, op) => op === 'status' ? new Promise(r => { release = r; }) : entries });
  store.currentWorkspace.workspaceId = 'new-workspace'; release(status);
  await expect(pending).rejects.toThrow('Billing context changed'); expect(await getWorkspaceDb().hosting_billing.count()).toBe(0);
});
it('refresh errors stay visible and close clears subscription and stale snapshot', async () => {
  const store = Object.assign(makeStore(), hostingBillingMixin, { towerUsageOpen: true, getTowerSyncService: () => ({ ensureLoaded: async () => { throw new Error('Stripe not configured'); } }) });
  await store.refreshHostingBilling(); expect(store.hostingBillingError).toBe('Stripe not configured'); expect(store.hostingBillingBusy).toBe(false);
  store.closeHostingBilling(); expect(store.hostingBillingSnapshot).toBeNull(); expect(store._hostingBillingKey).toBe('');
});

it('revoked authority clears cached financial data before reporting denial', async () => {
  const store = makeStore(), key = messageActivityPartition(messageActivityContext(store));
  await hydrateHostingBilling(store, {}, { read: async (_id, op) => op === 'status' ? status : entries });
  await expect(hydrateHostingBilling(store, {}, { read: async () => { throw Object.assign(new Error('revoked'), { status: 403 }); } })).rejects.toThrow('revoked');
  expect(await getWorkspaceDb().hosting_billing.get(key)).toBeUndefined();
});
