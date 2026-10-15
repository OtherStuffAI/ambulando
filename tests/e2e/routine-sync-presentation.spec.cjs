const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [390, 1440]) {
  test(`routine sync stays on the avatar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.closeThread({ syncRoute: false });
      store.navigateTo('status', { syncRoute: false });
    });

    const avatar = page.locator('.avatar-chip');
    const menu = page.locator('#profile-avatar-menu');
    const status = menu.locator('.sync-status-label');
    const progress = menu.locator('.startup-sync-progress-panel[role="status"]');

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.pgNavigationRecoveryPending = true;
      store.syncing = false;
      store.pendingWritesBusy = false;
      store.connectHostBusy = false;
      store.connectWorkspacesBusy = false;
      store.connectCreatingWorkspace = false;
      store.syncStatus = 'synced';
      store.startupSyncProgress = { active: false, visible: false, stage: 'complete', error: null };
    });
    await expect(page.getByText('Rechecking workspace access', { exact: false })).toHaveCount(0);
    await expect(avatar).not.toHaveAttribute('aria-label', 'Syncing');

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.syncing = true;
      store.syncStatus = 'syncing';
      store.startupSyncProgress = {
        active: true,
        visible: true,
        stage: 'receiving',
        page: 2,
        applied: 50,
        error: null,
      };
    });
    await expect(avatar).toHaveAttribute('aria-label', 'Syncing');
    await avatar.click();
    await expect(status).toHaveText('Syncing');
    await expect(menu.getByText('In progress', { exact: true })).toHaveCount(0);
    await expect(progress.locator('strong')).toHaveText('Syncing');
    await expect(progress.locator('.startup-sync-progress-meta')).toHaveText('Page 2 · 50 changes applied');

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.syncing = false;
      store.syncStatus = 'synced';
      store.startupSyncProgress = { active: false, visible: false, stage: 'complete', error: null };
    });
    await expect(progress).toBeHidden();
    await expect(status).not.toHaveText('Syncing');

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.syncStatus = 'error';
      store.startupSyncProgress = {
        active: false,
        visible: true,
        stage: 'error',
        error: 'Tower unavailable',
      };
    });
    await expect(progress.locator('strong')).toHaveText('Update stalled');
    await expect(progress.getByText('Tower unavailable', { exact: true })).toBeVisible();
    await expect(progress.getByRole('button', { name: 'Retry updates' })).toBeEnabled();

    await page.evaluate(() => {
      Alpine.store('chat').startupSyncProgress = {
        active: false,
        visible: true,
        stage: 'signing-paused',
        error: 'Browser signing paused. Keep stored data intact.',
      };
    });
    await expect(progress.locator('strong')).toHaveText('Browser signing paused');
    await expect(progress.getByText('Browser signing paused. Keep stored data intact.', { exact: true })).toBeVisible();
    await expect(progress.getByRole('button', { name: 'Retry updates' })).toBeEnabled();
  });
}
