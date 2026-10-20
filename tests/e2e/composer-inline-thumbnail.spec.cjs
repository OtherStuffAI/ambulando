const { test, expect } = require('playwright/test');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [390, 1440]) {
  for (const mode of ['reply', 'new thread']) {
    test(`compact attachment previews stay in the ${mode} shortcuts row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await openFixture(page);
      await page.evaluate((newThread) => {
        const store = Alpine.store('chat');
        store.deckThreadComposerOpen = newThread;
        store.getRecentMentionChips = () => [{
          id: 'agent-1',
          type: 'agent',
          label: 'Helper',
          avatarUrl: '',
        }];
        const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="60" height="40"%3E%3Crect width="60" height="40" fill="navy"/%3E%3C/svg%3E';
        store.threadFileDrafts = [
          { draft_id: 'first', kind: 'image', filename: 'first.png', preview_url: image, status: 'uploading' },
          { draft_id: 'second', kind: 'image', filename: 'second.png', preview_url: image, status: 'error' },
          { draft_id: 'third', kind: 'image', filename: 'third.png', preview_url: image, status: 'ready' },
        ];
        store.uploadChatFileDraft = (draftId, context) => {
          window.inlineRetry = { draftId, context };
          store.threadFileDrafts = store.threadFileDrafts.map((draft) => (
            draft.draft_id === draftId ? { ...draft, status: 'ready' } : draft
          ));
        };
      }, mode === 'new thread');

      const row = page.locator('.composer-shortcuts-row:visible');
      await expect(row).toBeVisible();
      await expect(row.getByRole('button', { name: 'Mention Helper', exact: true })).toBeVisible();
      const previews = row.locator('.chat-image-draft-inline');
      await expect(previews).toHaveCount(3);
      await expect(previews.locator('.chat-image-draft-status')).toHaveText(['Uploading…', 'Upload failed', 'Ready']);
      expect(await previews.evaluateAll((nodes) => nodes.map((node) => node.querySelector('img').getAttribute('alt')))).toEqual(['', '', '']);
      const geometry = await previews.evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const button = node.querySelector('button').getBoundingClientRect();
        return { width: box.width, height: box.height, buttonWidth: button.width, buttonHeight: button.height };
      }));
      for (const item of geometry) {
        expect(item.width).toBeLessThanOrEqual(44);
        expect(item.height).toBeLessThanOrEqual(44);
        expect(item.buttonWidth).toBeGreaterThanOrEqual(44);
        expect(item.buttonHeight).toBeGreaterThanOrEqual(44);
      }
      expect(await row.evaluate((node) => node.scrollWidth >= node.clientWidth)).toBe(true);
      await expect(page.locator('.thread-composer-region > .chat-image-draft-list')).toHaveCount(0);
      await expect(page.locator('.chat-image-draft-remove')).toHaveCount(0);

      const failed = row.getByRole('button', { name: 'Open second.png preview, upload failed', exact: true });
      await failed.focus();
      await failed.press('Enter');
      const modal = page.getByRole('dialog', { name: 'second.png', exact: true });
      await expect(modal).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close image preview', exact: true })).toBeFocused();
      await expect(modal).toContainText('Upload failed');
      await modal.getByRole('button', { name: 'Retry upload', exact: true }).click();
      expect(await page.evaluate(() => window.inlineRetry)).toEqual({ draftId: 'second', context: 'thread' });
      await expect(modal).toContainText('Ready to send');
      await modal.getByRole('button', { name: 'Remove attachment', exact: true }).click();
      await expect(modal).toBeHidden();
      await expect(page.locator('[data-chat-composer="thread"]')).toBeFocused();
      await expect(previews).toHaveCount(2);
      await expect(row.getByRole('button', { name: /Open first\.png preview/ })).toBeVisible();
      await expect(row.getByRole('button', { name: /Open third\.png preview/ })).toBeVisible();
    });
  }
}
