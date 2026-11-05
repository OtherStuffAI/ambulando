import { afterEach, describe, expect, it, vi } from 'vitest';
const { sign } = vi.hoisted(() => ({ sign: vi.fn(async () => 'Nostr fixture') }));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: sign, getMemorySecret: () => null, secretToNsec: () => '' }));
import { checkoutLocation, onboardingRequest, newUserOnboardingMixin } from '../src/new-user-onboarding.js';
afterEach(() => vi.unstubAllGlobals());
describe('new-user onboarding client boundaries', () => {
  it('only navigates to secure Stripe hosted Checkout', () => {
    expect(checkoutLocation('https://checkout.stripe.com/c/pay/cs_test')).toContain('checkout.stripe.com');
    for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://evil.example/', 'https://checkout.stripe.com@evil.example/', 'javascript:alert(1)']) expect(() => checkoutLocation(url)).toThrow();
  });
  it('signs the exact server order method/url/body and never submits a browser paid flag', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ order: { id: 'saved' } }));
    expect(await onboardingRequest('/api/agent-onboarding/order', { workspaceName: 'Home', agentName: 'Scout' }, { fetchImpl, origin: 'https://app.example' })).toEqual({ order: { id: 'saved' } });
    expect(sign).toHaveBeenLastCalledWith('https://app.example/api/agent-onboarding/order', 'POST', JSON.stringify({ workspaceName: 'Home', agentName: 'Scout' }), { freshContent: true });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('paid');
  });
  it('automatically polls owner-bound status without mutating or retrying setup', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ order: { id: 'saved', paid: false, ready: false } }));
    vi.stubGlobal('fetch', fetchImpl); vi.stubGlobal('location', { origin: 'https://app.example' });
    const s = { newUserBusy: false, newUserOnboardingOpen: true, session: { npub: 'owner' }, scheduleNewUserPoll: vi.fn() };
    await newUserOnboardingMixin.pollNewUserOrder.call(s);
    expect(s.newUserOrder.id).toBe('saved'); expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/agent-onboarding/order'); expect(s.scheduleNewUserPoll).toHaveBeenCalledOnce();
  });
  it('uses configured currency and one-time amount for its offer', () => {
    const getter = Object.getOwnPropertyDescriptor(newUserOnboardingMixin, 'newUserPriceLabel').get;
    expect(getter.call({ newUserConfig: { offer: { amount: 2100, currency: 'aud' } } })).toContain('21.00');
    expect(getter.call({ newUserConfig: { offer: { amount: 2100, currency: 'aud' } } })).toContain('AUD');
  });
});
