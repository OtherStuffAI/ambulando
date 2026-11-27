const { test, expect } = require('playwright/test');

for (const width of [390, 1440]) {
  test(`detached draft has explicit recovery controls and holds interaction at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.showConnectModal = false; store.openConnectModal = () => {};
      store.showWorkspaceBootstrapModal = false;
      store.scheduleStorageImageHydration = () => {};
      store.session = { ...(store.session || {}), npub: 'npub1helddocuitest' };
      store.navSection = 'docs';
      const doc = { record_id: 'held-doc-ui', title: 'Detached draft', content: 'Preserved local work',
        content_blocks: [{ id: 'block', type: 'markdown', raw: 'Preserved local work', text: 'Preserved local work', attrs: {} }],
        record_state: 'active', sync_status: 'synced', version: 1, shares: [], group_ids: [] };
      store.documents = [doc]; store.directories = [];
      store.selectedDocId = doc.record_id; store.selectedDocType = 'document';
      store.loadDocEditorFromSelection();
      store.docPublicationHold = { generation: 'reviewed-ui-generation' };
      // UI-only synthetic fixture: database/transport behavior is tested against
      // the real delta consumer and IndexedDB in the integration suite.
      store.saveDetachedDocReviewed = () => new Promise(resolve => { window.__finishHeldSave = resolve; });
    });
    const banner = page.locator('.doc-edit-access-banner').filter({ hasText: 'Removed from a thread. Your draft stays' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('including when you reopen Docs');
    await expect(banner.getByRole('button', { name: 'Discard detached local draft' })).toBeVisible();
    await banner.getByRole('button', { name: 'Save reviewed draft to source', exact: true }).click();
    await expect(page.locator('.docs-editor-v3')).toHaveAttribute('inert');
    await page.evaluate(() => window.__finishHeldSave(null));
    await expect(page.locator('.docs-editor-v3')).not.toHaveAttribute('inert');
    await expect(banner).toBeVisible();
  });
}
