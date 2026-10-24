import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommentOperation } from '../src/canvas/board-comments.js';
import { boardClient, EXIT_STALE, run } from '../scripts/excalidraw-board.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const CANVAS = '33333333-3333-4333-8333-333333333333';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rect = (id, version) => ({ id, type: 'rectangle', x: 0, y: 0, width: 5, height: 5, version, versionNonce: version, isDeleted: false });

/** Minimal signed Tower: every request must carry the signer's Authorization. */
function fakeTower() {
  const objects = new Map(), files = new Map(), requests = [], naplets = [];
  let counter = 0;
  const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const version = (file, objectId, author, body) => {
    const row = { id: id(), version_number: file.versions.length + 1, created_by_actor_npub: author, summary: body.summary || null, sha256_hex: sha(objects.get(objectId)), size_bytes: objects.get(objectId).byteLength, storage_object_id: objectId, created_at: new Date().toISOString() };
    file.versions.push(row); file.current_version_id = row.id;
    return row;
  };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method || 'GET';
    requests.push({ method, pathname, authorization: init.headers?.Authorization });
    if (!String(init.headers?.Authorization || '').startsWith('Nostr ')) return json(401, { error: 'unsigned' });
    const body = init.body ? JSON.parse(Buffer.from(init.body).toString()) : null;
    let match;
    if (pathname.endsWith('/storage/prepare')) return json(200, { object_id: id(), is_public: false });
    if ((match = pathname.match(/^\/api\/v4\/storage\/([^/]+)$/)) && method === 'PUT') { objects.set(match[1], Buffer.from(body.base64_data, 'base64')); return json(200, {}); }
    if ((match = pathname.match(/^\/api\/v4\/storage\/([^/]+)\/complete$/))) { expect(body.sha256_hex).toBe(sha(objects.get(match[1]))); return json(200, {}); }
    if ((match = pathname.match(/\/channels\/([^/]+)\/files$/))) {
      const file = { id: id(), channel_id: match[1], versions: [] };
      files.set(file.id, file); version(file, body.storage_object_id, 'npub1agent', body);
      return json(201, { file: { id: file.id, current_version_id: file.current_version_id } });
    }
    if ((match = pathname.match(/\/files\/([^/]+)\/versions$/))) {
      const file = files.get(match[1]);
      if (!file) return json(404, { error: 'missing', code: 'file_not_found' });
      if (method === 'GET') return json(200, { file_id: file.id, current_version_id: file.current_version_id, versions: [...file.versions].reverse() });
      if (body.base_version_id !== file.current_version_id) return json(409, { error: 'File base_version_id is stale', code: 'stale_base_version', current_version: file.versions.at(-1) });
      return json(201, { version: version(file, body.storage_object_id, 'npub1agent', body) });
    }
    if ((match = pathname.match(/\/files\/([^/]+)\/versions\/([^/]+)\/object$/))) {
      const row = files.get(match[1])?.versions.find(entry => entry.id === match[2]);
      return row ? new Response(objects.get(row.storage_object_id)) : json(404, { error: 'missing' });
    }
    if ((match = pathname.match(/\/canvases\/([^/]+)\/naplets$/))) { naplets.push(body); return json(201, { naplet: { id: id(), ...body } }); }
    return json(404, { error: `unhandled ${method} ${pathname}` });
  };
  const sign = async (url, method) => ({ authorization: `Nostr signed:${method}:${new URL(url).pathname}`, signedBy: 'npub1agent' });
  return { files, requests, naplets, client: boardClient({ baseUrl: 'https://tower.example', workspaceId: WS, sign, fetchImpl }) };
}

