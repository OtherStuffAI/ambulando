const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Synthetic UI check. Tower authorization and durable reuse are exercised by
// Tower's authenticated database/API tests, not by this browser fixture.
test('New DM offers the current member as Note to self', async ({ page }) => {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  const fixture = buildGroupsAccessFixture();
  await seedGroupsAccess(page, fixture);
  await page.evaluate(async () => {
    const s = window.Alpine.store('chat');
    const dm = { record_id:'scope-self-notes', title:'DMs', pg_kind:'dm', record_state:'active' };
    s.scopes = [...s.scopes,dm]; s.selectedBoardId = dm.record_id; s.selectedChannelId = null;
    s.refreshTowerPgWorkspaceMembers = async () => s.pgWorkspaceMembers;
    await s.openNewChannelModal({ scopeId:dm.record_id });
  });
  const dialog = page.locator('[x-show="$store.chat.showNewChannelModal"]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name:/Note to self/ }).click();
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').newChannelDmNpub)).toBe(fixture.viewer.npub);
  await expect(dialog.getByTestId('new-channel-create')).toBeEnabled();
});
