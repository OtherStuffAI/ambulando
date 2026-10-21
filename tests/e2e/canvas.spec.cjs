const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// The opaque HTML sandbox already forbids service workers. Playwright's block
// injection reads navigator.serviceWorker there and generates a SecurityError.
test.use({ serviceWorkers: 'allow', reducedMotion: 'reduce' });

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
        export { saveSettings, createWorkspaceDb } from './src/db.js';
        export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';
        export { normalizeWorkspaceEntry } from './src/workspaces.js';
      `,
    },
  })).outputFiles[0].text;
  const dbSource = await fs.readFile(path.resolve(__dirname, '../../src/db.js'), 'utf8');
  const v40Source = dbSource.replace(
    /\n  \/\/ Current-authority Canvas projections\.[\s\S]*?\n  db\.version\(41\)\.stores\(\{[\s\S]*?\n  \}\);\n/,
    '\n',
  );
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

test('dedicated Canvas route renders authorized sources and isolates trusted HTML', async ({ page, context }) => {
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
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(readingPosition);
  await expect(prose).toHaveAttribute('data-window-retained', 'yes');
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
  await scroll.focus(); await canvas.keyboard.type('do not edit');
  await expect(prose).not.toContainText('do not edit');
  await expect(canvas.getByTitle('Select (V)')).toHaveClass(/active/);

  await expect(canvas.getByText('Verify access')).toBeVisible();
  await expect(canvas.getByText('Use the existing record.')).toBeVisible();
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
  await canvas.getByLabel('Comment').fill('Please verify this area.');
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

test('Canvas starts one runtime across clean, current-v41, and v40 upgrade databases', async ({ browser }) => {
  test.setTimeout(45_000);
  expect(canvasHtmlSource).not.toContain('x-init="$store.canvas.init()"');
  const evidence = [];
  for (const databaseState of ['clean', 'current-v41', 'upgrade-v40']) {
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
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
    expect(persisted.version).toBe(410);
    if (databaseState !== 'clean') expect(persisted).toMatchObject({ pending: true, draft: true });
    evidence.push({ databaseState, snapshotRequests, indexedDbVersion: persisted.version, preservedPendingAndDraft: databaseState === 'clean' ? null : true });
    await context.close();
  }
  console.log('CANVAS_STARTUP_EVIDENCE', JSON.stringify(evidence));
});
