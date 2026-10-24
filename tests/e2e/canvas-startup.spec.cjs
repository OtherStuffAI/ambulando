const { test, expect } = require('playwright/test');
const { build, stop } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'allow', reducedMotion: 'reduce' });
const workspaceId = '20000000-0000-4000-8000-000000000002';
const canvasId = '30000000-0000-4000-8000-000000000003';
const scopeId = '40000000-0000-4000-8000-000000000004';
const channelId = '50000000-0000-4000-8000-000000000005';
const identity = { workspace_id: workspaceId, app_npub: 'npub1canvasapp', tower_service_npub: 'npub1canvastower', workspace_service_npub: 'npub1canvasworkspace' };
let seed;
test.beforeAll(async () => {
  seed = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify(identity.app_npub) }, stdin: {
    resolveDir: path.resolve(__dirname, '../..'), contents: `export { saveSettings, createWorkspaceDb } from './src/db.js'; export { signLoginEvent, pubkeyToNpub } from './src/auth/nostr.js'; export { normalizeWorkspaceEntry } from './src/workspaces.js';`,
  } })).outputFiles[0].text;
});
test.afterAll(() => stop());

async function prepare(page, context) {
  let snapshotRead = null, snapshotError = 0;
  const canvas = { id: canvasId, title: 'Startup interaction', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace' }, viewport: { x: 0, y: 0, scale: 1 } };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/__startup-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seed });
    if (url.pathname === '/__startup-seed.html') return route.fulfill({ contentType: 'text/html', body: '<title>Test session</title>' });
    if (url.pathname.endsWith(`/canvases/${canvasId}/snapshot`)) {
      if (snapshotRead) await snapshotRead;
      if (snapshotError) return route.fulfill({ status: snapshotError, json: { error: 'Unavailable' } });
      return route.fulfill({ json: { identity, workspace_id: workspaceId, complete: true, canvas, naplets: [], elements: [] } });
    }
    if (url.pathname.endsWith('/scopes')) return route.fulfill({ json: { scopes: [{ id: scopeId, workspace_id: workspaceId, name: 'Scope', row_version: 1 }] } });
    if (url.pathname.endsWith(`/scopes/${scopeId}/channels`)) return route.fulfill({ json: { channels: [{ id: channelId, workspace_id: workspaceId, scope_id: scopeId, name: 'Channel', row_version: 1 }] } });
    if (url.pathname.endsWith(`/channels/${channelId}`)) return route.fulfill({ json: { channel: { id: channelId, workspace_id: workspaceId, scope_id: scopeId, name: 'Channel', row_version: 1 } } });
    if (url.pathname.endsWith(`/channels/${channelId}/messages`)) return route.fulfill({ json: { messages: [], threads: [], effective_transcript: true, next_cursor: null } });
    if (url.pathname.endsWith('/members')) return route.fulfill({ json: { members: [] } });
    if (url.pathname.endsWith('/groups')) return route.fulfill({ json: { groups: [] } });
    if (process.env.SOL_RUNTIME_ASSETS === '1' && url.origin === 'http://127.0.0.1:41031' && !url.pathname.startsWith('/api/')) return route.continue();
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/__startup-seed.html');
  const workspaceKey = await page.evaluate(async ({ workspaceId, identity, scopeId, channelId }) => {
    const m = await import('/__startup-seed.js');
    const auth = await m.signLoginEvent('ephemeral'), npub = await m.pubkeyToNpub(auth.pubkey);
    const ws = m.normalizeWorkspaceEntry({ workspaceId, workspaceOwnerNpub: npub, pgSessionNpub: npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: identity.app_npub, towerServiceNpub: identity.tower_service_npub, workspaceServiceNpub: identity.workspace_service_npub, pgBackendMode: true, pgMe: { actor: { actor_id: 'reader', npub }, identity }, pgDescriptor: { identity } });
    await m.saveSettings({ knownWorkspaces: [ws], currentWorkspaceKey: ws.workspaceKey });
    const db = m.createWorkspaceDb(ws.workspaceKey); await db.open();
    await db.scopes.put({ record_id: scopeId, title: 'Scope', pg_workspace_id: workspaceId, owner_npub: npub, record_state: 'active' });
    await db.channels.put({ record_id: channelId, scope_id: scopeId, title: 'Channel', name: 'Channel', pg_workspace_id: workspaceId, owner_npub: npub, record_state: 'active', can_write: true, pg_backend: true });
    db.close(); return ws.workspaceKey;
  }, { workspaceId, identity, scopeId, channelId });
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(workspaceKey)}&canvasid=${canvasId}`);
  await page.waitForFunction(() => window.Alpine?.store('canvas')?.status === 'ready');
  return { hold: () => { let release; snapshotRead = new Promise(resolve => { release = resolve; }); return () => { snapshotRead = null; release(); }; }, deny: () => { snapshotError = 403; } };
}

async function monitor(page, context, start, complete) {
  const cdp = await context.newCDPSession(page);
  const rate = Number(process.env.CANVAS_STARTUP_CPU_RATE || 1);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  const boxes = await Promise.all(['Hand / pan (H)', 'Select (V)'].map(title => page.locator(`button[title="${title}"]`).boundingBox()));
  await page.evaluate(() => {
    window.startupProbe = { gaps: [], clicks: [], longTasks: [], running: true };
    window.startupLongTasks = new PerformanceObserver(list => startupProbe.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration, name: entry.name }))));
    startupLongTasks.observe({ type: 'longtask' });
    let last = performance.now();
    const tick = () => { const now = performance.now(); startupProbe.gaps.push(now - last); last = now; if (startupProbe.running) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    document.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!['Select (V)', 'Hand / pan (H)'].includes(target?.title)) return;
      const entry = { delay: performance.now() - event.timeStamp, expected: target.title.startsWith('Select') ? 'select' : 'hand', readersLoading: document.querySelectorAll('[x-canvas-document][aria-busy="true"]').length, startingFrames: [...document.querySelectorAll('.canvas-chat-frame')].filter(frame => !frame.contentWindow.Alpine?.store('chat')?.canvasChatBootstrapped).length };
      startupProbe.clicks.push(entry);
      entry.tool = Alpine.store('canvas').tool;
      requestAnimationFrame(() => { entry.paintDelay = performance.now() - event.timeStamp; entry.paintedTool = Alpine.store('canvas').tool; });
    });
  });
  const roundTrips = [], startedAt = Date.now(), until = startedAt + 60_000;
  let done = false;
  // Observe readiness independently. Awaiting a page.evaluate between clicks
  // would itself wait out a blocked event loop and miss the queued input delay.
  const completed = page.waitForFunction(complete, null, { timeout: 60_000 }).then(() => { done = true; });
  const pending = start();
  do {
    const box = boxes[roundTrips.length % 2], at = Date.now();
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left', clickCount: 1 };
    const timestamp = Date.now() / 1000;
    // Queue both edges in wire order before awaiting either acknowledgement,
    // just as a physical click can arrive while browser execution is blocked.
    const pressed = cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, timestamp });
    const released = cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, timestamp });
    await Promise.all([pressed, released]);
    roundTrips.push(Date.now() - at);
    await new Promise(resolve => setTimeout(resolve, 30));
  } while ((!done || roundTrips.length < 20) && Date.now() < until);
  await pending;
  await completed;
  expect(done).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => { startupProbe.running = false; startupLongTasks.disconnect(); resolve(); })));
  const result = await page.evaluate(() => startupProbe);
  const max = values => Math.max(0, ...values);
  const summary = { rate, elapsedMs: Date.now() - startedAt, samples: roundTrips.length, beforeReadyClicks: result.clicks.filter(click => click.readersLoading || click.startingFrames).length, maxRoundTrip: max(roundTrips), maxFrameGap: max(result.gaps), maxLongTask: max(result.longTasks.map(entry => entry.duration)), longTasks: result.longTasks.length, maxInputDelay: max(result.clicks.map(click => click.delay)), maxPaintDelay: max(result.clicks.map(click => click.paintDelay || 0)) };
  console.log('CANVAS_STARTUP', JSON.stringify(summary));
  expect(result.clicks.every(click => click.tool === click.expected)).toBe(true);
  // Keep this limit fixed across before/after runs. CPU throttling is a stress
  // diagnostic; the ordinary real-input regression gate is 200 ms.
  if (!process.env.CANVAS_STARTUP_MEASURE_ONLY) {
    expect(summary.beforeReadyClicks).toBeGreaterThan(0);
    expect(summary.maxRoundTrip).toBeLessThan(200);
    expect(summary.maxInputDelay).toBeLessThan(200);
    expect(summary.maxPaintDelay).toBeLessThan(200);
    expect(summary.maxFrameGap).toBeLessThan(200);
  }
  return summary;
}

for (const count of [1, 4]) test(`existing controls respond throughout ${count} long document startup(s)`, async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await prepare(page, context);
  await monitor(page, context, () => page.evaluate(count => {
    // Use the production directive, converter, adapter and full real DOM mount.
    // Seeding this source only isolates Tower from the traced reader blocker.
    const s = Alpine.store('canvas');
    s.naplets = Array.from({ length: count }, (_, n) => ({ id: `doc${n}`, title: 'Long document', access: 'ready', source: { type: 'document', id: `doc${n}` }, layout: { x: 30 + n * 100, y: 100 + n * 10, width: 620, height: 640, z: n + 1 }, content: { body: '# Heading\n\n' + Array.from({ length: 500 }, (_, i) => `## Section ${i}\n\nA representative long document with **bold** words and [links](https://example.com).\n\n- One\n- Two\n\n`).join('') } }));
  }, count), () => [...document.querySelectorAll('[x-canvas-document]')].length > 0 && [...document.querySelectorAll('[x-canvas-document]')].every(node => node.getAttribute('aria-busy') !== 'true' && node.textContent.includes('Section 499')));
  await expect(page.locator('.canvas-naplet').last().locator('.ProseMirror')).toContainText('Section 499');
  if (!process.env.CANVAS_STARTUP_MEASURE_ONLY) {
    await page.locator('button[title="Select (V)"]').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    console.log('CANVAS_TOOL_AFTER_SELECT', JSON.stringify(await page.evaluate(() => ({tool:Alpine.store('canvas').tool,stage:document.querySelector('.canvas-stage').className,shield:getComputedStyle(document.querySelector('.canvas-pan-shield')).display}))));
    await expect(page.locator('.canvas-stage')).toHaveClass(/tool-select/);
    await expect(page.locator('.canvas-pan-shield')).not.toBeVisible();
    const window = page.locator('.canvas-naplet').last();
    await window.getByRole('button', { name: 'Minimise window', exact: true }).click({timeout:1000});
    await window.getByRole('button', { name: 'Restore window', exact: true }).click({timeout:1000});
  }
});

