import { describe, expect, it } from 'vitest';
import { computeUnreadTaskMap, hasUnreadTasks } from '../src/unread-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T1 = '2026-03-25T10:00:00.000Z';
const T2 = '2026-03-25T11:00:00.000Z';
const T3 = '2026-03-25T12:00:00.000Z';
const T4 = '2026-03-25T13:00:00.000Z';

const VIEWER = 'npub_viewer';
const OTHER = 'npub_other';

function task(id, updatedAt, state = 'active', opts = {}) {
  return {
    record_id: id,
    updated_at: updatedAt,
    record_state: state,
    owner_npub: opts.owner_npub ?? OTHER,
    created_at: opts.created_at ?? updatedAt,
  };
}

// ---------------------------------------------------------------------------
// computeUnreadTaskMap
// ---------------------------------------------------------------------------

describe('computeUnreadTaskMap', () => {
  it('returns empty map when no tasks:nav cursor exists', () => {
    const tasks = [task('t1', T3)];
    const cursorMap = {};
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('returns empty map when tasks list is empty', () => {
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap([], cursorMap)).toEqual({});
  });

  it('marks task as unread when updated_at > tasks:nav cursor', () => {
    const tasks = [task('t1', T3)];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({ t1: true });
  });

  it('does not mark task as unread when updated_at <= tasks:nav cursor', () => {
    const tasks = [task('t1', T1)];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('does not mark task as unread when updated_at equals tasks:nav cursor', () => {
    const tasks = [task('t1', T2)];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('ignores deleted tasks', () => {
    const tasks = [task('t1', T3, 'deleted')];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('respects per-task cursor when it is more recent than nav cursor', () => {
    // Task updated at T3, nav cursor at T2, per-task cursor at T4 (user opened it after update)
    const tasks = [task('t1', T3)];
    const cursorMap = {
      'tasks:nav': T2,
      'tasks:item:t1': T4,
    };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('uses nav cursor when it is more recent than per-task cursor', () => {
    // Task updated at T1, nav cursor at T3, per-task cursor at T2
    // updated_at (T1) <= effective (T3) → not unread
    const tasks = [task('t1', T1)];
    const cursorMap = {
      'tasks:nav': T3,
      'tasks:item:t1': T2,
    };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('marks task unread when updated after both cursors', () => {
    // Task updated at T4, nav cursor at T2, per-task cursor at T3
    const tasks = [task('t1', T4)];
    const cursorMap = {
      'tasks:nav': T2,
      'tasks:item:t1': T3,
    };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({ t1: true });
  });

  it('handles mixed read/unread tasks correctly', () => {
    const tasks = [
      task('t1', T1), // before nav cursor → read
      task('t2', T3), // after nav cursor → unread
      task('t3', T3, 'deleted'), // deleted → ignored
      task('t4', T4), // after nav cursor, but has per-task cursor at T4 → read
      task('t5', T4), // after nav cursor, per-task cursor at T3 → still unread
    ];
    const cursorMap = {
      'tasks:nav': T2,
      'tasks:item:t4': T4,
      'tasks:item:t5': T3,
    };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({
      t2: true,
      t5: true,
    });
  });

  it('per-task cursor exactly at updated_at clears unread', () => {
    const tasks = [task('t1', T3)];
    const cursorMap = {
      'tasks:nav': T2,
      'tasks:item:t1': T3,
    };
    // updated_at (T3) is NOT > effective (T3), so not unread
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({});
  });

  it('treats tasks with various record_state values correctly', () => {
    const tasks = [
      task('t1', T3, 'active'),
      task('t2', T3, 'archived'),
      task('t3', T3, 'deleted'),
    ];
    const cursorMap = { 'tasks:nav': T2 };
    // Explicit off-deck lifecycle is excluded; active work remains unread
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({
      t1: true,
    });
  });

  // --- Bug fix: opening one task must NOT clear borders on other tasks ---

  it('opening task A must not affect unread state of task B', () => {
    // Scenario: tasks:nav is at seed baseline (T1).
    // User opens task t1 → per-task cursor set to T4.
    // Task t2 has no per-task cursor → should still be unread.
    // This verifies markTaskRead does NOT advance tasks:nav.
    const tasks = [
      task('t1', T3), // opened → per-task cursor at T4
      task('t2', T3), // NOT opened → no per-task cursor
    ];
    const cursorMap = {
      'tasks:nav': T1, // baseline stays at seed, NOT advanced to now
      'tasks:item:t1': T4, // only t1 was opened
    };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({
      t2: true, // t2 must remain unread
    });
  });

  it('navigating to tasks board must not clear per-task unread state', () => {
    // Scenario: user navigates to tasks section via nav.
    // tasks:nav should NOT advance — it stays at the auto-seed baseline.
    // All unread task borders should persist.
    const tasks = [
      task('t1', T3),
      task('t2', T4),
    ];
    const cursorMap = {
      'tasks:nav': T1, // baseline stays at seed value
    };
    // Both tasks remain unread after board navigation
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({
      t1: true,
      t2: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Self-created tasks — viewer should not see red border on own creations
// ---------------------------------------------------------------------------

describe('self-created task unread suppression', () => {
  it('does not mark a self-created task as unread when updated_at equals created_at', () => {
    // Operator A creates a task — created_at === updated_at, owner_npub === viewer
    const tasks = [task('t1', T3, 'active', { owner_npub: VIEWER, created_at: T3 })];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap, VIEWER)).toEqual({});
  });

  it('marks a self-created task as unread when someone else updates it', () => {
    // Operator A created the task at T2, but someone updated it at T4
    const tasks = [task('t1', T4, 'active', { owner_npub: VIEWER, created_at: T2 })];
    const cursorMap = { 'tasks:nav': T1 };
    expect(computeUnreadTaskMap(tasks, cursorMap, VIEWER)).toEqual({ t1: true });
  });

  it('does not suppress unread for tasks created by others', () => {
    // Task created by OTHER, viewer should see it as unread
    const tasks = [task('t1', T3, 'active', { owner_npub: OTHER, created_at: T3 })];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap, VIEWER)).toEqual({ t1: true });
  });

  it('self-created task with per-task cursor still works normally', () => {
    // Operator A created at T2, updated at T4, but he already opened it (cursor at T4)
    const tasks = [task('t1', T4, 'active', { owner_npub: VIEWER, created_at: T2 })];
    const cursorMap = { 'tasks:nav': T1, 'tasks:item:t1': T4 };
    expect(computeUnreadTaskMap(tasks, cursorMap, VIEWER)).toEqual({});
  });

  it('mixed self-created and other-created tasks', () => {
    const tasks = [
      task('t1', T3, 'active', { owner_npub: VIEWER, created_at: T3 }), // self-created, no update → read
      task('t2', T3, 'active', { owner_npub: OTHER, created_at: T3 }),   // other-created → unread
      task('t3', T4, 'active', { owner_npub: VIEWER, created_at: T2 }), // self-created but updated → unread
    ];
    const cursorMap = { 'tasks:nav': T1 };
    expect(computeUnreadTaskMap(tasks, cursorMap, VIEWER)).toEqual({
      t2: true,
      t3: true,
    });
  });

  it('works without viewerNpub (backwards compat, all tasks eligible)', () => {
    // When no viewerNpub is passed, no suppression happens
    const tasks = [task('t1', T3, 'active', { owner_npub: VIEWER, created_at: T3 })];
    const cursorMap = { 'tasks:nav': T2 };
    expect(computeUnreadTaskMap(tasks, cursorMap)).toEqual({ t1: true });
  });
});

// ---------------------------------------------------------------------------
// hasUnreadTasks — derives nav dot from per-task unread map
// ---------------------------------------------------------------------------

describe('hasUnreadTasks', () => {
  it('returns false for empty map', () => {
    expect(hasUnreadTasks({})).toBe(false);
  });

  it('returns true when at least one task is unread', () => {
    expect(hasUnreadTasks({ t1: true, t2: false })).toBe(true);
  });

  it('returns false when all tasks are read', () => {
    expect(hasUnreadTasks({ t1: false, t2: false })).toBe(false);
  });

  it('returns true when all tasks are unread', () => {
    expect(hasUnreadTasks({ t1: true, t2: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldSeedTasksNavCursor — decides whether to auto-create the tasks:nav cursor
// ---------------------------------------------------------------------------

import { shouldSeedTasksNavCursor } from '../src/unread-store.js';

describe('shouldSeedTasksNavCursor', () => {
  it('returns true when tasks exist but no tasks:nav cursor', () => {
    const tasks = [task('t1', T3)];
    const cursorMap = {};
    expect(shouldSeedTasksNavCursor(tasks, cursorMap)).toBe(true);
  });

  it('returns false when tasks:nav cursor already exists', () => {
    const tasks = [task('t1', T3)];
    const cursorMap = { 'tasks:nav': T2 };
    expect(shouldSeedTasksNavCursor(tasks, cursorMap)).toBe(false);
  });

  it('returns false when no tasks exist (empty DB)', () => {
    const cursorMap = {};
    expect(shouldSeedTasksNavCursor([], cursorMap)).toBe(false);
  });

  it('returns false when all tasks are deleted', () => {
    const tasks = [task('t1', T3, 'deleted'), task('t2', T2, 'deleted')];
    const cursorMap = {};
    expect(shouldSeedTasksNavCursor(tasks, cursorMap)).toBe(false);
  });

  it('returns true when mix of deleted and active tasks, no cursor', () => {
    const tasks = [task('t1', T3, 'deleted'), task('t2', T2, 'active')];
    const cursorMap = {};
    expect(shouldSeedTasksNavCursor(tasks, cursorMap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral contract: unread borders only clear on task open
// ---------------------------------------------------------------------------

describe('unread border behavioral contract', () => {
  it('navigateTo must NOT call markSectionRead for tasks', () => {
    // navigateTo('tasks') should only clear the nav dot visually,
    // not advance tasks:nav cursor which would wipe all per-task borders.
    // This is tested by verifying computeUnreadTaskMap preserves state
    // when tasks:nav is NOT advanced (stays at baseline).
    const tasks = [task('t1', T3), task('t2', T4)];
    const baselineCursor = { 'tasks:nav': T1 };
    const advancedCursor = { 'tasks:nav': T4 }; // what happens if tasks:nav is advanced to now

    // With baseline: both unread (correct)
    expect(computeUnreadTaskMap(tasks, baselineCursor)).toEqual({ t1: true, t2: true });
    // With advanced: both read (wrong — this is the bug)
    expect(computeUnreadTaskMap(tasks, advancedCursor)).toEqual({});
  });

  it('markTaskRead must only clear the opened task, not others', () => {
    // After opening t1, only t1 should be read. t2 must remain unread.
    const tasks = [task('t1', T3), task('t2', T3)];
    const cursorMap = {
      'tasks:nav': T1, // baseline NOT advanced
      'tasks:item:t1': T4, // t1 was opened
    };
    const result = computeUnreadTaskMap(tasks, cursorMap);
    expect(result).toEqual({ t2: true }); // only t2 still unread
    expect(result.t1).toBeUndefined(); // t1 is read
  });
});

// ---------------------------------------------------------------------------
// markAllTasksRead — behavioral tests via computeUnreadTaskMap
//
// markAllTasksRead advances tasks:nav to "now", which should clear all
// per-task unread indicators since updated_at <= now for every task.
// ---------------------------------------------------------------------------

const T5 = '2026-03-25T14:00:00.000Z';

describe('markAllTasksRead effect on computeUnreadTaskMap', () => {
  it('advancing tasks:nav to now clears all unread indicators', () => {
    const tasks = [
      task('t1', T3),
      task('t2', T4),
      task('t3', T2),
    ];
    // Before: tasks:nav at baseline T1, all tasks newer → unread
    const beforeCursors = { 'tasks:nav': T1 };
    expect(computeUnreadTaskMap(tasks, beforeCursors)).toEqual({
      t1: true,
      t2: true,
      t3: true,
    });

    // After: tasks:nav advanced to T5 (now) — all tasks older → read
    const afterCursors = { 'tasks:nav': T5 };
    expect(computeUnreadTaskMap(tasks, afterCursors)).toEqual({});
  });

  it('advancing tasks:nav clears unread even when per-task cursors exist', () => {
    const tasks = [
      task('t1', T3),
      task('t2', T4),
    ];
    // t1 has per-task cursor at T2 (still unread), t2 has none
    const beforeCursors = { 'tasks:nav': T1, 'tasks:item:t1': T2 };
    expect(computeUnreadTaskMap(tasks, beforeCursors)).toEqual({
      t1: true,
      t2: true,
    });

    // After mark all read: tasks:nav at T5 supersedes per-task cursors
    const afterCursors = { 'tasks:nav': T5, 'tasks:item:t1': T2 };
    expect(computeUnreadTaskMap(tasks, afterCursors)).toEqual({});
  });

  it('hasUnreadTasks returns false after mark-all clears the map', () => {
    // After markAllTasksRead, the unread map is empty → no nav dot
    expect(hasUnreadTasks({})).toBe(false);
  });

  it('new tasks arriving after mark-all-read show as unread', () => {
    // After marking all read at T5, a new task arrives with updated_at > T5
    const T6 = '2026-03-25T15:00:00.000Z';
    const tasks = [
      task('t1', T3), // before T5 → read
      task('t_new', T6), // after T5 → unread
    ];
    const cursors = { 'tasks:nav': T5 };
    expect(computeUnreadTaskMap(tasks, cursors)).toEqual({ t_new: true });
  });
});

// ---------------------------------------------------------------------------
// Read cursor sync verification
//
// read_cursors is a local-only Dexie table NOT registered in sync families.
// This means cursors do NOT sync across devices — they are device-local.
// ---------------------------------------------------------------------------

describe('read cursor sync status', () => {
  it('read_cursors is not a sync family', async () => {
    const { SYNC_FAMILY_OPTIONS } = await import('../src/sync-families.js');
    const familyTables = SYNC_FAMILY_OPTIONS.map((f) => f.table);
    expect(familyTables).not.toContain('read_cursors');
  });

  it('read_cursors table does not appear in any sync family id', async () => {
    const { SYNC_FAMILY_OPTIONS } = await import('../src/sync-families.js');
    const familyIds = SYNC_FAMILY_OPTIONS.map((f) => f.id);
    expect(familyIds).not.toContain('read_cursor');
    expect(familyIds).not.toContain('read_cursors');
  });
});

// ---------------------------------------------------------------------------
// markAllTasksRead method contract
// ---------------------------------------------------------------------------

describe('markAllTasksRead method contract', () => {
  it('should be exported from unread-store', async () => {
    const mod = await import('../src/unread-store.js');
    expect(mod.unreadStoreMixin.markAllTasksRead).toBeTypeOf('function');
  });

  it('should clear _unreadTaskItems and _unreadTasks when called', async () => {
    const mod = await import('../src/unread-store.js');
    const mockCtx = {
      session: { npub: VIEWER },
      _unreadTaskItems: { t1: true, t2: true },
      _unreadTasks: true,
      async markSectionRead(section) {
        this._markSectionReadCalled = section;
      },
      async refreshUnreadFlags() {},
    };

    await mod.unreadStoreMixin.markAllTasksRead.call(mockCtx);

    expect(mockCtx._markSectionReadCalled).toBe('tasks');
    expect(mockCtx._unreadTaskItems).toEqual({});
    expect(mockCtx._unreadTasks).toBe(false);
  });

  it('should be a no-op when no session npub', async () => {
    const mod = await import('../src/unread-store.js');
    const mockCtx = {
      session: null,
      _unreadTaskItems: { t1: true },
      _unreadTasks: true,
    };

    await mod.unreadStoreMixin.markAllTasksRead.call(mockCtx);

    expect(mockCtx._unreadTaskItems).toEqual({ t1: true });
    expect(mockCtx._unreadTasks).toBe(true);
  });
});
