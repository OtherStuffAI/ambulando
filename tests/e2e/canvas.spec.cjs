const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// The opaque HTML sandbox already forbids service workers. Playwright's block
// injection reads navigator.serviceWorker there and generates a SecurityError.
test.use({ serviceWorkers: 'allow', reducedMotion: 'reduce', hasTouch: true });

const workspaceId = '20000000-0000-4000-8000-000000000002';
const canvasId = '30000000-0000-4000-8000-000000000003';
const identity = {
  workspace_id: workspaceId,
  app_npub: 'npub1canvasapp',
  tower_service_npub: 'npub1canvastower',
  workspace_service_npub: 'npub1canvasworkspace',
};
let seedBundle;
let v40DbBundle;
let canvasHtmlSource;
let currentDbVersion;

test.beforeAll(async () => {
  canvasHtmlSource = await fs.readFile(path.resolve(__dirname, '../../canvas.html'), 'utf8');
  seedBundle = (await build({
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: {
      resolveDir: path.resolve(__dirname, '../..'),
      contents: `
        export { saveSettings, createWorkspaceDb, openWorkspaceDb, upsertMessage } from './src/db.js';
        export { finalizeEvent, getPublicKey } from 'nostr-tools';
        export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';
        export { normalizeWorkspaceEntry } from './src/workspaces.js';
      `,
    },
  })).outputFiles[0].text;
  const dbSource = await fs.readFile(path.resolve(__dirname, '../../src/db.js'), 'utf8');
  currentDbVersion = Math.max(...[...dbSource.matchAll(/db\.version\((\d+)\)/g)].map(match => Number(match[1]))) * 10;
  const v40Source = dbSource.replace(
    /\n  \/\/ Current-authority Canvas projections\.[\s\S]*?\n  db\.version\(41\)\.stores\(\{[\s\S]*?\n  \}\);\n/,
    '\n',
  ).replace(/\n  db\.version\(43\)\.stores\(\{[^\n]+\}\);/, '');
  if (v40Source === dbSource) throw new Error('Could not derive the v40 Canvas migration fixture');
  v40DbBundle = (await build({
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../../src'), contents: v40Source },
  })).outputFiles[0].text;
});

function definition(rowVersion = 1, viewport = { x: 0, y: 0, scale: 1 }) {
  return {
    id: canvasId,
    title: 'Delivery map',
    position: 1,
    row_version: rowVersion,
    can_manage: true,
    visibility: { mode: 'restricted', actor_ids: ['actor-reader'], group_ids: [] },
    viewport,
  };
}

function baseNaplets() {
  return [
    { id: 'doc', access: 'ready', row_version: 1, title: 'Brief', source: { type: 'document', id: 'doc-1' }, layout: { x: 30, y: 30, width: 320, height: 220, z: 1 }, content: { title: 'Launch brief', body: '# Rendered heading\n\nA canonical document projection.\n\n- First item\n- Second item\n\n1. Ordered item\n\n> Quoted evidence\n\n[Reference](https://example.com/reference)\n\n```js\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Answer | 42 |\n\n' + 'Long reading paragraph.\n\n'.repeat(60) } },
    { id: 'tasks', access: 'ready', row_version: 1, title: 'Tasks', source: { type: 'task_list', id: 'scope-1' }, layout: { x: 380, y: 30, width: 320, height: 220, z: 2 }, content: { tasks: [{ id: 'task-1', title: 'Verify access', state: 'in_progress', private_note: 'drop me' }] } },
    { id: 'chat', access: 'ready', row_version: 1, title: 'Discussion', source: { type: 'chat_thread', id: 'thread-1' }, layout: { x: 30, y: 280, width: 320, height: 220, z: 3 }, content: { messages: [{ id: 'message-1', author: 'Test collaborator', body: 'Use the existing record.', created_at: '2026-10-20T01:00:00Z' }] } },
    { id: 'html', access: 'ready', row_version: 1, title: 'Interactive card', source: { type: 'html', id: 'package-1' }, layout: { x: 380, y: 280, width: 320, height: 220, z: 4 }, content: { version: '1', digest: 'sha256:test', html: '<button id="counter">Count 0</button><a id="escape" href="https://example.invalid/secret">Leave</a><script>document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent="Count 1";<\/script>' } },
    { id: 'denied', access: 'denied', row_version: 1, title: 'Secret roadmap', source: { type: 'document', id: 'secret-document-id' }, layout: { x: 730, y: 30, width: 320, height: 220, z: 5 }, content: { body: 'classified body' } },
  ];
}

async function seedSessionAndWorkspace(page, authMethod = 'ephemeral') {
  await page.goto('/__canvas-seed.html');
  return page.evaluate(async ({ workspaceId, identity, authMethod }) => {
    const module = await import('/__canvas-seed.js');
    const event = await module.signLoginEvent(authMethod);
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
  }, { workspaceId, identity, authMethod });
}

