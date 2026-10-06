const { test, expect } = require('playwright/test');

async function seedSelectedDocument(page, options = {}) {
  await page.evaluate(async (seedOptions) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 100; index += 1) {
      if (window.Alpine?.store?.('chat')) break;
      await wait(50);
    }

    const store = window.Alpine?.store?.('chat');
    if (!store) throw new Error('Alpine chat store did not initialize.');
    const now = new Date().toISOString();
    const document = {
      record_id: 'doc-rich-default',
      owner_npub: 'npub1docsrichtest',
      title: 'Tip Tap Test',
      content: seedOptions.withStorageImage
        ? 'This should open in Tiptap by default.\n\n![Plant list](storage://image-object-123)'
        : 'This should open in Tiptap by default.',
      content_blocks: [{
        id: 'block-1',
        type: 'markdown',
        raw: 'This should open in Tiptap by default.',
        text: 'This should open in Tiptap by default.',
        attrs: {},
        start_line: 1,
      }, ...(seedOptions.withStorageImage ? [{
        id: 'block-2',
        type: 'image',
        raw: '![Plant list](storage://image-object-123)',
        text: '![Plant list](storage://image-object-123)',
        attrs: {},
        start_line: 3,
      }] : [])],
      content_model: null,
      version: 1,
      sync_status: 'synced',
      record_state: 'active',
      created_at: now,
      updated_at: now,
      shares: [],
      group_ids: [],
    };

    store.session = { ...(store.session || {}), npub: 'npub1docsrichtest' };
    // These synthetic editor probes do not own a Tower session. Keep signer
    // onboarding and automatic remote saves out of the isolated browser flow.
    store.openConnectModal = () => {};
    store.showConnectModal = false;
    store.scheduleDocAutosave = () => {};

    store.storageImageUrlCache = seedOptions.withStorageImage
      ? { 'image-object-123': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' }
      : {};
    store.navSection = 'docs';
    store.documents = [document];
    store.directories = [];
    store.currentFolderId = null;
    store.docComments = [];
    store.selectedDocId = document.record_id;
    store.selectedDocType = 'document';
    store.loadDocEditorFromSelection();

    if (seedOptions.enterEdit !== false) {
      store.acquireSelectedDocCheckout = async () => true;
      store.getSelectedDocCheckoutSession = () => ({
        checkout: {
          state: 'checked_out',
          holder_npub: 'npub1docsrichtest',
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      });

      const entered = await store.enterSelectedDocEditMode();
      if (!entered) throw new Error('Document edit mode did not open.');
    }
  }, options);
}

test('opening a document mounts the native Tiptap surface without acquiring edit access', async ({ page }) => {
  await page.goto('/');

  await seedSelectedDocument(page, { enterEdit: false });

  await expect(page.locator('.docs-editor-v3')).toBeVisible();
  await expect(page.locator('.doc-title-display')).toHaveText('Tip Tap Test');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('This should open in Tiptap by default.');
  await expect(page.locator('.doc-block-editor:visible')).toHaveCount(0);

  const editorMetrics = await page.locator('.doc-rich-editor .ProseMirror').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      text: node.textContent || '',
    };
  });

  expect(editorMetrics.width).toBeGreaterThan(300);
  expect(editorMetrics.height).toBeGreaterThan(120);
  expect(editorMetrics.text).toContain('This should open in Tiptap by default.');

  const access = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    return { mode: store.docEditorMode, state: store.docEditAccessState };
  });
  expect(access).toEqual({ mode: 'rich', state: 'ready' });
});

test('leaving Docs closes the selected editor before section data is cleared', async ({ page }) => {
  await page.goto('/');
  await seedSelectedDocument(page, { enterEdit: false });

  const result = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const released = [];
    store.releaseSelectedDocLeaseWhenSafe = async (record) => {
      released.push(record.record_id);
      return true;
    };
    store.navigateTo('tasks', { syncRoute: false });
    return {
      navSection: store.navSection,
      selectedDocId: store.selectedDocId,
      documents: store.documents.length,
      released,
    };
  });

  expect(result).toEqual({
    navSection: 'tasks',
    selectedDocId: null,
    documents: 0,
    released: ['doc-rich-default'],
  });
});

