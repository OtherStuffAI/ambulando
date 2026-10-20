const { test, expect } = require('playwright/test');
const path = require('node:path');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

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
  const handleCanvasRoute = async route => {
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
  };
  await page.route(`**/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`, handleCanvasRoute);
  await page.route(`**/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/**`, handleCanvasRoute);

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
    store.refreshTowerPgWorkspaceMembers = async () => {};
    store.refreshGroups = async () => {};
    store.getSenderAvatar = () => '';
    store.pgWorkspaceMembers = [
      { actor_id: 'actor-person', npub: 'npub1personfixture00000000000000000000000000000000000000000000000000', kind: 'human', display_name: 'Avery Stone', role: 'member' },
      { actor_id: 'actor-agent', npub: 'npub1agentfixture000000000000000000000000000000000000000000000000000', kind: 'agent', display_name: 'Research agent', role: 'agent' },
    ];
    store.groups = [{ group_id: 'group-delivery', owner_npub: store.workspaceOwnerNpub, name: 'Delivery team', member_npubs: ['npub1personfixture00000000000000000000000000000000000000000000000000'] }];
    Object.defineProperty(store, 'canvasPrincipalOptions', { configurable: true, get: () => [
      { key: 'actor:actor-person', type: 'actor', kind: 'person', kindLabel: 'Person', id: 'actor-person', label: 'Avery Stone', subtitle: 'member', avatarUrl: '', searchText: 'avery stone member actor-person' },
      { key: 'actor:actor-agent', type: 'actor', kind: 'agent', kindLabel: 'Agent', id: 'actor-agent', label: 'Research agent', subtitle: 'agent', avatarUrl: '', searchText: 'research agent actor-agent' },
      { key: 'group:group-delivery', type: 'group', kind: 'group', kindLabel: 'Group', id: 'group-delivery', label: 'Delivery team', subtitle: '1 member', avatarUrl: '', searchText: 'delivery team group-delivery' },
    ] });
  });

  const panel = page.getByTestId('deck-canvases');
  await expect(panel.getByText('Delivery map')).toBeVisible();
  await panel.getByRole('button', { name: 'Create canvas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create canvas' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    const store = window.Alpine.store('chat');
    store.pgWorkspaceMembers = [
      { actor_id: 'actor-person', npub: 'npub1personfixture00000000000000000000000000000000000000000000000000', kind: 'human', display_name: 'Avery Stone', role: 'member' },
      { actor_id: 'actor-agent', npub: 'npub1agentfixture000000000000000000000000000000000000000000000000000', kind: 'agent', display_name: 'Research agent', role: 'agent' },
    ];
    store.groups = [{ group_id: 'group-delivery', owner_npub: store.workspaceOwnerNpub, name: 'Delivery team', member_npubs: ['npub1personfixture00000000000000000000000000000000000000000000000000'] }];
  });
  await dialog.getByLabel('Canvas name').fill('Planning canvas');
  await dialog.getByText('Specific people, agents or groups', { exact: true }).click();
  const picker = dialog.getByRole('combobox', { name: 'Add people, agents or groups' });
  await picker.fill('Research');
  await picker.press('ArrowDown');
  await picker.press('Enter');
  await expect(dialog.getByText('Research agent', { exact: true })).toBeVisible();
  await picker.fill('Avery');
  await dialog.getByRole('option', { name: /Avery Stone/ }).click();
  await picker.fill('Delivery');
  await dialog.getByRole('option', { name: /Delivery team/ }).click();
  await dialog.getByRole('button', { name: 'Remove Avery Stone' }).click();
  await expect(dialog.getByRole('button', { name: 'Remove Avery Stone' })).toHaveCount(0);
  await page.screenshot({ path: path.resolve(__dirname, '../../tmp/docs/handoffs/canvas-access-modal-review-desktop.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Create canvas' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByText('Planning canvas')).toBeVisible();
  expect(requests[0]).toEqual({
    method: 'POST',
    pathname: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases`,
    body: {
      title: 'Planning canvas',
      visibility: { mode: 'restricted', actor_ids: ['actor-agent'], group_ids: ['group-delivery'] },
    },
  });

  const createdRow = panel.locator('.canvas-deck-row').filter({ hasText: 'Planning canvas' });
  await createdRow.getByRole('button', { name: 'Canvas options' }).click();
  await page.getByRole('menuitem', { name: 'Rename and visibility…' }).click();
  const settings = page.getByRole('dialog', { name: 'Canvas settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByText('Research agent', { exact: true })).toBeVisible();
  await expect(settings.getByText('Delivery team', { exact: true })).toBeVisible();
  await settings.getByLabel('Canvas name').fill('Planning wall');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings).toBeHidden();
  await expect(panel.getByText('Planning wall')).toBeVisible();
  expect(requests[1]).toMatchObject({
    method: 'PATCH',
    pathname: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/canvases/canvas-created`,
    body: { title: 'Planning wall', expected_row_version: 1 },
  });
});

