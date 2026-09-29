import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, generateSecretKey, nip19, verifyEvent } from 'nostr-tools';
import { createHostedSignupHandler, createSiteSigner, SITE_NPUB, TOWER_PATH } from '../server/hosted-signup.js';

const target = `https://tower.example${TOWER_PATH}`;
const origin = 'https://flightdeck.example';
const body = Buffer.from(JSON.stringify({ workspace_name: 'Example', idempotency_key: randomUUID(), terms_version: 'hosted-free-v1' }));
const userKey = generateSecretKey();
const siteKey = generateSecretKey();
const siteNpub = nip19.npubEncode(finalizeEvent({ kind: 1, created_at: 1, tags: [], content: '' }, siteKey).pubkey);
const now = 1780000000;

function proof(bytes = body, url = target, time = now, key = userKey) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const event = finalizeEvent({ kind: 27235, created_at: time, content: randomUUID(), tags: [['u', url], ['method', 'POST'], ['payload', hash]] }, key);
  return { event, header: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` };
}

function request(header, bytes = body, requestOrigin = origin) {
  return new Request(`${origin}/api/hosted/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin, ...(header ? { authorization: header } : {}) }, body: bytes });
}

function fixture() {
  const calls = [];
  const sign = (url, hash, id, time) => finalizeEvent({ kind: 27235, created_at: time, content: randomUUID(), tags: [['u', url], ['method', 'POST'], ['payload', hash], ['user_event_id', id]] }, siteKey);
  const handler = createHostedSignupHandler({ towerUrl: 'https://tower.example/', siteOrigin: origin, sign, siteNpub, now: () => now, fetchImpl: async (...args) => { calls.push(args); return Response.json({ workspace_id: 'ok' }, { status: 201 }); } });
  return { calls, handler };
}

describe('hosted signup attestation', () => {
  it('forwards exact bytes and the bound, fresh proofs', async () => {
    const { handler, calls } = fixture();
    const user = proof();
    const result = await handler(request(user.header));
    expect(result.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(target);
    expect(Buffer.from(calls[0][1].body).equals(body)).toBe(true);
    expect(calls[0][1].headers.authorization).toBe(user.header);
    const site = JSON.parse(Buffer.from(calls[0][1].headers['x-flightdeck-site-attestation'], 'base64').toString());
    expect(verifyEvent(site)).toBe(true);
    expect(site.tags).toContainEqual(['user_event_id', user.event.id]);
    expect(verifyEvent(user.event)).toBe(true);
  });

  it('rejects missing, altered, substituted, and expired user proofs', async () => {
    const { handler, calls } = fixture();
    expect((await handler(request(null))).status).toBe(401);
    expect((await handler(request(proof(Buffer.from('different')).header))).status).toBe(401);
    expect((await handler(request(proof(body, 'https://elsewhere.example/').header))).status).toBe(401);
    expect((await handler(request(proof(body, target, now - 61).header))).status).toBe(401);
    const forged = proof();
    forged.event.pubkey = '0'.repeat(64);
    expect((await handler(request(`Nostr ${Buffer.from(JSON.stringify(forged.event)).toString('base64')}`))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects replay, origin mismatch, bad schema, and arbitrary targets', async () => {
    const { handler } = fixture();
    const user = proof();
    expect((await handler(request(user.header))).status).toBe(201);
    expect((await handler(request(user.header))).status).toBe(409);
    expect((await handler(request(proof().header, body, 'https://evil.example'))).status).toBe(403);
    expect((await handler(request(proof().header, Buffer.from('{"extra":1}')))).status).toBe(400);
    expect(() => createHostedSignupHandler({ towerUrl: 'http://169.254.169.254/', siteOrigin: origin, sign: () => null })).toThrow();
    expect(() => createHostedSignupHandler({ towerUrl: 'https://tower.example/other', siteOrigin: origin, sign: () => null })).toThrow();
  });

  it('accepts the public host when TLS terminates before the Bun server', async () => {
    const { handler, calls } = fixture();
    const user = proof();
    const proxied = new Request('http://flightdeck.example/api/hosted/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, authorization: user.header },
      body,
    });
    expect((await handler(proxied)).status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it('fails closed for absent or mismatched site identity', () => {
    expect(() => createSiteSigner('', SITE_NPUB)).toThrow();
    expect(() => createSiteSigner(nip19.nsecEncode(siteKey), SITE_NPUB)).toThrow();
    const sign = createSiteSigner(nip19.nsecEncode(siteKey), siteNpub);
    const event = sign(target, 'a'.repeat(64), 'b'.repeat(64), now);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(nip19.decode(siteNpub).data);
  });
});