test('page lifecycle cleanup checkpoints a dirty document and schedules lease release', async ({ page }) => {
  await page.goto('/');
  await seedSelectedDocument(page, { enterEdit: false });

  const result = await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    const calls = [];
    store.docEditDraftDirty = true;
    store.persistSelectedDocDraft = async (options) => {
      calls.push(['draft', options]);
      return { document_id: store.selectedDocId };
    };
    store.releaseSelectedDocLeaseWhenSafe = async (record, options) => {
      await options.draftPromise;
      calls.push(['release', record.record_id]);
      return true;
    };
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return calls;
  });

  expect(result).toEqual([
    ['draft', { immediate: true }],
    ['release', 'doc-rich-default'],
  ]);
});

test('short rich timeline preserves whitespace and list structure through browser reopen', async ({ page }) => {
  test.setTimeout(45_000);
  const { shortRichDocumentFixture } = require('../fixtures/short-rich-document.js');
  const { markdownToProseMirrorDoc } = require('../../src/docs/editor/markdown-to-prosemirror.js');
  const { validateDocumentContentModelRoundTrip } = require('../../src/docs/editor/document-content-integrity.js');
  // This is an isolated rendering/serialization test; never contact a remote workspace.
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return ['127.0.0.1', 'localhost', '::1'].includes(host) ? route.continue() : route.abort();
  });
  await page.goto('/');
  await seedSelectedDocument(page, { enterEdit: false });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
  const setState = (state) => page.evaluate((next) => {
    const adapter = window.Alpine.store('chat').docRichEditorAdapter;
    adapter.setContent(next);
    return adapter.getContentModel();
  }, state);
  let model = await setState(shortRichDocumentFixture());
  const withoutIds = (state) => JSON.parse(JSON.stringify(state, (key, value) => key === 'fdBlockId' ? undefined : value));
  const original = withoutIds(model.editor_state);
  for (let cycle = 0; cycle < 3; cycle++) {
    expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
    model = await setState(markdownToProseMirrorDoc(model.content, { contentBlocks: model.content_blocks }));
    expect(withoutIds(model.editor_state)).toEqual(original);
    expect(await page.locator('.ProseMirror h2').textContent()).toBe('Phase 1: Preparation\u00a0');
    await expect(page.locator('.ProseMirror ol')).toHaveAttribute('start', '10');
    expect(await page.locator('.ProseMirror strong').textContent()).toBe('Deliverables:\u00a0');
  }
});

