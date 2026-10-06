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
    store.tasks = [{ record_id: 'layout-task', title: 'A readable task record', description: '## Expected outcome\n\nA clear brief with a working conversation.\n\n- Preserve rich descriptions\n- Keep dependencies accessible', state: 'in_progress', assigned_to_npubs: [], scope_id: 'scope-preserved', predecessor_task_ids: ['dependency'], tags: '', record_state: 'active', sync_status: 'synced', version: 1 }, { record_id: 'dependency', title: 'Agree the layout', state: 'done', tags: '', record_state: 'active', version: 1 }];
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
    await expect(panel.locator('.task-assignee-selected')).toContainText('Layout reviewer');
    await expect(panel.locator('.task-desc-preview h2')).toHaveText('Expected outcome');
    await expect(panel.locator('.task-detail-meta-row')).not.toContainText('[object');
    if (width < 769) {
      await panel.getByRole('button', { name: 'Comments', exact: true }).click();
      await expect(panel.locator('.task-detail-main')).toBeHidden();
    }
    await page.screenshot({ path: `tmp/docs/handoffs/task-record-read-${width}.png`, fullPage: true });
  });
}

// Exercise the actual PG editing path with a document-sized brief rather than
// relying on the short read-mode fixture above.
for (const mode of ['edit', 'view']) {
  for (const width of [1280, 390, 320]) {
    test(`long PG description owns no nested scroll in ${mode} mode at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFixture(page);
      await page.evaluate((mode) => {
        const store = window.Alpine.store('chat');
        store.editingTask.title = 'Flight Deck: adopt durable per-device sync checkpoints';
        store.editingTask.description = [
          '# Durable device checkpoints',
          'Flight Deck must adopt independent device checkpoints so each browser cache resumes after its own last committed position. Preserve pending edits, permissions and older-server support. Coordinate with @[Layout reviewer](mention:person:npub1fixture).',
          ...Array.from({ length: 14 }, (_, i) => `## Implementation requirement ${i + 1}\n\nThe browser must commit the complete materialization before acknowledging its position. Interrupted requests must recover safely without dropping local edits or replaying incomplete state. Coordinate the worker, transport and local persistence while preserving existing behavior.\n\nValidate cold bootstrap, incremental recovery and concurrent changes with realistic records and meaningful assertions.`),
          '## Final acceptance\n\n- The whole description remains accessible.\n- Dependency and subtask controls follow it.\n\n[Guide](https://example.com/guide) and @[Dependency](mention:task:dependency).',
        ].join('\n\n');
        store.editingTask.assigned_to_npubs = ['npub1fixture'];
        store.getSenderName = () => 'Layout reviewer';
        store.taskDetailMode = mode;
        store.taskDescriptionEditing = mode === 'edit';
      }, mode);
      const panel = page.locator('.task-detail-panel');
      const main = panel.locator('.task-detail-main');
      const scrollOwner = width > 768 ? main : panel.locator('.task-detail-body');
      const surface = panel.locator(mode === 'edit' ? '.task-rich-editor .ProseMirror' : '.task-desc-preview');
      await expect(surface).toBeVisible();
      await expect(surface.locator('h1')).toHaveText('Durable device checkpoints');
      await expect(surface.locator('h2')).toHaveCount(15);
      await expect(surface.locator('li')).toHaveCount(2);
      await expect(surface.locator('a[href="https://example.com/guide"]')).toHaveText('Guide');
      await expect(surface.locator('[data-mention-type=task]')).toHaveAttribute('data-mention-id', 'dependency');
      if (mode === 'edit') {
        await expect(surface).toHaveAttribute('contenteditable', 'true');
        await panel.getByRole('button', { name: 'Change task status: In Progress' }).click();
        await panel.getByRole('button', { name: 'Review', exact: true }).click();
        expect(await page.evaluate(() => window.Alpine.store('chat').editingTask.state)).toBe('review');
        await expect(panel.locator('.task-assignee-selected')).toContainText('Layout reviewer');
        await expect(panel.getByRole('textbox', { name: 'Assign task' })).toBeHidden();
      } else {
        await expect(surface.locator('h1')).toHaveText('Durable device checkpoints');
        await expect(surface.locator('h2')).toHaveCount(15);
      }
      if (mode === 'edit' && width === 1280) {
        await expect(surface.locator('[data-mention-type=person]')).toContainText('Layout reviewer');
        await page.evaluate(() => {
          const editor = window.Alpine.store('chat').taskRichDescriptionAdapter.getEditor();
          const from = editor.state.doc.firstChild.nodeSize + 1;
          editor.commands.setTextSelection({ from, to: from + 11 });
        });
        await panel.getByRole('button', { name: 'Bold', exact: true }).click();
        await expect(surface.locator('strong')).toContainText('Flight Deck');

        await surface.evaluate(node => {
          const editor = window.Alpine.store('chat').taskRichDescriptionAdapter.getEditor();
          editor.commands.setTextSelection(editor.state.doc.content.size - 1);
          node.focus();
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', '\nPasted acceptance paragraph.');
          node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        });
        await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').editingTask.description)).toContain('Pasted acceptance paragraph');
        await expect(surface.locator('[data-mention-type=person]')).toContainText('Layout reviewer');
        await page.evaluate(() => {
          const store = window.Alpine.store('chat');
          store.searchMentions = () => [{ type: 'person', id: 'npub1inserted', label: 'Mention recipient' }];
          store.refreshMentionResultsFromLocalIndex = () => {};
          const editor = store.taskRichDescriptionAdapter.getEditor();
          editor.commands.focus('end');
        });
        await surface.press('End');
        await page.keyboard.type(' @Mention');
        await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').mentionActive)).toBe(true);
        await surface.press('Enter');
        await expect(surface.locator('[data-mention-id=npub1inserted]')).toHaveText('Mention recipient');
        await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').editingTask.description)).toContain('@[Mention recipient](mention:person:npub1inserted)');
        await scrollOwner.evaluate(node => { node.scrollTop = 0; });
      }
      const geometry = await surface.evaluate(node => {
        const pane = innerWidth > 768 ? node.closest('.task-detail-main') : node.closest('.task-detail-body');
        const section = node.closest('.task-description-section');
        return {
          height: node.getBoundingClientRect().height,
          clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
          overflow: getComputedStyle(node).overflowY,
          paneHeight: pane.clientHeight, paneScrollHeight: pane.scrollHeight,
          border: getComputedStyle(node).borderTopWidth,
          sectionBorder: getComputedStyle(section).borderTopWidth,
          headerHeight: document.querySelector('.task-record-heading').getBoundingClientRect().height,
        };
      });
      expect(geometry.height).toBeGreaterThan(geometry.paneHeight * 2);
      expect(geometry.scrollHeight - geometry.clientHeight).toBeLessThanOrEqual(2);
      expect(geometry.overflow).toBe('visible');
      expect(geometry.paneScrollHeight).toBeGreaterThan(geometry.paneHeight * 2);
      expect(geometry.border).toBe('0px');
      expect(geometry.sectionBorder).toBe('0px');
      expect(geometry.headerHeight).toBeLessThan(width > 768 ? 165 : 220);
      console.log('TASK_RECORD_GEOMETRY', JSON.stringify({ mode, width, ...geometry }));
      const box = await scrollOwner.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 80);
      await page.mouse.wheel(0, 550);
      await expect.poll(() => scrollOwner.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
      expect(await surface.evaluate(node => node.scrollTop)).toBe(0);
      // Wheel over secondary content also belongs to the same pane.
      await scrollOwner.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(panel.locator(mode === 'edit' ? '.subtask-list-field' : '.task-predecessor-link')).toBeVisible();
      const before = await scrollOwner.evaluate(node => node.scrollTop);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 35);
      await page.mouse.wheel(0, -300);
      await expect.poll(() => scrollOwner.evaluate(node => node.scrollTop)).toBeLessThan(before - 50);
      await scrollOwner.evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: `tmp/docs/handoffs/task-record-long-${mode}-${width}.png`, fullPage: true });
      if (width < 769) {
        await panel.getByRole('button', { name: 'Comments', exact: true }).click();
        await expect(main).toBeHidden();
        await expect(panel.locator('.task-comments-section')).toBeVisible();
        await panel.getByRole('button', { name: 'Task', exact: true }).click();
        await expect(surface).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(panel.locator('label').filter({ hasText: /^Scope$/ })).toHaveCount(0);
      await page.evaluate(() => {
        const store = window.Alpine.store('chat');
        store.handleMentionNavigate = async (type, id) => { window.taskReferenceOpened = id; };
      });
      await surface.locator('[data-mention-type=task]').click();
      await expect.poll(() => page.evaluate(() => window.taskReferenceOpened)).toBe('dependency');
    });
  }
}

