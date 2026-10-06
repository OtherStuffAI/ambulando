const { test, expect } = require('playwright/test');
test.setTimeout(30_000);
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

// Synthetic records, real built UI, native clicks/taps and IndexedDB. This is
// browser regression coverage, not evidence of authenticated Tower access.
async function seed(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', route => {
    if (process.env.FLIGHTDECK_LINKED_RUNTIME === '1') {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(async () => {
    const s = window.Alpine.store('chat');
    const owner = 'npub1internalreferencebrowser';
    const key = `reference-browser-${crypto.randomUUID()}`;
    s.session = { npub: owner };
    s.bootstrapSelectedWorkspace = async () => {};
    s.ensurePgWorkspaceAvailable = async workspace => workspace;
    s.knownWorkspaces = [{ workspaceKey: key, workspaceId: key, workspaceOwnerNpub: owner,
      directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    for (const name of ['startWorkspaceLiveQueries', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries',
      'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings',
      'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) s[name] = async () => {};
    await s.selectWorkspace(key, { skipPgVerification: true });
    // Startup reconciliation must not reselect this isolated synthetic fixture.
    s.selectWorkspace = async () => {};
    s.__referenceDbName = `wingman-fd-ws-${key}`;
    // Dexie opens lazily; a real local read initializes all production stores.
    await s.loadLocalScopes();
    s.openConnectModal = () => {};
    // Cold click probes must not be fulfilled by mouse hover prefetch.
    s.prefetchFlightDeckDoc = () => {};
    s.showConnectModal = false;
    s.navSection = 'status';
    s.selectedChannelId = 'source-channel';
    s.channels = [{ record_id: 'source-channel', title: 'Source', scope_id: 'source-scope', record_state: 'active' },
      { record_id: 'target-channel', title: 'Target channel', scope_id: 'target-scope', record_state: 'active' }];
    s.scopes = [{ record_id: 'target-scope', name: 'Target scope', title: 'Target scope', record_state: 'active' }];
    const base = { owner_npub: owner, record_state: 'active', version: 1, sync_status: 'synced',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
      pg_channel_id: 'target-channel', scope_id: 'target-scope', group_ids: [], shares: [] };
    s.__referenceDoc = { ...base, record_id: 'target-doc', title: 'Target document', content: 'Loaded target body', content_blocks: [] };
    s.__referenceTask = { ...base, record_id: 'target-task', title: 'Target task', description: 'Loaded task detail', state: 'open' };
    s.documents = [s.__referenceDoc]; s.tasks = [s.__referenceTask];
    s.directories = [{ ...base, record_id: 'target-folder', title: 'Target folder' }];
    s.reports = [{ ...base, record_id: 'target-report', title: 'Target report', content: 'Report body' }];
    s.hydrateSelectedDocWithRetry = async () => null;
    s.inspectSelectedDocEditLease = async () => null;
    s.startDocCommentsLiveQuery = () => {};
    s.loadDocComments = async () => [];
    s.loadSelectedDocRecoveries = async () => [];
    s.scheduleDocAutosave = () => {};
    s.markDocRead = () => {};
    s.startTaskCommentsLiveQuery = () => {};
    s.loadTaskComments = async () => {};
    s.startThreadLiveActivity = async () => {};
    s.markTowerPgResourceViewed = async () => {};
    s.loadDeckThreadHistoryPage = async () => {};
    s.scheduleStorageImageHydration = () => {};
    s.fileMessages = [{ ...base, record_id: 'source-message', channel_id: 'source-channel', pg_thread_id: 'source-thread',
      sender_npub: owner, parent_message_id: null,
      body: ['document:target-doc', 'task:target-task', 'channel:target-channel', 'scope:target-scope',
        'directory:target-folder', 'report:target-report', 'person:npub1internalreferencebrowser', 'agent:npub1internalreferencebrowser', 'document:missing-doc'].map(ref => {
          const [type, id] = ref.split(':'); return `@[${id}](mention:${type}:${id})`;
        }).join(' ') + ' [Route document](/docs?docid=target-doc) [Route task](/tasks?taskid=target-task) [Foreign document](/docs?docid=target-doc&workspacekey=foreign-workspace)' }];
    s.messages = s.fileMessages;
    s.syncRoute(true);
    await s.openDeckThread('source-channel', 'source-message', { towerThreadId: 'source-thread', scrollToLatest: false });
    s.threadInput = 'Preserve source draft';
  });
}

for (const width of [1120, 390]) {
  for (const [type, id, expected] of [
    ['document', 'target-doc', { selectedDocId: 'target-doc' }],
    ['task', 'target-task', { activeTaskId: 'target-task' }],
    ['channel', 'target-channel', { selectedChannelId: 'target-channel', navSection: 'chat' }],
    ['scope', 'target-scope', { navSection: 'settings', scopeNavFocus: 'target-scope' }],
    ['directory', 'target-folder', { navSection: 'docs', currentFolderId: 'target-folder' }],

  ]) {
    test(`native modal ${type} link opens semantic destination at ${width}px`, async ({ page }) => {
      await seed(page, width);
      await page.getByRole('dialog', { name: 'Thread', exact: true }).locator(`[data-mention-id="${id}"]`).click();
      await expect.poll(() => page.evaluate(keys => {
        const s = window.Alpine.store('chat'); return Object.fromEntries(keys.map(k => [k, s[k]]));
      }, Object.keys(expected))).toEqual(expected);
      await expect(page.getByRole('dialog', { name: 'Thread', exact: true })).toHaveCount(0);
      if (type === 'report') expect(await page.evaluate(() => window.Alpine.store('chat').reportModalReport?.record_id)).toBe(id);
    });
  }

  test(`document link opens Dexie-only row absent rendered collections at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.evaluate(async () => {
      const s = window.Alpine.store('chat');
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open(s.__referenceDbName); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('documents', 'readwrite'); tx.objectStore('documents').put(JSON.parse(JSON.stringify(s.__referenceDoc))); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close(); s.documents = [];
      s.requestTowerSyncFamily = async () => { throw new Error('Cached link must not wait on Tower'); };
    });
    await page.getByRole('dialog', { name: 'Thread', exact: true }).locator('[data-mention-id="target-doc"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('target-doc');
    await expect(page.locator('.doc-preview-surface')).toContainText('Loaded target body');
  });
}

for (const width of [1120, 390]) {
  test(`cold target acknowledges click, latest cached click wins at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat'); s.documents = [];
      s.__referenceReads = [];
      s.requestTowerSyncFamily = (family, id) => {
        s.__referenceReads.push({ family, id });
        return new Promise(resolve => { s.__releaseReferenceRead = () => resolve(s.__referenceDoc); });
      };
    });
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.locator('[data-mention-id="target-doc"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').internalLinkOpening)).toBeTruthy();
    await expect(dialog.locator('.internal-reference-feedback').getByRole('status')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').__referenceReads)).toEqual([{ family: 'document', id: 'target-doc' }]);
    await dialog.locator('[data-mention-id="target-task"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').activeTaskId)).toBe('target-task');
    await page.evaluate(() => window.Alpine.store('chat').__releaseReferenceRead());
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => ({ task: window.Alpine.store('chat').activeTaskId, doc: window.Alpine.store('chat').selectedDocId }))).toEqual({ task: 'target-task', doc: null });
  });

  test(`task activity rendered document link opens on first click at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.getByRole('dialog', { name: 'Thread', exact: true }).locator('[data-mention-id="target-task"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').activeTaskId)).toBe('target-task');
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.taskComments = [{ record_id: 'task-link-comment', target_record_id: 'target-task',
        sender_npub: s.session.npub, body: '@[Activity document](mention:document:target-doc)',
        created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', record_state: 'active' }];
      s.taskDetailMobilePane = 'comments';
    });
    const activity = page.locator('.task-comment-body [data-mention-id="target-doc"]').first();
    if (width === 390) {
      const button = page.locator('.task-detail-mobile-switcher').getByRole('button', { name: /Activity|Comments/ }).first();
      if (await button.isVisible()) await button.click();
    }
    await activity.click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('target-doc');
  });
}

for (const width of [1120, 390]) {
  for (const surface of ['document-comment', 'document-block']) {
    test(`${surface} native task link opens on first click at ${width}px`, async ({ page }) => {
      await seed(page, width);
      await page.getByRole('dialog', { name: 'Thread', exact: true }).locator('[data-mention-id="target-doc"]').click();
      await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('target-doc');
      await page.evaluate(surface => {
        const s = window.Alpine.store('chat');
        if (surface === 'document-comment') {
          s.docComments = [{ record_id: 'doc-link-comment', target_record_id: 'target-doc',
            sender_npub: s.session.npub, body: '@[Comment task](mention:task:target-task)',
            parent_comment_id: null, comment_status: 'open', record_state: 'active',
            created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }];
          s.docCommentsVisible = true; s.docMobilePane = 'comments';
        } else {
          s.docEditorMode = 'block'; s.docMobilePane = 'document';
          s.docEditorBlocks = [{ id: 'reference-block', type: 'markdown', text: '@[Block task](mention:task:target-task)',
            raw: '@[Block task](mention:task:target-task)', attrs: {}, start_line: 1 }];
        }
      }, surface);
      const selector = surface === 'document-comment' ? '.doc-thread-entry [data-mention-id="target-task"]' : '.doc-block-rendered [data-mention-id="target-task"]';
      await page.locator(selector).first().click();
      await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').activeTaskId)).toBe('target-task');
    });
  }
}

for (const width of [1120, 390]) {
  test(`missing document loads by narrow click read and rejected read is visible at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat'); s.documents = []; s.__referenceReads = [];
      s.requestTowerSyncFamily = async (family, id) => {
        s.__referenceReads.push({ family, id });
        if (id === 'missing-doc') throw new Error('403: permission denied');
        s.applyDocuments([s.__referenceDoc]);
      };
    });
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.locator('[data-mention-id="missing-doc"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').internalLinkOpenError)).toContain('permission denied');
    await expect(page.getByRole('alert').filter({ hasText: /Could not open linked doc/ }).first()).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-mention-id="target-doc"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').selectedDocId)).toBe('target-doc');
    expect(await page.evaluate(() => window.Alpine.store('chat').__referenceReads)).toEqual([
      { family: 'document', id: 'missing-doc' }, { family: 'document', id: 'target-doc' },
    ]);
  });
}

