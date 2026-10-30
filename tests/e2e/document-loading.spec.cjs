const { test, expect } = require('playwright/test');
test.use({ serviceWorkers: 'block' });

async function openCachedDocument(page, beforeOpen = async () => {}) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine?.store?.('chat'));
  await beforeOpen();
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.session = { npub: 'npub1documentloadingtest' };
    s.showConnectModal = false;
    s.openConnectModal = () => {};
    s.documents = [{ record_id: 'loading-test', title: 'Loading test', content: 'Body survives editor failure', version: 1, pg_backend: true, sync_status: 'pending', record_state: 'active' }];
    s.__hydrateDocument = s.hydrateSelectedDocWithRetry;
    s.hydrateSelectedDocWithRetry = async () => null;
    s.inspectSelectedDocEditLease = async () => null;
    s.__restoreDocumentDraft = s.restoreSelectedDocDraft;
    s.restoreSelectedDocDraft = async () => null;
    s.loadDocComments = async () => [];
    s.ensureBackgroundSync = () => {};
    s.openDoc('loading-test', { edit: true });
  });
}

test('permanent editor failure automatically keeps readable content and permits a fresh explicit retry', async ({ page }) => {
  const requests = [];
  await page.route('**/assets/tiptap-editor-adapter-*.js*', route => {
    requests.push(route.request().url());
    return route.abort('failed');
  });
  await openCachedDocument(page);
  await expect(page.getByText(/Editing is unavailable\./)).toBeVisible();
  await expect(page.locator('[data-doc-editor-fallback]')).toContainText('Body survives editor failure');
  await expect(page.locator('.doc-rich-editor')).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1]).searchParams.get('editor-retry')).toBe('1');
  await page.evaluate(() => { window.Alpine.store('chat').selectedDocument.version++; });
  await page.waitForTimeout(600);
  expect(requests).toHaveLength(2);
  await page.unroute('**/assets/tiptap-editor-adapter-*.js*');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
  await expect(page.locator('[data-doc-editor-fallback]')).toHaveCount(0);
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocument.content)).toBe('Body survives editor failure');
});

test('transient entry import failure recovers automatically with a different module identity', async ({ page }) => {
  const requests = [];
  const failures = [];
  page.on('pageerror', error => {
    if (/module|tiptap|mountDocRichEditor/i.test(error.message)) failures.push(error.message);
  });
  await page.route('**/assets/tiptap-editor-adapter-*.js*', route => {
    requests.push(route.request().url());
    return requests.length === 1 ? route.abort('failed') : route.continue();
  });
  await openCachedDocument(page);
  await expect(page.locator('[data-doc-editor-fallback]')).toContainText('Body survives editor failure');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
  expect(requests).toHaveLength(2);
  expect(requests[0]).not.toBe(requests[1]);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => window.Alpine.store('chat').docRichEditorLoadError)).toBe('');
});

test('service-worker controlled editor recovers after a failed cold network fetch', async ({ browser }, testInfo) => {
  // Playwright 1.51 gates interception of worker-owned network requests.
  const previousWorkerEvents = process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS;
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: 'allow' });
  await context.addInitScript(() => {
    new MutationObserver(() => document.querySelectorAll('iframe').forEach(frame => frame.remove()))
      .observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  try {
    let requests = 0;
    let workerFetchFailed = false;
    await context.route('**/assets/tiptap-editor-adapter-*.js*', route => {
      requests++;
      if (requests === 1) {
        workerFetchFailed = Boolean(route.request().serviceWorker());
        return route.abort('failed');
      }
      return route.continue();
    });
    // Synthetic workspaces have no island dashboards. Do not let empty iframe
    // targets recursively boot the app shell while testing its real worker.
    await page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) {
        return route.fulfill({ contentType: 'text/html', body: '' });
      }
      return route.continue();
    });
    const failedImport = page.waitForEvent('console', { timeout: 15000,
      predicate: message => message.text().includes('document editor import failed; attempting recovery') });
    await openCachedDocument(page, async () => {
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 });
    });
    await failedImport;
    await expect(page.locator('[data-doc-editor-fallback]')).toContainText('Body survives editor failure');
    await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
    expect(await page.evaluate(() => window.Alpine.store('chat').docRichEditorLoadState)).toBe('ready');
    expect(workerFetchFailed).toBe(true);
    expect(requests).toBe(2);
  } finally {
    await context.setOffline(false);
    await context.close();
    if (previousWorkerEvents === undefined) delete process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS;
    else process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = previousWorkerEvents;
  }
});

