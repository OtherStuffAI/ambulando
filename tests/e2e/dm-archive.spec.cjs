const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test('DM removal has a shared-archive confirmation while rename and system removal stay protected', async ({ page }) => {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await seedGroupsAccess(page, buildGroupsAccessFixture());
  await page.evaluate(() => {
    const s = Alpine.store('chat');
    s.channels = [{ record_id: 'dm-archive', title: 'Disposable conversation', channel_type: 'dm', pg_kind: 'dm', scope_id: 'scope-beacon', record_state: 'active' }];
    s.selectedChannelId = 'dm-archive';
    s.channelSettingsChannelId = 'dm-archive';
    s.channelSettingsWorkspaceId = 'groups-access-workspace';
    s.showChannelSettingsModal = true;
  });
  const dialog = page.getByRole('dialog', { name: 'Channel settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Rename channel', exact: true })).toBeHidden();
  const remove = dialog.getByRole('button', { name: 'Delete channel', exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(dialog.getByRole('button', { name: 'Confirm delete', exact: true })).toBeVisible();
  await expect(dialog.getByText(/no longer accessible to any participant/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
  await expect(remove).toBeVisible();
  await page.evaluate(() => { const s=Alpine.store('chat');s.channels=[{...s.channels[0],metadata:{system_key:'protected'}}]; });
  await expect(remove).toBeHidden();
});
