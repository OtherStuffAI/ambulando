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
    expect(b.y).toBeGreaterThanOrEqual(h.y + h.height);
    expect(Math.abs(h.width - b.width)).toBeLessThan(2);
    await expect(hosted).toContainText('USD $5 credit');
    await expect(hosted).toContainText('paused if the amount due is unpaid');
    await capture(page, `initial-cards-${width}`);
    const input = byo.locator('input');
    const summary = byo.locator('summary');
    await expect(input).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(summary).toBeFocused();
    await expect(input).toBeVisible();
    await input.fill('https://my-tower.example');
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(input).toBeHidden();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('https://my-tower.example');
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
    await expect(hosted.getByRole('status')).toContainText('Sign in with your Nostr identity');
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

test('ready hosting opens name and draft terms, gates acceptance and shows a recoverable signup error', async ({ page, context }) => {
  await context.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/api/hosted/config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ signup_ready: true, tower_public_base_url: 'https://tower.example/' }) });
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
  await page.evaluate(() => {
    const s = window.Alpine.store('chat');
    s.isTowerPgMode = true;
    s.session = { npub: 'synthetic-browser-user' };
    s.openConnectModal();
    // Isolate browser UI from remote Tower transport; this is not a provisioning test.
    s.connectToPgHost = async function (url, label, config) {
      this.connectHostedConfig = config;
      this.connectHostUrl = url;
      this.connectHostLabel = label;
      this.connectStep = 2;
      this.connectPgOnboardingStep = 2;
      this.connectWorkspaces = [];
    };
    s.connectCreateWorkspace = async function () {
      this.connectHostedIntent = { workspaceName: this.connectNewWorkspaceName };
      this.connectWorkspacesError = 'The hosting site is not authorized by Tower. Retry later or contact support.';
    };
  });
  await page.locator('.connect-hosted-card').getByRole('button', { name: 'Host My Tower' }).click();
  const modal = page.locator('.connect-modal');
  await expect(modal.getByRole('heading', { name: 'Choose or create a workspace' })).toBeVisible();
  await expect(modal.locator('.connect-hosted-policy')).toContainText('shared across workspaces');
  await modal.locator('input[x-model="$store.chat.connectNewWorkspaceName"]').first().fill('Activation browser fixture');
  const create = modal.getByRole('button', { name: 'Create workspace', exact: true }).first();
  await expect(create).toBeDisabled();
  await modal.locator('input[x-model="$store.chat.connectHostedTermsAccepted"]').check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(modal).toContainText('hosting site is not authorized');
  await expect(modal.getByRole('button', { name: 'Retry signup' })).toBeVisible();
  expect(await page.evaluate(() => window.Alpine.store('chat').showConnectModal)).toBe(true);
  await capture(page, 'ready-hosted-terms-error');
});
