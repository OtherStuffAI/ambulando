const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');

// These are isolated synthetic records in a fresh Playwright browser context.
// All remote requests are blocked; this is frontend coverage, not authenticated
// Tower, checkout, permission, delivery or synchronization acceptance.
const evidence = 'tmp/docs/handoffs/sol-v5';
async function capture(page, name) {
  execFileSync('git', ['check-ignore', `${evidence}/${name}.png`]);
  if (execFileSync('git', ['ls-files', evidence], { encoding: 'utf8' }).trim()) throw new Error('Evidence destination must be untracked');
  await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true, animations: 'disabled' });
}
async function openFixture(page) {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'stopTaskCommentsLiveQuery', 'startTaskCommentsLiveQuery', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead', 'scheduleDocAutosave', 'clearInactiveSectionData']) s[key] = () => {};
    s.openConnectModal = () => {};
    s.showConnectModal = false;
    s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'npub1solfixture' };
    s.backendUrl = 'http://127.0.0.1:3100';
    s.pgBackendMode = false;
    s.isTowerPgMode = false;
    s.error = null;
    s.getSenderName = npub => npub === 'npub1solfixture' ? 'Design reviewer' : 'Implementation agent';
    const now = '2026-10-09T01:00:00.000Z';
    const row = { record_state: 'active', sync_status: 'synced', created_at: now, updated_at: now, version: 1 };
    s.channels = [{ ...row, record_id: 'sol-channel', title: 'Design implementation', name: 'Design implementation', metadata: {} }];
    s.selectedChannelId = 'sol-channel';
    s.pgContextSelectedChannelId = 'sol-channel';
    s.messages = [
      { ...row, record_id: 'sol-thread', thread_id: 'sol-thread', pg_thread_id: 'sol-thread', parent_message_id: null, channel_id: 'sol-channel', sender_npub: 'npub1solfixture', metadata: {}, body: 'Review the connected Ambulando interface. Keep existing conversations, tasks and documents working.' },
      { ...row, record_id: 'sol-reply', thread_id: 'sol-thread', pg_thread_id: 'sol-thread', parent_message_id: 'sol-thread', channel_id: 'sol-channel', sender_npub: 'npub1solagent', metadata: {}, body: 'The proposed design preserves local drafts. This fixture does not claim live delivery or backend authorization.' },
    ];
    s.tasks = [{ ...row, record_id: 'sol-task', title: 'Review connected frontend', description: '## Expected outcome\n\nPreserve existing behavior while applying semantic light and dark surfaces.\n\n- Review keyboard focus\n- Verify narrow reflow\n\n' + 'Long content remains readable. '.repeat(35), state: 'in_progress', assigned_to_npubs: [], predecessor_task_ids: [], tags: '', pg_channel_id: 'sol-channel' }];
    s.documents = [{ ...row, record_id: 'sol-doc', owner_npub: 'npub1solfixture', title: 'Connected design review', content: '# Connected design review\n\nThe browser remains the working application.\n\n' + 'A long paragraph exercises readable document width and scrolling. '.repeat(25), shares: [], group_ids: [] }];
    s.directories = [];
    s.loadTaskComments = async () => s.applyTaskComments([{ ...row, record_id: 'sol-comment', sender_npub: 'npub1solfixture', body: 'Review the fixture before approving the redesign.' }]);
    s.navSection = 'chat';
    s.openThread('sol-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
  });
  await expect(page.locator('div.chat-thread-panel')).toBeVisible();
}


async function assertTouchTargets(locator, label) {
  const sizes = await locator.evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label') || node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  expect(sizes.length, label).toBeGreaterThan(0);
  for (const size of sizes) { expect(size.width, `${label}: ${size.label}`).toBeGreaterThanOrEqual(44); expect(size.height, `${label}: ${size.label}`).toBeGreaterThanOrEqual(44); }
  console.log('SOL_V5_TOUCH_TARGETS', JSON.stringify({ label, sizes }));
}


