import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { brokerSessionContext, towerClient, TowerError } from '../scripts/html-artifact/tower.mjs';
import { outputGoalMetadata, publisherThreadRoute, resolvePublisherGoal } from '../scripts/html-artifact/goal-context.mjs';
import { boardClient } from '../scripts/excalidraw-board.mjs';
import { createEmptyBoardScene } from '../src/canvas/board-scene.js';

const workspace = randomUUID(), channel = randomUUID(), thread = randomUUID(), goal = randomUUID(), version = randomUUID();
const baseUrl = 'https://tower.example';
const ref = { version: 1, goal_file_id: goal, future_reference_field: { content_snapshot: 'Never copy this' } };
const canonicalRef = { version: 1, goal_file_id: goal };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const goalBody = Buffer.from(JSON.stringify({ schema: 'ambulando.goal', schema_version: 1, name: 'Purpose', description: 'Useful outputs', status: 'active', checkpoints: [], links: [], pinned_refs: [], future_goal_field: 'kept' }));
const context = backend => ({ ok: true, workspace: { workspaceId: workspace, backendBaseUrl: backend }, chat: { channelId: channel, threadId: thread } });
const route = { workspaceId: workspace, baseUrl, readContext: async () => context(baseUrl) };

function sourceClient({ status, contentType, body = goalBody, responseWorkspace = workspace, metadata = { ambulando_goal: ref }, bytes = body } = {}) {
  const request = vi.fn(async () => ({ thread: { id: thread, workspace_id: responseWorkspace, channel_id: channel, metadata, record_state: 'active' } }));
  return { request, getFile: vi.fn(async () => {
    if (status) throw new TowerError(status, 'denied', 'Unavailable');
    return { file: { id: goal, workspace_id: workspace, current_version_id: version, record_state: 'active', content_type: contentType || 'application/vnd.ambulando.goal+json', metadata: { goal: { schema_version: 1 } }, object: { storage_object: { size_bytes: body.length, sha256_hex: sha(body) } } } };
  }), readVersionBytes: vi.fn(async () => bytes) };
}

