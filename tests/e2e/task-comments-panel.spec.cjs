const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function taskPanelFixture(options = {}) {
  const source = readProjectFile('index.html');
  const navStart = source.indexOf('<nav class="mobile-detail-switcher task-detail-mobile-switcher"');
  const mobileTabs = source.slice(navStart, source.indexOf('</nav>', navStart) + 6);
  const css = readProjectFile('src/styles.css');
  const sectionClass = options.sectionClass || 'tasks-section chat-task-inline-section';
  const descriptionRepeat = options.descriptionRepeat || 48;
  const commentRepeat = options.commentRepeat || 56;
  const commentCount = options.commentCount || 1;
  const commentRows = Array.from({ length: commentCount }, (_, index) => `
    <div class="task-comment-row">
      <div class="task-comment-header">
        <span class="task-comment-sender">Implementation worker with a long display name</span>
        <span class="task-comment-time">${index + 1}m ago</span>
      </div>
      <div class="task-comment-body task-comment-body-collapsed">
        <p>${'A long task comment body '.repeat(commentRepeat)}</p>
        <pre><code>${'unbroken-code-fragment'.repeat(18)}</code></pre>
      </div>
    </div>
  `).join('');
  return `<!doctype html>
    <html>
      <head>
        <style>${css}</style>
      </head>
      <body>
        <main class="app-shell">
          <div class="main-content">
            <div class="content-scroll-area">
              <section class="${sectionClass}">
              <div class="task-detail-panel">
                ${mobileTabs}
                <div class="task-detail-body">
                  <div class="task-detail-main">
                    <h1 class="task-detail-title-display">Task detail</h1>
                    <div class="task-desc-preview chat-post-markdown">
                      <p>${'A long task description '.repeat(descriptionRepeat)}</p>
                      <p>https://example.test/${'unbroken-description-token'.repeat(12)}</p>
                    </div>
                  </div>
                  <div id="task-comments-panel" class="task-comments-section">
                    <div class="task-comments-header">
                      <div class="task-comments-header-copy">
                        <label class="task-field-label">Activity</label>
                        <span>7 comments</span>
                      </div>
                      <button class="thread-resize-btn task-comments-fullscreen-btn" type="button" aria-label="Open activity fullscreen">Open</button>
                    </div>
                    <div class="task-comment-input-area"><div class="task-comment-composer" contenteditable="true" role="textbox" aria-label="Comment"></div><button type="button">Post comment</button></div>
                    <div class="task-comments-list">
                      ${commentRows}
                    </div>
                  </div>
                </div>
                <div class="task-comments-fullscreen-backdrop" style="display: none;">
                  <section class="task-comments-fullscreen-modal" role="dialog" aria-modal="true">
                    <header class="task-comments-fullscreen-header">
                      <div>
                        <h2>Activity</h2>
                        <span>7 comments</span>
                      </div>
                      <button type="button" class="task-comments-fullscreen-close" aria-label="Close activity fullscreen">&times;</button>
                    </header>
                    <div class="task-comments-fullscreen-list">
                      <article class="task-comment-row task-comment-fullscreen-row">
                        <div class="task-comment-header">
                          <span class="task-comment-sender">Implementation worker with a long display name</span>
                          <span class="task-comment-time">just now</span>
                        </div>
                        <div class="task-comment-body task-comment-fullscreen-body">
                          <p>${'A long task comment body '.repeat(commentRepeat)}</p>
                          <pre><code>${'unbroken-code-fragment'.repeat(18)}</code></pre>
                        </div>
                      </article>
                    </div>
                  </section>
                </div>
              </div>
              </section>
            </div>
          </div>
        </main>
        <script>
          document.querySelectorAll('.task-detail-mobile-switcher button').forEach((button, index) => {
            button.addEventListener('click', () => document.querySelector('.task-detail-body').classList.toggle('task-detail-body-mobile-comments', index === 1));
          });
          const backdrop = document.querySelector('.task-comments-fullscreen-backdrop');
          document.querySelector('.task-comments-fullscreen-btn').addEventListener('click', () => {
            backdrop.style.display = 'flex';
          });
          document.querySelector('.task-comments-fullscreen-close').addEventListener('click', () => {
            backdrop.style.display = 'none';
          });
        </script>
      </body>
    </html>`;
}

async function panelMetrics(page) {
  return page.evaluate(() => {
    const body = document.querySelector('.task-detail-body').getBoundingClientRect();
    const main = document.querySelector('.task-detail-main').getBoundingClientRect();
    const comments = document.querySelector('.task-comments-section').getBoundingClientRect();
    return {
      bodyWidth: body.width,
      mainWidth: main.width,
      commentsWidth: comments.width,
      commentsShare: comments.width / (main.width + comments.width),
    };
  });
}

