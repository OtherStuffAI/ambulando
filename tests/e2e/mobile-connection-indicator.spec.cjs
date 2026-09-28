const { test, expect } = require('playwright/test');

test('mobile connection badge recovers through polling and still reports failed pulls and offline', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // This deterministic UI probe uses no external backend or workspace data.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.stopBackgroundSync();
    store.session = { npub: 'npub1mobileprobe' };
    store.backendUrl = 'http://127.0.0.1:3100';
    store.workspaceOwnerNpub = 'npub1mobileworkspace';
    store.workspaceDbKey = 'mobile-connection-probe';
    store.currentWorkspace = { workspaceId: 'mobile-connection-probe' };
    store.scheduleBackgroundSync = () => {};
    store.scheduleOfflineMessageResync = () => {};
    store.recoverVisibleAgentActivities = async () => {
      store.agentActivityRecoveryError = 'Activity updates could not be recovered. Retrying.';
      throw new Error('Synthetic activity endpoint failure');
    };
    store.requestTowerSyncFamily = async () => ({ applied: 0, pages: 1 });
    store.handleSSEStatus({ status: 'reconnecting', connectionKey: store.buildSSEConnectionKey() });
  });

  const badge = page.getByTestId('tower-connection-indicator');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Reconnecting');
  const bounds = await badge.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);

  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    await store.backgroundSyncTick();
    store.handleSSEStatus({ status: 'fallback-polling', connectionKey: store.buildSSEConnectionKey() });
    store.handleSSEStatus({ status: 'reconnecting', connectionKey: store.buildSSEConnectionKey() });
  });
  await expect(badge).toHaveCount(0);
  expect(await page.evaluate(() => window.Alpine.store('chat').agentActivityRecoveryError)).toContain('Retrying');

  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.requestTowerSyncFamily = async () => { throw new Error('Synthetic Tower pull failure'); };
    await store.backgroundSyncTick();
  });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Reconnecting');

  await context.setOffline(true);
  await page.evaluate(() => window.Alpine.store('chat').markTowerReachabilityDegraded('browser-offline', 'offline'));
  await expect(badge).toHaveText('Offline');
  await context.setOffline(false);
});
