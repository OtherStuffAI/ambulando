const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { openFixture } = require('./fixtures/mobile-chat.cjs');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
let bundle;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
  bundle = (await build({ bundle: true, write: false, format: 'esm', logLevel: 'silent',
    define: { __FLIGHT_DECK_PG_APP_NPUB__: JSON.stringify('npub1test') },
    stdin: { resolveDir: path.resolve(__dirname, '../..'), contents: `
      export { openWorkspaceDb } from './src/db.js';
      export { storeCredentials } from './src/auth/secure-store.js';
      export { setMemorySecret } from './src/auth/nostr.js';
      export { generateSecretKey, getPublicKey } from 'nostr-tools';
      export { textAttachmentViewerMixin } from './src/text-attachment-viewer.js';
      export { persistTextDraft, restorePersistedTextDrafts, discardPersistedTextDrafts } from './src/text-attachment-drafts.js';` },
  })).outputFiles[0].text;
});
async function setup(page) {
  await openFixture(page, true);
  await page.evaluate(async () => {
    const m = await import('/__text-fixture.js');
    const db = m.openWorkspaceDb('text-attachment-browser'); await db.open();
    const s = Alpine.store('chat');
    Object.defineProperties(s, Object.getOwnPropertyDescriptors(m.textAttachmentViewerMixin));
    s.persistTextAttachmentDraft = (context, draft) => m.persistTextDraft(s, context, draft);
    s.discardTextAttachmentDraftRows = drafts => m.discardPersistedTextDrafts(drafts);
    s.uploadChatFileDraft = () => {}; // Deliberately offline; no backend write is made.
    s.restoreTextFixture = () => m.restorePersistedTextDrafts(s, 'thread');
  });
}
test('real modal keeps exact offline drafts, bounds a 3.94MB paste, and restores after reload', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).pathname === '/__text-fixture.js'
    ? route.fulfill({ contentType: 'text/javascript', body: bundle }) : serveBuiltFlightDeck(route));
  await setup(page);
  const composer = page.locator('.thread-input-bar [data-chat-composer="thread"]');
  await composer.fill('keep');
  await composer.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'é😀\r\n' + 'x'.repeat(2600));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(composer).toHaveText('keep');
  const card = page.locator('.chat-thread-panel .chat-file-draft');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Text content', exact: true });
  await expect(editor).toBeVisible();
  await page.getByRole('textbox', { name: 'File name', exact: true }).fill('offline notes');
  await editor.fill('changed\nexact');
  await page.locator('.text-attachment-modal').getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(editor).toHaveValue('é😀\n' + 'x'.repeat(2600));
  await editor.evaluate(el => {
    el.setSelectionRange(0, el.value.length);
    const data = new DataTransfer(); data.setData('text/plain', 'log entry\r\n'.repeat(358400));
    const start = performance.now();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    window.textPasteDuration = performance.now() - start;
  });
  expect(await editor.evaluate(el => el.value.length)).toBeLessThanOrEqual(16000);
  const pasteMs = await page.evaluate(() => window.textPasteDuration);
  await page.getByRole('textbox', { name: 'File name', exact: true }).fill('offline notes');
  await page.locator('.text-attachment-modal').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(card).toContainText('offline notes.txt');
  await page.reload(); await setup(page);
  await page.evaluate(() => Alpine.store('chat').restoreTextFixture());
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(editor).toBeVisible();
  const result = await page.evaluate(() => {
    const modal = Alpine.store('chat').textAttachmentModal;
    return { bytes: modal.totals.bytes, pages: modal.pages.length, exact: modal.pages.join('') === 'log entry\r\n'.repeat(358400) };
  });
  expect(result.exact).toBe(true); expect(result.bytes).toBe(3942400); expect(result.pages).toBeGreaterThan(200);
  await page.screenshot({ path: test.info().outputPath('text-editor-large-offline.png') });
  const closeStarted = Date.now();
  await page.getByRole('button', { name: 'Close text attachment', exact: true }).click({ timeout: 1000 });
  await expect(editor).toBeHidden();
  console.log(JSON.stringify({ scenario: 'text-attachment-offline-large', pasteMs, closeMs: Date.now() - closeStarted, ...result }));
});

test('sent modal shows history and retains a conflict before explicit save-on-top', async ({ page }) => {
  let latest = 'v1'; let postCount = 0;
  const lineage = () => ({ id: 'file', current_version_id: latest, display_name: 'Sent.txt', row_version: 1,
    metadata: { text_attachment_lineage: { origin_message_id: 'message', origin_storage_object_id: 'original' } } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__text-fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname.startsWith('/api/v4/flightdeck-pg/')) {
      let body;
      if (url.pathname.endsWith('/channels/channel/files')) body = { files: [lineage()] };
      else if (/\/versions\/[^/]+\/object$/.test(url.pathname)) return route.fulfill({ contentType: 'text/plain', body: url.pathname.includes('/v2/') ? 'their newer edit' : 'first edit' });
      else if (url.pathname.endsWith('/versions') && route.request().method() === 'GET') body = { versions: Array.from({ length: Number(latest.slice(1)) }, (_, i) => ({ id: `v${i + 1}`, version_number: i + 1 })) };
      else if (url.pathname.endsWith('/versions')) {
        postCount += 1;
        if (postCount === 1) {
          latest = 'v2';
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'stale_base_version', error: 'A newer version exists', file: lineage(), current_version: { id: 'v2' } }) });
        }
        latest = 'v3'; body = { file: lineage(), version: { id: 'v3', version_number: 3 } };
      }
      if (body) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    return serveBuiltFlightDeck(route);
  });
  await setup(page);
  await page.evaluate(async () => {
    const m = await import('/__text-fixture.js'); const secret = m.generateSecretKey();
    await m.storeCredentials({ method: 'ephemeral', pubkey: m.getPublicKey(secret) }); m.setMemorySecret(secret);
    const s = Alpine.store('chat');
    s.captureStorageUploadContext = () => ({ workspaceId: 'workspace', options: { baseUrl: location.origin }, assertCurrent() {} });
    s.uploadTextAttachmentBytes = async () => ({ objectId: 'edited-object', sha256: 'synthetic' });
    await s.openSentTextAttachment({ record_id: 'message', channel_id: 'channel' }, { storage_object_id: 'original', filename: 'Sent.txt', kind: 'file', content_type: 'text/plain' });
  });
  const modal = page.locator('.text-attachment-modal');
  const editor = page.getByRole('textbox', { name: 'Text content', exact: true });
  await expect(editor).toHaveValue('first edit');
  await expect(page.getByRole('combobox', { name: 'Version', exact: true })).toContainText('Original (sent)');
  await modal.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('my retained edit');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).toContainText('Someone saved a newer version first');
  await expect(editor).toHaveValue('my retained edit');
  await page.screenshot({ path: test.info().outputPath('text-editor-version-conflict.png') });
  await modal.getByRole('button', { name: 'Save mine on top', exact: true }).click();
  await expect(modal).toContainText('Saved as new version');
  await expect(page.getByRole('combobox', { name: 'Version', exact: true })).toContainText('Version 3 (latest)');
  expect(postCount).toBe(2);
});
