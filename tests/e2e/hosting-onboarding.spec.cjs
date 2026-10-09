const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const evidence = 'tmp/docs/handoffs/nstack-onboarding';
async function capture(page, name) {
  execFileSync('git', ['check-ignore', `${evidence}/${name}.png`]);
  expect(execFileSync('git', ['ls-files', evidence], { encoding: 'utf8' }).trim()).toBe('');
  await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
}
for (const width of [1280, 390, 320]) {
  test(`hosting cards, unchanged BYO and preserved legal-link draft at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
    await page.evaluate(() => {
      const s = window.Alpine.store('chat');
      s.isTowerPgMode = true;
      s.knownHosts = [];
      s.connectStep = 1;
      s.showConnectModal = true;
      s.connectHostBusy = false;
      s.connectManualUrl = '';
      s.connectHostError = '';
      s.connectByo = function () { this.connectHostError = `BYO submitted: ${this.connectManualUrl}`; };
    });
    const hosted = page.locator('.connect-hosted-card');
    const byo = page.locator('.connect-byo-card');
    await expect(hosted).toBeVisible();
    await expect(byo).toBeVisible();
    const h = await hosted.boundingBox(), b = await byo.boundingBox();
    if (width > 700) { expect(h.x).toBeLessThan(b.x); expect(Math.abs(h.y - b.y)).toBeLessThan(2); }
    else { expect(b.y).toBeGreaterThanOrEqual(h.y + h.height); }
    await expect(hosted).toContainText('USD $5 credit');
    await expect(hosted).toContainText('paused if the amount due is unpaid');
    await capture(page, `initial-cards-${width}`);
    const input = byo.locator('input');
    await input.fill('https://my-tower.example');
    const popupPromise = context.waitForEvent('page');
    await hosted.getByRole('link', { name: 'Privacy Policy (draft)' }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy');
    await expect(popup.locator('main')).toContainText('Draft for owner review');
    await expect(popup.locator('main')).toContainText('IndexedDB through Dexie');
    expect(popup.url()).toContain('/legal/privacy.html');
    await popup.close();
    await expect(input).toHaveValue('https://my-tower.example');
    await hosted.getByRole('button', { name: 'Host My Tower' }).click();
    await expect(hosted.getByRole('status')).toContainText('No Tower has been provisioned');
    await expect(input).toHaveValue('https://my-tower.example');
    await byo.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(byo).toContainText('BYO submitted: https://my-tower.example');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, `cards-${width}`);
  });
}
for (const policy of ['privacy', 'terms']) {
  test(`direct public ${policy} page without application login`, async ({ page }) => {
    await page.route('**/*', route => serveBuiltFlightDeck(route));
    await page.goto(`/legal/${policy}.html`);
    await expect(page.locator('h1')).toHaveText(policy === 'terms' ? 'Terms of Hosting' : 'Privacy Policy');
    await expect(page.locator('.legal-draft')).toContainText('Draft for owner review');
    expect(await page.evaluate(() => Boolean(window.Alpine))).toBe(false);
    await page.getByRole('link', { name: policy === 'terms' ? 'Privacy Policy (draft)' : 'Terms (draft)' }).click();
    await expect(page.locator('h1')).toHaveText(policy === 'terms' ? 'Privacy Policy' : 'Terms of Hosting');
    await capture(page, `legal-from-${policy}`);
  });
}
