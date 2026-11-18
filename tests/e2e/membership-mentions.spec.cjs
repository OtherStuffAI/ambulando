const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ serviceWorkers: 'block' });
test.setTimeout(45000);

for (const hydration of ['roster first', 'access first']) {
  test(`${hydration}: Morgan becomes selectable in the same open thread after channel contacts hydrate`, async ({ page }) => {
    const { build } = require('esbuild');
    const path = require('node:path');
    const harness = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent',
      define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': '{}' },
      stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
        export {createWorkspaceDb} from './src/db.js';
        export {liveQuery} from 'dexie';
        export {serializeMentionComposerState} from './src/mention-composer.js';
      ` } });
    await page.route('**/*', route => new URL(route.request().url()).pathname === '/contact-probe.js'
      ? route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text })
      : serveBuiltFlightDeck(route));
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
    await page.evaluate(async () => {
      const m = await import('/contact-probe.js');
      const db = m.createWorkspaceDb('cold-person-mentions'); await db.open();
      const s = Alpine.store('chat');
      for (const key of ['syncRoute', 'requestTowerSyncFamily', 'startThreadLiveActivity', 'markTowerPgResourceViewed', 'scheduleStorageImageHydration', 'rememberPeople']) s[key] = async () => {};
      s.openConnectModal = () => {};
      s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
      s.session = { npub: 'npub1fixtureviewer' }; s.pgBackendMode = true;
      s.channels = [{ record_id: 'cold-channel', title: 'Contact fixture', scope_id: 'cold-scope', record_state: 'active' }];
      s.selectedChannelId = 'cold-channel'; s.pgContextSelectedChannelId = 'cold-channel';
      s.channelGrants = []; s.channelGrantsChannelId = null;
      s.scopes = []; s.groups = []; s.pgWorkspaceMembers = []; s.addressBookPeople = [];
      s.getSenderName = npub => s.chatProfiles[npub]?.name || npub;
      s.messages = [{ record_id: 'cold-root', channel_id: 'cold-channel', body: 'Contact hydration regression', sender_npub: 'npub1fixtureviewer', record_state: 'active', sync_status: 'synced', created_at: '2026-11-18T00:00:00Z' }];
      s.navSection = 'chat';
      s.openThread('cold-root', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
      const subscriptions = [
        m.liveQuery(() => db.workspace_members.toArray()).subscribe(rows => { s.pgWorkspaceMembers = rows; }),
        m.liveQuery(() => db.groups.toArray()).subscribe(rows => { s.groups = rows; }),
      ];
      const gates = {}, requests = [];
      const wait = kind => new Promise(resolve => { gates[kind] = resolve; });
      const roster = wait('roster'), access = wait('access');
      s.refreshTowerPgWorkspaceMembers = async () => {
        requests.push('members'); await roster;
        await db.workspace_members.put({ actor_id: 'fixture-person', npub: 'npub1fixtureperson', workspace_id: 'cold-workspace' });
      };
      s.refreshGroups = async () => {
        requests.push('groups'); await access;
        await db.groups.put({ group_id: 'channel-readers', member_npubs: ['npub1fixtureperson', 'npub1retired'] });
      };
      s.refreshChannelGrants = async () => {
        requests.push('grants'); await access;
        s.channelGrantsChannelId = 'cold-channel';
        s.channelGrants = [{ principal_type: 'group', principal_id: 'channel-readers', permissions: ['channel.read'] }];
      };
      window.contactProbe = { db, m, subscriptions, gates, requests };
    });
    const editor = page.locator('.thread-input-bar [data-chat-composer="thread"]');
    await expect(editor).toBeVisible();
    await editor.fill('@Morgan');
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').mentionActive)).toBe(true);
    await expect(page.locator('.mention-result-label')).toHaveCount(0);
    // Keep this exact DOM composer and thread open throughout hydration.
    await editor.evaluate(el => { window.contactProbe.editor = el; });
    expect(await page.evaluate(() => window.contactProbe.requests.sort())).toEqual(['grants', 'groups', 'members']);
    const hydrate = kind => page.evaluate(kind => window.contactProbe.gates[kind](), kind);
    await hydrate(hydration === 'roster first' ? 'roster' : 'access');
    await hydrate(hydration === 'roster first' ? 'access' : 'roster');
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').pgWorkspaceMembers.length)).toBe(1);
    await page.evaluate(() => { Alpine.store('chat').chatProfiles = { npub1fixtureperson: { name: 'Morgan' } }; });
    await expect(page.locator('.mention-result-label')).toHaveText(['Morgan']);
    expect(await editor.evaluate(el => el === window.contactProbe.editor)).toBe(true);
    await page.locator('.mention-result-item').click();
    await expect(editor.locator('[data-mention-token]')).toHaveText('@Morgan');
    expect(await editor.evaluate(el => window.contactProbe.m.serializeMentionComposerState(el))).toMatchObject({
      value: '@[Morgan](mention:person:npub1fixtureperson) ',
      actorMentions: [{ type: 'person', npub: 'npub1fixtureperson', label: 'Morgan' }],
    });
    await page.evaluate(async () => {
      for (const sub of window.contactProbe.subscriptions) sub.unsubscribe();
      await window.contactProbe.db.delete();
    });
  });
}

// Synthetic local browser evidence against the production bundle. Network is
// unavailable; these checks do not claim authenticated workspace verification.
for (const hydration of ['warm cache', 'late hydration']) {
  test(`${hydration}: an open mention picker reacts locally and inserts the canonical agent route`, async ({ page }) => {
    await page.route('**/*', route => {
      if (process.env.FLIGHTDECK_MENTION_LIVE_ASSETS !== '1') return serveBuiltFlightDeck(route);
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: {} });
      return route.continue();
    });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')));
    await page.evaluate(({ hydration }) => {
      const s = window.Alpine.store('chat');
      s.showConnectModal = false;
      s.showWorkspaceBootstrapModal = false;
      s.openConnectModal = () => {};
      s.ensureChatMentionRoster = async () => {};
      s.pgBackendMode = true;
      s.selectedChannelId = 'mention-fixture';
      s.channels = [{ record_id: 'mention-fixture', title: 'Fixture', record_state: 'active' }];
      s.groups = [];
      s.getSenderName = npub => s.chatProfiles[npub]?.name || npub;
      s.addressBookPeople = [{ npub: 'npub1unrelated', label: 'Unrelated Agent' }];
      const members = [{ actor_id: 'fixture-agent', npub: 'npub1fixture-agent', kind: 'agent', display_name: 'Fixture Agent' }];
      s.pgWorkspaceMembers = hydration === 'warm cache' ? members : [];
      const target = document.createElement('textarea');
      target.id = 'mention-fixture-input';
      target.dataset.chatComposer = 'message';
      target.dataset.channelVisibleMentions = 'true';
      target.style = 'position:fixed;left:40px;top:120px;width:320px;height:50px;z-index:1000';
      target.value = '@agent:';
      document.body.append(target);
      s._mentionTargetEl = target;
      s._mentionStartPos = 0;
      s._mentionEndPos = target.value.length;
      s.mentionQuery = 'agent:';
      s.mentionActive = true;
      s.refreshActiveMentionResults();
      if (hydration === 'late hydration') setTimeout(() => { s.pgWorkspaceMembers = members; }, 100);
    }, { hydration });
    const rows = page.locator('.mention-result-label');
    await expect(rows).toHaveText(['Fixture Agent']);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.pgWorkspaceMembers = [{ ...s.pgWorkspaceMembers[0], display_name: 'Renamed Agent' }];
    });
    await expect(rows).toHaveText(['Renamed Agent']);
    await page.locator('.mention-result-item').click();
    await expect(page.locator('#mention-fixture-input')).toHaveValue('@[Renamed Agent](mention:agent:npub1fixture-agent) ');
    expect(await page.evaluate(() => window.Alpine.store('chat').selectedAgentMentionsByComposer.message)).toEqual([
      { type: 'agent', npub: 'npub1fixture-agent', label: 'Renamed Agent' },
    ]);
  });
}

test('expired Dexie roster stays selectable through a slow failed reconciliation', async ({ page }) => {
  const { build } = require('esbuild');
  const path = require('node:path');
  const harness = await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test'), 'import.meta.env': '{}' },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
      export {readMembershipDirectory, MEMBERSHIP_FULL_REFRESH_MS} from './src/membership-freshness.js';
      export {createWorkspaceDb} from './src/db.js';
      export {liveQuery} from 'dexie';
    ` } });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/membership-probe.js') {
      return route.fulfill({ contentType: 'text/javascript', body: harness.outputFiles[0].text });
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')));
  await page.evaluate(async () => {
    const m = await import('/membership-probe.js');
    const db = m.createWorkspaceDb('stale-members-browser'); await db.open();
    const s = window.Alpine.store('chat');
    s.showConnectModal = false; s.showWorkspaceBootstrapModal = false; s.openConnectModal = () => {};
    s.pgBackendMode = true; s.selectedChannelId = 'stale-fixture';
    s.channels = [{ record_id: 'stale-fixture', title: 'Fixture', record_state: 'active' }];
    s.groups = []; s.getSenderName = npub => s.chatProfiles[npub]?.name || npub;
    const members = [{ actor_id: 'cached-agent', npub: 'npub1cached-agent', kind: 'agent', display_name: 'Cached Agent', workspace_id: 'w' }];
    await db.workspace_members.bulkPut(members);
    const options = { db, workspaceId: 'w', appNpub: 'app', baseUrl: 'http://127.0.0.1:3100', family: 'members' };
    const snapshot = { members: members.map(actor => ({ actor })) };
    await m.readMembershipDirectory({ ...options, now: () => Date.now() - m.MEMBERSHIP_FULL_REFRESH_MS - 1, read: async () => snapshot });
    const subscription = m.liveQuery(() => db.workspace_members.toArray()).subscribe(rows => { s.pgWorkspaceMembers = rows; });
    let rejectRead;
    const slow = new Promise((_, reject) => { rejectRead = reject; });
    window.membershipProbe = { db, subscription, rejectRead, pending: true, options, m };
    s.ensureChatMentionRoster = () => {
      if (!window.membershipProbe.request) window.membershipProbe.request = m.readMembershipDirectory({ ...options, read: () => slow })
        .catch(() => {}).finally(() => { window.membershipProbe.pending = false; });
    };
    const target = document.createElement('textarea');
    target.id = 'stale-mention-input'; target.dataset.chatComposer = 'message';
    target.dataset.channelVisibleMentions = 'true';
    target.style = 'position:fixed;left:40px;top:120px;width:320px;height:50px;z-index:1000';
    target.value = '@agent:'; document.body.append(target);
    s._mentionTargetEl = target; s._mentionStartPos = 0; s._mentionEndPos = target.value.length;
    s.mentionQuery = 'agent:'; s.mentionActive = true;
    s.ensureChatMentionRoster(); s.refreshActiveMentionResults();
  });
  const rows = page.locator('.mention-result-label');
  await expect(rows).toHaveText(['Cached Agent']);
  expect(await page.evaluate(() => window.membershipProbe.pending)).toBe(true);
  await page.evaluate(() => window.membershipProbe.rejectRead(new Error('offline')));
  await expect.poll(() => page.evaluate(() => window.membershipProbe.pending)).toBe(false);
  await expect(rows).toHaveText(['Cached Agent']);
  await page.locator('.mention-result-item').click();
  await expect(page.locator('#stale-mention-input')).toHaveValue('@[Cached Agent](mention:agent:npub1cached-agent) ');
  await page.evaluate(async () => {
    const p = window.membershipProbe;
    const state = (await p.db.sync_state.toArray())[0].value;
    if (Date.now() - state.fullReconciledAt < p.m.MEMBERSHIP_FULL_REFRESH_MS) throw new Error('Failure marked stale data fresh');
    p.subscription.unsubscribe(); await p.db.delete();
  });
});
