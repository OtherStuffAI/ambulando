const { test, expect } = require('playwright/test');
const headlineUrl = 'https://book.example.invalid/?story=exact%20headline%20%26%20question%3F';
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`subscribed reader deliberate links and inert cards ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const destinations = [];
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.hostname === 'book.example.invalid' || u.hostname === 'tracking.example.invalid') destinations.push(u.href);
      if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return route.abort();
      return route.continue();
    });
    await page.goto('/'); await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
    await page.evaluate(({ url }) => {
      const s = window.Alpine.store('chat'); s.stopBackgroundSync?.(); s.stopAllLiveQueries?.();
      s.startWorkspaceLiveQueries = () => {}; s.syncRoute = () => {}; s.performSync = () => {}; s.requestTowerSyncFamily = () => {};
      s.openConnectModal = () => {}; s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
      s.session = { npub: 'npub1syntheticreader' }; s.ownerNpub = 'npub1syntheticreader'; s.workspaceOwnerNpub = 'npub1syntheticreader';
      s.pgBackendMode = false; s.isTowerPgMode = false; s.navSection = 'status';
      s.subscribedFeedView = 'subscribed'; s.subscribedFeedSources = [{ id: 'sub', key: 'sub', title: 'Book fixture', status: 'active', source: { kind: 'public', url: 'https://feed.example.invalid/feed.json' } }];
      s.subscribedFeedStatus = [{ subscription_id: 'sub', stale: true, error: 'source_unavailable' }];
      s.subscribedFeedItems = [{ key: 'item', id: 'edition:1', subscription_id: 'sub', title: 'Exact headline', source_title: 'Book fixture', url, summary: '<img src="https://tracking.example.invalid/pixel" onerror="window.bad=true">Inert summary', text: '', published: '', attachments: [{ title: 'Podcast', mime_type: 'audio/mpeg', duration_in_seconds: 30 }], read: false, saved: false, dismissed: false }];
      window.feedOpens = []; window.feedFlags = []; window.open = (...args) => { window.feedOpens.push(args); return null; };
      s.setFeedFlag = (item, field, value) => { window.feedFlags.push({ field, value }); item[field] = value; };
      s.openFeedAdd = () => { s.feedAddOpen = true; s.feedApps = [{ key: 'app', title: 'Permitted app', connection: { display_name: 'Connected instance' } }]; };
    }, { url: headlineUrl });
    // The reader body has aria-label but no explicit region role.
    const body = page.locator('.subscribed-feed'); await expect(body).toBeVisible();
    await expect(body.getByText('Exact headline', { exact: true })).toBeVisible();
    await expect(body.locator('img, iframe, audio, video')).toHaveCount(0); expect(destinations).toEqual([]);
    await body.getByRole('button', { name: 'Mark read', exact: true }).click(); await body.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await page.evaluate(() => window.feedOpens.length)).toBe(0); expect(destinations).toEqual([]);
    await body.getByRole('button', { name: 'Exact headline', exact: true }).click();
    expect(await page.evaluate(() => window.feedOpens)).toEqual([[headlineUrl, '_blank', 'noopener,noreferrer']]);
    expect(destinations).toEqual([]); expect(await page.evaluate(() => Boolean(window.bad))).toBe(false);
    await expect(page.locator('.wapp-updates-body[aria-label="Feed"]')).toBeHidden();
    const width = await body.evaluate(el => el.getBoundingClientRect().width); expect(width).toBeLessThanOrEqual(viewport.width);
    await page.getByRole('button', { name: 'Add feed', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Add feed', exact: true })).toBeVisible();
    await expect(page.getByLabel('Public feed URL', { exact: true })).toBeVisible(); await expect(page.getByText(/Public sources must allow direct browser CORS/)).toBeVisible();
    await page.getByRole('button', { name: 'Close add feed', exact: true }).click();
    expect(await page.evaluate(() => window.feedFlags.map(f => f.field))).toEqual(['read', 'saved']);
  });
}

for (const width of [1440, 390]) {
  test(`Feed picker uses canonical actor and Agents registry ${width}`, async ({ page }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width, height: 1000 });
    const { generateSecretKey, getPublicKey, nip19 } = await import('nostr-tools');
    const secret = generateSecretKey(), pubkey = getPublicKey(secret), npub = nip19.npubEncode(pubkey);
    const workspaceId = '00000000-0000-4000-8000-000000000001', connectionId = '00000000-0000-4000-8000-000000000002', installationId = '00000000-0000-4000-8000-000000000003';
    let registryRequests = 0, registryFail = true, subscriptionBody, meRequests = 0;
    const signedUrls = [];
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
      const auth = req.headers().authorization;
      if (auth?.startsWith('Nostr ')) signedUrls.push(JSON.parse(Buffer.from(auth.slice(6), 'base64').toString()).tags.find(t => t[0] === 'u')?.[1]);
      if (url.pathname.endsWith('/me')) { meRequests++; return route.fulfill({ json: { actor: { actor_id: 'fixture-actor', npub }, identity: { workspace_id: workspaceId } } }); }
      if (url.hostname === 'agents.example.invalid') {
        registryRequests++;
        if (registryFail) return route.abort('failed');
        return route.fulfill({ json: { wapps: [{ wappInstallationId: installationId, title: 'Book of Sand', launchUrl: 'https://book.example.invalid', appNpub: 'app' }] } });
      }
      if (url.pathname === '/api/feed/read-targets') {
        const target = label => `https://tower.example.invalid/api/v4/graph/nodes?workspace_owner_npub=owner&source_app_npub=app&visibility=personal&label=${label}&limit=200&offset=0`;
        return route.fulfill({ json: { graph_read_targets: { stories: target('Story'), history: target('Reference') } } });
      }
      if (url.pathname === '/feed/editions') return route.fulfill({ json: { version: 'https://jsonfeed.org/version/1.1', title: 'Editions', feed_url: 'https://book.example.invalid/feed/editions', items: [{ date_published: '2026-10-01T00:00:00Z', id: 'edition:fixture', title: 'Completed edition headline', url: 'https://book.example.invalid/?story=exact-headline', content_text: 'Fixture edition summary' }] } });
      if (url.pathname === '/feed/list') return route.fulfill({ json: { contract_version: 1, feeds: [{ id: 'editions', title: 'Editions', description: 'Completed editions', endpoint: '/feed/editions', format: 'jsonfeed-1.1' }], next_cursor: null } });
      if (url.pathname.endsWith('/feed-subscriptions') && req.method() === 'POST') {
        subscriptionBody = req.postDataJSON();
        return route.fulfill({ json: { subscription: { schema_version: 1, id: installationId, workspace_id: workspaceId, reader_actor_id: 'fixture-actor', source: subscriptionBody.source, title: 'Editions', status: 'active', row_version: 1 } } });
      }
      return route.abort();
    });
    await page.goto('/'); await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat')));
    await page.evaluate(async ({ workspaceId, connectionId, npub, pubkey, secretHex, width }) => {
      const s = window.Alpine.store('chat'); s.stopBackgroundSync?.(); s.stopAllLiveQueries?.();
      for (const method of ['startSharedLiveQueries', 'startWorkspaceLiveQueries', 'syncRoute', 'performSync', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery', 'syncWorkspaceProfileDraft', 'validateSelectedBoardId']) s[method] = () => {};
      s.requestTowerSyncFamily = async () => {};
      s.session = { npub, pubkey, method: 'secret' }; s.ownerNpub = 'owner'; s.navSection = 'status';
      localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'secret', pubkey, secretHex }));
      s.knownWorkspaces = [{ workspaceKey: 'picker-fixture', workspaceId, workspaceOwnerNpub: 'owner', directHttpsUrl: 'https://tower.example.invalid', pgBackendMode: true, pgSessionNpub: npub, pgMe: { actor: { actor_id: 'fixture-actor', npub }, identity: { workspace_id: workspaceId } } }];
      await s.selectWorkspace('picker-fixture', { pgVerified: true });
      if (width === 390) delete s.currentWorkspace.pgMe;
      await s.openFeedAdd(); s.closeFeedAdd();
      const request = indexedDB.open('wingman-fd-ws-picker-fixture');
      await new Promise((resolve, reject) => { request.onerror = reject; request.onsuccess = () => {
        const db = request.result, tx = db.transaction('autopilot_connections', 'readwrite');
        tx.objectStore('autopilot_connections').put({ id: connectionId, workspace_id: workspaceId, pg_backend: true, display_name: 'Connected Autopilot', https_endpoint: 'https://agents.example.invalid', fips_endpoint: 'http://npub-node.fips:3601' });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject;
      }; });
      s.subscribedFeedView = 'subscribed'; s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
    }, { workspaceId, connectionId, npub, pubkey, width, secretHex: Buffer.from(secret).toString('hex') });
    await page.getByRole('button', { name: 'Add feed', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add feed', exact: true });
    await expect(dialog.getByText(/browser CORS settings/)).toBeVisible();
    registryFail = false; await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.getByLabel('Feed app')).toBeEnabled();
    await dialog.getByLabel('Feed app').selectOption({ label: 'https://agents.example.invalid · Book of Sand' });
    await expect(dialog.getByRole('button', { name: 'Subscribe to Editions' })).toBeVisible();
    await expect(dialog.getByRole('status')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Subscribe to Editions' })).toBeEnabled();
    const bounds = await dialog.boundingBox(); expect(bounds.width).toBeLessThanOrEqual(width); expect(bounds.x).toBeGreaterThanOrEqual(0);
    if (process.env.FEED_PICKER_SCREENSHOTS) await dialog.screenshot({ path: require('node:path').join(process.env.FEED_PICKER_SCREENSHOTS, `feed-picker-${width}.png`) });
    expect(registryRequests).toBe(2);
    await dialog.getByRole('button', { name: 'Subscribe to Editions' }).click(); await expect(dialog).toBeHidden();
    expect(subscriptionBody.source.autopilot_connection_id).toBe(connectionId); expect(subscriptionBody.source.feed_id).toBe('editions');
    expect(subscriptionBody.reader_actor_id).toBeUndefined(); expect(meRequests).toBe(width === 390 ? 1 : 0);
    await expect(page.locator('.subscribed-feed').getByText('Completed edition headline', { exact: true })).toBeVisible();
    expect(signedUrls).toContain('https://book.example.invalid/feed/list?limit=100');
    // Synthetic local signer and routed source responses; no claim of human ACL or live CORS proof.
  });
}
