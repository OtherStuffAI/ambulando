const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const crypto = require('node:crypto');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

const workspaceId = '20000000-0000-4000-8000-000000000071';
const canvasId = '30000000-0000-4000-8000-000000000072';
const channelId = '50000000-0000-4000-8000-000000000073';
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
  const state = { naplets: [], revoked: false, canvasRow: 1 };
  const addVersion = (file, bytes, author, summary = null) => {
    const objectId = uid(); objects.set(objectId, Buffer.from(bytes));
    const version = { id: uid(), version_number: file.versions.length + 1, storage_object_id: objectId, sha256_hex: sha(bytes), size_bytes: bytes.length, content_type: CONTENT_TYPE, created_by_actor_npub: author, summary, created_at: new Date(Date.UTC(2026, 9, 21, 6, file.versions.length)).toISOString() };
    file.versions.push(version); file.current_version_id = version.id;
    return version;
  };
  const sceneBytes = elements => Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }));
  const meta = file => { const current = file.versions.at(-1); return { file_id: file.id, current_version_id: current.id, current_version_number: current.version_number, content_type: CONTENT_TYPE, size_bytes: current.size_bytes, sha256: current.sha256_hex, can_write: true }; };
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
      if (suffix === `/channels/${channelId}/files` && method === 'POST') {
        const file = { id: uid(), channel_id: channelId, display_name: body.display_name, versions: [] };
        files.set(file.id, file);
        const bytes = objects.get(body.storage_object_id); const version = addVersion(file, bytes, 'npub1me');
        return json({ file: { id: file.id, current_version_id: version.id } }, 201);
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
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Saved');
  await expect(boardWindow(page).locator('.canvas-board-version')).toHaveText('Latest · v1');
  await expect(editorRoot(page)).toHaveAttribute('data-board-readonly', 'false');
  await expectEditorSized(page);

  // Inline drawing makes an unsaved local draft; nothing is published.
  await drawRectangle(page);
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Unsaved changes');
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
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Saved');
  await expect(boardWindow(page).locator('.canvas-board-version')).toHaveText('Latest · v2');
  expect(board.versions.map(row => row.version_number)).toEqual([1, 2]);
  expect(board.versions[1].summary).toBe('Two lanes');

  // Link existing board: a second naplet references the same canonical board.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await dialog.getByRole('radio', { name: 'Link existing board' }).check();
  await dialog.locator('.canvas-source-list button', { hasText: 'Release plan' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.canvas-board')).toHaveCount(2);
  expect(tower.files.size).toBe(1);
  expect(tower.state.naplets.map(row => row.source.id)).toEqual([board.id, board.id]);
  await expect.poll(() => count(page, 1)).toBe(2);
  await expect(boardWindow(page, 1).locator('.canvas-board-version')).toHaveText('Latest · v2');

  // Both naplets share one draft: drawing in one marks both unsaved.
  await drawRectangle(page, 1, 40);
  await expect.poll(() => count(page, 0)).toBe(3);
  await expect(boardWindow(page, 0).locator('.canvas-board-status')).toHaveText('Unsaved changes');
  page.once('dialog', prompt => prompt.accept());
  await menu(page, 1, 'Discard unsaved changes');
  await expect(boardWindow(page, 0).locator('.canvas-board-status')).toHaveText('Saved');
  await expect.poll(() => count(page, 0)).toBe(2);

  // History (on the top naplet, which overlaps the first): the version list and notices take space but the editor keeps its height.
  await boardWindow(page, 1).getByRole('button', { name: 'Version history' }).click();
  await expect(boardWindow(page, 1).locator('.canvas-board-history li button')).toHaveCount(2);
  await expect(boardWindow(page, 1).locator('.canvas-board-history')).toContainText('Two lanes');
  await expectEditorSized(page, 1, 120);
  await boardWindow(page, 1).getByRole('button', { name: 'Version history' }).click();
  await boardWindow(page, 1).getByRole('button', { name: 'Older version' }).click();
  await expect(boardWindow(page, 1).locator('.canvas-board-version')).toHaveText('Viewing v1');
  await expect(editorRoot(page, 1)).toHaveAttribute('data-board-readonly', 'true');
  await expect.poll(() => count(page, 1)).toBe(0);
  await boardWindow(page, 1).getByRole('button', { name: 'Return to latest' }).click();
  await expect.poll(() => count(page, 1)).toBe(2);
  await expect(editorRoot(page, 1)).toHaveAttribute('data-board-readonly', 'false');
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('canvas-excalidraw-boards.png') });
});

