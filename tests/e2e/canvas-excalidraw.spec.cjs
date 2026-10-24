const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const crypto = require('node:crypto');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

const workspaceId = '20000000-0000-4000-8000-000000000071';
const canvasId = '30000000-0000-4000-8000-000000000072';
const channelId = '50000000-0000-4000-8000-000000000073';
const scopeId = '50000000-0000-4000-8000-000000000074';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
const CONTENT_TYPE = 'application/vnd.excalidraw+json';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let counter = 0;
const uid = () => `60000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const element = (id, type = 'rectangle', extra = {}) => ({ id, type, x: 40, y: 40, width: 120, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, version: 1, versionNonce: 11, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra });

/** Synthetic signed Tower: Files, immutable versions with base_version_id CAS, canvas naplets. */
function fakeTower() {
  const objects = new Map(), files = new Map(), log = [];
  const state = { naplets: [], revoked: false, canvasRow: 1, renameError: false, readOnly: false };
  const addVersion = (file, bytes, author, summary = null) => {
    const objectId = uid(); objects.set(objectId, Buffer.from(bytes));
    const version = { id: uid(), version_number: file.versions.length + 1, storage_object_id: objectId, sha256_hex: sha(bytes), size_bytes: bytes.length, content_type: CONTENT_TYPE, created_by_actor_npub: author, summary, created_at: new Date(Date.UTC(2026, 9, 21, 6, file.versions.length)).toISOString() };
    file.versions.push(version); file.current_version_id = version.id;
    return version;
  };
  const sceneBytes = elements => Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }));
  const meta = file => { const current = file.versions.at(-1); return { file_id: file.id, current_version_id: current.id, current_version_number: current.version_number, content_type: CONTENT_TYPE, size_bytes: current.size_bytes, sha256: current.sha256_hex, can_write: !state.readOnly }; };
  const naplets = () => state.naplets.map(naplet => {
    const file = files.get(naplet.source.id);
    return state.revoked || !file
      ? { id: naplet.id, access: 'denied', layout: naplet.layout, row_version: 1 }
      : { id: naplet.id, access: 'ready', row_version: 1, title: naplet.title, layout: naplet.layout, source: { type: 'excalidraw', id: file.id }, content: meta(file) };
  });
  const tower = {
    files, log, state, naplets,
    createBoard(title, elements, author = 'npub1agent') {
      const file = { id: uid(), channel_id: channelId, display_name: `${title}.excalidraw`, versions: [] };
      files.set(file.id, file); addVersion(file, sceneBytes(elements), author);
      return file;
    },
    versionScene(fileId, number) {
      const version = files.get(fileId).versions.find(row => row.version_number === number);
      return JSON.parse(objects.get(version.storage_object_id).toString());
    },
    agentPublish(fileId, mutate, extraFiles = {}) {
      const file = files.get(fileId);
      const current = JSON.parse(objects.get(file.versions.at(-1).storage_object_id).toString());
      const next = { ...current, elements: mutate(current.elements), files: { ...current.files, ...extraFiles } };
      return addVersion(file, Buffer.from(JSON.stringify(next)), 'npub1agent', 'agent edit');
    },
    async handle(route) {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      expect(request.headers().authorization).toMatch(/^Nostr /);
      const body = request.postData() ? request.postDataJSON() : null;
      log.push(`${method} ${url.pathname}`);
      let match;
      if ((match = url.pathname.match(/^\/api\/v4\/storage\/([^/]+)$/)) && method === 'PUT') { objects.set(match[1], Buffer.from(body.base64_data, 'base64')); return json({ object_id: match[1] }); }
      if ((match = url.pathname.match(/^\/api\/v4\/storage\/([^/]+)\/complete$/))) { expect(body.sha256_hex).toBe(sha(objects.get(match[1]))); return json({}); }
      const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
      const suffix = url.pathname.slice(root.length);
      if (suffix === '/storage/prepare') { expect(body.content_type).toBe(CONTENT_TYPE); expect(body.is_public).toBeUndefined(); return json({ object_id: uid(), is_public: false }); }
      // Scope-first discovery used by "Link existing board".
      if (suffix === '/scopes' && method === 'GET') return json({ identity, scopes: [{ id: scopeId, name: 'Delivery' }], next_cursor: null });
      if (suffix === `/scopes/${scopeId}/channels` && method === 'GET') return json({ identity, scope_id: scopeId, channels: [{ id: channelId, scope_id: scopeId, name: 'Boards' }], next_cursor: null });
      if (suffix === `/channels/${channelId}/files` && method === 'GET') {
        return json({ identity, channel_id: channelId, files: [...files.values()].map(file => ({ id: file.id, channel_id: channelId, display_name: file.display_name, metadata: {}, current_version_id: file.current_version_id })), next_cursor: null });
      }
      if (suffix === `/channels/${channelId}/files` && method === 'POST') {
        const file = { id: uid(), channel_id: channelId, display_name: body.display_name, versions: [] };
        files.set(file.id, file);
        const bytes = objects.get(body.storage_object_id); const version = addVersion(file, bytes, 'npub1me');
        return json({ file: { id: file.id, current_version_id: version.id } }, 201);
      }
      if ((match = suffix.match(/^\/files\/([^/]+)$/))) {
        const file = files.get(match[1]);
        if (!file || state.revoked) return json({ error: 'not found' }, 404);
        if (method === 'PATCH') {
          expect(Object.keys(body)).toEqual(['display_name']);
          if (state.renameError || state.readOnly) return json({ error: 'Rename refused' }, 403);
          file.display_name = body.display_name;
        }
        return json({ identity, file: { id: file.id, display_name: file.display_name } });
      }
      if ((match = suffix.match(/^\/files\/([^/]+)\/versions$/))) {
        const file = files.get(match[1]);
        if (!file || state.revoked) return json({ error: 'not found' }, 404);
        if (method === 'GET') return json({ identity, file_id: file.id, current_version_id: file.current_version_id, versions: [...file.versions].reverse() });
        if (body.base_version_id !== file.current_version_id) return json({ error: 'File base_version_id is stale', code: 'stale_base_version', status: 409, identity, current_version: file.versions.at(-1) }, 409);
        return json({ identity, version: addVersion(file, objects.get(body.storage_object_id), 'npub1me', body.summary || null) }, 201);
      }
      if ((match = suffix.match(/^\/files\/([^/]+)\/versions\/([^/]+)\/object$/))) {
        const version = files.get(match[1])?.versions.find(row => row.id === match[2]);
        if (!version || state.revoked) return json({ error: 'not found' }, 404);
        return route.fulfill({ status: 200, contentType: CONTENT_TYPE, body: objects.get(version.storage_object_id) });
      }
      if (suffix === `/canvases/${canvasId}/snapshot`) {
        return json({ workspace_id: workspaceId, identity, complete: true, canvas: { id: canvasId, title: 'Boards', position: 1, row_version: state.canvasRow, can_manage: true, visibility: { mode: 'workspace', actor_ids: [], group_ids: [] }, viewport: { x: 0, y: 0, scale: 1 } }, naplets: naplets(), elements: [], comments: [] });
      }
      if (suffix === `/canvases/${canvasId}/naplets` && method === 'POST') {
        expect(body.source.type).toBe('excalidraw');
        if (!files.has(body.source.id)) return json({ error: 'invalid source' }, 400);
        const naplet = { id: uid(), source: body.source, title: body.title || 'Board', layout: body.layout };
        state.naplets.push(naplet);
        return json({ naplet }, 201);
      }
      if (suffix === `/canvases/${canvasId}` && method === 'PATCH') { state.canvasRow += 1; return json({ canvas: {} }); }
      return json({ error: `unhandled ${method} ${suffix}` }, 404);
    },
  };
  return tower;
}

let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js';\nexport { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';\nexport { normalizeWorkspaceEntry } from './src/workspaces.js';` },
  })).outputFiles[0].text;
});

