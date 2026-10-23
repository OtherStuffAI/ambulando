const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

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
