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
