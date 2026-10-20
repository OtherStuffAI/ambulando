const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openFixture } = require('./fixtures/mobile-chat.cjs');

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function captureEvidence(page) {
  const directory = process.env.SOL_EVIDENCE_DIR;
  if (!directory) return;
  execFileSync('git', ['check-ignore', directory]);
  expect(execFileSync('git', ['ls-files', directory], { encoding: 'utf8' }).trim()).toBe('');
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `canvas-row-menu-${(await page.viewportSize()).width}.png`),
    animations: 'disabled',
  });
}

async function openShortCanvas(page, rowCount = 1) {
  await openFixture(page);
  await page.evaluate((rows) => {
    const store = window.Alpine.store('chat');
    store.closeThread({ syncRoute: false });
    store.syncCanvasContext = () => {};
    store.navSection = 'status';
    store.canvasContextKey = store.canvasPartition;
    store.canvasRows = Array.from({ length: rows }, (_, index) => ({
      canvas_id: index === rows - 1 ? 'canvas-bottom-row' : `canvas-row-${index}`,
      title: index === rows - 1 ? 'Bottom row canvas' : `Canvas row ${index + 1}`,
      position: index + 1,
      row_version: 1,
      can_manage: true,
      visibility: { mode: 'workspace', actor_ids: [], group_ids: [] },
    }));
  }, rowCount);
  const panel = page.locator('[data-testid="deck-canvases"]');
  await expect(panel.locator('.canvas-deck-row')).toHaveCount(rowCount);
  await panel.evaluate((node, rows) => {
    Object.assign(node.style, {
      position: 'fixed',
      right: '8px',
      bottom: window.innerWidth <= 720 ? '48px' : '0px',
      width: '360px',
      height: rows > 1 ? '180px' : '118px',
      zIndex: '20',
    });
  }, rowCount);
  return panel;
}

async function assertBottomEdgeMenu(page, { delayMenuLayout = false } = {}) {
  const panel = await openShortCanvas(page);
  const trigger = panel.getByRole('button', { name: 'Canvas options' });
  const menu = page.getByRole('menu', { name: 'Canvas options', includeHidden: true });
  const action = menu.getByRole('menuitem', { name: 'Rename and visibility…' });

  if (delayMenuLayout) {
    await page.addStyleTag({ content: '.test-delay-canvas-menu { display: none !important; }' });
    await menu.evaluate((node) => node.classList.add('test-delay-canvas-menu'));
  }

  await trigger.focus();
  await trigger.press('Enter');
  if (delayMenuLayout) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await menu.evaluate((node) => node.classList.remove('test-delay-canvas-menu'));
  }
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-positioned', 'true');
  await expect(action).toBeFocused();
  const geometry = await page.evaluate(() => {
    const triggerRect = document
      .querySelector('[aria-label="Canvas options"]')
      .getBoundingClientRect();
    const menuNode = document.querySelector('[role="menu"][aria-label="Canvas options"]');
    const menuRect = menuNode.getBoundingClientRect();
    return {
      triggerTop: triggerRect.top,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      viewportHeight: innerHeight,
      placement: menuNode.dataset.placement,
    };
  });
  expect(geometry.placement).toBe('top');
  expect(geometry.menuTop).toBeLessThan(geometry.triggerTop);
  expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
  await captureEvidence(page);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(menu).toBeHidden();

  await trigger.click();
  await action.click();
  await expect(menu).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = window.Alpine.store('chat').canvasDialog;
        return `${dialog.mode}:${dialog.id}`;
      }),
    )
    .toBe('edit:canvas-bottom-row');
}

test('short Canvas bottom row keeps its complete menu visible and actionable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await assertBottomEdgeMenu(page);
});

test('scrolling a long Canvas closes the menu when its trigger leaves the list viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const panel = await openShortCanvas(page, 12);
  const list = panel.locator('.canvas-deck-list');
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const trigger = panel.getByRole('button', { name: 'Canvas options' }).last();
  await trigger.click();
  const menu = page.locator('[role="menu"][aria-label="Canvas options"]:visible');
  await expect(menu).toBeVisible();
  await list.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(menu).toBeHidden();
});

test.describe('touch viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('Canvas bottom-row menu waits for mobile layout and flips within the viewport', async ({
    page,
  }) => {
    await assertBottomEdgeMenu(page, { delayMenuLayout: true });
  });
});
