const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

test.use({ serviceWorkers: 'block' });
for (const width of [1280, 390]) {
  test(`workspace member identity, explicit role and removal confirmation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = buildGroupsAccessFixture();
    const person = fixture.people.find(person => person.kind === 'agent');
    const actor = { id: person.actor_id, npub: person.npub, display_name: 'Canonical Orion', kind: 'human' };
    const writes = [];
    let enabled = false;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      const match = url.pathname.match(/\/members\/([^/]+)\/(access|removal-preview|remove|agent-manager)$/);
      if (match) {
        expect(match[1]).toBe(actor.id);
        if (match[2] === 'access') return route.fulfill({ json: { actor, membership: { role: 'member' }, agent_manager: enabled, can_administer: true, coverage: { workspace: [{ permission: 'workspace.manage', allowed: enabled }], scopes: [{ id: 'scope-a', name: 'Scope A', permissions: [{ permission: 'scope.manage', allowed: enabled }] }], channels: [{ id: 'channel-a', name: 'Private A', permissions: [{ permission: 'channel.read', allowed: enabled }] }] } } });
        if (match[2] === 'removal-preview') return route.fulfill({ json: { preview: { actor, groups: [{ id: 'group-a', name: 'Agents' }], direct_grants: [{ id: 'grant-a', permission: 'channel.read', resource_channel_id: 'channel-a' }], agent_manager: enabled, confirmation_token: 'synthetic-token', blocked_reason: null, consequences: ['Historical messages and authorship are preserved.'] } } });
        writes.push({ action: match[2], body: request.postDataJSON() });
        if (match[2] === 'agent-manager') enabled = request.postDataJSON().enabled;
        return route.fulfill({ json: { actor, removed: match[2] === 'remove', agent_manager: enabled } });
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/');
    await seedGroupsAccess(page, fixture);
    await page.evaluate(({ npub }) => {
      const s = Alpine.store('chat');
      s.pgWorkspaceMembers = s.pgWorkspaceMembers.map(member => member.npub === npub ? { ...member, display_name: 'Canonical Orion' } : member);
      s.chatProfiles = { ...s.chatProfiles, [npub]: { name: 'WRONG OLD ORION' } };
    }, { npub: actor.npub });
    const row = page.getByRole('list', { name: 'Workspace members' }).getByRole('listitem').filter({ hasText: 'Canonical Orion' });
    await expect(row).toContainText(actor.npub);
    await expect(row).not.toContainText('WRONG OLD ORION');
    await row.getByRole('button', { name: 'Inspect access' }).click();
    const panel = page.getByTestId('workspace-member-admin');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(actor.npub);
    await expect(panel).toContainText('Denied');
    await expect(panel).toContainText('including private channels');
    const assign = panel.getByRole('button', { name: 'Assign agent-manager role' });
    await expect(assign).toBeDisabled();
    await panel.getByLabel('I intend to change this exact member’s workspace-wide role.').check();
    await panel.getByLabel('Type the member’s full npub').fill('WRONG OLD ORION');
    await expect(assign).toBeDisabled();
    await panel.getByLabel('Type the member’s full npub').fill(actor.npub);
    await assign.click();
    await expect(panel.getByRole('button', { name: 'Revoke agent-manager role' })).toBeVisible();
    expect(writes).toEqual([{ action: 'agent-manager', body: { enabled: true, confirm_npub: actor.npub } }]);
    await panel.getByRole('button', { name: 'Preview removal' }).click();
    const remove = panel.getByRole('button', { name: 'Confirm remove from workspace' });
    await expect(panel).toContainText('Historical messages and authorship are preserved.');
    await expect(panel).toContainText('Agents');
    await expect(remove).toBeDisabled();
    await panel.getByLabel('Type this member’s full npub to confirm removal').fill(actor.npub);
    await remove.click();
    await expect(panel).toBeHidden();
    expect(writes[1]).toEqual({ action: 'remove', body: { confirmation_token: 'synthetic-token', confirm_npub: actor.npub } });
  });
}
