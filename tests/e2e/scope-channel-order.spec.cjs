const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test('scope channel drag and keyboard moves persist, isolate and recover', async ({ page }) => {
  test.setTimeout(60000);
  const fixture = buildGroupsAccessFixture();
  fixture.scopes = fixture.scopes.map(s => ({ ...s, level: 'l1', record_state: 'active' }));
  fixture.channels = fixture.channels.map((c, index) => ({ ...c, position: index + 1 }));
  let fail = false;
  const writes = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/reorder')) {
      const id = url.pathname.split('/').at(-2);
      const { position } = route.request().postDataJSON();
      writes.push([id, position]);
      if (fail) return route.fulfill({ status: 403, json: { error: { message: 'Manage permission revoked' } } });
      const source = fixture.channels.find(c => c.record_id === id);
      const siblings = fixture.channels.filter(c => c.scope_id === source.scope_id).sort((a,b) => a.position - b.position);
      siblings.splice(siblings.indexOf(source), 1); siblings.splice(position - 1, 0, source);
      siblings.forEach((c,i) => { c.position = i + 1; });
      return route.fulfill({ json: { channel: { id, title: source.title, scope_id: source.scope_id, position }, position, changed: true } });
    }
    return serveBuiltFlightDeck(route);
  });
  async function open() {
    await page.goto('/'); await seedGroupsAccess(page, fixture);
    await page.evaluate(() => { const s = Alpine.store('chat'); s.settingsTab = 'scopes'; s.selectedChannelId = 'ch-gateway'; });
    await page.getByRole('button', { name: 'Expand scope Beacon', exact: true }).click();
  }
  await open();
  const rows = page.locator('#scope-scope-beacon .scope-setup-channel-row');
  const labels = () => rows.locator(':scope > span').allTextContents();
  await rows.filter({ hasText: 'dialogue' }).dragTo(rows.filter({ hasText: 'gateway' }));
  await expect(page.locator('#scope-scope-beacon [role=status]').last()).toHaveText('Channel order saved.');
  expect(await labels()).toEqual(['architecture', 'gateway', 'dialogue', 'Build']);
  expect(writes).toEqual([['ch-dialogue', 3]]);
  expect(await page.evaluate(() => Alpine.store('chat').selectedChannelId)).toBe('ch-gateway');
  await page.getByRole('button', { name: 'Move dialogue up', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(rows.locator(':scope > span')).toHaveText(['architecture', 'dialogue', 'gateway', 'Build']);
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').channelOrderBusy)).toBe(false);
  await expect.poll(() => writes.length).toBe(2);
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').channelOrderBusy)).toBe(false);
  await page.reload(); await seedGroupsAccess(page, fixture);
  await page.evaluate(() => { Alpine.store('chat').settingsTab = 'scopes'; });
  await page.getByRole('button', { name: 'Expand scope Beacon', exact: true }).click();
  expect(await labels()).toEqual(['architecture', 'dialogue', 'gateway', 'Build']);
  fail = true;
  await page.getByRole('button', { name: 'Move dialogue up', exact: true }).click();
  await expect(page.locator('#scope-scope-beacon [role=alert]')).toContainText('Previous order restored');
  expect(await labels()).toEqual(['architecture', 'dialogue', 'gateway', 'Build']);
  expect(fixture.channels.find(c => c.record_id === 'ch-mini').position).toBe(5);
  expect(await page.evaluate(() => Alpine.store('chat').draggedScopeId)).toBeFalsy();
  fail = false;
  await page.getByRole('button', { name: 'Move dialogue up', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Alpine.store('chat').channelOrderBusy)).toBe(false);
  await expect(rows.locator(':scope > span')).toHaveText(['dialogue', 'architecture', 'gateway', 'Build']);
  expect(writes).toEqual([['ch-dialogue', 3], ['ch-dialogue', 2], ['ch-dialogue', 1], ['ch-dialogue', 1]]);
  expect(await page.evaluate(() => Alpine.store('chat').channelOrderError)).toBe('');
  await page.reload(); await seedGroupsAccess(page, fixture);
  await page.evaluate(() => { Alpine.store('chat').settingsTab = 'scopes'; });
  await page.getByRole('button', { name: 'Expand scope Beacon', exact: true }).click();
  await expect(rows.locator(':scope > span')).toHaveText(['dialogue', 'architecture', 'gateway', 'Build']);
});
