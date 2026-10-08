const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { buildGroupsAccessFixture, seedGroupsAccess } = require('./fixtures/groups-access-seed.cjs');

for (const width of [1280, 390]) {
  test(`membership recovery preserves routing without stale content at ${width}px`, async ({ page }) => {
    test.setTimeout(30000);
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto('/');
    const fixture = buildGroupsAccessFixture();
    await seedGroupsAccess(page, fixture);
    await page.evaluate(() => {
      const s = Alpine.store('chat');
      s.navSection = 'chat'; s.selectedBoardId = 'scope-beacon'; s.selectedChannelId = 'ch-dialogue';
      s.activeThreadId = null; s.messageInput = 'Recoverable membership draft';
      s.messages = [{ record_id: 'private-old', channel_id: 'ch-dialogue', body: 'Revoked private body', record_state: 'active', updated_at: new Date().toISOString() }];
      s.pgNavigationWorkspaceKey = s.currentWorkspaceKey; s.pgNavigationGeneration = 1;
      s.chatPresentationCache = new Map([['ch-dialogue', { messages: s.messages }]]);
    });
    await page.evaluate(() => Alpine.store('chat').applyPgNavigationProjection({ generation: 2, pending: true, scopes: [], channels: [] }));
    await expect(page.getByRole('status').filter({ hasText: 'Rechecking workspace access' })).toBeVisible();
    await expect(page.getByText('Revoked private body', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => {
      const s = Alpine.store('chat'); return { board: s.selectedBoardId, channel: s.selectedChannelId, messages: s.messages.length, input: s.messageInput, cache: s.chatPresentationCache.size };
    })).toEqual({ board: 'scope-beacon', channel: null, messages: 0, input: '', cache: 0 });
    for (let i = 0; i < 4; i++) await page.evaluate(fx => Alpine.store('chat').applyPgNavigationProjection({ generation: 2, pending: true, scopes: fx.scopes, channels: fx.channels }), fixture);
    expect(await page.evaluate(() => Alpine.store('chat').selectedChannelId)).toBeNull();
    await page.evaluate(fx => Alpine.store('chat').applyPgNavigationProjection({ generation: 2, pending: false, scopes: fx.scopes, channels: fx.channels }), fixture);
    expect(await page.evaluate(() => ({ channel: Alpine.store('chat').selectedChannelId, draft: Alpine.store('chat').messageInput }))).toEqual({ channel: 'ch-dialogue', draft: 'Recoverable membership draft' });
    await expect(page.getByRole('status').filter({ hasText: 'Rechecking workspace access' })).toBeHidden();
    // Another authoritative replacement definitively revokes this destination.
    await page.evaluate(() => Alpine.store('chat').applyPgNavigationProjection({ generation: 3, pending: true, scopes: [], channels: [] }));
    await page.evaluate(() => Alpine.store('chat').applyPgNavigationProjection({ generation: 3, pending: false, scopes: [], channels: [] }));
    expect(await page.evaluate(() => ({ channel: Alpine.store('chat').selectedChannelId, messages: Alpine.store('chat').messages.length, draft: Alpine.store('chat').messageInput }))).toEqual({ channel: null, messages: 0, draft: '' });
    await expect(page.getByText('Revoked private body', { exact: true })).toHaveCount(0);

  });
}

async function presentAuthority(page, fixture, generation, pending, clear = false) {
  await page.evaluate(({ fx, generation, pending, clear }) => Alpine.store('chat').applyPgNavigationProjection({
    generation, pending, scopes: clear ? [] : fx.scopes, channels: clear ? [] : fx.channels,
  }), { fx: fixture, generation, pending, clear });
}

