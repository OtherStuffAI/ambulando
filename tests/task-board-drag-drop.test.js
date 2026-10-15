import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('task board drag and drop', () => {
  it('keeps cards draggable outside manual sort mode', () => {
    const html = readProjectFile('index.html');

    expect(html).toContain(':draggable="col.state !== \'summary\'"');
    expect(html).not.toContain(':draggable="col.state !== \'summary\' && $store.chat.taskSortIsManual"');
    expect(html).toContain('@drop.prevent="col.state !== \'summary\' && $store.chat.handleTaskDrop($event, col.state)"');
  });

  it('moves task state directly when the visible sort is not manual', () => {
    const source = readProjectFile('src/app.js');
    const start = source.indexOf('async handleTaskDrop(e, targetState, targetTaskId = null, position = \'end\')');
    const end = source.indexOf('const reorderPatches = buildTaskBoardReorderPatches', start);
    const preamble = source.slice(start, end);

    expect(preamble).toContain('if (!this.taskSortIsManual)');
    expect(preamble).toContain('await this.applyTaskPatch(taskId, { state: targetState }');
    expect(preamble).toContain('backgroundPg: isTowerPgBackendMode()');
  });

  it('ellipsizes summary titles beside actions while wrapping long titles on editing surfaces', () => {
    const html = readProjectFile('index.html');
    const styles = readProjectFile('src/styles.css');
    const source = readProjectFile('src/app.js');

    expect(source).toContain('isLongTaskTitle(title) {');
    expect(source).toContain("return { 'task-title-long': this.isLongTaskTitle(title) };");
    expect(html.match(/getTaskTitleLengthClass/g)).toHaveLength(9);
    expect(html.match(/isLongTaskTitle/g)).toHaveLength(2);
    expect(html).toMatch(/<textarea\s+class="task-detail-title"\s+rows="1"[\s\S]*?aria-label="Task title"[\s\S]*?><\/textarea>/);
    expect(html).not.toMatch(/<input\s+class="task-detail-title"/);
    expect(styles).toMatch(/\.flightdeck-summary-card-task \.attention-card-title\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
    expect(styles).toMatch(/\.flightdeck-summary-card-task \.attention-card-title\.task-title-long\s*\{[^}]*font-size:\s*0\.86rem;/s);
    expect(styles).not.toMatch(/\.flightdeck-summary-card-task\.task-title-long\s*\{[^}]*grid-template-columns:/s);
    expect(styles).not.toMatch(/\.flightdeck-summary-card-task\.task-title-long \.attention-card-meta\s*\{/s);
    expect(styles).toMatch(/\.kanban-card-title\.task-title-long\s*\{[^}]*font-size:\s*0\.8rem;/s);
    expect(styles).toMatch(/\.task-list-title\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
    expect(styles).toMatch(/\.task-detail-title-display\.task-title-long\s*\{[^}]*font-size:\s*1\.9rem;/s);
    expect(styles).toMatch(/\.task-detail-title\s*\{[^}]*max-width:\s*100%;[^}]*field-sizing:\s*content;[^}]*resize:\s*none;[^}]*white-space:\s*pre-wrap;[^}]*word-break:\s*break-word;[^}]*overflow-wrap:\s*anywhere;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*\.task-detail-title-display\.task-title-long\s*\{[^}]*font-size:\s*1\.45rem;/s);
    expect(styles).toMatch(/\.subtask-title\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
    expect(styles).toMatch(/\.task-parent-btn\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*text-align:\s*left;/s);
  });
});
