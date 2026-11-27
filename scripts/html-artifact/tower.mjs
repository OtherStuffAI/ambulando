// Signed Tower client for HTML artefact publication. Signing goes through the
// Autopilot capability broker CLI (`wingman-capability.ts nip98`), so this
// script never sees a private key or the capability bearer token.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outputGoalMetadata, primaryGoalReference, resolvePublisherGoal } from './goal-context.mjs';

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

/** Supported session context helper; it prints routing metadata, never keys or bearer tokens. */
export function brokerSessionContext({ cli, bun = process.env.BUN_BIN || 'bun', env = process.env, runImpl = run } = {}) {
  return async () => {
    if (!env.SESSION_ID) return null;
    const contextCli = cli || env.WINGMAN_CONTEXT_CLI || path.join(env.AUTOPILOT_REPO || path.join(os.homedir(), 'code', 'wm', 'autopilot'), 'clis', 'wingman.ts');
    const context = JSON.parse(await runImpl(bun, [contextCli, 'flightdeck', 'context', '--json']));
    if (!context || context.ok === false) throw new Error('Authoritative session context is unavailable');
    return context;
  };
}

/** NIP-98 signer backed by the capability broker CLI. */
export function brokerSigner({ cli = defaultSignerCli(), contextCli, bun = process.env.BUN_BIN || 'bun' } = {}) {
  const sign = async (url, method, bodyBytes) => {
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
  sign.sessionContext = brokerSessionContext({ cli: contextCli, bun });
  return sign;
}

export class TowerError extends Error {
  constructor(status, code, message, body) {
    super(`${status} ${code || ''} ${message || ''}`.trim());
    this.status = status; this.code = code; this.body = body;
  }
}

export function towerClient({ baseUrl, workspaceId, sign, fetchImpl = fetch, readContext = sign?.sessionContext, chatThreadId }) {
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
  let goalPromise;
  const client = {
    request,
    async readVersionBytes(fileId, versionId, { maxBytes } = {}) {
      const url = `${origin}${ws}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/object`;
      const { authorization } = await sign(url, 'GET', null);
      const response = await fetchImpl(url, { headers: { Authorization: authorization } });
      if (!response.ok) throw new TowerError(response.status, 'version_unavailable', 'Exact source version unavailable');
      if (!maxBytes) return Buffer.from(await response.arrayBuffer());
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Exact source version has no body');
      const chunks = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > maxBytes) throw new Error('Exact source version exceeds size limit');
          chunks.push(Buffer.from(next.value));
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    },
    async uploadObject({ bytes, contentType, fileName }) {
      const prepared = await request('POST', `${ws}/storage/prepare`, { file_name: fileName, content_type: contentType, size_bytes: bytes.byteLength });
      if (prepared.is_public !== false) throw new Error('Private storage must be confirmed before uploading source.');
      await request('PUT', `/api/v4/storage/${encodeURIComponent(prepared.object_id)}`, { base64_data: Buffer.from(bytes).toString('base64') });
      const { createHash } = await import('node:crypto');
      await request('POST', `/api/v4/storage/${encodeURIComponent(prepared.object_id)}/complete`, { size_bytes: bytes.byteLength, sha256_hex: createHash('sha256').update(bytes).digest('hex') });
      return prepared.object_id;
    },
    getFile: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}`),
    listVersions: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}/versions`),
    readCurrentObject: fileId => request('GET', `${ws}/files/${encodeURIComponent(fileId)}/object`),
    async createFile(channelId, body) {
      goalPromise ||= resolvePublisherGoal(client, { workspaceId, baseUrl: origin, readContext, chatThreadId });
      const reference = await goalPromise;
      const metadata = outputGoalMetadata(body.metadata, reference);
      const created = await request('POST', `${ws}/channels/${encodeURIComponent(channelId)}/files`, { ...body, metadata });
      if (reference) {
        // Creation and its durable association are verified separately; never replay an uncertain create blindly.
        try {
          const saved = (await client.getFile(created.file?.id))?.file;
          if (!saved || saved.id !== created.file?.id || saved.workspace_id !== workspaceId || saved.channel_id !== channelId || primaryGoalReference(saved.metadata?.ambulando_goal).goal_file_id !== reference.goal_file_id) throw new Error('Association readback mismatch');
        } catch (error) {
          throw new Error(`File ${created.file?.id || '(unknown)'} was created but its goal association could not be confirmed; inspect it before retrying`, { cause: error });
        }
      }
      return created;
    },
    createVersion: (fileId, body) => request('POST', `${ws}/files/${encodeURIComponent(fileId)}/versions`, body),
    addNaplet: (canvasId, body) => request('POST', `${ws}/canvases/${encodeURIComponent(canvasId)}/naplets`, body),
  };
  return client;
}
