const { test, expect } = require('playwright/test');
const fs = require('node:fs');
async function seed(page, content = 'Notebook', durable = false) {
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat'));
  await page.evaluate(async ({ content, durable }) => {
    const s = window.Alpine.store('chat');
    s.__navigationOriginals = Object.fromEntries(['hydrateSelectedDocWithRetry', 'inspectSelectedDocEditLease', 'persistSelectedDocDraft', 'restoreSelectedDocDraft', 'loadDocComments'].map(name => [name, s[name]]));
    const owner = 'npub1wikibrowsertest';
    s.session = { ...(s.session || {}), npub: owner };
    if (durable) {
      const key = `wiki-navigation-${crypto.randomUUID()}`;
      s.knownWorkspaces = [{ workspaceKey: key, workspaceId: key, workspaceOwnerNpub: owner, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
      for (const name of ['startWorkspaceLiveQueries', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) s[name] = async () => {};
      await s.selectWorkspace(key, { skipPgVerification: true });
      s.__draftDbName = `wingman-fd-ws-${key}`;
    }

    s.canManageChannel = () => true;
    s.openConnectModal = () => {};
    s.showConnectModal = false;
    s.channels = [{ record_id: 'wiki-channel', title: 'Notebook', scope_id: 'wiki-scope', metadata: { docs_home_document_id: 'wiki-home' } }];
    s.selectedChannelId = 'wiki-channel';
    s.selectedBoardId = '__pg_channel__:wiki-channel';
    s.documents = [
      { record_id: 'wiki-home', title: 'Home page', content, pg_channel_id: 'wiki-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, pg_backend: true, sync_status: 'pending', record_state: 'active' },
      { record_id: 'wiki-target', title: 'Plant list', content: 'Plant details', pg_channel_id: 'wiki-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, pg_backend: true, sync_status: 'pending', record_state: 'active' },
      { record_id: 'wiki-other', title: 'Private page', content: 'Outside channel', pg_channel_id: 'another-channel', scope_id: 'wiki-scope', owner_npub: owner, version: 1, pg_backend: true, sync_status: 'pending', record_state: 'active' },
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
    // Open is immediately editable; no manual Edit or target lease wait.
  }, { content, durable });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
  // Finish the unauthenticated shell route before the seeded notebook starts.
  // Otherwise an opening during routeSyncPaused never enters browser history.
  await page.waitForFunction(() => !window.Alpine.store('chat').routeSyncPaused);
  await page.evaluate(() => window.Alpine.store('chat').syncRoute());
  await expect(page).toHaveURL(/docid=wiki-home/);
}

for (const engine of ['chromium', 'webkit']) {
  for (const [width, height] of [[390, 844], [844, 390], [1280, 820]]) {
    test(`${engine} mounted Docs native scroll ${width}x${height}`, async ({ playwright, baseURL }) => {
      const browser = await playwright[engine].launch();
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1000, baseURL });
      const page = await context.newPage();
      await seed(page, Array.from({ length: 90 }, (_, i) => `Paragraph ${i}: ${'Long editable content '.repeat(12)}`).join('\n\n'));
      const scroller = width < 900 ? '.docs-editor-v3' : '.doc-preview-surface';
      const geometry = async () => page.locator(scroller).evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight, top: el.scrollTop, overflow: getComputedStyle(el).overflowY, rect: el.getBoundingClientRect().toJSON() }));
      const before = await geometry();
      expect(before.height).toBeGreaterThan(100);
      expect(before.total).toBeGreaterThan(before.height * 2);
      await page.mouse.move(before.rect.x + before.rect.width / 2, before.rect.y + before.height / 2);
      await page.mouse.wheel(0, 700);
      await expect.poll(async () => (await geometry()).top).toBeGreaterThan(100);
      if (engine === 'chromium' && width < 900) {
        const cdp = await context.newCDPSession(page);
        const y = before.rect.y + before.height - 20;
        const x = before.rect.x + before.rect.width / 2;
        const prior = (await geometry()).top;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 8 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(async () => (await geometry()).top).toBeGreaterThan(prior);
      }

      await page.evaluate(() => {
        const s = window.Alpine.store('chat');
        s.docEditAccessState = 'recovery'; s.docEditAccessMessage = 'Tower preserved this draft as a recovery version. Continue editing, promote it against the current head, or discard it.';
        s.docRecovery = { id: 'synthetic-recovery', resolution_state: 'open', base: { row_version: 1 } };
        s.docEditDraftDirty = true;
        s.__actions = [];
        for (const name of ['promoteSelectedDocRecovery', 'discardSelectedDocRecovery', 'copySelectedDocDraft']) s[name] = () => s.__actions.push(name);
      });
      await page.locator('.doc-recovery-summary').click();
      await expect(page.getByRole('button', { name: 'Promote', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Discard recovery', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
      expect(await page.evaluate(() => window.Alpine.store('chat').__actions)).toEqual(['copySelectedDocDraft']);
      const expanded = await page.locator('.doc-edit-access-banner').boundingBox();
      expect(expanded.height).toBeLessThan(230);
      const expandedBefore = await geometry();
      await page.mouse.move(expandedBefore.rect.x + expandedBefore.rect.width / 2, expandedBefore.rect.bottom - 15);
      await page.mouse.wheel(0, 500);
      await expect.poll(async () => (await geometry()).top).toBeGreaterThan(expandedBefore.top);
      if (process.env.DOCS_SCROLL_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.DOCS_SCROLL_EVIDENCE_DIR}/${engine}-${width}-expanded.png` });
      await page.locator('.doc-recovery-summary').click();
      const collapsed = await page.locator('.doc-edit-access-banner').boundingBox();
      expect(collapsed.height).toBeLessThan(70);
      await page.evaluate(() => { window.Alpine.store('chat').docEditDraftDirty = false; });
      await page.locator('.doc-recovery-summary').click();
      await page.getByRole('button', { name: 'Promote', exact: true }).click();
      await page.getByRole('button', { name: 'Discard recovery', exact: true }).click();
      expect(await page.evaluate(() => window.Alpine.store('chat').__actions)).toEqual(['copySelectedDocDraft', 'promoteSelectedDocRecovery', 'discardSelectedDocRecovery']);
      await page.locator('.doc-recovery-summary').click();
      if (width === 390) {
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 460 });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await expect.poll(async () => (await geometry()).height).toBeLessThan(before.height - 300);
        await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
      }
      if (width < 900) await page.setViewportSize({ width, height: width === 390 ? 460 : 320 });
      const editor = page.locator('.doc-rich-editor .ProseMirror');
      await page.mouse.move(before.rect.x + 30, Math.min((await geometry()).rect.bottom - 30, 300));
      await page.mouse.wheel(0, 25000);
      await editor.locator('p').last().click();
      await page.keyboard.press('End');
      await page.keyboard.type(' reachable caret');
      await expect(editor).toContainText('reachable caret');
      await expect.poll(async () => (await geometry()).top).toBeGreaterThan(1000);
      const final = await geometry();
      const caret = await page.evaluate(() => { const sel = window.getSelection(); const r = sel.getRangeAt(0).cloneRange(); r.setStart(r.startContainer, Math.max(0, r.startOffset - 1)); return r.getBoundingClientRect().toJSON(); });
      expect(caret.bottom).toBeLessThanOrEqual(final.rect.bottom + 2);
      const switcher = await page.locator('.doc-mobile-switcher').boundingBox();
      if (switcher) expect(caret.bottom).toBeLessThanOrEqual(switcher.y);
      expect(caret.top).toBeGreaterThanOrEqual(final.rect.top + 30);
      console.log(JSON.stringify({ engine, width, height, before, expanded, collapsed, final, caret }));
      await browser.close();
    });
  }
}
