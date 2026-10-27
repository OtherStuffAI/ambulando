// Chat-thread candidates for the @ lookahead. A thread is mentioned as
// `@[Label](mention:chat:<channelId>#<rootId>)`, the same reference form as
// "FD Ref", so openLinkedThread can validate the channel before opening it.

const LABEL_MAX_LENGTH = 80;

function plainLabel(value) {
  const text = String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/@?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[[\]()`*_>#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > LABEL_MAX_LENGTH ? `${text.slice(0, LABEL_MAX_LENGTH - 1).trimEnd()}…` : text;
}

function isActive(row) {
  return row?.record_id && !['deleted', 'archived'].includes(String(row.record_state || 'active'));
}

/**
 * Collapses cached roots to one entry per thread. A thread record whose
 * source message is also a cached root is represented by that message, which
 * matches the main feed (chat-order.js rankMainFeedMessages).
 */
export function chatThreadMentionCandidates(rows = [], { channelLabel = () => '' } = {}) {
  const roots = (Array.isArray(rows) ? rows : []).filter(row => isActive(row) && !row.parent_message_id && row.channel_id);
  const threadRecords = new Map(roots.filter(row => row.pg_record_type === 'thread').map(row => [row.record_id, row]));
  const sourceIds = new Set(roots.filter(row => row.pg_record_type !== 'thread').map(row => row.record_id));
  const candidates = [];
  const seen = new Set();
  for (const row of roots) {
    if (row.pg_record_type === 'thread' && row.pg_source_message_id && sourceIds.has(row.pg_source_message_id)) continue;
    const thread = threadRecords.get(row.pg_thread_id) || row;
    const key = String(row.pg_thread_id || row.record_id);
    if (seen.has(key)) continue;
    const label = plainLabel(thread.title || thread.pg_thread_title || row.title || row.pg_thread_title || row.body);
    if (!label) continue;
    seen.add(key);
    const channel = plainLabel(channelLabel(row.channel_id));
    candidates.push({
      type: 'chat',
      id: `${row.channel_id}#${row.record_id}`,
      label,
      sublabel: channel ? `Chat thread · ${channel}` : 'Chat thread',
      updated_at: row.updated_at || row.created_at || '',
    });
  }
  return candidates;
}
