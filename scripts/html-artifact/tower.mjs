// Signed Tower client for HTML artefact publication. Signing goes through the
// Autopilot capability broker CLI (`wingman-capability.ts nip98`), so this
// script never sees a private key or the capability bearer token.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultSignerCli(env = process.env) {
  if (env.WINGMAN_CAPABILITY_CLI) return env.WINGMAN_CAPABILITY_CLI;
  const autopilot = env.AUTOPILOT_REPO || path.join(os.homedir(), 'code', 'wm', 'autopilot');
  return path.join(autopilot, 'clis', 'wingman-capability.ts');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`signer exited ${code}: ${stderr.trim().slice(0, 400)}`)));
  });
}

/** NIP-98 signer backed by the capability broker CLI. */
export function brokerSigner({ cli = defaultSignerCli(), bun = process.env.BUN_BIN || 'bun' } = {}) {
  return async (url, method, bodyBytes) => {
    const args = [cli, 'nip98', '--url', url, '--method', method];
    let dir = null;
    try {
      if (bodyBytes) {
        dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-sign-'));
        const file = path.join(dir, 'body');
        await writeFile(file, bodyBytes);
        args.push('--body-file', file);
      }
      const output = JSON.parse(await run(bun, args));
      if (!output?.authorization) throw new Error('signer returned no authorization');
      return { authorization: output.authorization, signedBy: output.signedBy || '' };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

export class TowerError extends Error {
  constructor(status, code, message, body) {
    super(`${status} ${code || ''} ${message || ''}`.trim());
    this.status = status; this.code = code; this.body = body;
  }
}

export function towerClient({ baseUrl, workspaceId, sign, fetchImpl = fetch }) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) throw new Error('--tower must be an http(s) origin');
  const ws = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(method, pathname, body) {
    const url = `${origin}${pathname}`;
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const { authorization } = await sign(url, method, bytes);
    const response = await fetchImpl(url, { method, headers: { Authorization: authorization, Accept: 'application/json', ...(bytes ? { 'Content-Type': 'application/json' } : {}) }, body: bytes ?? undefined });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error */ }
    if (!response.ok) throw new TowerError(response.status, json?.error?.code || json?.code || json?.error, json?.error?.message || json?.message || text.slice(0, 200), json);
    return json;
  }
  return {
    request,
    async uploadObject({ bytes, contentType, fileName }) {
      const prepared = await request('POST', `${ws}/storage/prepare`, { file_name: fileName, content_type: contentType, size_bytes: bytes.byteLength });
      await request('PUT', `/api/v4/storage/${encodeURIComponent(prepared.object_id)}`, { base64_data: Buffer.from(bytes).toString('base64') });
      const { createHash } = await import('node:crypto');
      await request('POST', `/api/v4/storage/${encodeURIComponent(prepared.object_id)}/complete`, { size_bytes: bytes.byteLength, sha256_hex: createHash('sha256').update(bytes).digest('hex') });
      if (prepared.is_public) throw new Error('Tower prepared a public object; refusing to continue');
      return prepared.object_id;
    },
    getFile: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}`),
    listVersions: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}/versions`),
    readCurrentObject: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}/object`),
    createFile: (channelId, body) => request('POST', `${ws}/channels/${encodeURIComponent(channelId)}/files`, body),
    createVersion: (fileId, body) => request('POST', `${ws}/files/${encodeURIComponent(fileId)}/versions`, body),
    addNaplet: (canvasId, body) => request('POST', `${ws}/canvases/${encodeURIComponent(canvasId)}/naplets`, body),
  };
}