test('existing controls respond during real embedded chat bootstrap and slow I/O', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await prepare(page, context);
  let release;
  const read = new Promise(resolve => { release = resolve; });
  let delayedReads = 0, delayedDocuments = 0;
  await context.route('**/flight-deck?**', async route => {
    delayedDocuments++; await read;
    return process.env.SOL_RUNTIME_ASSETS === '1' ? route.continue() : serveBuiltFlightDeck(route);
  });
  await context.route(`**/channels/${channelId}`, async route => {
    expect(route.request().headers().authorization).toMatch(/^Nostr /);
    delayedReads++; await read;
    return route.fulfill({ json: { channel: { id: channelId, workspace_id: workspaceId, scope_id: scopeId, name: 'Channel', row_version: 1 } } });
  });
  const releaseTimer = setTimeout(release, 2500);
  try {
    await monitor(page, context, () => page.evaluate(async ({ scopeId, channelId }) => {
      const s = Alpine.store('canvas');
      for (let n = 0; n < 4; n++) { await s.placeChat({ x: 40 + n * 100, y: 100 + n * 20 }); const draft = s.chatDrafts.at(-1); await s.chooseChatScope(draft, scopeId); s.chooseChatChannel(draft, channelId); }
    }, { scopeId, channelId }), () => document.querySelectorAll('.canvas-chat-frame').length === 4 && [...document.querySelectorAll('.canvas-chat-frame')].every(frame => frame.contentWindow.Alpine?.store('chat')?.canvasChatBootstrapped));
    expect(delayedReads).toBeGreaterThan(0);
    expect(delayedDocuments).toBe(4);
  } finally { clearTimeout(releaseTimer); release(); }
});