test('stale saves keep the draft, merge brings agent work, refresh loads latest images, unsaved navigation warns, revocation purges', async ({ page, context }) => {
  test.setTimeout(150_000);
  const tower = fakeTower();
  const board = tower.createBoard('Shared', [element('seed')]);
  tower.state.naplets.push({ id: uid(), source: { type: 'excalidraw', id: board.id }, title: 'Shared', layout: { x: 40, y: 40, width: 640, height: 460, z: 1 } });
  const { errors } = await openCanvas(page, context, tower, { existingBoard: { id: board.id, title: 'Shared.excalidraw' } });
  await expect.poll(() => count(page)).toBe(1);

  // Link existing board is offered from cached board Files.
  await page.getByRole('button', { name: 'Add naplet' }).click();
  const dialog = page.locator('.canvas-add-dialog');
  await dialog.getByLabel('Type').selectOption('excalidraw');
  await dialog.getByRole('radio', { name: 'Link existing board' }).check();
  await expect(dialog.locator('.canvas-source-list button')).toHaveText(['Shared']);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // An agent saves v2 while I draw: my Save is rejected and the draft is kept.
  await drawRectangle(page);
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Unsaved changes');
  tower.agentPublish(board.id, elements => [...elements, element('agent-box', 'ellipse', { x: 400 })]);
  await menu(page, 0, 'Save board version');
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Newer version saved');
  await expect(boardWindow(page).locator('.canvas-board-message')).toContainText('kept as an unsaved draft');
  expect(board.versions).toHaveLength(2);
  await expect.poll(() => count(page)).toBe(2);

  // Merge rebases my draft onto v2 by element id; then save v3.
  await boardWindow(page).getByRole('button', { name: 'Merge latest' }).click();
  await expect.poll(() => count(page)).toBe(3);
  await expect(boardWindow(page).locator('.canvas-board-version')).toHaveText('Latest · v2');
  // A stroke followed immediately by Save is included (Save flushes the editor first).
  await drawRectangle(page, 0, -60);
  await boardWindow(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(boardWindow(page).locator('.canvas-board-version')).toHaveText('Latest · v3');
  await expectEditorSized(page);
  expect(tower.versionScene(board.id, 3).elements.filter(row => !row.isDeleted)).toHaveLength(4);
  expect(board.versions[2].created_by_actor_npub).toBe('npub1me');

  // Refresh loads a newer saved version (with an image) when there is no draft.
  tower.agentPublish(board.id, elements => [...elements, element('photo', 'image', { fileId: 'img-1', status: 'saved', x: 600, scale: [1, 1] })], { 'img-1': { id: 'img-1', mimeType: 'image/png', dataURL: PNG, created: 1 } });
  await page.reload();
  await expect(boardWindow(page).locator('.canvas-board-version')).toHaveText('Latest · v4');
  await expect.poll(() => count(page)).toBe(5);
  await expect(editorRoot(page)).toHaveAttribute('data-board-file-count', '1');

  // Unsaved navigation: the browser warns, and the draft survives a reload.
  await drawRectangle(page, 0, 120);
  await expect(boardWindow(page).locator('.canvas-board-status')).toHaveText('Unsaved changes');
  const dialogs = [];
  page.once('dialog', async prompt => { dialogs.push(prompt.type()); await prompt.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  const reopened = await context.newPage();
  await reopened.goto(page.url());
  await expect(boardWindow(reopened).locator('.canvas-board-status')).toHaveText('Unsaved changes');
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
