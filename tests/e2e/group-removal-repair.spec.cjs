const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Production built dialog/store with synthetic members and blocked backend.
// This proves visible failure/retained intent, not signed Tower authorization.
test('unresolved mixed group edits retain the dialog, selected members and actionable error', async ({ page }) => {
  const writes = [];
  await page.route('**/*', route => {
    if (['POST','DELETE','PUT','PATCH'].includes(route.request().method())) writes.push(route.request().url());
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  const fixture = buildGroupsAccessFixture();
  await seedGroupsAccess(page, fixture);
  await page.evaluate(fx => {
    const s = window.Alpine.store('chat');
    s.openEditGroupModal('group-team');
    // Keep manager and Kato; remove unresolved Holly while adding Brick.
    s.editGroupMembers = [fx.people[0],fx.people[1],fx.people[3]].map(p => ({npub:p.npub}));
    s.pgWorkspaceMembers = s.pgWorkspaceMembers.filter(p => p.actor_id !== 'actor-holly');
  }, fixture);
  const dialog = page.getByRole('dialog', {name:'Edit group',exact:true});
  await expect(dialog).toBeVisible();
  const before = await page.evaluate(() => window.Alpine.store('chat').editGroupMembers.map(m => m.npub));
  await dialog.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('member identity is unavailable');
  await expect(dialog.getByRole('alert')).toContainText('Refresh the workspace members and retry');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
  expect(await page.evaluate(() => window.Alpine.store('chat').editGroupMembers.map(m => m.npub))).toEqual(before);
  expect(writes).toEqual([]);
});
