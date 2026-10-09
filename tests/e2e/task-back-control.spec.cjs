const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

async function openFixture(page) {
  await page.route('**/*', route => {
    if (process.env.FLIGHTDECK_TASK_LIVE !== '1') return serveBuiltFlightDeck(route);
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'stopTaskCommentsLiveQuery', 'startTaskCommentsLiveQuery', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead']) store[key] = () => {};
    store.showWorkspaceBootstrapModal = false;
    store.backendUrl = "http://127.0.0.1:3100";
    store.session = { npub: 'npub1fixture' };
    store.bootstrapSelectedWorkspace = async () => {};
    store.ensurePgWorkspaceAvailable = async workspace => workspace;
    store.knownWorkspaces = [{ workspaceKey: 'layout-workspace', workspaceId: 'layout-workspace', workspaceOwnerNpub: 'npub1fixture', directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    for (const key of ['startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) store[key] = async () => {};
    await store.selectWorkspace('layout-workspace', { skipPgVerification: true });
    store.selectWorkspace = async () => {};
    await store.loadLocalScopes();
    store.openConnectModal = () => {};
    store.showConnectModal = false;
    store.error = null;
    store.rememberPeople = async () => {};
    store.tasks = [{ record_id: 'layout-task', pg_backend: true, pg_record_type: 'task', pg_channel_id: 'fixture-channel', title: 'A readable task record', description: '## Expected outcome\n\nA clear brief with a working conversation.\n\n- Preserve rich descriptions\n- Keep dependencies accessible', state: 'in_progress', assigned_to_npubs: [], scope_id: 'scope-preserved', predecessor_task_ids: ['dependency'], tags: '', record_state: 'active', sync_status: 'synced', version: 1 }, { record_id: 'dependency', title: 'Agree the layout', state: 'done', tags: '', record_state: 'active', version: 1 }];
    store.loadTaskComments = async () => store.applyTaskComments([
      { record_id: 'old', body: 'Earlier update', updated_at: '2026-10-05T01:00:00Z', sender_npub: 'npub1fixture' },
      { record_id: 'new', body: 'Latest update', updated_at: '2026-10-05T02:00:00Z', sender_npub: 'npub1fixture' },
    ]);
    store.navSection = 'tasks';
    store.commandTowerWorkspace = async (name, input) => { if (name !== 'task.update') throw new Error('Unexpected synthetic command: ' + name); window.taskSavedPatch = input.patch; return { ...input.task, version: input.task.version + 1, sync_status: 'synced' }; };
    store.openTaskDetail('layout-task');
  });
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.locator('.task-detail-panel')).toBeVisible();
}


for (const width of [1280, 390, 320]) {
 for (const theme of ['light', 'dark']) {
  test(`Back placement and task header interactions ${width}px ${theme}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(theme => localStorage.setItem('ambulando:theme', theme), theme);
    await openFixture(page);
    const header = page.locator('.task-detail-header');
    const back = header.getByRole('button', { name: 'Back', exact: true });
    const title = header.getByRole('textbox', { name: 'Task title' });
    const longTitle = 'Preserve task navigation and editing with a long title '.repeat(8);
    await title.fill(longTitle);
    await expect(header.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    const bb = await back.boundingBox(); const tb = await title.boundingBox();
    expect(bb.x + bb.width).toBeLessThanOrEqual(tb.x);
    expect(Math.abs(bb.y + bb.height / 2 - tb.y - tb.height / 2)).toBeLessThan(2);
    expect(tb.width).toBeGreaterThan(120);
    for (const button of await header.locator('button:visible').all()) {
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await back.focus();
    const focus = await back.evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }));
    expect(focus.outline).not.toBe('none'); expect(focus.width).toBeGreaterThan(0);
    await page.keyboard.press('Tab'); await expect(title).toBeFocused();
    await title.press('Tab'); await expect(header.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await header.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(title).toHaveValue('A readable task record');
    await title.fill(longTitle);
    await page.evaluate(() => { Alpine.store('chat').taskDetailSaving = true; });
    await expect(header.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
    await expect(header.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
    await page.evaluate(() => { Alpine.store('chat').taskDetailSaving = false; });
    await header.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.taskSavedPatch?.title)).toBe(longTitle);
    await page.evaluate(() => Alpine.store('chat').openTaskDetail('layout-task'));
    await expect(title).toHaveValue(longTitle);
    await header.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(header.getByRole('button', { name: 'Copied link', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('layout-task');
    const menu = header.getByRole('button', { name: 'More actions' });
    await menu.focus(); await page.keyboard.press('Enter');
    await expect(header.getByRole('button', { name: 'Move to…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
    await menu.click(); await header.getByRole('button', { name: 'FD Ref', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mention:task:layout-task');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(header.locator('.doc-actions-popover')).toBeHidden();
    if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/header-${width}-${theme}.png`, fullPage: true });
    // Read mode keeps long text bounded; modal close retains its existing right-side control.
    await page.evaluate(() => { Alpine.store('chat').taskDetailMode = 'view'; });
    await expect(header.getByRole('heading')).toHaveText(longTitle);
    const readBounds = await header.getByRole('heading').boundingBox();
    expect(readBounds.x).toBeGreaterThan(bb.x + bb.width);
    expect(readBounds.x + readBounds.width).toBeLessThanOrEqual(width);
    const actionsBounds = await header.locator('.task-detail-actions').boundingBox();
    expect(readBounds.x + readBounds.width <= actionsBounds.x + 1 || readBounds.y + readBounds.height <= actionsBounds.y + 1).toBe(true);
    if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/read-${width}-${theme}.png`, fullPage: true });
    await page.evaluate(() => { const s = Alpine.store('chat'); s.taskDetailMode = 'edit'; s.chatTaskModalOpen = true; });
    await expect(back).toBeHidden();
    await expect(header.getByRole('button', { name: 'Close task', exact: true })).toBeVisible();
    await page.evaluate(() => { Alpine.store('chat').chatTaskModalOpen = false; });
    // Existing Back persists PG drafts even during saving; it has no busy-exit block.
    await title.fill('Draft retained by Back');
    if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/draft-${width}-${theme}.png`, fullPage: true });
    await page.evaluate(() => { Alpine.store('chat').taskDetailSaving = true; });
    await back.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.task-detail-panel')).toHaveCount(0);
    await page.evaluate(() => Alpine.store('chat').openTaskDetail('layout-task'));
    await expect(title).toHaveValue('Draft retained by Back');
    await header.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(title).toHaveValue(longTitle);
    // Exercise the actual history return branch with an origin route in browser history.
    await page.evaluate(() => {
      history.replaceState({}, '', '/?origin=back-control');
      history.pushState({ taskDetailOriginRoute: '/?origin=back-control' }, '', '/?task=layout-task');
      Alpine.store('chat').taskDetailOriginRoute = '/?origin=back-control';
    });
    await back.click();
    await expect.poll(() => page.url()).toContain('origin=back-control');
  });
 }
}
