const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Production CSS and notification/preview constructors; synthetic content only.
// No server, credentials or backend traffic is required for this style audit.
test.setTimeout(30_000);
const root = path.resolve(__dirname, '../..');
const sourceCss = () => ['ambulando-tokens.css', 'styles.css', 'sol.css', 'pipeline-viewer.css']
  .map(file => fs.readFileSync(path.join(root, 'src', file), 'utf8').replace(/@import[^;]+;/g, '')).join('\n');
function css() {
  if (process.env.SOL_CONTRAST_DIST !== '1') return sourceCss();
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  return [...html.matchAll(/href="(\/assets\/[^" ]+\.css)"/g)]
    .map(match => fs.readFileSync(path.join(root, 'dist', match[1]), 'utf8')).join('\n');
}
const constructors = execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { buildSync } from 'esbuild';
  process.stdout.write(buildSync({ stdin: {
    contents: 'export * from "./src/version-check.js"; export * from "./src/image-modal.js";', resolveDir: ${JSON.stringify(root)},
  }, bundle: true, write: false, format: 'iife', globalName: 'ContrastUI',
    define: { 'import.meta.env.DEV': 'true' }, logLevel: 'silent' }).outputFiles[0].text);
`], { cwd: root, encoding: 'utf8' });
const scopeLevels = ['l1', 'l2', 'l3', 'l4', 'l5', 'product', 'project', 'deliverable', 'none', 'unscoped'];
const docRows = ['normal', 'selected'].map(state => `<li class="doc-item ${state === 'selected' ? 'doc-item-selected' : ''}" data-doc-row="${state}">
  <div class="doc-table-name-cell"><span class="doc-item-title" data-contrast="document title ${state}">Review document</span><div class="doc-item-meta">
  ${scopeLevels.map(level => `<button type="button" class="doc-scope-pill-btn"><span class="doc-scope-pill doc-scope-pill-compact doc-scope-pill-${level}" data-contrast="scope ${level} ${state}">Wingman Suite</span></button>`).join('')}
  </div></div><time class="doc-table-timestamp" data-contrast="document time ${state}">Today</time></li>`).join('');
const fixtures = `
<div class="page-header"><h1 data-contrast="header">Ambulando</h1><span class="sol-brand-tagline" data-contrast="tagline">Solvitur Ambulando</span></div>
<div class="settings-panel" style="padding:12px">
<p class="auth-description" data-contrast="secondary">Workspace information</p>
<input placeholder="Search workspaces" data-contrast="placeholder"><textarea placeholder="Write a comment" data-contrast="textarea placeholder"></textarea>
<button class="btn-primary" data-contrast="primary">Save</button><button class="btn-secondary" data-contrast="secondary button">Cancel</button>
<button class="copy-button copied" data-contrast="copied">Copied!</button>
<p class="settings-success" data-contrast="success">Saved</p><p class="settings-error" data-contrast="error">Could not save</p>
<div class="error-bar"><span data-contrast="error bar">Connection failed</span><button class="error-bar-dismiss" data-contrast="error dismiss">×</button></div>
<div class="access-section-tabs"><button role="tab" aria-selected="false" data-contrast="tab">Members</button><button role="tab" aria-selected="true" data-contrast="selected tab">Groups</button></div>
<span class="wapp-publishing-status-active" data-contrast="active badge">Active</span><span class="wapp-publishing-status-disabled" data-contrast="disabled badge">Disabled</span>
<button class="group-action-item group-action-delete" data-contrast="delete">Delete group</button>
</div>
<div class="agent-activity agent-activity-channel"><button class="agent-activity-toggle"><span class="agent-activity-title" data-contrast="activity title">Working</span><span class="agent-activity-summary" data-contrast="activity secondary">Checking records</span></button></div>
<div class="docs-section"><div class="docs-header"><h2 data-contrast="docs header">Documents</h2><span class="doc-table-timestamp" data-contrast="timestamp">Today</span></div>
<ul class="doc-items" style="display:block">${docRows}</ul><div class="doc-preview-surface"><div class="doc-block-editor-surface"><p data-contrast="paper ink">White document paper</p><a data-contrast="paper link">Reference</a></div></div></div>
<div class="thread-message"><button class="thread-load-more-btn chat-archived-toggle-btn" data-contrast="history">Show archived messages</button><button class="task-copy-btn task-edit-btn" data-contrast="edit">Edit</button></div>`;

async function measure(locator, property = 'color', pseudo = null) {
  return locator.evaluate((node, { property, pseudo }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const c = [...ctx.getImageData(0, 0, 1, 1).data]; c[3] /= 255; return c; };
    const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
    const ancestors = []; for (let p = node; p; p = p.parentElement) ancestors.unshift(p);
    let background = [255, 255, 255], opacity = 1;
    if (property === 'outlineColor' && parseFloat(getComputedStyle(node).outlineOffset) >= 0) ancestors.pop();
    for (const p of ancestors) { const s = getComputedStyle(p); opacity *= Number(s.opacity); const c = rgba(s.backgroundColor); c[3] *= opacity; background = over(c, background); }
    const style = getComputedStyle(node, pseudo); const raw = style[property]; const ink = rgba(raw); ink[3] *= opacity;
    const foreground = over(ink, background);
    const lum = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const values = [lum(foreground), lum(background)].sort((a, b) => a - b);
    return { label: node.dataset.contrast || node.className, color: raw, background, ratio: (values[1] + .05) / (values[0] + .05) };
  }, { property, pseudo });
}
for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
  test(`rendered shared contrast and update controls: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<html data-theme="${theme}"><head><style>${css()}</style></head><body><main style="height:100vh;overflow:auto;background:var(--background);color:var(--foreground)">${fixtures}</main></body></html>`);
    await page.addScriptTag({ content: constructors });
    await page.evaluate(() => ContrastUI.showUpdateBanner({ buildId: 'caprover-9999', buildNumber: 9999, releases: [{ buildNumber: 9999, label: 'Readable colours', notes: ['Notification and control text remain readable.'] }] }, { runningBuildNumber: 9998, refresh: () => new Promise((resolve, reject) => { window.rejectContrastRefresh = reject; }) }));
    const measurements = [];
    expect(await page.locator('.doc-block-editor-surface').evaluate(n => getComputedStyle(n).backgroundColor)).toBe('rgb(255, 255, 255)');
    const check = async (locator, state, minimum = 4.5, property = 'color', pseudo = null) => {
      const m = await measure(locator, property, pseudo); measurements.push({ state, ...m });
      expect(m.ratio, `${state}: ${m.label} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(minimum);
    };
    for (const item of await page.locator('[data-contrast]').all()) {
      await check(item, 'default', 4.5, 'color', /placeholder/.test(await item.getAttribute('data-contrast')) ? '::placeholder' : null);
    }
    for (const row of await page.locator('[data-doc-row]').all()) {
      await row.hover(); await page.waitForTimeout(180);
      for (const label of await row.locator('[data-contrast]').all()) await check(label, 'document row hover');
      for (const button of await row.locator('.doc-scope-pill-btn').all()) {
        await page.keyboard.press('Tab'); await button.focus();
        expect(await button.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle !== 'none')).toBe(true);
        await check(button, 'scope focus', 3, 'outlineColor');
      }
    }
    for (const selector of ['.update-banner-summary', '.update-banner-disclosure', '.update-banner-btn:not(.dismiss)', '.update-banner-btn.dismiss']) await check(page.locator(selector), 'banner');
    await check(page.locator('.update-banner-btn:not(.dismiss)'), 'action boundary', 3, 'borderTopColor');
    for (const selector of ['.update-banner-summary', '.update-banner-btn:not(.dismiss)', '.update-banner-btn.dismiss']) {
      const control = page.locator(selector); await control.hover(); await check(control, 'banner hover');
      await control.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      expect(await control.evaluate(n => n.matches(':focus-visible'))).toBe(true);
      await check(control, 'banner focus ring', 3, 'outlineColor');
    }
    const summary = page.locator('.update-banner-summary'); await summary.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    for (const selector of ['.update-banner-range', '.update-banner-release-heading', '.update-banner-release li']) await check(page.locator(selector), 'release notes');
    if (process.env.SOL_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SOL_EVIDENCE_DIR, `banner-${theme}-${width}.png`) });
    await page.locator('.update-banner-btn:not(.dismiss)').click();
    await expect(page.locator('.update-banner')).toHaveAttribute('aria-busy', 'true');
    await check(page.locator('.update-banner-btn:not(.dismiss)'), 'updating');
    await check(page.locator('.update-banner-btn:not(.dismiss)'), 'updating spinner', 3, 'borderTopColor', '::before');
    await page.evaluate(() => window.rejectContrastRefresh(new Error('Fixture retry')));
    await expect(page.locator('.update-banner-update-error')).toContainText('Fixture retry');
    await check(page.locator('.update-banner-update-error'), 'update error'); await check(page.locator('.update-banner-btn:not(.dismiss)'), 'retry');
    await page.locator('.update-banner-btn.dismiss').click(); await expect(page.locator('.update-banner')).toHaveCount(0);
    // Hover and keyboard checks on repeated controls, including success feedback.
    for (const selector of ['.btn-primary', '.btn-secondary', '.copy-button.copied', '.group-action-delete', '.chat-archived-toggle-btn', '.task-edit-btn']) {
      const button = page.locator(selector); await button.hover(); await check(button, 'shared hover');
      await page.keyboard.press('Tab'); await button.focus();
      expect(await button.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle !== 'none')).toBe(true);
      await check(button, 'shared focus', 3, 'outlineColor');
    }
    await page.evaluate(() => { ContrastUI.initImageModal(); ContrastUI.openImageModal('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="100"%3E%3C/svg%3E', 'Preview caption'); });
    for (const background of ['#000000', '#ffffff']) {
      await page.locator('main').evaluate((n, color) => n.style.background = color, background);
      await check(page.locator('.image-preview-caption'), `preview over ${background}`);
      const close = page.locator('.image-preview-close'); await check(close, 'preview close', 3); await close.hover(); await check(close, 'preview close hover', 3);
      await page.keyboard.press('Tab'); await close.focus();
      expect(await close.evaluate(n => n.matches(':focus-visible') && getComputedStyle(n).outlineStyle !== 'none')).toBe(true);
      await check(close, 'preview focus', 3, 'outlineColor');
    }
    await page.keyboard.press('Escape'); await expect(page.locator('.image-preview-overlay')).toHaveAttribute('aria-hidden', 'true');
    console.log(`CONTRAST ${theme} ${width}: ${measurements.length} measurements; minimum ${Math.min(...measurements.map(m => m.ratio)).toFixed(2)}:1`);
    if (process.env.SOL_EVIDENCE_DIR) { fs.mkdirSync(process.env.SOL_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SOL_EVIDENCE_DIR, `contrast-${theme}-${width}.json`), JSON.stringify(measurements, null, 2)); }
  });
}
