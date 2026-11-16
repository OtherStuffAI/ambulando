const { test, expect } = require('playwright/test');

test('signed QR preview, explicit transport and missing-native rejection preserve selection', async ({ page }) => {
  const { finalizeEvent, nip19, getPublicKey } = await import('nostr-tools');
  const key = new Uint8Array(32).fill(1);
  const service = nip19.npubEncode(getPublicKey(key));
  const payload = { type: 'nstack-workspace', version: 3, service_npub: service, workspace_id: '11111111-2222-3333-4444-555555555555', workspace_service_npub: service, name: 'QR test workspace',
    transports: { https: { url: 'https://tower.example' }, fips: { peer_npub: service, host: `${service}.fips`, port: 4443 } }, policy: { preferred: 'fips', fallback: 'none' } };
  const envelope = 'nstack:workspace:v3:' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 30383, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'nstack-workspace-connection-v3']], content: JSON.stringify(payload) }, key))).toString('base64url');
  const writes = [];
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.session = { npub: 'synthetic-signer' };
    s.showAuthModal = false; s.showConnectModal = true; s.connectStep = 1;
  });
  await page.getByText('Add an existing NStack', { exact: true }).click();
  await page.locator('input[x-model="$store.chat.connectManualUrl"]').fill(envelope);
  await page.locator('.connect-manual-form button[type="submit"]').click();
  await expect(page.getByText('QR test workspace', { exact: true })).toBeVisible();
  await expect(page.getByText(payload.workspace_id, { exact: true })).toBeVisible();
  const select = page.locator('select[x-model="$store.chat.connectWorkspacePreview.mode"]');
  await expect(select).toHaveValue('fips');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.locator('.connect-workspace-qr-preview').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await select.selectOption('https'); await expect(select).toHaveValue('https');
  await select.selectOption('fips');
  const before = await page.evaluate(() => window.Alpine.store('chat').selectedWorkspaceKey);
  await page.getByRole('button', { name: 'Confirm and verify workspace', exact: true }).click();
  await expect(page.locator('.connect-byo-card .auth-error')).toContainText('FIPS requires');
  expect(await page.evaluate(() => window.Alpine.store('chat').selectedWorkspaceKey)).toBe(before);
  expect(writes).toEqual([]);
});
