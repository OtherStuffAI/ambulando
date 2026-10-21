const { test, expect } = require('playwright/test');
const { serveBuiltFlightDeck } = require('./fixtures/serve-built-flightdeck.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Canvas document reading, updates and exact navigation: ${theme} ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/docs') return route.fulfill({ contentType: 'text/html', body: '<title>Document destination fixture</title>' });
      return serveBuiltFlightDeck(route);
    });
    await page.goto('/canvas.html');
    await page.waitForFunction(() => window.Alpine?.store('canvas')?.status === 'error');
    await page.evaluate(({ theme, width }) => {
      document.documentElement.dataset.theme = theme;
      const store = Alpine.store('canvas');
      store.status = 'ready'; store.error = ''; store.currentWorkspaceKey = 'pg:exact-workspace';
      store.canvas = { title: 'Document reading fixture', can_manage: false };
      store.naplets = [{ id: 'reader', access: 'ready', row_version: 1, title: 'Source brief', source: { type: 'document', id: 'exact-document' }, layout: { x: 16, y: 16, width: Math.min(width - 32, 640), height: 420, z: 1 }, content: { title: 'Source brief', body: '# Heading\n\n- Bullet\n\n1. Ordered\n\n> Quote\n\n[Reference](https://example.com/)\n\n```js\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Answer | 42 |\n\n' + 'Reading paragraph.\n\n'.repeat(80) } }];
    }, { theme, width });
    const doc = page.locator('[data-canvas-key="naplet:reader"]');
    const prose = doc.locator('.ProseMirror');
    await expect(prose).toHaveAttribute('contenteditable', 'false');
    await expect(prose.locator('h1')).toHaveText('Heading');
    await expect(prose.locator('ul li')).toHaveText('Bullet');
    await expect(prose.locator('ol li')).toHaveText('Ordered');
    await expect(prose.locator('blockquote')).toContainText('Quote');
    await expect(prose.locator('pre code')).toHaveText('const answer = 42;');
    await expect(prose.locator('table')).toContainText('Answer');
    await expect(prose.getByRole('link', { name: 'Reference' })).toHaveAttribute('href', 'https://example.com/');
    const scroll = doc.locator('.canvas-document-scroll');
    const before = await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }));
    await scroll.hover(); await page.mouse.wheel(0, 300);
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => ({ ...Alpine.store('canvas').viewport }))).toEqual(before);
    await scroll.focus(); await page.keyboard.type('draft');
    await expect(prose).not.toContainText('draft');
    expect(await page.evaluate(() => Alpine.store('canvas').tool)).toBe('select');
    const geometry = await doc.evaluate(el => {
      const paper = el.querySelector('.canvas-document-paper'), scroll = el.querySelector('.canvas-document-scroll');
      return { background: getComputedStyle(paper).backgroundColor, ink: getComputedStyle(paper).color, bounded: scroll.scrollHeight > scroll.clientHeight, fits: paper.getBoundingClientRect().width <= scroll.getBoundingClientRect().width };
    });
    expect(geometry).toEqual({ background: 'rgb(255, 255, 255)', ink: 'rgb(32, 39, 51)', bounded: true, fits: true });
    await prose.evaluate(el => { el.dataset.retained = 'yes'; });
    const readingPosition = await scroll.evaluate(el => el.scrollTop);
    await page.evaluate(() => { Alpine.store('canvas').naplets[0].content.body += '\n\n## Updated source'; });
    await expect(prose.locator('h2')).toHaveText('Updated source');
    await expect(prose).toHaveAttribute('data-retained', 'yes');
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(readingPosition);
    const destination = context.waitForEvent('page');
    await doc.getByRole('link', { name: 'Open in Ambulando to edit' }).click();
    const opened = await destination;
    await expect(opened).toHaveURL(/\/docs\?workspacekey=pg%3Aexact-workspace&docid=exact-document$/);
    await expect(opened).toHaveTitle('Document destination fixture');
    await opened.close();
    await expect(page).toHaveURL(/canvas\.html$/);
    await page.evaluate(() => { Alpine.store('canvas').naplets = [{ id: 'reader', access: 'denied', layout: { x: 16, y: 16, width: 300, height: 420, z: 1 } }]; });
    await expect(doc.locator('.ProseMirror')).toHaveCount(0);
    await expect(doc.getByRole('link', { name: 'Open in Ambulando to edit' })).toHaveCount(0);
    await expect(doc).toContainText('Ask your workspace owner for access.');
    console.log('CANVAS_DOCUMENT_READING', JSON.stringify({ theme, width, geometry, markdown: true, readOnly: true, containedScroll: true, retainedUpdate: true, exactDocPopup: true, revokedReaderRemoved: true }));
  });
}