test('dedicated Canvas route renders authorized sources and isolates trusted HTML', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  let canvasVersion = 1;
  let canvasViewport = { x: 0, y: 0, scale: 1 };
  let naplets = baseNaplets();
  let elements = [];
  let comments = [];
  const mutations = [];
  let snapshotRequests = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.searchParams.get('canvasthread') === 'thread-1') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Existing chat fixture</p>' });
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    if (url.pathname.startsWith(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}`)) {
      expect(request.headers().authorization).toMatch(/^Nostr /);
      const suffix = url.pathname.slice(url.pathname.indexOf(`/canvases/${canvasId}`) + `/canvases/${canvasId}`.length);
      if (request.method() === 'GET' && suffix === '/snapshot') {
        snapshotRequests += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvas: definition(canvasVersion, canvasViewport), naplets, elements, comments }) });
      }
      const body = request.postDataJSON();
      mutations.push({ method: request.method(), suffix, body });
      if (request.method() === 'PATCH' && suffix === '') {
        canvasViewport = body.viewport || canvasViewport;
        canvasVersion += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: definition(canvasVersion, canvasViewport) }) });
      }
      if (request.method() === 'PATCH' && suffix.startsWith('/naplets/')) {
        const id = suffix.split('/').pop();
        const naplet = naplets.find(row => row.id === id);
        naplet.row_version += 1;
        naplet.layout = body.layout;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ naplet }) });
      }
      if (request.method() === 'POST' && suffix === '/naplets') {
        naplets = [...naplets, { id: 'added', access: 'ready', row_version: 1, title: body.title || 'Added source', source: body.source, layout: body.layout, content: { title: 'Added source', body: 'Fresh source projection' } }];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ naplet: naplets.at(-1) }) });
      }
      if (request.method() === 'POST' && suffix === '/elements') {
        elements = [...elements, { id: `element-${elements.length + 1}`, row_version: 1, created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:00:00Z', ...body }];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ element: elements.at(-1) }) });
      }
      if (request.method() === 'PATCH' && suffix.startsWith('/elements/')) {
        const id = suffix.split('/').pop(), element = elements.find(row => row.id === id);
        Object.assign(element, body.layout ? { layout: body.layout } : {}, body.data ? { data: body.data } : {}, { row_version: element.row_version + 1 });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ element }) });
      }
      if (request.method() === 'POST' && suffix === '/comments') {
        comments = [...comments, { id: `comment-${comments.length + 1}`, row_version: 1, parent_comment_id: body.parent_comment_id || null, body: body.body, anchor: body.anchor, resolved_at: null, author: { actor_id: 'actor-reader', npub: 'npub-reader', label: 'Test collaborator' }, created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:00:00Z' }];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ comment: comments.at(-1) }) });
      }
      if (request.method() === 'PATCH' && suffix.startsWith('/comments/')) {
        const id = suffix.split('/').pop(), comment = comments.find(row => row.id === id);
        comment.resolved_at = body.resolved ? '2026-10-20T01:01:00Z' : null; comment.row_version += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ comment }) });
      }
    }
    return serveBuiltFlightDeck(route);
  });

  const workspaceKey = await seedSessionAndWorkspace(page);
  const original = page;
  const canvasUrl = `/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`;
  const canvasPage = context.waitForEvent('page', { timeout: 5_000 });
  await original.evaluate(url => { window.open(url, '_blank'); return true; }, canvasUrl);
  const canvas = await canvasPage;
  const canvasPageErrors = [];
  const canvasConsoleErrors = [];
  canvas.on('pageerror', error => canvasPageErrors.push(error.stack || error.message));
  canvas.on('console', message => { if (message.type() === 'error') canvasConsoleErrors.push(message.text()); });
  await expect(canvas.getByRole('heading', { name: 'Delivery map' })).toBeVisible();
  await canvas.waitForTimeout(100);
  expect(snapshotRequests).toBe(1);
  await expect(canvas.locator('.app-shell')).toHaveCount(0);
  await expect(canvas.locator('.canvas-naplet')).toHaveCount(5);
  await expect(canvas.getByText('Launch brief')).toBeVisible();
  const doc = canvas.locator('[data-canvas-key="naplet:doc"]');
  const prose = doc.locator('.ProseMirror');
  await expect(prose).toHaveAttribute('contenteditable', 'false');
  await expect(prose.locator('h1')).toHaveText('Rendered heading');
  await expect(prose.locator('ul li')).toHaveCount(2);
  await expect(prose.locator('ol li')).toHaveCount(1);
  await expect(prose.locator('blockquote')).toContainText('Quoted evidence');
  await expect(prose.locator('pre code')).toHaveText('const answer = 42;');
  await expect(prose.locator('table')).toContainText('Answer');
  await expect(prose.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.com/reference');
  const openDoc = doc.getByRole('link', { name: 'Open in Ambulando to edit' });
  const href = new URL(await openDoc.getAttribute('href'), canvas.url());
  expect(href.pathname).toBe('/docs');
  expect(href.searchParams.get('workspacekey')).toBe(workspaceKey);
  expect(href.searchParams.get('docid')).toBe('doc-1');
  await expect(openDoc).toHaveAttribute('target', '_blank');
  const beforeScroll = await canvas.evaluate(() => ({ ...Alpine.store('canvas').viewport }));
  const scroll = doc.locator('.canvas-document-scroll');
  await scroll.hover(); await canvas.mouse.wheel(0, 400);
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await canvas.evaluate(() => ({ ...Alpine.store('canvas').viewport }))).toEqual(beforeScroll);
  const readingPosition = await scroll.evaluate(el => el.scrollTop);
  await prose.evaluate(el => { el.dataset.windowRetained = 'yes'; });
  await doc.getByRole('button', { name: 'Minimise window', exact: true }).click();
  await expect(scroll).not.toBeVisible();
  await doc.getByRole('button', { name: 'Restore window', exact: true }).click();
  await doc.getByRole('button', { name: 'Open full screen', exact: true }).click();
  await expect(doc).toHaveJSProperty('open', true);
  await expect(prose).toHaveAttribute('data-window-retained', 'yes');
  await doc.getByRole('button', { name: 'Window options', exact: true }).click();
  await doc.getByRole('menuitem', { name: 'Bring forward' }).click();
  await expect.poll(() => mutations.filter(row => row.suffix === '/naplets/doc').length).toBe(1);
  expect(mutations.find(row => row.suffix === '/naplets/doc').body).toMatchObject({ expected_row_version: 1, layout: { z: 2 } });
  await doc.getByRole('button', { name: 'Restore from full screen', exact: true }).click();
  await expect(doc).toHaveJSProperty('open', false);
  await expect(doc).not.toHaveClass(/window-expanded/);
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(readingPosition);
  await expect(prose).toHaveAttribute('data-window-retained', 'yes');
  const header = await doc.locator('.canvas-naplet-header strong').boundingBox();
  await canvas.mouse.move(header.x + 8, header.y + 8);
  await canvas.mouse.down();
  await expect.poll(() => canvas.evaluate(() => Alpine.store('canvas').interaction?.type)).toBe('move');
  await canvas.mouse.move(header.x + 28, header.y + 20, { steps: 4 });
  await canvas.mouse.up();
  await expect.poll(() => naplets[0].layout.x).toBe(50);
  expect(naplets[0].layout.y).toBe(42);
  await expect(doc).toHaveClass(/selected/);
  const resize = await doc.getByRole('button', { name: 'Resize naplet' }).boundingBox();
  await canvas.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await canvas.mouse.down();
  await canvas.mouse.move(resize.x + resize.width / 2 + 30, resize.y + resize.height / 2 + 20, { steps: 4 });
  await canvas.mouse.up();
  await expect.poll(() => naplets[0].layout.width).toBe(350);
  expect(naplets[0].layout.height).toBe(240);
  for (const width of [1440, 390]) {
    await canvas.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await canvas.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const geometry = await doc.evaluate(el => {
        const paper = el.querySelector('.canvas-document-paper'), scroll = el.querySelector('.canvas-document-scroll');
        return { paper: getComputedStyle(paper).backgroundColor, ink: getComputedStyle(paper).color, bounded: scroll.clientHeight < scroll.scrollHeight, width: paper.getBoundingClientRect().width <= scroll.getBoundingClientRect().width };
      });
      expect(geometry).toEqual({ paper: 'rgb(255, 255, 255)', ink: 'rgb(32, 39, 51)', bounded: true, width: true });
    }
  }
  await canvas.setViewportSize({ width: 1280, height: 900 });
  await scroll.evaluate(el => { el.scrollTop = 0; });
  // Source updates reuse the same read-only editor; layout updates do not remount it.
  await prose.evaluate(el => { el.dataset.retained = 'yes'; });
  naplets[0].content.body += '\n\n## Fresh source update';
  await canvas.evaluate(() => Alpine.store('canvas').refresh());
  await expect(prose.locator('h2')).toHaveText('Fresh source update');
  await expect(prose).toHaveAttribute('data-retained', 'yes');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  await canvas.keyboard.type('do not edit');
  await expect(prose).not.toContainText('do not edit');
  await expect(canvas.getByTitle('Select (V)')).toHaveClass(/active/);

  await expect(canvas.getByText('Verify access')).toBeVisible();
  await expect(canvas.locator('[data-canvas-key="naplet:chat"] .canvas-chat-frame')).toHaveAttribute('src', /canvasthread=thread-1/);
  console.log('CANVAS_DOCUMENT_EVIDENCE', JSON.stringify({ markdown: ['headings', 'lists', 'links', 'code', 'tables', 'quotes'], readOnly: true, exactDocLink: href.toString(), themes: ['light', 'dark'], widths: [1440, 390], wheelContained: true, updateRetainsEditor: true }));
  const denied = canvas.locator('.canvas-naplet').filter({ hasText: 'Restricted item' });
  await expect(denied.getByText('Ask your workspace owner for access.', { exact: true })).toBeVisible();
  const rendered = await canvas.locator('body').innerText();
  expect(rendered).not.toContain('Secret roadmap');
  expect(rendered).not.toContain('secret-document-id');
  expect(rendered).not.toContain('classified body');

  const frame = canvas.frameLocator('iframe[title="Interactive card"]');
  await frame.locator('#counter').click();
  await expect(frame.locator('#counter')).toHaveText('Count 1');
  const popup = context.waitForEvent('page', { timeout: 500 }).catch(() => null);
  await frame.locator('#escape').click({ noWaitAfter: true });
  expect(await popup).toBeNull();
  await expect(frame.locator('#counter')).toHaveText('Count 1');
  await expect(canvas).toHaveURL(/\/canvas\.html/);

  await canvas.getByRole('button', { name: 'Zoom in' }).click();
  expect(await canvas.evaluate(() => ({ viewport: globalThis.Alpine.store('canvas').viewport, error: globalThis.Alpine.store('canvas').error }))).toMatchObject({ viewport: { scale: 1.1 }, error: '' });
  await expect(canvas.getByRole('button', { name: 'Reset zoom' })).toHaveText('110%');
  await expect.poll(() => mutations.filter(row => row.method === 'PATCH' && row.suffix === '').length).toBe(1);
  await canvas.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => mutations.filter(row => row.method === 'PATCH' && row.suffix === '').length).toBe(2);
  expect(mutations.filter(row => row.method === 'PATCH' && row.suffix === '').map(row => row.body.expected_row_version)).toEqual([1, 2]);

  await canvas.getByRole('button', { name: 'Add naplet' }).click();
  await canvas.getByRole('button', { name: 'New reference', exact: true }).click();
  await canvas.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(canvas.locator('.canvas-naplet')).toHaveCount(6);
  await expect(canvas.getByText('Fresh source projection')).toBeVisible();
  expect(mutations.find(row => row.method === 'POST').body.source).toEqual({ type: 'document', id: 'doc-2' });

  await canvas.getByTitle('Text (T)').click();
  await canvas.locator('.canvas-stage').click({ position: { x: 1100, y: 600 } });
  await expect(canvas.locator('.canvas-element.kind-text')).toHaveCount(1);
  const editor = canvas.locator('.canvas-element.kind-text textarea');
  await editor.fill('Persistent note');
  await editor.blur();
  await expect(canvas.getByText('Persistent note')).toBeVisible();

  await canvas.getByTitle('Comment (C)').click();
  await canvas.locator('.canvas-stage').click({ position: { x: 1000, y: 500 } });
  await canvas.locator('.canvas-comment-dialog').getByRole('textbox', { name: 'Comment', exact: true }).fill('Please verify this area.');
  await canvas.getByRole('button', { name: 'Post' }).click();
  await expect(canvas.locator('.canvas-comment-marker')).toHaveCount(1);

  await canvas.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => canvas.isClosed()).toBe(true);
  await expect(original).toHaveTitle('seed');
  expect(original.isClosed()).toBe(false);
  console.log('CANVAS_RUNTIME_ERRORS', JSON.stringify({ page: canvasPageErrors, console: canvasConsoleErrors }));
  expect(canvasPageErrors).toEqual([]);
  expect(canvasConsoleErrors).toEqual([]);
  console.log('CANVAS_BROWSER_EVIDENCE', JSON.stringify({ minimalChrome: true, napletFamilies: 4, deniedMetadataHidden: true, htmlInteractiveAndContained: true, sequentialCas: true, sourcePickerAndAddNaplet: true, persistentText: true, threadedCommentAnchor: true, closeReturnsToOriginalTab: true }));
});

test('Canvas starts one runtime across clean, current-schema, and v40 upgrade databases', async ({ browser }) => {
  test.setTimeout(45_000);
  expect(canvasHtmlSource).not.toContain('x-init="$store.canvas.init()"');
  const evidence = [];
  for (const databaseState of ['clean', 'current-schema', 'upgrade-v40']) {
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: true });
    const page = await context.newPage();
    let snapshotRequests = 0;
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.stack || error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
      if (url.pathname === '/__canvas-v40.js') return route.fulfill({ contentType: 'text/javascript', body: v40DbBundle });
      if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
      if (request.method() === 'GET' && url.pathname === `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}/snapshot`) {
        snapshotRequests += 1;
        expect(request.headers().authorization).toMatch(/^Nostr /);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvas: definition(), naplets: [] }) });
      }
      return serveBuiltFlightDeck(route);
    });

    await page.goto('/__canvas-seed.html', { waitUntil: 'domcontentloaded', timeout: 5_000 });
    const workspaceKey = await page.evaluate(async ({ workspaceId, identity, databaseState }) => {
      const current = await import('/__canvas-seed.js');
      const event = await current.signLoginEvent('ephemeral');
      const npub = await current.pubkeyToNpub(event.pubkey);
      const workspace = current.normalizeWorkspaceEntry({
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
      await current.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
      if (databaseState !== 'clean') {
        const dbModule = databaseState === 'upgrade-v40' ? await import('/__canvas-v40.js') : current;
        const db = dbModule.createWorkspaceDb(workspace.workspaceKey);
        await db.open();
        await db.pending_writes.add({ record_id: 'preserve-pending', record_family_hash: 'family', created_at: '2026-10-20T00:00:00Z' });
        await db.document_drafts.put({ draft_key: 'preserve-draft', workspace_id: workspaceId, document_id: 'doc-preserve', recovery_id: 'recovery-preserve', dirty_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' });
        db.close();
      }
      return workspace.workspaceKey;
    }, { workspaceId, identity, databaseState });

    await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    await expect.poll(
      () => page.evaluate(() => ({ status: globalThis.Alpine?.store?.('canvas')?.status, error: globalThis.Alpine?.store?.('canvas')?.error })),
      { timeout: 10_000, message: `Canvas should become ready for ${databaseState}` },
    ).toEqual({ status: 'ready', error: '' });
    await page.waitForTimeout(100);
    expect(snapshotRequests).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter(message => message.includes('Transaction committed too early'))).toEqual([]);

    const persisted = await page.evaluate(async ({ workspaceKey, databaseState }) => {
      const request = indexedDB.open(`wingman-fd-ws-${workspaceKey}`);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const version = db.version;
      if (databaseState === 'clean') { db.close(); return { version }; }
      const tx = db.transaction(['pending_writes', 'document_drafts'], 'readonly');
      const complete = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const pendingRequest = new Promise((resolve, reject) => {
        const value = tx.objectStore('pending_writes').getAll();
        value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error);
      });
      const draftRequest = new Promise((resolve, reject) => {
        const value = tx.objectStore('document_drafts').get('preserve-draft');
        value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error);
      });
      const [pending, draft] = await Promise.all([pendingRequest, draftRequest]);
      await complete;
      db.close();
      return { version, pending: pending.some(row => row.record_id === 'preserve-pending'), draft: draft?.draft_key === 'preserve-draft' };
    }, { workspaceKey, databaseState });
    expect(persisted.version).toBe(currentDbVersion);
    if (databaseState !== 'clean') expect(persisted).toMatchObject({ pending: true, draft: true });
    evidence.push({ databaseState, snapshotRequests, indexedDbVersion: persisted.version, preservedPendingAndDraft: databaseState === 'clean' ? null : true });
    await context.close();
  }
  console.log('CANVAS_STARTUP_EVIDENCE', JSON.stringify(evidence));
});


for (const width of [1440, 390]) test(`Canvas comments persist subjects and safe deletions in nonmodal movable popovers at ${width}px`, async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 850 });
  const author = { actor_id: 'actor-reader', npub: 'npub-reader', label: 'Reviewer' };
  const makeComment = (id, parent = null) => ({ id, parent_comment_id: parent, body: id === 'root' ? 'Review this naplet' : 'A reply', anchor: { type: 'canvas', x: 80, y: 400 }, row_version: 1, author, can_delete: true, can_retarget: !parent, retarget_preserves_position: true, can_resolve: !parent, resolved_at: null });
  let comments = [makeComment('root')];
  const naplets = [baseNaplets()[1]];
  naplets[0].layout = { x: 20, y: 20, width: 260, height: 180, z: 1 };
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}`;
    if (!url.pathname.startsWith(root)) {
      if (process.env.SOL_RUNTIME_ASSETS === '1' && url.origin === new URL(baseURL).origin && !url.pathname.startsWith('/api/')) return route.continue();
      return serveBuiltFlightDeck(route);
    }
    expect(request.headers().authorization).toMatch(/^Nostr /);
    const suffix = url.pathname.slice(root.length);
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (suffix === '/snapshot') return respond({ workspace_id: workspaceId, identity, complete: true, canvas: definition(), naplets, elements: [], comments });
    const body = request.postDataJSON(); requests.push({ suffix, method: request.method(), body });
    if (suffix.startsWith('/naplets/')) { Object.assign(naplets[0], { layout: body.layout, row_version: naplets[0].row_version + 1 }); return respond({}); }
    if (suffix === '/comments' && request.method() === 'POST') { comments.push({ ...makeComment('new-reply', body.parent_comment_id), body: body.body, anchor: body.anchor }); return respond({}); }
    const comment = comments.find(row => row.id === suffix.split('/').pop());
    if (body.expected_row_version !== comment?.row_version) return respond({ error: 'stale_row_version', message: 'Comment changed; refresh and try again' }, 409);
    if (request.method() === 'DELETE') {
      const replies = comments.filter(row => row.parent_comment_id === comment.id);
      if (!comment.parent_comment_id && JSON.stringify(body.expected_reply_versions) !== JSON.stringify(Object.fromEntries(replies.map(row => [row.id, row.row_version])))) return respond({ error: 'stale_row_version', message: 'Replies changed; refresh and confirm again' }, 409);
      comments = comments.filter(row => row.id !== comment.id && row.parent_comment_id !== comment.id); return respond({});
    }
    if (body.anchor) { comment.anchor = body.anchor; for (const row of comments.filter(row => row.parent_comment_id === comment.id)) { row.anchor = body.anchor; row.row_version++; } }
    if (typeof body.resolved === 'boolean') comment.resolved_at = body.resolved ? '2026-10-21T04:00:00Z' : null;
    comment.row_version++; return respond({});
  });
  const key = await seedSessionAndWorkspace(page);
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(key)}&canvasid=${canvasId}`);
  await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
  const panel = page.locator('.canvas-comment-panel'), editor = page.locator('.canvas-comment-dialog');
  await expect(panel).toBeVisible();
  expect(await panel.evaluate(node => node.matches(':modal'))).toBe(false);
  await expect(panel.getByText('Review this naplet', { exact: true })).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox()).height).toBeGreaterThan(100);
  const compact = await panel.boundingBox();
  expect(compact.width).toBeGreaterThanOrEqual(300); expect(compact.width).toBeLessThanOrEqual(340);
  expect(compact.height).toBeLessThanOrEqual(220);
  await expect(panel.locator('select')).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Choose linked naplet' })).not.toBeVisible();
  await expect(panel.getByText(/No linked naplet|Deletion requires|Apply subject/)).toHaveCount(0);
  if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/canvas-comment-compact-${width}.png` });
  // Keyboard and touch reveal a small direct-choice fallback only on demand.
  const chain = panel.getByRole('button', { name: 'Link subject', exact: true });
  if (width === 390) { const box = await chain.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); }
  else { await chain.focus(); await page.keyboard.press('Enter'); }
  await panel.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect.poll(() => comments[0].anchor.naplet_id).toBe('tasks');
  await chain.click(); await panel.getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect.poll(() => comments[0].anchor.type).toBe('canvas');
  comments.push(makeComment('reply', 'root'));
  await page.reload(); await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
  const handle = panel.locator('[data-popover-drag]');
  // Keyboard and pointer movement remain bounded even on a narrow viewport.
  await expect(handle).toBeVisible();
  await handle.focus(); const initial = await panel.boundingBox(); await page.keyboard.press('ArrowLeft');
  const afterKey = await panel.boundingBox();
  expect(afterKey.x).toBeLessThanOrEqual(initial.x);
  const headerBox = await handle.boundingBox();
  await page.mouse.move(headerBox.x + 50, headerBox.y + 15); await page.mouse.down(); await page.mouse.move(50, 640, { steps: 8 }); await page.mouse.up();
  const moved = await panel.boundingBox(); expect(moved.y).toBeGreaterThan(initial.y); expect(moved.x).toBeGreaterThanOrEqual(0); expect(moved.x + moved.width).toBeLessThanOrEqual(width);
  // Board selection works while the comment is open.
  await page.locator('.canvas-naplet-header').click({ position: { x: 90, y: 15 } });
  await expect(page.locator('.canvas-naplet')).toHaveClass(/selected/);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Link subject', exact: true }).scrollIntoViewIfNeeded();
  const link = await panel.getByRole('button', { name: 'Link subject', exact: true }).boundingBox();
  const target = await page.locator('.canvas-naplet-header').boundingBox();
  await page.mouse.move(link.x + 20, link.y + 15); await page.mouse.down(); await page.mouse.move(target.x + 100, target.y + 20, { steps: 12 });
  const draggingLine = page.locator('.canvas-comment-connector line');
  await expect(page.locator('.canvas-comment-connector')).toBeVisible();
  await expect(draggingLine).toHaveAttribute('x1', '80'); await expect(draggingLine).toHaveAttribute('y1', '400');
  const endpoint = await draggingLine.evaluate(node => { const p = new DOMPoint(+node.getAttribute('x2'), +node.getAttribute('y2')).matrixTransform(node.getScreenCTM()); return { x: p.x, y: p.y, dash: getComputedStyle(node).strokeDasharray }; });
  expect(Math.abs(endpoint.x - target.x - 100)).toBeLessThan(2); expect(Math.abs(endpoint.y - target.y - 20)).toBeLessThan(2);
  expect(endpoint.dash).not.toBe('none');
  if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/canvas-comment-drag-${width}.png` });
  await page.mouse.up();
  await expect.poll(() => comments[0].anchor.naplet_id).toBe('tasks');
  await expect(panel.getByRole('button', { name: 'Tasks', exact: true })).not.toBeVisible();
  expect(requests.filter(row => row.body.anchor).at(-1)?.body.anchor).toEqual({ type: 'naplet', naplet_id: 'tasks', x: 80, y: 400 });
  await chain.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Tasks', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: 'Tasks', exact: true })).not.toBeVisible();
  if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/canvas-comment-linked-${width}.png` });
  const line = page.locator('.canvas-comment-connector'); await expect(line).toBeVisible();
  const before = await line.locator('line').getAttribute('x2');
  const markerPosition = await page.locator('.canvas-comment-marker').getAttribute('style');
  expect(markerPosition).toBe('left:66px;top:386px');
  await page.mouse.move(target.x + 100, target.y + 20); await page.mouse.down(); await page.mouse.move(target.x + 140, target.y + 40, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => line.locator('line').getAttribute('x2')).not.toBe(before);
  await expect(page.locator('.canvas-comment-marker')).toHaveAttribute('style', markerPosition);
  await panel.getByRole('button', { name: 'Close', exact: true }).scrollIntoViewIfNeeded(); await panel.getByRole('button', { name: 'Close', exact: true }).click(); await expect(line).not.toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
  await expect.poll(() => page.evaluate(() => window.Alpine.store('canvas').activeComment?.anchor.naplet_id)).toBe('tasks');
  await expect(line).toBeVisible();
  await expect(page.locator('.canvas-comment-marker')).toHaveAttribute('style', markerPosition);
  await panel.getByRole('button', { name: 'Reply', exact: true }).click(); await editor.getByLabel('Comment', { exact: true }).fill('Reply stays in this thread');
  expect(await editor.evaluate(node => node.matches(':modal'))).toBe(false);
  await editor.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(panel.getByText('Reply stays in this thread')).toBeVisible();
  await panel.getByRole('button', { name: 'Delete reply', exact: true }).first().click();
  await panel.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Delete reply', exact: true })).toHaveCount(1);
  await page.reload(); await page.getByRole('button', { name: 'Open comment by Reviewer' }).click(); await expect(panel.getByRole('button', { name: 'Delete reply', exact: true })).toHaveCount(1);
  await panel.getByRole('button', { name: 'Resolve', exact: true }).click(); await expect(page.locator('.canvas-comment-marker')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Reopen', exact: true }).click(); await expect(page.locator('.canvas-comment-marker')).toHaveCount(1);
  // Confirmation captures the reply set; an arriving reply must cause conflict.
  await panel.getByRole('button', { name: 'Delete thread', exact: true }).click(); comments.push(makeComment('arrived', 'root'));
  await panel.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Replies changed'); await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Delete thread', exact: true }).click(); await expect(panel.getByText(/Delete this thread and 2 replies/)).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm delete', exact: true }).click(); await expect(panel).not.toBeVisible();
  await page.reload(); await expect(page.locator('.canvas-comment-marker')).toHaveCount(0);
  // Server capability projection gates actions; no guessed permission from visibility.
  comments = [{ ...makeComment('root'), can_delete: false, can_retarget: false, can_resolve: false }];
  await page.reload(); await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
  await expect(panel.getByRole('button', { name: 'Delete thread', exact: true })).not.toBeVisible();
  await expect(panel.getByRole('button', { name: 'Link subject', exact: true })).not.toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resolve', exact: true })).not.toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  comments = [{ ...makeComment('root'), retarget_preserves_position: false }];
  await page.reload(); await page.getByRole('button', { name: 'Open comment by Reviewer' }).click();
  await expect(panel.getByRole('button', { name: 'Link subject', exact: true })).not.toBeVisible();
  expect(errors).toEqual([]);
  console.log('CANVAS_COMMENT_EVIDENCE', JSON.stringify({ width, compact, runtimeAssets: process.env.SOL_RUNTIME_ASSETS === '1', visiblePointerLine: true, keyboardTouchFallback: true, nonmodal: true, draggableAndBounded: true, boardUsable: true, explicitTargetSurvivesReloadAndFollows: true, connectorOnlyOpen: true, repliesAndDeletionSurviveReload: true, resolveReopen: true, changedReplySetProtected: true, permissionGated: true }));
});

