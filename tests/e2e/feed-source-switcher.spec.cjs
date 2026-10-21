const { test, expect } = require('playwright/test');
for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
  test(`source switcher filters and fits ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
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

    }, { url: "https://feed.example.invalid/story" });

    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      const s = Alpine.store('chat');
      s.feedSourceFilter = 'all';
      s.nostrNotificationContext = JSON.stringify([s.currentWorkspaceKey, s.session.npub]);
      s.nostrNotificationItems = [{ key: 'nostr-item', id: 'nostr-item', title: 'Nostr fixture', source_title: 'Nostr fixture', published: '', content: 'Hello', read: false }];
    }, theme);
    const panel = page.getByTestId('deck-wapp-updates');
    const group = panel.getByRole('group', { name: 'Feed source filter' });
    await expect(group).toBeVisible();
    await expect(panel.locator('.wapp-update-card')).toHaveCount(2);
    const rss = group.getByRole('button', { name: 'RSS', exact: true });
    await rss.click();
    await expect(rss).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.wapp-update-card')).toHaveCount(1);
    await expect(panel.getByText('Exact headline', { exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    const nostr = group.getByRole('button', { name: 'Nostr', exact: true });
    await expect(nostr).toBeFocused(); await page.keyboard.press('Enter');
    await expect(nostr).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('Exact headline', { exact: true })).toBeHidden();
    await expect(panel.locator('.wapp-update-card')).toHaveCount(1);
    const all = group.getByRole('button', { name: 'All', exact: true });
    await all.focus(); await page.keyboard.press('Space');
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
    await expect(all).toHaveCSS('outline-style', 'solid');
    await expect(all).toHaveCSS('outline-width', '2px');
    await expect(rss).toHaveAttribute('title', 'Subscribed feeds (RSS)');
    await expect(nostr).toHaveAttribute('title', 'Nostr notifications (Nostrich)');
    await expect(panel.locator('.wapp-update-card')).toHaveCount(2);
    const bounds = await panel.locator('.wapp-updates-heading').evaluate(el => {
      const controls = [el.querySelector('h3'), ...el.querySelectorAll('.feed-source-switcher button'), el.querySelector('[aria-label="Add feed"]'), el.querySelector('[aria-label="Feed options"]')];
      return controls.map(n => { const r = n.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, center:r.y+r.height/2 }; });
    });
    expect(Math.max(...bounds.map(b=>b.center))-Math.min(...bounds.map(b=>b.center))).toBeLessThan(3);
    for (const b of bounds) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x+b.width).toBeLessThanOrEqual(width); }
    for (const b of bounds.slice(1,4)) { expect(b.width).toBeGreaterThanOrEqual(width < 768 ? 44 : 40); expect(b.height).toBeGreaterThanOrEqual(width < 768 ? 44 : 36); }
    console.log('SOURCE_SWITCHER', JSON.stringify({ width, theme, bounds }));
    if (process.env.SOL_EVIDENCE_DIR) await panel.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/source-switcher-${width}-${theme}.png` });
  });
}