async function cli(tower, args) {
  const out = [], err = [];
  const code = await run([...args, '--workspace', WS, '--tower', 'https://tower.example'], { out: line => out.push(line), err: line => err.push(line), clientFactory: () => tower.client });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('excalidraw-board agent helper', () => {
  it('reads drawing context and appends replies as broker identity against the read version', async () => {
    const tower = fakeTower();
    const scene = applyCommentOperation({ elements: [rect('box', 1)], files: {} }, { type: 'create', id: 'thread', anchor: { x: 0, y: 0 }, body: 'Question' }, 'npub1human');
    const file = await tower.client.create(CHANNEL, 'Discuss', scene);
    const read = JSON.parse((await cli(tower, ['comments', '--file', file.id])).out);
    expect(read.threads[0].context.nearby[0].id).toBe('box');
    const reply = await cli(tower, ['reply', '--file', file.id, '--thread', 'thread', '--body', 'Answer', '--base', file.current_version_id]);
    expect(reply.code).toBe(0);
    const current = await tower.client.read(file.id);
    expect(current.scene.wingman.comments[0].messages[1]).toMatchObject({ body: 'Answer', author_npub: 'npub1agent' });
    expect((await cli(tower, ['reply', '--file', file.id, '--thread', 'thread', '--body', 'Stale', '--base', file.current_version_id])).code).toBe(EXIT_STALE);
    expect(tower.files.get(file.id).versions).toHaveLength(2);
    await expect(cli(tower, ['reply', '--file', file.id, '--thread', 'thread', '--body', 'No base'])).rejects.toThrow(/base/);
  });

  it('creates and links, reads an exact version, edits locally and publishes against its base', async () => {
    const tower = fakeTower();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-cli-'));
    const created = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'Agent plan', '--canvas', CANVAS])).out);
    expect(tower.naplets[0]).toMatchObject({ source: { type: 'excalidraw', id: created.file_id }, title: 'Agent plan' });
    const scenePath = path.join(dir, 'plan.excalidraw');
    expect((await cli(tower, ['read', '--file', created.file_id, '--out', scenePath])).code).toBe(0);
    const sidecar = JSON.parse(await readFile(`${scenePath}.wingman.json`, 'utf8'));
    expect(sidecar).toMatchObject({ file_id: created.file_id, base_version_id: created.version_id, base_version_number: 1 });
    const scene = JSON.parse(await readFile(scenePath, 'utf8'));
    scene.elements.push(rect('agent-box', 1));
    await writeFile(scenePath, JSON.stringify(scene));
    const published = await cli(tower, ['publish', '--file', created.file_id, '--scene', scenePath, '--summary', 'Add agent box']);
    expect(published.code).toBe(0);
    expect(JSON.parse(published.out)).toMatchObject({ ok: true, version_number: 2 });
    const versions = JSON.parse((await cli(tower, ['versions', '--file', created.file_id])).out);
    expect(versions[0]).toMatchObject({ version_number: 2, current: true, author_npub: 'npub1agent', summary: 'Add agent box' });
    expect(tower.requests.every(row => row.authorization?.startsWith('Nostr '))).toBe(true);
  });

  it('rejects a stale base with exit 3 and leaves the local scene untouched', async () => {
    const tower = fakeTower();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-cli-'));
    const created = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'Race'])).out);
    const mine = path.join(dir, 'mine.excalidraw'), theirs = path.join(dir, 'theirs.excalidraw');
    await cli(tower, ['read', '--file', created.file_id, '--out', mine]);
    await cli(tower, ['read', '--file', created.file_id, '--out', theirs]);
    await writeFile(theirs, JSON.stringify({ type: 'excalidraw', elements: [rect('theirs', 1)], files: {} }));
    expect((await cli(tower, ['publish', '--file', created.file_id, '--scene', theirs])).code).toBe(0);
    const draft = JSON.stringify({ type: 'excalidraw', elements: [rect('mine', 1)], files: {} });
    await writeFile(mine, draft);
    const stale = await cli(tower, ['publish', '--file', created.file_id, '--scene', mine]);
    expect(stale.code).toBe(EXIT_STALE);
    expect(JSON.parse(stale.out)).toMatchObject({ ok: false, code: 'stale_base_version', current_version: { version_number: 2 } });
    expect(await readFile(mine, 'utf8')).toBe(draft);
    expect(tower.files.get(created.file_id).versions).toHaveLength(2);
  });

  it('reads an older exact version and exports a lossy public copy separately', async () => {
    const tower = fakeTower();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-cli-'));
    const source = path.join(dir, 'source.excalidraw');
    await writeFile(source, JSON.stringify({ type: 'excalidraw', elements: [rect('keep', 1), { ...rect('gone', 2), isDeleted: true }], files: {} }));
    const created = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'History', '--scene', source])).out);
    const v1 = path.join(dir, 'v1.excalidraw');
    await cli(tower, ['read', '--file', created.file_id, '--version', created.version_id, '--out', v1]);
    expect(JSON.parse(await readFile(v1, 'utf8')).elements.map(row => row.id)).toEqual(['keep', 'gone']);
    const publicPath = path.join(dir, 'public.excalidraw');
    await cli(tower, ['export', '--scene', v1, '--out', publicPath]);
    expect(JSON.parse(await readFile(publicPath, 'utf8')).elements.map(row => row.id)).toEqual(['keep']);
    const check = JSON.parse((await cli(tower, ['check', '--scene', v1])).out);
    expect(check).toMatchObject({ ok: true, elements: 2, deleted: 1 });
  });

  it('never takes the current head as a base for an arbitrary local file; dry run validates offline', async () => {
    const tower = fakeTower();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-cli-'));
    const created = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'No base'])).out);
    const loose = path.join(dir, 'loose.excalidraw');
    await writeFile(loose, JSON.stringify({ type: 'excalidraw', elements: [rect('x', 1)], files: {} }));
    const before = tower.requests.length;
    await expect(cli(tower, ['publish', '--file', created.file_id, '--scene', loose])).rejects.toThrow(/No base version/);
    expect(tower.requests.length).toBe(before);
    const dry = await cli(tower, ['publish', '--file', created.file_id, '--scene', loose, '--base', created.version_id, '--dry-run']);
    expect(JSON.parse(dry.out)).toMatchObject({ ok: true, dry_run: true, base_version_id: created.version_id, elements: 1 });
    expect(tower.requests.length).toBe(before);
    expect(tower.files.get(created.file_id).versions).toHaveLength(1);
  });

  it('refuses to publish a scene read from a different board', async () => {
    const tower = fakeTower();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-cli-'));
    const a = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'A'])).out);
    const b = JSON.parse((await cli(tower, ['create', '--channel', CHANNEL, '--title', 'B'])).out);
    const scenePath = path.join(dir, 'a.excalidraw');
    await cli(tower, ['read', '--file', a.file_id, '--out', scenePath]);
    await expect(cli(tower, ['publish', '--file', b.file_id, '--scene', scenePath])).rejects.toThrow(/read from board/);
  });
});
