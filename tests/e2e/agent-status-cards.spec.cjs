const { test, expect } = require('playwright/test');

for (const width of [1120, 390]) {
  test(`retained agent statuses stay compact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      const root = {
        record_id: 'status-thread', pg_thread_id: 'status-thread', thread_id: 'status-thread',
        channel_id: 'status-channel', parent_message_id: null, sender_npub: 'npub1operator',
        body: 'Agent status regression', metadata: {}, record_state: 'active', sync_status: 'synced',
        created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
      };
      store.startWorkspaceLiveQueries = () => {};
      store.syncRoute = () => {};
      store.performSync = () => {};
      store.requestTowerSyncFamily = async () => [];
      store.scheduleStorageImageHydration = () => {};
      store.session = { ...(store.session || {}), npub: 'npub1operator' };
      store.currentPgActorNpub = 'npub1operator';
      store.sseStatus = 'connected';
      store.towerFallbackReachable = true;
      store.towerReachabilityState = 'online';
      store.pgBackendMode = false;
      store.isTowerPgMode = false;
      store.channels = [{ record_id: 'status-channel', title: 'implementation', record_state: 'active', metadata: {} }];
      store.selectedChannelId = 'status-channel';
      store.pgContextSelectedChannelId = 'status-channel';
      store.pgWorkspaceMembers = [{ npub: 'npub1statusagent', display_name: 'Status Agent', kind: 'agent' }];
      store.addressBookPeople = [{ npub: 'npub1statusagent', label: 'Status Agent', name: 'Status Agent' }];
      store.messages = [root];
      store.navSection = 'chat';
      store.openThread('status-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
      store.applyAgentActivities([1, 2, 3, 4].map(n => ({
        record_id: `status-row-${n}`, activity_id: `status-${n}`, turn_id: `status-turn-${n}`,
        session_id: `pending:status-turn-${n}`, channel_id: 'status-channel', thread_id: 'status-thread',
        trigger_message_id: `status-trigger-${n}`, agent_npub: 'npub1statusagent',
        visibility: 'user_visible', state: n === 4 ? 'queued' : n === 3 ? 'accepted' : 'working',
        sequence: 1, created_at: `2026-09-28T0${n}:00:00Z`,
        expires_at: n === 1 || n === 3 ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z',
        queue_position: n === 4 ? 2 : null, blocked_by_turn_id: n === 4 ? 'status-turn-3' : null,
        commentary_history: [], commentary_next_before_sequence: null,
      })));
    });
    const cards = page.locator('.agent-activity-thread:visible');
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: 'Queued behind' })).toHaveCount(1);
    await expect(page.locator('.current-working-count:visible')).toHaveCount(0);
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.agentActivities[0].commentary_history = [{ history_key: 'status-history-1', activity_id: 'status-1', turn_id: 'status-turn-1',
        sequence: 2, body: 'Earlier useful commentary' }];
      store.agentActivities[0].sequence = 999;
      store.agentActivities[0].updated_at = '2999-01-01';
      store.openAgentActivityDetails('thread');
    });
    const dialog = page.getByRole('dialog', { name: 'Working history & diagnostics', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.agent-activity-retained')).toHaveCount(4);
    await dialog.locator('.agent-activity-retained').filter({ hasText: 'Earlier useful commentary' }).locator('summary').click();
    await expect(dialog.getByText('Earlier useful commentary', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close working history' }).click();
    await expect(cards).toHaveCount(2);
    await page.evaluate(() => {
      const row = window.Alpine.store('chat').agentActivities[3];
      Object.assign(row, { state: 'working', sequence: 2, body: 'Current useful commentary', queue_position: null });
    });
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Current useful commentary');
    await page.evaluate(() => { window.Alpine.store('chat').agentActivities[3].state = 'completed'; });
    await expect(cards).toHaveCount(0);
    await page.evaluate(() => {
      Object.assign(window.Alpine.store('chat').agentActivities[3], { state: 'failed', body: 'Validation failed' });
    });
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Validation failed');
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      // Earlier failures from separate triggers must not stack beside the
      // current failed request, and duplicate delivery must not add a card.
      store.agentActivities[0].state = 'failed';
      store.agentActivities[0].body = 'Earlier dispatch failed';
      store.agentActivities[1].state = 'failed';
      store.agentActivities[1].body = 'Second dispatch failed';
      store.agentActivities.push({ ...store.agentActivities[0] });
    });
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Validation failed');
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.agentActivities.push({ ...store.agentActivities[3],
        record_id: 'status-success', activity_id: 'status-success', turn_id: 'status-success-turn',
        created_at: '2026-09-28T05:00:00Z', state: 'completed', body: 'Retry succeeded', sequence: 1 });
    });
    await expect(cards).toHaveCount(0);
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      Object.assign(store.agentActivities[0], { sequence: 9999, updated_at: '2999-01-01' });
      store.openAgentActivityDetails('thread');
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.agent-activity-retained')).toHaveCount(5);
    await expect(dialog.getByText('Earlier dispatch failed', { exact: true })).toHaveCount(1);
    await expect(dialog.getByText('Second dispatch failed', { exact: true })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close working history' }).click();
    await expect(cards).toHaveCount(0);
  });
}
