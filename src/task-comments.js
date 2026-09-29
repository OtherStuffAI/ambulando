import { sortCommentsNewestFirst } from './comment-ordering.js';
import {
  hasPreviewId,
  prunePreviewState,
  togglePreviewId,
} from './preview-truncation.js';

export function dedupeRowsByRecordId(rows = []) {
  const seen = new Set();
  const result = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const recordId = String(row?.record_id || '').trim();
    if (!recordId || seen.has(recordId)) continue;
    seen.add(recordId);
    result.push(row);
  }
  return result;
}

export function normalizeTaskComments(comments = []) {
  return dedupeRowsByRecordId(sortCommentsNewestFirst(comments));
}

// Some task updates arrive with JSON-escaped paragraph breaks as literal text.
// Repair that legacy plain-text shape for display without changing stored bodies
// or interpreting escape sequences inside authored Markdown/code.
export function taskCommentDisplayBody(body = '') {
  const source = String(body ?? '');
  if (source.includes('\n') || !source.includes('\\n\\n')) return source;
  let cursor = 0;
  let display = '';
  for (const code of source.matchAll(/(`+)[\s\S]*?\1/g)) {
    display += source.slice(cursor, code.index).replace(/\\n/g, '\n');
    display += code[0];
    cursor = code.index + code[0].length;
  }
  return display + source.slice(cursor).replace(/\\n/g, '\n');
}

export function isTaskCommentExpanded(expandedIds = [], recordId) {
  return hasPreviewId(expandedIds, recordId);
}

export function isTaskCommentTruncated(truncatedIds = [], recordId) {
  return hasPreviewId(truncatedIds, recordId);
}

export function toggleTaskCommentExpandedId(expandedIds = [], recordId) {
  return togglePreviewId(expandedIds, recordId);
}

export function syncTaskCommentPreviewState({
  comments = [],
  expandedIds = [],
  truncatedIds = [],
} = {}) {
  const validIds = new Set((Array.isArray(comments) ? comments : []).map((comment) => comment.record_id));
  return prunePreviewState({
    expandedIds,
    truncatedIds,
    validIds,
  });
}
