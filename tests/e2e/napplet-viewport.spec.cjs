const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Exercise production shell markup and both production stylesheets without
// credentials or backend traffic. Runtime lifecycle is covered by napplet specs.
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const size of [[320,568], [375,667], [390,844], [568,320], [667,375], [844,390], [1440,900]]) {
  test(`napplet shells fit ${size.join('x')} with long titles and menus`, async ({ page }) => {
    await page.setViewportSize({ width:size[0], height:size[1] });
    await page.setContent('<html><body></body></html>');
    for (const file of ['src/styles.css','src/sol.css']) await page.addStyleTag({ path:path.join(root,file) });
    for (const id of ['message-activity-modal', 'org-data-modal', 'tower-usage-modal']) {
      const markup = html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))[0];
      await page.evaluate(({ markup }) => {
        const template = document.createElement('template'); template.innerHTML = markup;
        const dialog = template.content.firstElementChild;
        for (const el of [dialog,...dialog.querySelectorAll('*')]) {
          for (const attr of [...el.attributes]) if (/^(x-|:|@)/.test(attr.name)) el.removeAttribute(attr.name);
        }
        dialog.querySelector('h2').textContent = 'VeryLongUnbrokenNappletTitle'.repeat(20);
        const menu = dialog.querySelector('[role=menu]'); menu.hidden = true;
        menu.innerHTML = Array.from({length:24}, (_,i) => `<button role="menuitem">Action ${i} ${'LongUnbrokenContent'.repeat(5)}</button>`).join('');
        menu.lastElementChild.textContent = 'Close napplet';
        menu.lastElementChild.onclick = () => dialog.close();
        dialog.querySelector('[data-napplet-menu]').onclick = () => { menu.hidden = !menu.hidden; };
        dialog.querySelector('[data-napplet-close]').onclick = () => dialog.close();
        dialog.querySelector('iframe')?.setAttribute('srcdoc','<div style="width:2000px;height:2000px">Wide embedded content</div>');
        document.body.append(dialog); dialog.showModal();
      }, { markup });
      const dialog = page.locator(`#${id}`);
      for (const full of [false,true]) {
        await dialog.evaluate((el,full) => el.classList.toggle('thread-full',full),full);
        await page.waitForTimeout(250);
        const check = async selector => {
          const box = await dialog.locator(selector).boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x+box.width).toBeLessThanOrEqual(size[0]+1);
          expect(box.y+box.height).toBeLessThanOrEqual(size[1]+1);
        };
        await check('[data-napplet-close]');
        if (await dialog.locator('iframe').count()) await check('iframe');
        const bounds = await dialog.boundingBox();
        expect(bounds.width).toBeLessThanOrEqual(size[0]);
        expect(bounds.height).toBeLessThanOrEqual(size[1]);
        await dialog.locator('[data-napplet-menu]').click();
        await check('[role=menu]');
        const menu = dialog.locator('[role=menu]');
        expect(await menu.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await menu.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        await menu.getByRole('menuitem').last().scrollIntoViewIfNeeded();
        await check('[data-napplet-close]');
        await dialog.locator('[data-napplet-menu]').click();
      }
      await dialog.locator('[data-napplet-menu]').click();
      await dialog.getByRole('menuitem', { name:'Close napplet',exact:true }).click();
      await expect(dialog).not.toBeVisible();
      await dialog.evaluate(el => el.showModal());
      await dialog.locator('[data-napplet-close]').click();
      await expect(dialog).not.toBeVisible();
      await dialog.evaluate(el => el.remove());
    }
  });
}
