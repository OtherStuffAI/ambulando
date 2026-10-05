const { test, expect } = require('playwright/test');
test.setTimeout(30_000);
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

async function openTask(page, description = 'Ordinary description text.\n\n[Guide](https://example.com/guide) and @[Dependency](mention:task:dependency).', overrides = {}) {
  await page.route('**/*', route => {
    if (!process.env.FLIGHTDECK_ENTRY_LIVE) return serveBuiltFlightDeck(route);
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(async ({ description, overrides }) => {
    const s = window.Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'syncRoute', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead', 'resolveChatProfile', 'recomputeTowerPgUnreadProjection', 'rememberPeople', 'refreshReactionsForVisibleTargets']) s[key] = async () => {};
    s.showWorkspaceBootstrapModal = false;
    s.showConnectModal = false;
    s.session = { npub: 'npub1fixture' };
    s.knownWorkspaces = [{ workspaceKey: 'entry-workspace', workspaceId: 'entry-workspace', workspaceOwnerNpub: 'npub1fixture', directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    for (const key of ['startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) s[key] = async () => {};
    await s.selectWorkspace('entry-workspace', { skipPgVerification: true });
    s.backendUrl = 'http://127.0.0.1:3100';
    s.tasks = [{ record_id: 'entry-task', title: 'Edit the brief', description, state: 'in_progress', priority: 'sand', assigned_to_npubs: [], predecessor_task_ids: [], record_state: 'active', sync_status: 'synced', version: 1, pg_backend: true, pg_record_type: 'task', ...overrides }];
    s.loadTaskComments = async () => s.applyTaskComments([
      { record_id: 'old', body: 'Earlier update', updated_at: '2026-10-05T01:00:00Z' },
      { record_id: 'new', body: 'Latest update', updated_at: '2026-10-05T02:00:00Z' },
    ]);
    s.openTaskDetail('entry-task');
    // The real selected-task materialization callback that caused the regression.
    await s.applySelectedTask(s.tasks[0]);
  }, { description, overrides });
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.showConnectModal = false; s.showWorkspaceBootstrapModal = false; });
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.locator('.task-detail-panel')).toBeVisible();
}

for (const width of [1280, 390, 320]) {
  test(`real PG open, description click and immediate typing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTask(page);
    const panel = page.locator('.task-detail-panel');
    await expect(panel.locator('.task-desc-preview')).toBeVisible();
    await panel.locator('.task-desc-preview p').first().click();
    // Do not focus the editor or wait for its lazy mount before sending keys.
    await page.keyboard.type('Zfirst character');
    const editor = panel.locator('.ProseMirror[aria-label="Task description"]');
    await expect(editor).toBeFocused();
    await expect(editor).toContainText('Zfirst character');
    await expect(editor).toHaveCount(1);
    await expect(panel.locator('[aria-label="Task description formatting"]')).toHaveCount(1);
    await expect(panel.locator('.task-save-btn')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
    if (width < 769) {
      await panel.getByRole('button', { name: 'Comments', exact: true }).click();
      await expect(panel.locator('.task-detail-main')).toBeHidden();
      await expect(panel.locator('.task-comments-list .task-comment-body').first()).toContainText('Latest update');
      await panel.getByRole('button', { name: 'Task', exact: true }).click();
      await expect(editor).toContainText('Zfirst character');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`empty PG description has keyboard entry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTask(page, '');
    const button = page.getByRole('button', { name: 'Edit description', exact: true });
    await expect(page.getByText('Add a description', { exact: true })).toBeVisible();
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Empty task now has a brief');
    await expect(page.getByRole('textbox', { name: 'Task description', exact: true })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Task description', exact: true })).toHaveText('Empty task now has a brief');
  });
}

test('links and selection keep preview navigation and reading', async ({ page }) => {
  await openTask(page);
  const preview = page.locator('.task-desc-preview');
  await page.evaluate(() => { window.Alpine.store('chat').openChatTaskModal = async id => { window.referenceOpened = id; }; });
  await preview.locator('[data-mention-type=task]').click();
  await expect.poll(() => page.evaluate(() => window.referenceOpened)).toBe('dependency');
  const popup = page.waitForEvent('popup');
  await preview.getByRole('link', { name: 'Guide', exact: true }).click();
  await (await popup).close();
  await expect(preview).toBeVisible();
  await preview.locator('p').first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(preview).toBeVisible();
  await expect(page.locator('.task-rich-editor')).toHaveCount(0);
});

for (const blocked of ['read_only', 'saving', 'checkout', 'pending']) {
  test(`description entry respects ${blocked}`, async ({ page }) => {
    await openTask(page, 'Protected description', blocked === 'read_only' ? { read_only: true } : blocked === 'pending' ? { sync_status: 'pending', coedit_state: 'rejected' } : {});
    await page.evaluate(blocked => {
      const s = window.Alpine.store('chat');
      if (blocked === 'saving') s.taskDetailSaving = true;
      if (blocked === 'checkout') s.taskDetailCheckoutPending = true;
    }, blocked);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.showConnectModal = false; s.showWorkspaceBootstrapModal = false; });
    await page.locator('.task-desc-preview p').click();
    await expect(page.locator('.task-desc-preview')).toBeVisible();
    await expect(page.locator('.task-rich-editor')).toHaveCount(0);
    if (blocked === 'pending') await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').error)).toContain('pending save');
    else await expect(page.getByRole('button', { name: 'Edit description', exact: true })).toBeDisabled();
  });
}