test('a missing old-deploy editor asset stops recovery without reloading or replacing content', async ({ page }) => {
  let navigations = 0;
  let requests = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
  });
  await page.route('**/assets/tiptap-editor-adapter-*.js*', route => {
    requests++;
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Asset not found' });
  });
  await openCachedDocument(page);
  await expect(page.getByText(/Editing is unavailable\./)).toBeVisible();
  await expect(page.locator('[data-doc-editor-fallback]')).toContainText('Body survives editor failure');
  await page.waitForTimeout(700);
  expect(requests).toBe(2);
  expect(navigations).toBe(1);
  expect(await page.evaluate(() => ({ mode: window.Alpine.store('chat').docEditorMode,
    body: window.Alpine.store('chat').selectedDocument.content }))).toEqual({ mode: 'rich', body: 'Body survives editor failure' });
});

test('navigation during recovery mounts only the new document and keeps it read-only when permission changes', async ({ page }) => {
  let release;
  await page.route('**/assets/tiptap-editor-adapter-*.js*', async route => {
    if (!new URL(route.request().url()).searchParams.has('editor-retry')) return route.abort('failed');
    await new Promise(resolve => { release = resolve; });
    return route.continue();
  });
  await openCachedDocument(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.documents.push({ ...s.selectedDocument, record_id: 'next-document', title: 'Next document', content: 'New selection body' });
    s.openDoc('next-document', { syncRoute: false });
    s.isSelectedDocRichEditorEditable = () => false;
  });
  release();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('New selection body');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toHaveCount(1);
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toHaveAttribute('contenteditable', 'false');
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('next-document');
});

test('warm document opens render the body repeatedly', async ({ page }) => {
  await openCachedDocument(page);
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.closeDocEditor({ syncRoute: false });
      s.openDoc('loading-test', { syncRoute: false });
    });
  }
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
});

test('cold body completion at the same version renders on first open and ignores a late old visit', async ({ page }) => {
  await openCachedDocument(page);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.closeDocEditor({ syncRoute: false });
    const metadata = { record_id: 'cold-body', title: 'Cold body', content: '', version: 1, pg_backend: true, sync_status: 'synced', record_state: 'active', content_storage_object_id: 'cold-object', content_storage_status: 'remote' };
    s.documents = [...s.documents, metadata];
    s.hydrateSelectedDocWithRetry = () => new Promise(resolve => { s.__finishBody = resolve; });
    s.openDoc(metadata.record_id, { syncRoute: false });
  });
  await expect(page.getByText('Preview only — loading complete document…', { exact: true })).toBeVisible();
  await page.waitForFunction(() => typeof window.Alpine.store('chat').__finishBody === 'function');
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    const fresh = { ...s.selectedDocument, content: 'Complete authoritative body', content_storage_status: 'loaded' };
    s.documents = s.documents.map(row => row.record_id === fresh.record_id ? fresh : row);
    s.__finishBody(fresh);
  });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Complete authoritative body');
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    delete s.__finishBody;
    s.openDoc('cold-body', { syncRoute: false });
  });
  await page.waitForFunction(() => !!window.Alpine.store('chat').__finishBody);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    const old = s.__finishBody;
    s.openDoc('loading-test', { syncRoute: false });
    old({ record_id: 'cold-body', content: 'Stale body', content_storage_status: 'loaded' });
  });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Body survives editor failure');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).not.toContainText('Stale body');
});


test('native cross-channel document link recovers a deferred cold body on first open', async ({ page }) => {
  await openCachedDocument(page);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.closeDocEditor({ syncRoute: false });
    s.channels = [{ record_id: 'source-channel', title: 'Source' }, { record_id: 'target-channel', title: 'Target' }];
    s.selectedChannelId = 'source-channel';
    s.persistSelectedBoardId = () => {};
    s.documents = [
      { ...s.documents[0], pg_channel_id: 'source-channel', content: '@[Linked document](mention:document:cross-channel-body)' },
      { record_id: 'cross-channel-body', title: 'Linked body', pg_channel_id: 'target-channel', content: '', content_storage_object_id: 'object', content_storage_status: 'remote', version: 1, pg_backend: true, sync_status: 'synced', record_state: 'active' },
    ];
    s.hydrateSelectedDocWithRetry = s.__hydrateDocument;
    s.__bodyCalls = 0;
    s.prefetchFlightDeckDoc = async id => {
      if (id !== 'cross-channel-body') return s.documents.find(row => row.record_id === id);
      // Pointer hover prefetch is independent of the selected-body reconciliation
      // under test. Keep its request from consuming the deferred fixture result.
      if (s.selectedDocId !== id) return null;
      s.__bodyCalls++;
      if (s.__bodyCalls === 1) return { deferred: true, family: 'document', id };
      const fresh = { ...s.documents.find(row => row.record_id === id), content: 'First-open linked body', content_storage_status: 'loaded' };
      s.documents = s.documents.map(row => row.record_id === id ? fresh : row);
      return fresh;
    };
    s.loadSelectedDocRecoveries = async () => [];
    s.markDocRead = () => {};
    s.openDoc('loading-test', { syncRoute: false });
  });
  await page.locator('.doc-rich-editor [data-mention-id="cross-channel-body"]').click();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('First-open linked body');
  await expect.poll(() => page.evaluate(() => {
    const s = window.Alpine.store('chat');
    return { id: s.selectedDocId, channel: s.selectedChannelId, calls: s.__bodyCalls };
  })).toEqual({ id: 'cross-channel-body', channel: 'target-channel', calls: 2 });
});

