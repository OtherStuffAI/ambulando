const { test, expect } = require('playwright/test');

// Fixture-only browser coverage: Tower rows are applied to the store directly.
// It proves local lease expiry, transport labelling, foreground re-evaluation
// and terminal clearing in the real rendered thread without a backend.
test('live agent activity expires locally, labels reconnects and clears on completion', async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const root = {
      record_id: 'lease-thread', pg_thread_id: 'lease-thread', thread_id: 'lease-thread',
      channel_id: 'lease-channel', parent_message_id: null, sender_npub: 'npub1operator',
      body: 'Lease regression', metadata: {}, record_state: 'active', sync_status: 'synced',
      created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z',
    };
    store.startWorkspaceLiveQueries = () => {};
    store.syncRoute = () => {};
    store.performSync = () => {};
    store.requestTowerSyncFamily = async () => [];
    store.scheduleStorageImageHydration = () => {};
    store.session = { ...(store.session || {}), npub: 'npub1operator' };
    store.currentPgActorNpub = 'npub1operator';
    store.sseStatus = 'connected';
    store.towerFallbackReachable = false;
    store.towerReachabilityState = 'online';
    store.pgBackendMode = false;
    store.isTowerPgMode = false;
    store.channels = [{ record_id: 'lease-channel', title: 'implementation', record_state: 'active', metadata: {} }];
    store.selectedChannelId = 'lease-channel';
    store.pgContextSelectedChannelId = 'lease-channel';
    store.pgWorkspaceMembers = [{ npub: 'npub1leaseagent', display_name: 'Lease Agent', kind: 'agent' }];
    store.addressBookPeople = [{ npub: 'npub1leaseagent', label: 'Lease Agent', name: 'Lease Agent' }];
    store.messages = [root];
    store.navSection = 'chat';
    store.openThread('lease-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
    store.threadInput = 'Draft that must survive';
    const now = Date.now();
    // Deadline 12.5 s ago: the 15 s client grace ends about 2.5 s from now.
    const deadline = new Date(now - 12_500).toISOString();
    window.__leaseRow = {
      record_id: 'lease-row', activity_id: 'lease-activity', turn_id: 'lease-turn', session_id: 'lease-session',
      channel_id: 'lease-channel', thread_id: 'lease-thread', trigger_message_id: 'lease-trigger',
      agent_npub: 'npub1leaseagent', visibility: 'user_visible', state: 'working', sequence: 3,
      body: 'Reading the repository', lease_health: 'live', lease_expires_at: deadline, expires_at: deadline,
      created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now - 30_000).toISOString(),
      commentary_history: [], commentary_next_before_sequence: null,
    };
    store.applyAgentActivities([window.__leaseRow]);
  });

  const card = page.locator('.agent-activity-thread:visible');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Lease Agent · Working');
  await expect(card).toContainText('Reading the repository');
  await expect(card.locator('.current-working-symbol')).toBeVisible();

  // Transport loss with a live deadline is "reconnecting", not "stopped".
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.sseStatus = 'reconnecting';
    store.agentActivityRecoveryStartedAt = Date.now();
  });
  await expect(card).toContainText('Working · reconnecting…');

  // Deadline + grace passes while disconnected: stopped, no spinner, history kept.
  await expect(card).toContainText(/Stopped responding · last update \S/, { timeout: 6_000 });
  await expect(card).toContainText('What it said: Reading the repository');
  await expect(card.locator('.current-working-symbol')).toBeHidden();
  await expect(card).toHaveClass(/agent-activity-expired/);

  // A later live renewal (new epoch) and reconnect show it working again.
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.sseStatus = 'connected';
    store.agentActivityRecoveryStartedAt = 0;
    const leaseExpiresAt = new Date(Date.now() + 180_000).toISOString();
    store.applyAgentActivities([{ ...window.__leaseRow, lease_epoch: 2, lease_sequence: 0,
      lease_expires_at: leaseExpiresAt, expires_at: leaseExpiresAt, updated_at: new Date().toISOString() }]);
  });
  await expect(card).toContainText('Working · resumed');

  // Foreground: with the interval paused (as a throttled background tab), the
  // visibility change alone must re-evaluate an expiry before the next frame.
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    window.clearInterval(store.responseActivityTimer);
    store.responseActivityTimer = 'paused';
    const expired = new Date(Date.now() - 60_000).toISOString();
    store.agentActivities = [{ ...store.agentActivities[0], lease_expires_at: expired, expires_at: expired }];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(card).toContainText('Stopped responding', { timeout: 2_000 });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.responseActivityTimer = null;
    store.updateResponseActivityTimer();
  });

  // Terminal always wins and removes the header; drafts survive every change.
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.applyAgentActivities([{ ...window.__leaseRow, state: 'completed', sequence: 1,
      terminal_at: new Date().toISOString() }]);
  });
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.Alpine.store('chat').threadInput)).toBe('Draft that must survive');
});
