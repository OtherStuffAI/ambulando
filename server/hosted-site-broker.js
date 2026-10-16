import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const PREFIX = '/api/internal/signing/hosted-site/';

async function readCredential(path) {
  if (!isAbsolute(path)) throw new Error('site_credential_path_invalid');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128) throw new Error('site_credential_file_unsafe');
    const credential = (await file.readFile('utf8')).trim();
    if (!/^wmhost_v1_[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('site_credential_invalid');
    return credential;
  } finally { await file.close(); }
}

/** Server-only opaque capability. The app never receives a Nostr private key. */
export function createHostedSiteBroker({ baseUrl, credentialFile, appId, siteNpub, target, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || !appId || !siteNpub || !credentialFile) throw new Error('site_broker_configuration_invalid');
  async function call(operation, input) {
    const credential = await readCredential(credentialFile);
    const response = await fetchImpl(new URL(`${PREFIX}${operation}`, base).href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ appId, ...input }),
    });
    const text = await response.text();
    if (text.length > 16384 || !response.ok) throw new Error('site_broker_unavailable');
    return JSON.parse(text);
  }
  return {
    async readiness() {
      const result = await call('readiness', { url: target, siteNpub });
      if (result.ready !== true || result.appId !== appId || result.siteNpub !== siteNpub || result.url !== target
        || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('site_broker_unavailable');
      // An intentionally unsigned, invalid-body probe cannot provision a workspace.
      // It proves the named route is loaded instead of treating broker custody as Tower readiness.
      const probe = await fetchImpl(target, { method: 'POST', body: '{}', redirect: 'error',
        signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' } });
      const text = await probe.text();
      if (probe.status !== 401 || text.length > 4096 || !probe.headers.get('content-type')?.includes('application/json')) throw new Error('hosted_tower_route_unavailable');
      const denied = JSON.parse(text);
      if (denied.code !== 'nip98_auth_required' || denied.error !== 'nip98_auth_required') throw new Error('hosted_tower_route_unavailable');
      return true;
    },
    async sign(url, bodyHash, userEventId, _now, context) {
      if (url !== target || !context?.payload || context?.userEvent?.id !== userEventId) throw new Error('site_broker_context_invalid');
      const result = await call('attest', { url, method: 'POST', bodyHash, userEventId, payload: context.payload, userEvent: context.userEvent });
      return result.event;
    },
  };
}
