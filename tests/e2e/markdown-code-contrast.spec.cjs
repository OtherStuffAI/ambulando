const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');

// Production renderer and CSS, synthetic content, no backend writes.
const evidence = process.env.SOL_EVIDENCE_DIR;
const source = 'Build started for ambulando\n\t<escape> & preserve whitespace\n' + 'long_line_'.repeat(90);
const highlighted = '// readable comment\nconst greeting = "Hello <world>";\nfunction greet(count = 42) { return greeting + count; }\nconsole.log(greet());';
const surfaces = [
  ['chat', 'chat-post-markdown'],
  ['thread', 'thread-msg-text', 'chat-post-markdown'],
  ['document', 'docs-section', 'doc-preview-surface', 'doc-block-editor-surface', 'doc-block-rendered'],
  ['document comment', 'doc-thread-entry-body'],
  ['task comment', 'task-comment-body'],
  ['document history', 'doc-versioning-preview-content'],
];

async function contrast(page) {
  return page.locator('#code-probe').evaluate(root => {
    const rgb = value => value.match(/[\d.]+/g).map(Number);
    const lum = color => rgb(color).slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((v, c, i) => v + c * [0.2126, 0.7152, 0.0722][i], 0);
    const results = [];
    const visit = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = visit.nextNode())) {
      if (!text.textContent.trim() || text.parentElement.closest('.md-code-copy-status')) continue;
      const node = text.parentElement;
      let ancestor = node, background;
      while (ancestor) {
        background = getComputedStyle(ancestor).backgroundColor;
        if ((rgb(background)[3] ?? 1) === 1) break;
        ancestor = ancestor.parentElement;
      }
      const color = getComputedStyle(node).color;
      const values = [lum(color), lum(background)].sort((a, b) => a - b);
      results.push({ text: text.textContent.slice(0, 30), token: node.className, color, background, ratio: (values[1] + 0.05) / (values[0] + 0.05) });
    }
    return results;
  });
}

for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`code contrast, copy fidelity and local overflow: ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.startsWith('/api/') ? route.abort() : route.continue();
      });
      await page.goto('/');
      await page.waitForFunction(() => window.Alpine?.store('chat')?.routeSyncPaused === false);
      await page.evaluate(theme => window.Alpine.store('appearance').setTheme(theme), theme);
      await page.evaluate(() => {
        const root = document.createElement('div');
        root.id = 'code-probe';
        root.style.cssText = 'position:fixed;inset:64px 12px 12px;z-index:99999;overflow:auto;padding:16px;background:var(--card);color:var(--foreground)';
        document.body.appendChild(root);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedCode = text; } } });
      });
      const measurements = [];
      for (const [label, ...classes] of surfaces) {
        await page.evaluate(({ classes, source, highlighted }) => {
          const root = document.querySelector('#code-probe');
          root.replaceChildren();
          let parent = root;
          for (const className of classes) { const node = document.createElement('div'); node.className = className; parent.appendChild(node); parent = node; }
          parent.innerHTML = window.Alpine.store('chat').renderMarkdown('Inline `safe <code>`\n\n```\n' + source + '\n```\n\n```js\n' + highlighted + '\n```');
          // Exercise every token category, including ones absent from the JS sample.
          const code = parent.querySelectorAll('pre code')[1];
          for (const name of ['quote', 'keyword', 'string', 'number', 'title function_', 'deletion', 'addition', 'meta', 'params']) {
            const span = document.createElement('span'); span.className = 'hljs-' + name; span.dataset.tokenProbe = ''; span.textContent = '\n' + name; code.appendChild(span);
          }
        }, { classes, source, highlighted });
        const probe = page.locator('#code-probe');
        const plain = probe.locator('pre code').first();
        await expect(plain).toHaveText(source, { useInnerText: false });
        expect(await plain.textContent()).toBe(source);
        const geometry = await probe.locator('pre').first().evaluate(pre => {
          pre.scrollLeft = 120;
          const style = getComputedStyle(pre.querySelector('code'));
          return { width: pre.clientWidth, scrollWidth: pre.scrollWidth, scrollLeft: pre.scrollLeft, font: style.fontFamily, whiteSpace: style.whiteSpace, pageOverflow: document.documentElement.scrollWidth > innerWidth };
        });
        expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
        expect(geometry.scrollLeft).toBeGreaterThan(0);
        expect(geometry.font).toMatch(/mono|Consolas/);
        expect(geometry.whiteSpace).toBe('pre');
        expect(geometry.pageOverflow).toBe(false);
        let colors = await contrast(page);
        for (const item of colors) expect(item.ratio, `${label} ${item.token} ${item.text}`).toBeGreaterThanOrEqual(4.5);
        const copy = probe.locator('[data-md-code-copy]').first();
        await copy.hover();
        for (const item of await contrast(page)) expect(item.ratio, `hover ${label} ${item.text}`).toBeGreaterThanOrEqual(4.5);
        await copy.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        expect(await copy.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
        await copy.press('Enter');
        await expect(copy).toHaveAttribute('data-copy-state', 'copied');
        expect(await page.evaluate(() => window.copiedCode)).toBe(source);
        for (const item of await contrast(page)) expect(item.ratio, `copied ${label} ${item.text}`).toBeGreaterThanOrEqual(4.5);
        // Highlighting must preserve actual source (before adding token probes).
        expect(await probe.locator('pre code').nth(1).evaluate(node => [...node.childNodes].filter(n => !n.hasAttribute?.('data-token-probe')).map(n => n.textContent).join(''))).toBe(highlighted);
        await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
        await copy.click();
        await expect(copy).toHaveAttribute('data-copy-state', 'failed');
        for (const item of await contrast(page)) expect(item.ratio, `failed ${label} ${item.text}`).toBeGreaterThanOrEqual(4.5);
        await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedCode = text; }; });
        await probe.locator('[data-token-probe]').evaluateAll(nodes => nodes.forEach(node => node.remove()));
        await probe.locator('[data-md-code-copy]').nth(1).click();
        expect(await page.evaluate(() => window.copiedCode)).toBe(highlighted);
        await probe.locator('pre').evaluateAll(nodes => nodes.forEach(node => { node.scrollLeft = 0; }));
        measurements.push({ surface: label, minimumContrast: Math.min(...colors.map(c => c.ratio)), geometry });
        if (evidence) {
          const file = `${evidence}/${theme}-${width}-${label.replaceAll(' ', '-')}.png`;
          execFileSync('git', ['check-ignore', file]);
          expect(execFileSync('git', ['ls-files', evidence], { encoding: 'utf8' }).trim()).toBe('');
          await fs.mkdir(evidence, { recursive: true });
          await page.screenshot({ path: file, animations: 'disabled' });
        }
      }
      console.log('CODE_CONTRAST', JSON.stringify({ theme, width, measurements }));
    });
  }
}