test('refresh keeps existing controls available under slow reads and clears revoked access', async ({ page, context }) => {
  const backend = await prepare(page, context), release = backend.hold();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('button[title="Hand / pan (H)"]').click({ timeout: 1000 });
  expect(await page.evaluate(() => Alpine.store('canvas').tool)).toBe('hand');
  backend.deny(); release();
  await page.waitForFunction(() => Alpine.store('canvas').status === 'error');
  await expect(page.locator('.canvas-stage')).not.toBeVisible();
  expect(await page.evaluate(() => Alpine.store('canvas').naplets)).toEqual([]);
});


test('a loading document can be minimised, restored, revoked and replaced without late content', async ({ page, context }) => {
  await prepare(page, context);
  await page.evaluate(() => {
    Alpine.store('canvas').naplets = [{ id: 'loading', title: 'Loading reader', access: 'ready', source: { type: 'document', id: 'old' }, layout: { x: 30, y: 100, width: 620, height: 640, z: 1 }, content: { body: '# Private old source\n\n' + 'Long paragraph.\n\n'.repeat(800) } }];
  });
  const window = page.locator('.canvas-naplet');
  await expect(window.locator('[x-canvas-document]')).toHaveAttribute('aria-busy', 'true');
  await window.getByRole('button', { name: 'Minimise window', exact: true }).click({ timeout: 1000 });
  await expect(window.locator('.canvas-window-content')).not.toBeVisible();
  await window.getByRole('button', { name: 'Restore window', exact: true }).click({ timeout: 1000 });
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.naplets = [{ id: 'loading', access: 'denied', layout: s.naplets[0].layout }]; });
  await expect(window.locator('[x-canvas-document]')).toHaveCount(0);
  await expect(window).not.toContainText('Private old source');
  await page.evaluate(() => { const s = Alpine.store('canvas'); s.naplets = [{ id: 'loading', title: 'New reader', access: 'ready', source: { type: 'document', id: 'new' }, layout: s.naplets[0].layout, content: { body: '# Newly authorized source' } }]; });
  await expect(window.locator('.ProseMirror')).toHaveText('Newly authorized source');
  await page.waitForTimeout(150);
  await expect(window.locator('.ProseMirror')).toHaveText('Newly authorized source');
  await page.evaluate(() => { Alpine.store('canvas').naplets = []; });
  await expect(page.locator('.canvas-naplet')).toHaveCount(0);
});


