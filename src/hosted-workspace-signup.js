import { createNip98AuthHeader } from './auth/nostr.js';

export const HOSTED_TERMS_VERSION = 'hosted-free-v1';
export const HOSTED_ALLOWANCE_BYTES = 1_000_000_000;
const HOSTED_PATH = '/api/v4/flightdeck-pg/hosted/workspaces';

export function hostedSignupIntent(name) {
  const workspaceName = String(name || '').trim();
  if (!workspaceName || workspaceName.length > 80) throw new Error('Enter a workspace name of 1–80 characters.');
  const body = JSON.stringify({ workspace_name: workspaceName, idempotency_key: crypto.randomUUID(), terms_version: HOSTED_TERMS_VERSION });
  return { workspaceName, body };
}

export async function hostedSignupConfig(fetchImpl = fetch) {
  const response = await fetchImpl('/api/hosted/config', { cache: 'no-store' });
  if (!response.ok) return null;
  const config = await response.json();
  if (!config.signup_ready || !/^https:\/\/[^/?#]+\/$/.test(config.tower_public_base_url || '')) return null;
  return config;
}

export function hostedSignupError(code) {
  const messages = {
    nip98_invalid: 'The signature was invalid or expired. Retry to sign again.',
    nip98_expired: 'The signature expired. Retry to sign again.',
    signature_replayed: 'This signature was already used. Retry to sign again.',
    site_attestation_expired: 'The signup proof expired. Retry to sign again.',
    direct_user_signature_required: 'Sign with your own Nostr identity to create a workspace.',
    workspace_name_taken: 'You already have a workspace with this name. Choose another name.',
    hosted_workspace_limit: 'You have reached the hosted workspace limit.',
    signup_rate_limited: 'Too many signup attempts. Wait a while, then retry.',
    terms_version_required: 'The hosted terms version was rejected. Refresh Flight Deck before retrying.',
    site_signer_unavailable: 'Hosted signup is temporarily unavailable. Retry later.',
    tower_unavailable: 'Tower is unavailable. Retry to check whether your workspace was created.',
  };
  return messages[code] || `Workspace creation failed (${code || 'unknown error'}). Retry or contact support.`;
}

export async function submitHostedSignup(intent, config, { fetchImpl = fetch, sign = createNip98AuthHeader, onSigning = () => {}, onPending = () => {} } = {}) {
  const target = new URL(HOSTED_PATH, config.tower_public_base_url).href;
  onSigning();
  const authorization = await sign(target, 'POST', intent.body, { freshContent: true });
  onPending();
  const response = await fetchImpl('/api/hosted/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: authorization },
    body: intent.body, cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(hostedSignupError(result.code || result.error || `HTTP ${response.status}`));
    error.code = result.code || result.error;
    throw error;
  }
  if (!result.workspace_id || !result.descriptor || result.policy?.plan !== 'hosted_free'
    || result.policy?.allowance_bytes !== HOSTED_ALLOWANCE_BYTES
    || result.policy?.terms_version !== HOSTED_TERMS_VERSION
    || result.policy?.billing_state !== 'free_allowance'
    || result.policy?.payment_required !== false) throw new Error('Tower returned an invalid hosted workspace result. Retry to verify it.');
  return result;
}
