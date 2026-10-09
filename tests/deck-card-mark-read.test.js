import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unreadStoreMixin } from '../src/unread-store.js';

const INDEX_PATH = resolve(process.cwd(), 'index.html');
const STYLES_PATH = resolve(process.cwd(), 'src/styles.css');

describe('Deck card Mark read action', () => {
  it('renders separate read and done actions for review tasks while preserving other read actions', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const summary = html.slice(
      html.indexOf('data-testid="flightdeck-summary-inbox"'),
      html.indexOf('data-testid="flightdeck-summary-files"'),
    );
    const actions = summary.match(/<button type="button" class="attention-card-mark-read"[^>]*>Mark read<\/button>/g) || [];

    expect(actions).toHaveLength(6);
    expect(actions.every((action) => action.includes('data-deck-card-action'))).toBe(true);
    expect(actions.every((action) => action.includes('x-show=') && action.includes('.isUnread'))).toBe(true);
    expect(actions.every((action) => action.includes('@click.stop.prevent='))).toBe(true);
    expect(actions.every((action) => action.includes('@keydown.enter.stop') && action.includes('@keydown.space.stop'))).toBe(true);
    expect(actions.filter((action) => action.includes("markDeckResourceRead('thread'"))).toHaveLength(2);
    expect(actions.filter((action) => action.includes("markDeckResourceRead('task'"))).toHaveLength(2);
    expect(actions.filter((action) => action.includes("markDeckResourceRead('document'"))).toHaveLength(2);

    const fileCard = summary.slice(
      summary.indexOf("item.inboxKind === 'file'"),
      summary.indexOf('data-testid="deck-recent-channels"'),
    );
    expect(fileCard).not.toContain('attention-card-mark-read');

    const inboxTask = summary.slice(
      summary.indexOf("item.inboxKind === 'task'"),
      summary.indexOf("item.inboxKind === 'document'"),
    );
    expect(inboxTask).toContain('<template x-if="item.taskState === \'review\'">');
    expect(inboxTask).toContain('markDeckReviewTaskDone(item.recordId)');
    expect(inboxTask).toContain('>Mark done</button>');
    expect(inboxTask).not.toContain('<template x-if="item.taskState !== \'review\'">');
    expect(inboxTask).toContain("markDeckResourceRead('task', item.recordId)");
  });

  it('keeps card keyboard opening guarded while retaining the normal Open affordances', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const inbox = html.slice(
      html.indexOf('data-testid="flightdeck-summary-inbox"'),
      html.indexOf('data-testid="deck-recent-channels"'),
    );

    expect(inbox.match(/@keydown\.enter\.prevent="if \(\$store\.chat\.shouldOpenDeckCard\(\$event\)\)/g)).toHaveLength(3);
    expect(inbox.match(/@keydown\.space\.prevent="if \(\$store\.chat\.shouldOpenDeckCard\(\$event\)\)/g)).toHaveLength(3);
    expect(inbox).toContain('<span class="attention-card-action">Open chat</span>');
    expect(inbox).toContain('<span class="attention-card-action">Open task</span>');
    expect(inbox).toContain('<span class="attention-card-action">Open doc</span>');
  });

  it('uses a compact focus-visible control and permits narrow metadata wrapping', () => {
    const styles = readFileSync(STYLES_PATH, 'utf8');

    expect(styles).toMatch(/\.attention-card-mark-read\s*\{[^}]*min-height:\s*1\.7rem;[^}]*font-size:\s*0\.7rem;[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.attention-card-mark-read:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\);/s);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.attention-card-meta\s*\{[^}]*flex-wrap:\s*wrap;/s);
  });

  it('dispatches each supported family to exactly one focused read helper', async () => {
    const store = {
      markThreadRead: vi.fn(async () => 'thread'),
      markTaskRead: vi.fn(async () => 'task'),
      markDocRead: vi.fn(async () => 'document'),
    };

    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'thread', 'thread-1', 'channel-1')).resolves.toBe('thread');
    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'task', 'task-1')).resolves.toBe('task');
    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'document', 'doc-1')).resolves.toBe('document');
    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'file', 'file-1')).resolves.toBe(false);

    expect(store.markThreadRead).toHaveBeenCalledOnce();
    expect(store.markThreadRead).toHaveBeenCalledWith('thread-1', 'channel-1');
    expect(store.markTaskRead).toHaveBeenCalledOnce();
    expect(store.markTaskRead).toHaveBeenCalledWith('task-1');
    expect(store.markDocRead).toHaveBeenCalledOnce();
    expect(store.markDocRead).toHaveBeenCalledWith('doc-1');
  });

  it('acknowledges review activity without patching state or opening the task and preserves failures', async () => {
    const task = { record_id: 'review-1', state: 'review', activity_version: 7 };
    const store = {
      isTowerPgMode: true, currentWorkspace: { pgBackendMode: true }, tasks: [task],
      markTaskRead: unreadStoreMixin.markTaskRead,
      markTowerPgResourceViewed: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      applyTaskPatch: vi.fn(), openAutopilotOverviewTask: vi.fn(),
    };
    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'task', task.record_id)).resolves.toBe(true);
    await expect(unreadStoreMixin.markDeckResourceRead.call(store, 'task', task.record_id)).resolves.toBe(false);
    expect(store.markTowerPgResourceViewed).toHaveBeenCalledWith('task', 'review-1', 7);
    expect(task).toEqual({ record_id: 'review-1', state: 'review', activity_version: 7 });
    expect(store.applyTaskPatch).not.toHaveBeenCalled();
    expect(store.openAutopilotOverviewTask).not.toHaveBeenCalled();
  });

  it('marks a review task done before clearing its read state', async () => {
    const calls = [];
    const store = {
      tasks: [{ record_id: 'task-review', state: 'review', activity_version: 7 }],
      applyTaskPatch: vi.fn(async () => {
        calls.push('state');
        return { record_id: 'task-review', state: 'done', activity_version: 8 };
      }),
      markTaskRead: vi.fn(async () => {
        calls.push('read');
        return true;
      }),
    };

    await expect(unreadStoreMixin.markDeckReviewTaskDone.call(store, 'task-review')).resolves.toBe(true);
    expect(calls).toEqual(['state', 'read']);
    expect(store.applyTaskPatch).toHaveBeenCalledWith('task-review', { state: 'done' }, expect.objectContaining({
      backgroundPg: false,
      rollbackOnFailure: true,
    }));
    expect(store.markTaskRead).toHaveBeenCalledWith('task-review', 8);
  });

  it('uses an explicit accepted activity version instead of a stale in-memory task version', async () => {
    const store = {
      isTowerPgMode: true,
      currentWorkspace: { pgBackendMode: true },
      tasks: [{ record_id: 'task-review', state: 'done', activity_version: 7 }],
      markTowerPgResourceViewed: vi.fn(async () => true),
    };

    await expect(unreadStoreMixin.markTaskRead.call(store, 'task-review', 8)).resolves.toBe(true);
    expect(store.markTowerPgResourceViewed).toHaveBeenCalledWith('task', 'task-review', 8);
  });

  it('does not clear read state or claim success when the done-state write fails', async () => {
    const store = {
      tasks: [{ record_id: 'task-review', state: 'review' }],
      applyTaskPatch: vi.fn(async () => null),
      markTaskRead: vi.fn(),
      error: 'Tower rejected the task state update.',
    };

    await expect(unreadStoreMixin.markDeckReviewTaskDone.call(store, 'task-review')).resolves.toBe(false);
    expect(store.tasks[0].state).toBe('review');
    expect(store.markTaskRead).not.toHaveBeenCalled();
    expect(store.error).toBe('Tower rejected the task state update.');
  });

  it('ignores non-review tasks and surfaces a read-state failure after an accepted done write', async () => {
    const nonReviewStore = {
      tasks: [{ record_id: 'task-ready', state: 'ready' }],
      applyTaskPatch: vi.fn(),
      markTaskRead: vi.fn(),
    };
    await expect(unreadStoreMixin.markDeckReviewTaskDone.call(nonReviewStore, 'task-ready')).resolves.toBe(false);
    expect(nonReviewStore.applyTaskPatch).not.toHaveBeenCalled();

    const readFailureStore = {
      tasks: [{ record_id: 'task-review', state: 'review', activity_version: 8 }],
      applyTaskPatch: vi.fn(async () => {
        readFailureStore.tasks[0] = { ...readFailureStore.tasks[0], state: 'done', activity_version: 9 };
        return readFailureStore.tasks[0];
      }),
      markTaskRead: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      error: '',
    };
    await expect(unreadStoreMixin.markDeckReviewTaskDone.call(readFailureStore, 'task-review')).resolves.toBe(false);
    expect(readFailureStore.tasks[0]).toMatchObject({ state: 'done', activity_version: 9 });
    expect(readFailureStore.markTaskRead).toHaveBeenNthCalledWith(1, 'task-review', 9);
    expect(readFailureStore.error).toContain('Inbox read state could not be cleared');

    await expect(unreadStoreMixin.markDeckResourceRead.call(readFailureStore, 'task', 'task-review')).resolves.toBe(true);
    expect(readFailureStore.markTaskRead).toHaveBeenNthCalledWith(2, 'task-review');
  });

  it('marks one Tower thread through resource view state and preserves the legacy channel fallback', async () => {
    const towerStore = {
      isTowerPgMode: true,
      currentWorkspace: { pgBackendMode: true },
      markTowerPgResourceViewed: vi.fn(async () => true),
      markChannelRead: vi.fn(),
    };
    await expect(unreadStoreMixin.markThreadRead.call(towerStore, 'thread-1', 'channel-1')).resolves.toBe(true);
    expect(towerStore.markTowerPgResourceViewed).toHaveBeenCalledWith('thread', 'thread-1');
    expect(towerStore.markChannelRead).not.toHaveBeenCalled();

    const legacyStore = {
      isTowerPgMode: false,
      currentWorkspace: { pgBackendMode: false },
      markChannelRead: vi.fn(async () => undefined),
    };
    await expect(unreadStoreMixin.markThreadRead.call(legacyStore, 'thread-1', 'channel-1')).resolves.toBe(true);
    expect(legacyStore.markChannelRead).toHaveBeenCalledWith('channel-1');
  });
});