async function openCanvas(page, context, tower, { existingBoard = null } = {}) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    if (url.pathname.startsWith('/api/')) return tower.handle(route);
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/__seed.html');
  const workspaceKey = await page.evaluate(async ({ workspaceId, identity, channelId, existingBoard, CONTENT_TYPE }) => {
    const module = await import('/__seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'actor-me', npub }, identity }, pgDescriptor: { identity } });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = module.createWorkspaceDb(workspace.workspaceKey); await db.open();
    await db.channels.put({ record_id: channelId, title: 'Planning', record_state: 'active' });
    if (existingBoard) await db.documents.put({ record_id: existingBoard.id, pg_record_type: 'file', title: existingBoard.title, content_storage_content_type: CONTENT_TYPE, record_state: 'active' });
    db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity, channelId, existingBoard, CONTENT_TYPE });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  await expect(page.locator('.canvas-toolbar h1')).toHaveText('Boards');
  return { workspaceKey, errors };
}

const boardWindow = (page, index = 0) => page.locator('.canvas-naplet').filter({ has: page.locator('.canvas-board') }).nth(index);
const editorRoot = (page, index = 0) => boardWindow(page, index).frameLocator('.canvas-board-frame').locator('#board-root');
const frameSize = async (page, index = 0) => {
  const box = await boardWindow(page, index).locator('.canvas-board-frame').boundingBox();
  return box ? { width: Math.round(box.width), height: Math.round(box.height) } : { width: 0, height: 0 };
};
async function expectEditorSized(page, index = 0, minimum = 200) {
  await expect.poll(async () => (await frameSize(page, index)).height).toBeGreaterThan(minimum);
  await expect.poll(() => editorRoot(page, index).locator('canvas.interactive').evaluate(canvas => canvas.getBoundingClientRect().height)).toBeGreaterThan(minimum);
}
const count = async (page, index = 0) => Number(await editorRoot(page, index).getAttribute('data-board-element-count'));

