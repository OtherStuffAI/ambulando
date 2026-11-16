import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { parseWorkspaceConnection, verifyConnectionChallenge, connectionOrigin, challengeWorkspaceConnection } from '../src/nstack-workspace-connection.js';
const secret = generateSecretKey();
const service = nip19.npubEncode(getPublicKey(secret));
const now = Math.floor(Date.now() / 1000);
const payload = { type: 'nstack-workspace', version: 3, service_npub: service, workspace_id: '11111111-2222-3333-4444-555555555555', workspace_service_npub: service,
  transports: { https: { url: 'https://tower.example' }, fips: { peer_npub: service, host: `${service}.fips`, port: 4443 } }, policy: { preferred: 'fips', fallback: 'none' } };
const sign = (value, kind = 30383) => finalizeEvent({ kind, created_at: now, tags: [['d', kind === 30383 ? 'nstack-workspace-connection-v3' : 'nstack-connection-challenge-v1']], content: typeof value === 'string' ? value : JSON.stringify(value) }, secret);
const encode = event => 'nstack:workspace:v3:' + Buffer.from(typeof event === 'string' ? event : JSON.stringify(event)).toString('base64url');
const nonce = 'ab'.repeat(32);
const url = `https://tower.example/api/v4/flightdeck-pg/workspaces/${payload.workspace_id}/connection-proof?nonce=${nonce}`;
const proofContent = { nonce, service_npub: service, workspace_id: payload.workspace_id, workspace_service_npub: service, request_url: url, expires_at: now + 60 };
describe('shared workspace v3', () => {
  it('accepts Tower signed bytes and resolves FIPS without discovery', () => {
    expect(parseWorkspaceConnection(encode(sign(payload)), now)).toEqual(payload);
    expect(connectionOrigin(payload)).toBe(`http://${service}.fips:4443`);
    expect(connectionOrigin(payload, 'https')).toBe('https://tower.example');
  });
  it.each([
    { ...payload, version: 4 }, { ...payload, extra: true }, { ...payload, workspace_id: 'bad' },
    { ...payload, transports: {} }, { ...payload, transports: { https: null } },
    { ...payload, transports: { https: { url: 'https://user:pass@tower.example' } } },
    { ...payload, transports: { https: { url: 'https://tower.example/' } } },
    { ...payload, transports: { fips: { ...payload.transports.fips, host: 'other.fips' } } },
    { ...payload, policy: { preferred: 'fips', fallback: 'https' } },
    { ...payload, service_npub: nip19.npubEncode(getPublicKey(generateSecretKey())) },
  ])('rejects invalid signed payload %#', value => expect(() => parseWorkspaceConnection(encode(sign(value)), now)).toThrow());
  it('rejects bad signature, unknown event fields, duplicate/noncanonical JSON and oversized copy', () => {
    const event = sign(payload);
    expect(() => parseWorkspaceConnection(encode({ ...event, sig: '00'.repeat(64) }), now)).toThrow();
    expect(() => parseWorkspaceConnection(encode({ ...event, extra: true }), now)).toThrow();
    expect(() => parseWorkspaceConnection(encode(JSON.stringify(event).replace('{', '{ ')), now)).toThrow();
    expect(() => parseWorkspaceConnection(encode(sign(JSON.stringify(payload).replace('{', '{"version":3,'))), now)).toThrow();
    expect(() => parseWorkspaceConnection(encode(event) + '=', now)).toThrow();
    expect(() => parseWorkspaceConnection('nstack:workspace:v2:abc', now)).toThrow();
    expect(() => parseWorkspaceConnection('nstack:workspace:v3:' + 'a'.repeat(8192), now)).toThrow();
  });
  it('verifies nonce, exact URL, service, workspace authority, UUID and expiry', () => {
    expect(verifyConnectionChallenge(sign(proofContent, 30384), payload, nonce, url, now)).toEqual(proofContent);
    for (const patch of [{ nonce: 'cd'.repeat(32) }, { request_url: url + 'x' }, { workspace_id: '11111111-2222-3333-4444-666666666666' }, { workspace_service_npub: 'wrong' }, { service_npub: 'wrong' }, { expires_at: now }, { expires_at: now + 61 }]) {
      expect(() => verifyConnectionChallenge(sign({ ...proofContent, ...patch }, 30384), payload, nonce, url, now)).toThrow();
    }
  });
  it('makes one user-authenticated GET, never falls back or creates on denial', async () => {
    const calls = [];
    const auth = async (...args) => { calls.push(args); return 'Nostr user'; };
    const fetch = async (...args) => { calls.push(args); return { ok: false, status: 403 }; };
    await expect(challengeWorkspaceConnection(payload, connectionOrigin(payload), { auth, fetch })).rejects.toThrow('403');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe('GET');
    expect(calls[0][3]).toEqual({ useWorkspaceKey: false });
    expect(calls[1][1].redirect).toBe('error');
    expect(calls[1][0]).toContain(`${service}.fips:4443/api/`);
  });
});
