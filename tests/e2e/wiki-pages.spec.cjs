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
    s.persistSelectedDocDraft = async () => { s.__preserved = s.docRichEditorAdapter?.getContentModel()?.content; return { document_id: s.selectedDocId }; };
    s.restoreSelectedDocDraft = async () => null;
    s.__events = [];
    s.createDocument = async (title, options) => {
      s.__events.push(['create', s.selectedDocId, options.channelId]);
      const doc = { ...s.documents[0], record_id: 'wiki-created', title, content: options.initialContent };
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
  // Finish the unauthenticated shell route before the seeded notebook starts.
  // Otherwise an opening during routeSyncPaused never enters browser history.
  await page.waitForFunction(() => !window.Alpine.store('chat').routeSyncPaused);
  await page.evaluate(() => window.Alpine.store('chat').syncRoute());
  await expect(page).toHaveURL(/docid=wiki-home/);
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
  // A native drag must not navigate, even when it returns to its starting point.
  const box = await editor.locator('[data-wiki-id="wiki-target"]').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y + 5, { steps: 6 });
  await page.mouse.move(box.x + 5, box.y + 5, { steps: 6 }); await page.mouse.up();
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('wiki-home');
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.documents = s.documents.map((doc) => doc.record_id === 'wiki-target' ? { ...doc, record_state: 'deleted' } : doc); s.docRichEditorAdapter.refreshWikiLinks(); });
  await expect(editor.locator('.fd-wiki-unavailable')).toBeVisible();
  await editor.locator('.fd-wiki-unavailable').click();
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
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocument.content)).toBe('');
  await page.keyboard.type('Immediate target typing');
  await expect(editor).toHaveText('Immediate target typing');
  expect(await page.evaluate(() => window.Alpine.store('chat').error)).toBeNull();
  expect(await page.evaluate(() => window.Alpine.store('chat').__events)).toEqual([['create', 'wiki-home', 'wiki-channel'], ['save', 'wiki-home']]);
  await page.goBack();
  await expect(page.locator('.doc-title-display')).toHaveText('Home page');
  await expect(page.locator('[data-wiki-id="wiki-created"]')).toBeVisible();
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.docEditDraftDirty = true; window.Alpine.raw(s.docRichEditorAdapter.editor).commands.insertContent('Unsaved draft '); });
  await page.locator('[data-wiki-id="wiki-target"]').click();
  await expect(page.locator('.doc-title-display')).toHaveText('Plant list');
  expect(await page.evaluate(() => window.Alpine.store('chat').__preserved)).toContain('Unsaved draft');
  await page.goBack(); await expect(page.locator('.doc-title-display')).toHaveText('Home page');

});

test('title-only paste resolves unique channel page; unresolved click offers creation', async ({ page }) => {
  await seed(page, '[[Plant list]] [[Missing page]] [[Private page]]');
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.docRichEditorAdapter.refreshWikiLinks(); });
  await expect(page.locator('[data-wiki-id="wiki-target"]')).toBeVisible();
  await expect(page.locator('.fd-wiki-unresolved')).toHaveCount(2);
  await page.locator('.fd-wiki-unresolved').filter({ hasText: 'Missing page' }).click();
  await expect(page.locator('.doc-title-display')).toHaveText('Missing page');
});

test('ordinary click creates from the rich reader through edit access and keeps the origin link', async ({ page }) => {
  await seed(page, '[[Reader page]]');
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.docEditAccessState = 'ready'; s.docRichEditorAdapter.setEditable(false); });
  await page.locator('.fd-wiki-unresolved').click();
  await expect(page.locator('.doc-title-display')).toHaveText('Reader page');
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Reader creation typing');
  await expect(editor).toHaveText('Reader creation typing');
  await page.goBack();
  await expect(page.locator('[data-wiki-id="wiki-created"]')).toBeVisible();
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

