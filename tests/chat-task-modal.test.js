import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readProjectFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('chat task full-page navigation', () => {
  it('routes task mentions and same-origin task links through the hydrated task opener', () => {
    const source = readProjectFile('src/app.js');

    expect(source).toContain('resolveInternalReference(this, linkType, recordId');
    expect(source).toContain("route.section === 'tasks' && params.taskid");
    expect(source).toContain('this.handleMentionNavigate(type, id, { commentId: params.commentid');
    expect(source).toContain('openTaskLinkFromChat(this, taskId');
  });

  it('hydrates the selected task before opening full-page detail', () => {
    const source = readProjectFile('src/task-link-navigation.js');

    expect(source).toContain('await hydrateTask(store, recordId)');
    expect(source).toContain('await store.applyTasks?.(');
    expect(source).toContain('store.chatTaskModalOpen = false');
    expect(source).toContain('store.openTaskDetail(task.record_id)');
    expect(source).toContain('You do not have permission to read this task');
  });

  it('makes the shared task opener enforce the full-page task section', () => {
    const source = readProjectFile('src/task-detail-manager.js');
    const start = source.indexOf('openTaskDetail(taskId, options = {})');
    const end = source.indexOf('async closeTaskDetail', start);
    const method = source.slice(start, end);

    expect(method).toContain("this.navSection = 'tasks'");
    expect(method).toContain('this.chatTaskModalOpen = false');
    expect(method).toContain('this.mobileNavOpen = false');
  });
});
