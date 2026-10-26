const { test, expect } = require('playwright/test');

async function openConnectedShell(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.session = { npub: 'npub1connectionfixture' };
    store.sseStatus = 'connected';
    store.towerReachabilityState = 'online';
    store.towerReachabilityReason = 'sse-connected';
  });
}

test('connected mobile viewport does not render the reconnect indicator', async ({ page }) => {
  await openConnectedShell(page, { width: 390, height: 844 });

  await expect(page.getByTestId('tower-connection-indicator')).toHaveCount(0);
});

test('reconnecting mobile viewport reports status only inside Settings', async ({ page }) => {
  await openConnectedShell(page, { width: 390, height: 844 });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.handleSSEStatus({
      status: 'reconnecting',
      connectionKey: store.buildSSEConnectionKey(),
      reason: 'eventsource-error',
    });
  });

  await expect(page.getByTestId('tower-connection-indicator')).toHaveCount(0);
  await page.evaluate(() => { window.Alpine.store('chat').navSection = 'settings'; });
  const indicator = page.getByTestId('settings-connection-status');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText('Reconnecting');
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible();
});

test('mobile fallback lifecycle hides reconnecting after usable Tower sync and restores it on real loss', async ({ page }) => {
  await openConnectedShell(page, { width: 390, height: 844 });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const connectionKey = store.buildSSEConnectionKey();
    store.handleSSEStatus({ status: 'reconnecting', connectionKey, reason: 'eventsource-error' });
    store.markTowerReachabilityRecovered('background-sync-success', {
      refresh: false,
      fallbackUsable: true,
    });
    store.handleSSEStatus({ status: 'fallback-polling', connectionKey, reason: 'reconnect-exhausted' });
    store.handleSSEStatus({ status: 'reconnecting', connectionKey, reason: 'fallback-probe' });
  });

  await expect(page.getByTestId('tower-connection-indicator')).toHaveCount(0);

  await page.evaluate(() => {
    window.Alpine.store('chat').markTowerReachabilityOperationFailed('background-sync-failed');
  });

  await page.evaluate(() => { window.Alpine.store('chat').navSection = 'settings'; });
  await expect(page.getByTestId('settings-connection-status')).toHaveText('Reconnecting');
});

test('connected desktop viewport keeps the reconnect indicator hidden', async ({ page }) => {
  await openConnectedShell(page, { width: 1280, height: 820 });

  await expect(page.getByTestId('tower-connection-indicator')).toHaveCount(0);
});

test('exports only consented redacted diagnostics locally', async ({ page }) => {
  test.setTimeout(30000);
  await openConnectedShell(page, { width: 1280, height: 820 });
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.stopBackgroundSync();
    store.openConnectModal = () => {};
    store.loadRemoteWorkspaces = async () => {};
    store.showConnectModal = false;
    store.showWorkspaceBootstrapModal = false;
    store.backendUrl = location.origin;
    store.knownWorkspaces = [{ workspaceKey: 'connection-export', workspaceId: 'connection-export', pgBackendMode: true,
      workspaceOwnerNpub: store.session.npub, directHttpsUrl: location.origin }];
    store.selectedWorkspaceKey = 'connection-export';
    await store.openDiagnosticsDialog();
  });
  const downloadJson = async () => {
    await page.evaluate(() => { const store = window.Alpine.store('chat'); store.showConnectModal = false; store.showWorkspaceBootstrapModal = false; });
    const pending = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: 'Export diagnostics', exact: true }).click();
    const download = await pending;
    return JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
  };
  expect(await downloadJson()).toMatchObject({ version: 1, historyAvailable: false, events: [], platform: 'web' });
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.diagnosticsSettings.enabled = true;
    await store.saveDiagnosticsSettings();
    await fetch('/health?token=SECRET&user=SECRET');
  });
  const snapshot = await downloadJson();
  expect(snapshot.historyAvailable).toBe(true);
  expect(snapshot.buildNumber).toBeGreaterThan(0);
  expect(snapshot.build).toMatch(/^[0-9-]+$/);
  expect(new Date(snapshot.exportedAt).toISOString()).toBe(snapshot.exportedAt);
  expect(snapshot.events.length).toBeGreaterThan(0);
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.diagnosticsSettings.enabled = false;
    await store.saveDiagnosticsSettings();
  });
  expect(await downloadJson()).toMatchObject({ version: 1, historyAvailable: false, events: [], platform: 'web' });
});