test('Canvas access modal stays usable in a narrow, short viewport without full identity overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await openFixture(page, true);
  const fullNpub = `npub1${'z'.repeat(58)}`;
  await page.evaluate(({ fullNpub }) => {
    const store = window.Alpine.store('chat');
    store.closeThread({ syncRoute: false });
    store.syncCanvasContext = () => {};
    store.refreshTowerPgWorkspaceMembers = async () => {};
    store.refreshGroups = async () => {};
    store.getSenderAvatar = () => '';
    store.navSection = 'status';
    store.canvasContextKey = store.canvasPartition;
    store.pgWorkspaceMembers = Array.from({ length: 12 }, (_, index) => ({
      actor_id: `actor-${index}`,
      npub: index === 0 ? fullNpub : `npub1fixture${String(index).padStart(2, '0')}`,
      kind: index % 3 === 0 ? 'agent' : 'human',
      display_name: index === 0 ? fullNpub : `Workspace choice ${index}`,
    }));
    store.groups = [{ group_id: 'group-one', owner_npub: store.workspaceOwnerNpub, name: 'Delivery group' }];
    const options = store.pgWorkspaceMembers.map((member, index) => ({
      key: `actor:${member.actor_id}`, type: 'actor', kind: member.kind === 'agent' ? 'agent' : 'person',
      kindLabel: member.kind === 'agent' ? 'Agent' : 'Person', id: member.actor_id,
      label: index === 0 ? 'Unnamed person' : member.display_name,
      subtitle: index === 0 ? 'npub1zzzzz…zzzzzz' : 'Workspace member', avatarUrl: '',
      searchText: `${member.display_name} ${member.npub} ${member.actor_id}`.toLowerCase(),
    }));
    options.push({ key: 'group:group-one', type: 'group', kind: 'group', kindLabel: 'Group', id: 'group-one', label: 'Delivery group', subtitle: 'Workspace group', avatarUrl: '', searchText: 'delivery group group-one' });
    Object.defineProperty(store, 'canvasPrincipalOptions', { configurable: true, get: () => options });
    store.openCanvasCreateDialog();
  }, { fullNpub });

  const dialog = page.getByRole('dialog', { name: 'Create canvas' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('Specific people, agents or groups', { exact: true }).click();
  const picker = dialog.locator('#canvas-principal-search');
  await picker.fill('Workspace');
  for (let index = 1; index <= 8; index += 1) {
    await dialog.getByRole('option', { name: new RegExp(`Workspace choice ${index}(?:\\s|$)`) }).click();
    await picker.fill('Workspace');
  }
  await picker.press('Escape');
  await expect(dialog.getByRole('listbox', { name: 'People, agents and groups' })).toBeHidden();
  await expect(dialog).toBeVisible();

  const geometry = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const surface = node.querySelector('.canvas-settings-surface');
    const actions = node.querySelector('.canvas-settings-actions').getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      scrollWidth: surface.scrollWidth, clientWidth: surface.clientWidth,
      actionsTop: actions.top, actionsBottom: actions.bottom,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(520);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.actionsTop).toBeGreaterThanOrEqual(0);
  expect(geometry.actionsBottom).toBeLessThanOrEqual(520);
  await expect(dialog).not.toContainText(fullNpub);
  await page.screenshot({ path: path.resolve(__dirname, '../../tmp/docs/handoffs/canvas-access-modal-review.png'), animations: 'disabled' });
});