for (const width of [1120, 390]) for (const type of ['person', 'agent']) {
  test(`${type} modal link preserves identity-card semantics at ${width}px`, async ({ page }) => {
    await seed(page, width);
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.locator(`[data-mention-type="${type}"]`).click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').identityCard.open)).toBe(true);
    expect(await page.evaluate(() => window.Alpine.store('chat').identityCard.npub)).toBe('npub1internalreferencebrowser');
    await expect(dialog).toBeVisible();
  });
}

for (const width of [1120, 390]) for (const type of ['document', 'task']) {
  test(`same-origin ${type} route in non-chat modal uses target resolver at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.getByRole('dialog', { name: 'Thread', exact: true }).getByRole('link', { name: `Route ${type}`, exact: true }).click();
    const key = type === 'document' ? 'selectedDocId' : 'activeTaskId';
    await expect.poll(() => page.evaluate(key => window.Alpine.store('chat')[key], key)).toBe(type === 'document' ? 'target-doc' : 'target-task');
  });
}

for (const width of [1120, 390]) {
  test(`disabled report link visibly explains unavailable destination at ${width}px`, async ({ page }) => {
    await seed(page, width);
    const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
    await dialog.locator('[data-mention-id="target-report"]').click();
    await expect(dialog.getByRole('alert').filter({ hasText: /disabled/ }).first()).toBeVisible();
    await expect(dialog).toBeVisible();
  });
}

async function measureCachedOpen(page, type, touch) {
  const id = type === 'document' ? 'target-doc' : 'target-task';
  const selector = type === 'document' ? '.doc-title-display' : '.task-detail-title, .task-detail-title-display';
  const title = type === 'document' ? 'Target document' : 'Target task';
  await page.evaluate(({ id, selector, title }) => {
    window.__referencePaint = new Promise(resolve => {
      const onClick = event => {
        if (event.target.closest(`[data-mention-id="${id}"]`)) {
          document.removeEventListener('click', onClick, true);
          const activated = performance.now();
          const sample = () => {
            const node = [...document.querySelectorAll(selector)].find(node => (node.value || node.textContent).trim() === title && node.getBoundingClientRect().height > 0);
            if (node) requestAnimationFrame(() => resolve(performance.now() - activated));
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }
      };
      document.addEventListener('click', onClick, true);
    });
  }, { id, selector, title });
  const link = page.getByRole('dialog', { name: 'Thread', exact: true }).locator(`[data-mention-id="${id}"]`);
  if (touch) await link.tap(); else await link.click();
  const elapsed = await page.evaluate(() => window.__referencePaint);
  console.log(`REFERENCE_PAINT ${JSON.stringify({ type, device: touch ? 'touch' : 'desktop', elapsedMs: elapsed })}`);
  expect(elapsed).toBeLessThan(200);
}

for (const type of ['document', 'task']) {
  test(`cached ${type} desktop click paints destination within 200ms`, async ({ page }) => {
    await seed(page, 1120);
    await measureCachedOpen(page, type, false);
  });
}

test.describe('native mobile taps', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 900 } });
  for (const type of ['document', 'task']) {
    test(`cached ${type} touch tap paints destination within 200ms`, async ({ page }) => {
      await seed(page, 390);
      await measureCachedOpen(page, type, true);
    });
  }
});

for (const width of [1120, 390]) for (const mark of ['fdMention', 'link']) {
  test(`mounted rich ${mark} task reference opens on first native click at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.getByRole('dialog', { name: 'Thread', exact: true }).locator('[data-mention-id="target-doc"]').click();
    await page.waitForFunction(() => Boolean(window.Alpine.store('chat').docRichEditorAdapter?.editor));
    await page.evaluate(mark => {
      const s = window.Alpine.store('chat');
      const attrs = mark === 'fdMention' ? { mentionType: 'task', mentionId: 'target-task', label: 'Rich task reference' } : { href: 'mention:task:target-task' };
      window.Alpine.raw(s.docRichEditorAdapter.editor).commands.setContent({ type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Rich task reference', marks: [{ type: mark, attrs }] }] },
      ] });
    }, mark);
    await page.locator('.tiptap [data-mention-id="target-task"]').click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').activeTaskId)).toBe('target-task');
  });
}

