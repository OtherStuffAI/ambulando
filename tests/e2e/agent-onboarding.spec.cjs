const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const { onboardingBoundary } = require('./fixtures/agent-onboarding-boundary.cjs');
test.use({ serviceWorkers: 'block' });
test.setTimeout(60000);
const ORIGIN = 'https://127.0.0.1:41031';
async function capture(page, filename) {
  const file = `tmp/docs/handoffs/stripe-onboarding/${filename}`;
  execFileSync('git', ['check-ignore', file]);
  expect(execFileSync('git', ['ls-files', file], { encoding: 'utf8' }).trim()).toBe('');
  await fs.mkdir('tmp/docs/handoffs/stripe-onboarding', { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
}

for (const width of [1280, 390]) {
  test(`new web user resumes one workspace and paid setup at ${width}px (controlled services)`, async ({ page, context }) => {
    const boundary = await onboardingBoundary(ORIGIN);
    await page.setViewportSize({ width, height: 1000 });
    await page.exposeFunction('onboardingCommandBoundary', name => boundary.command(name));
    await context.route('**/*', async route => {
      const handled = await boundary.route(route); if (handled !== null) return;
      return serveBuiltFlightDeck(route);
    });
    try {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
      await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
      const panel = page.locator('.new-user-onboarding');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Create my workspace' })).toBeDisabled();
      await panel.getByLabel('Workspace name', { exact: true }).fill('Test home');
      await panel.getByLabel('Agent name', { exact: true }).fill('Scout');
      await panel.getByLabel('I have saved my recovery file securely.').check();
      await panel.getByLabel('I accept the').check();
      await capture(page, `signup-${width}.png`);
      await panel.getByRole('button', { name: 'Create my workspace' }).click();
      await expect(panel.locator('.new-user-offer')).toContainText('AUD');
      await expect(panel.locator('.new-user-offer')).toContainText('21.00');
      await expect(panel).toContainText('One-time payment');
      await capture(page, `offer-${width}.png`);
      const originalOwner = boundary.order().owner, originalOrderId = boundary.order().id;
      expect(boundary.calls.filter(x => x === 'workspace')).toHaveLength(1);
      await panel.getByRole('button', { name: 'Continue to Stripe Checkout' }).click();
      await expect(page).toHaveURL(/https:\/\/checkout.stripe.com/);
      expect(boundary.calls.filter(x => x === 'checkout')).toHaveLength(1);
      // Return/cancel and reload exercise real client status reads; neither is a payment verdict.
      await page.goto(`${ORIGIN}/?agent_order=${boundary.order().id}&checkout=cancelled`);
      await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('One-time payment');
      expect(await page.evaluate(() => window.Alpine.store('chat').session.npub)).toBe(originalOwner);
      expect(boundary.order().id).toBe(originalOrderId);
      expect(boundary.calls.filter(x => x === 'workspace')).toHaveLength(1);
      await panel.getByRole('button', { name: 'Continue to Stripe Checkout' }).click();
      await expect(page).toHaveURL(/checkout.stripe.com/);
      expect(boundary.calls.filter(x => x === 'checkout')).toHaveLength(1);
      await boundary.paid(); boundary.setCloudDown(true);
      await page.goto(`${ORIGIN}/?agent_order=return`);
      await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Check payment', exact: true }).click();
      await expect(panel).toContainText('Payment confirmed.');
      await expect(panel.getByRole('button', { name: 'Retry setup — no new payment' })).toBeVisible();
      boundary.setCloudDown(false);
      await panel.getByRole('button', { name: 'Retry setup — no new payment' }).click();
      await expect(panel.getByRole('button', { name: 'Connect my agent and open workspace' })).toBeVisible();
      await page.evaluate(({ dmId, workspaceId }) => {
        const s = window.Alpine.store('chat');
        // Explicit Tower transport boundaries: the actual onboarding orchestrator,
        // typed command intents, policy signatures and server proof checks still run.
        s.connectWithPgDescriptor = async () => ({ pgWorkspaceId: workspaceId });
        s.commandTowerWorkspace = (name) => window.onboardingCommandBoundary(name);
        s.refreshTowerPgWorkspaceMembers = async () => [];
        s.ensureTowerPgDmChannel = async () => ({ record_id: dmId });
        s.getTowerSyncService = () => ({ ensureLoaded: async () => ({}) });
      }, { dmId: boundary.dmId, workspaceId: boundary.workspaceId });
      await panel.getByRole('button', { name: 'Connect my agent and open workspace' }).click();
      await expect(panel).toBeHidden();
      expect(boundary.calls).toContain('workspace-member.create');
      expect(boundary.calls).toContain('general.ensure');
      expect(boundary.calls).toContain('connection');
      expect(boundary.calls.filter(x => x === 'checkout')).toHaveLength(1);
      expect(boundary.order().ready).toBe(true);

      const order = boundary.store.pending(); expect(order).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { boundary.store.close(); }
  });
}

test('existing workspace users retain access and alternate-server choice', async ({ page, context }) => {
  await context.route('**/*', route => serveBuiltFlightDeck(route));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
  const result = await page.evaluate(async () => {
    const s = window.Alpine.store('chat');
    s.session = { npub: 'existing-user' }; s.knownWorkspaces = [{ workspaceKey: 'existing' }];
    return s.resumeNewUserOnboarding();
  });
  expect(result).toBe(false);
  await expect(page.locator('.new-user-onboarding')).toBeHidden();
});
