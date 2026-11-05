import { createHmac, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { nip19, verifyEvent } from 'nostr-tools';
import { refuse } from './agent-stripe.js';
import { SITE_NPUB as APP } from './hosted-signup.js';
const NSTACK = 'https://nstack.otherstuff.ai';
const BASE = '/api/integrations/ambulando';
export function createAgentCloud({ origin, secretFile, secret, fetchImpl = fetch, now = () => Date.now() }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Invalid cloud deployment origin');
  function credential() {
    if (!secretFile && !secret) refuse(503, 'cloud_not_configured');
    if (secretFile) {
      const st = statSync(secretFile);
      if (!st.isFile() || (st.mode & 0o777) !== 0o600) refuse(503, 'cloud_not_configured');
      const bytes = readFileSync(secretFile); if (bytes.length < 32 || bytes.length > 4096) refuse(503, 'cloud_not_configured'); return bytes;
    }
    if (Buffer.byteLength(secret) < 32) refuse(503, 'cloud_not_configured'); return Buffer.from(secret);
  }
  async function request(path, body) {
    const raw = body === undefined ? '' : JSON.stringify(body), method = body === undefined ? 'GET' : 'POST', timestamp = String(Math.floor(now() / 1000));
    const signature = createHmac('sha256', credential()).update(`${timestamp}\n${method}\n${path}\n${raw}`).digest('hex');
    const response = await fetchImpl(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'x-wmcloud-timestamp': timestamp, 'x-wmcloud-signature': signature, ...(raw ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}) });
    const result = await response.json(); if (!response.ok) refuse(503, 'cloud_unavailable'); return result;
  }
  async function ownerRequest(target, method, raw, authorization, owner) {
    try {
      if (typeof authorization !== 'string' || !authorization.startsWith('Nostr ') || authorization.length > 6000) throw Error();
      const e = JSON.parse(Buffer.from(authorization.slice(6), 'base64').toString('utf8'));
      const tag = key => { const t = e.tags.filter(t => t[0] === key); return t.length === 1 && t[0].length === 2 ? t[0][1] : null; };
      if (e.kind !== 27235 || !verifyEvent(e) || nip19.npubEncode(e.pubkey) !== owner || Math.abs(now() / 1000 - e.created_at) > 60
        || tag('u') !== target || tag('method') !== method || (raw ? tag('payload') !== createHash('sha256').update(raw).digest('hex') : tag('payload') !== null)) throw Error();
    } catch { refuse(401, 'owner_proof_invalid'); }
    const r = await fetchImpl(target, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: authorization, 'x-flightdeck-pg-app-npub': APP, ...(raw ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}) });
    if (!r.ok) refuse(409, 'setup_not_verified');
    return r.json();
  }
  return {
    origin,
    async ready() {
      const r = await request(`${BASE}/readiness`);
      if (!r.ready || !r.enabled || !r.required?.ledger || !r.required?.signer || !r.required?.permittedTarget || !r.required?.connectionReady || r.nstackOrigin !== NSTACK || r.appId !== APP || r.creditGranted !== false) refuse(503, 'cloud_unavailable');
    },
    async fulfil(o) {
      const receipt = await request(`${BASE}/fulfill`, { purchaseId: o.id, ownerNpub: o.owner, workspaceId: o.workspace.workspace_id, agentName: o.agentName,
        nstackOrigin: NSTACK, appId: APP, stripeCheckoutSessionId: o.receipt.sessionId, stripePaymentIntentId: o.receipt.paymentIntent });
      if (receipt.purchaseId !== o.id || receipt.ownerNpub !== o.owner || receipt.workspaceId !== o.workspace.workspace_id || receipt.agentName !== o.agentName
        || receipt.nstackOrigin !== NSTACK || receipt.appId !== APP || receipt.creditGranted !== false || receipt.connection !== 'owner_signature_required'
        || receipt.status !== 'provisioned' || receipt.stage !== 'completed' || !receipt.agent?.provisioned || receipt.agent.connected !== false || receipt.agent.defaultAccess !== 'private_to_creator') refuse(503, 'cloud_setup_waiting');
      return { npub: receipt.agent.npub };
    },
    async verify(o, proofs) {
      const w = o.workspace.workspace_id, root = `${NSTACK}/api/v4/flightdeck-pg/workspaces/${w}`;
      const general = await ownerRequest(`${root}/general/ensure`, 'POST', '{}', proofs.generalAuthorization, o.owner);
      const me = await ownerRequest(`${root}/me`, 'GET', null, proofs.meAuthorization, o.owner);
      const state = await ownerRequest(`${origin}/api/nstack/state`, 'GET', null, proofs.stateAuthorization, o.owner);
      const discoverPath = `/api/nstack/discover?bot=${encodeURIComponent(o.agent.npub)}&origin=${encodeURIComponent(NSTACK)}`;
      const discovery = await ownerRequest(`${origin}${discoverPath}`, 'GET', null, proofs.discoverAuthorization, o.owner);
      const c = state.connections?.find(c => c.id === o.id), g = general.channel;
      const dm = me.visible?.channels?.filter(ch => ch.workspace_id === w && ch.kind === 'dm' && !ch.archived_at && !['archived', 'deleted'].includes(ch.record_state)
        && ch.participant_npubs?.length === 2 && ch.participant_npubs.includes(o.owner) && ch.participant_npubs.includes(o.agent.npub));
      const visible = discovery.workspaces?.find(x => x.id === w);
      if (general.identity?.workspace_id !== w || general.identity?.app_npub !== APP || g?.workspace_id !== w || general.policy?.kind !== 'all_workspace_members'
        || general.policy.version !== 1 || general.policy.access_level !== 'contribute' || !general.policy.group_id || g.record_state === 'archived'
        || me.actor?.npub !== o.owner || me.identity?.workspace_id !== w || me.identity?.app_npub !== APP || dm?.length !== 1
        || !c || c.ownerNpub !== o.owner || c.botNpub !== o.agent.npub || c.workspaceId !== w || c.nstackUrl !== NSTACK || c.appNpub !== APP
        || c.enabled !== true || c.paused !== false || c.commandUsers?.length !== 1 || c.commandUsers[0] !== o.owner
        || c.groupChannels?.length !== 0 || c.toolActions?.length !== 0 || c.web !== false
        || discovery.state !== 'ok' || discovery.botNpub !== o.agent.npub || discovery.nstackUrl !== NSTACK || discovery.namespace !== APP || visible?.error || !visible?.directMessages?.some(x => x.id === dm[0].id && x.with === o.owner)
        || !visible?.otherChannels?.some(x => x.id === g.id)) refuse(409, 'setup_not_verified');
      return { ready: true, generalId: g.id, dmId: dm[0].id };
    },
  };
}
