import { beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceDb, getResourceViewState, upsertResourceViewState } from '../src/db.js';
import { applyPgRecordChanges } from '../src/pg-record-delta.js';
import { unreadStoreMixin } from '../src/unread-store.js';
import fixture from './fixtures/flightdeck-record-delta-v1.json';

const canonical = fixture.canonical_upserts.changes.find(row => row.family === 'task');
const workspaceId = canonical.workspace_id;
const key = 'review-task-bulk-read';
let db;
beforeEach(async () => {
  db = openWorkspaceDb(key);
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
});
function taskChange(id, scope, activity = 7, version = '21') {
  return { ...canonical, id, version, scope_id: scope, row: {
    ...canonical.row, id, scope_id: scope, state: 'review', activity_version: activity,
    metadata: { ...canonical.row.metadata, assigned_to_npub: 'npub1viewer' },
    updated_at: '2026-09-08T01:00:00Z',
  } };
}
function page(changes, cursor) {
  return { ...fixture.one_message_delta, changes, next_cursor: cursor, has_more: false };
}
function makeStore() {
  return {
    ...unreadStoreMixin, isTowerPgMode: true, currentWorkspaceKey: key,
    session: { npub: 'npub1viewer' }, currentPgActorId: 'other-viewer',
    currentWorkspace: { workspaceId, pgBackendMode: true, directHttpsUrl: 'http://tower.test' },
    pgContextScopeId: 'scope-a',
    scopesMap: new Map(['scope-a', 'scope-b'].map(id => [id, { record_id: id, level: 'product' }])),
    tasks: [], messages: [], documents: [],
    applyTaskPatch: vi.fn(),
    markTowerPgResourcesViewed: vi.fn(async (workspace, resources) => {
      expect(workspace).toBe(workspaceId);
      return { states: resources.map(resource => ({
        ...resource, activity_version: resource.viewed_activity_version,
      })) };
    }),
  };
}

it.each([
  ['all tasks in Inbox', ['task'], false],
  ['everything in Inbox', ['thread', 'task', 'document'], false],
  ['task-board bulk read', ['task'], true],
])('%s persists review read watermarks without changing workflow state', async (_label, types, board) => {
  const store = makeStore();
  // The review update arrives independently of an old read watermark. A second
  // review task has never had a watermark row; a third belongs to another scope.
  await upsertResourceViewState({ record_id: 'task:review-old', resource_type: 'task', resource_id: 'review-old',
    scope_id: 'scope-a', activity_version: 2, viewed_activity_version: 2 });
  await applyPgRecordChanges(store, page([
    taskChange('review-old', 'scope-a'), taskChange('review-new', 'scope-a'), taskChange('outside', 'scope-b'),
  ], 'initial'));
  store.tasks = await db.tasks.toArray();
  const tasksBefore = await db.tasks.toArray();
  await store.recomputeTowerPgUnreadProjection();
  expect(store._recordDeltaAttentionActive).toBe(true);
  expect(store.isTaskUnread('review-old')).toBe(true);
  expect(store.isTaskUnread('review-new')).toBe(true);

  const result = board ? await store.markAllTasksRead() : await store.runInboxReadAction(types);
  expect(result).toEqual({ ok: true, count: board ? 3 : 2 });
  expect(store.isTaskUnread('review-old')).toBe(false);
  expect(store.isTaskUnread('review-new')).toBe(false);
  expect(store.isTaskUnread('outside')).toBe(!board);
  expect(store.markTowerPgResourcesViewed.mock.calls[0][1]).toContainEqual({
    resource_type: 'task', resource_id: 'review-old', viewed_activity_version: 7,
  });
  expect(await getResourceViewState('task', 'review-new')).toMatchObject({ viewed_activity_version: 7 });
  expect(await db.tasks.toArray()).toEqual(tasksBefore);
  expect(store.applyTaskPatch).not.toHaveBeenCalled();
  expect(await db.pending_writes.count()).toBe(0);

  db.close();
  await db.open();
  const reloaded = makeStore();
  reloaded.tasks = await db.tasks.toArray();
  await reloaded.recomputeTowerPgUnreadProjection();
  expect(reloaded.isTaskUnread('review-old')).toBe(false);
  expect(reloaded.isTaskUnread('review-new')).toBe(false);
  expect(reloaded.isTaskUnread('outside')).toBe(!board);
  // Same activity re-materializes without reviving unread; newer activity does.
  await applyPgRecordChanges(reloaded, page([taskChange('review-old', 'scope-a', 7, '22')], 'same'));
  await reloaded.recomputeTowerPgUnreadProjection();
  expect(reloaded.isTaskUnread('review-old')).toBe(false);
  await applyPgRecordChanges(reloaded, page([taskChange('review-old', 'scope-a', 8, '23')], 'new'));
  reloaded.tasks = await db.tasks.toArray();
  await reloaded.recomputeTowerPgUnreadProjection();
  expect(reloaded.isTaskUnread('review-old')).toBe(true);
  expect((await db.tasks.get('review-old')).state).toBe('review');
});
