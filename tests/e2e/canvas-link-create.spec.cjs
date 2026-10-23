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


for (const width of [1440, 390]) for (const lostResponse of [false, true]) test(`create canvas in link picker preserves drafts, cancellation and recovery ${width} lost=${lostResponse}`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: width === 390 ? 580 : 900 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const sourcePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`;
  const definitions = [{ id: ids[0], title: 'Overview', row_version: 1, can_manage: true, position: 1, visibility: { mode: 'workspace' } }];
  const naplets = [], posts = [], links = [];
  let rejectCreate = false, failList = false, delayCreate = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__canvas-seed.js') return route.fulfill({ contentType: 'text/javascript', body: seedBundle });
    if (url.pathname === '/__canvas-seed.html') return route.fulfill({ contentType: 'text/html', body: '<title>Seed</title>' });
    if (url.pathname.endsWith('/members')) return json({ identity, members: [{ actor: { id: 'actor-reader', npub: 'npub1fixture', kind: 'human', display_name: 'Reader' } }] });
    if (url.pathname.endsWith('/groups')) return json({ identity, groups: [{ id: 'group-delivery', name: 'Delivery team' }] });
    if (!url.pathname.startsWith(sourcePath)) return process.env.SOL_RUNTIME_ASSETS === '1' ? route.continue() : serveBuiltFlightDeck(route);
    expect(request.headers().authorization).toMatch(/^Nostr /);
    const parts = url.pathname.slice(sourcePath.length).split('/').filter(Boolean);
    if (!parts.length) {
      if (request.method() === 'GET') return failList ? json({ error: 'list_unavailable' }, 503) : json({ workspace_id: workspaceId, identity, complete: true, canvases: definitions });
      const body = request.postDataJSON(); posts.push(body);
      if (rejectCreate) return json({ error: 'creation_denied', message: 'Creation denied' }, 403);
      if (delayCreate) await new Promise(resolve => setTimeout(resolve, 250));
      const created = { id: ids[1], ...body, row_version: 1, can_manage: true, position: 2 };
      definitions.push(created); failList = true;
      return lostResponse ? route.abort('failed') : json({ workspace_id: workspaceId, identity, canvas: created }, 201);
    }
    if (parts[1] === 'snapshot') return json({ workspace_id: workspaceId, identity, complete: true, canvas: definitions[0], naplets, elements: [], comments: [] });
    if (parts[1] === 'naplets' && request.method() === 'POST') {
      const body = request.postDataJSON(); links.push(body);
      naplets.push({ id: 'new-link', ...body, access: 'ready', row_version: 1, content: { title: 'New canvas' } });
      return json({ naplet: naplets[0] });
    }
    return json({});
  });
  const key = await seedSessionAndWorkspace(page);
  await page.goto('/canvas.html?' + new URLSearchParams({ workspacekey: key, canvasid: ids[0] }));
  await expect(page.locator('.canvas-brand h1')).toHaveText('Overview');
  await page.getByRole('button', { name: 'Add naplet', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Add naplet', exact: true });
  await picker.locator('select').first().selectOption('canvas');
  await expect(picker).toContainText('No other accessible canvases.');
  await picker.getByLabel('Find a source').fill('old query');
  await picker.getByLabel('Label (optional)').fill('Keep this label');
  const create = picker.getByRole('button', { name: 'Create new canvas', exact: true });
  await create.focus(); await create.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create canvas', exact: true });
  await expect(dialog.getByLabel('Canvas name')).toBeFocused();
  await dialog.getByLabel('Canvas name').fill('Cancelled draft');
  await dialog.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(create).toBeFocused();
  await expect(picker.getByLabel('Find a source')).toHaveValue('old query');
  await expect(picker.getByLabel('Label (optional)')).toHaveValue('Keep this label'); expect(posts).toHaveLength(0);
  await create.click(); await dialog.getByLabel('Canvas name').fill('New canvas');
  await dialog.getByText('Specific people, agents or groups', { exact: true }).click();
  const combo = dialog.getByRole('combobox'); await combo.fill('Delivery');
  await dialog.getByRole('option', { name: /Delivery team/ }).click();
  await expect(dialog.getByRole('button', { name: 'Remove Delivery team' })).toBeVisible();
  await expect(dialog.locator('.canvas-principal-refresh-error')).toBeHidden();
  const geometry = await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, overflow:node.scrollWidth > node.clientWidth }; });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width); expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(width === 390 ? 580 : 900); expect(geometry.overflow).toBe(false);
  await page.screenshot({ path: `tmp/docs/handoffs/canvas-link-create-${width}.png` });
  rejectCreate = true; await dialog.getByRole('button', { name: 'Create canvas', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByLabel('Canvas name')).toHaveValue('New canvas');
  rejectCreate = false; delayCreate = true;
  await dialog.getByRole('button', { name: 'Create canvas', exact: true }).click();
  await dialog.getByLabel('Canvas name').press('Enter');
  await expect(dialog.getByRole('button', { name: 'Check canvas list', exact: true })).toBeVisible();
  expect(posts).toHaveLength(2); expect(posts[1]).toEqual({ title: 'New canvas', visibility: { mode: 'restricted', actor_ids: [], group_ids: ['group-delivery'] } });
  failList = false; await dialog.getByRole('button', { name: 'Check canvas list', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(create).toBeFocused();
  if (lostResponse) {
    await expect(picker.getByRole('status')).toContainText('Creation could not be confirmed');
    await create.click(); await expect(dialog.getByRole('button', { name:'Check canvas list', exact:true })).toBeVisible();
    await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
    await picker.getByLabel('Find a source').fill('New canvas');
    await picker.getByRole('button', { name:'New canvas', exact:true }).click();
    await create.click(); await expect(dialog.getByRole('button', { name:'Create canvas', exact:true })).toBeVisible();
    await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
    await picker.getByLabel('Find a source').fill('old query');
  } else await expect(picker.getByRole('status')).toContainText('Selected New canvas');
  await expect(picker.getByLabel('Find a source')).toHaveValue('old query'); await expect(picker.getByLabel('Label (optional)')).toHaveValue('Keep this label');
  await picker.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(picker).toBeHidden(); await expect(page.locator('.canvas-link-card h2')).toHaveText('New canvas');
  expect(posts).toHaveLength(2); expect(links).toHaveLength(1); expect(links[0]).toMatchObject({ source: { type:'canvas', id:ids[1] }, title:'Keep this label' });
  expect(errors).toEqual([]);
});
