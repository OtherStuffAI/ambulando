const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.use({ trace: 'off' });

test('native rich edits checkpoint and retry without a false integrity failure', async ({ page }) => {
  await page.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false, null, { timeout: 20000 });
  await page.evaluate(async () => {
    const store = Alpine.store('chat');
    const content = '# Synthetic live updates\n\nIntro with [specification](https://example.com/spec) and `u` tag.\n\n- Compare \\`search\\` literals.\n- Preserve **bold** and *emphasis*.\n\n```js\nconst url = new URL("https://example.com");\nconsole.log(url.search);\n```\n\n```text\nsecond code block\n```\n\nAfter code.\n\n| Key | Value |\n| --- | --- |\n| route | full URL |\n\n- [x] Done\n- [ ] Pending\n\n[[Synthetic wiki]]\n\n![Synthetic image](https://example.com/image.png)';
    store.session = { ...(store.session || {}), npub: 'npub1synthetic' };
    store.openConnectModal = () => {}; store.showConnectModal = false;
    store.scheduleDocAutosave = () => {};
    store.acquireSelectedDocCheckout = async () => true;
    store.getSelectedDocCheckoutSession = () => ({ checkout: { state: 'checked_out', holder_npub: 'npub1synthetic', lease_expires_at: new Date(Date.now()+60000).toISOString() } });
    store.navSection = 'docs';
    store.documents = [{record_id:'synthetic-integrity',owner_npub:'npub1synthetic',title:'Synthetic integrity',content,content_blocks:[],version:1,sync_status:'synced',record_state:'active',shares:[],group_ids:[],pg_backend:true,pg_record_type:'doc',pg_workspace_id:'synthetic-workspace',pg_channel_id:'synthetic-channel'}];
    store.selectedDocId = 'synthetic-integrity'; store.selectedDocType = 'document';
    store.loadDocEditorFromSelection();
    await store.enterSelectedDocEditMode();
    store.__drafts = [];
    store.persistSelectedDocDraft = async function(options = {}) { const row = options.row || this.buildSelectedDocDraftRow(options); this.__drafts.push(row); return row; };
  });
  const editor = page.locator('.doc-rich-editor .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.locator('p').filter({hasText:'After code.'}).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Native edit');
  const before = await page.evaluate(() => {
    const s = Alpine.store('chat'); const model = s.buildSelectedDocContentModel();
    const plain = n => n.type==='text' ? n.text : n.type==='fdWikiLink' ? n.attrs.title : n.type==='hardBreak' ? '\n' : (n.content||[]).map(plain).join('')+(['paragraph','heading','blockquote','listItem','taskItem'].includes(n.type)?'\n':'');
    return { visibleLength:s.getVisibleDocRichEditorText().replace(/\s+/g,' ').trim().length, modelLength:plain(model.editor_state).replace(/\s+/g,' ').trim().length, model, synchronized:JSON.stringify(s.docEditorContentModel)===JSON.stringify(s.docRichEditorAdapter.getContentModel()), mounts:document.querySelectorAll('.doc-rich-editor .ProseMirror').length };
  });
  console.log(JSON.stringify({visibleLength:before.visibleLength,modelLength:before.modelLength,synchronized:before.synchronized,mounts:before.mounts}));
  expect(before.mounts).toBe(1);
  expect(before.synchronized).toBe(true);
  // This is the old false-positive predicate: block boundaries add whitespace.
  expect(before.visibleLength).toBeGreaterThan(before.modelLength);
  await page.evaluate(async () => {
    const s = Alpine.store('chat'); s.docNeedsHeadCheck = true;
    await s.saveSelectedPgDocItem(s.selectedDocument, 'npub1synthetic');
    await s.saveSelectedPgDocItem(s.selectedDocument, 'npub1synthetic');
  });
  const after = await page.evaluate(() => { const s=Alpine.store('chat'); return {error:s.error,state:s.docAutosaveState,drafts:s.__drafts,model:s.buildSelectedDocContentModel()}; });
  expect(after.error || '').not.toContain('did not match');
  expect(after.state).toBe('device');
  expect(after.model).toEqual(before.model);
  expect(after.drafts.length).toBeGreaterThanOrEqual(2);
  expect(after.drafts.every(d => d.editor_state && !d.integrity_error)).toBe(true);
  await expect(editor).toContainText('Native edit');
  await expect(editor.locator('pre')).toHaveCount(2);
  await expect(editor.locator('table')).toHaveCount(1);
  const recovery = await page.evaluate(async () => {
    const s = Alpine.store('chat');
    const adapter = s.docRichEditorAdapter;
    const original = adapter.getContentModel();
    const getModel = adapter.getContentModel.bind(adapter);
    let stale = true;
    adapter.getContentModel = () => { if (stale) { stale = false; return { ...original, content:'', content_blocks:[], editor_state:{type:'doc',content:[]} }; } return getModel(); };
    await s.saveSelectedPgDocItem(s.selectedDocument, 'npub1synthetic');
    const blocked = {state:s.docAutosaveState,error:s.error,draft:s.__drafts.at(-1)};
    await s.saveSelectedPgDocItem(s.selectedDocument, 'npub1synthetic');
    return {blocked, state:s.docAutosaveState,error:s.error,model:getModel(),original};
  });
  expect(recovery.blocked.state).toBe('error');
  expect(recovery.blocked.error).toContain('did not match');
  expect(recovery.blocked.draft.editor_state).toEqual(recovery.model.editor_state);
  expect(recovery.state).toBe('device');
  expect(recovery.error).toBeNull();
  expect(recovery.model.editor_state).toEqual(recovery.original.editor_state);
  await expect(editor.locator('pre')).toHaveCount(2);
  await expect(editor.locator('table')).toHaveCount(1);
});
