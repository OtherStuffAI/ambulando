const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test.use({ serviceWorkers: 'block' });
for (const width of [1280, 390]) {
  test(`channel move requires access preview and exact safe retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = buildGroupsAccessFixture();
    const writes = [];
    let attempts = 0;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      if (url.pathname.endsWith('/channels/ch-dialogue/move-preview')) {
        writes.push({ action: 'preview', body: request.postDataJSON() });
        return route.fulfill({ json: { preview: {
          channel_id: 'ch-dialogue', source_scope_id: 'scope-beacon', destination_scope_id: 'scope-devops', confirmation_token: 'synthetic-token',
          access_changes: { gained: [], lost: [], retained: [{ actor_id: 'actor-manager', label: 'Workspace Manager', permissions: ['channel.manage'] }], direct_grants_preserved: true, direct_grant_count: 1,
            source_scope_access: [{ label: 'Source readers', permissions: ['scope.read'] }], destination_scope_access: [{ label: 'Destination managers', permissions: ['scope.manage'] }] },
          warnings: ['Scope grants do not grant inherited channel content access. Direct grants remain unchanged.'],
        } } });
      }
      if (url.pathname.endsWith('/channels/ch-dialogue/move')) {
        writes.push({ action: 'move', body: request.postDataJSON() });
        if (++attempts === 1) return route.abort('failed');
        return route.fulfill({ json: { channel: { id: 'ch-dialogue', workspace_id: 'groups-access-workspace', scope_id: 'scope-devops', name: 'dialogue', kind: 'channel', updated_at: new Date().toISOString() }, move: { source_scope_id: 'scope-beacon', destination_scope_id: 'scope-devops', mutation_id: request.postDataJSON().mutation_id } } });
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/');
    await seedGroupsAccess(page, fixture);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.navSection = 'chat'; s.settingsTab = ''; s.showSettings = false;
      s.selectedChannelId = 'ch-dialogue';
      s.openChannelSettings('ch-dialogue');
    });
    const panel = page.getByTestId('channel-move-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Confirm move to scope' })).toHaveCount(0);
    await panel.getByLabel('Move to scope', { exact: true }).selectOption('scope-devops');
    expect(writes).toHaveLength(0);
    await panel.getByRole('button', { name: 'Preview move', exact: true }).click();
    await expect(panel.getByTestId('channel-move-preview')).toContainText('Direct channel grants preserved (1)');
    await expect(panel).toContainText('Source readers: View scope');
    await expect(panel).toContainText('Destination managers: Manage scope');
    await expect(panel).toContainText('Scope grants do not grant inherited channel content access');
    expect(writes).toHaveLength(1);
    await panel.getByRole('button', { name: 'Confirm move to scope', exact: true }).click();
    const retry = panel.getByRole('button', { name: 'Retry same move', exact: true });
    await expect(retry).toBeVisible();
    await expect(panel.getByLabel('Move to scope', { exact: true })).toBeDisabled();
    await retry.click();
    await expect(panel.getByRole('status')).toContainText('Channel moved');
    expect(writes.filter(write => write.action === 'move')).toHaveLength(2);
    expect(writes[1].body).toEqual(writes[2].body);
    expect(writes[1].body).toMatchObject({ destination_scope_id: 'scope-devops', confirmation_token: 'synthetic-token' });
    expect(writes[1].body.mutation_id).toMatch(/^[0-9a-f-]{36}$/);
  });
}