async function drawRectangle(page, index = 0, offset = 0) {
  const frame = boardWindow(page, index).locator('.canvas-board-frame');
  await expect(editorRoot(page, index).locator('canvas.interactive')).toBeVisible();
  const box = await frame.boundingBox();
  const x = box.x + box.width / 2 - 80 + offset, y = box.y + box.height / 2 - 40 + offset;
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await page.keyboard.press('r');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y + 60, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

async function menu(page, index, label) {
  const window = boardWindow(page, index);
  await window.locator('.window-options').click();
  await window.locator('.canvas-window-options').getByRole('menuitem', { name: label }).click();
}
// Version and save state live in the title bar; Save floats in Excalidraw's top-right slot.
const status = (page, index = 0) => boardWindow(page, index).locator('.canvas-naplet-status');
const floatingSave = (page, index = 0) => boardWindow(page, index).frameLocator('.canvas-board-frame').locator('.wingman-board-action');

test('create, edit inline and full screen, save explicitly, reuse and browse versions', async ({ page, context }) => {
  test.setTimeout(150_000);
  const tower = fakeTower();
  const { errors } = await openCanvas(page, context, tower);

  // Add naplet → Excalidraw board → Create board creates the File and links it.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  const dialog = page.locator('.canvas-add-dialog');
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await dialog.getByRole('radio', { name: 'Create board' }).check();
  await dialog.getByLabel('Board title').fill('Release plan');
  await expect(dialog.getByLabel('Channel')).toHaveValue(channelId);
  await dialog.getByRole('button', { name: 'Create board' }).click();
  await expect(boardWindow(page)).toBeVisible();
  expect(tower.files.size).toBe(1);
  const [board] = tower.files.values();
  expect(tower.state.naplets[0].source).toEqual({ type: 'excalidraw', id: board.id });
  await expect(status(page)).toHaveText('v1');
  await expect(boardWindow(page).locator('[role="toolbar"], .canvas-board-history')).toHaveCount(0);
  await expect(floatingSave(page)).toHaveText('Saved');
  await expect(floatingSave(page)).toBeDisabled();
  await expect(editorRoot(page)).toHaveAttribute('data-board-readonly', 'false');
  await expectEditorSized(page);
  // An empty board opens at 100%, not at Excalidraw's fit-to-empty maximum.
  await expect(editorRoot(page)).toHaveAttribute('data-board-zoom', '1');

  // Inline drawing makes an unsaved local draft; nothing is published.
  await drawRectangle(page);
  await expect(status(page)).toHaveText('Unsaved · v1');
  await expect(floatingSave(page)).toBeEnabled();
  await expect.poll(() => count(page)).toBe(1);
  expect(board.versions).toHaveLength(1);

  // Full screen keeps the same editor instance and draft; draw there too.
  const keyBefore = await editorRoot(page).getAttribute('data-board-key');
  await boardWindow(page).locator('.window-popout').click();
  await expect(boardWindow(page)).toHaveClass(/window-expanded/);
  await expectEditorSized(page, 0, 600);
  await expect.poll(() => count(page)).toBe(1);
  await drawRectangle(page, 0, 160);
  await expect.poll(() => count(page)).toBe(2);
  await boardWindow(page).locator('.window-popout').click();
  await expect(boardWindow(page)).not.toHaveClass(/window-expanded/);
  await expect.poll(() => count(page)).toBe(2);
  expect(await editorRoot(page).getAttribute('data-board-key')).toBe(keyBefore);
  expect(board.versions).toHaveLength(1);

  // Explicit Save from the naplet menu creates immutable v2 against base v1.
  await menu(page, 0, 'Save with note…');
  await page.locator('.canvas-board-save-dialog').getByLabel('Change summary (optional)').fill('Two lanes');
  await page.locator('.canvas-board-save-dialog').getByRole('button', { name: 'Save version' }).click();
  await expect(status(page)).toHaveText('v2');
  await expect(floatingSave(page)).toHaveText('Saved');
  expect(board.versions.map(row => row.version_number)).toEqual([1, 2]);
  expect(board.versions[1].summary).toBe('Two lanes');

  // Link existing board: a second naplet references the same canonical board.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await dialog.getByRole('radio', { name: 'Link existing board' }).check();
  await dialog.locator('.canvas-artifact-picker').getByLabel('Scope').selectOption({ label: 'Delivery' });
  await dialog.locator('.canvas-artifact-list button', { hasText: 'Release plan' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.canvas-board')).toHaveCount(2);
  expect(tower.files.size).toBe(1);
  expect(tower.state.naplets.map(row => row.source.id)).toEqual([board.id, board.id]);
  await expect.poll(() => count(page, 1)).toBe(2);
  await expect(status(page, 1)).toHaveText('v2');

  // Both naplets share one draft: drawing in one marks both unsaved.
  await drawRectangle(page, 1, 40);
  await expect.poll(() => count(page, 0)).toBe(3);
  await expect(status(page, 0)).toHaveText('Unsaved · v2');
  page.once('dialog', prompt => prompt.accept());
  await menu(page, 1, 'Discard unsaved changes');
  await expect(status(page, 0)).toHaveText('v2');
  await expect.poll(() => count(page, 0)).toBe(2);

  // History lives in the cog's Versions dialog (on the top naplet, which overlaps the first).
  const versions = page.getByRole('dialog', { name: 'Versions' });
  await menu(page, 1, 'Versions…');
  await expect(versions.getByRole('list', { name: 'Saved versions' }).getByRole('button')).toHaveCount(2);
  await expect(versions).toContainText('Two lanes');
  await expect(versions.locator('[aria-current="true"]')).toContainText('v2');
  await versions.getByRole('button', { name: '‹ Older' }).click();
  await expect(status(page, 1)).toHaveText('Viewing v1 · read-only');
  await expect(versions.locator('[aria-current="true"]')).toContainText('v1');
  await versions.getByRole('button', { name: 'Close' }).click();
  await expect(editorRoot(page, 1)).toHaveAttribute('data-board-readonly', 'true');
  await expect(floatingSave(page, 1)).toHaveCount(0);
  await expect.poll(() => count(page, 1)).toBe(0);
  await menu(page, 1, 'Return to latest');
  await expect.poll(() => count(page, 1)).toBe(2);
  await expect(status(page, 1)).toHaveText('v2');
  await expect(editorRoot(page, 1)).toHaveAttribute('data-board-readonly', 'false');
  await expectEditorSized(page, 1, 300);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('canvas-excalidraw-boards.png') });
});

test('boards open at 100% inline and full screen; the viewer\'s zoom survives full screen and Save', async ({ page, context }) => {
  test.setTimeout(120_000);
  const tower = fakeTower();
  // A small drawing that fit-to-viewport would magnify to Excalidraw's 3000% maximum.
  const board = tower.createBoard('Sketch', [element('dot', 'rectangle', { x: 300, y: 200, width: 8, height: 8 })]);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: board.id }, title: 'Sketch', layout: { x: 40, y: 40, width: 640, height: 460, z: 1 } });
  const { errors } = await openCanvas(page, context, tower, { existingBoard: { id: board.id, title: 'Sketch.excalidraw' } });
  await expect.poll(() => count(page)).toBe(1);
  await expectEditorSized(page);
  const zoom = () => editorRoot(page).getAttribute('data-board-zoom');
  // Excalidraw's own zoom readout, as the viewer sees it (full screen only;
  // the compact inline layout has no zoom footer).
  const zoomLabel = boardWindow(page).frameLocator('.canvas-board-frame').locator('.reset-zoom-button');
  await expect.poll(zoom).toBe('1');
  await expect(status(page)).toHaveText('v1');

  // The viewer zooms in; inline ↔ full screen keeps that zoom (one editor instance).
  const frame = boardWindow(page).locator('.canvas-board-frame');
  const box = await frame.boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await page.keyboard.press('ControlOrMeta+Equal');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(zoom).not.toBe('1');
  const zoomed = await zoom();
  expect(Number(zoomed)).toBeGreaterThan(1);
  expect(Number(zoomed)).toBeLessThan(2);
  await boardWindow(page).locator('.window-popout').click();
  await expect(boardWindow(page)).toHaveClass(/window-expanded/);
  await expectEditorSized(page, 0, 600);
  expect(await zoom()).toBe(zoomed);
  await expect(zoomLabel).toHaveText(`${Math.round(Number(zoomed) * 100)}%`);
  await boardWindow(page).locator('.window-popout').click();
  await expect(boardWindow(page)).not.toHaveClass(/window-expanded/);
  expect(await zoom()).toBe(zoomed);
  // Opening at 100% is not a clamp: the viewer can zoom out below it too.
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ControlOrMeta+Minus');
  await expect.poll(async () => Number(await zoom())).toBeLessThan(1);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(zoom).toBe(zoomed);

  // Editing and Save keep the viewer's zoom; the viewport is not saved.
  await drawRectangle(page);
  await expect.poll(() => count(page)).toBe(2);
  await expect(status(page)).toHaveText('Unsaved · v1');
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v2');
  expect(await zoom()).toBe(zoomed);
  const saved = tower.versionScene(board.id, 2);
  expect(saved.elements).toHaveLength(2);
  expect(saved.appState).not.toHaveProperty('zoom');
  expect(saved.appState).not.toHaveProperty('scrollX');

  // A fresh open taken straight to full screen starts at 100% too.
  await page.reload();
  await boardWindow(page).locator('.window-popout').click();
  await expect(boardWindow(page)).toHaveClass(/window-expanded/);
  await expect.poll(() => count(page)).toBe(2);
  await expectEditorSized(page, 0, 600);
  await expect(zoomLabel).toHaveText('100%');
  await expect.poll(zoom).toBe('1');
  expect(errors).toEqual([]);
});

