const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
test.use({ serviceWorkers:'block' });
const { openFixture } = require('./fixtures/mobile-chat.cjs');

async function capture(page, name) {
  if (!process.env.SOL_EVIDENCE_DIR) return;
  execFileSync('git', ['check-ignore', process.env.SOL_EVIDENCE_DIR]);
  expect(execFileSync('git', ['ls-files', process.env.SOL_EVIDENCE_DIR], {encoding:'utf8'}).trim()).toBe('');
  await fs.mkdir(process.env.SOL_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.SOL_EVIDENCE_DIR}/${name}.png`, fullPage: true, animations: 'disabled' });
}
async function bounds(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { label: n.getAttribute('aria-label') || n.className, x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
  }));
}
for (const width of [320,375,390,430,900,1440]) {
 for (const theme of ['light','dark']) {
  test(`phone layout and local navigation ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openFixture(page);
    await page.evaluate(theme => window.Alpine.store('appearance').setTheme(theme), theme);
    await page.evaluate(width => {
      const s = window.Alpine.store('chat');
      s.closeThread({ syncRoute:false });
      s.navigateTo('status', { syncRoute:false });
      s.deckInboxEnabled = true;
      s.pgNavigationRecoveryPending = true;
      s.navCollapsed = width < 769;
      Object.defineProperty(s, 'pgContextChannels', { get:() => s.channels });
      s.messages = Array.from({length:12}, (_,i) => ({ ...s.messages[0], record_id:`phone-thread-${i}`, thread_id:`phone-thread-${i}`, pg_thread_id:`phone-thread-${i}`, parent_message_id:null, body:`Review mobile implementation ${i}: keep useful previews and readable controls.`, updated_at:new Date(Date.now()-i*60000).toISOString() }));
      s.fileMessages=s.messages;
    }, width);
    await expect(page.locator('[data-deck-column="inbox"]')).toBeVisible();
    await expect(page.locator('[data-deck-column="inbox"] .attention-card').first()).toBeVisible();
    await capture(page, `${width}-${theme}-inbox-recovery`);
    const header = await bounds(page,'.page-header');
    const cards = await bounds(page,'[data-deck-column="inbox"] .attention-card');
    const toolbar = await bounds(page,'.inbox-panel-heading button:visible');
    const pager = await bounds(page,'.deck-mobile-pagination-button:visible');
    console.log('MOBILE_LAYOUT',JSON.stringify({width,header,cards:cards.slice(0,2),toolbar,pager}));
    if (!process.env.SOL_LAYOUT_BEFORE) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 769) {
        expect(header[0].height).toBeLessThanOrEqual(60);
        for (const r of toolbar) { expect(r.width,r.label).toBeGreaterThanOrEqual(44); expect(r.height,r.label).toBeGreaterThanOrEqual(44); expect(r.x).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(width); }
        for (const r of pager) { expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBe(44); }
        expect(cards[0].height).toBeLessThanOrEqual(110);
        const gap = await page.evaluate(() => document.querySelector('[data-deck-column="inbox"]').getBoundingClientRect().top-document.querySelector('.workspace-recovery-status').getBoundingClientRect().bottom);
        expect(gap).toBeLessThanOrEqual(12);
        const search=page.locator('#deck-inbox-search');
        await search.fill('mobile implementation');
        await search.press('Enter');
        await expect(page.locator('[data-deck-column="inbox"] .attention-card').first()).toContainText('Review mobile implementation');
        await search.fill('');
        await search.press('Enter');
        await page.getByRole('button',{name:'Inbox read actions',exact:true}).click();
        await expect(page.getByRole('menu',{name:'Mark Inbox as read'})).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu',{name:'Mark Inbox as read'})).toBeHidden();
        await page.getByRole('button',{name:'Show Feed',exact:true}).click();
        await expect(page.getByRole('button',{name:'Show Feed',exact:true})).toHaveAttribute('aria-current','page');
        await page.getByRole('button',{name:'Show Inbox',exact:true}).click();
      }
    }
    await page.evaluate(() => { window.Alpine.store('chat').pgNavigationRecoveryPending=false; });
    await capture(page,`${width}-${theme}-inbox`);
    if(width<769) {
      await page.getByRole('button',{name:'Toggle navigation',exact:true}).click();
      await page.locator('.sidebar .expanded-sidebar-section-switcher-btn').filter({hasText:'Chat'}).click();
    } else await page.evaluate(() => window.Alpine.store('chat').navigateTo('chat',{syncRoute:false}));
    await page.evaluate(() => {
      const s=window.Alpine.store('chat'); s.openThread('phone-thread-0',{preserveChannelContext:true,scrollToLatest:false,syncRoute:false});
    });
    const composer=page.locator('.thread-input-bar [data-chat-composer="thread"]');
    await expect(composer).toBeVisible();
    await composer.fill('Phone draft stays exact 0123456789');
    await expect(composer).toHaveText('Phone draft stays exact 0123456789');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page,`${width}-${theme}-chat`);
    if(width<769) {
      await page.setViewportSize({width,height:520});
      await composer.focus();
      await capture(page,`${width}-${theme}-chat-short-viewport`);
      if(!process.env.SOL_LAYOUT_BEFORE) { const r=(await bounds(page,'.thread-input-bar'))[0]; expect(r.bottom).toBeLessThanOrEqual(520); expect(r.y).toBeGreaterThan(0); }
      await page.setViewportSize({width,height:844});
    }
    await page.evaluate(() => { const s=window.Alpine.store('chat'); s.closeThread({syncRoute:false}); s.navigateTo('tasks',{syncRoute:false}); s.openTaskDetail('sol-task'); s.taskDetailMode='view'; });
    await expect(page.locator('.task-detail-panel')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page,`${width}-${theme}-task`);
    await page.evaluate(() => { const s=window.Alpine.store('chat'); s.showTaskDetail=false; s.navigateTo('docs',{syncRoute:false}); s.selectedDocId='sol-doc'; s.selectedDocType='document'; s.loadDocEditorFromSelection(); });
    await expect(page.locator('.doc-title-display')).toHaveText('Connected design review');
    await expect(page.locator('.doc-rich-editor .ProseMirror')).toContainText('The browser remains the working application');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page,`${width}-${theme}-docs`);
    await page.evaluate(() => { window.Alpine.store('chat').navigateTo('files',{syncRoute:false}); });
    await expect(page.locator('.files-section')).toBeVisible();
    await expect(page.locator('.files-section')).toContainText('Mobile layout review.pdf');
    await capture(page,`${width}-${theme}-files`);
    if(!process.env.SOL_LAYOUT_BEFORE) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

}
