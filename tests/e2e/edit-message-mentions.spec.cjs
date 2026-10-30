const { test, expect } = require('playwright/test');
const { finalizeEvent, getPublicKey, nip19, verifyEvent } = require('nostr-tools');
const { createHash } = require('node:crypto');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const secret = new Uint8Array(32).fill(17);
const pubkey = getPublicKey(secret);
const operator = nip19.npubEncode(pubkey);
const bot = nip19.npubEncode('22'.repeat(32));
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', trace: 'off', screenshot: 'off' });
test.setTimeout(45000);

// Every HTTP request is intercepted; no real account, workspace or agent runs.
async function fixture(page) {
  const writes = [];
  let message;
  await page.exposeFunction('fixtureSign', event => finalizeEvent(event, secret));
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.endsWith('/channels/edit-channel/messages')) {
      const p = req.postDataJSON(); writes.push(p);
      message = { id: 'edit-message', workspace_id: 'edit-fixture', scope_id: 'edit-scope', channel_id: 'edit-channel', thread_id: 'edit-thread', body: p.body, metadata: { ...p.metadata, attachments: [{ storage_object_id: 'kept-file', filename: 'kept.txt', content_type: 'text/plain' }], agent_instruction_signature: p.message_signature }, mentions: p.metadata?.mentions || [], row_version: 1, created_by_actor_npub: operator, created_at: '2026-10-30T01:00:00Z', updated_at: '2026-10-30T01:00:00Z' };
      return route.fulfill({ json: { message, thread: { id: 'edit-thread', source_message_id: 'edit-message' } } });
    }
    if (req.method() === 'PATCH' && url.pathname.endsWith('/messages/edit-message')) {
      const p = req.postDataJSON(); writes.push(p);
      if (writes.rejectNext) { writes.rejectNext = false; return route.fulfill({ status: 503, json: { error: 'offline fixture' } }); }
      message = { ...message, body: p.body, mentions: p.mentions, metadata: { ...message.metadata, mentions: p.mentions, agent_instruction_signature: p.message_signature }, row_version: message.row_version + 1, updated_at: '2026-10-30T02:00:00Z' };
      return route.fulfill({ json: { message } });
    }
    if (process.env.FLIGHTDECK_EDIT_LIVE_ASSETS === '1' && url.origin === new URL(process.env.PLAYWRIGHT_BASE_URL).origin && !url.pathname.startsWith('/api/')) return route.continue();
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
  await page.evaluate(async ({ pubkey, operator, bot }) => {
    window.nostr = { getPublicKey: async () => pubkey, signEvent: window.fixtureSign };
    localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'extension', pubkey, expiresAt: Date.now() + 120000 }));
    const s = Alpine.store('chat');
    for (const key of ['startWorkspaceLiveQueries', 'loadRemoteWorkspaces', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery', 'syncRoute', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'recomputeTowerPgUnreadProjection', 'rememberPeople', 'refreshReactionsForVisibleTargets', 'ensureChatMentionRoster', 'startThreadLiveActivity', 'markTowerPgResourceViewed']) s[key] = async () => {};
    s.openConnectModal = () => {};
    s.session = { npub: operator };
    s.knownWorkspaces = [{ workspaceKey: 'edit-fixture', workspaceId: 'edit-fixture', workspaceOwnerNpub: operator, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    await s.selectWorkspace('edit-fixture', { skipPgVerification: true });
    s.pgWorkspaceMembers = [{ actor_id: 'edit-bot', npub: bot, kind: 'agent', display_name: 'Edit Bot' }];
    s.channels = [{ record_id: 'edit-channel', title: 'Isolated editing', scope_id: 'edit-scope', record_state: 'active' }];
    s.selectedChannelId = 'edit-channel'; s.selectedBoardId = '__pg_channel__:edit-channel'; s.navSection = 'chat';
    s.messages = []; s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    await s.sendMessage({ body: '**Original**\nSecond line' });
    s.openThread('edit-message', { scrollToLatest: false });
  }, { pubkey, operator, bot });
  return writes;
}

test('edit picker preserves canonical body, exact mentions, signature, cancel and unsent live draft', async ({ page }) => {
  page.setDefaultTimeout(5000);
  const writes = await fixture(page);
  expect(writes).toHaveLength(1);
  const editor = page.locator('[data-chat-composer="thread"]:visible');
  await editor.fill('Unsent reply draft');
  await page.evaluate(() => { Alpine.store('chat').threadFileDrafts = [{ draft_id: 'pending-reply', filename: 'pending.txt', status: 'uploading', kind: 'file' }]; });
  // Edit must capture live DOM even though normal typing defers the model.
  await page.evaluate(() => Alpine.store('chat').startMessageEdit('edit-message'));
  await expect(editor).toContainText('Original');
  await expect(editor).toContainText('Second line');
  await expect(page.locator('input[aria-label="Choose photos or files to attach to reply"]')).toBeDisabled();
  await editor.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); el.focus(); });
  await page.keyboard.type(' @edit');
  await page.locator('.mention-result-item').filter({ hasText: 'Edit Bot' }).click();
  await expect(editor.locator('[data-mention-token]')).toHaveText('@Edit Bot');
  await page.keyboard.type('please act');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  const body = `**Original**\nSecond line @[Edit Bot](mention:agent:${bot}) please act`;
  expect(writes[1]).toMatchObject({ body, row_version: 1, mentions: [{ type: 'agent', npub: bot, label: 'Edit Bot' }] });
  const sig = writes[1].message_signature;
  expect(verifyEvent(structuredClone(sig.nostr_event))).toBe(true);
  expect(sig).toMatchObject({ message_id: 'edit-message', revision: 2, body_sha256: createHash('sha256').update(body).digest('hex') });
  expect(sig.nostr_event.content).toBe(body);
  expect(sig.nostr_event.tags).toEqual(expect.arrayContaining([['message_id', 'edit-message'], ['revision', '2'], ['thread_id', 'edit-thread']]));
  await expect(editor).toHaveText('Unsent reply draft');
  expect(await page.evaluate(() => Alpine.store('chat').threadFileDrafts)).toMatchObject([{ draft_id: 'pending-reply', status: 'uploading' }]);
  expect(await page.evaluate(() => Alpine.store('chat').getChatMessageById('edit-message'))).toMatchObject({ body, version: 2, attachments: [{ storage_object_id: 'kept-file', filename: 'kept.txt', content_type: 'text/plain' }], pg_metadata: { mentions: writes[1].mentions, agent_instruction_signature: sig } });
  await page.evaluate(() => Alpine.store('chat').startMessageEdit('edit-message'));
  await expect(editor.locator('[data-mention-token]')).toHaveText('@Edit Bot');
  await editor.fill('Discard me');
  await page.locator('.chat-editing-banner:visible').getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveText('Unsent reply draft');
  expect(writes).toHaveLength(2);
  await page.evaluate(() => Alpine.store('chat').startMessageEdit('edit-message'));
  await editor.fill('No bot now');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ body: 'No bot now', mentions: [], row_version: 2 });
  await expect(editor).toHaveText('Unsent reply draft');
  await page.evaluate(() => Alpine.store('chat').startMessageEdit('edit-message'));
  await editor.fill('Retry this edit');
  writes.rejectNext = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(4);
  await expect(page.locator('.chat-editing-banner:visible')).toContainText('503');
  await expect(editor).toHaveText('Retry this edit');
  expect(await page.evaluate(() => Alpine.store('chat').getChatMessageById('edit-message').body)).toBe('No bot now');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(5);
  expect(writes[3]).toMatchObject({ body: 'Retry this edit', row_version: 3, message_signature: { revision: 4 } });
  expect(writes[4]).toMatchObject({ body: 'Retry this edit', row_version: 3, message_signature: { revision: 4 } });
  await expect(editor).toHaveText('Unsent reply draft');
});
