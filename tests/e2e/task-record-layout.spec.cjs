const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

async function openFixture(page) {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'stopTaskCommentsLiveQuery', 'startTaskCommentsLiveQuery', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead']) store[key] = () => {};
    store.showWorkspaceBootstrapModal = false;
    store.backendUrl = "http://127.0.0.1:3100";
    store.selectedWorkspaceKey = "fixture-workspace";
    store.session = { npub: 'npub1fixture' };
    store.tasks = [{ record_id: 'layout-task', title: 'A readable task record', description: '## Expected outcome\n\nA clear brief with a working conversation.\n\n- Preserve rich descriptions\n- Keep dependencies accessible', state: 'in_progress', assigned_to_npubs: [], scope_id: 'scope-preserved', predecessor_task_ids: ['dependency'], tags: [], record_state: 'active', sync_status: 'synced', version: 1 }, { record_id: 'dependency', title: 'Agree the layout', state: 'done', tags: [], record_state: 'active', version: 1 }];
    store.loadTaskComments = async () => store.applyTaskComments([
      { record_id: 'old', body: 'Earlier update', updated_at: '2026-10-05T01:00:00Z', sender_npub: 'npub1fixture' },
      { record_id: 'new', body: 'Latest update', updated_at: '2026-10-05T02:00:00Z', sender_npub: 'npub1fixture' },
    ]);
    store.navSection = 'tasks';
    store.openTaskDetail('layout-task');
  });
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.locator('.task-detail-panel')).toBeVisible();
}

for (const width of [1280, 390, 320]) {
  test(`built task record preserves description, dependencies and comments at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    const panel = page.locator('.task-detail-panel');
    await expect(panel.locator('.task-description-section')).toBeVisible();
    await expect(panel.locator('.task-predecessor-link')).toContainText('Agree the layout');
    await expect(panel.locator('label').filter({ hasText: /^Scope$/ })).toHaveCount(0);
    if (width < 769) {
      await expect(panel.locator('.task-comments-section')).toBeHidden();
      await panel.getByRole('button', { name: 'Comments', exact: true }).click();
      await expect(panel.locator('.task-detail-main')).toBeHidden();
      await expect(panel.locator('.task-comments-section')).toBeVisible();
    } else {
      const share = await panel.evaluate(node => {
        const brief = node.querySelector('.task-detail-main').getBoundingClientRect();
        const comments = node.querySelector('.task-comments-section').getBoundingClientRect();
        return comments.width / (brief.width + comments.width);
      });
      expect(share).toBeGreaterThan(0.53);
    }
    await expect(panel.locator('.task-comments-list .task-comment-body').first()).toContainText('Latest update');
    await page.evaluate(async () => {
      const store = window.Alpine.store('chat');
      await store.applyTaskComments([{ record_id: 'live', body: 'Live update', updated_at: '2026-10-05T03:00:00Z', sender_npub: 'npub1fixture' }, ...store.taskComments]);
    });
    await expect(panel.locator('.task-comments-list .task-comment-body').first()).toContainText('Live update');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/docs/handoffs/task-record-${width}.png`, fullPage: true });
    if (width < 769) {
      await panel.getByRole('button', { name: 'Task', exact: true }).click();
      await expect(panel.locator('.task-description-section')).toBeVisible();
      await expect(panel.locator('.task-comments-section')).toBeHidden();
    }
    expect(await page.evaluate(() => window.Alpine.store('chat').editingTask.scope_id)).toBe('scope-preserved');
  });
}

for (const width of [1280, 390]) {
  test(`read-mode task header and rich description at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.editingTask.assigned_to_npubs = ['npub1fixture'];
      store.getSenderName = () => 'Layout reviewer';
      store.taskDetailMode = 'view';
      store.taskDescriptionEditing = false;
    });
    const panel = page.locator('.task-detail-panel');
    await expect(panel.locator('.task-detail-title-display')).toHaveText('A readable task record');
    await expect(panel.locator('.task-detail-meta-row')).toContainText('Layout reviewer');
    await expect(panel.locator('.task-desc-preview h2')).toHaveText('Expected outcome');
    await expect(panel.locator('.task-detail-meta-row')).not.toContainText('[object');
    if (width < 769) {
      await panel.getByRole('button', { name: 'Comments', exact: true }).click();
      await expect(panel.locator('.task-detail-main')).toBeHidden();
    }
    await page.screenshot({ path: `tmp/docs/handoffs/task-record-read-${width}.png`, fullPage: true });
  });
}
