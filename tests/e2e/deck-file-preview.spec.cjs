const { test, expect } = require('playwright/test');
const { build } = require('esbuild');
const path = require('node:path');
const { verifyEvent } = require('nostr-tools');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64');

for (const width of [390, 1280]) {
  test(`Deck attachments preview and save with signed storage at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const auth = await build({ stdin: { contents: "import { signLoginEvent } from './src/auth/nostr.js'; window.seedPreviewAuth = () => signLoginEvent('ephemeral');", resolveDir: path.resolve(__dirname, '../..') }, bundle: true, write: false, format: 'iife', logLevel: 'silent' });
    const requests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v4/storage/')) {
        const header = route.request().headers().authorization || '';
        const event = JSON.parse(Buffer.from(header.replace(/^Nostr /, ''), 'base64').toString());
        expect(verifyEvent(event)).toBe(true);
        expect(event.tags).toContainEqual(['u', url.href]);
        expect(event.tags).toContainEqual(['method', 'GET']);
        requests.push(url.pathname);
        if (url.pathname.includes('denied')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Storage denied"}' });
        return route.fulfill({ contentType: url.pathname.includes('image') ? 'image/png' : 'application/pdf', body: url.pathname.includes('image') ? PNG : Buffer.from('%PDF-1.4\nfixture') });
      }
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store('chat'));
    await page.addScriptTag({ content: auth.outputFiles[0].text });
    await page.evaluate(async () => {
      await window.seedPreviewAuth();
      const store = window.Alpine.store('chat');
      store.session = { npub: 'npub1previewfixture' };
      store.backendUrl = location.origin;
      store.navSection = 'status';
      store.deckInboxEnabled = true;
      const rows = [
        { object_id: 'image', name: 'bird.png', kind: 'image' },
        { object_id: 'pdf', name: 'report.pdf', kind: 'document' },
        { object_id: 'denied', name: 'denied.pdf', kind: 'file' },
      ].map(row => ({ ...row, inboxKind: 'file', source_type: 'document', source_record_id: 'parent-doc', sourceTypeLabel: 'Document attachment' }));
      Object.defineProperty(store, 'visibleAutopilotOverviewInbox', { get: () => rows });
      store.openDoc = () => { throw new Error('Attachment incorrectly opened an internal document'); };
    });
    const imageCard = page.getByRole('button', { name: 'Preview bird.png', exact: true });
    await imageCard.click();
    const dialog = page.getByRole('dialog', { name: 'bird.png', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toBeVisible();
    await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 1);
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save locally', exact: true }).click();
    expect((await downloadPromise).suggestedFilename()).toBe('bird.png');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(imageCard).toBeFocused();
    await page.getByRole('button', { name: 'Preview report.pdf', exact: true }).click();
    const file = page.getByRole('dialog', { name: 'report.pdf', exact: true });
    await expect(file.getByText('This file is ready to save locally.')).toBeVisible();
    const pdfDownload = page.waitForEvent('download');
    await file.getByRole('button', { name: 'Save locally', exact: true }).click();
    expect((await pdfDownload).suggestedFilename()).toBe('report.pdf');
    await file.getByRole('button', { name: 'Close image preview' }).click();
    await page.getByRole('button', { name: 'Preview denied.pdf', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'denied.pdf' }).getByRole('alert')).toContainText('403');
    await page.keyboard.press('Escape');
    expect(requests).toEqual(['/api/v4/storage/image/content', '/api/v4/storage/pdf/content', '/api/v4/storage/denied/content']);
  });
}