test('typing stays visible during delayed lease acquisition and continues in the same editor after success', async ({ page }) => {
  await page.goto('/');
  await seedSelectedDocument(page, { enterEdit: false });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const now = new Date().toISOString();
    const document = {
      record_id: 'doc-rich-delayed',
      owner_npub: 'npub1docsrichtest',
      title: 'Delayed lease',
      content: 'Base',
      content_blocks: [{ id: 'base', type: 'markdown', raw: 'Base', text: 'Base', attrs: {}, start_line: 1 }],
      version: 6,
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'synced',
      record_state: 'active',
      created_at: now,
      updated_at: now,
      shares: [],
      group_ids: [],
    };
    store.navSection = 'docs';
    store.documents = [document];
    store.selectedDocId = document.record_id;
    store.selectedDocType = 'document';
    store.loadDocEditorFromSelection();
    store.__leaseAcquireCalls = 0;
    store.__saveCalls = 0;
    store.scheduleDocAutosave = () => { store.__autosaveScheduled = (store.__autosaveScheduled || 0) + 1; };
    store.saveSelectedDocItem = async () => { store.__saveCalls += 1; return document; };
    store.acquireSelectedDocCheckout = () => {
      store.__leaseAcquireCalls += 1;
      return new Promise((resolve) => {
        window.__resolveDelayedDocLease = () => {
          store.pgEditLeaseSessions = {
            ...(store.pgEditLeaseSessions || {}),
            [`document:${document.record_id}`]: {
              acquireState: 'held',
              lease: { id: 'lease-delayed', lease_token: 'token-delayed' },
            },
          };
          resolve(true);
        };
      });
    };
  });

  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('End');
  expect(await page.evaluate(() => Alpine.store('chat').__leaseAcquireCalls)).toBe(0);
  await page.keyboard.type('ABC');

  await expect(page.locator('.doc-edit-status')).toHaveText('Acquiring edit access…');
  await expect(editor).toContainText('BaseABC');
  const acquiring = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const node = document.querySelector('.doc-rich-editor .ProseMirror');
    node.dataset.delayedLeaseProbe = 'same-editor';
    return {
      state: store.docEditAccessState,
      acquireCalls: store.__leaseAcquireCalls,
      saveCalls: store.__saveCalls,
      content: store.docRichEditorAdapter.editor.getText(),
    };
  });
  expect(acquiring).toEqual({ state: 'acquiring', acquireCalls: 1, saveCalls: 0, content: 'BaseABC' });

  await page.keyboard.type(' [[Lease pending page]]');
  await expect(editor.locator('.fd-wiki-unresolved')).toHaveText('Lease pending page');
  await page.evaluate(() => window.__resolveDelayedDocLease());
  await expect(page.locator('.doc-edit-status')).toHaveText('Saved');
  await expect(editor).toHaveAttribute('data-delayed-lease-probe', 'same-editor');
  await expect(editor).toContainText('BaseABC');
  const editing = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    return {
      state: store.docEditAccessState,
      acquireCalls: store.__leaseAcquireCalls,
      saveCalls: store.__saveCalls,
      autosaveScheduled: store.__autosaveScheduled,
      content: store.docRichEditorAdapter.editor.getText(),
      selectionFrom: store.docRichEditorAdapter.editor.state.selection.from,
    };
  });
  expect(editing).toMatchObject({
    state: 'editing',
    acquireCalls: 1,
    saveCalls: 0,
    content: 'BaseABC Lease pending page',
  });
  expect(editing.autosaveScheduled).toBeGreaterThanOrEqual(1);
  expect(editing.selectionFrom).toBeGreaterThan(1);
});

test('an accepted single-client save stays saved through same-version sparse hydration', async ({ page }) => {
  await page.goto('/');
  await seedSelectedDocument(page, { enterEdit: false });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();

  const result = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const initial = {
      ...store.selectedDocument,
      version: 5,
      pg_backend: true,
      pg_record_type: 'doc',
      pg_workspace_id: 'workspace-1',
      pg_channel_id: 'channel-1',
      content_storage_object_id: 'storage-v5',
      content_storage_status: 'loaded',
      content_sha256_hex: 'b'.repeat(64),
      pg_canonical_version_id: 'doc-rich-default:5',
      pg_canonical_storage_object_id: 'storage-v5',
      pg_canonical_body_sha256_hex: 'b'.repeat(64),
    };
    store.documents = [initial];
    store.docRichEditorAdapter.setContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { fdBlockId: 'saved-block' },
        content: [{ type: 'text', text: 'Edited once by this client.' }],
      }],
    }, { emitUpdate: false });
    const submitted = {
      ...initial,
      ...store.docRichEditorAdapter.getContentModel(),
      content_storage_object_id: 'storage-v6',
      content_sha256_hex: 'a'.repeat(64),
    };
    store.docEditBaseRecordId = initial.record_id;
    store.docEditBaseRowVersion = 5;
    store.docEditBaseVersionId = 'doc-rich-default:5';
    store.docEditBaseBodySha256Hex = 'b'.repeat(64);
    store.docEditBaseStorageObjectId = 'storage-v5';
    store.docEditBaseAvailable = true;
    store.docEditDraftDirty = true;
    store.docEditAccessState = 'editing';

    const accepted = store.acceptSelectedPgDocSaveCanonical({
      ...initial,
      version: 6,
      content_storage_object_id: 'storage-v6',
      content_storage_status: 'remote',
      content_sha256_hex: 'a'.repeat(64),
      pg_canonical_version_id: 'doc-rich-default:6',
      pg_canonical_storage_object_id: 'storage-v6',
      pg_canonical_body_sha256_hex: 'a'.repeat(64),
    }, submitted);
    store.docAutosaveState = 'saved';
    store.applyDocuments([{
      ...accepted,
      content_blocks: [],
      editor_state: null,
      content_storage_status: 'remote',
      content_sha256_hex: null,
      pg_canonical_body_sha256_hex: null,
    }]);
    store.observeSelectedDocAuthoritativeVersion();

    return {
      baseVersion: store.docEditBaseRowVersion,
      bodyHash: store.selectedDocument.pg_canonical_body_sha256_hex,
      dirty: store.docEditDraftDirty,
      autosaveState: store.docAutosaveState,
      accessState: store.docEditAccessState,
      conflict: store.docEditConflict,
      contentPreserved: store.selectedDocument.content === submitted.content,
    };
  });

  expect(result).toEqual({
    baseVersion: 6,
    bodyHash: 'a'.repeat(64),
    dirty: false,
    autosaveState: 'saved',
    accessState: 'editing',
    conflict: null,
    contentPreserved: true,
  });
});

