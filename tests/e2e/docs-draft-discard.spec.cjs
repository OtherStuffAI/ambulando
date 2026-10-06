const { test, expect } = require('playwright/test');

test('discarding a blocked draft clears recovery UI and refreshes current ownership', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/');
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 100; index += 1) {
      if (window.Alpine?.store?.('chat')) break;
      await wait(50);
    }
    const store = window.Alpine?.store?.('chat');
    if (!store) throw new Error('Alpine chat store did not initialize.');
    store.openConnectModal = () => {};
    store.showConnectModal = false;
    const now = new Date().toISOString();
    const authoritative = {
      record_id: 'doc-draft-discard',
      owner_npub: 'npub1docsdiscardtest',
      title: 'Draft discard test',
      content: 'Authoritative Tower body',
      content_blocks: [{ id: 'block-1', type: 'markdown', raw: 'Authoritative Tower body', text: 'Authoritative Tower body', attrs: {}, start_line: 1 }],
      version: 2,
      pg_backend: true,
      pg_workspace_id: 'workspace-doc-discard',
      pg_record_type: 'doc',
      sync_status: 'synced',
      record_state: 'active',
      created_at: now,
      updated_at: now,
      shares: [],
      group_ids: [],
    };
    store.session = { ...(store.session || {}), npub: 'npub1docsdiscardtest' };
    store.navSection = 'docs';
    store.documents = [authoritative];
    store.directories = [];
    store.selectedDocId = authoritative.record_id;
    store.selectedDocType = 'document';
    store.loadDocEditorFromSelection();
    store.hydrateSelectedDocWithRetry = async () => authoritative;
    store.__draftDeleted = false;
    store.clearSelectedDocDraft = async () => {
      store.__draftDeleted = true;
      store.docLocalDraft = null;
      return true;
    };
    store.inspectSelectedDocEditLease = async () => {
      const lease = {
        id: 'lease-other',
        holder_actor_npub: 'npub1othereditor',
        holder_display_name: 'Other editor',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      store.docEditLeaseInfo = lease;
      return { inspectionState: 'ready', inspectedLease: lease };
    };
    store.__retryCalls = 0;
    store.beginSelectedDocLeaseAcquisition = async () => { store.__retryCalls += 1; return false; };
  });
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.Alpine.store('chat').docRichEditorAdapter));
  await page.evaluate(async () => {
    const store = window.Alpine.store('chat');
    store.docRichEditorAdapter.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsent local draft' }] }],
    }, { emitUpdate: false });
    store.docEditDraftDirty = true;
    store.docEditAccessState = 'blocked';
    store.docEditAccessMessage = 'Another actor is editing this Tower PG record. View mode until the lease is available.';
    store.docEditConflict = { baseVersion: 1, currentVersion: 2 };
    store.docLocalDraft = { document_id: store.selectedDocId, content: 'Unsent local draft' };
  });

  await expect(page.locator('.doc-edit-status')).toContainText('Draft preserved');
  await page.locator('.doc-recovery-summary').click();
  await page.getByRole('button', { name: 'Discard local draft' }).click();

  await expect(page.getByRole('button', { name: 'Discard local draft' })).toBeHidden();
  await expect(page.locator('.doc-edit-status')).toContainText('Edit access unavailable');
  await expect(page.locator('.doc-edit-status')).not.toContainText('Draft preserved');
  await expect(page.locator('.doc-edit-access-banner')).toContainText('Edit access unavailable');
  await expect(page.locator('.doc-rich-editor .ProseMirror')).toHaveAttribute('contenteditable', 'false');

  const state = await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    return {
      draftDeleted: store.__draftDeleted,
      dirty: store.docEditDraftDirty,
      conflict: store.docEditConflict,
      recovery: store.docRecovery,
      accessState: store.docEditAccessState,
      content: store.docEditorContent,
      holder: store.docEditLeaseInfo?.holder_actor_npub,
    };
  });
  expect(state).toEqual({
    draftDeleted: true,
    dirty: false,
    conflict: null,
    recovery: null,
    accessState: 'blocked',
    content: 'Authoritative Tower body',
    holder: 'npub1othereditor',
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').__retryCalls)).toBe(1);
});
