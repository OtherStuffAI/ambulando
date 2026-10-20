const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const workspaceId = '20000000-0000-4000-8000-000000000002';
const canvasId = '30000000-0000-4000-8000-000000000003';
const identity = {
  workspace_id: workspaceId,
  app_npub: 'npub1canvasapp',
  tower_service_npub: 'npub1canvastower',
  workspace_service_npub: 'npub1canvasworkspace',
};
let seedBundle;

test.beforeAll(async () => {
  seedBundle = (await build({
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: {
      resolveDir: path.resolve(__dirname, '../..'),
      contents: `
        export { saveSettings } from './src/db.js';
        export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';
        export { normalizeWorkspaceEntry } from './src/workspaces.js';
      `,
    },
  })).outputFiles[0].text;
});

function definition(rowVersion = 1) {
  return {
    id: canvasId,
    title: 'Delivery map',
    position: 1,
    row_version: rowVersion,
    can_manage: true,
    visibility: { mode: 'restricted', actor_ids: ['actor-reader'], group_ids: [] },
    viewport: { x: 0, y: 0, scale: 1 },
  };
}

function baseNaplets() {
  return [
    { id: 'doc', access: 'ready', row_version: 1, title: 'Brief', source: { type: 'document', id: 'doc-1' }, layout: { x: 30, y: 30, width: 320, height: 220, z: 1 }, content: { title: 'Launch brief', body: 'A canonical document projection.' } },
    { id: 'tasks', access: 'ready', row_version: 1, title: 'Tasks', source: { type: 'task_list', id: 'scope-1' }, layout: { x: 380, y: 30, width: 320, height: 220, z: 2 }, content: { tasks: [{ id: 'task-1', title: 'Verify access', state: 'in_progress', private_note: 'drop me' }] } },
    { id: 'chat', access: 'ready', row_version: 1, title: 'Discussion', source: { type: 'chat_thread', id: 'thread-1' }, layout: { x: 30, y: 280, width: 320, height: 220, z: 3 }, content: { messages: [{ id: 'message-1', author: 'Rick', body: 'Use the existing record.', created_at: '2026-10-20T01:00:00Z' }] } },
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
    return workspace.workspaceKey;
  }, { workspaceId, identity });
}

test('dedicated Canvas route renders authorized sources and isolates trusted HTML', async ({ page, context }) => {
  test.setTimeout(60_000);
  let canvasVersion = 1;
  let naplets = baseNaplets();
  const mutations = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    if (url.pathname.startsWith(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/${canvasId}`)) {
      expect(request.headers().authorization).toMatch(/^Nostr /);
      const suffix = url.pathname.slice(url.pathname.indexOf(`/canvases/${canvasId}`) + `/canvases/${canvasId}`.length);
      if (request.method() === 'GET' && suffix === '/snapshot') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvas: definition(canvasVersion), naplets }) });
      }
      const body = request.postDataJSON();
      mutations.push({ method: request.method(), suffix, body });
      if (request.method() === 'PATCH' && suffix === '') {
        canvasVersion += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: definition(canvasVersion) }) });
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
    }
    return serveBuiltFlightDeck(route);
  });

  const workspaceKey = await seedSessionAndWorkspace(page);
  const original = page;
  const canvasUrl = `/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`;
  const canvasPage = context.waitForEvent('page');
  await original.evaluate(url => { window.open(url, '_blank'); return true; }, canvasUrl);
  const canvas = await canvasPage;
  await expect(canvas.getByRole('heading', { name: 'Delivery map' })).toBeVisible();
  await expect(canvas.locator('.app-shell')).toHaveCount(0);
  await expect(canvas.locator('.canvas-naplet')).toHaveCount(5);
  await expect(canvas.getByText('Launch brief')).toBeVisible();
  await expect(canvas.getByText('Verify access')).toBeVisible();
  await expect(canvas.getByText('Use the existing record.')).toBeVisible();
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
  await expect(canvas.getByRole('button', { name: 'Reset zoom' })).toHaveText('110%');
  await expect.poll(() => mutations.filter(row => row.method === 'PATCH' && row.suffix === '').length).toBe(1);
  await canvas.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => mutations.filter(row => row.method === 'PATCH' && row.suffix === '').length).toBe(2);
  expect(mutations.filter(row => row.method === 'PATCH' && row.suffix === '').map(row => row.body.expected_row_version)).toEqual([1, 2]);

  await canvas.getByRole('button', { name: 'Add naplet' }).click();
  await canvas.getByLabel('Source record ID').fill('doc-2');
  await canvas.getByLabel('Display title (optional)').fill('New reference');
  await canvas.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(canvas.locator('.canvas-naplet')).toHaveCount(6);
  await expect(canvas.getByText('Fresh source projection')).toBeVisible();
  expect(mutations.find(row => row.method === 'POST').body.source).toEqual({ type: 'document', id: 'doc-2' });

  await canvas.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => canvas.isClosed()).toBe(true);
  await expect(original).toHaveTitle('seed');
  expect(original.isClosed()).toBe(false);
  console.log('CANVAS_BROWSER_EVIDENCE', JSON.stringify({ minimalChrome: true, napletFamilies: 4, deniedMetadataHidden: true, htmlInteractiveAndContained: true, sequentialCas: true, addNaplet: true, closeReturnsToOriginalTab: true }));
});
