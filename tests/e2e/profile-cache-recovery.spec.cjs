const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');
const { finalizeEvent, getPublicKey, nip19 } = require('nostr-tools');
const fs = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

test('signed kind-0 replaces rendered chat npubs and survives offline reload', async ({ page, context }) => {
  page.on('dialog', dialog => dialog.accept());
  const key = new Uint8Array(32); key[31] = 91;
  const hex = getPublicKey(key); const npub = nip19.npubEncode(hex);
  const metadata = finalizeEvent({ kind: 0, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ name: 'Recovered fixture name', picture: 'https://example.invalid/avatar.png' }) }, key);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).pathname.includes('/assets/profile-worker-')) {
      const script = await fs.readFile(path.join(process.env.FLIGHTDECK_TEST_DIST || path.resolve(__dirname, '../../dist'), new URL(route.request().url()).pathname), 'utf8');
      // Inject only the relay transport into the actual built module worker.
      // Event validation, coalescing, cache writes and UI resolution stay real.
      // Playwright's WebSocket routing does not cover this dedicated worker.
      const socketFixture = `self.fixtureRequests = 0; self.fixturePending = []; self.fixtureRelease = () => { for (const [socket, id] of self.fixturePending.slice(0, 1)) { socket.onmessage?.({data: JSON.stringify(['EVENT', id, ${JSON.stringify(metadata)}])}); socket.onmessage?.({data: JSON.stringify(['EOSE', id])}); } }; self.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send(raw) { const data = JSON.parse(raw); if (data[0] === 'REQ') { self.fixtureRequests++; self.fixturePending.push([this, data[1]]); } } close() { this.readyState = 3; } };`;
      return route.fulfill({ contentType: 'text/javascript', body: socketFixture + '\n' + script });
    }
    return serveBuiltFlightDeck(route);
  });
  async function mount() {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Alpine?.store?.('chat')?.routeSyncPaused === false);
    await page.evaluate(({ npub, hex }) => {
      const s = Alpine.store('chat');
      for (const key of ['startWorkspaceLiveQueries', 'syncRoute', 'performSync', 'requestTowerSyncFamily', 'scheduleStorageImageHydration', 'clearInactiveSectionData']) s[key] = () => {};
      s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
      s.session = { npub: 'npub1isolatedfixture' }; s.backendUrl = 'http://127.0.0.1:3100';
      s.pgBackendMode = false; s.isTowerPgMode = false; s.error = null;
      const row = { record_state: 'active', sync_status: 'synced', created_at: '2026-10-09T01:00:00.000Z', updated_at: '2026-10-09T01:00:00.000Z', version: 1 };
      s.channels = [{ ...row, record_id: 'profile-channel', title: 'Profile fixture', metadata: {} }];
      s.selectedChannelId = 'profile-channel'; s.pgContextSelectedChannelId = 'profile-channel';
      s.messages = [{ ...row, record_id: 'profile-thread', thread_id: 'profile-thread', pg_thread_id: 'profile-thread', parent_message_id: null, channel_id: 'profile-channel', sender_npub: npub, metadata: {}, body: 'Public profile recovery fixture' }];
      s.navSection = 'chat';
      s.openThread('profile-thread', { preserveChannelContext: true, scrollToLatest: false, syncRoute: false });
      const el = document.createElement('div'); el.id = 'profile-fixture'; el.setAttribute('x-data', '{}');
      el.innerHTML = `<span id="npub-name" x-text="$store.chat.getSenderName('${npub}')"></span><span id="hex-name" x-text="$store.chat.getSenderName('${hex}')"></span>`;
      document.body.append(el); Alpine.initTree(el);
    }, { npub, hex });
  }
  await mount();
  await expect(page.locator('.chat-thread-panel')).toBeVisible();
  await expect(page.locator('#npub-name')).toContainText('npub');
  await expect.poll(() => page.workers().some(worker => worker.url().includes('profile-worker-'))).toBe(true);
  const worker = page.workers().find(worker => worker.url().includes('profile-worker-'));
  await expect.poll(() => worker.evaluate(() => self.fixtureRequests)).toBeGreaterThan(0);
  await worker.evaluate(() => self.fixtureRelease());
  await expect(page.locator('.chat-thread-panel')).toContainText('Recovered fixture name');
  await expect(page.locator('#npub-name')).toHaveText('Recovered fixture name');
  await expect(page.locator('#hex-name')).toHaveText('Recovered fixture name');
  await page.waitForFunction(async npub => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wingman-fd-shared'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction('address_book'); const req = tx.objectStore('address_book').get(npub);
    const row = await new Promise(resolve => { req.onsuccess = () => resolve(req.result); }); db.close();
    return row?.label === 'Recovered fixture name';
  }, npub);
  await page.evaluate(() => { const s = Alpine.store('chat'); s.closeThread({ syncRoute: false }); s.navSection = 'status'; });
  await context.setOffline(true);
  await mount(); // shell assets are fulfilled locally; all real network is offline
  await expect(page.locator('.chat-thread-panel')).toContainText('Recovered fixture name');
  await expect(page.locator('#npub-name')).toHaveText('Recovered fixture name');
  await expect(page.locator('#hex-name')).toHaveText('Recovered fixture name');
  expect(await page.evaluate(npub => Alpine.store('chat').getCachedPerson(npub)?.avatar_url, npub)).toBe('https://example.invalid/avatar.png');
});
