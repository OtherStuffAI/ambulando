import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { hostedSignupIntent, submitHostedSignup, hostedSignupError, hostedSignupConfig } from '../src/hosted-workspace-signup.js';

const config = { signup_ready: true, tower_public_base_url: 'https://tower.example/' };
const descriptor = { type: 'wingman_workspace_locator', identity: { workspace_id: 'workspace-1' } };
const policy = { plan: 'hosted_free', allowance_bytes: 1_000_000_000, terms_version: 'hosted-usd-v1', billing_state: 'usd_prepaid', billing_version: 1, welcome_credit_usd: '5', promo_expiry_days: 30, payment_required: false };

describe('hosted workspace signup', () => {
  it('signs the exact Tower URL and body sent to the site route; retries reuse bytes with a fresh signature', async () => {
    const intent = hostedSignupIntent('  Café  ');
    expect(Object.keys(JSON.parse(intent.body))).toEqual(['workspace_name', 'idempotency_key', 'terms_version']);
    expect(JSON.parse(intent.body)).toMatchObject({ workspace_name: 'Café', terms_version: 'hosted-usd-v1' });
    const sign = vi.fn().mockResolvedValueOnce('Nostr first').mockResolvedValueOnce('Nostr second');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspace_id: 'workspace-1', descriptor, policy }) });
    await submitHostedSignup(intent, config, { sign, fetchImpl });
    await submitHostedSignup(intent, config, { sign, fetchImpl });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledWith('https://tower.example/api/v4/flightdeck-pg/hosted/workspaces', 'POST', intent.body, { freshContent: true });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/hosted/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Nostr first' }, body: intent.body, cache: 'no-store',
    });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ body: intent.body, headers: { Authorization: 'Nostr second' } });
    expect(createHash('sha256').update(new TextEncoder().encode(fetchImpl.mock.calls[0][1].body)).digest('hex'))
      .toBe(createHash('sha256').update(new TextEncoder().encode(sign.mock.calls[0][2])).digest('hex'));
  });

  it.each([
    { billing_state: 'legacy_unlinked' }, { billing_version: 2 },
    { welcome_credit_usd: '0' }, { promo_expiry_days: 0 }, { payment_required: true },
  ])('rejects incompatible billing response: %j', async (change) => {
    await expect(submitHostedSignup(hostedSignupIntent('One'), config, {
      sign: async () => 'Nostr test', fetchImpl: async () => Response.json({ workspace_id: 'workspace-1', descriptor, policy: { ...policy, ...change } }),
    })).rejects.toThrow(/invalid hosted workspace result/);
  });

  it.each([null, { signup_ready: false }, { ...config, tower_public_base_url: 'https://user:password@tower.example/' },
    { ...config, tower_public_base_url: 'http://tower.example/' }, { ...config, tower_public_base_url: 'https://tower.example/path' },
  ])('refuses invalid readiness configuration: %j', async value => {
    expect(await hostedSignupConfig(async () => Response.json(value))).toBeNull();
  });

  it('gives recoverable errors for denial, expiry and transport failure', async () => {
    const intent = hostedSignupIntent('One');
    await expect(submitHostedSignup(intent, config, { sign: () => Promise.reject(new Error('Denied')), fetchImpl: vi.fn() })).rejects.toThrow('Denied');
    await expect(submitHostedSignup(intent, config, { sign: () => 'Nostr test', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ code: 'nip98_invalid' }) }) })).rejects.toThrow(/expired/);
    expect(hostedSignupError('tower_unavailable')).toMatch(/Retry/);
  });
});