describe('authoritative publisher goal context', () => {
  it('uses the supported broker session-context CLI and skips it only outside a session', async () => {
    const runImpl = vi.fn(async () => JSON.stringify(context(baseUrl)));
    expect(await brokerSessionContext({ cli: '/verified/clis/wingman.ts', env: { SESSION_ID: 'current' }, runImpl })()).toEqual(context(baseUrl));
    expect(runImpl.mock.calls[0][1]).toEqual(['/verified/clis/wingman.ts', 'flightdeck', 'context', '--json']);
    expect(await brokerSessionContext({ env: {}, runImpl })()).toBeNull();
    expect(runImpl).toHaveBeenCalledTimes(1);
    expect(await publisherThreadRoute({ ...route, readContext: async () => ({ ok: true, chat: { threadId: null } }) })).toBeNull();
    await expect(publisherThreadRoute({ ...route, readContext: async () => { throw Error('helper unavailable'); } })).rejects.toThrow('helper unavailable');
  });

  it('resolves exact Goal kind/schema/hash and returns only its native reference, retaining overall metadata without transferring unknown reference snapshots', async () => {
    const client = sourceClient();
    expect(await resolvePublisherGoal(client, route)).toEqual(canonicalRef);
    expect(client.readVersionBytes).toHaveBeenCalledWith(goal, version, { maxBytes: 256 * 1024 });
    expect(client.request.mock.calls[0][1]).toContain(`/workspaces/${workspace}/threads/${thread}`);
    expect(outputGoalMetadata({ artefact: { editor: 'original' }, future: { preserved: true } }, ref)).toEqual({ artefact: { editor: 'original' }, future: { preserved: true }, ambulando_goal: canonicalRef });
    const original = { artefact: { unknown: 'keep' }, ambulando_goal: ref };
    const snapshot = structuredClone(original);
    expect(outputGoalMetadata(original, ref)).toEqual({ artefact: original.artefact, ambulando_goal: canonicalRef });
    expect(original).toEqual(snapshot);
    expect(ref.future_reference_field.content_snapshot).toBe('Never copy this');
  });

  it('keeps ACL-denied primary identity only; missing, invalid kind/content and digest failures refuse inheritance', async () => {
    expect(await resolvePublisherGoal(sourceClient({ status: 403 }), route)).toEqual(canonicalRef);
    await expect(resolvePublisherGoal(sourceClient({ status: 404 }), route)).rejects.toMatchObject({ status: 404 });
    await expect(resolvePublisherGoal(sourceClient({ contentType: 'text/html' }), route)).rejects.toThrow('supported accessible Goal');
    await expect(resolvePublisherGoal(sourceClient({ body: Buffer.from('{"schema":"arbitrary"}') }), route)).rejects.toThrow('unsupported or invalid');
    await expect(resolvePublisherGoal(sourceClient({ bytes: Buffer.from('corrupt') }), route)).rejects.toThrow('integrity');
    const deniedBody = sourceClient(); deniedBody.readVersionBytes.mockRejectedValue(new TowerError(403, 'denied', 'Unavailable'));
    expect(await resolvePublisherGoal(deniedBody, route)).toEqual(canonicalRef);
  });

  it('refuses mismatched workspace/backend/channel or malformed primary instead of guessing from mentions', async () => {
    await expect(publisherThreadRoute({ ...route, workspaceId: randomUUID() })).rejects.toThrow('does not match');
    await expect(publisherThreadRoute({ ...route, baseUrl: 'https://other.example' })).rejects.toThrow('does not match');
    await expect(resolvePublisherGoal(sourceClient({ responseWorkspace: randomUUID() }), route)).rejects.toThrow('identity');
    await expect(resolvePublisherGoal(sourceClient({ metadata: { ambulando_goal: { version: 4, goal_file_id: goal } } }), route)).rejects.toThrow('malformed');
    expect(await resolvePublisherGoal(sourceClient({ metadata: { explicit_goal_mentions: [goal] } }), route)).toBeNull();
    await expect(publisherThreadRoute({ ...route, chatThreadId: 'not-a-uuid' })).rejects.toThrow('--chat-thread');
    expect(() => outputGoalMetadata({ ambulando_goal: { version: 1, goal_file_id: randomUUID() } }, ref)).toThrow('disagrees');
  });

  it('explicit chat routing bypasses unrelated session selection but still reads the authoritative record', async () => {
    const readContext = vi.fn(() => { throw Error('unrelated context'); });
    expect(await resolvePublisherGoal(sourceClient(), { ...route, chatThreadId: thread, readContext })).toEqual(canonicalRef);
    expect(readContext).not.toHaveBeenCalled();
  });
});

let directory, server, origin, signer;
const files = new Map(), objects = new Map(), calls = [];
let omitNextAssociation = false;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'goal-publisher-test-'));
  const root = `/api/v4/flightdeck-pg/workspaces/${workspace}`;
  server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    const pathname = new URL(req.url, 'http://fixture').pathname;
    calls.push({ method: req.method, pathname, body });
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!String(req.headers.authorization).startsWith('Nostr fixture')) return send(401, { error: 'unsigned' });
    if (pathname === `${root}/threads/${thread}`) return send(200, { thread: { id: thread, workspace_id: workspace, channel_id: channel, metadata: { ambulando_goal: ref }, record_state: 'active' } });
    if (pathname === `${root}/files/${goal}`) return send(200, { file: { id: goal, workspace_id: workspace, current_version_id: version, content_type: 'application/vnd.ambulando.goal+json', metadata: { goal: { schema_version: 1 } }, object: { storage_object: { size_bytes: goalBody.length, sha256_hex: sha(goalBody) } } } });
    if (pathname === `${root}/files/${goal}/versions/${version}/object`) { res.writeHead(200); return res.end(goalBody); }
    if (pathname === `${root}/storage/prepare`) { const id = randomUUID(); objects.set(id, {}); return send(201, { object_id: id, is_public: false }); }
    let match;
    if ((match = pathname.match(/^\/api\/v4\/storage\/([^/]+)$/))) { objects.get(match[1]).bytes = Buffer.from(body.base64_data, 'base64'); return send(200, {}); }
    if (pathname.endsWith('/complete')) return send(200, {});
    if (pathname === `${root}/channels/${channel}/files`) {
      const file = { id: randomUUID(), workspace_id: workspace, channel_id: channel, metadata: body.metadata, storage_object_id: body.storage_object_id, current_version_id: randomUUID() };
      files.set(file.id, file); return send(201, { file });
    }
    if ((match = pathname.match(new RegExp(`^${root}/files/([^/]+)/versions$`)))) {
      const file = files.get(match[1]);
      return send(200, { current_version_id: file.current_version_id, versions: [{ id: file.current_version_id, version_number: 1 }] });
    }
    if ((match = pathname.match(new RegExp(`^${root}/files/([^/]+)$`))) && files.has(match[1])) {
      const file = files.get(match[1]);
      if (omitNextAssociation) { omitNextAssociation = false; return send(200, { file: { ...file, metadata: {} } }); }
      return send(200, { file });
    }
    return send(404, { error: `Unhandled ${pathname}` });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  signer = path.join(directory, 'broker-fixture.mjs');
  await writeFile(signer, `const a=process.argv.slice(2); console.log(JSON.stringify(a[0]==='flightdeck'?${JSON.stringify(context(origin))}:{authorization:'Nostr fixture',signedBy:'npub1fixture'}));`);
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });

