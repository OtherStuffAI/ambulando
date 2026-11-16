// Synthetic interoperability fixture; this well-known test key has no authority.
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
const secret = new Uint8Array(32).fill(1);
const npub = nip19.npubEncode(getPublicKey(secret));
const now = 1800000000;
const payload = { type: 'nstack-workspace', version: 3, service_npub: npub, workspace_id: '11111111-2222-3333-4444-555555555555', workspace_service_npub: npub, name: 'Shared fixture', transports: { https: { url: 'https://tower.example' }, fips: { peer_npub: npub, host: `${npub}.fips`, port: 4443 } }, policy: { preferred: 'fips', fallback: 'none' } };
const sign = (content, kind, tag) => finalizeEvent({ kind, created_at: now, tags: [['d', tag]], content: JSON.stringify(content) }, secret);
const event = sign(payload, 30383, 'nstack-workspace-connection-v3');
const envelope = 'nstack:workspace:v3:' + Buffer.from(JSON.stringify(event)).toString('base64url');
const nonce = 'ab'.repeat(32);
const request_url = `https://tower.example/api/v4/flightdeck-pg/workspaces/${payload.workspace_id}/connection-proof?nonce=${nonce}`;
const proof = sign({ nonce, service_npub: npub, workspace_id: payload.workspace_id, workspace_service_npub: npub, request_url, expires_at: now + 60 }, 30384, 'nstack-connection-challenge-v1');
const wrap = e => 'nstack:workspace:v3:' + Buffer.from(JSON.stringify(e)).toString('base64url');
const rejected_envelopes = [
  { ...payload, version: 4 }, { ...payload, workspace_id: 'bad' }, { ...payload, extra: true },
  { ...payload, transports: {} }, { ...payload, transports: { https: null } },
  { ...payload, transports: { https: { url: 'https://user:pass@tower.example' } } },
  { ...payload, transports: { https: { url: 'https://tower.example/' } } },
  { ...payload, transports: { fips: { ...payload.transports.fips, host: 'wrong.fips' } } },
  { ...payload, transports: { fips: { ...payload.transports.fips, port: 0 } } },
  { ...payload, policy: { preferred: 'fips', fallback: 'https' } },
  { ...payload, service_npub: nip19.npubEncode('02'.repeat(32)) },
].map(p => wrap(sign(p, 30383, 'nstack-workspace-connection-v3')));
const baseProof = JSON.parse(proof.content);
const rejected_proofs = [{ nonce: 'cd'.repeat(32) }, { request_url: request_url + 'x' }, { workspace_id: '11111111-2222-3333-4444-666666666666' }, { workspace_service_npub: 'wrong' }, { service_npub: 'wrong' }, { expires_at: now }, { expires_at: now + 61 }].map(p => sign({ ...baseProof, ...p }, 30384, 'nstack-connection-challenge-v1'));
console.log(JSON.stringify({ now, envelope, nonce, request_url, proof, rejected_envelopes, rejected_proofs }));
