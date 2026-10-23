import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactPackageError, MANIFEST_ID, packageArtifactFolder, readManifest } from '../scripts/html-artifact/package.mjs';

const CLI = path.resolve(__dirname, '../scripts/publish-html-artifact.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = color => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, color, color, color]);

let root;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'html-artifact-test-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function folder(files) {
  const dir = await mkdtemp(path.join(root, 'artefact-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

function runCli(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.env.BUN_BIN || 'bun', [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const page = body => `<!doctype html><html lang="en"><head><title>Report</title><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body>${body}</body></html>`;

describe('artefact packaging', () => {
  it('inlines local CSS and JS and turns local images into private asset references', async () => {
    const dir = await folder({
      'index.html': page('<img src="img/hero.png" alt="Hero" loading="lazy"><a href="img/hero.png"><img src="img/badge.png"></a><a href="#top">Top</a>'),
      'style.css': 'h1{color:red}',
      'app.js': 'window.ready=1',
      'img/hero.png': png(1),
      'img/badge.png': png(2),
    });
    const packaged = await packageArtifactFolder(dir);
    expect(packaged.title).toBe('Report');
    expect(packaged.html).toContain('h1{color:red}');
    expect(packaged.html).toContain('window.ready=1');
    expect(packaged.html).not.toMatch(/src="img\/|href="style.css"|href="img\//);
    expect(packaged.html).toContain('data-asset="hero.png"');
    expect(packaged.html).toContain('data-asset="badge.png"');
    expect(packaged.html).toContain('href="#top"');
    expect(packaged.assets.map(asset => [asset.name, asset.contentType, asset.sha256])).toEqual([
      ['hero.png', 'image/png', sha(png(1))],
      ['badge.png', 'image/png', sha(png(2))],
    ]);
    expect(packaged.warnings.join('\n')).toMatch(/links to local files were removed/);
  });

  it('rejects remote dependencies, folder escapes and unsupported features with every problem listed', async () => {
    const outside = await folder({ 'secret.png': png(3) });
    const dir = await folder({
      'index.html': `<html><head><script src="https://cdn.example/lib.js"></script><link rel="stylesheet" href="https://fonts.example/a.css"></head><body>
        <img src="https://images.example/x.png"><img src="../${path.basename(outside)}/secret.png"><img src="/etc/passwd"><img src="a.png" srcset="a.png 2x"><img src="notes.txt"></body></html>`,
      'a.png': png(4),
      'notes.txt': 'not an image',
    });
    const error = await packageArtifactFolder(dir).catch(caught => caught);
    expect(error).toBeInstanceOf(ArtifactPackageError);
    const problems = error.problems.join('\n');
    expect(problems).toMatch(/remote scripts are not allowed/);
    expect(problems).toMatch(/remote stylesheets and fonts are not allowed/);
    expect(problems).toMatch(/remote images are not allowed/);
    expect(problems).toMatch(/resolves outside the artefact folder/);
    expect(problems).toMatch(/absolute path/);
    expect(problems).toMatch(/srcset is not supported/);
    expect(problems).toMatch(/not a supported image/);
  });

  it('refuses symlinks that leave the folder and images whose bytes lie about their type', async () => {
    const outside = await folder({ 'leak.png': png(5) });
    const dir = await folder({ 'index.html': '<img src="link.png"><img src="fake.png">', 'fake.png': 'GIF89a' });
    await symlink(path.join(outside, 'leak.png'), path.join(dir, 'link.png'));
    const error = await packageArtifactFolder(dir).catch(caught => caught);
    expect(error.problems.join('\n')).toMatch(/link\.png" resolves outside the artefact folder/);
    expect(error.problems.join('\n')).toMatch(/does not match its image\/png extension/);
  });
});

describe('publish CLI', () => {
  it('--dry-run packages without contacting Tower and writes a reviewable folder', async () => {
    const dir = await folder({ 'index.html': page('<img src="hero.png">'), 'style.css': 'p{}', 'app.js': '', 'hero.png': png(6) });
    const out = path.join(root, `out-${randomUUID()}`);
    const result = await runCli([dir, '--dry-run', '--out', out], { WINGMAN_TOWER_URL: 'http://127.0.0.1:1' });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ dry_run: true, title: 'Report', assets: [{ name: 'hero.png', content_type: 'image/png', sha256: sha(png(6)) }] });
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    expect(readManifest(html)).toEqual([expect.objectContaining({ name: 'hero.png', sha256: sha(png(6)) })]);
    expect(await readFile(path.join(out, 'assets', 'hero.png'))).toEqual(png(6));
    expect(await readFile(path.join(out, 'preview.html'), 'utf8')).toContain('assets/hero.png');
  });

  it('exits non-zero with readable problems for unsupported folders', async () => {
    const dir = await folder({ 'index.html': '<script src="https://cdn.example/x.js"></script>' });
    const result = await runCli([dir, '--dry-run']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Artefact cannot be packaged:[\s\S]*remote scripts are not allowed/);
  });

  describe('against a fake Tower with a fake capability broker', () => {
    const workspace = randomUUID(), channel = randomUUID(), canvas = randomUUID();
    const objects = new Map(), files = new Map(), calls = [];
    let server, origin, signer, raceNext = false;

    beforeAll(async () => {
      signer = path.join(root, 'fake-signer.mjs');
      // Mirrors `wingman-capability.ts nip98` output; records what it was asked to sign.
      await writeFile(signer, `const a = process.argv.slice(2); const i = k => a[a.indexOf(k) + 1];
console.log(JSON.stringify({ authorization: 'Nostr fake:' + i('--method') + ':' + (a.includes('--body-file') ? 'body' : 'nobody'), signedBy: 'npub1fake' }));`);
      const ws = `/api/v4/flightdeck-pg/workspaces/${workspace}`;
      const versionsOf = file => ({ current_version_id: file.versions.at(-1).id, versions: [...file.versions].reverse() });
      server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url, 'http://x');
        calls.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization, body });
        const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        let match;
        if (req.method === 'POST' && url.pathname === `${ws}/storage/prepare`) {
          const id = randomUUID(); objects.set(id, { contentType: body.content_type });
          return send(201, { object_id: id, is_public: false });
        }
        if ((match = url.pathname.match(/^\/api\/v4\/storage\/([^/]+)$/)) && req.method === 'PUT') {
          objects.get(match[1]).bytes = Buffer.from(body.base64_data, 'base64');
          return send(200, { object_id: match[1] });
        }
        if ((match = url.pathname.match(/^\/api\/v4\/storage\/([^/]+)\/complete$/))) {
          const object = objects.get(match[1]);
          if (sha(object.bytes) !== body.sha256_hex) return send(409, { error: 'storage SHA-256 mismatch' });
          object.completed = true;
          return send(200, { object_id: match[1] });
        }
        if (req.method === 'POST' && url.pathname === `${ws}/channels/${channel}/files`) {
          if (!objects.get(body.storage_object_id)?.completed) return send(400, { error: 'incomplete' });
          const file = { id: randomUUID(), channel_id: channel, display_name: body.display_name, metadata: body.metadata, versions: [{ id: randomUUID(), version_number: 1, object: body.storage_object_id }] };
          files.set(file.id, file);
          return send(201, { file: { id: file.id, channel_id: channel, current_version_id: file.versions[0].id } });
        }
        if ((match = url.pathname.match(new RegExp(`^${ws}/files/([^/]+)/versions$`)))) {
          const file = files.get(match[1]);
          if (!file) return send(404, { error: { code: 'file_not_found' } });
          if (req.method === 'GET') return send(200, versionsOf(file));
          // A concurrent publisher lands first.
          if (raceNext) { raceNext = false; file.versions.push({ id: randomUUID(), version_number: file.versions.length + 1, object: file.versions[0].object }); }
          if (body.base_version_id !== file.versions.at(-1).id) return send(409, { error: { code: 'stale_base_version' } });
          const version = { id: randomUUID(), version_number: file.versions.length + 1, object: body.storage_object_id };
          file.versions.push(version);
          return send(201, { version });
        }
        if ((match = url.pathname.match(new RegExp(`^${ws}/files/([^/]+)/object$`)))) {
          const file = files.get(match[1]);
          if (!file) return send(404, { error: { code: 'file_not_found' } });
          return send(200, { file: { id: file.id, channel_id: file.channel_id, current_version_id: file.versions.at(-1).id }, object: { base64_data: objects.get(file.versions.at(-1).object).bytes.toString('base64') } });
        }
        if (req.method === 'POST' && url.pathname === `${ws}/canvases/${canvas}/naplets`) return send(201, { naplet: { id: randomUUID(), access: 'ready', source: body.source } });
        return send(404, { error: 'unexpected route' });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise(resolve => server.close(resolve)));

    const publish = (dir, extra = []) => runCli([dir, '--tower', origin, '--workspace', workspace, '--signer-cli', signer, ...extra]);

    it('creates private image Files and an HTML File whose manifest pins exact versions, then updates in place', async () => {
      const dir = await folder({ 'index.html': page('<img src="hero.png"><img src="badge.png">'), 'style.css': '', 'app.js': '', 'hero.png': png(7), 'badge.png': png(8) });
      const first = await publish(dir, ['--channel', channel, '--canvas', canvas]);
      expect(first.code, first.stderr).toBe(0);
      const created = JSON.parse(first.stdout);
      const htmlFile = files.get(created.file_id);
      expect(htmlFile.metadata).toEqual({ html_artifact: true });
      expect(created).toMatchObject({ version_number: 1, channel_id: channel, naplet: { access: 'ready' } });
      expect(calls.find(call => call.path.endsWith('/naplets')).body.source).toEqual({ type: 'html', id: created.file_id });
      const manifest = readManifest(objects.get(htmlFile.versions[0].object).bytes.toString('utf8'));
      expect(manifest.map(row => row.name)).toEqual(['hero.png', 'badge.png']);
      for (const row of manifest) {
        const imageFile = files.get(row.file_id);
        expect(imageFile.metadata).toEqual({ html_artifact_asset: true });
        expect(imageFile.versions.map(version => version.id)).toContain(row.version_id);
        expect(row.sha256).toBe(sha(objects.get(imageFile.versions[0].object).bytes));
      }
      // Every request is signed through the broker; bodies are bound to the signature.
      expect(calls.every(call => /^Nostr fake:/.test(call.authorization))).toBe(true);
      expect(calls.filter(call => call.body !== undefined).every(call => call.authorization.endsWith(':body'))).toBe(true);
      expect(calls.filter(call => call.path.endsWith('/storage/prepare')).every(call => call.body.is_public === undefined)).toBe(true);

      // Update: unchanged hero is reused, changed badge gets a new version of the same image File.
      await writeFile(path.join(dir, 'badge.png'), png(9));
      const second = await publish(dir, ['--file', created.file_id]);
      expect(second.code, second.stderr).toBe(0);
      const updated = JSON.parse(second.stdout);
      expect(updated).toMatchObject({ file_id: created.file_id, version_number: 2, channel_id: channel });
      const next = readManifest(objects.get(htmlFile.versions[1].object).bytes.toString('utf8'));
      expect(next.find(row => row.name === 'hero.png')).toEqual(manifest.find(row => row.name === 'hero.png'));
      const badge = next.find(row => row.name === 'badge.png'), previousBadge = manifest.find(row => row.name === 'badge.png');
      expect(badge.file_id).toBe(previousBadge.file_id);
      expect(badge.version_id).not.toBe(previousBadge.version_id);
      expect(badge.sha256).toBe(sha(png(9)));
      expect(updated.update_command).toContain(`--file ${created.file_id}`);
    });

    it('reports a racing publication instead of overwriting it', async () => {
      const dir = await folder({ 'index.html': '<p>v1</p>' });
      const created = JSON.parse((await publish(dir, ['--channel', channel])).stdout);
      raceNext = true;
      await writeFile(path.join(dir, 'index.html'), '<p>v2</p>');
      const result = await publish(dir, ['--file', created.file_id]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/stale base_version_id/);
      expect(files.get(created.file_id).versions).toHaveLength(2);
    });

    it('refuses a --channel that differs from the existing File', async () => {
      const dir = await folder({ 'index.html': '<p>x</p>' });
      const created = JSON.parse((await publish(dir, ['--channel', channel])).stdout);
      const result = await publish(dir, ['--file', created.file_id, '--channel', randomUUID()]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--channel does not match/);
    });
  });
});

it('keeps the manifest id shared with Tower', () => {
  expect(MANIFEST_ID).toBe('wingman-artifact-assets');
});