test('task activity header exposes only the fullscreen comment reader control', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.setContent(taskPanelFixture());

  const normal = await panelMetrics(page);
  expect(normal.commentsShare).toBeGreaterThan(0.53);
  expect(normal.commentsShare).toBeLessThan(0.57);
  await expect(page.locator('.task-comments-panel-rail')).toHaveCount(0);
  await expect(page.locator('.task-comments-resize-btn')).toHaveCount(0);
  await expect(page.locator('.task-comments-fullscreen-btn')).toHaveCount(1);

  await page.locator('.task-comments-fullscreen-btn').click();
  await expect(page.locator('.task-comments-fullscreen-backdrop')).toBeVisible();
  await expect(page.locator('.task-comment-fullscreen-body')).toBeVisible();
  const modalWidth = await page.locator('.task-comments-fullscreen-modal').evaluate((node) => node.getBoundingClientRect().width);
  expect(modalWidth / 1280).toBeGreaterThan(0.78);
  expect(modalWidth / 1280).toBeLessThan(0.82);

  await page.locator('.task-comments-fullscreen-close').click();
  await expect(page.locator('.task-comments-fullscreen-backdrop')).toBeHidden();
});

test('desktop task details and comments scroll independently', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.setContent(taskPanelFixture({
    sectionClass: 'tasks-section',
    descriptionRepeat: 260,
    commentRepeat: 32,
    commentCount: 12,
  }));

  const metrics = await page.evaluate(() => {
    const body = document.querySelector('.task-detail-body');
    const main = document.querySelector('.task-detail-main');
    const comments = document.querySelector('.task-comments-section');
    const commentsList = document.querySelector('.task-comments-list');
    main.scrollTop = 80;
    commentsList.scrollTop = 140;
    return {
      bodyOverflowY: getComputedStyle(body).overflowY,
      mainOverflowY: getComputedStyle(main).overflowY,
      commentsOverflowY: getComputedStyle(comments).overflowY,
      commentsListOverflowY: getComputedStyle(commentsList).overflowY,
      mainScrollTop: main.scrollTop,
      commentsListScrollTop: commentsList.scrollTop,
      mainCanScroll: main.scrollHeight > main.clientHeight,
      commentsListCanScroll: commentsList.scrollHeight > commentsList.clientHeight,
    };
  });

  expect(metrics.bodyOverflowY).toBe('hidden');
  expect(metrics.mainOverflowY).toBe('auto');
  expect(metrics.commentsOverflowY).toBe('auto');
  expect(metrics.commentsListOverflowY).toBe('auto');
  expect(metrics.mainCanScroll).toBe(true);
  expect(metrics.commentsListCanScroll).toBe(true);
  expect(metrics.mainScrollTop).toBeGreaterThan(0);
  expect(metrics.commentsListScrollTop).toBeGreaterThan(0);
});

test('task comments layout stays single column on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.setContent(taskPanelFixture());

  const gridColumns = await page.locator('.task-detail-body').evaluate((node) => getComputedStyle(node).gridTemplateColumns);

  expect(gridColumns.split(' ')).toHaveLength(1);
});

test('long task descriptions and comments stay within their panels', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 820 });
  await page.setContent(taskPanelFixture());

  const metrics = await page.evaluate(() => {
    const body = document.querySelector('.task-detail-body').getBoundingClientRect();
    const main = document.querySelector('.task-detail-main').getBoundingClientRect();
    const comments = document.querySelector('.task-comments-section').getBoundingClientRect();
    const description = document.querySelector('.task-desc-preview').getBoundingClientRect();
    const comment = document.querySelector('.task-comment-body').getBoundingClientRect();
    const code = document.querySelector('.task-comment-body pre').getBoundingClientRect();
    return {
      bodyRight: body.right,
      mainRight: main.right,
      commentsLeft: comments.left,
      commentsRight: comments.right,
      descriptionRight: description.right,
      commentRight: comment.right,
      codeRight: code.right,
      descriptionScrollWidth: document.querySelector('.task-desc-preview').scrollWidth,
      descriptionClientWidth: document.querySelector('.task-desc-preview').clientWidth,
      commentScrollWidth: document.querySelector('.task-comment-body').scrollWidth,
      commentClientWidth: document.querySelector('.task-comment-body').clientWidth,
    };
  });

  expect(metrics.mainRight).toBeLessThanOrEqual(metrics.commentsLeft);
  expect(metrics.descriptionRight).toBeLessThanOrEqual(metrics.mainRight + 1);
  expect(metrics.commentRight).toBeLessThanOrEqual(metrics.commentsRight + 1);
  expect(metrics.codeRight).toBeLessThanOrEqual(metrics.commentsRight + 1);
  expect(metrics.descriptionScrollWidth).toBeLessThanOrEqual(metrics.descriptionClientWidth + 1);
  expect(metrics.commentScrollWidth).toBeLessThanOrEqual(metrics.commentClientWidth + 1);
});

for (const width of [390, 320]) {
  test(`mobile Task / Comments tabs retain one usable panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.setContent(taskPanelFixture());
    await expect(page.locator('.task-detail-main')).toBeVisible();
    await expect(page.locator('.task-comments-section')).toBeHidden();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(page.locator('.task-detail-main')).toBeHidden();
    await expect(page.locator('.task-comments-section')).toBeVisible();
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Mobile comment');
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveText('Mobile comment');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Task', exact: true }).click();
    await expect(page.locator('.task-detail-main')).toBeVisible();
    await expect(page.locator('.task-comments-section')).toBeHidden();
  });
}
