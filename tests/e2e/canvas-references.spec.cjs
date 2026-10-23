const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

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
        canvas: { id: canvasId, title: 'Roadmap', position: 1, row_version: 1, can_manage: true, visibility: { mode: 'workspace' }, viewport: { x: 0, y: 0, scale: 1 } },
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

const naplet = (page, id) => page.locator(`[data-canvas-key="naplet:${id}"]`);
const stageCentreOffset = (page, id) => page.evaluate(id => {
  const stage = document.querySelector('.canvas-stage').getBoundingClientRect();
  const target = document.querySelector(`[data-canvas-key="naplet:${id}"]`).getBoundingClientRect();
  return { dx: Math.abs((target.left + target.right) / 2 - (stage.left + stage.right) / 2), dy: Math.abs((target.top + target.bottom) / 2 - (stage.top + stage.bottom) / 2), visible: target.left >= stage.left && target.right <= stage.right && target.top >= stage.top };
}, id);

/** Rejects instead of hanging when a raw browser promise never settles. */
function bounded(promise, label, ms = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Records each successful copy while the native clipboard write still has to resolve. */
function spyOnClipboardWrites() {
  const clipboard = navigator.clipboard;
  window.__copiedReferences = [];
  if (!clipboard?.writeText) return;
  const nativeWriteText = clipboard.writeText.bind(clipboard);
  clipboard.writeText = async text => { await nativeWriteText(text); window.__copiedReferences.push(String(text)); };
}
const lastCopied = page => bounded(page.evaluate(() => window.__copiedReferences.at(-1) ?? null), 'read copied reference');

// Manually created contexts close even when a step fails, so teardown never waits on them.
let openContexts = [];
test.afterEach(async () => {
  // Pending route handlers otherwise keep a failed test's teardown waiting.
  await Promise.all(openContexts.map(context => bounded(context.unrouteAll({ behavior: 'ignoreErrors' }).then(() => context.close()), 'close context').catch(() => undefined)));
  openContexts = [];
});

for (const width of [1440, 390]) test(`Copy reference opens and focuses the exact naplet across local workspace keys without writing the shared viewport ${width}px`, async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const step = label => console.log('CANVAS_REFERENCE_STEP', width, label);
  const state = { writes: [], targetDenied: false, targetRemoved: false, canvasDenied: false };
  const author = await browser.newContext({ baseURL, viewport: { width, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  openContexts.push(author);
  await author.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await author.addInitScript(spyOnClipboardWrites);
  await routeTower(author, state);
  const page = await author.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  step('seed author');
  const authorKey = await bounded(seed(page), 'seed author', 30_000);
  step('open canvas by local key');
  // Ordinary local-key canvas links keep working.
  await page.goto(`/canvas.html?workspacekey=${encodeURIComponent(authorKey)}&canvasid=${canvasId}`);
  await expect(page.locator('.canvas-toolbar h1')).toHaveText('Roadmap');

  // Copy reference from the nearby naplet's cog menu (keyboard reachable).
  step('copy reference');
  await page.bringToFront();
  const cog = naplet(page, nearId).getByRole('button', { name: 'Window options', exact: true });
  await cog.click();
  await naplet(page, nearId).getByRole('menuitem', { name: 'Copy reference' }).click();
  await expect(page.locator('.canvas-notice')).toHaveText('Reference copied. Paste it into chat or a document.');
  const copiedNear = await lastCopied(page);
  expect(copiedNear).toBe(`[Nearby list · Roadmap](${baseURL}/canvas.html?workspaceid=${workspaceId}&canvasid=${canvasId}&napletid=${nearId})`);
  // Restricted placeholders have no reference to copy.
  await naplet(page, deniedId).getByRole('button', { name: 'Window options', exact: true }).click();
  await expect(naplet(page, deniedId).getByRole('menuitem', { name: 'Copy reference' })).toBeHidden();
  await page.keyboard.press('Escape');

  // Clipboard denied: no false success; a selectable manual fallback with the same link.
  step('clipboard denied fallback');
  await bounded(page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); }), 'deny clipboard');
  await bounded(page.evaluate(() => Alpine.store('canvas').clearNotice()), 'clear notice');
  await cog.click();
  await naplet(page, nearId).getByRole('menuitem', { name: 'Copy reference' }).click();
  const fallback = page.getByRole('dialog', { name: 'Copy reference' });
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole('alert')).toContainText('blocked copying');
  await expect(page.locator('.canvas-notice')).toBeHidden();
  await expect(fallback.getByLabel('Markdown link')).toHaveValue(copiedNear);
  await expect(fallback.getByLabel('Markdown link')).toBeFocused();
  expect(await bounded(fallback.getByLabel('Markdown link').evaluate(field => field.selectionEnd - field.selectionStart), 'read selection')).toBe(copiedNear.length);
  await expect(fallback.getByLabel('Browser URL')).toHaveValue(copiedNear.match(/\((.*)\)$/)[1]);
  await fallback.getByRole('button', { name: 'Try copying again' }).click();
  await expect(fallback.getByRole('alert')).toContainText('still blocked');
  await fallback.getByRole('button', { name: 'Close' }).click();
  await expect(fallback).toBeHidden();
  await expect(page.locator('.canvas-reference-dialog textarea')).toHaveValue('');
  // Losing access to the canvas closes any fallback and keeps nothing on screen.
  step('fallback closes when canvas access is lost');
  await cog.click();
  await naplet(page, nearId).getByRole('menuitem', { name: 'Copy reference' }).click();
  await expect(fallback).toBeVisible();
  state.canvasDenied = true;
  await bounded(page.evaluate(() => Alpine.store('canvas').refresh()), 'refresh denied canvas');
  await expect(page.locator('.canvas-status h1')).toHaveText('Canvas unavailable');
  await expect(fallback).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Nearby list');
  state.canvasDenied = false;
  expect(state.writes).toEqual([]);

  // Another browser profile/identity has a different local workspace key for the same workspace.
  step('open reference in another profile');
  const reader = await browser.newContext({ baseURL, viewport: { width, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  openContexts.push(reader);
  await routeTower(reader, state);
  const other = await reader.newPage();
  other.on('pageerror', error => errors.push(String(error)));
  const readerKey = await bounded(seed(other), 'seed reader', 30_000);
  expect(readerKey).not.toBe(authorKey);
  const reference = `/canvas.html?workspaceid=${workspaceId}&canvasid=${canvasId}&napletid=${targetId}`;
  await other.goto(reference);
  step('reference opened');
  const target = naplet(other, targetId);
  await expect(target).toHaveClass(/selected/);
  await expect(target).toHaveClass(/reference-target/);
  await expect(target).toBeFocused();
  step('target selected and focused');
  await expect.poll(() => stageCentreOffset(other, targetId)).toMatchObject({ visible: true });
  const offset = await bounded(stageCentreOffset(other, targetId), 'measure offset');
  expect(offset.dx).toBeLessThan(4); expect(offset.dy).toBeLessThan(4);
  step('target centred');
  // An oversized target is zoomed out viewer-locally to fit; small screens never zoom in.
  const scale = await bounded(other.evaluate(() => Alpine.store('canvas').viewport.scale), 'read scale');
  // 800×460 in a 390px phone stage fits at ~0.43, well above the 0.2 zoom floor.
  if (width > 400) expect(scale).toBe(1); else { expect(scale).toBeLessThan(0.5); expect(scale).toBeGreaterThan(0.35); }
  await expect(target.getByRole('button', { name: 'Window options', exact: true })).toBeInViewport();
  step('target controls in view');
  await expect(target).not.toHaveClass(/reference-target/, { timeout: 5000 });
  // Refreshing the snapshot neither refocuses nor resets the viewer-local view.
  step('refresh keeps viewer-local view');
  await other.locator('.canvas-toolbar').getByRole('button', { name: 'Refresh' }).click();
  await expect(other.locator('.canvas-toolbar h1')).toHaveText('Roadmap');
  // Focus is not moved back to the referenced naplet (the toolbar hides while loading, so Refresh may lose focus).
  await expect(target).not.toBeFocused();
  await expect(target).not.toHaveClass(/reference-target/);
  expect((await bounded(stageCentreOffset(other, targetId), 'measure refreshed offset')).visible).toBe(true);
  expect(await bounded(other.evaluate(() => Alpine.store('canvas').viewportLocal), 'read viewportLocal')).toBe(true);
  // Opening the link wrote nothing: no viewport, layout or selection persisted.
  await other.waitForTimeout(500);
  expect(state.writes).toEqual([]);

  // A minimised target is restored when a reference focuses it.
  step('restore minimised target');
  await target.getByRole('button', { name: 'Minimise window', exact: true }).click();
  await expect(target).toHaveClass(/window-minimised/);
  await bounded(other.evaluate(id => { const store = Alpine.store('canvas'); store.reference = { napletId: id, requested: true, handled: false }; store.focusReferenceTarget(); }, targetId), 'focus minimised target');
  await expect(target).not.toHaveClass(/window-minimised/);

  // Missing, restricted and malformed targets share one non-disclosing message; the canvas still opens.
  step('generic unavailable targets');
  const generic = 'The referenced item is unavailable. It may have been removed, or you may not have access.';
  for (const [label, prepare, napletId] of [
    ['removed', () => { state.targetRemoved = true; }, targetId],
    ['restricted target', () => { state.targetRemoved = false; state.targetDenied = true; }, targetId],
    ['restricted placeholder', () => { state.targetDenied = false; }, deniedId],
    ['malformed', () => {}, '<script>x</script>'],
  ]) {
    prepare();
    await other.goto(`/canvas.html?workspaceid=${workspaceId}&canvasid=${canvasId}&napletid=${encodeURIComponent(napletId)}`);
    await expect(other.locator('.canvas-toast'), label).toHaveText(generic);
    await expect(other.locator('.canvas-toolbar h1')).toHaveText('Roadmap');
    await expect(other.locator('body')).not.toContainText('Protected');
    await expect(other.locator('body')).not.toContainText('channel-secret');
    await expect(other.locator('.canvas-naplet.selected')).toHaveCount(0);
  }
  // Denied canvas and unknown workspace stay neutral.
  step('denied canvas and unknown workspace');
  state.canvasDenied = true;
  await other.goto(reference);
  await expect(other.locator('.canvas-status')).toContainText('Canvas unavailable.');
  state.canvasDenied = false;
  await other.goto(`/canvas.html?workspaceid=99999999-0000-4000-8000-000000000000&canvasid=${canvasId}&napletid=${targetId}`);
  await expect(other.locator('.canvas-status')).toContainText('Open this workspace in Ambulando');
  // Browser history between references is ordinary navigation; going back revalidates current authority.
  step('back navigation');
  await other.goBack();
  await expect(other.locator('.canvas-toolbar h1')).toHaveText('Roadmap');
  await expect(naplet(other, targetId)).toHaveClass(/selected/);
  expect(state.writes).toEqual([]);
  expect(errors).toEqual([]);
  console.log('CANVAS_REFERENCE_EVIDENCE', JSON.stringify({ width, scale, copied: true, clipboardDeniedFallback: true, otherLocalKey: true, focused: true, centred: offset, viewportWrites: 0, refocusOnRefresh: false, generic: 4 }));
});
