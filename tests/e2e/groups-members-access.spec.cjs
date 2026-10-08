const { mkdirSync } = require('node:fs');
const { test, expect } = require('playwright/test');
const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

// Synthetic Tower: every request is answered by this route table. Non-loopback
// hosts are aborted, so the flow can never grant access in a real workspace.
const EVIDENCE_DIR = 'tmp/docs/handoffs/groups-access';
const AGENTS_KEY = { principal_type: 'group', principal_id: 'group-agents' };
const DENIED = { status: 403, body: { code: 'permission_denied', required_permission: 'channel.grants.manage' } };

function grantsFor(channelId) {
  if (channelId === 'ch-architecture') return [{ ...AGENTS_KEY, access_level: 'view' }];
  if (channelId === 'ch-gateway') return [{ ...AGENTS_KEY, permissions: ['channel.read', 'bespoke.permission'] }];
  if (channelId === 'ch-build') return [{ ...AGENTS_KEY, access_level: 'contribute' }];
  return [];
}

async function installTower(page, state) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      state.blocked.push(url.href);
      return route.abort();
    }
    const grants = url.pathname.match(/\/api\/v4\/flightdeck-pg\/workspaces\/[^/]+\/channels\/([^/]+)\/grants(?:\/([^/]+)\/([^/]+))?$/);
    const members = /\/api\/v4\/flightdeck-pg\/workspaces\/[^/]+\/members$/.test(url.pathname);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (grants && request.method() === 'GET') {
      state.reads.push(grants[1]);
      if (state.holdReads) await state.holdReads;
      return json(200, { grants: grantsFor(grants[1]) });
    }
    if (grants && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
      const write = { method: request.method(), channel: grants[1], principal: grants[2] ? `${grants[2]}:${grants[3]}` : null, body: request.postDataJSON() };
      state.writes.push(write);
      const deny = state.denyChannels.has(grants[1]);
      return deny ? json(DENIED.status, DENIED.body) : json(200, { grant: { ...AGENTS_KEY, ...(write.body || {}) } });
    }
    if (members && request.method() === 'POST') {
      state.memberWrites.push(request.postDataJSON());
      if (state.denyMembers) return json(DENIED.status, { code: 'permission_denied', required_permission: 'workspace.members.manage' });
      return json(200, { member: { actor: { actor_id: 'actor-new', npub: request.postDataJSON().member_npub } } });
    }
    return serveBuiltFlightDeck(route);
  });
}