function runHtml(folder) {
  return new Promise(resolve => {
    const child = spawn(process.env.BUN_BIN || 'bun', [path.resolve('scripts/publish-html-artifact.mjs'), folder, '--tower', origin, '--workspace', workspace, '--channel', channel, '--signer-cli', signer, '--context-cli', signer, '--json'], { env: { ...process.env, SESSION_ID: 'fixture-session' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('native publisher paths', () => {
  it('automatically associates new HTML and its private image Files through the broker route and verifies readback', async () => {
    const folder = path.join(directory, 'html'); await import('node:fs/promises').then(fs => fs.mkdir(folder));
    await writeFile(path.join(folder, 'index.html'), '<html><head><title>Useful result</title></head><body><img src="picture.png"></body></html>');
    await writeFile(path.join(folder, 'picture.png'), Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]));
    const result = await runHtml(folder);
    expect(result.stderr, result.stdout).toBe(''); expect(result.code).toBe(0);
    const published = JSON.parse(result.stdout), html = files.get(published.file_id);
    expect(html.metadata).toMatchObject({ html_artifact: true, ambulando_goal: canonicalRef });
    expect(files.get(published.assets[0].file_id).metadata).toMatchObject({ html_artifact_asset: true, ambulando_goal: canonicalRef });
    expect(calls.some(call => call.method === 'GET' && call.pathname.endsWith(`/files/${html.id}`))).toBe(true);
    expect(objects.get(html.storage_object_id).bytes.toString()).not.toContain('ambulando_goal');
  });

  it('reports a post-create association mismatch with the original File identity and never blindly replays', async () => {
    const sign = async () => ({ authorization: 'Nostr fixture', signedBy: 'npub1fixture' });
    const client = towerClient({ baseUrl: origin, workspaceId: workspace, sign, readContext: async () => context(origin) });
    const before = files.size; omitNextAssociation = true;
    const failure = await client.createFile(channel, { storage_object_id: randomUUID(), metadata: { future: 'keep' } }).catch(error => error);
    const created = [...files.values()].at(-1);
    expect(failure.message).toContain(`File ${created.id} was created`);
    expect(failure.message).toContain('inspect it before retrying');
    expect(files.size).toBe(before + 1);
  });

  it('whiteboard creation inherits the same primary while revision writes never replace metadata', async () => {
    const sign = async () => ({ authorization: 'Nostr fixture', signedBy: 'npub1fixture' });
    sign.sessionContext = async () => context(origin);
    const client = boardClient({ baseUrl: origin, workspaceId: workspace, sign });
    const file = await client.create(channel, 'Vision board', createEmptyBoardScene());
    expect(files.get(file.id).metadata).toMatchObject({ kind: 'excalidraw_board', title: 'Vision board', ambulando_goal: canonicalRef });
    const requests = [];
    const revision = towerClient({ baseUrl, workspaceId: workspace, sign, readContext: () => { throw Error('Revision must not derive another primary'); }, fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ version: { id: version } })); } });
    await revision.createVersion(file.id, { base_version_id: file.current_version_id, storage_object_id: randomUUID() });
    expect(requests[0]).not.toHaveProperty('metadata');
  });
});
