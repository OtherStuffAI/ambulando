import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
const mock = vi.hoisted(() => ({ fetch: vi.fn(), descriptor: vi.fn(), bridge: vi.fn(), auth: vi.fn(), savePreference: vi.fn() }));
vi.mock('../src/tower-transport.js', async importOriginal => ({ ...await importOriginal(), towerFetch: mock.fetch, connectTowerBridge: mock.bridge, saveTowerTransportPreference: mock.savePreference }));
vi.mock('../src/auth/nostr.js', async importOriginal => ({ ...await importOriginal(), createNip98AuthHeader: mock.auth }));
vi.mock('../src/api.js', async importOriginal => ({ ...await importOriginal(), getTowerPgWorkspaceDescriptor: mock.descriptor }));
import { importTowerTransports, getTowerTransport } from '../src/tower-transport.js';
import { connectSettingsManagerMixin as mixin } from '../src/connect-settings-manager.js';
const secret = new Uint8Array(32).fill(1);
const service = nip19.npubEncode(getPublicKey(secret));
const payload = { type: 'nstack-workspace', version: 3, service_npub: service, workspace_id: '11111111-2222-3333-4444-555555555555', workspace_service_npub: service,
  transports: { https: { url: 'https://tower.example' }, fips: { peer_npub: service, host: `${service}.fips`, port: 4443 } }, policy: { preferred: 'https', fallback: 'none' } };
