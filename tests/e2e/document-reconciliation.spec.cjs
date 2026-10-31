const { test, expect } = require('playwright/test');
test.use({ serviceWorkers: 'block' });

async function prepare(page, { overlap = false } = {}) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine?.store?.('chat'));
  await page.evaluate(async ({ overlap }) => {
    const s = window.Alpine.store('chat');
    const { createDocumentEditorState } = await import('/src/docs/editor/document-editor-store.js');
    const { documentContentSignature } = await import('/src/docs-manager.js');
    const owner = 'npub1documentreconciliation';
    const key = `review-${crypto.randomUUID()}`;
    s.session = { npub: owner };
    s.showConnectModal = false;
    s.openConnectModal = () => {};
    s.bootstrapSelectedWorkspace = async () => {};
    s.ensurePgWorkspaceAvailable = async workspace => workspace;
    s.knownWorkspaces = [{ workspaceKey: key, workspaceId: key, workspaceOwnerNpub: owner,
      directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    for (const name of ['startWorkspaceLiveQueries', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery']) s[name] = async () => {};
    await s.selectWorkspace(key, { skipPgVerification: true });
    s.ensureBackgroundSync = () => {};
    s.loadDocComments = async () => [];
    s.loadSelectedDocRecoveries = async () => [];
    s.inspectSelectedDocEditLease = async () => null;
    s.getEffectiveDocShares = () => [];
    s.beginSelectedDocLeaseAcquisition = async () => { s.docEditAccessState = 'editing'; return true; };
    const base = overlap ? 'Original sentence' : 'First paragraph\n\nSecond paragraph';
    const row = { record_id: 'review-doc', title: 'Review example', ...createDocumentEditorState({ content: base }).contentModel,
      owner_npub: owner, pg_workspace_id: key, scope_id: 'review-scope', pg_backend: true,
      sync_status: 'synced', record_state: 'active', version: 6,
      content_storage_object_id: 'base-v6', content_storage_status: 'loaded',
      content_sha256_hex: 'b'.repeat(64), pg_canonical_body_sha256_hex: 'b'.repeat(64), pg_canonical_version_id: 'review-doc:6' };
    s.documents = [row];
    const remote = overlap ? 'Their sentence' : 'First paragraph\n\nTheir second paragraph';
    s.__reviewRemote = { ...row, ...createDocumentEditorState({ content: remote }).contentModel, version: 8,
      content_storage_object_id: 'remote-v8', pg_canonical_body_sha256_hex: 'c'.repeat(64), pg_canonical_version_id: 'review-doc:8' };
    s.hydrateSelectedDocWithRetry = async () => JSON.parse(JSON.stringify(s.__reviewRemote));
    s.__reviewBaseSignature = documentContentSignature(row);
    s.openDoc('review-doc', { edit: true, syncRoute: false, ensureSync: false });
  }, { overlap });
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await page.evaluate(async ({ overlap }) => {
    const s = window.Alpine.store('chat');
    const { createDocumentEditorState } = await import('/src/docs/editor/document-editor-store.js');
    // Native text entry below owns the local change; force the common base to
    // the captured v6 because the initial background head read is separately mocked.
    const base = overlap ? 'Original sentence' : 'First paragraph\n\nSecond paragraph';
    const row = { ...s.selectedDocument, version: 6, ...createDocumentEditorState({ content: base }).contentModel,
      pg_canonical_body_sha256_hex: 'b'.repeat(64), pg_canonical_version_id: 'review-doc:6', content_storage_object_id: 'base-v6' };
    s.patchDocumentLocal(row);
    s.applySelectedDocAuthoritativeContent(row);
    s.docEditBaseContentSignature = s.__reviewBaseSignature;
    s.docEditAccessState = 'editing';
    s.docRichEditorAdapter.setEditable(true);
  }, { overlap });
  await editor.click();
  await editor.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector('p') || element);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type('My ');
  await page.evaluate(async () => { const s = window.Alpine.store('chat'); s.cancelDocAutosave(); await s.checkSelectedDocLatest(); });
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
  return editor;
}

test('browser worker merges independent rich edits and keeps a reviewable draft', async ({ page }) => {
  const editor = await prepare(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review document changes' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('latest saved v8');
  await page.getByRole('button', { name: 'Merge my changes — edit result', exact: true }).click();
  await expect(editor).toContainText('My First paragraph');
  await expect(editor).toContainText('Their second paragraph');
  expect(await page.evaluate(() => window.Alpine.store('chat').docMergePending)).toBe(true);
  expect(await page.evaluate(() => window.Alpine.store('chat').docEditBaseRowVersion)).toBe(8);
  await expect(page.getByText(/Automatic saving is paused until you save this result/)).toBeVisible();
});

test('accept confirms replacement, keeps recoverable draft, and never publishes a version', async ({ page }) => {
  const editor = await prepare(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const accept = page.getByRole('button', { name: 'Accept latest', exact: true });
  await expect(accept).toBeDisabled();
  await page.getByLabel('Replace my unsaved draft with the latest saved version').check();
  await accept.click();
  await expect(editor).toContainText('Their second paragraph');
  await expect(editor).not.toContainText('My First');
  expect(await page.evaluate(() => window.Alpine.store('chat').docEditBaseRowVersion)).toBe(8);
  await page.getByText('Previously replaced drafts on this device', { exact: true }).click();
  await page.getByRole('button', { name: 'Resume preserved draft', exact: true }).click();
  await expect(editor).toContainText('My First paragraph');
  expect(await page.evaluate(() => window.Alpine.store('chat').docEditBaseRowVersion)).toBe(6);
});

test('remote advance during review preserves local edits and refreshes review', async ({ page }) => {
  const editor = await prepare(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.evaluate(() => { const s = window.Alpine.store('chat'); s.__reviewRemote.version = 9; s.__reviewRemote.pg_canonical_version_id = 'review-doc:9'; });
  await page.getByRole('button', { name: 'Merge my changes — edit result', exact: true }).click();
  await expect(editor).toContainText('My First paragraph');
  expect(await page.evaluate(() => window.Alpine.store('chat').docEditBaseRowVersion)).toBe(6);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review document changes' })).toContainText('latest saved v9');
  await expect(page.getByText('Preserved earlier merge preview against v8')).toBeVisible();
});

test('phone layout requires readable overlap choices before applying a merge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = await prepare(page, { overlap: true });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const merge = page.getByRole('button', { name: 'Merge my changes — edit result', exact: true });
  await expect(merge).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Review document changes' })).not.toContainText('editor_state');
  while (await merge.isDisabled()) {
    const unresolved = page.locator('.doc-merge-conflict').filter({ hasNot: page.locator('button[aria-pressed="true"]') });
    if (!await unresolved.count()) break;
    await unresolved.first().getByRole('button', { name: 'Keep my change', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.Alpine.store('chat').docReviewBusy)).toBe(false);
  }
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(editor).toContainText('My Original sentence');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
