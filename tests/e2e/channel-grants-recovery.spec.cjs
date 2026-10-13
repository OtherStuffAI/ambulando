const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test('open channel settings recover from a transient Tower outage without grant writes', async ({ page }) => {
  const state = { reads: 0, writes: 0, unavailable: true };
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    if (/\/channels\/ch-architecture\/grants$/.test(url.pathname)) {
      if (request.method() !== 'GET') { state.writes++; return route.abort(); }
      state.reads++;
      return route.fulfill({ status: state.unavailable ? 502 : 200, contentType: 'application/json',
        body: JSON.stringify(state.unavailable
          ? { error: { message: 'Tower startup migrations unavailable', retryable: true } }
          : { grants: [{ principal_type: 'group', principal_id: 'group-agents', access_level: 'view' }] }) });
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')));
  await page.evaluate(() => { window.grantsRefreshForRecoveryTest = window.Alpine.store('chat').refreshChannelGrants; });
  await seedGroupsAccess(page, buildGroupsAccessFixture());
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.refreshChannelGrants = window.grantsRefreshForRecoveryTest;
    s.openChannelSettings('ch-architecture');
  });
  const dialog = page.locator('[x-show="$store.chat.showChannelSettingsModal"]');
  await expect(dialog.locator('[x-text="$store.chat.channelGrantsError"]')).toHaveText('Tower startup migrations unavailable');
  await expect(dialog.locator('.channel-grants-empty').last()).toContainText('Temporary connection failures retry automatically');
  expect(state.reads).toBe(1);
  state.unavailable = false;
  await expect(dialog.locator('.channel-grants-list')).toBeVisible();
  await expect(dialog.locator('[x-text="$store.chat.channelGrantsError"]')).toBeHidden();
  expect(state.reads).toBe(2);
  await page.waitForTimeout(2500);
  expect(state.reads).toBe(2);
  expect(state.writes).toBe(0);
  await expect(dialog).toBeVisible();
});
