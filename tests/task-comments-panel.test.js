import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath) {
  return readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8');
}

function extractRule(css, selector) {
  const selectorIndex = css.indexOf(selector);
  expect(selectorIndex, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const blockStart = css.indexOf('{', selectorIndex);
  let depth = 1;
  let index = blockStart + 1;
  while (index < css.length && depth > 0) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    index += 1;
  }
  return css.slice(blockStart + 1, index - 1);
}

describe('task comments panel fullscreen affordance', () => {
  it('renders one task activity fullscreen button without the old resize affordance', () => {
    const html = readProjectFile('index.html');

    expect(html).toContain('task-comments-fullscreen-btn');
    expect(html).toContain('$store.chat.openTaskCommentsFullscreen()');
    expect(html).toContain('class="mobile-detail-switcher task-detail-mobile-switcher"');
    expect(html).toContain("$store.chat.taskDetailMobilePane = 'details'");
    expect(html).toContain("$store.chat.taskDetailMobilePane = 'comments'");
    expect(html).toContain('task-detail-body-mobile-comments');
    expect(html).toContain('aria-label="Open activity fullscreen"');
    expect(html).not.toContain('task-comments-resize-btn');
    expect(html).not.toContain('taskCommentsPanelExpanded');
    expect(html).not.toContain('toggleTaskCommentsPanelExpanded');
    expect(html).not.toContain('task-detail-body-comments-expanded');
    expect(html).not.toContain('task-comments-section-expanded');
    expect(html).not.toContain('task-detail-activity-sidebar');
    expect(html).not.toContain('task-comments-panel-rail');
    expect(html).toContain('id="task-comments-panel"');

    const mainIndex = html.indexOf('class="task-detail-main"');
    const commentsIndex = html.indexOf('id="task-comments-panel"');
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(commentsIndex).toBeGreaterThan(mainIndex);
  });

  it('places a scope-free heading above the brief and predecessors after its description', () => {
    const html = readProjectFile('index.html');
    const record = html.slice(html.indexOf('class="task-detail-panel"'), html.indexOf('id="task-comments-panel"'));
    expect(record.indexOf('task-record-heading')).toBeLessThan(record.indexOf('task-detail-body"'));
    expect(record.indexOf('task-description-section')).toBeLessThan(record.indexOf('>Predecessors</label>'));
    expect(record).not.toContain('>Scope</label>');
    expect(record).not.toContain('getTaskScopeLabel');
    expect(record).toContain('>Task</button>');
    expect(record).toContain('>Comments</button>');
    expect(record).toContain('handleEditingTaskDraftChanged()');
    expect(record).toContain('assignEditingTask(person.npub)');
    expect(record).toContain('mountTaskRichDescriptionEditor($el)');
    expect(readProjectFile('src/app.js')).toContain('handleTaskRichPaste?.(event, editor)');
  });

  it('defines fullscreen store state and detail lifecycle reset', () => {
    const appSource = readProjectFile('src/app.js');
    const taskDetailSource = readProjectFile('src/task-detail-manager.js');

    expect(appSource).toMatch(/taskCommentsFullscreenOpen:\s*false/);
    expect(appSource).toMatch(/taskDetailMobilePane:\s*'details'/);
    expect(appSource).toContain('taskDetailManagerMixin');
    expect(taskDetailSource).not.toContain('taskCommentsPanelExpanded');
    expect(taskDetailSource).not.toContain('toggleTaskCommentsPanelExpanded');
    expect(taskDetailSource).toContain('openTaskCommentsFullscreen()');
    expect(taskDetailSource).toContain('closeTaskCommentsFullscreen()');
    expect(taskDetailSource).toContain('normalizeTaskComments(comments)');

    const openTaskDetail = taskDetailSource.slice(taskDetailSource.indexOf('openTaskDetail(taskId'), taskDetailSource.indexOf('async closeTaskDetail'));
    expect(openTaskDetail).toContain('this.taskCommentsFullscreenOpen = false;');
    expect(openTaskDetail).toContain("this.taskDetailMobilePane = 'details';");

    const closeTaskDetail = taskDetailSource.slice(taskDetailSource.indexOf('async closeTaskDetail'), taskDetailSource.indexOf('openTaskCommentsFullscreen()'));
    expect(closeTaskDetail).toContain('this.taskCommentsFullscreenOpen = false;');
    expect(closeTaskDetail).toContain("this.taskDetailMobilePane = 'details';");
  });

  it('renders a fullscreen activity reader for long comments', () => {
    const html = readProjectFile('index.html');

    expect(html).toContain('task-comments-fullscreen-backdrop');
    expect(html).toContain('task-comments-fullscreen-modal');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('@keydown.escape.window="$store.chat.closeTaskCommentsFullscreen()"');
    expect(html).toContain('task-comment-fullscreen-body');
    expect(html.match(/x-html="\$store\.chat\.renderMarkdown\(\$store\.chat\.taskCommentDisplayBody\(comment\.body\)\)"/g)).toHaveLength(2);
    expect(html).toContain('aria-describedby="task-comment-markdown-help"');
    expect(html).toContain('Markdown supported: headings, lists, links');
  });

  it('keys task comments by durable record identity so insertions do not remount the list', () => {
    const html = readProjectFile('index.html');

    expect(html.match(/x-for="comment in \$store\.chat\.taskComments" :key="comment\.record_id"/g)).toHaveLength(2);
    expect(html).not.toContain("${comment.record_id || 'comment'}:${index}");
    expect(html).not.toContain("${comment.record_id || 'comment-fullscreen'}:${index}");
  });

  it('keeps the baseline task comments layout and mobile fullscreen modal', () => {
    const css = readProjectFile('src/styles.css');

    const headerRule = extractRule(css, '\n.task-detail-header');
    expect(headerRule).toMatch(/position\s*:\s*sticky/);
    expect(headerRule).toMatch(/top\s*:\s*0/);
    expect(headerRule).toMatch(/z-index\s*:\s*31/);

    const bodyRule = extractRule(css, '\n.task-detail-body');
    expect(bodyRule).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*9fr\)\s*minmax\(0,\s*11fr\)/);
    expect(css).not.toContain('task-detail-body-comments-expanded');
    expect(css).not.toContain('task-comments-resize-btn');
    expect(css).not.toContain('task-detail-activity-sidebar');
    expect(css).not.toContain('task-comments-panel-rail');

    const mobileStart = css.lastIndexOf('@media (max-width: 768px)');
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobileCss = css.slice(mobileStart);
    expect(mobileCss).toContain('.mobile-detail-switcher');
    expect(mobileCss).toContain('bottom: calc(var(--mobile-section-switcher-height, 68px) + env(safe-area-inset-bottom))');
    expect(mobileCss).toContain('.task-detail-body:not(.task-detail-body-mobile-comments) .task-comments-section');
    expect(mobileCss).toContain('.task-detail-body-mobile-comments .task-detail-main');
    const mobileFullscreenRule = extractRule(mobileCss, '.task-comments-fullscreen-modal');
    expect(mobileFullscreenRule).toMatch(/height\s*:\s*100%/);
    expect(mobileFullscreenRule).toMatch(/border-radius\s*:\s*0/);
  });
});
