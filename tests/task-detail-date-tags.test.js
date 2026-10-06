import { describe, expect, it, vi } from 'vitest';
import { taskDetailManagerMixin } from '../src/task-detail-manager.js';
import { parseTags } from '../src/translators/tasks.js';
function draft() {
  return { ...taskDetailManagerMixin, editingTask: { record_id: 'task', scheduled_for: null, tags: ' Design,design ' },
    getTaskTags: task => parseTags(task?.tags), allTaskTags: ['design', 'polish', 'accessibility'],
    isTaskDetailEditing: () => true, handleEditingTaskDraftChanged: vi.fn(), enterTaskDetailEditMode: vi.fn() };
}
describe('task date/tag draft controls', () => {
 it('preserves date-only keys across month/year and leap-day navigation', async () => {
   const s=draft();
   expect(s.shiftTaskDate('2028-02-28','day',1)).toBe('2028-02-29');
   expect(s.shiftTaskDate('2026-12-31','day',1)).toBe('2027-01-01');
   await s.setEditingTaskDate('2028-02-29'); expect(s.editingTask.scheduled_for).toBe('2028-02-29');
   await s.setEditingTaskDate(null); expect(s.editingTask.scheduled_for).toBeNull();
   expect(s.handleEditingTaskDraftChanged).toHaveBeenCalledTimes(2);
 });
 it('uses shared tag vocabulary and normalized comma persistence without duplicates', async () => {
   const s=draft(); expect(s.taskTagOptions('POL')).toEqual(['polish']);
   await s.changeEditingTaskTag(' POLISH,Design,polish '); expect(s.editingTask.tags).toBe('design,polish');
   expect(s.taskTagOptions('')).toEqual(['accessibility']);
   await s.changeEditingTaskTag('design',true); expect(s.editingTask.tags).toBe('polish');
 });
 it('honours blocked edit entry and saving guards', async () => {
   const s=draft(); s.isTaskDetailEditing=()=>false; s.enterTaskDetailEditMode.mockResolvedValue(false);
   expect(await s.setEditingTaskDate('2026-10-07')).toBe(false);
   expect(await s.changeEditingTaskTag('polish')).toBe(false);
   expect(s.handleEditingTaskDraftChanged).not.toHaveBeenCalled();
   s.taskDetailSaving=true; await s.setEditingTaskDate(null); expect(s.editingTask.tags).toBe(' Design,design ');
 });
 it('does not apply asynchronous edits to a newly opened task', async () => {
   const s=draft(); s.isTaskDetailEditing=()=>false;
   s.enterTaskDetailEditMode.mockImplementation(async()=> { s.editingTask={record_id:'other',tags:'keep'}; return true; });
   expect(await s.changeEditingTaskTag('polish')).toBe(false); expect(s.editingTask.tags).toBe('keep');
 });
});
