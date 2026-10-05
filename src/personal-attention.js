import { isTaskActivityAuthoredByViewer, resolveTaskActivityViewer, latestTaskActivity } from './task-attention-actor.js';

const number = value => Math.max(0, Number(value) || 0);
const metadata = row => row?.pg_metadata || row?.metadata || {};

// Only structured identities are routing authority. Historical structured npubs
// remain accepted when an actor ID is absent; visible body text is never parsed.
export function mentionsViewer(mentions, viewer) {
  return (Array.isArray(mentions) ? mentions : []).some(mention => {
    if (!['person', 'agent', 'human'].includes(mention?.type)) return false;
    if (mention.actor_id) return Boolean(viewer.actorId && mention.actor_id === viewer.actorId);
    return Boolean(viewer.npub && mention.npub === viewer.npub);
  });
}

export function isTaskAssignedToViewer(row, viewer) {
  // An explicit canonical primary (including null) overrides stale row caches.
  const meta = metadata(row);
  if (Object.prototype.hasOwnProperty.call(row || {}, 'assigned_to_npub') || Object.prototype.hasOwnProperty.call(meta, 'assigned_to_npub')) {
    const primary = Object.prototype.hasOwnProperty.call(row || {}, 'assigned_to_npub') ? row.assigned_to_npub : meta.assigned_to_npub;
    return Boolean(viewer.npub && primary === viewer.npub);
  }
  const assignments = (Array.isArray(row?.assignments) ? row.assignments : []).filter(a => !a.deleted_at);
  if (assignments.length === 1) return Boolean(viewer.actorId && assignments[0].actor_id === viewer.actorId
    || viewer.npub && assignments[0].actor_npub === viewer.npub);
  const npubs = row?.assigned_to_npubs || [];
  return Boolean(npubs.length === 1 && viewer.npub && npubs[0] === viewer.npub);
}

export function personalAttentionVersion(row = {}, state = {}, options = {}) {
  const type = options.resourceType || state.resource_type || row.pg_record_type;
  const activity = number(row.activity_version || state.activity_version);
  if (row.deleted_at || row.archived_at || ['deleted', 'archived'].includes(row.record_state) || row.pg_record_type === 'file') return 0;
  if (type === 'thread') return activity;
  const viewer = resolveTaskActivityViewer({ ...options, viewState: state });
  const attention = row.attention || row.pg_attention;
  if (attention?.policy_version === 1) {
    const mentionVersion = number(attention.mention_activity_versions?.[viewer.actorId]);
    if (type === 'task') return Math.max(mentionVersion, isTaskAssignedToViewer(row, viewer) && attention.last_activity_actor_id !== viewer.actorId ? activity : 0);
    if (type === 'document' || type === 'doc') return Math.max(mentionVersion,
      mentionsViewer(metadata(row).mentions, viewer) && attention.body_actor_id !== viewer.actorId ? number(attention.body_activity_version) : 0);
    return 0;
  }
  if (state.attention_policy_version === 1) return number(state.attention_activity_version);

  // Old Towers cannot supply exact event positions. Qualify historical cached
  // activity by its own timestamp, never by a later unrelated activity version.
  if (type === 'task' && number(row.activity_version) < number(state.activity_version)) return 0;
  const readAt = Date.parse(state.updated_at || '') || 0;
  const authored = (activityRow, kind) => isTaskActivityAuthoredByViewer(activityRow, { ...options, kind, viewState: state });
  const latest = latestTaskActivity(row, options.comments || []);
  if (type === 'task' && isTaskAssignedToViewer(row, viewer) && !authored(latest.row, latest.kind)) return activity;
  const comments = options.comments || [];
  if (comments.some(comment => comment.record_state !== 'deleted' && !comment.deleted_at
    && mentionsViewer(metadata(comment).mentions || comment.mentions, viewer)
    && !authored(comment, 'comment') && (Date.parse(comment.updated_at || comment.created_at || '') || 0) > readAt)) return activity;
  if (['document', 'doc'].includes(type) && mentionsViewer(metadata(row).mentions || row.mentions, viewer)
    && !authored(row, 'task') && (Date.parse(row.updated_at || row.created_at || '') || 0) > readAt) return activity;
  return 0;
}

export function hasPersonalUnreadAttention(row, state, options = {}) {
  return personalAttentionVersion(row, state, options) > number(state?.viewed_activity_version);
}

export function isDeckAttachedFile(row = {}) {
  const type = row.source_target_type || row.source_type;
  return Boolean(row.thread_id || row.pg_thread_id || row.task_id || row.pg_task_id
    || ['task', 'chat'].includes(type) || (type === 'comment' && row.source_target_type !== 'document'));
}

export function standaloneDeckFiles(rows = []) {
  const attachedObjects = new Set(rows.filter(isDeckAttachedFile).map(row => row.object_id).filter(Boolean));
  return rows.filter(row => !isDeckAttachedFile(row) && !attachedObjects.has(row.object_id));
}
