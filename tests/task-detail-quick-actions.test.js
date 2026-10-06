import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const indexPath = path.resolve(__dirname, '../index.html');
const appPath = path.resolve(__dirname, '../src/app.js');
const indexContent = fs.readFileSync(indexPath, 'utf-8');
const appContent = fs.readFileSync(appPath, 'utf-8');

describe('task detail quick actions', () => {
  it('offers states in the badge picker without the removed detail shortcuts', () => {
    const detail = indexContent.slice(indexContent.indexOf('<!-- Task detail panel -->'), indexContent.indexOf('task-detail-mobile-switcher'));
    expect(detail).toContain('Change task status: ');
    expect(detail).toContain("['new', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archive']");
    expect(detail).not.toContain('applyTaskDetailQuickAction(');
    expect(detail).not.toContain('<select');
    expect(indexContent).toContain('aria-label="Filter tasks by status"');
    expect(indexContent).toContain("@click=\"$store.chat.applyBulkTaskAction('blocked')\"");
  });

  it('routes view-mode quick actions through the local task patch and PG background path', () => {
    expect(appContent).toContain('async applyTaskDetailQuickAction(action)');
    expect(appContent).toContain("this.buildTaskDetailQuickActionPatch(action)");
    expect(appContent).toContain('backgroundPg: isTowerPgBackendMode()');
    expect(appContent).toContain('if (!isTowerPgBackendMode())');
    expect(appContent).toContain('await this.flushAndBackgroundSync();');
    expect(appContent).toContain("return { state: 'done', assigned_to_npubs: [] };");
    expect(appContent).toContain("return { state: 'blocked' };");
    expect(appContent).toContain("return { state: 'archive', assigned_to_npubs: [] };");
    expect(appContent).toContain("return { scheduled_for: this.getTaskDueTodayDateKey() };");
  });

  it('force-repairs task board drag writes when normal checkout sync leaves them pending', () => {
    expect(appContent).toContain('async handleTaskDrop(e, targetState, targetTaskId = null, position = \'end\')');
    expect(appContent).toContain('const flushResult = await this.flushAndBackgroundSync();');
    expect(appContent).toContain('if ((flushResult?.pushed ?? 0) < reorderPatches.length && typeof this.forceSyncPendingWriteTargets === \'function\')');
    expect(appContent).toContain('familyId: \'task\'');
  });
});
