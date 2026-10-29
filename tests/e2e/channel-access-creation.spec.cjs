const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test.use({ serviceWorkers: 'block' });
for (const width of [1200, 390]) {
  test(`channel creation and creator access editing at ${width}px preserve explicit authority`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = buildGroupsAccessFixture();
    const manager = ['channel.read', 'channel.write', 'channel.manage', 'channel.grants.read', 'channel.grants.manage',
      'task.read', 'task.create', 'task.update', 'task.comment', 'comment.create', 'doc.read', 'doc.write',
      'file.read', 'file.write', 'audio_note.read', 'audio_note.write'];
    let grants = [{ principal_type: 'person', principal_id: fixture.viewer.actor_id,
      principal: { npub: fixture.viewer.npub, display_name: fixture.viewer.name }, permissions: [...manager, 'channel.grant'] }];
    const creates = [], changes = [];
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      if (url.pathname.endsWith('/scopes/scope-beacon/channels') && request.method() === 'POST') {
        creates.push(request.postDataJSON());
        return route.fulfill({ json: { channel: { id: 'created-research', workspace_id: 'groups-access-workspace',
          scope_id: 'scope-beacon', name: 'Research', kind: 'channel', metadata: {}, row_version: 1 } } });
      }
      if (/\/channels\/ch-architecture\/grants(?:\/actor\/actor-manager)?$/.test(url.pathname)) {
        if (request.method() === 'GET') return route.fulfill({ json: { grants } });
        const body = request.postDataJSON(); changes.push(body);
        grants = [{ ...grants[0], access_level: body.access_level, permissions: ['channel.read', 'channel.write',
          'task.read', 'task.create', 'task.update', 'task.comment', 'comment.create', 'doc.read', 'doc.write',
          'file.read', 'file.write', 'audio_note.read', 'audio_note.write'] }];
        return route.fulfill({ json: { grants } });
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')));
    await page.evaluate(() => { window.channelAccessRefresh = Alpine.store('chat').refreshChannelGrants; });
    await seedGroupsAccess(page, fixture);
    await page.evaluate(async () => {
      const s = Alpine.store('chat');
      s.selectChannel = async () => {};
      await s.openNewChannelModal({ scopeId: 'scope-beacon' });
    });
    await page.getByTestId('new-channel-name-input').fill('Research');
    const creatorIndex = await page.evaluate(() => Alpine.store('chat').newChannelAccessRows.findIndex(row => row.principal_id === 'actor-manager'));
    expect(creatorIndex).toBeGreaterThanOrEqual(0);
    await page.getByTestId(`new-channel-permission-capacity-${creatorIndex}`).selectOption('viewer');
    await expect(page.getByTestId(`new-channel-permission-capacity-${creatorIndex}`)).toHaveValue('manager');
    await page.getByTestId('new-channel-create').click();
    await expect.poll(() => creates.length).toBe(1);
    expect(creates[0].grants.find(row => row.principal_id === 'actor-manager').access_level).toBe('manage');
    await page.evaluate(() => {
      const s = Alpine.store('chat'); s.refreshChannelGrants = window.channelAccessRefresh;
      s.openChannelSettings('ch-architecture');
    });
    const dialog = page.locator('[x-show="$store.chat.showChannelSettingsModal"]');
    const level = dialog.locator('.channel-grant-capacity-select:visible');
    await expect(level).toHaveValue('manager');
    await level.selectOption('contributor');
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toEqual({ access_level: 'contribute' });
    await expect(level).toHaveValue('contributor');
    expect(grants[0].permissions).not.toContain('channel.grants.manage');
    expect(grants[0].permissions).not.toContain('channel.grant');
  });
}