for (const kind of ['task', 'doc']) {
  test(`Authority reset removes rendered ${kind} detail and fences pending navigation`, async ({ page }) => {
    test.setTimeout(30000);
    await page.route('**/*', route => serveBuiltFlightDeck(route)); await page.goto('/');
    await page.waitForFunction(() => Boolean(Alpine.store('chat')));
    const fixture = buildGroupsAccessFixture(); await seedGroupsAccess(page, fixture);
    await presentAuthority(page, fixture, 1, false);
    await page.evaluate(() => { Alpine.store('chat').navSection = 'settings'; });
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').pgNavigationGeneration)).toBe(1);
    const title = `Private ${kind} recovery sentinel`;
    await page.evaluate(({ kind, title }) => {
      const s = Alpine.store('chat'); const row = { record_id: `private-${kind}`, title, description: title, content: title, record_state: 'active', scope_id: 'scope-beacon', group_ids: [], version: 1, sync_status: 'synced', content_format: 'markdown', content_storage_status: 'loaded', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      s.selectedBoardId = 'scope-beacon';
      if (kind === 'task') { s.navSection = 'tasks'; s.tasks = [row]; s.activeTaskId = row.record_id; s.editingTask = row; s.taskEditOriginal = { ...row }; s.taskDetailMode = 'view'; s.showTaskDetail = true; }
      if (kind === 'doc') { s.navSection = 'docs'; s.documents = [row]; s.selectedDocType = 'document'; s.selectedDocId = row.record_id; s.loadDocEditorFromSelection(row); s.docEditorMode = 'source'; s.docEditorBodyLoaded = true; }
    }, { kind, title });
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    await presentAuthority(page, fixture, 2, true, true);
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').pgNavigationRecoveryPending)).toBe(true);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => ({ task: Alpine.store('chat').editingTask, doc: Alpine.store('chat').docEditorContent, report: Alpine.store('chat').reportModalReport }))).toEqual({ task: null, doc: '', report: null });
    // Real navigation methods must retain new IDs without mounting old content.
    await page.evaluate(() => { const s = Alpine.store('chat'); s.openTaskDetail('new-task'); s.openDoc('new-doc'); });
    await presentAuthority(page, fixture, 3, true, true);
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').pgNavigationGeneration)).toBe(3);
    expect(await page.evaluate(() => ({ id: Alpine.store('chat').pgNavigationRecoverySelection.docId, editor: Alpine.store('chat').docEditorContent, task: Alpine.store('chat').editingTask }))).toEqual({ id: 'new-doc', editor: '', task: null });
    await presentAuthority(page, fixture, 3, false, true);
    await expect.poll(() => page.evaluate(() => Alpine.store('chat').pgNavigationRecoveryPending)).toBe(false);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  });
}

for (const action of ['workspace switch', 'logout']) {
  test(`pending recovery intent and editor models cannot cross ${action}`, async ({ page }) => {
    test.setTimeout(30000);
    await page.route('**/*', route => serveBuiltFlightDeck(route)); await page.goto('/');
    const fixture = buildGroupsAccessFixture(); await seedGroupsAccess(page, fixture);
    await presentAuthority(page, fixture, 1, false);
    await page.evaluate(() => {
      const s = Alpine.store('chat'); s.navSection = 'tasks'; s.activeTaskId = 'private-task';
      s.editingTask = { record_id: 'private-task', title: 'Lifecycle private task', record_state: 'active' };
      s.taskEditOriginal = { ...s.editingTask }; s.taskDetailMode = 'view'; s.showTaskDetail = true;
      // Draft storage is covered by canonical/unit tests; this fixture checks rendered lifecycle.
      s.persistTaskLocalDraft = async () => true;
    });
    await expect(page.getByText('Lifecycle private task', { exact: true })).toBeVisible();
    await presentAuthority(page, fixture, 2, true, true);
    await expect(page.getByText('Lifecycle private task', { exact: true })).toHaveCount(0);
    await page.evaluate(async action => {
      const s = Alpine.store('chat');
      if (action === 'logout') await s.logout();
      else {
        s.knownWorkspaces = [...s.knownWorkspaces, { ...s.currentWorkspace, workspaceKey: 'disposable-second-workspace', workspaceId: 'disposable-second-workspace' }];
        await s.selectWorkspace('disposable-second-workspace', { skipPgVerification: true, refresh: false });
      }
    }, action);
    expect(await page.evaluate(() => ({ intent: Alpine.store('chat').pgNavigationRecoverySelection,
      task: Alpine.store('chat').editingTask, doc: Alpine.store('chat').docEditorContent, report: Alpine.store('chat').reportModalReport }))).toEqual({ intent: null, task: null, doc: '', report: null });
    await expect(page.getByText('Lifecycle private task', { exact: true })).toHaveCount(0);
  });
}