test('task detail can be closed during startup and a late read cannot reopen it', async ({ page, context }) => {
  await prepare(page, context);
  const taskId = '60000000-0000-4000-8000-000000000006';
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await context.route(`**/tasks/${taskId}`, async route => { started(); await pending; await route.fulfill({ status: 403, json: { error: 'Unavailable' } }).catch(() => {}); });
  await page.evaluate(taskId => Alpine.store('canvas').openTreeTask(null, { record_id: taskId }), taskId);
  await requestStarted;
  const close = await page.getByRole('button', { name: 'Close task details', exact: true }).boundingBox();
  const cdp = await context.newCDPSession(page), startedAt = Date.now();
  const position = { x: close.x + close.width / 2, y: close.y + close.height / 2, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position });
  expect(Date.now() - startedAt).toBeLessThan(200);
  expect(await page.evaluate(() => Alpine.store('canvas').taskDetailFrame)).toBeNull();
  release();
  await page.waitForTimeout(100);
  await expect(page.locator('.canvas-task-detail-dialog')).not.toBeVisible();
  await page.locator('button[title="Hand / pan (H)"]').click();
  expect(await page.evaluate(() => Alpine.store('canvas').tool)).toBe('hand');
});

test('a delayed Hand paint cannot re-enable the pan shield after an ordinary Select click', async ({ page, context }) => {
  await prepare(page, context);
  await page.evaluate(() => {
    Alpine.store('canvas').naplets = [{ id: 'controls', title: 'Existing controls', access: 'ready', source: { type: 'task_list', id: 'tasks' }, content: { tasks: [] }, layout: { x: 30, y: 100, width: 620, height: 400, z: 1 } }];
  });
  await expect(page.locator('.canvas-naplet')).toBeVisible();
  await page.evaluate(() => {
    window.savedStartupRAF = window.requestAnimationFrame;
    window.delayedStartupPaints = [];
    window.requestAnimationFrame = callback => delayedStartupPaints.push(callback);
  });
  for (let i = 0; i < 2; i++) {
    await page.locator('button[title="Hand / pan (H)"]').click({ timeout: 1000 });
    await page.locator('button[title="Select (V)"]').click({ timeout: 1000 });
  }
  expect(await page.evaluate(() => Alpine.store('canvas').tool)).toBe('select');
  await page.evaluate(async () => {
    const delayed = delayedStartupPaints.splice(0);
    window.requestAnimationFrame = savedStartupRAF;
    for (const callback of delayed) { callback(performance.now()); await new Promise(resolve => setTimeout(resolve, 0)); }
  });
  console.log('CANVAS_DELAYED_SHIELD', await page.evaluate(() => ({ tool: Alpine.store('canvas').tool, shield: getComputedStyle(document.querySelector('.canvas-pan-shield')).display })));
  await expect(page.locator('.canvas-pan-shield')).not.toBeVisible({ timeout: 1000 });
  await page.getByRole('button', { name: 'Minimise window', exact: true }).click({ timeout: 1000 });
  await expect(page.locator('.canvas-window-content')).not.toBeVisible();
});
