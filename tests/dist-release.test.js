import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectCurrentAssetClosure, publishStagedDist } from '../scripts/dist-release.mjs';
import { verifyDistAssets } from '../scripts/verify-dist-assets.mjs';
import { missingDistAssetGuardPlugin } from '../vite.config.js';

const temporaryDirectories = [];

function makeDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'flightdeck-dist-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, relativePath, body) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Flight Deck dist release publication', () => {
  it('retains relative lazy editor imports and their dependencies across a release', () => {
    const root = makeDirectory();
    const dist = path.join(root, 'dist');
    const staged = path.join(root, 'staged');
    write(dist, 'index.html', '<script src="/assets/app-old.js"></script>');
    write(dist, 'assets/app-old.js', 'import("./editor-old.js"); const preloads = ["assets/editor-old.css"];');
    write(dist, 'assets/editor-old.js', 'import "./nested/dependency-old.js";');
    write(dist, 'assets/nested/dependency-old.js', 'import "../app-old.js";');
    write(dist, 'assets/editor-old.css', 'old editor styles');
    write(staged, 'index.html', '<script src="/assets/app-new.js"></script>');
    write(staged, 'assets/app-new.js', 'new app');
    expect([...collectCurrentAssetClosure(dist)].sort()).toEqual([
      'app-old.js', 'editor-old.css', 'editor-old.js', 'nested/dependency-old.js',
    ]);
    const result = publishStagedDist(staged, dist);
    expect(result.retainedPreviousAssets).toHaveLength(4);
    for (const asset of result.retainedPreviousAssets) expect(existsSync(path.join(dist, 'assets', asset))).toBe(true);
  });

  it('ignores route patterns and diagnostic regexes when collecting assets', () => {
    const dist = makeDirectory();
    write(dist, 'index.html', '<script src="/assets/app.js"></script>');
    write(dist, 'assets/app.js', 'const route = "/assets/:id"; const pattern = "/assets/(${chunks})";');
    expect([...collectCurrentAssetClosure(dist)]).toEqual(['app.js']);
  });

  it('rejects a build with a missing lazy editor dependency before publication', () => {
    const dist = makeDirectory();
    write(dist, 'index.html', '<script src="/assets/app.js"></script><button data-chat-get-it-done="true"></button><div data-testid="chat-get-it-done-modal"></div>');
    write(dist, 'assets/app.js', 'import("./missing-editor.js")');
    write(dist, 'version.json', '{}');
    write(dist, 'service-worker.js', '');
    expect(() => verifyDistAssets(dist)).toThrow('missing asset /assets/missing-editor.js');
  });

  it('publishes complete new assets before atomically replacing HTML and retains the previous asset closure', () => {
    const root = makeDirectory();
    const dist = path.join(root, 'dist');
    const staged = path.join(root, 'staged');

    write(dist, 'index.html', '<script src="/assets/index-old.js"></script><link href="/assets/index-old.css">');
    write(dist, 'assets/index-old.js', 'new URL("/assets/worker-old.js", import.meta.url)');
    write(dist, 'assets/index-old.css', 'old css');
    write(dist, 'assets/worker-old.js', 'old worker');
    write(dist, 'assets/orphan.js', 'obsolete');

    write(staged, 'index.html', '<script src="/assets/index-new.js"></script><link href="/assets/index-new.css"><button data-chat-get-it-done="true"></button><div data-testid="chat-get-it-done-modal"></div>');
    write(staged, 'assets/index-new.js', 'new URL("/assets/worker-new.js", import.meta.url)');
    write(staged, 'assets/index-new.css', 'new css');
    write(staged, 'assets/worker-new.js', 'new worker');
    write(staged, 'version.json', '{}');
    write(staged, 'service-worker.js', 'self.addEventListener("fetch", () => {})');

    publishStagedDist(staged, dist, {
      onBeforeIndexPublish() {
        expect(readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('index-old.js');
        expect(existsSync(path.join(dist, 'assets/index-new.js'))).toBe(true);
        expect(existsSync(path.join(dist, 'assets/index-new.css'))).toBe(true);
      },
    });

    expect(readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('index-new.js');
    expect(existsSync(path.join(dist, 'assets/index-old.js'))).toBe(true);
    expect(existsSync(path.join(dist, 'assets/index-old.css'))).toBe(true);
    expect(existsSync(path.join(dist, 'assets/worker-old.js'))).toBe(true);
    expect(existsSync(path.join(dist, 'assets/orphan.js'))).toBe(false);
    expect(verifyDistAssets(dist).assetRefs).toEqual(['index-new.js', 'index-new.css']);
  });

  it('returns a real 404 for a missing preview asset instead of passing it to the SPA fallback', () => {
    let middleware;
    missingDistAssetGuardPlugin().configurePreviewServer({
      middlewares: { use(handler) { middleware = handler; } },
    });

    const headers = {};
    let body;
    let nextCalled = false;
    const response = {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      end(value) { body = value; },
    };
    middleware(
      { method: 'GET', url: '/assets/definitely-missing-flightdeck-asset.js' },
      response,
      () => { nextCalled = true; },
    );

    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(404);
    expect(headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(body).toBe('Asset not found');
  });

  it('keeps nginx asset misses out of the SPA fallback', () => {
    const nginx = readFileSync(path.resolve('nginx.conf'), 'utf8');
    const assetLocation = nginx.slice(nginx.indexOf('location /assets/'), nginx.indexOf('location = /index.html'));
    expect(assetLocation).toContain('try_files $uri =404;');
  });
});
