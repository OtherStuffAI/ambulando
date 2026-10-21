const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: true });
const workspaceId = '20000000-0000-4000-8000-000000000002';
const ids = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003'];
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js'; export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js'; export { normalizeWorkspaceEntry } from './src/workspaces.js';` }
  })).outputFiles[0].text;
});
async function seedSessionAndWorkspace(page) {
  await page.goto('/__canvas-seed.html');
  return page.evaluate(async ({ workspaceId, identity }) => {
    const module = await import('/__canvas-seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({
      workspaceId,
      workspaceOwnerNpub: npub,
      pgSessionNpub: npub,
      directHttpsUrl: 'http://127.0.0.1:3100',
      appNpub: identity.app_npub,
      towerServiceNpub: identity.tower_service_npub,
      workspaceServiceNpub: identity.workspace_service_npub,
      pgBackendMode: true,
      pgMe: { actor: { actor_id: 'actor-reader', npub }, identity },
      pgDescriptor: { identity },
    });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = module.createWorkspaceDb(workspace.workspaceKey);
    await db.open();
    await Promise.all([
      db.documents.put({ record_id: 'doc-2', title: 'New reference', record_state: 'active' }),
      db.channels.put({ record_id: 'scope-2', name: 'Delivery', record_state: 'active' }),
      db.chat_messages.put({ record_id: 'thread-2', title: 'Launch discussion', pg_record_type: 'thread', record_state: 'active' }),
      db.documents.put({ record_id: 'file-2', title: 'Interactive report', pg_record_type: 'file', pg_storage_version_id: 'package-2', content_type: 'text/html', record_state: 'active' }),
    ]);
    db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity });
}


for (const width of [1440, 390]) test(`Canvas Link picker, persistence, browser history and access ${width}px`, async ({ page, context }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width, height: 900 });
  const requests = [], writes = [];
  let unavailable = false, denied = false, listFailure = false;
  const definition = id => ({ id, title: ['Overview', 'Detail B', 'Detail C'][ids.indexOf(id)], row_version: 1, position: ids.indexOf(id) + 1, can_manage: true, viewport: { x: 0, y: 0, scale: 1 }, visibility: { mode: 'workspace' } });
  const rows = Object.fromEntries(ids.map(id => [id, []]));
  const sourcePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<title>Seed</title>' });
    if (!url.pathname.startsWith(sourcePath)) return process.env.SOL_RUNTIME_ASSETS === '1' ? route.continue() : serveBuiltFlightDeck(route);
    expect(request.headers().authorization).toMatch(/^Nostr /);
    requests.push(url.pathname);
    const parts = url.pathname.slice(sourcePath.length).split('/').filter(Boolean), id = parts[0];
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (!id) return listFailure ? route.fulfill({ status: 503, body: '{}' }) : json({ workspace_id: workspaceId, identity, complete: true, canvases: ids.map(definition) });
    if (request.method() === 'GET' && parts[1] === 'snapshot') {
      if (unavailable && id === ids[1]) return route.fulfill({ status: 404, body: '{}' });
      return json({ workspace_id: workspaceId, identity, complete: true, canvas: definition(id), naplets: rows[id].map(row => denied ? { ...row, access: 'denied', title: 'Protected destination', content: { title: 'Protected destination', thumbnail: 'secret.png' } } : row), elements: [], comments: [] });
    }
    const body = request.postDataJSON(); writes.push(body);
    if (request.method() === 'POST' && parts[1] === 'naplets') {
      expect(body.source.type).toBe('canvas'); expect(body.source.id).not.toBe(id);
      const row = { id: `link-${rows[id].length}`, access: 'ready', source: body.source, title: body.title || definition(body.source.id).title, content: { title: definition(body.source.id).title }, layout: body.layout, row_version: 1 };
      rows[id].push(row); return json({ naplet: row });
    }
    if (request.method() === 'PATCH' && parts[1] === 'naplets') { const row = rows[id].find(row => row.id === parts[2]); row.layout = body.layout; row.row_version++; return json({ naplet: row }); }
    return json({});
  });
  const key = await seedSessionAndWorkspace(page);
  const url = id => '/canvas.html?' + new URLSearchParams({ workspacekey: key, canvasid: id });
  const open = page.getByRole('link', { name: 'Open canvas', exact: true });
  const add = async (title, label = '') => {
    await page.getByRole('button', { name: 'Add naplet', exact: true }).click();
    const dialog = page.locator('.canvas-add-dialog');
    await dialog.locator('select').first().selectOption('canvas');
    await expect(dialog.getByRole('button', { name: definition(new URL(page.url()).searchParams.get('canvasid')).title, exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: title, exact: true }).click();
    await dialog.getByLabel('Label (optional)').fill(label);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  };
  await page.goto(url(ids[0])); await expect(page.locator('.canvas-brand h1')).toContainText('Overview');
  await add('Detail B', 'Work detail');
  await expect(page.locator('.canvas-naplet-header')).toContainText('Work detail');
  await expect(page.locator('.canvas-link-card h2')).toHaveText('Detail B');
  await expect(page.locator('.canvas-link-card img, .canvas-link-card iframe')).toHaveCount(0);
  await page.reload(); await expect(open).toBeVisible();
  expect(rows[ids[0]][0].title).toBe('Work detail');
  expect(writes[0]).toMatchObject({ source: { type: 'canvas', id: ids[1] }, title: 'Work detail' });
  // No destination read, subscription, recursive canvas load or preview capture.
  expect(requests.filter(p => p.endsWith('/snapshot')).every(p => p.includes(ids[0]))).toBe(true);
  const naplet = page.locator('.canvas-naplet').first();
  const heading = naplet.locator('.canvas-naplet-header');
  let box = await heading.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 15); await page.mouse.down(); await page.mouse.move(box.x + 34, box.y + 28); await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(ids[0]));
  const resize = naplet.getByRole('button', { name: 'Resize naplet', exact: true });
  box = await resize.boundingBox(); await page.mouse.move(box.x + 8, box.y + 8); await page.mouse.down(); await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(ids[0]));
  if (width === 390) await open.tap(); else await open.click();
  await expect(page).toHaveURL(new RegExp(ids[1]));
  await add('Detail C'); await open.click(); await expect(page).toHaveURL(new RegExp(ids[2]));
  await page.goBack(); await expect(page).toHaveURL(new RegExp(ids[1])); await expect(open).toBeVisible();
  await page.goBack(); await expect(page).toHaveURL(new RegExp(ids[0])); await expect(open).toBeVisible();
  await page.goForward(); await expect(page).toHaveURL(new RegExp(ids[1]));
  await page.goto(url(ids[1])); await add('Overview');
  await page.locator('.canvas-link-card').filter({ hasText: 'Overview' }).getByRole('link', { name: 'Open canvas' }).click();
  await expect(page).toHaveURL(new RegExp(ids[0]));
  expect(context.pages()).toHaveLength(1);
  // Deleted/inaccessible destination route uses the same neutral state.
  unavailable = true; await open.click(); await expect(page.locator('.canvas-status .canvas-error')).toBeVisible();
  await page.goBack(); await expect(open).toBeVisible();
  denied = true;
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect(page.locator('.canvas-denied')).toBeVisible();
  await page.reload();
  await expect(page.locator('.canvas-denied')).toBeVisible(); await expect(open).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Protected destination');
  await expect(page.locator('img[src="secret.png"]')).toHaveCount(0);
  // A failed fresh list must not offer cached destinations.
  listFailure = true; await page.getByRole('button', { name: 'Add naplet', exact: true }).click();
  const dialog = page.locator('.canvas-add-dialog'); await dialog.locator('select').first().selectOption('canvas');
  await expect(dialog).toContainText('Canvas choices unavailable.');
  await expect(dialog.locator('.canvas-source-list button')).toHaveCount(0);
  console.log('CANVAS_LINK_EVIDENCE', JSON.stringify({ width, nativeHistory: true, persisted: true, titleOnly: true, noDestinationPreview: true, unavailable: true, denied: true, dragResize: true }));
});
