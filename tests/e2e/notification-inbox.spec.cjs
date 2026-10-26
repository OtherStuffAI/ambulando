const { test, expect } = require('playwright/test');

// Renders the shared notification inbox from seeded store state. It needs no
// Tower: sync, Dexie projection and CAS commands are covered by unit tests.
async function blockExternalRequests(page) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
}

const item = (id, extra = {}) => ({
  key: `ctx|${id}`, id, title: `Title ${id}`, body: extra.body || '', category: extra.category || 'mention', severity: 'normal',
  source: { app_id: 'flightdeck.core', label: 'Flight Deck', kind: 'tower_rule' }, group: extra.group || null,
  read: Boolean(extra.read), archived: false, unavailable: Boolean(extra.unavailable), ageLabel: '5m ago', route: extra.route || null,
});

async function seed(page, viewport) {
  await blockExternalRequests(page);
  await page.setViewportSize(viewport);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
  await page.evaluate(items => {
    const store = window.Alpine.store('chat');
    store.showConnectModal = false;
    store.showWorkspaceBootstrapModal = false;
    store.openConnectModal = () => {};
    store.startWorkspaceLiveQueries = () => {};
    store.syncRoute = () => {};
    store.performSync = () => {};
    store.requestTowerSyncFamily = async () => {};
    store.session = { ...(store.session || {}), npub: 'npub1inboxe2e' };
    store.pgBackendMode = true;
    store.activateNotificationInbox = () => {};
    store.notificationInboxReady = true;
    store.notificationInboxStatus = 'ok';
    store.notificationInboxItems = items;
    store.notificationInboxCategories = ['mention', 'task_assignment'];
    store.notificationInboxUnread = 2;
  }, [
    item('a', { body: 'A mention in a thread', route: { section: 'chat' }, group: { key: 'g', event_count: 3 } }),
    item('b', { category: 'task_assignment' }),
    item('c', { read: true }),
    item('gone', { unavailable: true, read: true }),
  ]);
}

test('notification inbox panel renders, is keyboard operable and fits narrow screens', async ({ page }) => {
  await seed(page, { width: 1280, height: 800 });
  const button = page.getByTestId('notification-inbox-button');
  await expect(button).toBeVisible();
  await expect(page.getByTestId('notification-inbox-badge')).toHaveText('2');
  await expect(button).toHaveAttribute('aria-label', 'Notifications, 2 unread');
  await expect(page.getByTestId('notification-inbox-panel')).toBeHidden();

  await button.click();
  const panel = page.getByTestId('notification-inbox-panel');
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const rows = page.getByTestId('notification-inbox-item');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Title a');
  await expect(rows.first()).toContainText('3 updates');
  await expect(rows.first()).toHaveClass(/unread/);
  await expect(rows.nth(2)).not.toHaveClass(/unread/);
  await expect(page.getByTestId('notification-inbox-view-inbox')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('notification-inbox-category')).toBeVisible();
  await expect(page.getByTestId('notification-inbox-empty')).toBeHidden();
  // Text is rendered inertly.
  expect(await panel.evaluate(node => node.querySelectorAll('img, script').length)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();

  await page.setViewportSize({ width: 390, height: 760 });
  await button.click();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const overflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1);
  expect(overflow).toBe(false);
});

test('empty and unsupported states are explicit, never a blank panel', async ({ page }) => {
  await seed(page, { width: 1280, height: 800 });
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.notificationInboxItems = [];
    store.notificationInboxUnread = 0;
    store.notificationInboxStatus = 'unsupported';
    store.notificationInboxMessage = 'This Tower does not provide the shared notification inbox yet. Existing alerts and Needs You keep working.';
    store.notificationInboxOpen = true;
  });
  await expect(page.getByTestId('notification-inbox-badge')).toBeHidden();
  await expect(page.getByTestId('notification-inbox-status')).toContainText('does not provide the shared notification inbox');
  await expect(page.getByTestId('notification-inbox-empty')).toContainText('does not provide');
  await expect(page.getByTestId('notification-inbox-mark-all')).toBeDisabled();
});