const encode = p => 'nstack:workspace:v3:' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 30383, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'nstack-workspace-connection-v3']], content: JSON.stringify(p) }, secret))).toString('base64url');
function store(p = payload) {
  return { ...Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(mixin)).filter(([, d]) => typeof d.value === 'function').map(([k, d]) => [k, d.value])), session: { npub: 'user' }, connectManualUrl: encode(p), knownHosts: [], knownWorkspaces: [],
    rememberVerifiedPgWorkspace: vi.fn(async () => ({ workspaceKey: 'exact' })), selectWorkspace: vi.fn(),
    verifyPgDescriptor: vi.fn(async () => ({ descriptor: { towerBaseUrl: 'https://tower.example' }, me: {} })) };
}
beforeEach(() => {
  vi.clearAllMocks(); importTowerTransports([]); mock.auth.mockResolvedValue('Nostr user');
  mock.fetch.mockImplementation(async url => {
    const nonce = new URL(url).searchParams.get('nonce');
    const now = Math.floor(Date.now() / 1000);
    const proof = finalizeEvent({ kind: 30384, created_at: now, tags: [['d', 'nstack-connection-challenge-v1']], content: JSON.stringify({ nonce, service_npub: service, workspace_id: payload.workspace_id, workspace_service_npub: service, request_url: url, expires_at: now + 60 }) }, secret);
    return { ok: true, text: async () => JSON.stringify({ proof }) };
  });
  mock.descriptor.mockResolvedValue({ type: 'wingman_workspace_locator', tower_base_url: 'https://tower.example', identity: { tower_service_npub: service, workspace_id: payload.workspace_id, workspace_service_npub: service, workspace_owner_npub: service } });
});
describe('workspace QR orchestration', () => {
  it('previews locally without connecting, persisting or changing the identity', async () => {
    const s = store(); await s.connectByo();
    expect(s.connectWorkspacePreview.payload.workspace_id).toBe(payload.workspace_id);
    expect(mock.fetch).not.toHaveBeenCalled(); expect(s.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    expect(s.session.npub).toBe('user');
  });
  it('rejects whitespace and copy-cap bypass before preview', async () => {
    const s = store(); s.connectManualUrl += ' '.repeat(8192); await s.connectByo();
    expect(s.connectWorkspacePreview).toBeNull(); expect(s.connectHostError).toBeTruthy();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('confirms, challenges, verifies existing registration and selects the exact workspace', async () => {
    const s = store(); await s.connectByo(); await s.confirmWorkspaceConnection();
    expect(s.connectHostError).toBeNull(); expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(s.verifyPgDescriptor.mock.calls[0][1].verifyRegistration).toBe(true);
    expect(s.rememberVerifiedPgWorkspace).toHaveBeenCalledOnce();
    expect(s.selectWorkspace).toHaveBeenCalledWith('exact', { pgVerified: true });
  });
  it.each([401, 403, 404])('denial %s leaves saved state and selection intact', async status => {
    mock.fetch.mockResolvedValue({ ok: false, status });
    const s = store(); await s.connectByo(); await s.confirmWorkspaceConnection();
    expect(s.connectHostError).toContain(String(status)); expect(mock.descriptor).not.toHaveBeenCalled();
    expect(s.rememberVerifiedPgWorkspace).not.toHaveBeenCalled(); expect(s.selectWorkspace).not.toHaveBeenCalled();
  });
  it('rejects descriptor substitution and changed existing pins before storage', async () => {
    const s = store(); await s.connectByo();
    mock.descriptor.mockResolvedValue({ type: 'wingman_workspace_locator', identity: { workspace_id: 'different', workspace_service_npub: service, workspace_owner_npub: service } });
    await s.confirmWorkspaceConnection(); expect(s.connectHostError).toContain('mismatch');
    expect(s.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    const pinned = store(); pinned.knownHosts = [{ url: 'https://tower.example', serviceNpub: 'different' }];
    await pinned.connectByo(); mock.fetch.mockClear(); await pinned.confirmWorkspaceConnection();
    expect(mock.fetch).not.toHaveBeenCalled(); expect(pinned.connectHostError).toContain('pin');
  });
  it('keeps the entire successful FIPS path on its selected peer', async () => {
    const origin = `http://${service}.fips:4443`;
    const disconnect = vi.fn();
    mock.bridge.mockResolvedValue({ mode: 'fips', transport: 'native', endpoint: origin, serviceNpub: service, handle: { disconnect } });
    const s = store({ ...payload, policy: { preferred: 'fips', fallback: 'none' } });
    s.verifyPgDescriptor.mockResolvedValue({ descriptor: { towerBaseUrl: origin }, me: {} });
    await s.connectByo(); await s.confirmWorkspaceConnection();
    expect(s.connectHostError).toBeNull();
    expect(mock.fetch.mock.calls.every(([url]) => url.startsWith(origin + '/'))).toBe(true);
    expect(mock.descriptor).toHaveBeenCalledWith(payload.workspace_id, { baseUrl: origin, appNpub: null });
    expect(mock.savePreference).toHaveBeenCalledWith(origin, { mode: 'fips', endpoint: origin, serviceNpub: service });
    expect(s.selectWorkspace).toHaveBeenCalledWith('exact', { pgVerified: true });
    expect(s.rememberVerifiedPgWorkspace.mock.calls[0][2].select).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('releases a staged FIPS handle on access denial without changing selection', async () => {
    const origin = `http://${service}.fips:4443`;
    const disconnect = vi.fn();
    mock.bridge.mockResolvedValue({ mode: 'fips', transport: 'native', endpoint: origin, serviceNpub: service, handle: { disconnect } });
    mock.fetch.mockResolvedValue({ ok: false, status: 403 });
    const s = store({ ...payload, policy: { preferred: 'fips', fallback: 'none' } });
    await s.connectByo(); await s.confirmWorkspaceConnection();
    expect(disconnect).toHaveBeenCalledOnce(); expect(getTowerTransport(origin).mode).toBe('https');
    expect(mock.savePreference).not.toHaveBeenCalled(); expect(s.selectWorkspace).not.toHaveBeenCalled();
  });
  it('missing scoped FIPS transport does not issue HTTPS or save anything', async () => {
    mock.bridge.mockRejectedValue(Error('FIPS requires WMapp with scoped transport handles'));
    const s = store({ ...payload, policy: { preferred: 'fips', fallback: 'none' } });
    await s.connectByo(); await s.confirmWorkspaceConnection();
    expect(s.connectHostError).toContain('FIPS requires'); expect(mock.fetch).not.toHaveBeenCalled();
    expect(s.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    expect(mock.bridge.mock.calls[0][0]).toContain(`${service}.fips`);
  });
});
