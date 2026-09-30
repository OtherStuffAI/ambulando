// Exercise the production Deck layout rules without a Tower connection.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const css = await readFile('src/styles.css', 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
      <main class="app-shell"><header class="page-header" style="height:56px">Wingman</header><div class="app-layout"><div class="main-content"><div class="content-scroll-area content-scroll-area-deck"><div class="status-section status-section-deck"><section class="flightdeck-summary-overview flightdeck-summary-overview-deck"><div class="deck-columns-track" data-deck-ready>
        <section class="flightdeck-summary-panel flightdeck-summary-panel-inbox deck-column" data-deck-column="inbox"><div class="autopilot-panel-heading inbox-panel-heading" data-deck-mobile-sticky-heading><h3>Inbox</h3><form class="inbox-search-form"><select class="inbox-type-select" aria-label="Inbox type"><option>All</option></select><input aria-label="Search Inbox"><button class="inbox-search-submit" aria-label="Search Inbox">⌕</button></form><button class="deck-new-thread-button" aria-label="New thread">+</button><button class="doc-actions-toggle" aria-label="Inbox read actions">⋮</button></div><div class="deck-card-scroll" tabindex="0" aria-label="Inbox cards">${Array.from({ length: 30 }, (_, i) => `<div class="attention-card">Inbox card ${i}</div>`).join('')}</div></section>
        <div class="deck-right-stack"><section class="flightdeck-summary-panel flightdeck-summary-panel-wapp-updates deck-column"><div class="autopilot-panel-heading" data-deck-mobile-sticky-heading><h3>Feed</h3></div><div class="wapp-updates-body">${Array.from({ length: 25 }, (_, i) => `<div class="attention-card">Feed card ${i}</div>`).join('')}</div></section><section class="flightdeck-summary-panel flightdeck-summary-panel-recent deck-column"><div class="autopilot-panel-heading" data-deck-mobile-sticky-heading><h3>Recent channels</h3></div><div class="deck-card-scroll" tabindex="0" aria-label="Recent channels">${Array.from({ length: 25 }, (_, i) => `<div class="attention-card">Recent card ${i}</div>`).join('')}</div></section></div>
      </div><nav class="deck-mobile-pagination">••••</nav></section></div></div></div><nav class="mobile-section-switcher"><button class="mobile-section-switcher-btn">Navigation</button></nav></main></body></html>`,
  }));
  for (const [width, height] of [[375, 812], [390, 667], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://deck-layout-fixture.test/');
    const result = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const outer = document.querySelector('.content-scroll-area');
      const cards = document.querySelector('[data-deck-column="inbox"] .deck-card-scroll');
      const heading = document.querySelector('[data-deck-column="inbox"] .inbox-panel-heading');
      const before = heading.getBoundingClientRect().top;
      cards.scrollTop = 400;
      const surfaces = [...document.querySelectorAll('.deck-column')].map((panel) => {
        const header = panel.querySelector('.autopilot-panel-heading');
        const body = panel.querySelector('.deck-card-scroll, .wapp-updates-body');
        const top = header.getBoundingClientRect().top;
        body.scrollTop = 300;
        return { bodyScrollTop: body.scrollTop, headerShift: header.getBoundingClientRect().top - top, bodyTop: body.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom };
      });
      return { surfaces, outerScrollHeight: outer.scrollHeight, outerClientHeight: outer.clientHeight,
        cardsScrollTop: cards.scrollTop, headingShift: heading.getBoundingClientRect().top - before,
        cardsTop: cards.getBoundingClientRect().top, headerBottom: heading.getBoundingClientRect().bottom,
        deckBottom: box('[data-deck-column="inbox"]').bottom,
        navTop: box('.mobile-section-switcher').top,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(result.cardsScrollTop > 0 && Math.abs(result.headingShift) < 1);
    assert(result.surfaces.every(s => s.bodyScrollTop > 0 && Math.abs(s.headerShift) < 1 && s.bodyTop >= s.headerBottom - 1));
    assert(result.cardsTop >= result.headerBottom - 1);
    assert(!result.horizontalOverflow);
    if (width <= 720) {
      assert(result.outerScrollHeight <= result.outerClientHeight + 1, 'Outer Deck must not scroll');
      assert(result.deckBottom <= result.navTop + 1, 'Deck must fit above mobile navigation');
      assert(result.navTop - result.deckBottom < 40, 'Deck should fill available height');
    }
    results.push({ width, height, ...result });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