test('wiki integrity text preserves real browser paragraph separators across title changes', async ({ page }) => {
  await seed(page, 'Plant list appears in ordinary prose.\n\n[Saved label](wiki:wiki-target)\n\nThird paragraph\n\nLast paragraph');
  const result = await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    const editor = document.querySelector('.doc-rich-editor .ProseMirror');
    const before = editor.innerText;
    const labelOffset = before.lastIndexOf('Plant list');
    const expected = before.slice(0, labelOffset) + 'Saved label' + before.slice(labelOffset + 'Plant list'.length);
    const normalized = s.getVisibleDocRichEditorText();
    s.documents = s.documents.map((doc) => doc.record_id === 'wiki-target' ? { ...doc, title: 'A much longer renamed page' } : doc);
    s.docRichEditorAdapter.refreshWikiLinks();
    return { before, expected, normalized, renamed: s.getVisibleDocRichEditorText() };
  });
  expect(result.before).toContain('\n\n');
  expect(result.normalized).toBe(result.expected);
  expect(result.renamed).toBe(result.expected);
  expect(result.normalized).toContain('Plant list appears in ordinary prose.');
});

// Native touch events, rather than a narrow viewport alone.
test.describe('touch wiki navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('tap a newly typed closed link, type immediately, Back, then tap an existing link', async ({ page }) => {
    await seed(page, '[Plant list](wiki:wiki-target)');
    const editor = page.locator('.doc-rich-editor .ProseMirror');
    await editor.tap(); await page.keyboard.press('End'); await page.keyboard.type(' [[Mobile page]]');
    await editor.locator('.fd-wiki-unresolved').tap();
    await expect(page.locator('.doc-title-display')).toHaveText('Mobile page');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocument.content)).toBe('');
    await page.keyboard.type('Mobile immediate typing');
    await expect(editor).toHaveText('Mobile immediate typing');
    expect(await page.evaluate(() => window.Alpine.store('chat').error)).toBeNull();
    await page.goBack();
    await expect(page.locator('.doc-title-display')).toHaveText('Home page');
    await expect(editor.locator('[data-wiki-id="wiki-created"]')).toBeVisible();
    await editor.locator('[data-wiki-id="wiki-target"]').tap();
    await expect(page.locator('.doc-title-display')).toHaveText('Plant list');
  });
});

for (const mobile of [false, true]) {
  test(`native Docs entry returns to shared home after All docs and another page (mobile: ${mobile})`, async ({ page }) => {
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
    await seed(page);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.startWorkspaceLiveQueries = () => {};
      s.ensureBackgroundSync = () => {};
      s.refreshStatusRecentChanges = () => {};
      const pages = [...s.documents];
      s.refreshDocuments = async () => { s.documents = pages; };
    });
    const nav = page.getByRole('navigation', { name: 'Channel notebook' });
    const docs = mobile ? page.locator('.mobile-section-switcher-btn[aria-label="Docs"]')
      : page.locator('li').filter({ has: page.locator('.sidebar-label', { hasText: /^Docs$/ }) });
    await nav.getByRole('button', { name: 'All docs', exact: true }).click();
    await expect(page.locator('.docs-editor-v3')).toHaveCount(0);
    await docs.click();
    await expect(page.locator('.doc-title-display')).toHaveText('Home page');
    await page.evaluate(() => window.Alpine.store('chat').openDoc('wiki-target'));
    await expect(page.locator('.doc-title-display')).toHaveText('Plant list');
    await docs.click();
    await expect(page.locator('.doc-title-display')).toHaveText('Home page');
    // Another section closes the document; native Docs returns to Home again.
    await page.evaluate(() => window.Alpine.store('chat').navigateTo('status'));
    await docs.click();
    await expect(page.locator('.doc-title-display')).toHaveText('Home page');
    // An already open dirty home must retain its mounted editor and typing.
    await page.evaluate(async () => window.Alpine.store('chat').enterSelectedDocEditMode());
    const editor = page.locator('.doc-rich-editor .ProseMirror');
    await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' Unsaved home typing');
    await docs.click();
    await expect(editor).toContainText('Unsaved home typing');
    expect(await page.evaluate(() => window.Alpine.store('chat').__preserved)).toContain('Unsaved home typing');
    // No-home channel clears the previous document to its explicit list fallback.
    await page.evaluate(() => { const s = window.Alpine.store('chat'); s.channels[0].metadata.docs_home_document_id = null; });
    await docs.click();
    await expect(page.locator('.docs-editor-v3')).toHaveCount(0);
    expect(await page.evaluate(() => window.Alpine.store('chat').docsShowAll)).toBe(true);
  });
}

