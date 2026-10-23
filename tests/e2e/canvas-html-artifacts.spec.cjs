const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// The opaque HTML sandbox forbids service workers; see canvas.spec.cjs.
test.use({ serviceWorkers: 'allow', reducedMotion: 'reduce' });

const workspaceId = '20000000-0000-4000-8000-000000000012';
const canvasId = '30000000-0000-4000-8000-000000000013';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
const id = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const heroV1 = png(6, 4, [200, 40, 40]);
const heroV2 = png(12, 8, [40, 160, 80]);
const badge = png(5, 5, [30, 60, 200]);
const forged = png(31, 31, [0, 0, 0]);
const asset = (name, fileId, versionId, bytes) => ({ name, status: 'ready', file_id: fileId, version_id: versionId, sha256: sha(bytes), size_bytes: bytes.length, content_type: 'image/png' });
const objects = new Map([[`${id(11)}/${id(12)}`, heroV1], [`${id(11)}/${id(13)}`, heroV2], [`${id(21)}/${id(22)}`, badge]]);

const fullDocument = (heading, image) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title><style>h1{color:rgb(10, 120, 60)}</style></head><body class="artefact"><h1 id="top">${heading}</h1><img data-asset="${image}" alt="hero"><img data-asset="private.png" alt="denied"><p id="out"></p></body></html>`;
// Naplet A tries to forge deliveries into every frame and spoof host notices.
const attacker = `<p id="attack">attacker</p><img data-asset="badge.png" alt="badge"><script>
  document.addEventListener('wingman:assets-ready', () => setTimeout(() => {
    const fake = new Blob([Uint8Array.from(atob(${JSON.stringify(forged.toString('base64'))}), c => c.charCodeAt(0))], { type: 'image/png' });
    for (let i = 0; i < parent.frames.length; i += 1) {
      for (const nonce of ['', 'guess', document.documentElement.innerHTML.match(/[0-9a-f]{32}/)?.[0] || 'x']) {
        try { parent.frames[i].postMessage({ type: 'wingman-artifact-assets', nonce, assets: [{ name: 'hero-v2.png', blob: fake }, { name: 'hero-v1.png', blob: fake }] }, '*'); } catch {}
      }
    }
    parent.postMessage({ type: 'wingman-artifact-assets:unload', nonce: 'guess' }, '*');
    parent.postMessage({ type: 'wingman-artifact-assets:ready', nonce: 'guess' }, '*');
    document.getElementById('attack').textContent = 'attempted ' + typeof window.wingmanAssets.url('badge.png');
  }, 50));
<\/script>`;
const navigator = '<p>leaving</p><script>setTimeout(() => location.replace("about:blank"), 300);<\/script>';

function htmlNaplet({ napletId, title, html, versionId, versionNumber, currentNumber = versionNumber, follows = true, assets, layout, fileId }) {
  return {
    id: napletId, access: 'ready', row_version: 1, title, layout,
    source: { type: 'html', id: fileId, version_id: follows ? null : versionId },
    content: { html, version: String(versionNumber), digest: sha(Buffer.from(html)), file_id: fileId, version_id: versionId, version_number: versionNumber, current_version_id: currentNumber === 2 ? id(16) : versionId, current_version_number: currentNumber, follows_latest: follows, assets, manifest_error: null },
  };
}

let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js';\nexport { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';\nexport { normalizeWorkspaceEntry } from './src/workspaces.js';` },
  })).outputFiles[0].text;
});