async function assertPhoneConversation(page, label) {
  await assertTouchTargets(page.locator('.mobile-scope-workspace-avatar-btn:visible'), `${label} scope avatar`);
  await assertTouchTargets(page.locator('.chat-thread-panel .chat-msg-actions-toggle:visible'), `${label} message actions`);
  await assertTouchTargets(page.locator('.chat-thread-panel .identity-avatar-button:visible'), `${label} identity avatars`);
  const geometry = await page.locator('.chat-thread-panel .thread-header').evaluate(node => {
    const header = node.getBoundingClientRect(), copy = node.querySelector('.thread-header-copy').getBoundingClientRect(), actions = node.querySelector('.thread-header-actions').getBoundingClientRect(), style = getComputedStyle(node);
    return { innerWidth: header.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth), copyWidth: copy.width, copyBottom: copy.bottom, actionsTop: actions.top };
  });
  expect(geometry.copyWidth).toBeGreaterThanOrEqual(geometry.innerWidth - 1);
  expect(geometry.actionsTop).toBeGreaterThanOrEqual(geometry.copyBottom - 1);
  console.log('SOL_V5_THREAD_HEADER', JSON.stringify({ label, geometry }));
}

for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`isolated connected surfaces and readable errors: ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFixture(page);
      await page.evaluate(theme => window.Alpine.store('appearance').setTheme(theme), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.thread-message').first()).toContainText('Review the connected Ambulando interface');
      const composer = page.locator('.thread-input-bar [data-chat-composer="thread"]');
      await composer.fill('A preserved local draft');
      await expect(composer).toHaveText('A preserved local draft');
      if (width < 769) await assertPhoneConversation(page, `${theme} ${width}`);
      if (width < 769) await assertTouchTargets(page.locator('.thread-message .reaction-bar button:visible'), `conversation ${theme} ${width}`);
      await capture(page, `fixture-${theme}-${width}-conversation`);
      await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navigateTo('tasks', { syncRoute: false }); s.openTaskDetail('sol-task'); s.taskDetailMode = 'view'; });
      await expect(page.locator('.task-detail-panel')).toBeVisible();
      await expect(page.locator('.task-desc-preview')).toContainText('Expected outcome');
      if (width < 769) await assertTouchTargets(page.locator('.task-detail-meta-pill.task-status-badge:visible'), `task status ${theme} ${width}`);
      if (width < 769) await assertTouchTargets(page.locator('.task-detail-mobile-switcher .mobile-detail-switcher-btn:visible'), `task detail ${theme} ${width}`);
      await capture(page, `fixture-${theme}-${width}-task`);
      await page.evaluate(() => { const s = window.Alpine.store('chat'); s.showTaskDetail = false; s.navigateTo('docs', { syncRoute: false }); s.selectedDocId = 'sol-doc'; s.selectedDocType = 'document'; s.loadDocEditorFromSelection(); });
      await expect(page.locator('.doc-title-display')).toHaveText('Connected design review');
      await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('The browser remains the working application');
      if (width < 769) {
        await assertTouchTargets(page.locator('.doc-mobile-switcher .mobile-detail-switcher-btn:visible'), `document sections ${theme} ${width}`);
        await page.evaluate(() => { window.Alpine.store('chat').docCommentsVisible = false; });
        await assertTouchTargets(page.locator('.doc-comment-drawer-rail:visible'), `document comments rail ${theme} ${width}`);
      }
      await capture(page, `fixture-${theme}-${width}-document`);
      await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navigateTo('settings', { syncRoute: false }); s.settingsTab = 'connection'; });
      await expect(page.locator('.settings-tabs')).toBeVisible();
      await capture(page, `fixture-${theme}-${width}-settings`);
      await page.evaluate(() => { window.Alpine.store('chat').error = 'Fixture: Tower unavailable. Your local draft is preserved; retry when connected.'; });
      await expect(page.getByRole('alert')).toContainText('Tower unavailable');
      await capture(page, `fixture-${theme}-${width}-error`);
      await page.getByRole('button', { name: 'Dismiss error' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      if (width < 769) {
        await page.evaluate(() => { window.Alpine.store('chat').chatImagePreviewModal = { open: true, filename: 'Fixture.pdf', objectId: 'fixture', backendUrl: 'http://127.0.0.1:3100', loading: false, downloading: false, src: '', error: 'Fixture: Could not load file. Retry when connected.' }; });
        await expect(page.getByRole('dialog', { name: 'Fixture.pdf', exact: true })).toBeVisible();
        await assertTouchTargets(page.locator('.chat-image-preview-close:visible'), `file preview close ${theme} ${width}`);
        await capture(page, `fixture-${theme}-${width}-file-preview-error`);
        await page.getByRole('button', { name: 'Close image preview', exact: true }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.reload();
      await page.waitForFunction(() => window.Alpine?.store?.('chat'));
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });
  }
}

test('command palette contains keyboard focus and restores its trigger', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => { window.Alpine.store('chat').closeThread({ syncRoute: false }); });
  await expect(page.locator('.chat-thread-modal-backdrop')).toBeHidden();
  const trigger = page.locator('.brand-lockup-button');
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-command-palette-input]')).toBeFocused();
  await capture(page, 'fixture-command-dialog');
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('phone drawer uses keyboard-operable connected navigation with touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  await page.evaluate(() => { window.Alpine.store('chat').closeThread({ syncRoute: false }); });
  await expect(page.locator('.chat-thread-modal-backdrop')).toBeHidden();
  const toggle = page.getByRole('button', { name: 'Toggle navigation', exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  const taskLink = page.locator('.sidebar .expanded-sidebar-section-switcher-btn').filter({ hasText: /Tasks/ });
  await expect(taskLink).toBeVisible();
  expect(await taskLink.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect.poll(() => page.locator('.sidebar').evaluate(node => node.contains(document.activeElement))).toBe(true);
  await capture(page, 'fixture-phone-navigation');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').mobileNavOpen)).toBe(false);
  await expect(toggle).toBeFocused();
  await expect(page.locator('.sidebar')).toHaveJSProperty('inert', true);
  await toggle.press('Enter');
  await expect(taskLink).toBeVisible();
  await taskLink.focus();
  await taskLink.press('Enter');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').navSection)).toBe('tasks');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').mobileNavOpen)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
  test(`additional working surface evidence ${theme} ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(theme => { window.Alpine.store('appearance').setTheme(theme); window.Alpine.store('chat').closeThread({ syncRoute: false }); }, theme);
    await page.evaluate(() => window.Alpine.store('chat').navigateTo('status', { syncRoute: false }));
    if (width > 768) {
      if (await page.evaluate(() => window.Alpine.store('chat').navCollapsed)) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
      await expect(page.locator('.sidebar .sol-sidebar-brand')).toContainText('Ambulando');
      await expect(page.locator('.sidebar .expanded-sidebar-section-switcher')).toBeVisible();
      await capture(page, `fixture-${theme}-${width}-navigation`);
    }
    await expect(page.locator('.content-scroll-area')).toBeVisible();
    await capture(page, `fixture-${theme}-${width}-home`);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navigateTo('tasks', { syncRoute: false }); s.taskViewMode = 'list'; });
    await expect(page.locator('.task-list-title')).toContainText('Review connected frontend');
    await capture(page, `fixture-${theme}-${width}-task-list`);
    await page.evaluate(() => { window.Alpine.store('chat').taskViewMode = 'kanban'; });
    await expect(page.locator('.kanban-board')).toBeVisible();
    await expect(page.locator('.kanban-card')).toContainText('Review connected frontend');
    await capture(page, `fixture-${theme}-${width}-task-board`);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navigateTo('files', { syncRoute: false }); s.documents = []; s.files = []; });
    await expect(page.getByText('No files found.', { exact: true })).toBeVisible();
    await capture(page, `fixture-${theme}-${width}-files-empty`);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navigateTo('agents', { syncRoute: false }); s.workspaceAgents = []; });
    await expect(page.getByText('No agents are connected to this workspace yet.', { exact: true })).toBeVisible();
    await capture(page, `fixture-${theme}-${width}-agents-empty`);
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.workspaceAgents = [{ id: 'sol-agent', agent_id: 'sol-agent', agent_npub: 'npub1solagent', display_name: 'Implementation agent', is_visible: true, metadata: { description: 'Fixture agent; live runtime unavailable.', can_instruct: false } }]; s.loadSelectedAgentSpaceView = async () => { s.agentSpaceLoading = false; s.agentSpaceError = 'Fixture: Autopilot unavailable. Retry when connected.'; }; s.openAgentSpace('sol-agent'); });
    await expect(page.locator('.agent-space-detail h1')).toHaveText('Implementation agent');
    await expect(page.locator('.agent-space .agent-space-error')).toContainText('Autopilot unavailable');
    await capture(page, `fixture-${theme}-${width}-agent-error`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('signed-out onboarding has honest authentication choices', async ({ page }) => {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat'));
  await expect(page.locator('.brand-lockup-button')).toContainText('Ambulando');
  await expect(page.getByRole('button', { name: 'Sign Up', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Browser Extension', exact: true })).toBeEnabled();
  await expect(page.getByText('Waiting for NIP-07 extension injection.', { exact: false })).toBeVisible();
  await capture(page, 'fixture-signed-out-auth');
  const advanced = page.locator('summary').filter({ hasText: 'Advanced options' });
  await advanced.focus();
  await advanced.press('Enter');
  await expect(page.getByLabel('Nostr secret key')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Connect Bunker', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.Alpine.store('appearance').setTheme('dark'));
  await capture(page, 'fixture-signed-out-advanced-dark-phone');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.Alpine.store('chat').session)).toBeFalsy();
});

test('visible theme control changes and persists the user preference', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => { window.Alpine.store('chat').closeThread({ syncRoute: false }); window.Alpine.store('appearance').setTheme('light'); });
  const themeButton = page.getByRole('button', { name: 'Change color theme', exact: true });
  await themeButton.focus();
  await themeButton.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('ambulando:theme'))).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('profile actions support menu keyboard navigation and restore the avatar trigger', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => { window.Alpine.store('chat').closeThread({ syncRoute: false }); });
  await expect(page.locator('.chat-thread-modal-backdrop')).toBeHidden();
  const avatar = page.locator('.avatar-chip');
  await avatar.focus();
  await avatar.press('Enter');
  const menu = page.getByRole('region', { name: 'Profile and workspace actions', exact: true });
  await expect(menu).toBeVisible();
  await expect(avatar).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => menu.evaluate(node => node.contains(document.activeElement))).toBe(true);
  const focusedControlIndex = () => menu.evaluate(node => {
    const items = [...node.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])')].filter(item => item.isConnected && item.getClientRects().length > 0);
    return { index: items.indexOf(document.activeElement), last: items.length - 1 };
  });
  await page.keyboard.press('End');
  await expect.poll(async () => { const state = await focusedControlIndex(); return state.index === state.last && state.last > 0; }).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await focusedControlIndex()).index).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await focusedControlIndex()).index).toBe(1);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await focusedControlIndex()).index).toBe(0);
  await capture(page, 'fixture-profile-actions-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(avatar).toHaveAttribute('aria-expanded', 'false');
  await expect(avatar).toBeFocused();
});