test('stale saves keep the draft, merge brings agent work, refresh loads latest images, unsaved navigation warns, revocation purges', async ({ page, context }) => {
  test.setTimeout(150_000);
  const tower = fakeTower();
  const board = tower.createBoard('Shared', [element('seed')]);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: board.id }, title: 'Shared', layout: { x: 40, y: 40, width: 640, height: 460, z: 1 } });
  const { errors } = await openCanvas(page, context, tower, { existingBoard: { id: board.id, title: 'Shared.excalidraw' } });
  await expect.poll(() => count(page)).toBe(1);

  // Link existing board lists board Files Tower returns for the chosen scope.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  const dialog = page.locator('.canvas-add-dialog');
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await dialog.getByRole('radio', { name: 'Link existing board' }).check();
  await dialog.locator('.canvas-artifact-picker').getByLabel('Scope').selectOption({ label: 'Delivery' });
  await expect(dialog.locator('.canvas-artifact-list .canvas-artifact-title')).toHaveText(['Shared']);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // An agent saves v2 while I draw: my Save is rejected and the draft is kept.
  await drawRectangle(page);
  await expect(status(page)).toHaveText('Unsaved · v1');
  tower.agentPublish(board.id, elements => [...elements, element('agent-box', 'ellipse', { x: 400 })]);
  await menu(page, 0, 'Save board version');
  await expect(status(page)).toHaveText('Unsaved · newer v2 saved');
  await expect(boardWindow(page).locator('.canvas-board-message')).toContainText('kept as an unsaved draft');
  expect(board.versions).toHaveLength(2);
  await expect.poll(() => count(page)).toBe(2);

  // Merge (cog menu) rebases my draft onto v2 by element id; then save v3.
  await menu(page, 0, 'Merge latest');
  await expect.poll(() => count(page)).toBe(3);
  await expect(status(page)).toHaveText('Unsaved · v2');
  // A real stroke followed immediately by the floating Save is included (Save flushes the editor first).
  await drawRectangle(page, 0, -60);
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v3');
  await expectEditorSized(page);
  expect(tower.versionScene(board.id, 3).elements.filter(row => !row.isDeleted)).toHaveLength(4);
  expect(board.versions[2].created_by_actor_npub).toBe('npub1me');

  // Refresh loads a newer saved version (with an image) when there is no draft.
  tower.agentPublish(board.id, elements => [...elements, element('photo', 'image', { fileId: 'img-1', status: 'saved', x: 600, scale: [1, 1] })], { 'img-1': { id: 'img-1', mimeType: 'image/png', dataURL: PNG, created: 1 } });
  await page.reload();
  await expect(status(page)).toHaveText('v4');
  await expect.poll(() => count(page)).toBe(5);
  await expect(editorRoot(page)).toHaveAttribute('data-board-file-count', '1');

  // Unsaved navigation: the browser warns, and the draft survives a reload.
  await drawRectangle(page, 0, 120);
  await expect(status(page)).toHaveText('Unsaved · v4');
  const dialogs = [];
  page.once('dialog', async prompt => { dialogs.push(prompt.type()); await prompt.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  const reopened = await context.newPage();
  await reopened.goto(page.url());
  await expect(status(reopened)).toHaveText('Unsaved · v4');
  await expect(boardWindow(reopened).locator('.canvas-board-message')).toContainText('restored');
  await expect.poll(() => count(reopened)).toBe(6);
  expect(board.versions).toHaveLength(4);

  // Revocation: the naplet becomes the generic restricted item and the draft is purged.
  tower.state.revoked = true;
  await reopened.locator('.canvas-toolbar').getByRole('button', { name: 'Refresh' }).click();
  await expect(reopened.locator('.canvas-naplet strong').first()).toHaveText('Restricted item');
  await expect(reopened.locator('.canvas-board')).toHaveCount(0);
  await expect(reopened.locator('body')).not.toContainText('Shared');
  await expect.poll(() => reopened.evaluate(async () => {
    const names = (await indexedDB.databases()).map(row => row.name).filter(name => name?.includes('fd') || name?.includes('workspace'));
    let drafts = 0;
    for (const name of names) {
      const db = await new Promise(resolve => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(null); });
      if (db?.objectStoreNames.contains('canvas_board_drafts')) drafts += await new Promise(resolve => { const request = db.transaction('canvas_board_drafts').objectStore('canvas_board_drafts').count(); request.onsuccess = () => resolve(request.result); });
      db?.close();
    }
    return drafts;
  })).toBe(0);
  expect(errors).toEqual([]);
});


