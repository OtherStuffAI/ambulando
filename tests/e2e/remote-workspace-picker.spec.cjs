const { test, expect } = require('playwright/test');

test('PG picker shows and selects every workspace under the same owner', async ({ page }) => {
  await page.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(hostname)) return route.continue();
    return route.abort();
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.session = { npub: 'npub1user' };
    store.connectStep = 2;
    store.connectPgOnboardingStep = 2;
    store.showConnectModal = true;
    store.connectWorkspacesBusy = false;
    store.connectWorkspaces = [1, 2, 3, 4].map((number) => ({
      workspaceId: `workspace-${number}`,
      workspaceOwnerNpub: 'npub1sameowner',
      name: `Workspace ${number}`,
      description: `Description ${number}`,
      pgBackendMode: true,
    }));
    store.connectWorkspaceRequestDiagnostics = {
      attempts: [{ method: 'GET', url: 'https://tower.example/api/v4/flightdeck-pg/workspaces',
        appNpubSent: true, appNpub: 'npub1app', signerNpub: 'npub1user',
        transportMode: 'https', httpStatus: 200, responseShape: { workspacesCount: 4 } }],
      responseWorkspaceCount: 4, mappedWorkspaceCount: 4, visibleWorkspaceCount: null,
    };
    window.__selectedWorkspaceIds = [];
    store.connectSelectPgWorkspace = (workspace) => window.__selectedWorkspaceIds.push(workspace.workspaceId);
  });

  const rows = page.getByTestId('connect-pg-workspace-row');
  await expect(rows).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(rows.nth(index)).toBeVisible();
    await expect(rows.nth(index)).toContainText(`Workspace ${index + 1}`);
    await rows.nth(index).click();
  }
  expect(await page.evaluate(() => window.__selectedWorkspaceIds)).toEqual([
    'workspace-1', 'workspace-2', 'workspace-3', 'workspace-4',
  ]);

  await page.evaluate(() => window.Alpine.store('chat').updateConnectWorkspaceVisibleRowCount());
  await expect(page.locator('.connect-workspace-diagnostics')).toContainText('4 returned');
  await expect(page.locator('.connect-workspace-diagnostics')).toContainText('fetched 4; mapped 4; visible rows 4');
});
