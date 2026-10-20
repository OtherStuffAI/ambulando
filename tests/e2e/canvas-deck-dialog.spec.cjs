const { test, expect } = require('playwright/test');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const workspaceId = '20000000-0000-4000-8000-000000000012';
const identity = {
  workspace_id: workspaceId,
  app_npub: 'npub1canvasapp',
  tower_service_npub: 'npub1canvastower',
  workspace_service_npub: 'npub1canvasworkspace',
};

test('Deck Create canvas opens and submits through Tower, then settings opens and saves', async ({ page }) => {
  test.setTimeout(40_000);
  const requests = [];
  let canvases = [{
    id: 'canvas-existing',
    title: 'Delivery map',
    position: 1,
    row_version: 1,
    can_manage: true,
    visibility: { mode: 'workspace', actor_ids: [], group_ids: [] },
  }];

  await page.route('**/__canvas-deck-seed.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
  await page.route(`**/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases*`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const collectionPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`;
    expect(request.headers().authorization).toMatch(/^Nostr /);
    if (request.method() === 'GET' && url.pathname === collectionPath) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ workspace_id: workspaceId, identity, complete: true, canvases }),
      });
    }
    const body = request.postDataJSON();
    requests.push({ method: request.method(), pathname: url.pathname, body });
    if (request.method() === 'POST' && url.pathname === collectionPath) {
      canvases = [...canvases, {
        id: 'canvas-created', title: body.title, position: 2, row_version: 1, can_manage: true,
        visibility: body.visibility,
      }];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: canvases.at(-1) }) });
    }
    if (request.method() === 'PATCH' && url.pathname === `${collectionPath}/canvas-created`) {
      canvases = canvases.map(canvas => canvas.id === 'canvas-created'
        ? { ...canvas, title: body.title, visibility: body.visibility, row_version: 2 }
        : canvas);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas: canvases.at(-1) }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/__canvas-deck-seed.html');
  await page.evaluate(async ({ workspaceId, identity }) => {
    const { signLoginEvent, pubkeyToNpub } = await import('/src/auth/nostr.js');
    const event = await signLoginEvent('ephemeral');
    const npub = await pubkeyToNpub(event.pubkey);
    const workspaceKey = `pg:${npub}::tower:${identity.tower_service_npub}::workspace:${identity.workspace_service_npub}::app:${identity.app_npub}::id:${workspaceId}`;
    const workspace = {
      workspaceKey,
      workspaceId,
      workspaceOwnerNpub: npub,
      pgSessionNpub: npub,
      directHttpsUrl: 'http://127.0.0.1:3100',
      appNpub: identity.app_npub,
      towerServiceNpub: identity.tower_service_npub,
      workspaceServiceNpub: identity.workspace_service_npub,
      pgBackendMode: true,
      pgMe: { actor: { actor_id: 'actor-reader', npub }, identity },
      pgDescriptor: { identity },
    };
    const request = indexedDB.open('wingman-fd-shared', 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('app_settings')) db.createObjectStore('app_settings', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('storage_image_cache')) db.createObjectStore('storage_image_cache', { keyPath: 'object_id' });
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'pubkey' });
      if (!db.objectStoreNames.contains('address_book')) db.createObjectStore('address_book', { keyPath: 'npub' });
      if (!db.objectStoreNames.contains('workspace_keys')) db.createObjectStore('workspace_keys', { keyPath: 'workspace_owner_npub' });
      if (!db.objectStoreNames.contains('tower_transport_preferences')) db.createObjectStore('tower_transport_preferences', { keyPath: 'logicalTower' });
      if (!db.objectStoreNames.contains('nstack_selections')) db.createObjectStore('nstack_selections', { keyPath: 'partition' });
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('app_settings', 'readwrite');
    tx.objectStore('app_settings').put({ id: 1, knownWorkspaces: [workspace], currentWorkspaceKey: workspace.workspaceKey });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { workspaceId, identity });

  await page.goto('/');
  await page.waitForFunction(id => window.Alpine?.store?.('chat')?.currentWorkspace?.workspaceId === id, workspaceId);
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.closeThread({ syncRoute: false });
    store.navSection = 'status';
  });

  const panel = page.getByTestId('deck-canvases');
  await expect(panel.getByText('Delivery map')).toBeVisible();
  await panel.getByRole('button', { name: 'Create canvas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create canvas' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Planning canvas');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByText('Planning canvas')).toBeVisible();
  expect(requests[0]).toEqual({
    method: 'POST',
    pathname: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`,
    body: {
      title: 'Planning canvas',
      visibility: { mode: 'workspace', actor_ids: [], group_ids: [] },
    },
  });

  const createdRow = panel.locator('.canvas-deck-row').filter({ hasText: 'Planning canvas' });
  await createdRow.getByRole('button', { name: 'Canvas options' }).click();
  await page.getByRole('menuitem', { name: 'Rename and visibility…' }).click();
  const settings = page.getByRole('dialog', { name: 'Canvas settings' });
  await expect(settings).toBeVisible();
  await settings.getByLabel('Name').fill('Planning wall');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings).toBeHidden();
  await expect(panel.getByText('Planning wall')).toBeVisible();
  expect(requests[1]).toMatchObject({
    method: 'PATCH',
    pathname: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/canvas-created`,
    body: { title: 'Planning wall', expected_row_version: 1 },
  });
});
