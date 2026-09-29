import { describe, expect, it } from 'vitest';
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
