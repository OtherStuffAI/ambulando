const { test, expect } = require('playwright/test');
test.setTimeout(45000);
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
      s.subscribedFeedSources = [{ id: 'sub', key: 'sub', title: 'Book fixture', status: 'active', source: { kind: 'public', url: 'https://feed.example.invalid/feed.json' } }];
      s.subscribedFeedStatus = [{ subscription_id: 'sub', stale: true, error: 'source_unavailable' }];
      s.subscribedFeedItems = [{ key: 'item', id: 'edition:1', subscription_id: 'sub', title: 'Exact headline', source_title: 'Book fixture', url, summary: '<img src="https://tracking.example.invalid/pixel" onerror="window.bad=true">Inert summary', text: '', published: '', attachments: [{ title: 'Podcast', mime_type: 'audio/mpeg', duration_in_seconds: 30 }], read: false, saved: false, dismissed: false }];
      window.feedRefreshes = 0; s.refreshSubscribedFeed = () => { window.feedRefreshes++; }; s.setFeedSubscriptionStatus = (source, status) => { source.status = status; }; window.feedOpens = []; window.feedFlags = []; window.open = (...args) => { window.feedOpens.push(args); return null; };
      s.setFeedFlag = (item, field, value) => { window.feedFlags.push({ field, value }); item[field] = value; };

    }, { url: headlineUrl });
    // The reader body has aria-label but no explicit region role.
    const body = page.locator('.feeds-reader'); await expect(body).toBeVisible();
    await expect(body.getByText('Exact headline', { exact: true })).toBeVisible();
    await expect(body.locator('img, iframe, audio, video')).toHaveCount(0); expect(destinations).toEqual([]);
    const options = page.locator('.feed-options-menu').getByRole('button', { name: 'Feed options', exact: true });
    await expect(body.getByRole('menuitem', { name: 'Mark read', exact: true })).toBeHidden();
    await expect(body.getByText('Sources', { exact: true })).toBeHidden();
    await options.click(); await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
    expect(await page.evaluate(() => window.feedRefreshes)).toBe(1);
    await options.click(); await page.getByRole('menuitemcheckbox', { name: 'Show dismissed', exact: true }).click();
    expect(await page.evaluate(() => window.Alpine.store('chat').showDismissedFeeds)).toBe(true);
    await options.click(); await page.getByRole('menuitem', { name: 'Manage sources', exact: true }).click();
    await expect(body.getByText('Sources', { exact: true })).toBeVisible();
    await body.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
    await expect(body.getByRole('button', { name: 'Resubscribe', exact: true })).toBeVisible();
    await body.getByRole('button', { name: 'Resubscribe', exact: true }).click();
    await body.getByRole('button', { name: 'Close sources', exact: true }).click();
    const actions = body.getByRole('button', { name: 'Actions for Exact headline', exact: true });
    await actions.click(); await expect(body.getByRole('menuitem', { name: 'Mark read', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(body.getByRole('menuitem', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(actions).toBeFocused();
    await actions.click(); await body.getByRole('menuitem', { name: 'Mark read', exact: true }).click();
    await actions.click(); await body.getByRole('menuitem', { name: 'Save', exact: true }).click();
    await actions.click(); await expect(body.getByRole('menu')).toBeVisible(); const menuBounds = await body.getByRole('menu').boundingBox();
    expect(menuBounds.x).toBeGreaterThanOrEqual(0); expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
    await body.locator('.feed-item-source').click(); await expect(body.getByRole('menu')).toBeHidden();
    // Even a short final card can reveal its menu inside the scroll viewport.
    await body.evaluate(el => { el.style.maxHeight = '150px'; el.style.overflowY = 'auto'; });
    await page.evaluate(() => { window.Alpine.store('chat').subscribedFeedItems[0].summary = 'Short summary'; });
    await actions.click(); const dismiss = body.getByRole('menuitem', { name: 'Dismiss', exact: true });
    await dismiss.scrollIntoViewIfNeeded(); await expect(dismiss).toBeInViewport();
    expect(await dismiss.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    await page.keyboard.press('Escape'); await body.evaluate(el => { el.style.maxHeight = ''; el.style.overflowY = ''; });
    if (process.env.FEED_WIDGET_SCREENSHOTS) await page.locator('[data-testid="deck-wapp-updates"]').screenshot({ path: `/tmp/feed-widget-after-${viewport.width}.png` });
    expect(await page.evaluate(() => window.feedOpens.length)).toBe(0); expect(destinations).toEqual([]);
    await body.getByRole('button', { name: 'Exact headline', exact: true }).click();
    expect(await page.evaluate(() => window.feedOpens)).toEqual([[headlineUrl, '_blank', 'noopener,noreferrer']]);
    expect(destinations).toEqual([]); expect(await page.evaluate(() => Boolean(window.bad))).toBe(false);
    await expect(page.getByLabel('Feed view')).toHaveCount(0);
    const width = await body.evaluate(el => el.getBoundingClientRect().width); expect(width).toBeLessThanOrEqual(viewport.width);
    await page.locator('[data-testid="deck-wapp-updates"]').getByRole('button', { name: 'Add feed', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Add feed', exact: true })).toBeVisible();
    await expect(page.getByLabel('Feed URL', { exact: true })).toBeVisible(); await expect(page.getByText(/Paste a JSON Feed or RSS URL/)).toBeVisible(); await expect(page.getByRole('dialog', { name: 'Add feed' }).locator('select')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close add feed', exact: true }).click();
    expect(await page.evaluate(() => window.feedFlags.map(f => f.field))).toEqual(['read', 'saved']);
  });
}

for (const width of [1440, 390]) for (const format of ['json', 'rss']) {
  test(`Feeds URL validates and survives reload: ${format}, ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { generateSecretKey, getPublicKey, nip19 } = await import('nostr-tools');
    const secret = generateSecretKey(), pubkey = getPublicKey(secret), npub = nip19.npubEncode(pubkey);
    const workspaceId = '00000000-0000-4000-8000-000000000001', subscriptionId = '00000000-0000-4000-8000-000000000003';
    let subscriptionBody, sourceRequests = 0, registryRequests = 0;
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
      if (url.pathname.includes('/api/wapps')) registryRequests++;
      if (url.pathname.endsWith('/me')) return route.fulfill({ json: { actor: { actor_id: 'fixture-actor', npub }, identity: { workspace_id: workspaceId } } });
      if (url.hostname === 'feed.example.invalid') {
        sourceRequests++; expect(req.headers().authorization).toBeUndefined(); expect(req.headers().cookie).toBeUndefined();
        return route.fulfill(format === 'json' ? { json: { version: 'https://jsonfeed.org/version/1.1', title: 'Example', items: [{ id: 'one', title: 'Persistent headline', content_text: 'Hello' }] } } : { contentType: 'application/rss+xml', body: '<rss version="2.0"><channel><title>Example</title><item><guid>one</guid><title>Persistent headline</title><description>Hello</description></item></channel></rss>' });
      }
      if (url.pathname.endsWith('/feed-subscriptions') && req.method() === 'POST') {
        subscriptionBody = req.postDataJSON();
        return route.fulfill({ json: { subscription: { schema_version: 1, id: subscriptionId, workspace_id: workspaceId, reader_actor_id: 'fixture-actor', source: subscriptionBody.source, title: 'Example', status: 'active', row_version: 1 } } });
      }
      if (url.pathname.endsWith('/item-states') && req.method() === 'PUT') {
        const body = req.postDataJSON(); return route.fulfill({ json: { item_state: { id: 'state-one', schema_version: 1, workspace_id: workspaceId, reader_actor_id: 'fixture-actor', subscription_id: subscriptionId, item_id: body.item_id, read: true, saved: true, dismissed: true, row_version: 1 } } });
      }
      return route.abort();
    });
    const configure = async ({ workspaceId, npub, pubkey, secretHex }) => {
      const s = window.Alpine.store('chat'); s.stopBackgroundSync?.(); s.stopAllLiveQueries?.();
      for (const method of ['startSharedLiveQueries', 'syncRoute', 'performSync', 'ensureWorkspaceSessionKey', 'loadLocalWorkspaceCoreData', 'persistWorkspaceSettings', 'refreshWorkspaceSettings', 'refreshLegacyWorkspaceRecovery', 'syncWorkspaceProfileDraft', 'validateSelectedBoardId']) s[method] = () => {};
      s.requestTowerSyncFamily = async () => {};
      s.session = { npub, pubkey, method: 'secret' }; s.ownerNpub = 'owner'; s.navSection = 'status';
      localStorage.setItem('nostr_secure_auth_recovery_v1', JSON.stringify({ method: 'secret', pubkey, secretHex }));
      s.knownWorkspaces = [{ workspaceKey: 'feeds-fixture', workspaceId, workspaceOwnerNpub: 'owner', directHttpsUrl: 'https://tower.example.invalid', pgBackendMode: true, pgSessionNpub: npub, pgMe: { actor: { actor_id: 'fixture-actor', npub }, identity: { workspace_id: workspaceId } } }];
      await s.selectWorkspace('feeds-fixture', { pgVerified: true });
      s.subscribedFeedView = 'legacy'; // An old client preference cannot gate startup.
      s.showConnectModal = false; s.showWorkspaceBootstrapModal = false;
      await s.activateFeeds();
    };
    const fixture = { workspaceId, npub, pubkey, secretHex: Buffer.from(secret).toString('hex') };
    await page.goto('/'); await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat'))); await page.evaluate(configure, fixture); console.log('feeds-stage', format, width, 'configured');
    await page.locator('[data-testid="deck-wapp-updates"]').getByRole('button', { name: 'Add feed', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add feed', exact: true }); await expect(dialog.locator('select')).toHaveCount(0);
    await dialog.getByLabel('Feed URL').fill(`https://feed.example.invalid/feed.${format}`); await dialog.getByRole('button', { name: 'Add feed', exact: true }).click();
    await expect(dialog).toBeHidden(); console.log('feeds-stage', format, width, 'subscribed'); expect(subscriptionBody.source.kind).toBe('public'); expect(subscriptionBody.source.format).toBe(format === 'rss' ? 'rss' : 'jsonfeed-1.1'); expect(registryRequests).toBe(0);
    const reader = page.locator('.feeds-reader'); await expect(reader.getByText('Persistent headline', { exact: true })).toBeVisible(); expect(sourceRequests).toBeGreaterThanOrEqual(2);
    console.log('feeds-stage', format, width, 'rendered'); await page.evaluate(async () => { const s = window.Alpine.store('chat'); const item = s.subscribedFeedItems[0]; await s.setFeedFlag(item, 'saved', true); });
    await expect(reader.getByRole('button', { name: 'Unsave', exact: true })).toHaveCount(0); // dismissed by fixture state
    await page.evaluate(() => localStorage.removeItem('nostr_secure_auth_recovery_v1')); await page.reload(); await page.waitForFunction(() => Boolean(window.Alpine?.store?.('chat'))); await page.evaluate(configure, fixture);
    console.log('feeds-stage', format, width, 'reloaded');
    const widget = page.locator('[data-testid="deck-wapp-updates"]');
    await widget.getByRole('button', { name: 'Feed options', exact: true }).click();
    await widget.getByRole('menuitemcheckbox', { name: 'Show dismissed', exact: true }).click();
    await expect(reader.getByText('Persistent headline', { exact: true })).toBeVisible();
    await reader.getByRole('button', { name: 'Actions for Persistent headline', exact: true }).click();
    await expect(reader.getByRole('menuitem', { name: 'Unsave', exact: true })).toBeVisible();
    await expect(reader.getByRole('menuitem', { name: 'Mark unread', exact: true })).toBeVisible();
    await expect(reader.getByRole('menuitem', { name: 'Restore', exact: true })).toBeVisible();
  });
}
