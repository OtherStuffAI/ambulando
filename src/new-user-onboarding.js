import { createTowerPgWorkspaceMember, ensureTowerPgGeneral } from './tower-command-intents.js';
import { createNip98AuthHeader, getMemorySecret, secretToNsec } from './auth/nostr.js';
import { FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
const ROOT = '/api/agent-onboarding';
const PUBLIC_TOWER = 'https://nstack.otherstuff.ai';
const runtime = new WeakMap();
const messages = {
  journey_already_exists: 'Your original setup is saved. Resume it instead of starting another workspace.',
  checkout_needs_support: 'We need to check your original checkout. Contact support with your order reference before trying another payment.',
  signature_invalid: 'Please approve a fresh signature and try again.',
  signature_replayed: 'Please approve a fresh signature and try again.',
  rate_limited: 'Please wait a moment before checking again.',
  setup_not_verified: 'Your setup is still waiting for verification. Retry without paying again.',
};
export async function onboardingRequest(path, body, { fetchImpl = fetch, sign = createNip98AuthHeader, origin = location.origin } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  const raw = body === undefined ? null : JSON.stringify(body);
  const authorization = await sign(new URL(path, origin).href, method, raw, { freshContent: true });
  const response = await fetchImpl(path, { method, headers: { Authorization: authorization, ...(raw ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}), cache: 'no-store' });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(messages[value.code] || 'Setup could not finish yet. Your saved progress is kept; try again.');
  return value;
}
export function checkoutLocation(value) {
  const url = new URL(value);
  if (url.origin !== 'https://checkout.stripe.com' || url.username || url.password) throw new Error('Checkout is unavailable. Please retry later.');
  return url.href;
}
export const newUserOnboardingMixin = {
  newUserOnboardingOpen: false, newUserBusy: false, newUserError: '', newUserConfig: null,
  newUserOrder: null, newUserWorkspaceName: 'My workspace', newUserAgentName: 'Scout',
  newUserRecoverySaved: false, newUserTermsAccepted: false,
  get newUserPriceLabel() {
    const offer = this.newUserOrder?.offer || this.newUserConfig?.offer;
    return offer ? new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency, currencyDisplay: 'code' }).format(offer.amount / 100) : '';
  },
  async beginNewUserSignup() {
    await this.login('ephemeral');
    if (this.isLoggedIn && !this.knownWorkspaces.length && !this.newUserOnboardingOpen) await this.openNewUserOnboarding();
  },
  async resumeNewUserOnboarding() {
    if (typeof window === 'undefined' || typeof location === 'undefined' || !this.session?.npub) return false;
    let preference = ''; try { preference = localStorage.getItem(`ambulando.onboarding:${this.session.npub}`) || ''; } catch {}
    const returning = new URL(location.href).searchParams.has('agent_order');
    if (!returning && (preference === 'dismissed' || this.knownWorkspaces.length && preference !== 'pending')) return false;
    await this.openNewUserOnboarding(); return true;
  },
  async openNewUserOnboarding() {
    try { localStorage.setItem(`ambulando.onboarding:${this.session.npub}`, 'pending'); } catch {}
    this.newUserOnboardingOpen = true; this.showConnectModal = false; this.showWorkspaceBootstrapModal = false;
    this.newUserError = ''; this.newUserBusy = true;
    const owner = this.session?.npub;
    try {
      const config = await fetch(`${ROOT}/config`, { cache: 'no-store' }).then(r => r.json());
      if (this.session?.npub !== owner) return;
      this.newUserConfig = config;
      const { order } = await onboardingRequest(`${ROOT}/order`);
      if (this.session?.npub !== owner) return;
      this.newUserOrder = order;
      if (order) { this.newUserWorkspaceName = order.workspaceName; this.newUserAgentName = order.agentName; }
      if (order?.ready) await this.openCompletedNewUserWorkspace();
      else if (order?.workspace) this.scheduleNewUserPoll();
    } catch (error) { this.newUserError = error.message; }
    finally { this.newUserBusy = false; }
  },
  saveNewUserRecovery() {
    const secret = getMemorySecret();
    if (!secret) { this.newUserError = 'Use your signer’s recovery procedure to keep access to this identity.'; return; }
    const blob = new Blob([`Ambulando identity recovery\nKeep this file private. Anyone with this key can use your identity.\n\n${secretToNsec(secret)}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'ambulando-identity-recovery.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async prepareNewUserWorkspace() {
    if (this.newUserBusy || !this.newUserTermsAccepted || (this.session?.method === 'ephemeral' && !this.newUserRecoverySaved)) return;
    this.newUserBusy = true; this.newUserError = '';
    const owner = this.session?.npub;
    try {
      if (!this.newUserConfig?.ready) throw new Error('Cloud agent signup is not available yet. Please try again later or connect an existing workspace.');
      let order = this.newUserOrder;
      if (!order?.workspaceStarted) ({ order } = await onboardingRequest(`${ROOT}/order`, { workspaceName: this.newUserWorkspaceName.trim(), agentName: this.newUserAgentName.trim() }));
      if (this.session?.npub !== owner) return;
      this.newUserOrder = order;
      if (!order.workspace) {
        const target = `${PUBLIC_TOWER}/api/v4/flightdeck-pg/hosted/workspaces`;
        const authorization = await createNip98AuthHeader(target, 'POST', order.workspaceBody, { freshContent: true });
        ({ order } = await onboardingRequest(`${ROOT}/orders/${order.id}/workspace`, { authorization }));
        if (this.session?.npub !== owner) return;
        this.newUserOrder = order;
      }
    } catch (error) { this.newUserError = error.message; }
    finally { this.newUserBusy = false; }
  },
  async checkoutNewUserAgent() {
    if (this.newUserBusy || !this.newUserOrder?.workspace) return;
    this.newUserBusy = true; this.newUserError = '';
    const owner = this.session?.npub;
    try {
      const { order } = await onboardingRequest(`${ROOT}/orders/${this.newUserOrder.id}/checkout`, {});
      if (this.session?.npub !== owner) return;
      this.newUserOrder = order;
      if (order.paid) { this.scheduleNewUserPoll(); return; }
      if (order.checkoutUrl) location.assign(checkoutLocation(order.checkoutUrl));
      else this.scheduleNewUserPoll();
    } catch (error) { this.newUserError = error.message; }
    finally { this.newUserBusy = false; }
  },
  scheduleNewUserPoll() {
    const prior = runtime.get(this); if (prior) clearTimeout(prior);
    if (!this.newUserOnboardingOpen || !this.session?.npub || this.newUserOrder?.ready) return;
    runtime.set(this, setTimeout(() => { if (!document.hidden) void this.pollNewUserOrder(); else this.scheduleNewUserPoll(); }, 5000));
  },
  async pollNewUserOrder() {
    if (this.newUserBusy || !this.newUserOnboardingOpen) { this.scheduleNewUserPoll(); return; }
    const owner = this.session?.npub;
    try {
      const { order } = await onboardingRequest(`${ROOT}/order`);
      if (this.session?.npub !== owner || !this.newUserOnboardingOpen) return;
      if (order) this.newUserOrder = order;
      if (order?.ready) await this.openCompletedNewUserWorkspace();
    } catch { /* Keep saved progress; explicit Check payment / Retry provides recovery. */ }
    finally { this.scheduleNewUserPoll(); }
  },
  async refreshNewUserOrder(continueSetup = false) {
    if (this.newUserBusy || !this.newUserOrder) return;
    const owner = this.session?.npub;
    this.newUserBusy = true; this.newUserError = '';
    try {
      const { order } = await onboardingRequest(`${ROOT}/orders/${this.newUserOrder.id}/retry`, {});
      if (this.session?.npub !== owner) return;
      this.newUserOrder = order;
      if (continueSetup && order.agent) await this.connectNewUserAgent();
      if (this.newUserOrder?.ready) await this.openCompletedNewUserWorkspace();
    } catch (error) { this.newUserError = error.message; }
    finally { this.newUserBusy = false; this.scheduleNewUserPoll(); }
  },
  async connectNewUserAgent() {
    // Filled by the supported Tower command + owner-signed wmcloud policy contract.
    const order = this.newUserOrder;
    if (!order?.paid || !order.agent || !order.workspace) throw new Error('Your paid agent is still being prepared. Retry setup in a moment.');
    await completeNewUserConnection(this, order, next => { this.newUserOrder = next; });
  },
  async openCompletedNewUserWorkspace() {
    const order = this.newUserOrder; if (!order?.ready) return;
    await this.connectWithPgDescriptor(JSON.stringify(order.workspace.descriptor), { selectWorkspaceOptions: { openWorkspaceHome: true } });
    if (this.workspaceSelectionError) throw new Error(this.workspaceSelectionError);
    await this.getTowerSyncService()?.ensureLoaded('channels', '', { force: true });
    this.newUserOnboardingOpen = false;
    try { localStorage.removeItem(`ambulando.onboarding:${this.session.npub}`); } catch {}
    const url = new URL(location.href); url.searchParams.delete('agent_order'); url.searchParams.delete('checkout'); history.replaceState(null, '', url);
  },
  closeNewUserOnboarding({ connectExisting = true } = {}) {
    clearTimeout(runtime.get(this)); runtime.delete(this); this.newUserOnboardingOpen = false;
    if (connectExisting && this.session?.npub) { try { localStorage.setItem(`ambulando.onboarding:${this.session.npub}`, 'dismissed'); } catch {} }
    if (connectExisting && !this.knownWorkspaces.length && this.session?.npub) this.openConnectModal();
  },
};

async function signedJson(url, method, body) {
  const raw = body === undefined ? null : JSON.stringify(body);
  const authorization = await createNip98AuthHeader(url, method, raw, { freshContent: true });
  const response = await fetch(url, { method, headers: { Authorization: authorization, ...(raw ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}), redirect: 'error', cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error('Your payment is safe. Workspace connection is waiting; retry setup without paying again.');
  return result;
}
// Shared records use Tower commands and Dexie; external payment/owner-policy commands remain separate.
async function completeNewUserConnection(store, order, update) {
  const owner = store.session?.npub;
  await store.connectWithPgDescriptor(JSON.stringify(order.workspace.descriptor), { closeModal: true });
  if (store.session?.npub !== owner || store.workspaceSelectionError) throw new Error('Please sign in with the identity that started this setup.');
  const options = { baseUrl: PUBLIC_TOWER, appNpub: FLIGHT_DECK_PG_APP_NPUB };
  await createTowerPgWorkspaceMember(store, order.workspace.workspace_id, { member_npub: order.agent.npub, kind: 'agent', role: 'member', display_name: order.agentName }, options);
  await ensureTowerPgGeneral(store, order.workspace.workspace_id, options);
  await store.refreshTowerPgWorkspaceMembers({ force: true, limit: 200 });
  const dm = await store.ensureTowerPgDmChannel(order.agent.npub);
  if (!dm?.record_id) throw new Error('Your private conversation is still being prepared. Retry setup.');
  const cloud = new URL(order.cloudOrigin);
  if (cloud.protocol !== 'https:' || cloud.origin !== order.cloudOrigin) throw new Error('Cloud connection is unavailable.');
  await signedJson(`${cloud.origin}/api/nstack/connection`, 'PUT', {
    connection_id: order.connectionId, bot_npub: order.agent.npub, nstack_url: PUBLIC_TOWER,
    workspace_id: order.workspace.workspace_id, app_npub: FLIGHT_DECK_PG_APP_NPUB,
    command_users: [owner], enabled: true, group_channels: [], tool_actions: [], web: false,
  });
  const root = `${PUBLIC_TOWER}/api/v4/flightdeck-pg/workspaces/${order.workspace.workspace_id}`;
  const proof = async (url, method = 'GET', body = null) => createNip98AuthHeader(url, method, body, { freshContent: true });
  // Proofs are single-use for exact routes; the server forwards them and checks canonical responses.
  const proofs = {
    generalAuthorization: await proof(`${root}/general/ensure`, 'POST', '{}'),
    meAuthorization: await proof(`${root}/me`),
    stateAuthorization: await proof(`${cloud.origin}/api/nstack/state`),
    discoverAuthorization: await proof(`${cloud.origin}/api/nstack/discover?bot=${encodeURIComponent(order.agent.npub)}&origin=${encodeURIComponent(PUBLIC_TOWER)}`),
  };
  if (store.session?.npub !== owner) throw new Error('Your identity changed. Sign in again to resume setup.');
  const result = await onboardingRequest(`${ROOT}/orders/${order.id}/verify`, proofs);
  if (store.session?.npub !== owner) throw new Error('Your identity changed. Sign in again to resume setup.');
  update(result.order);
}