test('explicit foreign workspace route fails visibly without reading current workspace target', async ({ page }) => {
  await seed(page, 1120);
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.__referenceReads = []; s.requestTowerSyncFamily = async (...args) => s.__referenceReads.push(args); });
  const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
  await dialog.getByRole('link', { name: 'Foreign document', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: /another workspace/ }).first()).toBeVisible();
  expect(await page.evaluate(() => ({ doc: window.Alpine.store('chat').selectedDocId, reads: window.Alpine.store('chat').__referenceReads }))).toEqual({ doc: null, reads: [] });
  await expect(dialog).toBeVisible();
});

for (const width of [1120, 390]) {
  test(`task link opens Dexie-only target absent rendered list at ${width}px`, async ({ page }) => {
    await seed(page, width);
    await page.evaluate(async () => {
      const s = window.Alpine.store('chat');
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open(s.__referenceDbName); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('tasks', 'readwrite'); tx.objectStore('tasks').put(JSON.parse(JSON.stringify(s.__referenceTask))); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close(); s.tasks = [];
      s.requestTowerSyncFamily = async () => { throw new Error('Dexie task must not wait on Tower'); };
    });
    await page.getByRole('dialog', { name: 'Thread', exact: true }).locator('[data-mention-id="target-task"]').click();
    await expect(page.locator('.task-detail-title')).toHaveValue('Target task');
    expect(await page.evaluate(() => window.Alpine.store('chat').activeTaskId)).toBe('target-task');
  });
}

test('closing source modal cancels pending target read navigation', async ({ page }) => {
  await seed(page, 1120);
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.documents = [];
    s.requestTowerSyncFamily = () => new Promise(resolve => { s.__releaseReferenceRead = () => { s.applyDocuments([s.__referenceDoc]); resolve(); }; }); });
  const dialog = page.getByRole('dialog', { name: 'Thread', exact: true });
  await dialog.locator('[data-mention-id="target-doc"]').click();
  await expect(dialog.locator('.internal-reference-feedback').getByRole('status')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close thread', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.Alpine.store('chat').__releaseReferenceRead());
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => ({ section: window.Alpine.store('chat').navSection, doc: window.Alpine.store('chat').selectedDocId }))).toEqual({ section: 'status', doc: null });
});
