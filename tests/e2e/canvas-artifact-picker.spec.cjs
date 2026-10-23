const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// The opaque HTML sandbox forbids service workers; see canvas.spec.cjs.
test.use({ serviceWorkers: 'allow', reducedMotion: 'reduce' });

const workspaceId = '20000000-0000-4000-8000-000000000022';
const canvasId = '30000000-0000-4000-8000-000000000023';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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

// Scope "Delivery" has General (two artefacts, a board and a photo), Design
// (one artefact) and Restricted (Files unreadable). Scope "Empty" has a
// channel with no artefacts. The daily artefact's manifest names a permitted
// logo and an image File the viewer cannot read ("private.png"): that one is
// intentionally denied and must never be downloaded.
const scopes = [{ id: id(1), name: 'Delivery' }, { id: id(2), name: 'Empty scope' }];
const channels = {
  [id(1)]: [{ id: id(11), scope_id: id(1), name: 'General' }, { id: id(12), scope_id: id(1), name: 'Design' }, { id: id(13), scope_id: id(1), name: 'Restricted' }],
  [id(2)]: [{ id: id(21), scope_id: id(2), name: 'Quiet' }],
};
const logo = png(160, 48, [220, 120, 20]);
const manifest = assets => `<script type="application/json" id="wingman-artifact-assets">${JSON.stringify({ version: 1, assets })}</script>`;
const dailyHtml = `<!doctype html><html><head><title>Daily</title></head><body><h1 id="heading">Team daily catch-up</h1><img data-asset="logo.png" alt="logo"><img data-asset="private.png" alt="private">${manifest([
  { name: 'logo.png', file_id: id(40), version_id: id(41), sha256: sha(logo) },
  { name: 'private.png', file_id: id(42), version_id: id(43), sha256: sha(logo) },
])}</body></html>`;
const logoHtml = '<h1 id="heading">NStack logo directions</h1>';
const deniedHtml = '<h1>secret</h1>';
const htmlVersions = {
  [id(31)]: { versionId: id(32), html: dailyHtml },
  [id(33)]: { versionId: id(34), html: logoHtml },
  [id(35)]: { versionId: id(36), html: deniedHtml, denied: true },
};
const file = (fileId, channelId, name, extra = {}) => ({ id: fileId, channel_id: channelId, scope_id: id(1), display_name: name, metadata: { html_artifact: true }, current_version_id: htmlVersions[fileId]?.versionId || id(99), updated_at: '2026-10-21T00:00:00Z', record_state: 'active', ...extra });
const channelFiles = {
  [id(11)]: [file(id(31), id(11), 'Team daily catch-up — HTML example'), file(id(35), id(11), 'Revoked report'), file(id(37), id(11), 'Roadmap.excalidraw', { metadata: { kind: 'excalidraw_board', title: 'Roadmap' } }), file(id(38), id(11), 'photo.png', { metadata: {} })],
  [id(12)]: [file(id(33), id(12), 'NStack logo directions — HTML example')],
  [id(21)]: [],
};