test('board Rename validates, cancels, reports failure and persists canonical titles without touching scenes', async ({ page, context }) => {
  const tower = fakeTower();
  const file = tower.createBoard('Original', [element('kept')]);
  const layout = { x: 50, y: 50, width: 650, height: 450, z: 1 };
  tower.state.naplets = [0, 1].map(i => ({ id: uid(), source: { type: 'excalidraw', id: file.id }, title: 'Legacy override', layout: { ...layout, x: 50 + i * 680 } }));
  const original = JSON.stringify(file);
  const scene = tower.versionScene(file.id, 1);
  const ids = tower.state.naplets.map(row => row.id);
  await openCanvas(page, context, tower);
  const rename = async () => {
    await boardWindow(page).getByRole('button', { name: 'Window options', exact: true }).click();
    await boardWindow(page).getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  };
  await expect(boardWindow(page).locator('header strong')).toHaveText('Original.excalidraw');
  await rename();
  const dialog = page.getByRole('dialog', { name: 'Rename board', exact: true });
  const input = dialog.getByRole('textbox', { name: 'Board name' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Original.excalidraw');
  await input.fill('Cancel this');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(boardWindow(page).getByRole('button', { name: 'Window options', exact: true })).toBeFocused();
  await rename(); await input.fill('Escape this'); await input.press('Escape');
  expect(JSON.stringify(file)).toBe(original);
  await rename(); await input.fill('   '); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a board name');
  expect(JSON.stringify(file)).toBe(original);
  tower.state.renameError = true;
  await input.fill('Planning'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('cannot rename');
  await expect(dialog).toBeVisible(); expect(JSON.stringify(file)).toBe(original);
  tower.state.renameError = false;
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.canvas-naplet header strong')).toHaveText(['Planning', 'Planning']);
  await expect(page.getByRole('dialog', { name: 'Planning', exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.canvas-naplet header strong')).toHaveText(['Planning', 'Planning']);
  expect(file.versions).toHaveLength(1);
  expect(tower.versionScene(file.id, 1)).toEqual(scene);
  expect(tower.state.naplets.map(row => row.id)).toEqual(ids);
  expect(file.id).toBe(JSON.parse(original).id);
  tower.state.readOnly = true; await page.reload();
  await boardWindow(page).getByRole('button', { name: 'Window options', exact: true }).click();
  await expect(boardWindow(page).getByRole('menuitem', { name: 'Rename…', exact: true })).not.toBeVisible();
});

test('phone: floating Save sits in Excalidraw top-right without covering tools and saves an immediate stroke inline and full screen', async ({ page, context }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const tower = fakeTower();
  const board = tower.createBoard('Phone', [element('seed')]);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: board.id }, title: 'Phone', layout: { x: 10, y: 10, width: 360, height: 520, z: 1 } });
  const { errors } = await openCanvas(page, context, tower, { existingBoard: { id: board.id, title: 'Phone.excalidraw' } });
  await expect.poll(() => count(page)).toBe(1);
  const frame = boardWindow(page).frameLocator('.canvas-board-frame');
  const layout = () => frame.locator('body').evaluate(() => {
    const save = document.querySelector('.wingman-board-action')?.getBoundingClientRect();
    const tools = [...document.querySelectorAll('.App-toolbar button, .App-toolbar label, .App-toolbar .ToolIcon, .mobile-misc-tools-container button, .dropdown-menu-button, .main-menu-trigger')]
      .map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    const overlaps = tools.filter(rect => save && rect.left < save.right && save.left < rect.right && rect.top < save.bottom && save.top < rect.bottom).length;
    return { save: save && { left: save.left, right: save.right, top: save.top, bottom: save.bottom }, width: innerWidth, tools: tools.length, overlaps };
  });
  // Real pointer stroke, then Save at once: the pending stroke is flushed into v2.
  const stroke = async offset => {
    const box = await boardWindow(page).locator('.canvas-board-frame').boundingBox();
    const x = box.x + box.width / 2 - 60 + offset, y = box.y + box.height / 2 - 30 + offset;
    await page.mouse.click(x - 20, y + 120);
    await page.keyboard.press('r');
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 50, { steps: 5 }); await page.mouse.up();
  };
  for (const [mode, expectedVersion] of [['inline', 2], ['expanded', 3]]) {
    if (mode === 'expanded') {
      await boardWindow(page).locator('.window-popout').click();
      await expect(boardWindow(page)).toHaveClass(/window-expanded/);
      await expectEditorSized(page, 0, 600);
    }
    await expect(floatingSave(page)).toHaveText('Saved');
    const geometry = await layout();
    expect(geometry.tools).toBeGreaterThan(3);
    expect(geometry.overlaps).toBe(0);
    expect(geometry.save.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.save.top).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath(`phone-${mode}.png`) });
    const before = await count(page);
    await stroke(mode === 'inline' ? 0 : 40);
    await floatingSave(page).click();
    await expect(status(page)).toHaveText(`v${expectedVersion}`);
    expect(tower.versionScene(board.id, expectedVersion).elements.filter(row => !row.isDeleted)).toHaveLength(before + 1);
    console.log('CANVAS_BOARD_PHONE_SAVE', JSON.stringify({ mode, ...geometry, version: expectedVersion }));
  }
  // One editor instance: full screen reused the inline iframe.
  await expect(page.locator('.canvas-board-frame')).toHaveCount(1);
  // CAS: someone saves meanwhile; my immediate Save is refused and the draft is kept.
  tower.agentPublish(board.id, elements => [...elements, element('agent-phone', 'ellipse', { x: 300 })]);
  await stroke(-40);
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('Unsaved · newer v4 saved');
  expect(board.versions).toHaveLength(4);
  await expect(boardWindow(page).locator('.canvas-board-message')).toContainText('kept as an unsaved draft');
  expect(errors).toEqual([]);
});

