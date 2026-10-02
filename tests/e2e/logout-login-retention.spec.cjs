const { test, expect } = require('playwright/test');
const { nip19 } = require('nostr-tools');
const fixture = require('../fixtures/flightdeck-record-delta-v1.json');
const workspaceId = fixture.one_message_delta.changes[0].workspace_id;
const alicePubkey = '11'.repeat(32);
const bobPubkey = '22'.repeat(32);
const alice = nip19.npubEncode(alicePubkey);
const exactCursor = 'opaque:900719925474099312345:browser-exact';

// Production served entry, auth/logout/login handlers, selection, native IndexedDB
// and packaged materialization worker. Signer/authority are deterministic fixtures;
// this does not claim authenticated live-Tower ACL acceptance.
test('served logout/login retains cursor and intent, isolates another signer and supports explicit reset', async ({ page, baseURL }) => {
  const requests = [];
  let firstPage = true;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname.endsWith('/record-sync')) {
      requests.push(url.searchParams.get('cursor'));
      body = { ...fixture.one_message_delta,
        changes: firstPage ? fixture.canonical_upserts.changes : [],
        actors: firstPage ? fixture.canonical_upserts.actors : [],
        next_cursor: exactCursor, has_more: false };
      firstPage = false;
    } else if (url.pathname.endsWith('/resource-view-states')) body = { states: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
  });
  await page.route('https://**', route => route.abort());
  await page.goto(baseURL);
  await page.waitForFunction(() => window.Alpine?.store('chat') && !window.Alpine.store('chat').routeSyncPaused);
  await page.evaluate(({ alice, alicePubkey, workspaceId }) => {
    const s = Alpine.store('chat');
    window.retentionSigner = alicePubkey;
    window.nostr = { getPublicKey: async () => window.retentionSigner,
      signEvent: async event => ({ ...event, pubkey: window.retentionSigner, id: 'a'.repeat(64), sig: 'b'.repeat(128) }) };
    const entry = { workspaceKey: `pg:${alice}::tower:npub1tower::workspace:npub1workspace::app:${s.currentWorkspace?.appNpub || 'flightdeck_pg'}::id:${workspaceId}`,
      workspaceId, workspaceOwnerNpub: 'npub1owner', towerServiceNpub: 'npub1tower',
      workspaceServiceNpub: 'npub1workspace', appNpub: 'flightdeck_pg', pgSessionNpub: alice,
      pgBackendMode: true, directHttpsUrl: 'http://127.0.0.1:3100', name: 'Retention fixture' };
    s.knownWorkspaces = [entry]; s.backendUrl = entry.directHttpsUrl;
    s.navSection = 'chat'; s.selectedBoardId = 'all'; s.routeSyncPaused = true;
    for (const name of ['resolveChatProfile', 'rememberPeople', 'discoverPgOnboardingAnnouncements',
      'discoverPgWorkspaceSelfIndex', 'loadRemoteWorkspaces', 'persistWorkspaceSettings',
      'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery', 'ensureWorkspaceSessionKey',
      'syncWorkspaceProfileDraft', 'validateSelectedBoardId', 'normalizeSettingsTab',
      'updateWorkspaceBootstrapPrompt', 'startSharedLiveQueries', 'ensureBackgroundSync']) s[name] = () => {};
    s.prepareWorkspaceAccessGate = () => false;
    s.verifyPgWorkspaceForSelection = async entry => {
      if (entry.pgSessionNpub !== s.session?.npub) throw new Error('different signer');
      if (window.retentionDenied) throw new Error('workspace_membership_required');
      return entry;
    };
    s.bootstrapSelectedWorkspace = () => s.runTowerPgWorkspaceSync();
    window.retentionEntry = entry;
    window.retentionRead = async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('wingman-fd-ws-' + window.retentionEntry.workspaceKey);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(['channels', 'tasks', 'pending_writes', 'document_drafts', 'sync_state']);
      const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const rows = await Promise.all(['channels', 'tasks', 'pending_writes', 'document_drafts', 'sync_state'].map(name => request(tx.objectStore(name).getAll())));
      db.close(); return rows;
    };
  }, { alice, alicePubkey, workspaceId });
  await page.evaluate(() => Alpine.store('chat').login('extension'));
  expect(await page.evaluate(() => Alpine.store('chat').loginError)).toBeNull();
  expect(requests).toEqual([null]);
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('wingman-fd-ws-' + window.retentionEntry.workspaceKey); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(['pending_writes', 'document_drafts'], 'readwrite');
    tx.objectStore('pending_writes').add({ record_id: 'alice-intent', envelope: { signature_npub: Alpine.store('chat').session.npub } });
    tx.objectStore('document_drafts').put({ draft_key: 'alice-draft', document_id: 'doc', workspace_id: window.retentionEntry.workspaceId, content: 'Alice local intent' });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  });
  const before = await page.evaluate(() => window.retentionRead());
  expect(before[0].length).toBeGreaterThan(0); expect(before[1].length).toBeGreaterThan(0);
  await page.evaluate(() => Alpine.store('chat').logout());
  expect(await page.evaluate(() => ({ session: Alpine.store('chat').session, tasks: Alpine.store('chat').tasks,
    channels: Alpine.store('chat').channels, queue: Alpine.store('chat').pgTaskWriteQueue,
    service: Boolean(Alpine.store('chat')._towerSyncService), worker: Boolean(Alpine.store('chat')._towerPgMaterializationWorker) })))
    .toEqual({ session: null, tasks: [], channels: [], queue: [], service: false, worker: false });
  expect(await page.evaluate(() => window.retentionRead())).toEqual(before);
  await page.evaluate(() => Alpine.store('chat').login('extension'));
  expect(requests).toEqual([null, exactCursor]);
  const same = await page.evaluate(() => window.retentionRead());
  expect(same[0]).toEqual(before[0]); expect(same[1]).toEqual(before[1]);
  expect(same[2]).toEqual(before[2]); expect(same[3]).toEqual(before[3]);
  await page.evaluate(async ({ bobPubkey }) => { await Alpine.store('chat').logout(); window.retentionSigner = bobPubkey; await Alpine.store('chat').login('extension'); }, { bobPubkey });
  expect(await page.evaluate(() => ({ channels: Alpine.store('chat').channels, tasks: Alpine.store('chat').tasks, queue: Alpine.store('chat').pgTaskWriteQueue })))
    .toEqual({ channels: [], tasks: [], queue: [] });
  expect(requests).toEqual([null, exactCursor]);
  await page.evaluate(async ({ alicePubkey }) => {
    await Alpine.store('chat').logout(); window.retentionSigner = alicePubkey;
    Alpine.store('chat').knownWorkspaces = [window.retentionEntry]; window.retentionDenied = true;
    await Alpine.store('chat').login('extension');
  }, { alicePubkey });
  expect(await page.evaluate(() => Alpine.store('chat').channels)).toEqual([]);
  expect(requests).toEqual([null, exactCursor]);
  expect(await page.evaluate(() => window.retentionRead())).toEqual(same);
  await page.evaluate(() => Alpine.store('chat').logout());
  await page.goto(new URL('/?reset=1', baseURL).href);
  await page.waitForURL(url => !url.searchParams.has('reset'));
  const names = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
  expect(names.some(name => name.startsWith('wingman-fd-ws-'))).toBe(false);
  expect(await page.evaluate(() => Alpine.store('chat')?.channels || [])).toEqual([]);
});
