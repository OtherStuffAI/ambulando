const { test, expect } = require('playwright/test');
test.use({ serviceWorkers: 'block' });
test.setTimeout(60000);

// Browser-local integration: real settings/Dexie, document orchestration and UI.
// Tower reads and checkout authority are simulated; this is not live ACL evidence.
async function seed(page, user = 'npub1modealice', denied = false) {
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(({ user, denied }) => {
    const s = window.Alpine.store('chat');
    s.session = { npub: user };
    s.openConnectModal = () => {}; s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    s.updateWorkspaceBootstrapPrompt = () => {}; s.loadRemoteWorkspaces = async () => {};
    s.startWorkspaceLiveQueries = () => {}; s.syncRoute = () => {};
    s.ensureBackgroundSync = () => {};
    s.hydrateSelectedDocWithRetry = async () => null;
    s.inspectSelectedDocEditLease = async () => null;
    s.restoreSelectedDocDraft = async () => null;
    s.loadDocComments = async () => [];
    s.scheduleDocAutosave = () => {};
    s.acquireSelectedDocCheckout = async () => !denied;
    s.getSelectedDocCheckoutSession = () => denied ? null : ({ checkout: { state: 'checked_out', holder_npub: user, lease_expires_at: new Date(Date.now() + 60000).toISOString() } });
    if (denied) s.enterSelectedDocEditMode = async () => false;
    s.documents = [{ record_id: 'mode-document', owner_npub: user, title: 'Opening mode example', content: 'Saved document body', version: 1, sync_status: 'pending', record_state: 'active', content_blocks: [], shares: [], group_ids: [] }];
    s.directories = [];
    s.openDoc('mode-document', { syncRoute: false });
  }, { user, denied });
}

async function settings(page) {
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.navSection = 'settings'; s.settingsTab = 'deck'; });
  return page.getByLabel('Default document opening mode', { exact: true });
}
const mode = page => page.evaluate(() => window.Alpine.store('chat').docEditorMode);

test('unset View, explicit Edit survives reload, View persists and another user stays isolated', async ({ page }) => {
  await page.goto('/'); await seed(page);
  await expect.poll(() => mode(page)).toBe('preview');
  await expect(page.locator('.doc-preview-surface')).toBeVisible();
  const choice = await settings(page);
  await expect(choice).toHaveValue('view');
  await choice.selectOption('edit');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').documentOpeningMode)).toBe('edit');
  await page.screenshot({ path: 'tmp/docs/handoffs/document-mode-setting.png' });
  await page.reload(); await seed(page);
  await expect.poll(() => mode(page)).toBe('rich');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
  await page.evaluate(() => window.Alpine.store('chat').setDocReadMode());
  await expect.poll(() => mode(page)).toBe('preview');
  await page.evaluate(() => window.Alpine.store('chat').openDoc('mode-document', { syncRoute: false }));
  await expect.poll(() => mode(page)).toBe('rich');
  await seed(page, 'npub1modebob');
  await expect.poll(() => mode(page)).toBe('preview');
  await seed(page);
  await (await settings(page)).selectOption('view');
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').documentOpeningMode)).toBe('view');
  await page.reload(); await seed(page);
  await expect.poll(() => mode(page)).toBe('preview');
  await page.evaluate(async () => { await window.Alpine.store('chat').enterSelectedDocEditMode(); });
  await expect.poll(() => mode(page)).toBe('rich');
  expect(await page.evaluate(() => window.Alpine.store('chat').documentOpeningMode)).toBe('view');
});

test('denied edit entry stays View with an explicit Edit preference', async ({ page }) => {
  await page.goto('/'); await seed(page, 'npub1modealice', true);
  await page.evaluate(async () => { const s = window.Alpine.store('chat'); await s.setDocumentOpeningMode('edit'); s.openDoc('mode-document', { syncRoute: false }); });
  await expect.poll(() => mode(page)).toBe('preview');
  await expect(page.locator('.doc-preview-surface')).toBeVisible();
  await expect(page.locator('.doc-rich-editor:visible')).toHaveCount(0);
});
