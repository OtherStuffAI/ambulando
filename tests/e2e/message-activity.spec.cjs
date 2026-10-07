const { test, expect } = require('playwright/test');

// Synthetic local-Tower contract fixtures. This exercises the real service,
// hydrator, Dexie/liveQuery, modal and sandbox; it is not authenticated live smoke.
async function setup(page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, body: '{}' });
    return route.continue();
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.Alpine?.store('chat'));
  await page.evaluate(async () => {
    const { openWorkspaceDb } = await import('/src/db.js');
    const { hydrateMessageActivity } = await import('/src/message-activity/hydrate.js');
    const { TowerSyncService } = await import('/src/tower-sync-service.js');
    const store = window.Alpine.store('chat');
    store.showConnectModal = false; store.showWorkspaceBootstrapModal = false;
    store.startWorkspaceLiveQueries = () => {}; store.syncRoute = () => {};
    store.session = { npub: 'synthetic-reader' }; store.backendUrl = 'http://127.0.0.1:3100';
    store.workspaceDbKey = 'synthetic-activity'; store.selectedWorkspaceKey = 'synthetic-activity';
    store.knownWorkspaces = [{ workspaceKey: 'synthetic-activity', workspaceId: 'workspace', workspaceOwnerNpub: 'owner', towerServiceNpub: 'tower', workspaceServiceNpub: 'service', appNpub: 'app', directHttpsUrl: 'http://127.0.0.1:3100' }];
    store.selectedBoardId = '__all__'; store.navSection = 'status';
    const db = openWorkspaceDb('synthetic-activity'); await db.open();
    await db.channels.bulkPut([{ record_id: 'a', title: 'General <script>literal</script>', owner_npub: 'owner', scope_id: 's' }, { record_id: 'empty', title: 'Empty', owner_npub: 'owner', scope_id: 's' }, { record_id: 'denied', title: 'Secret channel', owner_npub: 'owner' }]);
    await db.scopes.put({ record_id: 's', owner_npub: 'owner', title: 'Delivery' });
    window.activityFixture = { calls: [], mode: 'ready', pending: [], db };
    const read = async (_workspace, range, options) => {
      const f = window.activityFixture; f.calls.push({ range, signal: options.signal });
      if (f.mode === 'delayed') await new Promise(resolve => f.pending.push(resolve));
      if (f.mode === 'denied') throw Object.assign(new Error('denied'), { status: 403 });
      const as_of = '2026-10-07T12:00:00.000Z';
      return { identity: { workspace_id: 'workspace', workspace_owner_npub: 'owner', tower_service_npub: 'tower', workspace_service_npub: 'service', app_npub: 'app' },
        workspace_id: 'workspace', range, from: range === 'all' ? null : new Date(Date.parse(as_of) - (range === '7d' ? 7 : 30) * 86400000).toISOString(), as_of, to: as_of, complete: true,
        channels: f.mode === 'empty' ? [] : [{ channel_id: 'a', scope_id: 's', count: range === '7d' ? 3 : 8 }, { channel_id: 'empty', scope_id: 's', count: 0 }] };
    };
    const service = new TowerSyncService({ workspaceKey: 'synthetic-activity', families: { 'message-activity': { load: (_id, options) => hydrateMessageActivity(store, options.range, options, { read }) } } });
    store._towerSyncService = service; store.getTowerSyncService = () => service;
  });
  await expect(page.getByTestId('message-activity-launch')).toBeVisible();
}
const frame = page => page.frameLocator('#message-activity-modal iframe');