test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) console.log('CANVAS_FAILURE', JSON.stringify({ url: page.url(), errors: info.errors.map(error => ({ message: String(error.message || '').slice(0, 1600) })) })); });

for (const touch of [false, true]) test(`native arrow and text controls persist with history (${touch ? 'touch' : 'mouse'})`, async ({ page, context, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  test.setTimeout(90_000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('CANVAS_ERROR', error.message); });
  let viewport = { x: 0, y: 0, scale: 1 }, version = 1;
  let elements = [
    { id: 'legacy-arrow', kind: 'arrow', row_version: 1, layout: { x: 50, y: 100, width: 200, height: 80, z: 1 }, data: { direction: 'forward', custom: 'retain' } },
    { id: 'legacy-text', kind: 'text', row_version: 1, layout: { x: 50, y: 320, width: 260, height: 160, z: 2 }, data: { text: 'Legacy text', custom: 'retain' } },
    { id: 'rectangle', kind: 'rectangle', row_version: 1, layout: { x: 1050, y: 400, width: 100, height: 100, z: 3 }, data: {} },
  ];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}`;
    const respond = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith(root)) {
      const suffix = url.pathname.slice(root.length);
      if (suffix === '/snapshot') return respond({ workspace_id: workspaceId, identity, complete: true, canvas: definition(version, viewport), elements, naplets: [], comments: [] });
      const body = request.postDataJSON();
      if (suffix === '') { viewport = body.viewport || viewport; version++; return respond({ canvas: definition(version, viewport) }); }
      if (suffix === '/elements') { const element = { ...body, id: `created-${elements.length}`, row_version: 1 }; elements.push(element); return respond({ element }); }
      if (suffix.startsWith('/elements/')) {
        const element = elements.find(row => row.id === suffix.split('/').pop());
        expect(body.expected_row_version).toBe(element.row_version);
        if (body.layout) element.layout = body.layout;
        if (body.data) element.data = body.data;
        element.row_version++;
        return respond({ element });
      }
    }
    // Test real registered runtime assets when requested; all API writes stay synthetic.
    if (process.env.SOL_RUNTIME_ASSETS === '1' && url.origin === new URL(baseURL).origin && !url.pathname.startsWith('/api/')) return route.continue();
    return serveBuiltFlightDeck(route);
  });
  const workspaceKey = await seedSessionAndWorkspace(page);
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  await expect(page.locator('.canvas-stage')).toBeVisible();
  const stage = await page.locator('.canvas-stage').boundingBox();
  const drag = async (from, to) => {
    if (!touch) { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); }
    else {
      const client = await context.newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= 8; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await client.detach();
    }
  };
  const handleDrag = async (label, dx, dy) => { const box = await page.getByRole('button', { name: label, exact: true }).boundingBox(); await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy }); await expect.poll(() => page.evaluate(() => Alpine.store('canvas').saving)).toBe(false); };
  await expect(page.locator('[data-canvas-key="element:legacy-text"] .canvas-text')).toHaveCSS('font-size', '16px');
  await page.getByTitle('Arrow (A)', { exact: true }).click();
  const drawingTouch = touch ? await context.newCDPSession(page) : null;
  if (drawingTouch) {
    await drawingTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: stage.y + 140 }] });
    await drawingTouch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 800, y: stage.y + 220 }] });
  } else { await page.mouse.move(500, stage.y + 140); await page.mouse.down(); await page.mouse.move(800, stage.y + 220, { steps: 5 }); }
  await expect(page.locator('.canvas-preview .canvas-vector-line')).toHaveAttribute('d', 'M 0 0 L 300 80');
  await expect(page.locator('.canvas-preview .canvas-shape')).toBeHidden();
  if (drawingTouch) { await drawingTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await drawingTouch.detach(); } else await page.mouse.up();
  await expect.poll(() => elements.length).toBe(4);
  await expect(page.getByRole('button', { name: 'Bend arrow', exact: true })).toBeVisible();
  const arrow = page.locator('[data-canvas-key="element:created-3"]');
  await expect(arrow.locator('.canvas-resize')).toBeHidden();
  await expect(arrow).toHaveCSS('outline-style', 'none');
  const checkHandlePaint = async state => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const paint = await arrow.locator('.canvas-arrow-handle').evaluateAll(handles => handles.map(handle => {
        const style = getComputedStyle(handle);
        return { fill: style.backgroundColor, border: style.borderTopColor, width: style.borderTopWidth, style: style.borderTopStyle };
      }));
      expect(paint).toHaveLength(3);
      for (const handle of paint) {
        expect(handle.fill).not.toBe('rgba(0, 0, 0, 0)');
        expect(handle.border).not.toBe('rgba(0, 0, 0, 0)');
        expect(handle.width).toBe('2px');
        expect(handle.style).toBe('solid');
        expect(handle.fill).not.toBe(handle.border);
      }
      console.log('HANDLE_PAINT', JSON.stringify({ state, theme, touch, paint }));
      await testInfo.attach(`${state}-${theme}`, { body: await page.screenshot({ path: testInfo.outputPath(`${state}-${theme}.png`) }), contentType: 'image/png' });
    }
  };
  await checkHandlePaint('straight');
  await handleDrag('Bend arrow', 0, -90);
  await checkHandlePaint('bent');
  await expect(arrow.locator('.canvas-vector-line')).toHaveAttribute('d', / Q /);
  const bent = structuredClone(elements[3]);
  await page.getByTitle('Undo (Ctrl/Cmd+Z)', { exact: true }).click();
  await expect(arrow.locator('.canvas-vector-line')).not.toHaveAttribute('d', / Q /);
  await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)', { exact: true }).click();
  await expect(arrow.locator('.canvas-vector-line')).toHaveAttribute('d', / Q /);
  await handleDrag('Adjust arrow start', -30, 20);
  await handleDrag('Adjust arrow end', 40, 20);
  expect(elements[3].data.curve).toBeDefined();
  for (const style of ['dotted', 'dashed', 'solid']) { await page.getByLabel('Line style', { exact: true }).selectOption(style); await expect.poll(() => elements[3].data.lineStyle).toBe(style); }
  for (const head of ['arrow','triangle','diamond','circle','none']) { await page.getByLabel('End arrowhead', { exact: true }).selectOption(head); await expect.poll(() => elements[3].data.endArrowhead).toBe(head); }
  await page.getByLabel('End arrowhead', { exact: true }).selectOption('arrow');
  await page.getByLabel('Start arrowhead', { exact: true }).selectOption('circle');
  await page.getByLabel('Line style', { exact: true }).selectOption('dashed');
  await expect.poll(() => elements[3].data.lineStyle).toBe('dashed');
  await page.getByRole('button', { name: 'Straighten', exact: true }).click();
  await expect(arrow.locator('.canvas-vector-line')).not.toHaveAttribute('d', / Q /);
  await page.getByTitle('Undo (Ctrl/Cmd+Z)', { exact: true }).click();
  await expect(arrow.locator('.canvas-vector-line')).toHaveAttribute('d', / Q /);
  // Move the whole curved stroke away from its handles, with pointer/touch capture.
  const curvePoint = (row, t) => {
    const s = row.data.start, e = row.data.end, c = row.data.curve;
    return { x: row.layout.x + (1-t)**2*s[0] + 2*(1-t)*t*c[0] + t*t*e[0], y: stage.y + row.layout.y + (1-t)**2*s[1] + 2*(1-t)*t*c[1] + t*t*e[1] };
  };
  const beforeMove = structuredClone(elements[3]), point = curvePoint(beforeMove, .25);
  await drag(point, { x: point.x + 30, y: point.y + 25 });
  await expect.poll(() => elements[3].layout.x).toBe(beforeMove.layout.x + 30);
  expect(elements[3].layout.y).toBe(beforeMove.layout.y + 25);
  expect(elements[3].data).toEqual(beforeMove.data);
  await expect(arrow.getByRole('button', { name: 'Bend arrow', exact: true })).toBeVisible();
  await testInfo.attach('curved-arrow-controls', { body: await page.screenshot({ path: testInfo.outputPath('curved-arrow-controls.png') }), contentType: 'image/png' });
  // Selecting a legacy line on its visible stroke preserves fallback geometry.
  await page.mouse.click(150, stage.y + 140);
  await handleDrag('Bend arrow', 0, -30);
  expect(elements[0].data.custom).toBe('retain');
  await page.locator('[data-canvas-key="element:legacy-text"] .canvas-text').click();
  await page.getByLabel('Text size', { exact: true }).fill('48'); await page.getByLabel('Text size', { exact: true }).press('Tab');
  await expect(page.locator('[data-canvas-key="element:legacy-text"] .canvas-text')).toHaveCSS('font-size', '48px');
  expect(elements[1].data).toEqual({ text: 'Legacy text', custom: 'retain', fontSize: 48 });
  await page.locator('[data-canvas-key="element:legacy-text"] .canvas-text').dblclick();
  await expect(page.locator('[data-text-editor="legacy-text"]')).toHaveCSS('font-size', '48px');
  await page.locator('[data-text-editor="legacy-text"]').fill('Resized legacy text');
  await page.locator('[data-text-editor="legacy-text"]').press('Control+Enter');
  await expect.poll(() => elements[1].data.text).toBe('Resized legacy text');
  await page.getByLabel('Zoom in', { exact: true }).click();
  await expect.poll(() => viewport.scale).toBeCloseTo(1.1);
  await page.getByTitle('Hand / pan (H)', { exact: true }).click();
  await drag({ x: 900, y: stage.y + 500 }, { x: 930, y: stage.y + 530 });
  await expect.poll(() => viewport.x).not.toBe(0);
  await page.reload(); await expect(page.locator('.canvas-stage')).toBeVisible();
  await expect(arrow.locator('.canvas-vector-line')).toHaveAttribute('d', / Q /);
  await expect(arrow.locator('.canvas-vector-line')).toHaveAttribute('stroke-dasharray', '10 7');
  await expect(page.locator('[data-canvas-key="element:legacy-text"] .canvas-text')).toHaveText('Resized legacy text');
  await expect(page.locator('[data-canvas-key="element:legacy-text"] .canvas-text')).toHaveCSS('font-size', '48px');
  // Handles remain aligned with the rendered line after persisted zoom/pan.
  const p = curvePoint(elements[3], .25);
  await page.mouse.click((p.x * viewport.scale) + viewport.x, ((p.y - stage.y) * viewport.scale) + viewport.y + stage.y);
  await checkHandlePaint('zoomed');
  const beforeZoomEdit = structuredClone(elements[3]);
  await handleDrag('Adjust arrow end', 22, 11);
  const endWorld = row => row.data.end.map((v, i) => v + (i ? row.layout.y : row.layout.x));
  expect(endWorld(elements[3])).toEqual(endWorld(beforeZoomEdit).map((v, i) => v + (i ? 10 : 20)));
  expect(elements[2].layout).toEqual({ x: 1050, y: 400, width: 100, height: 100, z: 3 });
  expect(bent.data.curve).toBeDefined();
  expect(errors).toEqual([]);
});

test.describe('Canvas Chat', () => {
  test.use({ serviceWorkers: 'block' });

for (const { parentOnly, signerProbe, revocationHistory } of [{ parentOnly: false }, { parentOnly: true }, { parentOnly: true, signerProbe: true }, { parentOnly: true, revocationHistory: true }]) {
test(`Canvas Chat places locally and selects scope then channel into the normal composer${parentOnly ? ' with parent-only NIP07 signer' : ''}${signerProbe ? ' isolated rejection' : ''}${revocationHistory ? ' known concurrent-history revocation regression' : ''}`, async ({ page, context }) => {
  test.skip(revocationHistory && process.env.CANVAS_REVOKED_HISTORY_REGRESSION !== '1', 'Known pending-status observation after signer revocation with live history writers; enable CANVAS_REVOKED_HISTORY_REGRESSION=1 to reproduce.');
  test.setTimeout(120000); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
  console.log('CANVAS_CHAT_STAGE', 'start');
  const scopeId = '40000000-0000-4000-8000-000000000004';
  const channelId = '50000000-0000-4000-8000-000000000005';
  let naplets = [];
  let artifactVersionReads = 0;
  const artifactId = '90000000-0000-4000-8000-000000000001', artifactVersion = '90000000-0000-4000-8000-000000000003';
  const sends = [], threads = new Map(), savedMessages = [];
  let ownerNpub = '';
  const agentNpub = require('nostr-tools').nip19.npubEncode('11'.repeat(32));
  const now = '2026-10-22T04:00:00.000Z';
  let bindingPosts = 0;
  let signedReads = 0;
  if (parentOnly) {
    const secret = Array.from(require('nostr-tools').generateSecretKey());
    await context.addInitScript(({ secret }) => {
      if (window !== window.parent) return;
      const key = new Uint8Array(secret);
      window.__parentSignerEvents = [];
      window.nostr = {
        __wingman: true,
        getPublicKey: async () => (await import('/__canvas-seed.js')).getPublicKey(key),
        signEvent: async event => {
          if (window.__rejectNextCanvasSign && event.kind === 33358) { window.__rejectNextCanvasSign = false; throw new Error('Synthetic user rejected signing'); }
          window.__parentSignerEvents.push(event);
          return (await import('/__canvas-seed.js')).finalizeEvent(event, key);
        },
      };
    }, { secret });
  }
  const checkAuth = request => {
    const auth = JSON.parse(Buffer.from(request.headers().authorization.slice(6), 'base64').toString());
    expect(require('nostr-tools').verifyEvent(auth)).toBe(true);
    expect(auth.kind).toBe(27235);
    expect(auth.tags).toEqual(expect.arrayContaining([['u', request.url()], ['method', request.method()]]));
    if (request.postData()) expect(auth.tags).toContainEqual(['payload', require('node:crypto').createHash('sha256').update(request.postData()).digest('hex')]);
  };

  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && request.method() === 'POST') {
      expect(request.headers().authorization).toMatch(/^Nostr /);
      if (parentOnly) checkAuth(request);
      const body = request.postDataJSON(); sends.push(body);
      const threadId = body.thread_id || '60000000-0000-4000-8000-' + String(threads.size + 1).padStart(12, '0');
      const messageId = '70000000-0000-4000-8000-' + String(sends.length).padStart(12, '0');
      const sentAt = new Date(Date.parse(now) + sends.length * 60000).toISOString();
      const message = { id: messageId, workspace_id: workspaceId, scope_id: scopeId, channel_id: channelId, thread_id: threadId, body: body.body, metadata: { ...body.metadata, agent_instruction_signature: body.message_signature }, row_version: 1, created_at: sentAt, updated_at: sentAt };
      savedMessages.push(message);
      if (!threads.has(threadId)) threads.set(threadId, { id: threadId, workspace_id: workspaceId, scope_id: scopeId, channel_id: channelId, source_message_id: messageId, title: body.thread_title || 'Canvas conversation', row_version: 1, created_at: now, updated_at: now });
      const thread = threads.get(threadId);
      thread.row_version += 1; thread.activity_version = sends.length;
      return route.fulfill({ json: { message, thread } });
    }
    if (url.pathname.endsWith('/descriptor')) return route.fulfill({ json: { type: 'wingman_workspace_locator', tower_base_url: 'http://127.0.0.1:3100', identity: { ...identity, workspace_owner_npub: ownerNpub }, capabilities: ['pg_scopes', 'pg_channels'] } });
    if (url.pathname.endsWith(`/workspaces/${workspaceId}/me`)) return route.fulfill({ json: { identity: { ...identity, workspace_owner_npub: ownerNpub }, actor: { actor_id: 'actor-reader', npub: ownerNpub }, permissions: ['workspace.read', 'workspace.manage'] } });
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && request.method() === 'GET') return route.fulfill({ json: { messages: savedMessages.filter(row => !url.searchParams.get('thread_id') || row.thread_id === url.searchParams.get('thread_id')), threads: [...threads.values()], effective_transcript: true, next_cursor: null } });
    if (url.pathname.endsWith(`/channels/${channelId}/threads`)) return route.fulfill({ json: { threads: [...threads.values()] } });
    if (/\/threads\/[^/]+$/.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { thread: threads.get(url.pathname.split('/').pop()) } });
    if (url.pathname.endsWith(`/canvases/${canvasId}/naplets`) && request.method() === 'POST') {
      bindingPosts++;
      const body = request.postDataJSON();
      naplets.push({ ...body, id: '80000000-0000-4000-8000-' + String(bindingPosts).padStart(12, '0'), row_version: 1, access: 'ready', content: { messages: [] } });
      return route.fulfill({ json: { naplet: naplets.at(-1) } });
    }
    if (url.pathname.includes(`/canvases/${canvasId}/naplets/`) && request.method() === 'DELETE') {
      const id = url.pathname.split('/').pop(); naplets = naplets.filter(row => row.id !== id);
      return route.fulfill({ json: { deleted: true } });
    }
    if (url.pathname.endsWith(`/naplets/${artifactId}/html`)) {
      artifactVersionReads++;
      expect(url.searchParams.get('version_id')).toBe(artifactVersion);
      return route.fulfill({ json: { workspace_id: workspaceId, identity, naplet_id: artifactId, content: { file_id: artifactId, version_id: artifactVersion, version_number: 3, html: '<p>Referenced version three</p>' }, versions: [] } });
    }
    if (url.pathname.endsWith('/canvases')) return route.fulfill({ json: { workspace_id: workspaceId, identity, complete: true, canvases: [definition(), { ...definition(), id: '30000000-0000-4000-8000-000000000099', title: 'Ambulando brand' }] } });
    if (url.pathname.endsWith('/canvases/30000000-0000-4000-8000-000000000099/snapshot')) return route.fulfill({ json: { workspace_id: workspaceId, identity, complete: true, canvas: { ...definition(), id: '30000000-0000-4000-8000-000000000099', title: 'Ambulando brand' }, naplets, elements: [], comments: [] } });
    if (url.pathname.endsWith(`/canvases/${canvasId}/snapshot`)) return route.fulfill({ json: { workspace_id: workspaceId, identity, complete: true, canvas: definition(1, { x: 0, y: 0, scale: 1 }), naplets, elements: [], comments: [] } });
    if (url.pathname.endsWith(`/workspaces/${workspaceId}/scopes`)) return route.fulfill({ json: { scopes: [{ id: scopeId, workspace_id: workspaceId, name: 'Canvas scope', row_version: 1 }] } });
    if (url.pathname.endsWith(`/scopes/${scopeId}/channels`)) return route.fulfill({ json: { channels: [{ id: channelId, workspace_id: workspaceId, scope_id: scopeId, name: 'Canvas channel', row_version: 1 }] } });
    if (parentOnly && url.pathname.endsWith(`/channels/${channelId}`)) { checkAuth(request); signedReads++; }
    if (url.pathname.endsWith(`/channels/${channelId}`)) return route.fulfill({ json: { channel: { id: channelId, workspace_id: workspaceId, scope_id: scopeId, name: 'Canvas channel', row_version: 1 } } });
    return serveBuiltFlightDeck(route);
  });
  const workspaceKey = await seedSessionAndWorkspace(page, parentOnly ? 'extension' : 'ephemeral');
  ownerNpub = workspaceKey.split(':')[1];
  console.log('CANVAS_CHAT_STAGE', 'seeded');
  await page.evaluate(async ({ workspaceKey, workspaceId, scopeId, channelId }) => {
    const m = await import('/__canvas-seed.js'), db = m.createWorkspaceDb(workspaceKey);
    await db.open();
    await db.scopes.put({ record_id: scopeId, owner_npub: workspaceKey.split(':')[1], pg_workspace_id: workspaceId, pg_backend: true, title: 'Canvas scope', record_state: 'active' });
    await db.channels.put({ record_id: channelId, owner_npub: workspaceKey.split(':')[1], pg_workspace_id: workspaceId, scope_id: scopeId, name: 'Canvas channel', title: 'Canvas channel', record_state: 'active', can_write: true, pg_backend: true });
    db.close();
  }, { workspaceKey, workspaceId, scopeId, channelId });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  console.log('CANVAS_CHAT_STAGE', 'placing', await page.evaluate(() => ({status:Alpine.store('canvas').status,error:Alpine.store('canvas').error})));
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  console.log('CANVAS_CHAT_STAGE', 'tool selected');
  await page.locator('.canvas-stage').click({ position: { x: 50, y: 50 } });
  console.log('CANVAS_CHAT_STAGE', 'placed');
  await expect(page.locator('.canvas-naplet')).toHaveCount(1);
  await page.getByRole('button', { name: 'Canvas scope', exact: true }).click();
  await page.getByRole('button', { name: 'Canvas channel', exact: true }).click({noWaitAfter:true});
  const frame = page.frameLocator('.canvas-chat-frame').first();
  await expect(frame.locator('[data-chat-composer="thread"]').first()).toBeVisible({ timeout: 15000 });
  await frame.locator('[data-chat-composer="thread"]').first().fill('Canvas draft stays independent');
  await expect(frame.locator('[data-chat-composer="thread"]').first()).toHaveText('Canvas draft stays independent');
  await expect(frame.locator('.page-header')).not.toBeVisible();
  if (parentOnly) {
    expect(await frame.locator('body').evaluate(() => window.nostr === undefined)).toBe(true);
    expect(signedReads).toBeGreaterThan(0);
  }
  console.log('CANVAS_CHAT_STAGE', 'normal composer ready');
  await frame.locator('body').evaluate((_element, agentNpub) => {
    const s = Alpine.store('chat');
    s.pgWorkspaceMembers = [{ actor_id: 'agent-canvas', npub: agentNpub, kind: 'agent', display_name: 'Canvas Agent' }];
  }, agentNpub);
  const editor = frame.locator('[data-chat-composer="thread"]').first();
  await expect(frame.getByLabel('Message Canvas origin')).toHaveText('From: Delivery map');
  await editor.fill('@Canvas Agent');
  await expect(frame.locator('.mention-result-item').filter({ hasText: 'Canvas Agent' }).first()).toBeVisible();
  await frame.locator('.mention-result-item').filter({ hasText: 'Canvas Agent' }).first().click();
  await editor.press('End');
  await editor.pressSequentially(' Please review this Canvas @canvas:thiscanvas');
  await expect(frame.locator('.mention-result-item').filter({ hasText: 'This Canvas' }).first()).toBeVisible();
  await editor.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  expect(sends).toHaveLength(0);
  await expect(editor.locator('a.canvas-reference-pill')).toHaveCount(0);
  await editor.press('Enter');
  await expect(editor.locator('a.canvas-reference-pill')).toHaveCount(1);
  await expect(editor.locator('a.canvas-reference-pill')).toHaveAttribute('href', /canvasid=/);
  if (parentOnly) {
    const draft = await editor.innerText();
    await page.evaluate(() => { window.__rejectNextCanvasSign = true; });
    await frame.getByRole('button', { name: 'Start thread', exact: true }).click();
    await expect(frame.locator('.error-bar-message')).toContainText('Synthetic user rejected signing');
    expect(sends).toHaveLength(0);
    await expect(editor).toHaveText(draft);
  }
  await frame.getByRole('button', { name: 'Start thread', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].metadata.mentions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent', npub: agentNpub })]));
  expect(sends[0].message_signature).toBeTruthy();
  expect(sends[0].body).toContain('[From: Delivery map](');
  expect(sends[0].body.match(/context=origin/g)).toHaveLength(1);
  expect(sends[0].body).toContain('[Delivery map](');
  if (parentOnly) {
    const signature = sends[0].message_signature;
    expect(signature.nostr_event.kind).toBe(33358);
    expect(require('nostr-tools').verifyEvent(signature.nostr_event)).toBe(true);
    expect(signature.nostr_event.content).toBe(sends[0].body);
    expect(await page.evaluate(() => window.__parentSignerEvents.some(e => e.kind === 33358))).toBe(true);
  }
  await expect.poll(() => naplets.length).toBe(1);
  await expect(editor).toHaveAttribute('aria-label', 'Reply to thread');
  console.log('CANVAS_CHAT_STAGE', 'first ordinary signed thread bound');
  const firstThread = naplets[0].source.id;
  if (signerProbe) {
    await editor.fill('First chat draft');
    await frame.locator('body').evaluate(() => { const s = Alpine.store('chat'); s.stopBackgroundSync(); s.stopThreadLiveActivity?.(); });
    await page.evaluate(() => { Alpine.store('canvas').session = { ...Alpine.store('canvas').session, pubkey: '22'.repeat(32) }; });
    const result = await frame.locator('body').evaluate(async () => {
      const s = Alpine.store('chat'), m = await import('/__canvas-seed.js');
      const sent = await s.sendThreadReply();
      const db = m.createWorkspaceDb(s.currentWorkspaceKey); await db.open();
      const rows = await db.chat_messages.toArray(); db.close();
      return { sent, error: s.error, db: rows.filter(row => row.body?.includes('First chat draft')).map(row => ({ id: row.record_id, status: row.sync_status })), ui: s.messages.filter(row => row.body?.includes('First chat draft')).map(row => ({ id: row.record_id, status: row.sync_status })) };
    });
    console.log('BOUNDED_SIGNER_PROBE', JSON.stringify(result));
    expect(result.sent).toBe(false); expect(result.db[0]?.status).toBe('failed'); expect(result.ui[0]?.status).toBe('failed');
    return;
  }
  const firstKey = await page.locator('.canvas-chat-frame').getAttribute('data-canvas-chat-frame');
  await editor.fill('First chat draft');
  console.log('CANVAS_CHAT_STAGE', 'placing');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('.canvas-stage').click({ position: { x: 740, y: 50 } });
  await page.getByRole('button', { name: 'Canvas scope', exact: true }).click();
  await page.getByRole('button', { name: 'Canvas channel', exact: true }).click({noWaitAfter:true});
  const second = page.frameLocator('.canvas-chat-frame').nth(1);
  const secondEditor = second.locator('[data-chat-composer="thread"]').first();
  await expect(secondEditor).toBeVisible({timeout:5000}).catch(async error => { console.log('SECOND_EMBED_STATE', await page.evaluate(() => [...document.querySelectorAll('.canvas-chat-frame')].map(f => { try { const s = f.contentWindow.Alpine?.store('chat'); return {src:f.src,ready:s?.canvasChatEmbedReady,error:s?.canvasChatEmbedError,session:!!s?.session,open:s?.deckThreadComposerOpen,channel:s?.deckThreadComposerChannelId,body:f.contentDocument?.body?.innerText.slice(0,250)}; } catch(e) {return {error:e.message};} }))); throw error; });
  await expect(secondEditor).toHaveText('');
  console.log('CANVAS_CHAT_STAGE', 'second independent composer ready');
  await secondEditor.fill('Second independent conversation');
  await second.getByRole('button', { name: 'Start thread', exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  await expect.poll(() => naplets.length).toBe(2);
  console.log('CANVAS_CHAT_STAGE', 'two independent threads bound');
  expect(naplets[1].source.id).not.toBe(firstThread);
  await expect(editor).toHaveText('First chat draft');
  await expect(page.locator('.canvas-chat-frame').first()).toHaveAttribute('data-canvas-chat-frame', firstKey);
  // A different browsing context materializes replies into the shared Dexie.
  await page.evaluate(async ({ workspaceKey, firstThread, channelId, agentNpub, now }) => {
    const m = await import('/__canvas-seed.js'); m.openWorkspaceDb(workspaceKey);
    for (let i = 0; i < 12; i++) await m.upsertMessage({ record_id: `reactive-reply-${i}`, channel_id: channelId, parent_message_id: '70000000-0000-4000-8000-000000000001', pg_thread_id: firstThread, pg_record_type: 'message', body: `Reactive reply ${i} ` + 'Visible thread update. '.repeat(25), sender_npub: agentNpub, record_state: 'active', sync_status: 'synced', created_at: new Date(Date.parse(now) + i * 1000).toISOString(), updated_at: new Date(Date.parse(now) + i * 1000).toISOString(), pg_backend: true });
  }, { workspaceKey, firstThread, channelId, agentNpub, now });
  await expect(frame.locator('.thread-replies')).toContainText('Reactive reply 11');
  console.log('CANVAS_CHAT_STAGE', 'shared Dexie replies visible');
  await expect(second.locator('.thread-replies')).not.toContainText('Reactive reply 11');
  await editor.focus();
  const viewportBefore = await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }));
  await editor.press('ArrowLeft');
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }))).toEqual(viewportBefore);
  if (parentOnly) {
    const signedBefore = await page.evaluate(() => window.__parentSignerEvents.filter(event => event.kind === 33358).length);
    await page.evaluate(async () => {
      const trusted = document.querySelector('.canvas-chat-frame');
      const url = new URL(trusted.src), s = Alpine.store('canvas');
      const data = { type: 'ambulando-canvas-chat-sign', id: 'spoof', method: 'getPublicKey', workspaceKey: s.currentWorkspaceKey, pubkey: s.session.pubkey, key: url.searchParams.get('canvaskey') };
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.invalid', source: trusted.contentWindow, data }));
      const arbitrary = document.createElement('iframe'); arbitrary.id = 'unregistered-signer-test';
      arbitrary.srcdoc = '<p>Unregistered same-origin frame</p>'; document.body.append(arbitrary);
      await new Promise(resolve => { arbitrary.onload = resolve; });
    });
    // Post from that browsing context so event.source is the unregistered frame.
    await page.frameLocator('#unregistered-signer-test').locator('body').evaluate(() => {
      const s = parent.Alpine.store('canvas'), trusted = parent.document.querySelector('.canvas-chat-frame');
      parent.postMessage({ type: 'ambulando-canvas-chat-sign', id: 'unregistered', method: 'signEvent', workspaceKey: s.currentWorkspaceKey, pubkey: s.session.pubkey, key: trusted.dataset.canvasChatFrame, event: { kind: 33358, pubkey: s.session.pubkey, content: 'Spoof', created_at: Math.floor(Date.now() / 1000), tags: [['protocol', 'flightdeck_pg_message_instruction'], ['workspace_id', s.currentWorkspace.workspaceId]] } }, parent.location.origin);
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__parentSignerEvents.filter(event => event.kind === 33358).length)).toBe(signedBefore);
    await page.evaluate(() => document.querySelector('#unregistered-signer-test').remove());
    // Identity revocation and failed-row persistence are exercised in the
    // isolated rejection case, without this fixture's live-history writers.
    if (revocationHistory) {
      await frame.locator('body').evaluate(() => { const s = Alpine.store('chat'); s.stopBackgroundSync(); s.stopThreadLiveActivity?.(); });
      await page.evaluate(() => { Alpine.store('canvas').session = { ...Alpine.store('canvas').session, pubkey: '22'.repeat(32) }; });
      expect(await frame.locator('body').evaluate(() => Alpine.store('chat').sendThreadReply())).toBe(false);
      await expect(frame.locator('.error-bar-message')).toContainText(/Chat signer (identity changed|connection closed)/);
      await expect.poll(() => frame.locator('body').evaluate(() => Alpine.store('chat').threadMessages.some(row => row.body.endsWith('First chat draft') && row.sync_status === 'failed')), { timeout: 5000 }).toBe(true);
      expect(sends).toHaveLength(2);
    }
  }
  await page.reload();
  await expect(page.locator('.canvas-chat-frame')).toHaveCount(2);
  await expect(page.frameLocator('.canvas-chat-frame').first().locator('.thread-replies')).toContainText('Reactive reply 11');
  expect(sends).toHaveLength(2);
  expect(bindingPosts).toBe(2);
  const reloaded = page.frameLocator('.canvas-chat-frame').first();
  const reloadedEditor = reloaded.locator('[data-chat-composer="thread"]').first();
  await reloadedEditor.fill('@canvas:Ambulando br');
  await expect(reloaded.locator('.mention-result-item').filter({ hasText: 'Ambulando brand' })).toBeVisible();
  await reloaded.locator('.mention-result-item').filter({ hasText: 'Ambulando brand' }).click();
  await reloadedEditor.press('End'); await reloadedEditor.pressSequentially(' Explicit other Canvas');
  await reloaded.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect.poll(() => sends.length).toBe(3);
  expect(sends[2].body).toContain('[From: Delivery map](');
  expect(sends[2].body).toContain('[Ambulando brand](');
  expect(sends[2].metadata.mentions || []).toEqual([]);
  expect(sends[2].thread_id).toBe(firstThread);
  // Same ordinary thread on another real Canvas page retains its own origin.
  console.log('CANVAS_CHAT_STAGE', 'explicit other Canvas reference sent');
  const other = await context.newPage();
  await other.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=30000000-0000-4000-8000-000000000099`);
  const otherFrame = other.frameLocator('.canvas-chat-frame').first();
  await expect(otherFrame.getByLabel('Message Canvas origin')).toHaveText('From: Ambulando brand');
  await otherFrame.locator('[data-chat-composer="thread"]').first().fill('Same thread from another Canvas');
  await otherFrame.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect.poll(() => sends.length).toBe(4);
  expect(sends[3].body).toContain('[From: Ambulando brand](');
  expect(sends[3].thread_id).toBe(firstThread);
  await other.close();
  // Exercise the ordinary Chat app, reading the saved origins and composing
  // outside the Canvas iframe. No inherited message/thread context may leak.
  console.log('CANVAS_CHAT_STAGE', 'second Canvas origin verified');
  const ordinary = await context.newPage();
  await ordinary.goto(`/flight-deck?workspacekey=${encodeURIComponent(workspaceKey)}&channelid=${channelId}&threadid=70000000-0000-4000-8000-000000000001`);
  await ordinary.waitForFunction(() => window.Alpine?.store('chat')?.session?.npub && Alpine.store('chat').routeSyncPaused === false);
  await expect(ordinary.locator('.thread-replies')).toContainText('From: Delivery map');
  const ordinaryEditor = ordinary.locator('[data-chat-composer="thread"]').first();
  await ordinaryEditor.fill('Ordinary Chat without stale Canvas');
  await ordinary.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect.poll(() => sends.length, { timeout: 5000 }).toBe(5).catch(async error => { console.log('ORDINARY_SEND_STATE', await ordinary.evaluate(() => { const s = Alpine.store('chat'); return { error: s.error, input: s.threadInput, active: s.activeThreadId, channel: s.activeThreadChannelId, canSend: s.canComposeInThreadDestination, open: s.deckThreadComposerOpen, workspace: s.currentWorkspace?.workspaceId }; })); throw error; });
  expect(sends[4].body).toBe('Ordinary Chat without stale Canvas');
  expect(sends[4].thread_id).toBe(firstThread);
  await ordinary.close();
  naplets.push({ id: artifactId, title: 'Brand page', access: 'ready', row_version: 1, source: { type: 'html', id: artifactId }, layout: { x: 50, y: 700, width: 320, height: 220, z: 3 }, content: { file_id: artifactId, version_id: artifactVersion, version_number: 3, html: '<p>Referenced version three</p>' } });
  await page.reload();
  const artifactFrame = page.frameLocator('.canvas-chat-frame').first();
  const artifactEditor = artifactFrame.locator('[data-chat-composer="thread"]').first();
  await artifactEditor.fill('@canvas:Brand page');
  await expect(artifactFrame.locator('.mention-result-item').filter({ hasText: 'Brand page' })).toBeVisible();
  await artifactFrame.locator('.mention-result-item').filter({ hasText: 'Brand page' }).click();
  await expect(artifactEditor.locator('a.canvas-reference-pill')).toHaveAttribute('href', new RegExp(`versionid=${artifactVersion}`));
  // Save and restore the ordinary draft, then send the restored chip.
  await artifactEditor.blur();
  await expect.poll(() => artifactFrame.locator('body').evaluate(() => Alpine.store('chat').threadInput)).toContain(`versionid=${artifactVersion}`);
  await artifactFrame.locator('body').evaluate(() => {
    const s = Alpine.store('chat'); s.saveChatComposerDraft('thread'); s.threadInput = '';
  });
  await expect(artifactEditor).toHaveText('');
  await artifactFrame.locator('body').evaluate(() => Alpine.store('chat').restoreChatComposerDraft('thread'));
  const restored = artifactFrame;
  await expect(restored.locator('[data-chat-composer="thread"]').first().locator('a.canvas-reference-pill')).toHaveAttribute('href', new RegExp(`versionid=${artifactVersion}`));
  await restored.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect.poll(() => sends.length).toBe(6);
  expect(sends[5].body).toContain(`sourceid=${artifactId}&versionid=${artifactVersion}`);
  expect(sends[5].metadata.mentions || []).toEqual([]);
  expect(sends[5].thread_id).toBe(firstThread);
  await expect.poll(() => restored.locator('body').evaluate(() => Alpine.store('chat').threadMessages.some(row => row.body.includes('Brand page') && row.sync_status === 'synced'))).toBe(true);
  await page.reload();
  await expect(page.frameLocator('.canvas-chat-frame').first().locator('[data-chat-composer="thread"]').first()).toBeVisible();
  await expect(page.frameLocator('.canvas-chat-frame').first().locator('.thread-replies a.canvas-reference-pill').filter({ hasText: 'Brand page' })).toHaveAttribute('href', new RegExp(`versionid=${artifactVersion}`), { timeout: 5000 });
  const versionUrl = new URL(sends[5].body.match(/\[Brand page[^\]]*\]\(([^)]+)\)/)[1]);
  // A later snapshot now follows a newer version; the saved link still opens v3.
  naplets.at(-1).content = { ...naplets.at(-1).content, version_id: '90000000-0000-4000-8000-000000000004', version_number: 4, html: '<p>New latest four</p>' };
  const versionPage = await context.newPage();
  await versionPage.goto(versionUrl.href);
  await expect.poll(() => artifactVersionReads).toBeGreaterThan(0);
  await expect(versionPage.locator('[data-canvas-key="naplet:' + artifactId + '"]')).toHaveAttribute('data-canvas-key', 'naplet:' + artifactId);
  await expect.poll(() => versionPage.evaluate(id => Alpine.store('canvas').htmlContent(Alpine.store('canvas').naplets.find(n => n.id === id)).version_number, artifactId)).toBe(3);
  const readsBeforeMismatch = artifactVersionReads;
  versionUrl.searchParams.set('sourceid', 'different-source');
  await versionPage.goto(versionUrl.href);
  await expect(versionPage.locator('.canvas-toast')).toContainText('The referenced item is unavailable');
  expect(artifactVersionReads).toBe(readsBeforeMismatch);
  naplets.at(-1).access = 'denied';
  versionUrl.searchParams.set('sourceid', artifactId);
  await versionPage.goto(versionUrl.href);
  await expect(versionPage.locator('.canvas-toast')).toContainText('The referenced item is unavailable');
  expect(artifactVersionReads).toBe(readsBeforeMismatch);
  await versionPage.close();
  console.log('CANVAS_CHAT_EVIDENCE', JSON.stringify({ parentOnly, signedReads, placement: true, twoTaps: true, normalComposer: true, structuredMention: true, signedMessage: true, liveAutopilotDispatch: false, independentChats: true, reactiveDexieReplies: true, reload: true, sends: sends.length, bindings: bindingPosts }));
});
}

});
