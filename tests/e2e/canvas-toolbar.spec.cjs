const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.afterEach(async ({ context }) => { await context.unrouteAll({ behavior: 'ignoreErrors' }); });

const workspaceId = '20000000-0000-4000-8000-000000000091';
const canvasId = '30000000-0000-4000-8000-000000000092';
const targetId = '60000000-0000-4000-8000-000000000093';
const nearId = '60000000-0000-4000-8000-000000000094';
const deniedId = '60000000-0000-4000-8000-000000000095';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
const tasks = title => ({ tasks: [{ id: `${title}-1`, title: `${title} task`, state: 'todo' }] });

let seedBundle;
test.beforeAll(async () => {
  seedBundle = (await build({
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js';\nexport { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js';\nexport { normalizeWorkspaceEntry } from './src/workspaces.js';` },
  })).outputFiles[0].text;
});

/** Synthetic signed Tower for one canvas. Records every write. */
async function routeTower(context, state) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const root = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
    if (!url.pathname.startsWith('/api/')) return serveBuiltFlightDeck(route);
    expect(request.headers().authorization).toMatch(/^Nostr /);
    if (request.method() !== 'GET') state.writes.push(`${request.method()} ${url.pathname.slice(root.length)}`);
    if (url.pathname === `${root}/canvases/${canvasId}/snapshot`) {
      if (state.canvasDenied) return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        workspace_id: workspaceId, identity, complete: true,
        canvas: { id: canvasId, title: 'Ambulando, NStack, Wingman & Browser — a long canvas title', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace' }, viewport: { x: 0, y: 0, scale: 1 } },
        naplets: [
          { id: nearId, access: 'ready', row_version: 1, title: 'Nearby list', source: { type: 'task_list', id: 'channel-near' }, content: tasks('near'), layout: { x: 20, y: 20, width: 300, height: 220, z: 1 } },
          ...(state.targetRemoved ? [] : [{ id: targetId, access: state.targetDenied ? 'denied' : 'ready', row_version: 1, title: state.targetDenied ? 'Protected plan' : 'Launch plan', source: { type: 'task_list', id: 'channel-secret' }, content: tasks('launch'), layout: { x: 2600, y: 1800, width: 800, height: 460, z: 2 } }]),
          { id: deniedId, access: 'denied', row_version: 1, title: 'Protected budget', layout: { x: 20, y: 280, width: 260, height: 200, z: 3 } },
        ],
        elements: [], comments: [],
      }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: {}, naplet: {} }) });
  });
}

/** Signs in a fresh identity and saves a local workspace entry; returns its local key. */
async function seed(page) {
  await page.goto('/__seed.html');
  return page.evaluate(async ({ workspaceId, identity }) => {
    const module = await import('/__seed.js');
    const event = await module.signLoginEvent('ephemeral');
    const npub = await module.pubkeyToNpub(event.pubkey);
    const workspace = module.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'actor-me', npub }, identity }, pgDescriptor: { identity } });
    await module.saveSettings({ knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    const db = module.createWorkspaceDb(workspace.workspaceKey); await db.open(); db.close();
    return workspace.workspaceKey;
  }, { workspaceId, identity });
}

// Exercise the production canvas template and store with synthetic Tower records.
for (const width of [320, 390, 700, 768, 1024, 1440, 2048]) test(`Toolbar stays within a ${width}px canvas including selection options`, async ({ page, context }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await routeTower(context, { writes: [] });
  const key = await seed(page);
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(key)}&canvasid=${canvasId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await expect(page.locator('.canvas-toolbar h1')).toContainText('Ambulando, NStack');
  await expect(page.locator('.canvas-stage')).toBeVisible();
  const checkBounds = async () => {
    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('.canvas-toolbar');
      const stage = document.querySelector('.canvas-stage').getBoundingClientRect();
      const scroll = toolbar.querySelector('.canvas-toolbar-scroll');
      const groups = [...scroll.children].filter(el => el.getClientRects().length);
      return { overflow: toolbar.scrollWidth - toolbar.clientWidth, stageHeight: stage.height,
        wrap: getComputedStyle(scroll).flexWrap,
        tops: groups.map(el => Math.round(el.getBoundingClientRect().top)),
        first: scroll.querySelector('button').textContent,
        title: toolbar.querySelector('h1').title,
        titleWidth: toolbar.querySelector('.canvas-brand').getBoundingClientRect().width,
        scrollable: scroll.scrollWidth > scroll.clientWidth };
    });
    expect(geometry.wrap).toBe('nowrap');
    expect(new Set(geometry.tops).size).toBe(1);
    expect(geometry.first).toBe('Chat');
    expect(geometry.title).toContain('long canvas title');
    expect(geometry.titleWidth).toBeLessThanOrEqual(180);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.stageHeight).toBeGreaterThanOrEqual(440);
  };
  await checkBounds();
  for (const title of ['Rectangle (R)', 'Diamond (D)', 'Ellipse (O)', 'Line (L)', 'Free draw (P)', 'Eraser (E)', 'Comment (C)']) await expect(page.getByTitle(title, { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const store = Alpine.store('canvas'); store.setTool('select');
    for (const key of ['r', 'd', 'o', 'l', 'p', 'e', 'c']) store.handleKeydown({ key, target: document.body });
    if (store.tool !== 'select') throw new Error('Removed shortcut remains active');
    for (const tool of ['rectangle', 'diamond', 'ellipse', 'line', 'draw', 'eraser', 'comment', 'embed']) store.setTool(tool);
    if (store.tool !== 'select') throw new Error('Removed tool can still be selected');
  });
  await page.evaluate(() => {
    const store = Alpine.store('canvas');
    store.elements = [{ id: 'arrow-test', kind: 'arrow', data: {}, layout: { x: 0, y: 0, width: 100, height: 100 } }];
    store.selectedKeys = ['element:arrow-test'];
  });
  await expect(page.getByRole('group', { name: 'Arrow options' })).toBeVisible();
  await checkBounds();
  await page.evaluate(() => { const store = Alpine.store('canvas'); store.elements[0].kind = 'text'; store.elements[0].data = { text: 'A note' }; });
  await expect(page.getByRole('group', { name: 'Text options' })).toBeVisible();
  await checkBounds();
  if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SOL_EVIDENCE_DIR, `canvas-toolbar-${width}.png`) });
  const hand = page.getByTitle('Hand / pan (H)', { exact: true });
  await hand.focus(); await page.keyboard.press('Enter');
  await expect(hand).toHaveClass(/active/);
  const stage = await page.locator('.canvas-stage').boundingBox();
  const beforePan = await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }));
  await page.mouse.move(stage.x + 100, stage.y + 100);
  await page.mouse.down(); await page.mouse.move(stage.x + 140, stage.y + 130); await page.mouse.up();
  const afterPan = await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }));
  expect(afterPan.x).not.toBe(beforePan.x);
  const zoom = page.getByRole('button', { name: 'Zoom in', exact: true });
  await zoom.focus(); await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => Alpine.store('canvas').viewport.scale)).toBeGreaterThan(afterPan.scale);
  await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('100%');
  // A short embedded pane keeps the stage available and keyboard focus reveals later controls.
  await page.setViewportSize({ width, height: 400 });
  await page.getByRole('button', { name: 'Close', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  expect((await page.locator('.canvas-stage').boundingBox()).height).toBeGreaterThanOrEqual(200);
  expect(errors).toEqual([]);
});

// Side panels reduce the iframe width without changing the outer desktop window.
test('Toolbar follows its embedded pane when side panels change width', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeTower(context, { writes: [] });
  const key = await seed(page);
  await context.route('**/__pane.html', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:0;display:flex}aside{width:300px;flex:none}iframe{border:0;height:900px;flex:1;min-width:0}</style><aside>Navigation</aside><iframe title="Canvas" src="/canvas.html?workspacekey=${encodeURIComponent(key)}&canvasid=${canvasId}"></iframe><aside id="details">Details</aside>` }));
  await page.goto('/__pane.html');
  const canvas = page.frameLocator('iframe');
  await expect(canvas.locator('.canvas-toolbar h1')).toContainText('Ambulando');
  for (const panelWidth of [300, 500, 0]) {
    await page.locator('#details').evaluate((el, width) => { el.style.width = `${width}px`; }, panelWidth);
    await expect.poll(() => canvas.locator('.canvas-toolbar').evaluate(el => ({
      overflow: el.scrollWidth - el.clientWidth,
      wrap: getComputedStyle(el.querySelector('.canvas-toolbar-scroll')).flexWrap,
    }))).toEqual({ overflow: 0, wrap: 'nowrap' });
    await canvas.getByRole('button', { name: 'Zoom in', exact: true }).click();
  }
});
