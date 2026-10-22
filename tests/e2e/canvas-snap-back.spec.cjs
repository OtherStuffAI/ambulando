const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
const workspaceId = '20000000-0000-4000-8000-000000000081';
const canvasId = '30000000-0000-4000-8000-000000000082';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) }, stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js'; export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js'; export { normalizeWorkspaceEntry } from './src/workspaces.js';` } })).outputFiles[0].text;
});
async function fixture(page, context) {
  const state = {
    canvas: { id: canvasId, title: 'Timing map', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace' }, viewport: { x: 0, y: 0, scale: 1 } },
    naplets: ['a', 'b'].map((id, i) => ({ id, access: 'ready', row_version: 1, title: `List ${id}`, source: { type: 'task_list', id: `channel-${id}` }, content: { tasks: [] }, layout: { x: 30 + i * 400, y: 40, width: 320, height: 220, z: i + 1 } })),
    elements: [{ id: 'c', kind: 'text', row_version: 1, data: { text: 'Original' }, layout: { x: 850, y: 40, width: 150, height: 100, z: 3 } }],
    writes: [], hold: false, release: null, fail: false,
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    if (!url.pathname.startsWith('/api/')) return serveBuiltFlightDeck(route);
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}`;
    expect(request.headers().authorization).toMatch(/^Nostr /);
    if (url.pathname === `${root}/snapshot`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvas: state.canvas, naplets: state.naplets, elements: state.elements, comments: [] }) });
    if (request.method() === 'PATCH' && url.pathname.startsWith(root)) {
      const body = request.postDataJSON(), target = url.pathname === root ? state.canvas : state.naplets.find(row => url.pathname.endsWith(`/naplets/${row.id}`)) || state.elements.find(row => url.pathname.endsWith(`/elements/${row.id}`));
      state.writes.push({ path: url.pathname, body });
      if (state.hold) { state.hold = false; await new Promise(resolve => { state.release = resolve; }); }
      if (state.fail) { state.fail = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Injected layout conflict' }) }); }
      if (!target || target.access === 'denied') return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      expect(body.expected_row_version).toBe(target.row_version);
      Object.assign(target, body.layout ? { layout: body.layout } : {}, body.viewport ? { viewport: body.viewport } : {}, body.data ? { data: body.data } : {}); target.row_version++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: state.canvas, naplet: target }) });
    }
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/__seed.html');
  const key = await page.evaluate(async ({ workspaceId, identity }) => {
    const m = await import('/__seed.js'), event = await m.signLoginEvent('ephemeral'), npub = await m.pubkeyToNpub(event.pubkey);
    const workspace = m.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'actor-me', npub }, identity }, pgDescriptor: { identity } });
    await m.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = m.createWorkspaceDb(workspace.workspaceKey); await db.open(); db.close(); return workspace.workspaceKey;
  }, { workspaceId, identity });
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(key)}&canvasid=${canvasId}`);
  await expect(page.locator('.canvas-toolbar h1')).toHaveText('Timing map');
  return state;
}
// Inject a full materialized snapshot via Dexie, exercising the actual liveQuery
// subscriber (including unrelated rows), independently of the held HTTP write.
async function snapshot(page, edit = {}) {
  await page.evaluate(async edit => {
    const m = await import('/__seed.js'), s = Alpine.store('canvas'), db = m.createWorkspaceDb(s.currentWorkspaceKey); await db.open();
    const row = (await db.canvas_snapshots.toArray())[0];
    row.request_id = crypto.randomUUID(); row.canvas.title = edit.title || row.canvas.title;
    if (edit.elementText) { row.elements[0].data.text = edit.elementText; row.elements[0].row_version++; }
    if (edit.z) { const n = row.naplets.find(n => n.id === 'a'); n.layout.z = edit.z; n.row_version++; }
    if (edit.otherTitle) row.naplets.find(n => n.id === 'b').title = edit.otherTitle;
    if (edit.remove) row.naplets = row.naplets.filter(n => n.id !== edit.remove);
    if (edit.deny) row.naplets = row.naplets.map(n => n.id === edit.deny ? { id: n.id, layout: n.layout, access: 'denied', row_version: n.row_version } : n);
    await db.canvas_snapshots.put(row); db.close();
  }, edit);
  await expect.poll(() => page.evaluate(() => Alpine.store('canvas').canvas.title)).toBe(edit.title || 'Timing map');
}
async function gesture(page, type, ids, dx, dy, finish = true) {
  await page.evaluate(({ type, ids, dx, dy, finish }) => {
    const s = Alpine.store('canvas');
    s.selectedKeys = ids.map(id => id.includes(':') ? id : `naplet:${id}`);
    s.startItemInteraction('naplet', s.naplets.find(n => n.id === ids[0]), { button: 0, pointerId: 99, clientX: 0, clientY: 0, stopPropagation() {}, currentTarget: {} }, type);
    s.movePointer({ pointerId: 99, clientX: dx, clientY: dy });
    if (finish) { window.pendingGesture = s.endPointer({ pointerId: 99 }); }
  }, { type, ids, dx, dy, finish });
}
const layout = page => page.evaluate(() => Alpine.store('canvas').naplets.map(n => ({ ...n.layout })));
async function idle(page) { await expect.poll(() => page.evaluate(() => !Alpine.store('canvas').saving && !Alpine.store('canvas').viewportSaving)).toBe(true); }

test('overlapping resize saves keep the latest geometry through full snapshots and reload; undo/redo survives', async ({ page, context }) => {
  const state = await fixture(page, context); state.hold = true;
  await gesture(page, 'resize', ['a'], 60, 30);
  await expect.poll(() => !!state.release).toBe(true);
  await gesture(page, 'resize', ['a'], 70, 40);
  await snapshot(page, { title: 'Remote title during save', otherTitle: 'Unrelated live source' });
  expect(await page.evaluate(() => Alpine.store('canvas').naplets[1].title)).toBe('Unrelated live source');
  expect((await layout(page))[0]).toMatchObject({ width: 450, height: 290 });
  state.release(); await idle(page);
  expect(state.writes).toHaveLength(2);
  expect(state.naplets[0].layout).toMatchObject({ width: 450, height: 290 });
  await page.evaluate(() => Alpine.store('canvas').undoChange());
  expect((await layout(page))[0]).toMatchObject({ width: 380, height: 250 });
  await page.evaluate(() => Alpine.store('canvas').redoChange());
  expect((await layout(page))[0]).toMatchObject({ width: 450, height: 290 });
  await page.reload(); await expect(page.locator('.canvas-toolbar h1')).toHaveText('Timing map');
  expect((await layout(page))[0]).toMatchObject({ width: 450, height: 290 });
});

test('an in-progress group gesture rebinds rows across snapshots and saves every member', async ({ page, context }) => {
  const state = await fixture(page, context);
  await gesture(page, 'move', ['a', 'b', 'element:c'], 40, 20, false);
  state.naplets[0].layout.z = 9; state.naplets[0].row_version++;
  state.elements[0].data.text = 'Updated by collaborator'; state.elements[0].row_version++;
  await snapshot(page, { title: 'Updated while dragging', z: 9, elementText: 'Updated by collaborator' });
  expect((await layout(page)).map(n => n.x)).toEqual([70, 470]);
  expect(await page.evaluate(() => Alpine.store('canvas').elements[0].data.text)).toBe('Updated by collaborator');
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.movePointer({ pointerId: 99, clientX: 90, clientY: 50 }); window.pendingGesture = s.endPointer({ pointerId: 99 }); });
  await idle(page);
  expect(state.naplets.map(n => n.layout.x)).toEqual([120, 520]);
  expect((await layout(page)).map(n => n.x)).toEqual([120, 520]);
  await page.evaluate(() => Alpine.store('canvas').undoChange());
  expect((await layout(page)).map(n => n.x)).toEqual([30, 430]);
  expect((await layout(page))[0].z).toBe(9);
  await page.evaluate(() => Alpine.store('canvas').redoChange());
  expect((await layout(page))[0].z).toBe(9);
  expect(state.elements[0].data.text).toBe('Updated by collaborator');
  await page.reload(); await expect(page.locator('.canvas-toolbar h1')).toHaveText('Timing map');
  expect((await layout(page)).map(n => n.x)).toEqual([120, 520]);
});

test('pan and zoom made during delayed viewport saves persist the final view, including the debounce window', async ({ page, context }) => {
  const state = await fixture(page, context); state.hold = true;
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.viewport = { x: 80, y: 30, scale: 1 }; window.firstView = s.saveViewport(); });
  await expect.poll(() => !!state.release).toBe(true);
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.viewport = { x: 180, y: 90, scale: 1.4 }; window.secondView = s.saveViewport(); });
  await snapshot(page, { title: 'Changed title' });
  expect(await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }))).toEqual({ x: 180, y: 90, scale: 1.4 });
  state.release(); await idle(page);
  expect(state.writes).toHaveLength(2);
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.viewport = { x: 200, y: 100, scale: 1.5 }; s.queueViewportSave(); });
  await snapshot(page, { title: 'Still current during debounce' });
  expect(await page.evaluate(() => Alpine.store('canvas').viewport.x)).toBe(200);
  await expect.poll(() => state.canvas.viewport.scale).toBe(1.5); await idle(page);
  await page.reload(); await expect(page.locator('.canvas-toolbar h1')).toHaveText('Timing map');
  expect(await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }))).toEqual({ x: 200, y: 100, scale: 1.5 });
});

test('failed saves report errors, reconcile authoritative geometry and allow a later gesture', async ({ page, context }) => {
  const state = await fixture(page, context); state.fail = true;
  await gesture(page, 'resize', ['a'], 60, 30); await idle(page);
  await expect.poll(() => page.evaluate(() => Alpine.store('canvas').error)).toContain('Injected layout conflict');
  expect((await layout(page))[0]).toMatchObject({ width: 320, height: 220 });
  expect(await page.evaluate(() => Alpine.store('canvas').canUndo)).toBe(false);
  await gesture(page, 'resize', ['a'], 80, 50); await idle(page);
  expect(state.naplets[0].layout).toMatchObject({ width: 400, height: 270 });
  state.fail = true;
  await page.evaluate(() => Alpine.store('canvas').undoChange());
  expect((await layout(page))[0]).toMatchObject({ width: 400, height: 270 });
  expect(await page.evaluate(() => Alpine.store('canvas').canUndo)).toBe(true);
  expect(await page.evaluate(() => Alpine.store('canvas').canRedo)).toBe(false);
  await page.evaluate(() => Alpine.store('canvas').undoChange());
  expect((await layout(page))[0]).toMatchObject({ width: 320, height: 220 });
  await page.evaluate(() => Alpine.store('canvas').redoChange());
  expect((await layout(page))[0]).toMatchObject({ width: 400, height: 270 });
  state.fail = true;
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.viewport.x = 999; return s.saveViewport(); });
  expect(await page.evaluate(() => Alpine.store('canvas').viewport.x)).toBe(0);
  expect(await page.evaluate(() => Alpine.store('canvas').error)).toContain('Injected layout conflict');
});

test('deletions and access revocation remain authoritative during active gestures', async ({ page, context }) => {
  const state = await fixture(page, context);
  await gesture(page, 'resize', ['a'], 100, 100, false);
  await snapshot(page, { title: 'Restricted now', deny: 'a' });
  await expect.poll(() => page.evaluate(() => Alpine.store('canvas').naplets[0].access)).toBe('denied');
  await page.evaluate(() => Alpine.store('canvas').endPointer({ pointerId: 99 }));
  expect(state.writes).toHaveLength(0);
  await gesture(page, 'move', ['b'], 50, 30, false);
  await snapshot(page, { title: 'Removed now', remove: 'b' });
  await expect.poll(() => page.evaluate(() => Alpine.store('canvas').naplets.length)).toBe(1);
  await page.evaluate(() => Alpine.store('canvas').endPointer({ pointerId: 99 }));
  expect(state.writes).toHaveLength(0);
});

test('real mouse resize stays under the pointer when an earlier delayed save completes mid-gesture', async ({ page, context }) => {
  const state = await fixture(page, context); state.hold = true;
  const naplet = page.locator('[data-canvas-key="naplet:a"]');
  await naplet.locator('header').click();
  const handle = naplet.getByRole('button', { name: 'Resize naplet', exact: true });
  let box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 20); await page.mouse.up();
  await expect.poll(() => !!state.release).toBe(true);
  box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 40);
  await snapshot(page, { title: 'Concurrent update' });
  state.release();
  await expect.poll(() => state.naplets[0].layout.width).toBe(370);
  await page.waitForTimeout(1100);
  expect((await layout(page))[0]).toMatchObject({ width: 440, height: 280 });
  await page.mouse.move(x + 90, y + 60); await page.mouse.up(); await idle(page);
  expect(state.naplets[0].layout).toMatchObject({ width: 460, height: 300 });
  await page.reload(); await expect(page.locator('.canvas-toolbar h1')).toHaveText('Timing map');
  expect((await layout(page))[0]).toMatchObject({ width: 460, height: 300 });
});
