import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedSiteBroker } from '../server/hosted-site-broker.js';

let dir;
let credentialFile;
const credential = `wmhost_v1_${'a'.repeat(43)}`;
const target = 'https://hosted.example/api/v4/flightdeck-pg/hosted/workspaces';
const siteNpub = 'npub1synthetic';
const appId = 'app-one';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'site-broker-test-'));
  credentialFile = join(dir, 'credential');
  writeFileSync(credentialFile, credential, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function broker(fetchImpl, overrides = {}) {
  return createHostedSiteBroker({ baseUrl: 'http://127.0.0.1:3600/', credentialFile, appId, siteNpub, target, fetchImpl, ...overrides });
}
function ready() { return { ready: true, appId, siteNpub, url: target, expiresAt: Math.floor(Date.now() / 1000) + 60 }; }
describe('server-only hosted-site broker', () => {
  it('checks real broker identity and named Tower route without a signup proof', async () => {
    const calls = [];
    const client = broker(async (url, options) => {
      calls.push({ url, options });
      return url === target ? Response.json({ error: 'nip98_auth_required', code: 'nip98_auth_required' }, { status: 401 }) : Response.json(ready());
    });
    expect(await client.readiness()).toBe(true);
    expect(calls[0].options.headers.authorization).toBe(`Bearer ${credential}`);
    expect(JSON.parse(calls[0].options.body)).toEqual({ appId, url: target, siteNpub });
    expect(calls[1].options.headers.authorization).toBeUndefined();
    expect(calls[1].options.body).toBe('{}');
    expect(calls[1].url).toBe(target);
  });
  it.each(['appId', 'siteNpub', 'url', 'expiresAt', 'ready'])('fails closed for mismatched readiness %s', async field => {
    const client = broker(async () => Response.json({ ...ready(), [field]: field === 'ready' ? false : field === 'expiresAt' ? 1 : 'different' }));
    await expect(client.readiness()).rejects.toThrow('site_broker_unavailable');
  });
  it.each([404, 200, 500])('fails closed when Tower route probe returns %s', async status => {
    const client = broker(async url => url === target ? new Response('not the supported route', { status }) : Response.json(ready()));
    await expect(client.readiness()).rejects.toThrow('hosted_tower_route_unavailable');
  });
  it('passes exact payload and verified user event without generic signing fields', async () => {
    let seen;
    const client = broker(async (url, options) => { seen = { url, options }; return Response.json({ event: { id: 'attestation' } }); });
    const userEvent = { id: 'user-id' };
    expect(await client.sign(target, 'hash', 'user-id', 123, { payload: 'exact bytes', userEvent, appId: 'wrong', method: 'GET' })).toEqual({ id: 'attestation' });
    expect(JSON.parse(seen.options.body)).toEqual({ appId, url: target, method: 'POST', bodyHash: 'hash', userEventId: 'user-id', payload: 'exact bytes', userEvent });
    await expect(client.sign('https://evil.example', 'hash', 'user-id', 123, { payload: 'exact bytes', userEvent })).rejects.toThrow('site_broker_context_invalid');
  });
  it('rejects unsafe/missing credential files and never uses raw-key configuration', async () => {
    const client = broker(async () => Response.json(ready()));
    chmodSync(credentialFile, 0o644);
    await expect(client.readiness()).rejects.toThrow('site_credential_file_unsafe');
    chmodSync(credentialFile, 0o600);
    const link = join(dir, 'symlink'); symlinkSync(credentialFile, link);
    await expect(broker(async () => Response.json(ready()), { credentialFile: link }).readiness()).rejects.toThrow();
    writeFileSync(credentialFile, 'nsec1not-a-broker-credential');
    await expect(client.readiness()).rejects.toThrow('site_credential_invalid');
  });
  it.each(['https://remote.example/', 'http://localhost/', 'http://127.0.0.1/path', 'http://user:password@127.0.0.1/'])('rejects unsafe broker target %s', baseUrl => {
    expect(() => broker(fetch, { baseUrl })).toThrow('site_broker_configuration_invalid');
  });
  it('sanitizes broker failures and bounds replies', async () => {
    await expect(broker(async () => Response.json({ error: credential }, { status: 403 })).readiness()).rejects.toThrow('site_broker_unavailable');
    await expect(broker(async () => new Response('x'.repeat(16385))).readiness()).rejects.toThrow('site_broker_unavailable');
  });
});