test('spatial pins, safe text, replies, resolve and shape following survive saves and reload', async ({ page, context }) => {
  test.setTimeout(45000);
  const tower = fakeTower();
  const file = tower.createBoard('Discussion', [element('discussion-shape')]);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: file.id }, title: 'Discussion', layout: { x: 40, y: 60, width: 1000, height: 700, z: 1 } });
  const { errors } = await openCanvas(page, context, tower);
  const editor = editorRoot(page);
  await expect(editor).toHaveAttribute('data-board-readonly', 'false');
  await expect(editor).toHaveAttribute('data-board-zoom', '1');
  await editor.getByRole('button', { name: 'Comments (0)', exact: true }).click();
  await editor.getByRole('button', { name: 'Add comment', exact: true }).click();
  // The single shape is centred at 100%; attach in its centre.
  const frame = await boardWindow(page).locator('.canvas-board-frame').boundingBox();
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await editor.getByRole('textbox', { name: 'Comment', exact: true }).fill('<img src=x onerror=alert(1)> Question');
  await editor.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(editor.locator('.board-comment-pin')).toHaveCount(1);
  await expect(editor.locator('.board-comment-messages')).toContainText('<img src=x onerror=alert(1)> Question');
  await expect(editor.locator('.board-comment-messages img')).toHaveCount(0);
  await editor.getByRole('textbox', { name: 'Reply', exact: true }).fill('A threaded answer');
  await editor.getByRole('button', { name: 'Add reply', exact: true }).click();
  await expect(editor.locator('.board-comment-messages article')).toHaveCount(2);
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v2');
  const saved = tower.versionScene(file.id, 2);
  expect(saved.elements).toHaveLength(1);
  expect(saved.wingman.comments[0].anchor.element_id).toBe('discussion-shape');
  expect(saved.wingman.comments[0].messages[1].body).toBe('A threaded answer');
  // Resolve, hide, reveal and reopen through the thread.
  await editor.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(editor.locator('.board-comment-pin')).toHaveCount(0);
  await editor.getByLabel('Show resolved').check();
  await expect(editor.locator('.board-comment-pin')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Reopen', exact: true }).click();
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v3');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  const dragPin = await editor.locator('.board-comment-pin').boundingBox();
  await page.mouse.move(dragPin.x + 15 - 60, dragPin.y + 15);
  await page.mouse.down();
  await page.mouse.move(dragPin.x + 15 + 20, dragPin.y + 15 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await editor.locator('.board-comment-pin').boundingBox()).x - dragPin.x).toBeCloseTo(80, 0);
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v4');
  await page.reload();
  await expect(editor.locator('.board-comment-pin')).toHaveCount(1);
  // Agent movement gets loaded; pin follows its shape in the drawing coordinate space.
  tower.agentPublish(file.id, rows => rows.map(e => ({ ...e, x: e.x + 150, y: e.y + 60, version: e.version + 1 })));
  await menu(page, 0, 'Load latest saved version');
  await expect(status(page)).toHaveText('v5');
  await expect(editor.locator('.board-comment-pin')).toHaveCount(1);
  tower.agentPublish(file.id, rows => rows.map(e => ({ ...e, isDeleted: true, version: e.version + 1 })));
  await menu(page, 0, 'Load latest saved version');
  await expect(status(page)).toHaveText('v6');
  await expect(editor.locator('.board-comment-pin')).toHaveAttribute('title', 'Shape removed; last location retained');
  await editor.locator('.board-comment-pin').click();
  await expect(editor.locator('.board-comment-messages article')).toHaveCount(2);
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`discussion in fullscreen at ${width}px: point pins, pan/zoom, read-only and revocation`, async ({ page, context }) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width, height: 900 });
  const tower = fakeTower();
  const file = tower.createBoard('Point discussion', []);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: file.id }, title: 'Point discussion', layout: { x: 10, y: 60, width: 700, height: 650, z: 1 } });
  await openCanvas(page, context, tower);
  await boardWindow(page).locator('.window-popout').click();
  const editor = editorRoot(page);
  await expect(editor).toHaveAttribute('data-board-readonly', 'false');
  await expect(editor).toHaveAttribute('data-board-zoom', '1');
  await editor.getByRole('button', { name: 'Comments (0)', exact: true }).click();
  await editor.getByRole('button', { name: 'Add comment', exact: true }).click();
  const frame = await boardWindow(page).locator('.canvas-board-frame').boundingBox();
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await editor.getByRole('textbox', { name: 'Comment', exact: true }).fill('Point thread');
  await editor.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(editor.locator('.board-comment-pin')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(floatingSave(page)).toHaveCount(1);
  await floatingSave(page).click();
  await expect(status(page)).toHaveText('v2');
  expect(tower.versionScene(file.id, 2).wingman.comments[0].anchor.element_id).toBeUndefined();
  const pin = editor.locator('.board-comment-pin');
  const before = await pin.boundingBox();
  await page.mouse.move(frame.x + frame.width / 2 - 80, frame.y + frame.height / 2 + 80);
  await page.mouse.wheel(0, 80);
  await expect.poll(async () => Math.abs((await pin.boundingBox()).y - before.y)).toBeGreaterThan(20);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await expect.poll(() => editor.getAttribute('data-board-zoom')).not.toBe('1');
  await pin.click();
  await editor.getByRole('textbox', { name: 'Reply', exact: true }).fill('Unsent private draft');
  tower.state.readOnly = true;
  await menu(page, 0, 'Load latest saved version');
  // Snapshot refresh updates can_write, independently of scene history.
  await boardWindow(page).locator('.window-popout').click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(editor).toHaveAttribute('data-board-readonly', 'true');
  await boardWindow(page).locator('.window-popout').click();
  await pin.click();
  await expect(editor.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('textbox')).toHaveCount(0);
  tower.state.revoked = true;
  await boardWindow(page).locator('.window-popout').click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(boardWindow(page)).toHaveCount(0);
  await expect(page.getByText('Unsent private draft')).toHaveCount(0);
});
