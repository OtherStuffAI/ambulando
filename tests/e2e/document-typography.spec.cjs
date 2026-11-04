const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Synthetic document content with the real editor/renderer and served production
// styles. These probes do not assert authenticated Tower save/delivery.
for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`document list typography: ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/');
      await page.waitForFunction(() => window.Alpine?.store('appearance'));
      const asset = fs.readdirSync(path.resolve('dist/assets')).find(name => /^tiptap-editor-adapter-.*\.js$/.test(name));
      expect(asset).toBeTruthy();
      const html = '<h1>Document heading</h1><p>Comfortable reading text.</p>'
        + '<ul><li><p>Loose bullet with enough text to wrap onto multiple lines at a narrow reading width, keeping every continuation aligned with the text.</p>'
        + '<p>Second paragraph in the same item.</p><ol><li><p>Nested ordered text with a long continuation that wraps too.</p></li></ol></li>'
        + '<li><p>Next bullet.</p></li></ul><ol start="10"><li><p>Ordered loose paragraph with enough words to wrap and retain its hanging indent.</p></li></ol>'
        + '<ul><li>Tight bullet text<ul><li>Nested tight bullet</li></ul></li></ul><h4>Small heading</h4><p><a href="https://example.com">A link</a></p>';
      await page.evaluate(async ({ html, theme, asset }) => {
        window.Alpine.store('appearance').setTheme(theme);
        const probe = document.createElement('section');
        probe.className = 'docs-section';
        probe.style.cssText = 'position:fixed;inset:64px 0 0;z-index:9999;overflow:auto';
        probe.innerHTML = '<div class="doc-preview-surface"><div class="doc-rich-editor"></div></div>';
        document.body.appendChild(probe);
        const { createTiptapEditorAdapter } = await import(`/assets/${asset}`);
        window.typographyAdapter = createTiptapEditorAdapter({ element: probe.querySelector('.doc-rich-editor'), editable: true });
        window.typographyAdapter.editor.commands.setContent(html);
        const read = document.createElement('div');
        read.className = 'doc-block-rendered';
        read.id = 'typography-read';
        read.innerHTML = html;
        // Use the same paper ancestor as the editor, without replacing app data.
        document.querySelector('.doc-rich-editor').appendChild(read);
      }, { html, theme, asset });
      for (const scale of [1, 1.25]) {
        await page.locator('.doc-rich-editor').evaluate((node, scale) => { node.style.zoom = scale; }, scale);
        const result = await page.evaluate(() => {
          return ['.ProseMirror', '#typography-read'].map(selector => {
            const root = document.querySelector(selector);
            const style = getComputedStyle(root);
            return {
              size: style.fontSize, line: style.lineHeight,
              items: [...root.querySelectorAll('li')].map(li => {
                const paragraph = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
                const range = document.createRange();
                range.selectNodeContents(paragraph);
                const lines = [...range.getClientRects()];
                const first = lines[0];
                const box = paragraph.getBoundingClientRect();
                const list = getComputedStyle(li.parentElement);
                const textStyle = getComputedStyle(paragraph);
                return { size: textStyle.fontSize, line: textStyle.lineHeight,
                  position: list.listStylePosition, indent: parseFloat(list.paddingInlineStart),
                  firstLineOffset: first.top - box.top,
                  paragraphOffset: box.top - li.getBoundingClientRect().top,
                  hanging: paragraph === li || lines.every(line => Math.abs(line.left - first.left) < 1),
                  display: getComputedStyle(li).display };
              }),
              h4: getComputedStyle(root.querySelector('h4')).fontSize,
            };
          });
        });
        console.log('document typography', { width, theme, scale, result });
        if (process.env.SOL_EVIDENCE_DIR && scale === 1) {
          await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/web-lists-${theme}-${width}.png` });
          await page.locator('#typography-read').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/web-lists-read-${theme}-${width}.png` });
        }
        for (const surface of result) {
          expect(surface.size).toBe('16px');
          expect(surface.line).toBe('25.6px');
          expect(surface.h4).toBe('14.72px');
          for (const item of surface.items) {
            expect(item.size).toBe(surface.size);
            expect(item.line).toBe(surface.line);
            expect(item.position).toBe('outside');
            expect(item.indent).toBe(24);
            expect(item.display).toBe('list-item');
            expect(item.firstLineOffset).toBeLessThan(12);
            expect(item.paragraphOffset).toBe(0);
            expect(item.hanging).toBe(true);
          }
        }
      }
      const editor = page.locator('.ProseMirror');
      await editor.locator('li p').first().click();
      await page.keyboard.press('Home');
      await page.keyboard.type('Edited ');
      await expect(editor).toContainText('Edited ');
      await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
      const roundTrip = await page.evaluate(() => {
        const adapter = window.typographyAdapter;
        const saved = adapter.getContentModel();
        adapter.setContent(saved.editor_state);
        return { text: adapter.editor.getText(), listCount: adapter.editor.view.dom.querySelectorAll('li').length };
      });
      expect(roundTrip.text).toContain('Edited ');
      expect(roundTrip.listCount).toBe(6);
    });
  }
}