for (const width of [1280, 390, 320]) {
  test(`compact task card controls and keyboard picker at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.getSenderName = () => 'Layout reviewer';
      store.taskEditOriginal = { ...store.editingTask, assigned_to_npubs: [] };
      store.findPeopleSuggestions = () => [{ npub: 'npub1fixture', label: 'Layout reviewer', subtitle: 'Reviewer' }];
    });
    const panel = page.locator('.task-detail-panel');
    const header = panel.locator('.task-detail-header');
    const title = header.getByRole('textbox', { name: 'Task title' });
    await expect(title).toBeVisible();
    await title.fill('Design Unix-first local Nostr signer for Autopilot');
    const assign = panel.getByRole('textbox', { name: 'Assign task' });
    await expect(assign).toBeVisible();
    expect((await assign.boundingBox()).width).toBeLessThan(260);
    await assign.fill('Layout');
    await expect(panel.locator('.docs-share-suggestions .docs-share-suggestion')).toBeVisible();
    await assign.press('ArrowDown');
    await expect(panel.locator('.docs-share-suggestions .docs-share-suggestion')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel.locator('.task-assignee-selected')).toContainText('Layout reviewer');
    await expect(assign).toBeHidden();
    await page.screenshot({ path: `tmp/docs/handoffs/task-card-assigned-${width}.png`, fullPage: true });
    await panel.getByRole('button', { name: 'Clear task assignee' }).click();
    await expect(assign).toBeVisible();
    await expect(panel.locator('.task-assignee-selected')).toHaveCount(0);
    const badge = panel.getByRole('button', { name: 'Change task status: In Progress' });
    await badge.focus();
    await badge.press('ArrowDown');
    await expect(panel.getByRole('button', { name: 'Backlog', exact: true })).toBeFocused();
    await page.screenshot({ path: `tmp/docs/handoffs/task-card-status-${width}.png`, fullPage: true });
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('button', { name: 'Ready', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: 'Change task status: Ready' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('group', { name: 'Task states' })).toBeHidden();
    await expect(panel.locator('.task-record-heading select')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^Do it / })).toHaveCount(0);
    await expect(panel.locator('.task-quick-date-link').filter({ hasText: /^(Blocked|Done|Archive)$/ })).toHaveCount(0);
    await page.evaluate(() => { window.Alpine.store('chat').taskDraftRemoteChanged = true; });
    await expect(header.getByText('Remote update available', { exact: true })).toBeHidden();
    await header.getByRole('button', { name: 'More actions' }).click();
    await expect(header.getByText('Remote update available', { exact: true })).toBeVisible();
    await page.screenshot({ path: `tmp/docs/handoffs/task-card-overflow-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(header.getByRole('button', { name: 'More actions' })).toBeFocused();
    await expect(header.locator('.doc-actions-popover')).toBeHidden();
    await expect(header.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
    const actions = await header.locator('.task-detail-actions').evaluate(node => [...node.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(button => button.textContent.trim()));
    expect(actions.at(-1)).toBe('Back');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `tmp/docs/handoffs/task-card-unassigned-${width}.png`, fullPage: true });
    await header.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(title).toHaveValue('A readable task record');
    await expect(panel.getByRole('button', { name: 'Change task status: In Progress' })).toBeVisible();
    expect(await page.evaluate(() => window.Alpine.store('chat').taskDraftRemoteChanged)).toBe(false);
  });
}