for (const width of [1280, 390]) {
  test(`Groups & Members access flows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const state = { reads: [], writes: [], memberWrites: [], blocked: [], denyChannels: new Set(['ch-tower']), denyMembers: false };
    await installTower(page, state);
    await page.goto('/');
    const fixture = buildGroupsAccessFixture();
    await seedGroupsAccess(page, fixture);
    mkdirSync(EVIDENCE_DIR, { recursive: true });

    const tabs = page.getByRole('tablist', { name: 'Groups and members' });
    const membersTab = tabs.getByRole('tab', { name: /Members/ });
    await expect(membersTab).toHaveAttribute('aria-selected', 'true');

    // Members: search, rename affordance and inline add validation/permission failure.
    const memberList = page.getByRole('list', { name: 'Workspace members' });
    await expect(memberList.getByRole('listitem')).toHaveCount(fixture.people.length);
    await page.getByPlaceholder('Search by name, npub or role').fill('agent');
    await expect(memberList.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Rename Brick' })).toBeVisible();
    await page.getByPlaceholder('Search by name, npub or role').fill('nobody-here');
    await expect(page.getByText('No members match “nobody-here”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();

    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    const npubInput = page.getByLabel('Add a member by npub');
    await expect(npubInput).toBeFocused();
    await npubInput.fill('npub1short');
    await npubInput.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a full npub' })).toBeVisible();
    expect(state.memberWrites).toHaveLength(0);
    await npubInput.fill(fixture.people[1].npub);
    await npubInput.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Kato is already a member.' })).toBeVisible();
    expect(state.memberWrites).toHaveLength(0);
    const newcomer = nip19.npubEncode(getPublicKey(generateSecretKey()));
    state.denyMembers = true;
    await npubInput.fill(newcomer);
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Only workspace admins can do that.' })).toBeVisible();
    state.denyMembers = false;
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Member added.' })).toBeVisible();
    expect(state.memberWrites).toEqual([
      { member_npub: newcomer, role: 'member', kind: 'human' },
      { member_npub: newcomer, role: 'member', kind: 'human' },
    ]);
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-members-${width}.png` });

    // Keyboard: arrow keys move between the three jobs.
    await membersTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: /Groups/ })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: /Groups/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove nested group Agents from Team' })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-groups-${width}.png` });

    // Group dialogs move focus in, keep Tab inside and restore focus to the opener.
    const newGroupButton = page.getByRole('button', { name: 'New group', exact: true });
    await newGroupButton.focus();
    await newGroupButton.press('Enter');
    const groupDialog = page.getByRole('dialog', { name: 'New group' });
    await expect(groupDialog).toBeVisible();
    await expect(groupDialog.getByPlaceholder('e.g. Team, Clients, Reviewers')).toBeFocused();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      expect(await groupDialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await groupDialog.getByRole('button', { name: 'Close new group' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(groupDialog.getByRole('button', { name: 'Create group' })).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await groupDialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(groupDialog).toBeHidden();
    await expect(newGroupButton).toBeFocused();
    await tabs.getByRole('tab', { name: /Groups/ }).focus();
    await page.keyboard.press('End');
    const accessTab = tabs.getByRole('tab', { name: 'Channel access' });
    await expect(accessTab).toBeFocused();
    await expect(accessTab).toHaveAttribute('aria-selected', 'true');

    // Channel access: nothing is preselected and Review is disabled until who + channels are chosen.
    const count = page.getByTestId('access-selected-count');
    const review = page.getByRole('button', { name: 'Review changes' });
    await expect(count).toHaveText('0 of 10 selected');
    await expect(review).toBeDisabled();
    await page.locator('#access-bulk-group').selectOption('group-agents');
    await page.locator('label.access-capacity-option').filter({ hasText: 'Contribute' }).click();
    await expect(review).toBeDisabled();

    // A filtered scope select only adds the channels that are visible.
    await page.getByPlaceholder('Filter channels or scopes').fill('beacon');
    await page.getByLabel('Select all 4 shown channels in Beacon').check();
    await page.getByPlaceholder('Filter channels or scopes').fill('');
    await expect(count).toHaveText('4 of 10 selected');
    const devOps = page.getByRole('group', { name: 'Dev Ops channels' });
    await expect(devOps.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await page.getByRole('group', { name: 'Wingman Suite channels' }).getByLabel('Tower').check();
    await expect(count).toHaveText('5 of 10 selected');
    await expect(page.getByLabel('Select all 3 shown channels in Wingman Suite')).toHaveJSProperty('indeterminate', true);
    await expect(page.getByTestId('access-summary')).toHaveText('Agents will get Contribute access in 5 channels.');
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-access-${width}.png` });

    // Closing while current access is still loading discards that read; reopening reaches ready.
    const dialog = page.getByTestId('access-preview-dialog');
    let releaseReads;
    state.holdReads = new Promise((resolve) => { releaseReads = resolve; });
    await review.click();
    await expect(dialog.getByText('Checking current access…')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Apply to/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    state.holdReads = null;
    releaseReads();
    state.reads.length = 0;

    // Preview reads only; it never writes.
    await review.click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
    await expect(dialog.getByText('2 new')).toBeVisible();
    await expect(dialog.getByText('1 changed')).toBeVisible();
    await expect(dialog.getByText('1 already set')).toBeVisible();
    await expect(dialog.getByText('1 custom kept')).toBeVisible();
    await expect(dialog.getByText('Change from View')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply to 3 channels' })).toBeEnabled();
    expect(state.writes).toHaveLength(0);
    expect([...state.reads].sort()).toEqual(['ch-architecture', 'ch-build', 'ch-dialogue', 'ch-gateway', 'ch-tower']);
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-preview-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(state.writes).toHaveLength(0);

    // Confirmed apply: exact targets and payloads; partial failure is reported per channel.
    await review.click();
    await dialog.getByRole('button', { name: 'Apply to 3 channels' }).click();
    const results = page.getByTestId('access-results');
    await expect(results.getByRole('alert')).toHaveText('1 of 5 channels failed. The others were updated.');
    await expect(results.locator('li.is-failed')).toContainText('You need Manage access on this channel to do that.');
    expect(state.writes).toEqual([
      { method: 'POST', channel: 'ch-dialogue', principal: null, body: { principal_type: 'group', principal_id: 'group-agents', access_level: 'contribute' } },
      { method: 'PUT', channel: 'ch-architecture', principal: 'group:group-agents', body: { access_level: 'contribute' } },
      { method: 'POST', channel: 'ch-tower', principal: null, body: { principal_type: 'group', principal_id: 'group-agents', access_level: 'contribute' } },
    ]);
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-partial-failure-${width}.png` });

    // Retry targets only the failed channel with the same rule.
    state.denyChannels.clear();
    await results.getByRole('button', { name: 'Retry 1 failed' }).click();
    await expect(dialog.getByText('1 new')).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply to 1 channel' }).click();
    await expect(results.getByRole('status')).toHaveText('No failures: 1 channel processed.');
    expect(state.writes.at(-1)).toEqual({ method: 'POST', channel: 'ch-tower', principal: null, body: { principal_type: 'group', principal_id: 'group-agents', access_level: 'contribute' } });
    expect(state.writes.filter((write) => write.method === 'DELETE')).toHaveLength(0);
    expect(state.writes.every((write) => ['ch-dialogue', 'ch-architecture', 'ch-tower'].includes(write.channel))).toBe(true);

    // Lowering a permission is called out before anything is written.
    const writesBefore = state.writes.length;
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(count).toHaveText('0 of 10 selected');
    await page.locator('label.access-capacity-option').filter({ hasText: /^\s*View/ }).click();
    await page.getByRole('group', { name: 'Beacon channels' }).getByLabel('Build').check();
    await expect(page.getByTestId('access-summary')).toHaveText('Agents will get View access in 1 channel.');
    await review.click();
    await expect(dialog.getByText('Lower from Contribute')).toBeVisible();
    await expect(dialog.getByText('1 lowered')).toBeVisible();
    await expect(dialog.getByRole('note')).toHaveText('1 channel will lose abilities: the current permission is replaced by View.');
    await page.screenshot({ path: `${EVIDENCE_DIR}/after-preview-downgrade-${width}.png` });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(state.writes).toHaveLength(writesBefore);
    expect(state.blocked).toEqual([]);
    expect(errors).toEqual([]);
  });
}
