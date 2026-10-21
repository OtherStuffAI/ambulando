const { test, expect } = require('playwright/test');
const { nip19 } = require('nostr-tools');

test('Setup viewer persists and changes cached Nostr links immediately', async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine?.store('chat'));
  await page.evaluate(() => {
    const store = Alpine.store('chat');
    store.showConnectModal = false; store.showWorkspaceBootstrapModal = false; store.session = { npub: 'npub1viewerfixture' }; store.navSection = 'settings'; store.settingsTab = 'deck';
    window.__viewerOpened = []; window.open = (...args) => window.__viewerOpened.push(args);
  });
  const input = page.locator('#nostr-viewer-base-url');
  await expect(input).toBeVisible();
  await input.fill('https://viewer.example/event///');
  await page.getByRole('button', { name: 'Save Nostr viewer', exact: true }).click();
  await expect(input).toHaveValue('https://viewer.example/event/');
  const id = nip19.neventEncode({ id: 'cd'.repeat(32), author: 'ab'.repeat(32), kind: 1 });
  await page.evaluate(id => {
    const store = Alpine.store('chat');
    window.__cachedNostrItem = { url: `https://njump.me/${id}` };
    store.openFeedItem(window.__cachedNostrItem);
    store.openFeedItem({ url: 'https://example.com/article' });
  }, id);
  expect(await page.evaluate(() => window.__viewerOpened)).toEqual([
    [`https://viewer.example/event/${id}`, '_blank', 'noopener,noreferrer'],
    ['https://example.com/article', '_blank', 'noopener,noreferrer'],
  ]);
  await input.fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Save Nostr viewer', exact: true }).click();
  await expect(page.locator('#nostr-viewer-error')).toBeVisible();
  expect(await page.evaluate(() => Alpine.store('chat').nostrViewerBaseUrl)).toBe('https://viewer.example/event/');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.Alpine?.store('chat'));
  expect(await page.evaluate(() => Alpine.store('chat').nostrViewerBaseUrl)).toBe('https://viewer.example/event/');
  await page.evaluate(() => { const store = Alpine.store('chat'); store.showConnectModal = false; store.showWorkspaceBootstrapModal = false; store.session = { npub: 'npub1viewerfixture' }; store.navSection = 'settings'; store.settingsTab = 'deck'; });
  await page.getByRole('button', { name: 'Reset to njump', exact: true }).click();
  await expect(input).toHaveValue('https://njump.me/');
  await input.fill(''); await page.getByRole('button', { name: 'Save Nostr viewer', exact: true }).click();
  await expect(input).toHaveValue('https://njump.me/');
});