test('body error has explicit recovery on the same selected document', async ({ page }) => {
  await openCachedDocument(page);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.closeDocEditor({ syncRoute: false });
    s.documents = [{ record_id: 'failed-body', title: 'Failed body', content: '', version: 1, pg_backend: true, sync_status: 'synced', record_state: 'active', content_storage_object_id: 'object', content_storage_status: 'error' }];
    s.openDoc('failed-body', { syncRoute: false });
  });
  await expect(page.getByText('Preview only — complete document unavailable. Reconnect and retry to edit.', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.hydrateSelectedDocWithRetry = s.__hydrateDocument;
    s.prefetchFlightDeckDoc = async () => {
      const fresh = { ...s.selectedDocument, content: 'Recovered after reconnect', content_storage_status: 'loaded' };
      s.documents = [fresh];
      return fresh;
    };
    s.loadSelectedDocRecoveries = async () => [];
    s.markDocRead = () => {};
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('Recovered after reconnect');
  await expect(page.getByText('Preview only — complete document unavailable. Reconnect and retry to edit.', { exact: true })).toBeHidden();
});

test('complete cached body edits offline and reopening requires an explicit draft choice', async ({ page, context }) => {
  await openCachedDocument(page);
  await page.evaluate(async () => {
    const s = window.Alpine.store('chat');
    s.closeDocEditor({ syncRoute: false });
    const owner = 'npub1offlinedocumentbrowser';
    const key = `offline-document-${crypto.randomUUID()}`;
    s.session = { npub: owner };
    s.bootstrapSelectedWorkspace = async () => {};
    s.ensurePgWorkspaceAvailable = async workspace => workspace;
    s.knownWorkspaces = [{ workspaceKey: key, workspaceId: key, workspaceOwnerNpub: owner,
      directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    for (const name of ['startWorkspaceLiveQueries', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) s[name] = async () => {};
    await s.selectWorkspace(key, { skipPgVerification: true });
    s.__offlineDb = `wingman-fd-ws-${key}`;
    await s.loadLocalScopes();
    s.documents = [{ record_id: 'offline-doc', title: 'Offline document', content: 'Complete cached saved body',
      owner_npub: owner, pg_workspace_id: key, scope_id: 'offline-scope', pg_backend: true,
      sync_status: 'synced', record_state: 'active', version: 2,
      content_storage_object_id: 'offline-object', content_storage_status: 'loaded',
      content_sha256_hex: 'b'.repeat(64), pg_canonical_body_sha256_hex: 'b'.repeat(64) }];
    s.loadSelectedDocRecoveries = async () => [];
    s.restoreSelectedDocDraft = s.__restoreDocumentDraft;
  });
  await context.setOffline(true);
  await page.evaluate(() => window.Alpine.store('chat').openDoc('offline-doc', { syncRoute: false }));
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await expect(editor).toContainText('Complete cached saved body');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Offline edit');
  await expect(page.getByText('Saved on this device · waiting to sync', { exact: true }).first()).toBeVisible();
  await page.evaluate(async () => {
    const s = window.Alpine.store('chat');
    await s.persistSelectedDocDraft();
    s.closeDocEditor({ syncRoute: false });
    s.openDoc('offline-doc', { syncRoute: false });
  });
  await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toBeVisible();
  await expect(editor).toContainText('Complete cached saved body');
  await expect(editor).not.toContainText('Offline edit');
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(editor).toContainText('Offline edit');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedDocument.content)).toBe('Complete cached saved body');
});
