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
 test(`polished board metadata and Backlog filter at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height:900}); await openFixture(page);
  await page.evaluate(()=> { const s=Alpine.store('chat'); s.showTaskDetail=false; s.selectedBoardId=null; s.taskViewMode='kanban'; s.taskFilterState=''; s.taskFilterTags=[]; s.taskFilter=''; s.taskFilterAssignee=null; s.tasks=[{record_id:'backlog-task',title:'Plan the next release',state:'new',tags:'polish,accessibility',scheduled_for:'2026-10-15',record_state:'active',version:1},{record_id:'ready-task',title:'Review the compact controls',state:'ready',tags:'polish',record_state:'active',version:1}]; });
  const column=page.locator('.kanban-col-new'); await expect(column.locator('.kanban-column-title')).toHaveText('Backlog');
  await column.locator('.kanban-column-header').click(); await expect(column.locator('.kanban-card')).toContainText('Plan the next release');
  await expect(column.locator('.task-card-tag').first()).toHaveCSS('border-radius','6px');
  await expect(column.locator('.badge-date')).toHaveCSS('border-radius','10px');
  if(width<769) await page.getByRole('button',{name:'Task controls',exact:true}).click();
  const filter=page.getByRole('button',{name:'Filter tasks by status',exact:true});
  const mine=page.locator('.filter-to-me-btn'); await expect(mine).toHaveCSS('border-radius','6px'); await mine.focus(); await mine.press('Space'); await expect(mine).toHaveAttribute('aria-pressed','true'); await mine.press('Space'); await expect(mine).toHaveAttribute('aria-pressed','false');
  await filter.focus(); await filter.press('ArrowDown');
  const states=page.getByRole('group',{name:'Task status filters'});
  await expect(states.getByRole('button',{name:'All statuses',exact:true})).toBeFocused();
  const neutral=await states.getByRole('button',{name:'All statuses',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor);
  const ready=await states.getByRole('button',{name:'Ready',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(ready).not.toBe(neutral);
  await page.keyboard.press('ArrowDown'); await expect(states.getByRole('button',{name:'Backlog',exact:true})).toBeFocused();
  await page.keyboard.press('Enter'); await expect(filter).toContainText('Backlog');
  expect(await page.evaluate(()=>Alpine.store('chat').taskFilterState)).toBe('new');
  expect(await page.evaluate(()=>Alpine.store('chat').tasks[0].state)).toBe('new');
  await filter.press('ArrowUp'); await expect(states.getByRole('button',{name:'Done',exact:true})).toBeFocused();
  await page.keyboard.press('Home'); await expect(states.getByRole('button',{name:'All statuses',exact:true})).toBeFocused();
  const bounds=await states.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
  await page.screenshot({path:`tmp/docs/handoffs/task-board-filter-${width}.png`,fullPage:true});
  await page.keyboard.press('Escape'); await expect(filter).toBeFocused();
  await filter.click(); await states.getByRole('button',{name:'All statuses',exact:true}).click();
  await page.locator('.task-tag-filters .tag-chip').filter({hasText:'accessibility'}).click();
  expect(await page.evaluate(()=>Alpine.store('chat').taskFilterTags)).toEqual(['accessibility']);
  await page.locator('.clear-filters-btn').click();
  await page.evaluate(()=>Alpine.store('chat').toggleTaskViewMode());
  const group=page.locator('.task-list-group').filter({has:page.locator('.task-list-group-new')});
  await expect(group.locator('.task-list-group-label')).toHaveText('Backlog');
  await group.locator('.task-list-group-header').click();
  await expect(group.locator('.task-list-row')).toContainText('Plan the next release');
  if(width<769) await page.getByRole('button',{name:'Task controls',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`tmp/docs/handoffs/task-board-list-${width}.png`,fullPage:true});
  await page.evaluate(()=>Alpine.store('chat').openTaskDetail('backlog-task'));
  await expect(page.getByRole('button',{name:'Change task status: Backlog'})).toBeVisible();
 });
}