test('immediate reopening ignores the old dialog close event and retains focus containment', async ({ page }) => {
  await setup(page); await page.getByTestId('message-activity-launch').click();
  await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
  await page.evaluate(() => window.Alpine.store('chat').openMessageActivity());
  await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Message activity', exact: true }).focus();
  for (let n = 0; n < 5; n++) {
    await page.keyboard.press('Tab');
    // Chromium may include browser chrome in the Tab cycle (reported as body).
    // Background application controls must remain inert throughout.
    expect(await page.evaluate(() => {
      const active = document.activeElement;
      const contained = active === document.body || document.getElementById('message-activity-modal').contains(active);
      document.querySelector('[data-testid="message-activity-launch"]').focus();
      return contained && document.activeElement !== document.querySelector('[data-testid="message-activity-launch"]');
    })).toBe(true);
  }
  await page.getByRole('button', { name: 'Close Message activity', exact: true }).click();
  await expect(page.getByTestId('message-activity-launch')).toBeFocused();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Toolbox launches a real sandboxed dashboard, ranges, refresh and keyboard closure at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await setup(page);
    const launch = page.getByTestId('message-activity-launch'); await launch.click();
    await expect(page.getByRole('dialog', { name: 'Message activity', exact: true })).toBeVisible();
    await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    await expect(frame(page).getByText('General <script>literal</script>', { exact: true })).toBeVisible();
    await expect(frame(page).getByText('Secret channel')).toHaveCount(0);
    await expect(page.locator('#message-activity-modal iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame(page).getByRole('cell', { name: '0', exact: true })).toBeVisible();
    await frame(page).getByLabel('Time range').selectOption('30d');
    await expect(frame(page).getByRole('heading', { name: '8 messages', exact: true })).toBeVisible();
    await frame(page).getByLabel('Time range').selectOption('all');
    await expect(frame(page).getByText(/All time →/)).toBeVisible();
    await page.evaluate(async () => { await window.activityFixture.db.channels.update('a', { title: 'Renamed from Dexie' }); });
    await expect(frame(page).getByRole('cell', { name: 'Renamed from Dexie' })).toBeVisible();
    const bounds = await page.locator('#message-activity-modal').boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(viewport.width); expect(bounds.height).toBeLessThanOrEqual(viewport.height);
    const overflow = await frame(page).locator('body').evaluate(el => el.scrollWidth > innerWidth); expect(overflow).toBe(false);
    await page.screenshot({ path: `tmp/docs/handoffs/message-dashboard-${viewport.width}.png` });
    expect(await frame(page).locator('body').evaluate(() => { try { return !!parent.document.body; } catch { return false; } })).toBe(false);
    await frame(page).getByRole('button', { name: 'Refresh', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('message-activity-modal')).not.toBeVisible();
    await expect(launch).toBeFocused();
    await expect(page.locator('#message-activity-modal iframe')).toHaveAttribute('src', 'about:blank');
  });
}

test('hostile requests, denied/empty responses, close and scope/workspace/identity invalidation clear stale counts', async ({ page }) => {
  await setup(page); await page.getByTestId('message-activity-launch').click();
  await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
  await frame(page).locator('body').evaluate(() => {
    const base = { version: 1, session: location.hash.slice(1) };
    parent.postMessage({ ...base, type: 'refresh', workspace_id: 'other' }, '*');
    parent.postMessage({ ...base, type: 'range', range: '999d' }, '*');
    parent.postMessage({ ...base, type: 'fetch', url: 'http://127.0.0.1:3100/private' }, '*');
  });
  await page.evaluate(() => window.postMessage({ version: 1, session: document.querySelector('#message-activity-modal iframe').src.split('#')[1], type: 'refresh' }, '*'));
  expect(await page.evaluate(() => window.activityFixture.calls.length)).toBe(1);
  await page.evaluate(() => { window.activityFixture.mode = 'denied'; });
  await frame(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(frame(page).getByRole('alert')).toContainText('access denied');
  await expect(frame(page).getByRole('heading', { name: '3 messages' })).toHaveCount(0);
  await page.evaluate(() => { window.activityFixture.mode = 'empty'; });
  await frame(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(frame(page).getByRole('status')).toContainText('No accessible channels');
  await page.getByRole('button', { name: 'Close Message activity', exact: true }).click();
  await page.evaluate(() => { window.activityFixture.mode = 'ready'; });
  await page.getByTestId('message-activity-launch').click();
  await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
  await page.evaluate(() => { window.activityFixture.mode = 'delayed'; });
  await frame(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => window.activityFixture.pending.length === 1);
  await frame(page).getByLabel('Time range').selectOption('30d');
  await page.waitForFunction(() => window.activityFixture.pending.length === 2);
  await page.evaluate(() => { window.activityFixture.mode = 'ready'; window.activityFixture.pending.pop()(); });
  await expect(frame(page).getByRole('heading', { name: '8 messages', exact: true })).toBeVisible();
  await page.evaluate(() => window.activityFixture.pending.pop()());
  await expect(frame(page).getByRole('heading', { name: '8 messages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close Message activity', exact: true }).click();
  for (const change of ['close', 'scope', 'workspace', 'identity']) {
    await page.evaluate(() => { window.activityFixture.mode = 'delayed'; });
    await page.getByTestId('message-activity-launch').click();
    await expect(frame(page).getByRole('status')).toContainText('Loading');
    await page.waitForFunction(() => window.activityFixture.pending.length > 0);
    await page.evaluate(change => {
      const store = window.Alpine.store('chat');
      if (change === 'close') store.closeMessageActivity();
      if (change === 'scope') store.selectedBoardId = 'scope-other';
      if (change === 'workspace') store._workspaceSelectionGeneration = (store._workspaceSelectionGeneration || 0) + 1;
      if (change === 'identity') store.session = { npub: 'other-reader' };
    }, change);
    await expect(page.getByTestId('message-activity-modal')).not.toBeVisible();
    expect(await page.evaluate(() => window.activityFixture.calls.at(-1).signal.aborted)).toBe(true);
    await page.evaluate(() => { window.activityFixture.pending.splice(0).forEach(resolve => resolve()); });
    await expect(page.locator('#message-activity-modal iframe')).toHaveAttribute('src', 'about:blank');
  }
});

for (const width of [1280, 390]) {
  test(`napplet history, menu and in-place presentation preserve the dashboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setup(page);
    await page.getByTestId('message-activity-launch').click();
    const back = page.getByRole('button', { name: 'Back in napplet history', exact: true });
    const forward = page.getByRole('button', { name: 'Forward in napplet history', exact: true });
    const menu = page.getByRole('button', { name: 'Message activity menu', exact: true });
    await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    await expect(back).toBeDisabled(); await expect(forward).toBeDisabled();
    await frame(page).getByLabel('Time range').selectOption('30d');
    await expect(frame(page).getByRole('heading', { name: '8 messages', exact: true })).toBeVisible();
    await frame(page).getByLabel('Time range').selectOption('all');
    await expect(frame(page).getByText(/All time →/)).toBeVisible();
    await back.click(); await expect(frame(page).getByLabel('Time range')).toHaveValue('30d');
    await back.click(); await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    await expect(back).toBeDisabled(); await expect(forward).toBeEnabled();
    await forward.click(); await expect(frame(page).getByLabel('Time range')).toHaveValue('30d');
    await frame(page).getByLabel('Time range').selectOption('7d');
    await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    await expect(forward).toBeDisabled();
    const src = await page.locator('#message-activity-modal iframe').getAttribute('src');
    const calls = await page.evaluate(() => window.activityFixture.calls.length);
    await frame(page).locator('body').evaluate(() => { window.presentationMarker = 'same running frame'; });
    await page.getByRole('button', { name: 'Expand Message activity', exact: true }).click();
    await expect(page.getByTestId('message-activity-modal')).toHaveClass(/thread-full/);
    await expect.poll(async () => (await page.getByTestId('message-activity-modal').boundingBox()).width).toBeGreaterThan(width - 30);
    await expect.poll(async () => (await page.getByTestId('message-activity-modal').boundingBox()).height).toBeGreaterThan(860);
    await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    await expect(back).toBeEnabled();
    await menu.click(); await expect(page.getByRole('menuitem', { name: 'Collapse to modal' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
    await expect(page.getByTestId('message-activity-modal')).toBeVisible();
    await menu.click(); await page.getByRole('menuitem', { name: 'Collapse to modal' }).click();
    await expect(page.getByTestId('message-activity-modal')).not.toHaveClass(/thread-full/);
    expect(await page.locator('#message-activity-modal iframe').getAttribute('src')).toBe(src);
    expect(await frame(page).locator('body').evaluate(() => window.presentationMarker)).toBe('same running frame');
    expect(await page.evaluate(() => window.activityFixture.calls.length)).toBe(calls);
    await menu.click(); await page.locator('#message-activity-title').click();
    await expect(page.getByRole('menu')).not.toBeVisible();
    await menu.click(); await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
    await expect(frame(page).getByRole('heading', { name: '3 messages', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.activityFixture.calls.length)).toBe(calls + 1);
    await menu.click(); await page.getByRole('menuitem', { name: 'Expand to full page' }).click();
    await page.getByRole('button', { name: 'Collapse Message activity', exact: true }).click();
    await menu.click(); await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect(page.getByTestId('message-activity-launch')).toBeFocused();
  });
}
