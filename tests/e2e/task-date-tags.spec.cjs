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
 for (const modal of [false, true]) {
  test(`calendar and tags draft controls ${width}px ${modal ? 'modal' : 'page'}`, async ({page}) => {
    await page.setViewportSize({width, height:900});
    await openFixture(page);
    await page.evaluate(modal => { const s=Alpine.store('chat'); s.editingTask.scheduled_for='2026-10-06'; s.editingTask.tags='design'; s.tasks.push({record_id:'vocabulary',tags:'polish,accessibility',state:'new',record_state:'active'}); if(modal) s.chatTaskModalOpen=true; }, modal);
    const date=page.getByRole('button',{name:'Schedule task',exact:true});
    await date.click();
    const calendar=page.getByRole('dialog',{name:'Schedule task calendar'});
    await expect(calendar).toBeVisible();
    await expect(calendar.locator('[data-date="2026-10-06"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(calendar.locator('[data-date="2026-10-07"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(date).toContainText('Oct 7');
    await expect(date).toBeFocused();
    await date.click();
    await calendar.locator('[data-date="2026-10-31"]').click();
    await date.click(); await expect(calendar.locator('[data-date="2026-10-31"]')).toBeFocused(); await page.keyboard.press('ArrowRight');
    await expect(calendar.locator('[data-date="2026-11-01"]')).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect(calendar.locator('strong')).toHaveText('December 2026');
    await expect(calendar.locator('[data-date="2026-12-01"]')).toBeFocused();
    await page.keyboard.press('PageUp');
    await expect(calendar.locator('[data-date="2026-11-01"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(calendar.locator('[data-date="2026-10-26"]')).toBeFocused();
    await page.keyboard.press('End');
    await expect(calendar.locator('[data-date="2026-11-01"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await date.click();
    await calendar.getByRole('button',{name:'Next month'}).click();
    await expect(calendar.locator('strong')).toHaveText('November 2026');
    await page.keyboard.press('Escape');
    await expect(date).toBeFocused();
    await date.click();
    await calendar.getByRole('button',{name:'Clear date'}).click();
    await expect(date).toHaveText('No date');
    await page.getByRole('button',{name:'Add tag',exact:true}).click();
    const search=page.getByRole('textbox',{name:'Find or create tag'});
    await search.fill('pol');
    await page.getByRole('button',{name:'polish',exact:true}).click();
    const tagBounds=await page.getByRole('dialog',{name:'Add task tags'}).boundingBox(); expect(tagBounds.x).toBeGreaterThanOrEqual(0); expect(tagBounds.x+tagBounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({path:`tmp/docs/handoffs/task-tags-popup-${width}-${modal ? 'modal' : 'page'}.png`,fullPage:true});
    await search.fill('Custom');
    await search.press('Enter');
    await search.fill('CUSTOM');
    await search.press('Enter');
    await search.press('Escape');
    await expect(page.getByRole('button',{name:'Remove tag custom'})).toHaveCount(1);
    await page.getByRole('button',{name:'Remove tag design'}).click();
    expect(await page.evaluate(()=>Alpine.store('chat').editingTask.tags)).toBe('polish,custom');
    await date.click();
    const bounds=await calendar.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`tmp/docs/handoffs/task-date-tags-${width}-${modal ? 'modal' : 'page'}.png`,fullPage:true});
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Discard',exact:true}).click();
    await expect(date).toHaveText('No date');
    expect(await page.evaluate(()=>Alpine.store('chat').editingTask.tags)).toBe('');
    await date.click();
    const day=calendar.locator('.task-calendar-days button').filter({hasText:/^15$/}).first();
    const selected=await day.getAttribute('data-date'); await day.click();
    await page.getByRole('button',{name:'Add tag',exact:true}).click();
    await search.fill('saved-tag'); await search.press('Enter'); await search.press('Escape');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.taskSavedPatch?.tags)).toBe('saved-tag');
    expect(await page.evaluate(()=>window.taskSavedPatch.scheduled_for)).toBe(selected);
    await page.evaluate(()=>Alpine.store('chat').openTaskDetail('layout-task'));
    await expect(page.getByRole('button',{name:'Remove tag saved-tag'})).toBeVisible();
    expect(await page.evaluate(()=>Alpine.store('chat').editingTask.scheduled_for)).toBe(selected);
  });
 }
}
