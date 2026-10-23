const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { generateSecretKey, getPublicKey, nip19, finalizeEvent, verifyEvent } = require('nostr-tools');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Real DOM handlers, command service, API signing and IndexedDB. Only Tower's
// HTTP responses are simulated; this is not a live Tower authorization test.
test('scope drag and menu saves sign current revisions, acknowledge, recover and survive reload', async ({ page }) => {
  test.setTimeout(45000);
  const secret = generateSecretKey(), pubkey = getPublicKey(secret);
  const fixture = buildGroupsAccessFixture();
  fixture.viewer.npub = nip19.npubEncode(pubkey);
  fixture.scopes = fixture.scopes.map(row => ({ ...row, level: 'l1', record_state: 'active' }));
  let server = { workspace_id: 'groups-access-workspace', actor_id: fixture.viewer.actor_id, scope_ids: fixture.scopes.map(row => row.record_id), row_version: 7 };
  let reject = '';
  const titles = Object.fromEntries(fixture.scopes.map(row => [row.record_id, row.title]));
  const writes = [], reads = [];
  await page.exposeFunction('signOrderingEvent', event => finalizeEvent(event, secret));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/me/scope-order')) {
      const event = JSON.parse(Buffer.from(request.headers().authorization.slice(6), 'base64').toString());
      expect(verifyEvent(event)).toBe(true); expect(event.pubkey).toBe(pubkey);
      expect(event.tags).toContainEqual(['u', request.url()]);
      expect(event.tags).toContainEqual(['method', request.method()]);
      if (request.method() === 'GET') { reads.push(server.row_version); return route.fulfill({ json: { scope_order: server } }); }
      const body = request.postDataJSON(); writes.push(body);
      expect(event.tags).toContainEqual(['payload', createHash('sha256').update(request.postData()).digest('hex')]);
      if (reject) return route.fulfill({ status: reject === 'scope_order_conflict' ? 409 : 403, json: { error: reject } });
      if (body.expected_row_version !== server.row_version) return route.fulfill({ status: 409, json: { error: 'scope_order_conflict' } });
      server = { ...server, scope_ids: body.scope_ids, row_version: server.row_version + 1 };
      return route.fulfill({ json: { scope_order: server } });
    }
    return serveBuiltFlightDeck(route);
  });
  const source = `
import {liveQuery} from 'dexie';
import {openWorkspaceDb} from './src/db.js';
window.observeSavedOrder = async actor => {
 const db = openWorkspaceDb('groups-access-workspace'); await db.open(); window.orderDb=db;
 window.orderSubscription=liveQuery(()=>db.scope_orders.get(actor)).subscribe(row=>{
  if(!window.pauseOrderProjection) Alpine.store('chat').personalScopeOrder=row||null;
 });
};`;
  const bundle = await build({ stdin: { contents: source, resolveDir: path.resolve(__dirname, '../..') }, bundle: true, write: false, format: 'iife', logLevel: 'silent', define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') } });
  async function boot() {
    await seedGroupsAccess(page, fixture);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async ({ actor, pubkey }) => {
      localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method:'extension',pubkey,createdAt:Date.now(),expiresAt:Date.now()+600000 }));
      window.nostr={getPublicKey:async()=>pubkey,signEvent:event=>window.signOrderingEvent(event)};
      const s=Alpine.store('chat'); s.settingsTab='scopes'; s.personalScopeOrder=null;
      await window.observeSavedOrder(actor);
    }, { actor: fixture.viewer.actor_id, pubkey });
  }
  const card = id => page.locator(`#scope-${id}`);
  const labels = page.locator('.scope-cards > .scope-card .scope-card-title');
  async function move(id, direction) {
    const toggle = card(id).getByRole('button', { name: 'Scope actions', exact: true });
    const action = card(id).getByRole('button', { name: `Move scope ${titles[id]} ${direction}`, exact: true });
    // Wait for Alpine's previous close transition before opening again.
    await expect(action).toBeHidden();
    await toggle.click();
    await action.click();
    await expect(action).toBeHidden();
  }
  const busy = () => page.evaluate(() => Alpine.store('chat').scopeOrderSaving);
  const saved = async revision => {
    await expect.poll(busy,{timeout:5000}).toBe(false);
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').personalScopeOrder?.row_version)).toBe(revision);
    expect(await page.evaluate(() => Alpine.store('chat').scopeOrderError)).toBe('');
  };
  await page.goto('/'); await boot();
  // No successful preference is seeded locally. The first write must read rev7.
  await move('scope-devops', 'up'); await saved(8);
  await expect(labels).toHaveText(['Dev Ops', 'Beacon', 'Wingman Suite']);
  await card('scope-suite').dragTo(card('scope-devops')); await saved(9);
  await expect(labels).toHaveText(['Wingman Suite', 'Dev Ops', 'Beacon']);
  await move('scope-suite', 'down'); await saved(10);
  expect(writes.map(row => row.expected_row_version)).toEqual([7,8,9]);
  expect(new Set(writes.map(row => row.mutation_id)).size).toBe(3);
  await page.reload(); await boot();
  await expect(labels).toHaveText(['Dev Ops', 'Wingman Suite', 'Beacon']);
  expect(await page.evaluate(async actor => (await orderDb.scope_orders.get(actor)).row_version, fixture.viewer.actor_id)).toBe(10);
  // A delayed visible projection must not become the next write's revision.
  await page.evaluate(() => { window.pauseOrderProjection=true; Alpine.store('chat').personalScopeOrder=null; });
  await move('scope-devops','up');
  await expect.poll(busy).toBe(false);
  expect(writes.at(-1).expected_row_version).toBe(10);
  await page.evaluate(async actor => { window.pauseOrderProjection=false; Alpine.store('chat').personalScopeOrder=await orderDb.scope_orders.get(actor); }, fixture.viewer.actor_id);
  await saved(11);
  reject='scope_order_conflict';
  await move('scope-devops','down');
  await expect.poll(busy).toBe(false);
  expect(await page.evaluate(() => Alpine.store('chat').scopeOrderError)).toContain('another session');
  expect(await page.evaluate(() => Alpine.store('chat').scopeOrderNotice)).toBe('');
  reject='permission_denied'; await move('scope-devops','down');
  await expect.poll(busy).toBe(false);
  expect(await page.evaluate(() => Alpine.store('chat').scopeOrderError)).toContain('permission_denied');
  reject=''; await move('scope-devops','down'); await saved(12);
  expect(reads.length).toBeGreaterThan(writes.length); // conflict recovery read
  const persisted = [...server.scope_ids];
  await page.evaluate(() => { const s=Alpine.store('chat');s.session={npub:'another-reader'}; });
  await move('scope-devops','down'); await expect.poll(busy).toBe(false);
  expect(server.scope_ids).toEqual(persisted); expect(server.row_version).toBe(12);
  await page.reload(); await boot();
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').personalScopeOrderIds)).toEqual(persisted);
});