async function contrastRatio(locator) {
  return locator.evaluate(element => {
    const parse = value => (value.match(/[\d.]+/g) || []).map(Number);
    const composite = (foreground, background) => {
      const alpha = foreground.length > 3 ? foreground[3] : 1;
      return foreground.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha));
    };
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors) background = composite(parse(getComputedStyle(node).backgroundColor), background);
    const foreground = composite(parse(getComputedStyle(element).color), background);
    const luminance = color => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const light = luminance(foreground), dark = luminance(background);
    return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  });
}

for (const width of [1440, 390, 320]) {
  for (const theme of ['light', 'dark']) {
    test(`selected Context and populated Agent Space retain contrast and geometry ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFixture(page);
      if (width < 769) await assertPhoneConversation(page, `${theme} ${width}`);
      await page.evaluate(theme => { const s = window.Alpine.store('chat'); window.Alpine.store('appearance').setTheme(theme); s.closeThread({ syncRoute: false }); s.navigateTo('context', { syncRoute: false }); }, theme);
      await expect(page.locator('.chat-thread-modal-backdrop')).toBeHidden();
      await page.evaluate(() => {
        const view = window.Alpine.$data(document.querySelector('.context-tree-view'));
        view.status = 'complete'; view.hasContext = true; view.capabilities = { edit: true, manage: true };
        view.components = [{ id: 'sol-root', parent_id: null, title: 'Parent component', sort_order: 0 }, { id: 'sol-child', parent_id: 'sol-root', title: 'Child component', sort_order: 1 }];
        view.relayout(); view.selectedId = 'sol-root';
      });
      const selected = page.locator('.context-tree-node-selected');
      const label = selected.locator('.context-tree-label');
      await expect(label).toHaveText('Parent component');
      const selectedTextContrast = await contrastRatio(label);
      expect(selectedTextContrast).toBeGreaterThanOrEqual(4.5);
      const disclosure = selected.locator('.context-tree-node-toggle');
      await disclosure.hover();
      const hoverDisclosureContrast = await contrastRatio(disclosure);
      const hoverTextContrast = await contrastRatio(label);
      expect(hoverDisclosureContrast).toBeGreaterThanOrEqual(3);
      expect(hoverTextContrast).toBeGreaterThanOrEqual(4.5);
      if (width < 769) {
        const size = await disclosure.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
        expect(size.width).toBeGreaterThanOrEqual(44); expect(size.height).toBeGreaterThanOrEqual(44);
      }
      await capture(page, `fixture-${theme}-${width}-context-selected-hover`);
      await page.evaluate(() => window.Alpine.$data(document.querySelector('.context-tree-view')).startCreate());
      const dialog = page.getByRole('dialog', { name: 'New component', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox', { name: 'Component name', exact: true }).fill('Unsubmitted fixture component');
      const save = dialog.getByRole('button', { name: 'Save component', exact: true });
      await expect(save).toBeEnabled();
      const saveContrast = await contrastRatio(save);
      expect(saveContrast).toBeGreaterThanOrEqual(4.5);
      if (width < 769) {
        const sizes = await dialog.locator('button:visible').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        for (const size of sizes) { expect(size.width).toBeGreaterThanOrEqual(44); expect(size.height).toBeGreaterThanOrEqual(44); }
      }
      await capture(page, `fixture-${theme}-${width}-context-create`);
      // Native form is exercised without submitting any authorized mutation.
      await dialog.getByRole('button', { name: 'Cancel edit', exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.evaluate(() => {
        const s = window.Alpine.store('chat'); s.navigateTo('agents', { syncRoute: false });
        s.loadSelectedAgentSpaceView = async () => {};
        s.workspaceAgents = [{ id: 'sol-populated-agent', agent_id: 'fixture-agent', agent_npub: 'npub1solagent', display_name: 'Implementation agent', metadata: { description: 'Fixture installation with existing pipelines', can_instruct: false } }];
        s.openAgentSpace('sol-populated-agent'); s.agentSpaceLoading = false; s.agentSpaceError = ''; s.agentSpaceView = 'pipelines';
        s.agentSpaceData = { definitions: [{ id: 'fixture-pipeline', name: 'Long pipeline title '.repeat(12), description: 'https://example.invalid/' + 'long-path'.repeat(60), assigned: true, default: false, overrides: [] }], missing: [] };
      });
      const agent = page.locator('.agent-space-card.active');
      await expect(agent).toContainText('Implementation agent');
      const agentSelectedContrast = await contrastRatio(agent.locator('strong'));
      expect(agentSelectedContrast).toBeGreaterThanOrEqual(4.5);
      const pipeline = page.locator('.agent-space-row');
      await expect(pipeline).toContainText('Long pipeline title');
      const geometry = await page.locator('.agent-space').evaluate(node => [...node.querySelectorAll('.agent-space-list,.agent-space-detail,.agent-space-row,.agent-space-row strong,.agent-space-row p,.agent-space-tabs')].map(item => ({ className: item.className, width: item.clientWidth, scrollWidth: item.scrollWidth, right: item.getBoundingClientRect().right })));
      for (const item of geometry) {
        expect(item.scrollWidth, item.className).toBeLessThanOrEqual(item.width + 1);
        expect(item.right, item.className).toBeLessThanOrEqual(width + 1);
      }
      if (width < 769) {
        const sizes = await page.locator('.agent-space button:visible').evaluateAll(nodes => nodes.map(node => ({ label: node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        for (const size of sizes) { expect(size.width, size.label).toBeGreaterThanOrEqual(44); expect(size.height, size.label).toBeGreaterThanOrEqual(44); }
      }
      await capture(page, `fixture-${theme}-${width}-agent-selected`);
      await pipeline.scrollIntoViewIfNeeded();
      await capture(page, `fixture-${theme}-${width}-agent-populated`);
      console.log('SOL_V5_RENDERED_REGRESSION', JSON.stringify({ width, theme, selectedTextContrast, hoverDisclosureContrast, hoverTextContrast, saveContrast, agentSelectedContrast, geometry }));
    });
  }
}

for (const width of [1440, 1280, 390]) for (const theme of ['light', 'dark']) {
  test(`A4 paper geometry, editing and comments: ${theme} ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(({ theme, width }) => {
      const s = window.Alpine.store('chat');
      s.closeThread({ syncRoute: false });
      window.Alpine.store('appearance').setTheme(theme);
      s.documents[0].content = '# Writing on paper\n\nThe browser remains the working application.\n\n' + Array.from({ length: 35 }, (_, i) => `## Section ${i + 1}\n\nA long document grows continuously while comments keep their own scroll pane. This is a synthetic review document.\n\n`).join('');
      s.navigateTo('docs', { syncRoute: false });
      s.selectedDocId = 'sol-doc'; s.selectedDocType = 'document'; s.loadDocEditorFromSelection();
      s.docComments = [{ record_id: 'a4-comment', target_record_id: 'sol-doc', parent_comment_id: null, comment_status: 'open', body: 'Review the writing margins and keep the page white in both themes.', sender_npub: s.session.npub, record_state: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
      s.docCommentsVisible = width > 768;
      s.docMobilePane = 'document';
    }, { theme, width });
    const editor = page.locator('.doc-rich-editor .ProseMirror');
    await expect(editor).toContainText('Section 35');
    const geometry = await page.locator('.doc-rich-editor').evaluate(paper => {
      const style = getComputedStyle(paper), pane = paper.parentElement, ink = getComputedStyle(paper.querySelector('.ProseMirror'));
      return { width: paper.getBoundingClientRect().width, height: paper.getBoundingClientRect().height, minHeight: parseFloat(style.minHeight), padding: parseFloat(style.paddingLeft), background: style.backgroundColor, ink: ink.color, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, paneScrollHeight: pane.scrollHeight, paneHeight: pane.clientHeight, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry.background).toBe('rgb(255, 255, 255)');
    expect(geometry.ink).toBe('rgb(32, 39, 51)');
    expect(geometry.minHeight).toBeGreaterThan(1122);
    expect(geometry.height).toBeGreaterThan(geometry.minHeight);
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    if (width > 768) {
      expect(geometry.width).toBeCloseTo(210 * 96 / 25.4, 0);
      expect(geometry.padding).toBeCloseTo(20 * 96 / 25.4, 0);
      expect(geometry.paneScrollHeight).toBeGreaterThan(geometry.paneHeight);
      await expect(page.locator('.doc-comment-thread-panel')).toContainText('Review the writing margins');
      await page.locator('.doc-preview-surface').evaluate(pane => { pane.scrollTop = 600; pane.scrollLeft = pane.scrollWidth; });
      expect(await page.locator('.doc-comment-thread-panel').evaluate(pane => pane.scrollTop)).toBe(0);
      await page.locator('.doc-preview-surface').evaluate(pane => { pane.scrollTop = 0; pane.scrollLeft = 0; });
    } else {
      expect(geometry.width).toBeLessThan(390);
      expect(geometry.paneScrollWidth).toBeLessThanOrEqual(geometry.paneWidth);
    }
    await editor.evaluate(node => node.dataset.a4Probe = 'preserved');
    await editor.click({ position: { x: 20, y: 20 } });
    await page.keyboard.type('Draft probe ');
    await expect(editor).toContainText('Draft probe');
    await capture(page, `a4-${theme}-${width}-document`);
    if (width < 769) {
      await page.getByLabel('Document sections').getByRole('button', { name: 'Comments', exact: true }).click();
      await expect(page.locator('.doc-comment-thread-panel')).toContainText('Review the writing margins');
      const comment = page.locator('.doc-thread-entry-root:visible');
      await page.locator('.doc-thread-list:visible').evaluate(list => list.scrollTop = list.scrollHeight);
      await expect(comment).toContainText('Review the writing margins');
      await capture(page, `a4-${theme}-${width}-comments`);
      await page.getByLabel('Document sections').getByRole('button', { name: 'Docs', exact: true }).click();
    }
    await expect(editor).toHaveAttribute('data-a4-probe', 'preserved');
    console.log('SOL_A4_GEOMETRY', JSON.stringify({ theme, width, geometry }));
  });
}

for (const width of [1440, 1280, 390]) for (const theme of ['light', 'dark']) {
  test(`Ambulando name and responsive view navigation: ${theme} ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page);
    await page.evaluate(theme => { const s = Alpine.store('chat'); s.closeThread({ syncRoute: false }); Alpine.store('appearance').setTheme(theme); }, theme);
    await expect(page.locator('.brand-copy h1')).toHaveText('Ambulando');
    await expect(page).toHaveTitle(/Ambulando$/);
    expect(await page.locator('head title').textContent()).not.toContain('Sol');
    // Static fixture responses are page-routed; inspect the built manifest directly.
    const installed = JSON.parse(await fs.readFile('dist/manifest.json', 'utf8'));
    expect(installed.name).toBe('Ambulando');
    expect(installed.short_name).toBe('Ambulando');
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    const nav = width > 768 ? page.locator('.sol-horizontal-navigation:visible') : page.locator('.sidebar .expanded-sidebar-section-switcher:visible');
    await expect(nav).toBeVisible();
    expect(await page.locator('.expanded-sidebar-section-switcher:visible').count()).toBe(1);
    if (width > 768) {
      await expect(page.locator('.sidebar .expanded-sidebar-section-switcher')).toBeHidden();
      const rect = await nav.boundingBox();
      expect(rect.y).toBeLessThan(150);
      expect(rect.width).toBeGreaterThan(500);
    } else await assertTouchTargets(nav.locator('.expanded-sidebar-section-switcher-btn'), 'phone product navigation');
    await capture(page, `nav-${theme}-${width}-expanded`);
    for (const [label, section] of [['Deck','status'],['Chat','chat'],['Tasks','tasks'],['Docs','docs'],['Files','files'],['Agents','agents'],['Context','context'],['Toolbox','toolbox']]) {
      if (width < 769 && !(await nav.isVisible())) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
      await nav.getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => page.evaluate(() => Alpine.store('chat').navSection)).toBe(section);
      if (width > 768) await expect(nav.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current','page');
      else await expect(nav).toBeHidden();
    }
    if (width > 768) {
      if (width === 1280) {
        await page.setViewportSize({ width: 900, height: 900 });
        expect(await nav.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
        await nav.getByRole('button', { name: 'Toolbox', exact: true }).click();
        await capture(page, `nav-${theme}-900-horizontal-scroll`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width, height: 900 });
      }
      await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
      await expect(page.locator('.sol-horizontal-navigation')).toBeHidden();
      await page.locator('.sidebar-nav:visible').getByRole('button', { name: 'Docs', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Alpine.store('chat').navSection)).toBe('docs');
      await expect(page.locator('.sidebar-nav:visible li').filter({has:page.getByRole('button',{name:'Docs',exact:true})})).toHaveClass(/active/);
    }
    await capture(page, `nav-${theme}-${width}-compact`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
}
