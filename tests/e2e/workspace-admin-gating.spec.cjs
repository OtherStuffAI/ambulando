const crypto = require('node:crypto');

const { test, expect } = require('playwright/test');
const { finalizeEvent, getPublicKey, nip19, nip44 } = require('nostr-tools');

function resolveAdminNsec() {
  return String(process.env.TESTING_NSEC || '').trim();
}

function resolveMemberNsec() {
  return String(process.env.TESTING_MEMBER_NSEC || '').trim();
}

function hexToBytes(hex) {
  const normalized = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid secret hex.');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function decodeSecret(secret) {
  const value = String(secret || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return hexToBytes(value);
  const decoded = nip19.decode(value);
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Invalid nsec.');
  }
  return decoded.data;
}

function decodeNpub(npub) {
  const decoded = nip19.decode(String(npub || '').trim());
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error(`Invalid npub: ${npub}`);
  }
  return decoded.data;
}

function npubFromSecret(secret) {
  return nip19.npubEncode(getPublicKey(secret));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function createNip98AuthHeader(url, method, body, secret) {
  const serialized = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (serialized != null && method.toUpperCase() !== 'GET') {
    tags.push(['payload', sha256Hex(serialized)]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function requestJson(baseUrl, path, { method = 'GET', body = null, secret } = {}) {
  const url = new URL(path, baseUrl).toString();
  const response = await fetch(url, {
    method,
    headers: {
      authorization: createNip98AuthHeader(url, method, body, secret),
      ...(body == null ? {} : { 'content-type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  return data;
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'workspace';
}

async function loginWithSecret(page, nsec) {
  await page.goto('/');
  await page.locator('details.auth-advanced summary').click();
  await page.locator('input[name="secret"]').fill(nsec);
  await page.getByRole('button', { name: 'BYO Nsec' }).click();
  await expect(page.locator('.auth-error:visible')).toHaveCount(0);
}

async function createWorkspace(page, workspaceName) {
  const connectModal = page.locator('.modal').filter({ hasText: 'Connect to SuperBased' });
  const connectVisible = await connectModal.isVisible().catch(() => false)
    || await connectModal.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
  if (connectVisible) {
    await connectModal.locator('.connect-host-row').first().click();

    const selectModal = page.locator('.modal').filter({ hasText: 'Select Workspace' });
    await expect(selectModal).toBeVisible();
    await selectModal.locator('input[placeholder="My workspace"]').fill(workspaceName);
    await selectModal.locator('input[placeholder=""]').fill('Playwright admin gating workspace');
    await selectModal.getByRole('button', { name: 'Create workspace' }).click();
    return;
  }

  const bootstrapNameInput = page.locator('.superbased-modal input[placeholder="Wingmen"]');
  if (await bootstrapNameInput.isVisible().catch(() => false)) {
    await bootstrapNameInput.fill(workspaceName);
    await page.locator('.superbased-modal textarea[placeholder="Optional description"]').fill('Playwright admin gating workspace');
    await page.locator('.superbased-modal').getByRole('button', { name: 'Create workspace' }).click();
    return;
  }

  const workspaceTrigger = page.locator('.sidebar-workspace-trigger');
  await expect(workspaceTrigger).toBeVisible();
  await workspaceTrigger.click();
  await page.getByRole('button', { name: 'Add workspace...' }).click();

  await expect(connectModal).toBeVisible();
  await connectModal.locator('.connect-host-row').first().click();

  const selectModal = page.locator('.modal').filter({ hasText: 'Select Workspace' });
  await expect(selectModal).toBeVisible();
  await selectModal.locator('input[placeholder="My workspace"]').fill(workspaceName);
  await selectModal.locator('input[placeholder=""]').fill('Playwright admin gating workspace');
  await selectModal.getByRole('button', { name: 'Create workspace' }).click();
}

async function findWorkspaceByName(baseUrl, adminSecret, adminNpub, workspaceName) {
  const data = await requestJson(baseUrl, `/api/v4/workspaces?member_npub=${encodeURIComponent(adminNpub)}`, {
    secret: adminSecret,
  });
  return (data.workspaces || []).find((workspace) => workspace.name === workspaceName) || null;
}

async function shareWorkspaceSharedGroup({ baseUrl, adminSecret, adminNpub, memberNpub, workspaceOwnerNpub }) {
  const groupsData = await requestJson(baseUrl, `/api/v4/groups?npub=${encodeURIComponent(adminNpub)}`, {
    secret: adminSecret,
  });
  const sharedGroup = (groupsData.groups || []).find((group) => (
    group.owner_npub === workspaceOwnerNpub && group.group_kind === 'workspace_shared'
  ));
  if (!sharedGroup) {
    throw new Error(`Could not find workspace_shared group for ${workspaceOwnerNpub}`);
  }

  const keysData = await requestJson(baseUrl, `/api/v4/groups/keys?member_npub=${encodeURIComponent(adminNpub)}`, {
    secret: adminSecret,
  });
  const sharedGroupKey = (keysData.keys || []).find((entry) => entry.group_id === sharedGroup.id);
  if (!sharedGroupKey) {
    throw new Error(`Could not find wrapped key for group ${sharedGroup.id}`);
  }

  const plaintextGroupNsec = nip44.decrypt(
    sharedGroupKey.wrapped_group_nsec,
    nip44.getConversationKey(adminSecret, decodeNpub(sharedGroupKey.wrapped_by_npub)),
  );
  const wrappedForMember = nip44.encrypt(
    plaintextGroupNsec,
    nip44.getConversationKey(adminSecret, decodeNpub(memberNpub)),
  );

  await requestJson(baseUrl, `/api/v4/groups/${sharedGroup.id}/members`, {
    method: 'POST',
    secret: adminSecret,
    body: {
      member_npub: memberNpub,
      wrapped_group_nsec: wrappedForMember,
      wrapped_by_npub: adminNpub,
    },
  });

  return sharedGroup;
}

const adminNsec = resolveAdminNsec();
const memberNsec = resolveMemberNsec();
const backendUrl = String(process.env.PLAYWRIGHT_TOWER_URL || 'http://127.0.0.1:3100').trim();

test.describe('workspace admin gating', () => {
  test.skip(!adminNsec, 'TESTING_NSEC is not set.');
  test.skip(!memberNsec, 'TESTING_MEMBER_NSEC is not set.');

  test('shared-only member does not see admin-only settings or scope creation controls', async ({ page, browser }) => {
    const adminSecret = decodeSecret(adminNsec);
    const memberSecret = decodeSecret(memberNsec);
    const adminNpub = npubFromSecret(adminSecret);
    const memberNpub = npubFromSecret(memberSecret);
    const adminLoginSecret = nip19.nsecEncode(adminSecret);
    const memberLoginSecret = nip19.nsecEncode(memberSecret);
    const workspaceName = `PW Admin Gate ${Date.now()}`;
    const workspaceSlug = slugify(workspaceName);

    await loginWithSecret(page, adminLoginSecret);
    await createWorkspace(page, workspaceName);
    await expect(page.locator('.sidebar-workspace-name')).toContainText(workspaceName);

    await expect.poll(async () => {
      const workspace = await findWorkspaceByName(backendUrl, adminSecret, adminNpub, workspaceName);
      return workspace?.workspace_owner_npub || null;
    }, {
      timeout: 20000,
      message: 'workspace should be visible to admin via the workspace list route',
    }).not.toBeNull();

    const workspace = await findWorkspaceByName(backendUrl, adminSecret, adminNpub, workspaceName);
    await shareWorkspaceSharedGroup({
      baseUrl: backendUrl,
      adminSecret,
      adminNpub,
      memberNpub,
      workspaceOwnerNpub: workspace.workspace_owner_npub,
    });

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    try {
      await loginWithSecret(memberPage, memberLoginSecret);
      await memberPage.goto(`/${workspaceSlug}/settings`);

      await expect(memberPage.locator('.sidebar-workspace-name')).toContainText(workspaceName);
      await expect(memberPage.getByRole('heading', { name: 'SuperBased' })).toBeVisible();

      const visibleTabs = await memberPage.locator('.settings-tabs .settings-tab:visible').allTextContents();
      expect(visibleTabs).toEqual(['NStack']);

      await expect(memberPage.getByRole('button', { name: 'Workspace', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Automation', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Flows', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Sync', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Scopes', exact: true })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Groups & Members', exact: true })).toHaveCount(0);
      await expect(memberPage.locator('#workspace-name-input')).toBeHidden();
      await expect(memberPage.getByRole('button', { name: 'Save workspace' })).toBeHidden();
      await expect(memberPage.getByRole('heading', { name: 'Scopes' })).toHaveCount(0);
      await expect(memberPage.locator('.scope-create-bar')).toBeHidden();
    } finally {
      await memberContext.close();
    }
  });
});
