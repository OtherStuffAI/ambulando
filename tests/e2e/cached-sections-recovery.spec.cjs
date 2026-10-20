const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const { width, theme } of [
  { width: 1440, theme: 'light' },
  { width: 2048, theme: 'dark' },
]) {
  test(`cached Tasks, Docs and Files remain usable during refresh at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await openFixture(page);
    await page.evaluate((selectedTheme) => {
      const store = Alpine.store('chat');
      Alpine.store('appearance').setTheme(selectedTheme);
      store.pgNavigationRecoveryPending = true;
      store.selectedBoardId = '__all__';
      store.taskViewMode = 'list';
      store.showTaskDetail = false;
      store.sectionRefreshError = '';
      store.sectionRefreshFamily = '';
    }, theme);

    await page.evaluate(() => Alpine.store('chat').navigateTo('tasks', { syncRoute: false }));
    await expect(page.getByText('Review connected frontend', { exact: true }).first()).toBeVisible();
    await page.getByText('Review connected frontend', { exact: true }).first().click();
    await expect(page.locator('.task-detail-panel')).toBeVisible();

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.showTaskDetail = false;
      store.navigateTo('docs', { syncRoute: false });
    });
    await expect(page.getByText('Connected design review', { exact: true }).first()).toBeVisible();
    await page.getByText('Connected design review', { exact: true }).first().click();
    await expect(page.locator('.docs-editor-v3')).toBeVisible();

    await page.evaluate(() => {
      const store = Alpine.store('chat');
      store.closeDocEditor({ syncRoute: false });
      store.navigateTo('files', { syncRoute: false });
    });
    await expect(page.getByText('Mobile layout review.pdf', { exact: true }).first()).toBeVisible();

    await page.evaluate(async () => {
      const store = Alpine.store('chat');
      store.navigateTo('tasks', { syncRoute: false });
      store.refreshTasks = async () => { throw Object.assign(new Error('NIP-98 signing timed out'), { status: 401, code: 'auth_timeout' }); };
      await store.retryActiveSectionRefresh();
    });
    const error = page.locator('.section-refresh-error');
    await expect(error).toContainText('browser signing was interrupted');
    await expect(page.getByText('Review connected frontend', { exact: true }).first()).toBeVisible();
    await page.evaluate(() => { Alpine.store('chat').refreshTasks = async () => []; });
    await error.getByRole('button', { name: 'Retry' }).click();
    await expect(error).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });
}
