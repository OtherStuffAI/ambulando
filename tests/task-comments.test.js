import { describe, expect, it } from 'vitest';
import { taskDetailManagerMixin } from '../src/task-detail-manager.js';
import { renderMarkdownToHtml } from '../src/markdown.js';
import {
  isTaskCommentExpanded,
  isTaskCommentTruncated,
  normalizeTaskComments,
  syncTaskCommentPreviewState,
  taskCommentDisplayBody,
  toggleTaskCommentExpandedId,
} from '../src/task-comments.js';

describe('task comment helpers', () => {
  it('displays escaped paragraph breaks in plain updates without changing authored code', () => {
    expect(taskCommentDisplayBody('Status: done\\n\\nValidation: pass\\nNext: review'))
      .toBe('Status: done\n\nValidation: pass\nNext: review');
    expect(renderMarkdownToHtml(taskCommentDisplayBody('Status: done\\n\\nValidation: pass')))
      .toContain('<p>Validation: pass</p>');
    expect(taskCommentDisplayBody('Literal `\\n\\n` in a normal paragraph')).toBe('Literal `\\n\\n` in a normal paragraph');
    expect(taskCommentDisplayBody('Status: done\\n\\nCode: `\\n`\\nNext: review'))
      .toBe('Status: done\n\nCode: `\\n`\nNext: review');
    expect(taskCommentDisplayBody('Status: done\\n\\n```js\\nconst text = "\\n\\n";\\n```\\nNext: review'))
      .toBe('Status: done\n\n```js\\nconst text = "\\n\\n";\\n```\nNext: review');
    const markdown = '```js\nconst text = "\\n\\n";\n```';
    expect(taskCommentDisplayBody(markdown)).toBe(markdown);
  });
  it('sorts comments newest first and removes duplicate record ids', () => {
    const comments = normalizeTaskComments([
      { record_id: 'comment-a', updated_at: '2026-06-22T10:00:00.000Z' },
      { record_id: 'comment-b', updated_at: '2026-06-22T11:00:00.000Z' },
      { record_id: 'comment-a', updated_at: '2026-06-22T12:00:00.000Z' },
      { record_id: '', updated_at: '2026-06-22T13:00:00.000Z' },
    ]);

    expect(comments.map((comment) => comment.record_id)).toEqual(['comment-a', 'comment-b']);
    expect(comments[0].updated_at).toBe('2026-06-22T12:00:00.000Z');
  });

  it('keeps initial, live, edited, posted and reloaded rows newest-first with deterministic ties', async () => {
    const store = {
      taskComments: [],
      rememberPeople: async () => {},
      syncTaskCommentPreviewState: () => {},
      scheduleTaskCommentPreviewMeasurement: () => {},
      scheduleStorageImageHydration: () => {},
    };
    const apply = (rows) => taskDetailManagerMixin.applyTaskComments.call(store, rows);
    const old = { record_id: 'old', updated_at: '2026-10-05T01:00:00Z', version: 1 };
    const a = { record_id: 'a', updated_at: '2026-10-05T02:00:00Z', version: 1 };
    const z = { record_id: 'z', updated_at: a.updated_at, version: 1 };
    await apply([old, a, z]);
    expect(store.taskComments.map(row => row.record_id)).toEqual(['z', 'a', 'old']);
    await apply([z, old, a]);
    expect(store.taskComments.map(row => row.record_id)).toEqual(['z', 'a', 'old']);
    const edited = { ...old, updated_at: '2026-10-05T03:00:00Z', version: 2, body: 'Edited' };
    await apply([a, edited, z]);
    expect(store.taskComments[0]).toEqual(edited);
    const posted = { record_id: 'post', updated_at: '2026-10-05T04:00:00Z', version: 1 };
    const optimistic = normalizeTaskComments([posted, ...store.taskComments]);
    await apply([...optimistic].reverse());
    expect(store.taskComments.map(row => row.record_id)).toEqual(['post', 'old', 'z', 'a']);
  });

  it('tracks expanded and truncated preview ids without stale comment ids', () => {
    expect(isTaskCommentExpanded(['comment-1'], 'comment-1')).toBe(true);
    expect(isTaskCommentTruncated(['comment-2'], 'comment-2')).toBe(true);
    expect(toggleTaskCommentExpandedId(['comment-1'], 'comment-1')).toEqual([]);
    expect(toggleTaskCommentExpandedId([], 'comment-1')).toEqual(['comment-1']);

    expect(syncTaskCommentPreviewState({
      comments: [{ record_id: 'comment-1' }],
      expandedIds: ['comment-1', 'stale-comment'],
      truncatedIds: ['comment-1', 'other-stale-comment'],
    })).toEqual({
      expandedIds: ['comment-1'],
      truncatedIds: ['comment-1'],
    });
  });
});