for (const width of [1440, 390]) test(`private HTML artefacts render permitted images, isolate naplets and browse/pin versions from the cog menu ${width}px`, async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: 900 });
  const v1Html = fullDocument('Daily catch-up v1', 'hero-v1.png');
  const v2Html = fullDocument('Daily catch-up v2', 'hero-v2.png');
  const deniedAsset = { name: 'private.png', status: 'unavailable' };
  let artefact = htmlNaplet({ napletId: 'artefact', fileId: id(15), title: 'Daily catch-up', html: v2Html, versionId: id(16), versionNumber: 2, assets: [asset('hero-v2.png', id(11), id(13), heroV2), deniedAsset], layout: { x: 20, y: 20, width: Math.min(520, width - 40), height: 420, z: 1 } });
  const naplets = () => [
    artefact,
    htmlNaplet({ napletId: 'attacker', fileId: id(25), title: 'Other artefact', html: attacker, versionId: id(26), versionNumber: 1, assets: [asset('badge.png', id(21), id(22), badge)], layout: { x: 560, y: 20, width: 360, height: 260, z: 2 } }),
    htmlNaplet({ napletId: 'navigator', fileId: id(35), title: 'Navigator', html: navigator, versionId: id(36), versionNumber: 1, assets: [], layout: { x: 560, y: 300, width: 360, height: 200, z: 3 } }),
  ];
  const assetRequests = [], patches = [], browses = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
    if (url.pathname.startsWith(root)) {
      expect(request.headers().authorization).toMatch(/^Nostr /);
      const suffix = url.pathname.slice(root.length);
      const object = /^\/files\/([^/]+)\/versions\/([^/]+)\/object$/.exec(suffix);
      if (object) {
        assetRequests.push(`${object[1]}/${object[2]}`);
        const bytes = objects.get(`${object[1]}/${object[2]}`);
        return bytes ? route.fulfill({ status: 200, contentType: 'image/png', body: bytes }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      if (suffix === `/canvases/${canvasId}/snapshot`) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvas: { id: canvasId, title: 'Artefacts', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace', actor_ids: [], group_ids: [] }, viewport: { x: 0, y: 0, scale: 1 } }, naplets: naplets(), elements: [], comments: [] }) });
      }
      if (suffix === `/canvases/${canvasId}/naplets/artefact/html`) {
        browses.push(url.searchParams.get('version_id'));
        const old = url.searchParams.get('version_id') === id(14);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          workspace_id: workspaceId, identity, naplet_id: 'artefact',
          content: old ? { ...artefact.content, html: v1Html, digest: sha(Buffer.from(v1Html)), version: '1', version_id: id(14), version_number: 1, assets: [asset('hero-v1.png', id(11), id(12), heroV1), deniedAsset] } : artefact.content,
          versions: [{ id: id(16), version_number: 2 }, { id: id(14), version_number: 1 }],
        }) });
      }
      if (request.method() === 'PATCH' && suffix === `/canvases/${canvasId}/naplets/artefact`) {
        const body = request.postDataJSON();
        patches.push(body.source_version_id);
        artefact = body.source_version_id
          ? htmlNaplet({ napletId: 'artefact', fileId: id(15), title: 'Daily catch-up', html: v1Html, versionId: id(14), versionNumber: 1, currentNumber: 2, follows: false, assets: [asset('hero-v1.png', id(11), id(12), heroV1), deniedAsset], layout: artefact.layout })
          : htmlNaplet({ napletId: 'artefact', fileId: id(15), title: 'Daily catch-up', html: v2Html, versionId: id(16), versionNumber: 2, assets: [asset('hero-v2.png', id(11), id(13), heroV2), deniedAsset], layout: artefact.layout });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ naplet: artefact }) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    return serveBuiltFlightDeck(route);
  });

  await page.goto('/__seed.html');
  const workspaceKey = await page.evaluate(async ({ workspaceId, identity }) => {
    const module = await import('/__seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'actor-reader', npub }, identity }, pgDescriptor: { identity } });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = module.createWorkspaceDb(workspace.workspaceKey); await db.open(); db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity });

  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  const artefactWindow = page.locator('[data-canvas-key="naplet:artefact"]');
  const status = artefactWindow.locator('.canvas-naplet-status');
  // No version strip: version state lives in the title bar, controls in the cog.
  await expect(status).toHaveText('Latest · v2');
  await expect(status).toHaveAttribute('title', 'Latest · v2 · 1 image unavailable');
  await expect(artefactWindow.locator('[role="toolbar"], select')).toHaveCount(0);
  // boundingBox() is null until the frame is laid out; wait rather than race it.
  await expect(artefactWindow.locator('iframe')).toBeVisible();
  await expect(artefactWindow.locator('.canvas-naplet-header')).toBeVisible();
  const frameBox = await artefactWindow.locator('iframe').boundingBox(), headerBox = await artefactWindow.locator('.canvas-naplet-header').boundingBox();
  expect(Math.abs(frameBox.y - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(2);
  const sandbox = await artefactWindow.locator('iframe').evaluate(frame => ({ sandbox: frame.getAttribute('sandbox'), srcdoc: frame.getAttribute('srcdoc') || '' }));
  expect(sandbox.sandbox).toBe('allow-scripts');
  expect(sandbox.srcdoc).not.toMatch(/Nostr |Authorization|nsec/);
  expect(sandbox.srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(sandbox.srcdoc.indexOf('h1{color:rgb(10, 120, 60)}'));

  const frameFor = napletId => page.frameLocator(`[data-canvas-key="naplet:${napletId}"] iframe`);
  const imageState = (napletId, alt) => frameFor(napletId).locator(`img[alt="${alt}"]`).evaluate(img => ({ state: img.dataset.assetState || '', width: img.naturalWidth, src: img.getAttribute('src') || '' }));
  await expect.poll(() => imageState('artefact', 'hero')).toMatchObject({ state: 'ready', width: 12 });
  await expect.poll(() => imageState('attacker', 'badge')).toMatchObject({ state: 'ready', width: 5 });
  expect((await imageState('artefact', 'hero')).src).toMatch(/^blob:/);
  expect(await imageState('artefact', 'denied')).toMatchObject({ state: 'missing', width: 0 });
  await expect(frameFor('artefact').locator('h1')).toHaveCSS('color', 'rgb(10, 120, 60)');
  await expect(frameFor('artefact').locator('body')).toHaveClass('artefact');
  expect(assetRequests.sort()).toEqual([`${id(11)}/${id(13)}`, `${id(21)}/${id(22)}`]);

  // Cross-naplet forgery and spoofed host notices change nothing.
  await expect(frameFor('attacker').locator('#attack')).toHaveText('attempted string');
  await page.waitForTimeout(300);
  expect(await imageState('artefact', 'hero')).toMatchObject({ state: 'ready', width: 12 });
  expect(await artefactWindow.locator('iframe').getAttribute('data-navigation-blocked')).toBeNull();

  // A self-navigating artefact is replaced and receives nothing further.
  await expect(page.locator('[data-canvas-key="naplet:navigator"] iframe')).toHaveAttribute('data-navigation-blocked', 'true');
  await expect(frameFor('navigator').locator('body')).toContainText('tried to navigate away');

  // The cog menu opens a Versions dialog by keyboard; focus returns to the cog on close.
  const cog = artefactWindow.getByRole('button', { name: 'Window options', exact: true });
  const menu = artefactWindow.getByRole('menu');
  const versionsDialog = page.getByRole('dialog', { name: 'Versions' });
  await cog.click();
  await expect(menu.getByRole('menuitem', { name: 'Minimise window' })).toBeFocused();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Versions…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(versionsDialog).toBeVisible();
  await expect(versionsDialog.getByRole('list', { name: 'Saved versions' }).getByRole('button')).toHaveText(['v2latest', 'v1']);
  await expect(versionsDialog.locator('[aria-current="true"]')).toHaveText('v2latest');
  await page.keyboard.press('Escape');
  await expect(versionsDialog).not.toBeVisible();
  await expect(cog).toBeFocused();

  const openVersions = async () => { await cog.click(); await menu.getByRole('menuitem', { name: 'Versions…' }).click(); await expect(versionsDialog).toBeVisible(); };
  // Viewer-local browsing loads v1 and its own private image.
  await openVersions();
  await versionsDialog.getByRole('button', { name: '‹ Older' }).click();
  await expect(status).toHaveText('Viewing v1');
  await expect(versionsDialog.locator('.canvas-versions-status')).toHaveText('Viewing v1 · 1 image unavailable');
  await expect(versionsDialog.getByRole('button', { name: '‹ Older' })).toBeDisabled();
  await expect(frameFor('artefact').locator('h1')).toHaveText('Daily catch-up v1');
  await expect.poll(() => imageState('artefact', 'hero')).toMatchObject({ state: 'ready', width: 6 });
  expect(browses).toContain(id(14));
  expect(patches).toEqual([]);
  await versionsDialog.getByRole('button', { name: 'Close' }).click();
  // Back to the shared version is also a direct cog action while browsing.
  await cog.click();
  await menu.getByRole('menuitem', { name: 'Back to v2' }).click();
  await expect(frameFor('artefact').locator('h1')).toHaveText('Daily catch-up v2');
  await expect(status).toHaveText('Latest · v2');

  // Pin v1 for everyone from the version list, then return to latest.
  await openVersions();
  await versionsDialog.getByRole('button', { name: /^v1/ }).click();
  await expect(status).toHaveText('Viewing v1');
  await versionsDialog.getByRole('button', { name: 'Pin this version' }).click();
  await expect(status).toHaveText('Pinned · v1 (latest v2)');
  await expect(versionsDialog.getByRole('list', { name: 'Saved versions' }).getByRole('button')).toHaveText(['v2latest', 'v1pinned']);
  await expect(frameFor('artefact').locator('h1')).toHaveText('Daily catch-up v1');
  await versionsDialog.getByRole('button', { name: 'Follow latest' }).click();
  await expect(status).toHaveText('Latest · v2');
  await versionsDialog.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => imageState('artefact', 'hero')).toMatchObject({ state: 'ready', width: 12 });
  expect(patches).toEqual([id(14), null]);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('canvas-html-artifacts.png') });
  console.log('CANVAS_HTML_ARTIFACT_EVIDENCE', JSON.stringify({ width, cogVersions: true, privateImagesRendered: true, deniedImageMissing: true, crossNapletForgeryIgnored: true, selfNavigationBlocked: true, versionBrowse: true, pinAndFollowLatest: true, assetRequests: assetRequests.length }));
});