test('rich document edit mode displays stored images while editing', async ({ page }) => {
  await page.goto('/');

  await seedSelectedDocument(page, { withStorageImage: true });

  const image = page.locator('.doc-rich-editor .ProseMirror img[data-storage-object-id="image-object-123"]');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^data:image\/gif;base64,/);
  await expect(image).toHaveClass(/md-storage-image/);
  await expect(image).not.toHaveClass(/md-storage-image-pending/);
});

test('comments stay usable without remounting or exiting the rich editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');

  await seedSelectedDocument(page);

  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Unsaved review draft.');

  const before = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const editorNode = document.querySelector('.doc-rich-editor .ProseMirror');
    editorNode.dataset.persistenceProbe = 'same-editor';
    store.docComments = [
      {
        record_id: 'comment-root-1',
        target_record_id: store.selectedDocId,
        parent_comment_id: null,
        anchor_block_id: null,
        anchor_line_number: null,
        comment_status: 'open',
        body: 'General review thread',
        sender_npub: store.session.npub,
        record_state: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const selection = store.docRichEditorAdapter.editor.state.selection;
    store.toggleDocCommentsVisible();
    return {
      mode: store.docEditorMode,
      content: store.docRichEditorAdapter.editor.getText(),
      selectionFrom: selection.from,
      selectionTo: selection.to,
    };
  });

  await expect(page.locator('.doc-comment-thread-panel')).toBeVisible();
  await expect(page.locator('.doc-comment-thread-panel')).toContainText('General review thread');
  await expect(page.locator('.doc-mode-chip', { hasText: 'Save' })).toBeVisible();
  await page.locator('.doc-thread-entry-root:visible').click();
  await page.locator('.doc-thread-reply:visible .doc-thread-reply-input').fill('Reply draft while editing');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toHaveAttribute('data-persistence-probe', 'same-editor');

  await page.setViewportSize({ width: 390, height: 820 });
  await expect(page.locator('.doc-comment-thread-panel')).toBeVisible();
  await expect(page.locator('.doc-mode-chip', { hasText: 'Save' })).toBeVisible();
  await page.getByLabel('Document sections').getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();

  const after = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const selection = store.docRichEditorAdapter.editor.state.selection;
    return {
      mode: store.docEditorMode,
      content: store.docRichEditorAdapter.editor.getText(),
      selectionFrom: selection.from,
      selectionTo: selection.to,
      nodeProbe: document.querySelector('.doc-rich-editor .ProseMirror')?.dataset.persistenceProbe,
    };
  });

  expect(after).toEqual({ ...before, nodeProbe: 'same-editor' });
});