test('Docs Home cannot override an explicit page opened during its delayed refresh', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.startWorkspaceLiveQueries = () => {}; s.ensureBackgroundSync = () => {};
    s.refreshDocuments = () => new Promise(resolve => { window.finishHomeRefresh = resolve; });
    s.navigateTo('docs'); s.openDoc('wiki-target'); window.finishHomeRefresh();
  });
  await expect(page.locator('.doc-title-display')).toHaveText('Plant list');
});


test('locked Docs channel changes open the destination home and no-home list', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const s = Alpine.store('chat');
    s.pgBackendMode = true;
    s.channels = [...s.channels,
      { record_id: 'destination', title: 'Destination', scope_id: 'wiki-scope', metadata: { docs_home_document_id: 'destination-home' } },
      { record_id: 'no-home', title: 'No home', scope_id: 'wiki-scope', metadata: {} }];
    s.documents = [...s.documents, { ...s.documents[0], record_id: 'destination-home', title: 'Destination home', pg_channel_id: 'destination' }];
    const pages = [...s.documents]; s.refreshDocuments = async () => { s.documents = pages; };
    s.startWorkspaceLiveQueries = () => {}; s.ensureBackgroundSync = () => {};
    s.resetOpenDocumentForContextChange = async () => { s.closeDocEditor({ syncRoute: false }); };
    s.lockedView = 'docs'; s.navCollapsed = false; s.desktopSidebarMode = 'expanded';
  });
  expect(await page.evaluate(() => Alpine.store('chat').isCurrentViewLocked)).toBe(true);
  await page.evaluate(() => Alpine.store('chat').selectWorkContextChannel('destination'));
  await expect(page.locator('.doc-title-display')).toHaveText('Destination home');
  await page.evaluate(() => Alpine.store('chat').selectWorkContextChannel('no-home'));
  await expect(page.locator('.docs-editor-v3')).toHaveCount(0);
  expect(await page.evaluate(() => Alpine.store('chat').selectedChannelId)).toBe('no-home');
});


test('Docs route restores the requested channel Home and explicit All docs after shell context reset', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const s = Alpine.store('chat'); s.pgBackendMode = true;
    s.startWorkspaceLiveQueries = () => {}; s.ensureBackgroundSync = () => {};
    s.channels = [...s.channels, { record_id: 'wrong-channel', title: 'Other', scope_id: 'wiki-scope', metadata: {} }];
    s.selectedChannelId = 'wrong-channel'; s.selectedBoardId = '__pg_channel__:wrong-channel';
    history.replaceState({}, '', '/docs?channelid=wiki-channel');
    return s.applyRouteFromLocation();
  });
  await expect(page.locator('.doc-title-display')).toHaveText('Home page');
  expect(await page.evaluate(() => Alpine.store('chat').selectedChannelId)).toBe('wiki-channel');
  await page.getByRole('navigation', { name: 'Channel notebook' }).getByRole('button', { name: 'All docs', exact: true }).click();
  await expect(page).toHaveURL(/docsview=all/);
  await expect(page).toHaveURL(/channelid=wiki-channel/);
  await page.evaluate(() => { const s = Alpine.store('chat'); s.selectedChannelId = 'wrong-channel'; return s.applyRouteFromLocation(); });
  await expect(page.locator('.docs-editor-v3')).toHaveCount(0);
  expect(await page.evaluate(() => ({ channel: Alpine.store('chat').selectedChannelId, all: Alpine.store('chat').docsShowAll }))).toEqual({ channel: 'wiki-channel', all: true });
});
