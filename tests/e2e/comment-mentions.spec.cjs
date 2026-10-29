const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
test.setTimeout(30_000);

// Production UI with isolated local records and unavailable backend traffic.
// These checks never instruct real agents or write to a shared workspace.
async function openCommentSurface(page, surface, composing = true) {
  const writes = [];
  // Reload must retain comments without bootstrapping the synthetic signer as
  // a real saved login before this fixture configures its isolated workspace.
  await page.addInitScript(() => localStorage.removeItem('nostr_secure_auth_recovery_v1'));
  await page.unroute('**/*');
  await page.route('**/*', route => {
    const request = route.request();
    if (request.method() === 'POST' && /\/(tasks|docs)\/[^/]+\/comments$/.test(new URL(request.url()).pathname)) {
      const payload = request.postDataJSON();
      writes.push(payload);
      return route.fulfill({ json: { comment: {
        id: payload.metadata?.client_record_id || `accepted-${writes.length}`,
        workspace_id: 'comment-mentions', scope_id: 'comment-scope', channel_id: 'comment-channel',
        ...(surface === 'task' ? { task_id: 'comment-task' } : { doc_id: 'comment-doc' }),
        parent_comment_id: payload.parent_comment_id || null,
        body: payload.body, mentions: payload.mentions, metadata: payload.metadata,
        row_version: 1, created_at: '2026-10-29T02:00:00Z', updated_at: '2026-10-29T02:00:00Z',
      } } });
    }
    return serveBuiltFlightDeck(route);
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.Alpine?.store('chat')));
  await page.evaluate(async ({ surface, composing }) => {
    const s = window.Alpine.store('chat');
    // An isolated mock NIP-07 provider drives the existing signing path. All
    // network requests are intercepted; this establishes no Tower authority.
    const pubkey = 'a'.repeat(64);
    window.nostr = { getPublicKey: async () => pubkey, signEvent: async event => ({ ...event, pubkey, id: 'b'.repeat(64), sig: 'c'.repeat(128) }) };
    localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'extension', pubkey, expiresAt: Date.now() + 60_000 }));
    window.readCommentFixtureRows = () => new Promise((resolve, reject) => {
      const open = indexedDB.open('wingman-fd-ws-comment-mentions');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('comments').objectStore('comments').getAll();
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
    for (const key of ['startWorkspaceLiveQueries', 'startSharedLiveQueries', 'stopWorkspaceLiveQueries', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery', 'syncRoute', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'markTaskRead', 'resolveChatProfile', 'recomputeTowerPgUnreadProjection', 'rememberPeople', 'refreshReactionsForVisibleTargets', 'ensureChatMentionRoster']) s[key] = async () => {};
    s.openConnectModal = () => {};
    s.showConnectModal = false;
    s.showWorkspaceBootstrapModal = false;
    s.session = { npub: 'npub1commentoperator' };
    s.knownWorkspaces = [{ workspaceKey: 'comment-mentions', workspaceId: 'comment-mentions', workspaceOwnerNpub: 'npub1commentoperator', directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }];
    await s.selectWorkspace('comment-mentions', { skipPgVerification: true });
    s.pgWorkspaceMembers = [
      { actor_id: 'fixture-agent', npub: 'npub1fixtureagent', kind: 'agent', display_name: 'Rich Agent' },
      { actor_id: 'richard', npub: 'npub1fixtureperson', kind: 'person', display_name: 'Richard' },
    ];
    s.addressBookPeople = [{ npub: 'npub1outsider', label: 'Rich Agent outsider' }];
    s.getSenderName = npub => s.pgWorkspaceMembers.find(member => member.npub === npub)?.display_name || 'Operator';
    s.channels = [{ record_id: 'comment-channel', title: 'Comment fixture', scope_id: 'comment-scope', record_state: 'active' }];
    // A different active chat must not supply mention identities for comments.
    s.selectedChannelId = 'different-chat';
    s.groups = [];
    const task = { record_id: 'comment-task', title: 'Comment task', description: 'A complete task description', state: 'in_progress', priority: 'sand', assigned_to_npubs: [], predecessor_task_ids: [], record_state: 'active', sync_status: 'synced', version: 1, pg_backend: true, pg_record_type: 'task', pg_channel_id: 'comment-channel' };
    s.tasks = [task];
    s.loadTaskComments = async () => s.applyTaskComments([...(await window.readCommentFixtureRows()).filter(row => row.target_record_id === 'comment-task'), { record_id: 'existing', body: 'Existing @[Rich Agent](mention:agent:npub1fixtureagent) update', sender_npub: 'npub1commentoperator', updated_at: '2026-10-05T01:00:00Z' }]);
    if (surface === 'task') {
      s.openTaskDetail(task.record_id);
      await s.applySelectedTask(task);
    } else {
      const doc = { record_id: 'comment-doc', title: 'Comment document', content: 'Document body', pg_channel_id: 'comment-channel', scope_id: 'comment-scope', owner_npub: 'npub1commentoperator', version: 1, pg_backend: true, sync_status: 'synced', record_state: 'active' };
      s.documents = [doc];
      for (const key of ['hydrateSelectedDocWithRetry', 'inspectSelectedDocEditLease', 'loadSelectedDocRecoveries', 'restoreSelectedDocDraft', 'loadDocComments']) s[key] = async () => null;
      for (const key of ['markDocRead', 'startDocCommentsLiveQuery', 'scheduleDocAutosave']) s[key] = () => {};
      s.releaseSelectedDocLeaseWhenSafe = async () => true;
      s.navSection = 'docs';
      s.openDoc(doc.record_id);
      s.loadDocComments = async () => { s.docComments = [...(await window.readCommentFixtureRows()).filter(row => row.target_record_id === 'comment-doc'), { record_id: 'comment-root', target_record_id: doc.record_id, body: 'Existing @[Rich Agent](mention:agent:npub1fixtureagent) update', sender_npub: 'npub1commentoperator', comment_status: 'open', updated_at: '2026-10-05T01:00:00Z' }]; };
      await s.loadDocComments();
      s.docCommentsVisible = true;
      s.docMobilePane = 'comments';
      s.selectedDocCommentId = 'comment-root';
      s.docCommentAnchorLine = surface === 'doc-comment' && composing ? 1 : null;
    }
    s.showConnectModal = false;
    s.showWorkspaceBootstrapModal = false;
    s.error = '';
  }, { surface, composing });
  return writes;
}

for (const touch of [false, true]) {
  test.describe(touch ? 'touch' : 'keyboard', () => {
    test.use({ hasTouch: touch });
  for (const surface of ['task', 'doc-comment', 'doc-reply']) {
    test(`${surface}: @ric picker retains body, identity and caret with ${touch ? 'touch' : 'keyboard'} selection`, async ({ page }) => {
      await page.setViewportSize({ width: touch ? 390 : 1280, height: 900 });
      const writes = await openCommentSurface(page, surface);
      if (surface === 'task' && touch) await page.getByRole('button', { name: 'Comments', exact: true }).click();
      const composer = page.locator(surface === 'task' ? '.task-comment-composer' : `[data-chat-composer="${surface}"]:visible`).first();
      await expect(composer).toBeVisible();
      await composer.click();
      await page.keyboard.type('Before @ric');
      const rows = page.locator('.mention-result-item');
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: 'outsider' })).toHaveCount(0);
      if (touch) await rows.filter({ hasText: 'Rich Agent' }).tap();
      else await page.keyboard.press('Enter');
      await page.keyboard.type('after');
      const model = surface === 'task' ? 'newTaskCommentBody' : surface === 'doc-comment' ? 'newDocCommentBody' : 'newDocCommentReplyBody';
      expect(await page.evaluate(model => window.Alpine.store('chat')[model], model)).toBe('Before @[Rich Agent](mention:agent:npub1fixtureagent) after');
      expect(await page.evaluate(surface => window.Alpine.store('chat').selectedAgentMentionsByComposer[surface === 'task' ? 'task-comment' : surface], surface)).toEqual([{ type: 'agent', npub: 'npub1fixtureagent', label: 'Rich Agent' }]);
      await expect(composer).toBeFocused();
      await expect(composer.locator('[data-mention-token]')).toHaveText('@Rich Agent');
      await composer.press('Shift+Enter');
      await page.keyboard.type('Second line');
      expect(await page.evaluate(model => window.Alpine.store('chat')[model], model)).toContain('after\nSecond line');
      await page.keyboard.type(' @richard');
      await expect(rows).toHaveCount(1);
      if (touch) await rows.tap();
      else await page.keyboard.press('Enter');
      await page.keyboard.type('complete');
      const expectedBody = 'Before @[Rich Agent](mention:agent:npub1fixtureagent) after\nSecond line @[Richard](mention:person:npub1fixtureperson) complete';
      expect(await page.evaluate(model => window.Alpine.store('chat')[model], model)).toBe(expectedBody);
      if (surface === 'task') await page.locator('.task-comment-actions').getByRole('button', { name: 'Post', exact: true }).click();
      else if (surface === 'doc-comment') await page.locator('.doc-thread-new-comment').getByRole('button', { name: 'Post', exact: true }).click();
      else await composer.locator('..').getByRole('button', { name: 'Reply', exact: true }).click();
      await expect.poll(() => writes.length).toBe(1);
      const mentions = [{ type: 'agent', npub: 'npub1fixtureagent', label: 'Rich Agent' }, { type: 'person', npub: 'npub1fixtureperson', label: 'Richard' }];
      expect(writes[0]).toMatchObject({ body: expectedBody, mentions, metadata: { mentions } });
      if (surface === 'doc-reply') expect(writes[0].parent_comment_id).toBe('comment-root');
      await expect.poll(() => page.evaluate(async () => (await window.readCommentFixtureRows()).filter(row => row.body.includes('Second line')).length)).toBe(1);
      expect(await page.evaluate(async () => (await window.readCommentFixtureRows()).find(row => row.body.includes('Second line')))).toMatchObject({ body: expectedBody, pg_metadata: { mentions } });
      await openCommentSurface(page, surface, false);
      if (surface === 'task' && touch) await page.getByRole('button', { name: 'Comments', exact: true }).click();
      const rendered = page.locator(surface === 'task' ? '.task-comments-list' : '.doc-thread-list');
      await expect(rendered).toContainText('Second line');
      const personTag = rendered.locator('[data-mention-type="person"]').filter({ hasText: 'Richard' });
      await expect(personTag).toBeVisible();
      await page.evaluate(() => { window.Alpine.store('chat').openIdentityCard = (_event, npub) => { window.openedCommentIdentity = npub; }; });
      if (touch) await personTag.tap();
      else await personTag.click();
      await expect.poll(() => page.evaluate(() => window.openedCommentIdentity)).toBe('npub1fixtureperson');
      // A canonical tag already on disk uses the same normal click handler.
      const oldTag = rendered.locator('[data-mention-type="agent"]').first();
      if (touch) await oldTag.tap();
      else await oldTag.click();
      await expect.poll(() => page.evaluate(() => window.openedCommentIdentity)).toBe('npub1fixtureagent');
    });
  }
  });
}
