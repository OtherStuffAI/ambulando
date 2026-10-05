const { test, expect } = require('playwright/test');

async function seed(page, content = 'Notebook') {
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat'));
  await page.evaluate(async (content) => {
    const s = window.Alpine.store('chat');
    const owner = 'npub1wikibrowsertest';
    s.session = { ...(s.session || {}), npub: owner };
    s.canManageChannel = () => true;
    s.openConnectModal = () => {};
    s.showConnectModal = false;
    s.channels = [{ record_id: 'wiki-channel', title: 'Notebook', scope_id: 'wiki-scope', metadata: { docs_home_document_id: 'wiki-home' } }];
    s.selectedChannelId = 'wiki-channel';
    s.selectedBoardId = '__pg_channel__:wiki-channel';
    s.documents = [
      { record_id: 'wiki-home', title: 'Home page', content, pg_channel_id: 'wiki-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, sync_status: 'pending', record_state: 'active' },
      { record_id: 'wiki-target', title: 'Plant list', content: 'Plant details', pg_channel_id: 'wiki-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, sync_status: 'pending', record_state: 'active' },
      { record_id: 'wiki-other', title: 'Private page', content: 'Outside channel', pg_channel_id: 'another-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, sync_status: 'pending', record_state: 'active' },
    ];
    s.hydrateSelectedDocWithRetry = async () => null;
    s.inspectSelectedDocEditLease = async () => null;
    s.handleDocRichEditIntent = () => {};
    s.resolvePgWriteContext = () => ({ scopeId: 'wiki-scope', channelId: 'wiki-channel' });
    s.refreshDocuments = async () => s.documents;
    s.loadSelectedDocRecoveries = async () => [];
    s.markDocRead = () => {};
    s.startDocCommentsLiveQuery = () => {};
    s.loadDocComments = async () => [];
    s.scheduleDocAutosave = () => {};
    s.releaseSelectedDocLeaseWhenSafe = async () => true;
    s.releaseLockManagedCheckout = async () => true;
    s.persistSelectedDocDraft = async () => { s.__preserved = s.docRichEditorAdapter?.getContentModel()?.content; };
    s.restoreSelectedDocDraft = async () => null;
    s.__events = [];
    s.createDocument = async (title, options) => {
      s.__events.push(['create', s.selectedDocId, options.channelId]);
      const doc = { ...s.documents[0], record_id: 'wiki-created', title, content: 'New page body' };
      s.documents = [...s.documents, doc];
      return doc;
    };
    s.saveSelectedDocItem = async () => {
      s.__events.push(['save', s.selectedDocId]);
      const model = s.docRichEditorAdapter.getContentModel();
      s.documents = s.documents.map((doc) => doc.record_id === s.selectedDocId ? { ...doc, ...model } : doc);
      s.docEditDraftDirty = false;
      return s.selectedDocument;
    };
    s.navSection = 'docs';
    s.openDoc('wiki-home');
    await s.enterSelectedDocEditMode();
  }, content);
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
}

test('wiki picker keyboard, Escape, mouse, ID roundtrip, rename/delete and selection safety', async ({ page }) => {
  await seed(page);
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' [[');
  const picker = page.getByRole('listbox', { name: 'Link to a channel page' });
  await expect(picker).toBeVisible();
  await expect(picker).not.toContainText('Private page');
  await page.keyboard.press('Escape'); await expect(picker).toBeHidden();
  await page.keyboard.type('Plant'); await expect(picker).toBeVisible();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await expect(editor.locator('[data-wiki-id="wiki-target"]')).toHaveText('Plant list');
  await expect(picker).toBeHidden();
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.documents = s.documents.map((doc) => doc.record_id === 'wiki-target' ? { ...doc, title: 'Renamed plant list' } : doc); s.docRichEditorAdapter.refreshWikiLinks(); });
  await expect(editor.locator('[data-wiki-id="wiki-target"]')).toHaveText('Renamed plant list');
  await editor.locator('[data-wiki-id="wiki-target"]').click();
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('wiki-home');
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.documents = s.documents.map((doc) => doc.record_id === 'wiki-target' ? { ...doc, record_state: 'deleted' } : doc); s.docRichEditorAdapter.refreshWikiLinks(); });
  await expect(editor.locator('.fd-wiki-unavailable')).toBeVisible();
  await editor.locator('.fd-wiki-unavailable').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('wiki-home');
  // Mouse choice and native rich/source roundtrip retain the selected ID.
  await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' [[Home');
  await picker.getByRole('option').filter({ hasText: 'Home page' }).click();
  const result = await page.evaluate(() => { const s = window.Alpine.store('chat'); s.setDocEditorMode('source'); const source = s.docEditorContent; s.docEditorProseMirrorState = null; s.refreshProseMirrorStateFromCompatibility(); s.setDocEditorMode('rich'); return source; });
  expect(result).toContain('(wiki:wiki-target)'); expect(result).toContain('(wiki:wiki-home)');
  await expect(page.locator('.doc-rich-editor [data-wiki-id="wiki-home"]')).toBeVisible();
});

test('create saves origin before navigating, browser Back retains page links and unsaved draft', async ({ page }) => {
  await seed(page, '[Plant list](wiki:wiki-target)');
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' [[New page');
  await page.getByRole('listbox').getByRole('option').filter({ hasText: 'Create' }).click();
  await expect(page.locator('.doc-title-display')).toHaveText('New page');
  expect(await page.evaluate(() => window.Alpine.store('chat').__events)).toEqual([['create', 'wiki-home', 'wiki-channel'], ['save', 'wiki-home']]);
  await page.goBack();
  await expect(page.locator('.doc-title-display')).toHaveText('Home page');
  await expect(page.locator('[data-wiki-id="wiki-created"]')).toBeVisible();
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.docEditDraftDirty = true; window.Alpine.raw(s.docRichEditorAdapter.editor).commands.insertContent('Unsaved draft '); });
  await page.locator('[data-wiki-id="wiki-target"]').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.locator('.doc-title-display')).toHaveText('Plant list');
  expect(await page.evaluate(() => window.Alpine.store('chat').__preserved)).toContain('Unsaved draft');
  await page.goBack(); await expect(page.locator('.doc-title-display')).toHaveText('Home page');

});

test('title-only paste resolves unique channel page; unresolved click offers creation', async ({ page }) => {
  await seed(page, '[[Plant list]] [[Missing page]] [[Private page]]');
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.docRichEditorAdapter.refreshWikiLinks(); });
  await expect(page.locator('[data-wiki-id="wiki-target"]')).toBeVisible();
  await expect(page.locator('.fd-wiki-unresolved')).toHaveCount(2);
  await page.locator('.fd-wiki-unresolved').filter({ hasText: 'Missing page' }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.locator('.doc-title-display')).toHaveText('Missing page');
});

test('mobile Home and All docs controls preserve channel and home fallback', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const nav = page.getByRole('navigation', { name: 'Channel notebook' });
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: 'All docs', exact: true }).click();
  expect(await page.evaluate(() => ({ id: window.Alpine.store('chat').selectedDocId, channel: window.Alpine.store('chat').selectedChannelId }))).toEqual({ id: null, channel: 'wiki-channel' });
  await nav.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.doc-title-display')).toHaveText('Home page');
  const box = await nav.boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.documents = s.documents.filter((doc) => doc.record_id !== 'wiki-home'); });
  await nav.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.docs-editor-v3')).toHaveCount(0);
  await expect(nav).toContainText('Home page unavailable');
});
