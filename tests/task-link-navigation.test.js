import { describe, expect, it, vi } from 'vitest';

import { buildPgChannelTaskBoardId } from '../src/pg-record-context.js';
import { taskBoardStateMixin } from '../src/task-board-state.js';
import { taskDetailManagerMixin } from '../src/task-detail-manager.js';
import {
  openTaskLinkFromChat,
  resolveTaskForDetail,
  taskOpenErrorMessage,
} from '../src/task-link-navigation.js';

function crossScopeStore(overrides = {}) {
  const store = {
    ...taskDetailManagerMixin,
    navSection: 'chat',
    selectedBoardId: 'pg:channel:origin-channel',
    selectedChannelId: 'origin-channel',
    tasks: [],
    showTaskDetail: false,
    activeTaskId: null,
    editingTask: null,
    taskDetailOriginRoute: '',
    chatTaskModalOpen: false,
    chatTaskModalTitle: '',
    chatTaskModalFullScreen: false,
    mobileNavOpen: false,
    releaseCurrentPgTaskDetailLeaseBeforeSwitch: vi.fn(),
    destroyTaskRichDescriptionEditor: vi.fn(),
    applyTaskComments: vi.fn(),
    getTaskAssigneeNpubs: vi.fn(() => []),
    resolveChatProfile: vi.fn(),
    loadTaskComments: vi.fn(),
    scheduleStorageImageHydration: vi.fn(),
    markTaskRead: vi.fn(),
    syncRoute: vi.fn(),
    selectPgChannelContext: taskBoardStateMixin.selectPgChannelContext,
    selectBoard: vi.fn(),
    async applyTasks(tasks) { this.tasks = tasks; },
    ...overrides,
  };
  return store;
}

describe('cross-scope task link navigation', () => {
  it('hydrates a task outside the active channel before opening it in the correct PG context', async () => {
    const task = {
      record_id: 'cross-scope-task',
      scope_id: 'target-scope',
      pg_channel_id: 'target-channel',
      title: 'Cross-scope task',
      description: '',
      record_state: 'active',
      pg_backend: true,
    };
    const store = crossScopeStore();
    const hydrateTowerPgTask = vi.fn(async (target) => {
      await target.applyTasks([...target.tasks, task]);
      return task;
    });

    const opened = await openTaskLinkFromChat(store, task.record_id, {
      getTaskById: vi.fn(async () => null),
      hydrateTowerPgTask,
      isTowerPgBackendMode: () => true,
    });

    expect(opened).toBe(true);
    expect(hydrateTowerPgTask).toHaveBeenCalledWith(store, task.record_id);
    expect(store.editingTask).toMatchObject({ record_id: task.record_id, pg_channel_id: 'target-channel' });
    expect(store.selectedChannelId).toBe('target-channel');
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('target-channel'));
    expect(store.navSection).toBe('tasks');
    expect(store.showTaskDetail).toBe(true);
    expect(store.selectBoard).not.toHaveBeenCalled();
  });

  it('hydrates a replayed task route before opening detail', async () => {
    const task = {
      record_id: 'route-task', pg_channel_id: 'route-channel', title: 'Route task',
      description: '', record_state: 'active', pg_backend: true,
    };
    const store = crossScopeStore();

    const opened = await store.openTaskDetailFromRoute(task.record_id, {
      syncRoute: false,
      captureOrigin: false,
      originRoute: '/flight-deck/chat?channelid=origin-channel&threadid=origin-thread',
      deps: {
        getTaskById: vi.fn(async () => null),
        hydrateTowerPgTask: vi.fn(async (target) => {
          await target.applyTasks([task]);
          return task;
        }),
        isTowerPgBackendMode: () => true,
      },
    });

    expect(opened).toBe(true);
    expect(store.taskDetailOriginRoute).toContain('threadid=origin-thread');
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('route-channel'));
  });

  it('shows an explicit authorization/not-found error when Tower hides the task', async () => {
    const store = crossScopeStore();
    const hidden = Object.assign(new Error('not found'), { status: 404 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const task = await resolveTaskForDetail(store, 'hidden-task', {
      getTaskById: vi.fn(async () => null),
      hydrateTowerPgTask: vi.fn(async () => { throw hidden; }),
      isTowerPgBackendMode: () => true,
    });

    expect(task).toBeNull();
    expect(store.error).toBe('You do not have permission to read this task, or it no longer exists.');
    expect(taskOpenErrorMessage(hidden)).toBe(store.error);
    expect(store.showTaskDetail).toBe(false);
    warn.mockRestore();
  });
});