test('rich-editor selection becomes a saved visible quote and line anchor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await seedSelectedDocument(page);
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();

  const before = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const editor = window.Alpine.raw(store.docRichEditorAdapter).editor;
    const quote = 'open in Tiptap';
    const text = editor.getText();
    const textOffset = text.indexOf(quote);
    const from = textOffset + 1;
    editor.commands.setTextSelection({ from, to: from + quote.length });
    const editorNode = document.querySelector('.doc-rich-editor .ProseMirror');
    editorNode.dataset.selectionAnchorProbe = 'same-editor';
    store.toggleDocCommentsVisible();
    return {
      quote,
      mode: store.docEditorMode,
      content: editor.getText(),
      from,
      to: from + quote.length,
    };
  });

  await page.getByTitle('Add a new comment').click();
  await expect(page.locator('.doc-thread-new-comment')).toBeVisible();
  await expect(page.locator('.doc-thread-new-comment-meta')).toHaveText('New comment on line 1');
  await expect(page.locator('.doc-thread-anchor-quote-pending')).toHaveText(before.quote);
  await expect(page.locator('.doc-mode-chip', { hasText: 'Save' })).toBeVisible();

  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const anchor = store.getPendingDocCommentAnchorFields();
    const now = new Date().toISOString();
    store.docComments = [{
      record_id: 'selection-root-1',
      target_record_id: store.selectedDocId,
      parent_comment_id: null,
      ...anchor,
      comment_status: 'open',
      body: 'Comment on selected text',
      sender_npub: store.session.npub,
      record_state: 'active',
      created_at: now,
      updated_at: now,
      pg_metadata: { ...anchor },
    }];
    store.selectDocCommentThread('selection-root-1', { syncRoute: false, reveal: false });
  });

  const savedAnchor = page.locator('.doc-thread-entry-root .doc-thread-anchor');
  await expect(savedAnchor.locator('.doc-thread-anchor-line')).toHaveText('Line 1');
  await expect(savedAnchor.locator('.doc-thread-anchor-quote')).toHaveText(before.quote);
  await expect(page.locator('.doc-thread-entry-root')).toContainText('Comment on selected text');

  await page.locator('.doc-thread-entry-root').click();
  const after = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    const editor = window.Alpine.raw(store.docRichEditorAdapter).editor;
    const selection = editor.state.selection;
    return {
      mode: store.docEditorMode,
      content: editor.getText(),
      selectedText: editor.state.doc.textBetween(selection.from, selection.to, '\n', ''),
      nodeProbe: document.querySelector('.doc-rich-editor .ProseMirror')?.dataset.selectionAnchorProbe,
    };
  });
  expect(after).toEqual({
    mode: before.mode,
    content: before.content,
    selectedText: before.quote,
    nodeProbe: 'same-editor',
  });

  await page.setViewportSize({ width: 390, height: 820 });
  await expect(savedAnchor.locator('.doc-thread-anchor-line')).toBeVisible();
  await expect(savedAnchor.locator('.doc-thread-anchor-quote')).toBeVisible();
  await expect(page.locator('.doc-mode-chip', { hasText: 'Save' })).toBeVisible();
});

test('rich document paste shows an upload placeholder before the image appears', async ({ page }) => {
  await page.goto('/');

  await seedSelectedDocument(page);
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();

  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.uploadInlineImageFile = () => new Promise((resolve) => {
      window.__resolveDocRichUpload = () => {
        store.storageImageUrlCache = {
          ...(store.storageImageUrlCache || {}),
          'uploaded-image-1': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        };
        resolve({
          objectId: 'uploaded-image-1',
          fileName: 'uploaded-image.png',
          markdown: '![uploaded-image.png](storage://uploaded-image-1)',
        });
      };
    });

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'uploaded-image.png', { type: 'image/png' });
    const clipboardData = new DataTransfer();
    clipboardData.items.add(file);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
    });
    document.querySelector('.doc-rich-editor .ProseMirror').dispatchEvent(pasteEvent);
  });

  await expect(page.locator('.doc-rich-upload-placeholder')).toBeVisible();
  await expect(page.locator('.doc-rich-upload-placeholder')).toHaveText('Uploading image...');

  await page.evaluate(() => window.__resolveDocRichUpload());

  await expect(page.locator('.doc-rich-upload-placeholder')).toHaveCount(0);
  const image = page.locator('.doc-rich-editor .ProseMirror img[data-storage-object-id="uploaded-image-1"]');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^data:image\/gif;base64,/);
});
