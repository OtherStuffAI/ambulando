const { test, expect } = require('playwright/test');

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }]) {
  test(`Deck Feed and Recent Channels keep headings above scrolling lists at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await page.goto('/');
    await page.waitForFunction(() => window.Alpine?.store('chat'));
    await page.evaluate(() => {
      const store = window.Alpine.store('chat');
      store.session = { npub: 'npub1layoutfixture' };
      store.navSection = 'status';
      store.deckInboxEnabled = true;
    });
    await expect(page.locator('[data-testid="deck-wapp-updates"]')).toBeVisible();
    // Synthetic rendered rows exercise the real shell/CSS without Tower writes.
    await page.evaluate(() => {
      for (const [id, rowClass] of [['deck-wapp-updates', 'wapp-update-card'], ['deck-recent-channels', 'deck-recent-channel-row']]) {
        const body = document.querySelector(`[data-testid="${id}"] .deck-card-scroll`);
        body.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
          const row = document.createElement(id === 'deck-wapp-updates' ? 'article' : 'button');
          row.className = rowClass;
          row.innerHTML = `<div><strong>Fixture ${index}</strong><p>Representative list content with a title and preview.</p></div>`;
          row.style.flexShrink = '0';
          return row;
        }));
      }
    });
    for (const id of ['deck-wapp-updates', 'deck-recent-channels']) {
      const panel = page.locator(`[data-testid="${id}"]`);
      await panel.scrollIntoViewIfNeeded();
      const before = await panel.evaluate(el => {
        const heading = el.querySelector('.autopilot-panel-heading');
        const body = el.querySelector('.deck-card-scroll');
        const outer = document.querySelector('.content-scroll-area-deck');
        const panelStyle = getComputedStyle(el);
        return { headingTop: heading.getBoundingClientRect().top, headingBottom: heading.getBoundingClientRect().bottom, bodyTop: body.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, border: panelStyle.borderTopWidth, padding: panelStyle.paddingLeft, headerBackground: getComputedStyle(heading).backgroundColor, outerHeight: outer.clientHeight, outerScrollHeight: outer.scrollHeight, bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight };
      });
      expect(before.border).toBe('0px');
      expect(before.padding).toBe('0px');
      expect(before.headerBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(before.bodyTop).toBeGreaterThanOrEqual(before.headingBottom - 1);
      expect(before.bodyScrollHeight).toBeGreaterThan(before.bodyHeight);
      await panel.locator('.deck-card-scroll').evaluate(el => { el.scrollTop = 300; });
      const after = await panel.evaluate(el => ({ top: el.querySelector('.autopilot-panel-heading').getBoundingClientRect().top, scrollTop: el.querySelector('.deck-card-scroll').scrollTop, panelScroll: el.scrollTop }));
      expect(after.top).toBe(before.headingTop);
      expect(after.scrollTop).toBeGreaterThan(0);
      expect(after.panelScroll).toBe(0);
      if (viewport.width <= 720) {
        expect(before.outerScrollHeight).toBeLessThanOrEqual(before.outerHeight + 1);
        expect(before.bottom).toBeLessThanOrEqual(viewport.height - 40);
      }
      console.log(JSON.stringify({ viewport, id, before, after }));
    }
    if (viewport.width > 720) {
      const stack = await page.locator('.deck-right-stack').evaluate(el => {
        const [feed, recent] = el.children;
        return { feedBottom: feed.getBoundingClientRect().bottom, recentTop: recent.getBoundingClientRect().top, recentBottom: recent.getBoundingClientRect().bottom, stackBottom: el.getBoundingClientRect().bottom };
      });
      expect(stack.feedBottom).toBeLessThanOrEqual(stack.recentTop);
      expect(stack.recentBottom).toBeLessThanOrEqual(stack.stackBottom + 1);
    }
    const feed = page.locator('[data-testid="deck-wapp-updates"]');
    await feed.scrollIntoViewIfNeeded();
    await feed.getByRole('button', { name: 'Feed options', exact: true }).click();
    await expect(feed.getByRole('dialog', { name: 'Feed options' })).toBeVisible();
    const menu = await feed.getByRole('dialog', { name: 'Feed options' }).boundingBox();
    const bounds = await feed.boundingBox();
    expect(menu.y + menu.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    expect(menu.x).toBeGreaterThanOrEqual(bounds.x);
    expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    await page.screenshot({ path: testInfo.outputPath("feed-channels.png") });
  });
}