let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js';\nexport { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';\nexport { normalizeWorkspaceEntry } from './src/workspaces.js';` },
  })).outputFiles[0].text;
});

async function openCanvas(page, context, log) {
  const naplets = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
    if (!url.pathname.startsWith(root)) return serveBuiltFlightDeck(route);
    expect(request.headers().authorization).toMatch(/^Nostr /);
    const suffix = url.pathname.slice(root.length);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ identity, ...body }) });
    log.requests.push(`${request.method()} ${suffix}`);
    if (suffix === '/scopes') return json({ scopes, next_cursor: null });
    let match = /^\/scopes\/([^/]+)\/channels$/.exec(suffix);
    if (match) return json({ scope_id: match[1], channels: channels[match[1]] || [], next_cursor: null });
    match = /^\/channels\/([^/]+)\/files$/.exec(suffix);
    if (match) return match[1] === id(13) ? json({ error: 'forbidden' }, 403) : json({ channel_id: match[1], files: channelFiles[match[1]] || [], next_cursor: null });
    match = /^\/files\/([^/]+)\/versions$/.exec(suffix);
    if (match) {
      const fileId = match[1];
      if (fileId === id(40)) return json({ versions: [{ id: id(41), file_id: id(40), version_number: 1, content_type: 'image/png', size_bytes: logo.length, sha256_hex: sha(logo) }] });
      const entry = htmlVersions[fileId];
      if (!entry || entry.denied) return json({ error: 'forbidden' }, 403);
      return json({ versions: [{ id: entry.versionId, file_id: fileId, version_number: 3, content_type: 'text/html', size_bytes: Buffer.byteLength(entry.html), sha256_hex: sha(Buffer.from(entry.html)) }] });
    }
    match = /^\/files\/([^/]+)\/versions\/([^/]+)\/object$/.exec(suffix);
    if (match) {
      log.objects.push(`${match[1]}/${match[2]}`);
      if (match[1] === id(40) && match[2] === id(41)) return route.fulfill({ contentType: 'image/png', body: logo });
      const entry = htmlVersions[match[1]];
      if (entry && !entry.denied && entry.versionId === match[2]) return route.fulfill({ contentType: 'text/html', body: entry.html });
      return json({ error: 'not_found' }, 404);
    }
    if (suffix === `/canvases/${canvasId}/snapshot`) {
      return json({ workspace_id: workspaceId, complete: true, canvas: { id: canvasId, title: 'Picker test', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace', actor_ids: [], group_ids: [] }, viewport: { x: 0, y: 0, scale: 1 } }, naplets, elements: [], comments: [] });
    }
    if (request.method() === 'POST' && suffix === `/canvases/${canvasId}/naplets`) {
      const body = request.postDataJSON();
      log.created.push(body);
      const entry = htmlVersions[body.source.id];
      naplets.push({
        id: `naplet-${naplets.length + 1}`, access: 'ready', row_version: 1, title: body.title, layout: body.layout, source: { type: 'html', id: body.source.id, version_id: null },
        content: { html: entry.html, version: '3', digest: sha(Buffer.from(entry.html)), file_id: body.source.id, version_id: entry.versionId, version_number: 3, current_version_id: entry.versionId, current_version_number: 3, follows_latest: true, assets: [], manifest_error: null },
      });
      return json({ naplet: naplets.at(-1) }, 201);
    }
    return json({ error: 'not_found' }, 404);
  });

  await page.goto('/__seed.html');
  const workspaceKey = await page.evaluate(async ({ workspaceId, identity }) => {
    const module = await import('/__seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'actor-reader', npub }, identity }, pgDescriptor: { identity } });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    // Nothing is cached locally: discovery must come from Tower.
    const db = module.createWorkspaceDb(workspace.workspaceKey); await db.open(); db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity });
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  await expect(page.getByRole('button', { name: 'Add naplet' })).toBeVisible();
}

for (const width of [1440, 390]) test(`scope-first artefact picker previews and adds an existing HTML File (${width}px)`, async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: width < 700 ? 844 : 720 });
  const log = { requests: [], objects: [], created: [] };
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await openCanvas(page, context, log);

  await page.getByRole('button', { name: 'Add naplet' }).click();
  const dialog = page.locator('.canvas-add-dialog');
  await dialog.getByLabel('Type').selectOption('html');
  const picker = dialog.locator('.canvas-artifact-picker');
  const scope = picker.getByLabel('Scope'), channel = picker.getByLabel('Channel'), status = picker.locator('.canvas-artifact-status');
  await expect(status).toHaveText('Choose a scope to see its HTML artefacts.');
  await expect(channel).toBeDisabled();
  expect(log.requests.some(row => row.includes('/channels'))).toBe(false);
  await expect(scope.locator('option')).toHaveText(['Choose a scope', 'Delivery', 'Empty scope']);

  // Scope only: every readable channel in the scope, named, HTML only.
  await scope.selectOption({ label: 'Delivery' });
  await expect(status).toHaveText('3 of 3 HTML artefacts in this scope. 1 channel unavailable.');
  await expect(channel.locator('option')).toHaveText(['All channels', 'Design', 'General', 'Restricted']);
  const items = picker.locator('.canvas-artifact-list button');
  await expect(items.locator('.canvas-artifact-title')).toHaveText(['NStack logo directions — HTML example', 'Revoked report', 'Team daily catch-up — HTML example']);
  await expect(picker.locator('.canvas-artifact-list')).not.toContainText('photo.png');
  expect(log.objects).toEqual([]);

  // Scope + channel.
  await channel.selectOption({ label: 'General' });
  await expect(items.locator('.canvas-artifact-title')).toHaveText(['Revoked report', 'Team daily catch-up — HTML example']);
  await expect(status).toHaveText('2 of 2 HTML artefacts in this channel.');
  await channel.selectOption({ label: 'Restricted' });
  await expect(status).toHaveText('Files in this channel are unavailable to you.');
  await channel.selectOption({ label: 'All channels' });
  await expect(items).toHaveCount(3);

  // Select and preview: only this File's version and its permitted image are fetched.
  await items.filter({ hasText: 'Team daily catch-up' }).click();
  const preview = picker.locator('.canvas-artifact-preview');
  await expect(preview.locator('figcaption')).toHaveText('Team daily catch-up — HTML example · v3 · adds as latest');
  const frame = preview.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('data-assets-delivered', '1');
  await expect(page.frameLocator('.canvas-artifact-preview iframe').locator('#heading')).toHaveText('Team daily catch-up');
  const previewFrame = page.frameLocator('.canvas-artifact-preview iframe');
  await expect.poll(() => previewFrame.locator('img[alt="logo"]').evaluate(img => img.naturalWidth)).toBe(160);
  // The denied image stays unresolved and its bytes are never requested.
  expect(await previewFrame.locator('img[alt="private"]').evaluate(img => img.naturalWidth)).toBe(0);
  expect(log.objects.sort()).toEqual([`${id(31)}/${id(32)}`, `${id(40)}/${id(41)}`].sort());
  expect(log.requests.some(row => row.includes(id(42)) && row.endsWith('/object'))).toBe(false);
  // Selecting scrolls the preview into view on phones; Add stays reachable.
  await expect(preview.locator('iframe')).toBeInViewport({ ratio: width < 700 ? 0.5 : 1 });
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeInViewport();
  // Evidence only: hide the intentionally denied image's broken-image glyph.
  await previewFrame.locator('img[alt="private"]').evaluate(img => { img.style.display = 'none'; });
  await page.screenshot({ path: test.info().outputPath(`artifact-picker-preview-${width}.png`) });
  // No artefact markup reaches the host document.
  expect(await page.locator('#heading').count()).toBe(0);
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

  // Narrowing the channel drops the selection; a File whose access was
  // revoked after listing shows a neutral message and no content.
  await channel.selectOption({ label: 'General' });
  await expect(preview.locator('iframe')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await items.filter({ hasText: 'Revoked report' }).click();
  await expect(preview.locator('figcaption')).toHaveText('This artefact is unavailable to you.');
  await expect(preview.locator('iframe')).toHaveCount(0);
  expect(log.objects.some(row => row.startsWith(id(35)))).toBe(false);

  // Changing scope clears the channel, selection and preview.
  await items.filter({ hasText: 'Team daily catch-up' }).click();
  await expect(frame).toHaveAttribute('data-assets-delivered', '1');
  await scope.selectOption({ label: 'Empty scope' });
  await expect(channel).toHaveValue('');
  await expect(channel.locator('option')).toHaveText(['All channels', 'Quiet']);
  await expect(status).toHaveText('No HTML artefacts in this scope.');
  await expect(preview.locator('iframe')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

  // Back to Delivery → General: add the existing File.
  await scope.selectOption({ label: 'Delivery' });
  await channel.selectOption({ label: 'General' });
  await items.filter({ hasText: 'Team daily catch-up' }).click();
  await expect(frame).toHaveAttribute('data-assets-delivered', '1');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(log.created).toHaveLength(1);
  expect(log.created[0]).toMatchObject({ source: { type: 'html', id: id(31) }, title: 'Team daily catch-up — HTML example' });
  expect(log.created[0].source).not.toHaveProperty('version_id');
  await expect(page.locator('[data-canvas-key="naplet:naplet-1"] .canvas-html-version')).toHaveText('Latest · v3');

  // Reopening starts fresh.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  await dialog.getByLabel('Type').selectOption('html');
  await expect(status).toHaveText('Choose a scope to see its HTML artefacts.');
  await expect(scope).toHaveValue('');
  expect(pageErrors).toEqual([]);
});

test('linking an existing board uses the same scope-first picker', async ({ page, context }) => {
  const log = { requests: [], objects: [], created: [] };
  await openCanvas(page, context, log);
  await page.getByRole('button', { name: 'Add naplet' }).click();
  const dialog = page.locator('.canvas-add-dialog');
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await expect(dialog.locator('.canvas-artifact-picker')).toBeHidden();
  await dialog.getByLabel('Link existing board').check();
  const picker = dialog.locator('.canvas-artifact-picker');
  await picker.getByLabel('Scope').selectOption({ label: 'Delivery' });
  await expect(picker.locator('.canvas-artifact-list .canvas-artifact-title')).toHaveText(['Roadmap']);
  await expect(picker.locator('.canvas-artifact-preview')).toBeHidden();
  await picker.locator('.canvas-artifact-list button').click();
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  expect(log.objects).toEqual([]);
});
