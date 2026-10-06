import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';
import { standaloneDeckFiles } from './personal-attention.js';
import {
  getPgChannelScopeId,
  parsePgTaskBoardId,
} from './pg-record-context.js';
import { resolveChannelLabel } from './channel-labels.js';
import { isTerminalTaskState } from './attention-feed.js';
import { recordFamilyHash } from './translators/chat.js';
import { formatStateLabel } from './translators/tasks.js';
import {
  isTerminalAgentActivity,
  selectVisibleAgentActivities,
} from './agent-activity.js';
import {
  isTaskActivityAuthoredByViewer,
} from './task-attention-actor.js';
import {
  resolveHorizontalSwipe,
  resolveVisibleThreadNeighbour,
  shouldSuppressThreadNavigation,
} from './thread-navigation.js';
import { getChannelById } from './db.js';

const UNSCOPED_SCOPE_ID = '__unscoped__';
const ALL_SCOPE_ID = 'all';
const ALL_CHANNEL_ID = 'all';
const OVERVIEW_PANEL_PAGE_SIZE = 5;
export const DECK_INBOX_PAGE_SIZE = 50;
const OPEN_COMMENT_STATUSES = new Set(['', 'open', 'unresolved', 'active']);
const DECK_COMPLETED_TASK_STATES = new Set(['done', 'complete', 'completed']);
const TASK_FAMILY = recordFamilyHash('task');
const DOCUMENT_FAMILY = recordFamilyHash('document');
const MAX_TIMEOUT_MS = 2_147_483_647;
const overviewProjectionCache = new WeakMap();

function normalizeString(value) {
  return String(value || '').trim();
}

function mergeUnreadMaps(...maps) {
  const unread = {};
  for (const map of maps) {
    for (const [recordId, value] of Object.entries(map || {})) {
      if (value === true) unread[recordId] = true;
    }
  }
  return unread;
}

function memoizedProjection(store, key, references, build) {
  let cache = overviewProjectionCache.get(store);
  if (!cache) {
    cache = new Map();
    overviewProjectionCache.set(store, cache);
  }
  const previous = cache.get(key);
  const unchanged = previous
    && previous.references.length === references.length
    && references.every((value, index) => Object.is(value, previous.references[index]));
  if (unchanged) return previous.value;
  const value = build();
  cache.set(key, { references: [...references], value });
  return value;
}

function shouldIncludeInboxTask(row = {}) {
  const state = normalizeString(row.taskState || row.state).toLowerCase();
  return !isTerminalTaskState(state);
}

export function normalizeInboxSearchText(value) {
  return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

const COMPLETE_MENTION_PATTERN = /@?\[(?:\\.|[^\]\\])*\]\(mention:[a-zA-Z_][a-zA-Z0-9_-]*:[^)]+\)/g;
const MARKDOWN_IMAGE_PATTERN = /!\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g;
const MARKDOWN_LINK_PATTERN = /\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g;

function unescapeMarkdownLabel(value) {
  return String(value || '').replace(/\\([\\`*_\[\]{}()#+.!~>-])/g, '$1');
}

export function deriveDeckThreadCreateTitle(value) {
  const source = String(value || '');
  if (!source.trim()) return '';
  const visible = source
    .replace(COMPLETE_MENTION_PATTERN, ' ')
    .replace(MARKDOWN_IMAGE_PATTERN, (_match, label) => ` ${unescapeMarkdownLabel(label)} `)
    .replace(MARKDOWN_LINK_PATTERN, (_match, label) => ` ${unescapeMarkdownLabel(label)} `)
    .replace(/<[^>]*>/g, ' ')
    .replace(/(^|\s)(?:#{1,6}|>|[-+*])\s+|[*_~`]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!visible) return 'Untitled thread';
  return visible.split(' ').slice(0, 10).join(' ').slice(0, 120).trim() || 'Untitled thread';
}

function isKeyLikeDisplay(value) {
  const text = normalizeString(value);
  return /^npub1/i.test(text)
    || /^nprofile1/i.test(text)
    || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(text)
    || /^[0-9a-f]{24,}$/i.test(text);
}

function timestampMs(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : 0;
}

function addWorkingKey(keys, prefix, value) {
  const normalized = normalizeString(value);
  if (normalized) keys.add(`${prefix}:${normalized}`);
}

function addInboxActivityWorkingKeys(keys, activity = {}) {
  const channelId = normalizeString(activity.channel_id);
  const threadId = normalizeString(activity.thread_id);
  const triggerMessageId = normalizeString(activity.trigger_message_id);
  const targetRecordId = normalizeString(activity.target_record_id);
  const targetFamily = normalizeString(activity.target_record_family_hash || activity.record_family_hash).toLowerCase();

  addWorkingKey(keys, 'thread', threadId);
  addWorkingKey(keys, 'message', triggerMessageId);
  if (channelId && threadId) keys.add(`channel-thread:${channelId}:${threadId}`);
  if (targetFamily.endsWith(':task')) addWorkingKey(keys, 'task', targetRecordId);
  if (targetFamily.endsWith(':document')) addWorkingKey(keys, 'document', targetRecordId);
  addWorkingKey(keys, 'task', activity.task_id || activity.taskId);
  addWorkingKey(keys, 'document', activity.document_id || activity.documentId);
}

export function buildInboxWorkingResourceKeys(activities = [], { nowMs = Date.now() } = {}) {
  const keys = new Set();
  for (const activity of selectVisibleAgentActivities(Array.isArray(activities) ? activities : [], 'connected', nowMs)) {
    if (isTerminalAgentActivity(activity)) continue;
    const expiresAt = Date.parse(activity.expires_at || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) continue;
    addInboxActivityWorkingKeys(keys, activity);
  }
  return keys;
}

function soonestInboxWorkingExpiry(activities = [], nowMs = Date.now()) {
  let next = Infinity;
  for (const activity of selectVisibleAgentActivities(Array.isArray(activities) ? activities : [], 'connected', nowMs)) {
    if (isTerminalAgentActivity(activity)) continue;
    const expiresAt = Date.parse(activity.expires_at || '');
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) next = Math.min(next, expiresAt);
  }
  return Number.isFinite(next) ? next : 0;
}

function isInboxRowWorking(row = {}, workingResourceKeys = null) {
  if (!workingResourceKeys?.has || row.inboxKind === 'file') return false;
  if (row.inboxKind === 'chat') {
    const threadId = normalizeString(row.id);
    const rootRecordId = normalizeString(row.rootRecordId);
    const channelId = normalizeString(row.channelId);
    return (channelId && threadId && workingResourceKeys.has(`channel-thread:${channelId}:${threadId}`))
      || (channelId && rootRecordId && workingResourceKeys.has(`channel-thread:${channelId}:${rootRecordId}`))
      || workingResourceKeys.has(`thread:${threadId}`)
      || workingResourceKeys.has(`thread:${rootRecordId}`)
      || workingResourceKeys.has(`message:${rootRecordId}`);
  }
  if (row.inboxKind === 'task') return workingResourceKeys.has(`task:${normalizeString(row.recordId)}`);
  if (row.inboxKind === 'document') return workingResourceKeys.has(`document:${normalizeString(row.recordId)}`);
  return false;
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function shiftDateKey(value, deltaDays) {
  const date = parseDateKey(value);
  if (!date) return String(value || '');
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function dateOrdinal(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function formatDailyScopeDate(value) {
  const date = parseDateKey(value);
  if (!date) return String(value || '');
  const day = date.getUTCDate();
  return `${day}${dateOrdinal(day)} ${date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
}

function newestIso(left, right) {
  return timestampMs(left) >= timestampMs(right) ? (left || '') : (right || '');
}

function recordScopeId(row = {}) {
  return normalizeString(
    row.scope_id
    || row.scope_l5_id
    || row.scope_l4_id
    || row.scope_l3_id
    || row.scope_l2_id
    || row.scope_l1_id
    || ''
  );
}

function isFileBackedDocument(row = {}) {
  return normalizeString(row.pg_record_type) === 'file'
    || Boolean(normalizeString(row.pg_storage_object_id));
}

function isDocumentBodyStorageRow(row = {}) {
  return !isFileBackedDocument(row)
    && normalizeString(row.source_type) === 'document'
    && normalizeString(row.kind) === 'document';
}

export function scopeMatches(rowScopeId, selectedScopeId, scopesMap) {
  const selected = normalizeString(selectedScopeId);
  const rowScope = normalizeString(rowScopeId);
  if (!selected || selected === ALL_SCOPE_ID || selected === '__all__') return true;
  if (selected === UNSCOPED_SCOPE_ID) return !rowScope;
  if (!rowScope) return false;
  if (rowScope === selected) return true;
  const scope = scopesMap?.get?.(rowScope);
  if (!scope) return false;
  return [
    scope.l1_id,
    scope.l2_id,
    scope.l3_id,
    scope.l4_id,
    scope.l5_id,
    scope.parent_id,
  ].some((value) => normalizeString(value) === selected);
}

function buildOverviewContext({ selectedScopeId = ALL_SCOPE_ID, selectedChannelId = ALL_CHANNEL_ID } = {}) {
  const scopeId = normalizeString(selectedScopeId);
  const channelId = normalizeString(selectedChannelId);
  const hasScope = Boolean(scopeId && scopeId !== ALL_SCOPE_ID && scopeId !== '__all__' && scopeId !== '__recent__');
  const hasChannel = Boolean(channelId && channelId !== ALL_CHANNEL_ID);
  if (!hasScope && !hasChannel) {
    return { mode: 'all', scopeId: ALL_SCOPE_ID, channelId: ALL_CHANNEL_ID };
  }
  return {
    mode: 'context',
    scopeId: hasScope ? scopeId : '',
    channelId: hasChannel ? channelId : '',
  };
}

function rowMatchesContext(row = {}, context = {}, scopesMap = null) {
  if (context.mode === 'all') return { matches: true, missing: false };
  const rowScope = recordScopeId(row);
  const rowChannel = normalizeString(row.channel_id || row.pg_channel_id || '');
  const hasScope = Boolean(rowScope);
  const hasChannel = Boolean(rowChannel);
  const wantsScope = Boolean(context.scopeId);
  const wantsChannel = Boolean(context.channelId);
  const scopeOk = !wantsScope || scopeMatches(rowScope, context.scopeId, scopesMap);
  const channelOk = !wantsChannel || rowChannel === context.channelId;
  return {
    matches: scopeOk && channelOk,
    missing: (wantsScope && !hasScope) || (wantsChannel && !hasChannel),
  };
}

function channelLabel(channel = {}) {
  return normalizeString(channel.title || channel.name || channel.label) || 'Chat';
}

function overviewChannelLabel(channel = {}, options = {}) {
  if (typeof options.getChannelLabel === 'function') {
    const label = normalizeString(options.getChannelLabel(channel));
    if (label) return label;
  }
  return resolveChannelLabel(channel, {
    sessionNpub: options.sessionNpub,
    getParticipants: options.getParticipants,
    getSenderName: options.getSenderName,
  }) || channelLabel(channel);
}

function readableTitle(row = {}, fallback = 'Untitled') {
  return normalizeString(row.title || row.name || row.subject || row.display_name || row.body) || fallback;
}

function commentIsOpen(comment = {}) {
  const status = normalizeString(comment.comment_status || comment.status).toLowerCase();
  return OPEN_COMMENT_STATUSES.has(status);
}

function mergeComments(...sources) {
  const rows = new Map();
  for (const source of sources) {
    for (const row of Array.isArray(source) ? source : []) {
      if (!row?.record_id) continue;
      rows.set(row.record_id, row);
    }
  }
  return [...rows.values()];
}

function findActiveChannel(channels = [], channelId = '') {
  const id = normalizeString(channelId);
  if (!id) return null;
  return (Array.isArray(channels) ? channels : [])
    .find((channel) => channel?.record_id === id && channel.record_state !== 'deleted') || null;
}

function resolveOverviewChannelId(store = {}) {
  const board = parsePgTaskBoardId(store.selectedBoardId);
  if (board.type === 'scope') {
    const scopeId = normalizeString(board.scopeId);
    if (scopeId === ALL_SCOPE_ID || scopeId === '__all__' || scopeId === '__recent__') return '';
  }
  return normalizeString(
    store.pgContextSelectedChannelId
    || board.channelId
    || store.selectedChannelId
    || ''
  );
}

function resolveOverviewScopeId(store = {}) {
  const board = parsePgTaskBoardId(store.selectedBoardId);
  if (board.type === 'scope') {
    const scopeId = normalizeString(board.scopeId);
    if (scopeId === ALL_SCOPE_ID || scopeId === '__all__' || scopeId === '__recent__') return '';
    if (scopeId && scopeId !== ALL_SCOPE_ID && scopeId !== '__all__' && scopeId !== '__recent__') return scopeId;
  }
  const channel = findActiveChannel(store.channels, resolveOverviewChannelId(store));
  return getPgChannelScopeId(channel) || '';
}

export function buildAutopilotOverviewThreads({
  channels = [],
  messages = [],
  selectedScopeId = ALL_SCOPE_ID,
  selectedChannelId = ALL_CHANNEL_ID,
  scopesMap = null,
  getChannelLabel = null,
  getParticipants = null,
  getSenderName = null,
  sessionNpub = '',
  unreadChannelMap = {},
  unreadThreadMap = {},
  resourceViewStateMode = false,
} = {}) {
  const context = buildOverviewContext({ selectedScopeId, selectedChannelId });
  const channelById = new Map(
    (Array.isArray(channels) ? channels : [])
      .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
      .map((channel) => [channel.record_id, channel])
  );
  const threadRows = new Map();

  for (const message of new Map((Array.isArray(messages) ? messages : []).map(row => [row?.record_id, row])).values()) {
    if (!message?.record_id || message.record_state === 'deleted') continue;
    const channel = channelById.get(message.channel_id);
    if (!channel) continue;
    const channelScopeId = recordScopeId(channel);
    const match = rowMatchesContext({ ...message, scope_id: channelScopeId }, context, scopesMap);
    if (!match.matches) continue;

    const threadId = normalizeString(message.pg_thread_id || message.parent_message_id || message.record_id);
    const existing = threadRows.get(threadId);
    const messageTs = timestampMs(message.updated_at);
    const existingTs = timestampMs(existing?.latestMessageUpdatedAt);
    const isMetadata = message.pg_record_type === 'thread';
    const isPersistedThread = isMetadata || Boolean(normalizeString(message.title) && message.pg_thread_id && !message.parent_message_id);
    const isThreadRoot = !message.parent_message_id || message.record_id === threadId || isPersistedThread;
    const rootTitle = normalizeString(message.title || message.subject || message.body);

    if (!existing) {
      threadRows.set(threadId, {
        id: threadId,
        channelId: message.channel_id,
        channelLabel: overviewChannelLabel(channel, { getChannelLabel, getParticipants, getSenderName, sessionNpub }),
        scopeId: channelScopeId || null,
        title: rootTitle || '(empty thread)',
        latestMessage: isMetadata ? '' : normalizeString(message.body),
        latestMessageUpdatedAt: isMetadata ? '' : message.updated_at || '',
        latestMessageSender: isMetadata ? '' : message.sender_npub || '',
        messageBodies: isMetadata ? [] : [normalizeString(message.body)],
        messageCount: isMetadata ? 0 : 1,
        rootRecordId: isThreadRoot ? message.record_id : (normalizeString(message.parent_message_id) || threadId),
        hasPersistedTitle: isPersistedThread,
        hasMetadataTitle: isMetadata,
        isBranch: Boolean(isMetadata && message.pg_parent_thread_id),
        isUnread: resourceViewStateMode
          ? unreadThreadMap?.[threadId] === true
          : unreadChannelMap?.[message.channel_id] === true,
      });
      continue;
    }

    if (!isMetadata) {
      existing.messageCount += 1;
      existing.messageBodies.push(normalizeString(message.body));
      if (isThreadRoot && !existing.isBranch) existing.rootRecordId = message.record_id;
    }
    if (isMetadata && message.pg_parent_thread_id) {
      existing.isBranch = true;
      existing.rootRecordId = message.record_id;
    }
    existing.isUnread = existing.isUnread || (resourceViewStateMode
      ? unreadThreadMap?.[threadId] === true
      : unreadChannelMap?.[message.channel_id] === true);
    if (isPersistedThread && rootTitle && (isMetadata || !existing.hasMetadataTitle)) {
      existing.title = rootTitle;
      existing.hasPersistedTitle = true;
      existing.hasMetadataTitle = isMetadata;
    } else if (isThreadRoot && rootTitle && !existing.hasPersistedTitle) {
      existing.title = rootTitle;
      existing.rootRecordId = message.record_id;
    }
    if (!isMetadata && (messageTs > existingTs || (messageTs === existingTs && String(message.record_id).localeCompare(String(existing.id)) > 0))) {
      existing.latestMessage = normalizeString(message.body);
      existing.latestMessageUpdatedAt = message.updated_at || '';
      existing.latestMessageSender = message.sender_npub || '';
    }
  }

  return [...threadRows.values()].sort((left, right) => {
    const ts = timestampMs(right.latestMessageUpdatedAt) - timestampMs(left.latestMessageUpdatedAt);
    if (ts !== 0) return ts;
    return String(left.id || '').localeCompare(String(right.id || ''));
  });
}

export function buildAutopilotOverviewTasks({
  tasks = [],
  comments = [],
  selectedScopeId = ALL_SCOPE_ID,
  selectedChannelId = ALL_CHANNEL_ID,
  scopesMap = null,
  unreadTaskMap = {},
  viewerActorId = '',
  viewerNpub = '',
  workspaceMembers = [],
} = {}) {
  const context = buildOverviewContext({ selectedScopeId, selectedChannelId });
  const taskComments = new Map();

  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment?.record_id || comment.record_state === 'deleted') continue;
    if (normalizeString(comment.target_record_family_hash) !== TASK_FAMILY) continue;
    const targetId = normalizeString(comment.target_record_id);
    if (!targetId) continue;
    const bucket = taskComments.get(targetId) || [];
    bucket.push(comment);
    taskComments.set(targetId, bucket);
  }

  const rows = [];
  let hiddenMissingContext = 0;

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task?.record_id || task.record_state === 'deleted') continue;
    if (DECK_COMPLETED_TASK_STATES.has(normalizeString(task.state).toLowerCase())) continue;
    const match = rowMatchesContext(task, context, scopesMap);
    if (!match.matches) {
      if (match.missing) hiddenMissingContext += 1;
      continue;
    }
    const commentsForTask = taskComments.get(task.record_id) || [];
    const actorOptions = { viewerActorId, viewerNpub, workspaceMembers };
    const attentionComments = commentsForTask.filter((comment) => !isTaskActivityAuthoredByViewer(comment, {
      ...actorOptions,
      kind: 'comment',
    }));
    const latestComment = attentionComments.reduce((latest, comment) => (
      timestampMs(comment.updated_at) > timestampMs(latest?.updated_at) ? comment : latest
    ), null);
    const taskUpdatedAt = task.updated_at || task.created_at || '';
    const latestCommentAt = latestComment?.updated_at || '';
    const activityAt = newestIso(taskUpdatedAt, latestCommentAt);
    if (!activityAt) continue;
    const commentDrove = timestampMs(latestCommentAt) > timestampMs(taskUpdatedAt);
    rows.push({
      id: `task:${task.record_id}`,
      kind: 'task',
      recordId: task.record_id,
      title: readableTitle(task, 'Untitled task'),
      subtitle: task.status || formatStateLabel(task.state) || 'Task',
      taskState: task.state || 'new',
      reason: commentDrove
        ? `${attentionComments.length} recent ${attentionComments.length === 1 ? 'comment' : 'comments'}`
        : (task.updated_at ? 'Task updated' : 'Task created'),
      activityAt,
      actorNpub: latestComment?.sender_npub || task.updated_by_npub || task.sender_npub || '',
      count: attentionComments.length,
      inboxSearchText: [
        task.title,
        task.name,
        task.subject,
        task.body,
        task.description,
        task.status,
        task.state,
        latestComment?.body,
      ].filter(Boolean).join(' '),
      isUnread: unreadTaskMap?.[task.record_id] === true,
      context: {
        scopeId: recordScopeId(task) || null,
        channelId: task.pg_channel_id || task.channel_id || null,
      },
      hrefTarget: { section: 'tasks', recordId: task.record_id, focusId: latestComment?.record_id || null },
    });
  }

  rows.sort((left, right) => {
    const ts = timestampMs(right.activityAt) - timestampMs(left.activityAt);
    if (ts !== 0) return ts;
    return String(left.recordId || '').localeCompare(String(right.recordId || ''));
  });
  rows.diagnostics = hiddenMissingContext > 0
    ? [`${hiddenMissingContext} task ${hiddenMissingContext === 1 ? 'record is' : 'records are'} hidden because scope/channel is missing.`]
    : [];
  return rows;
}

export function buildAutopilotOverviewDocuments({
  documents = [],
  comments = [],
  selectedScopeId = ALL_SCOPE_ID,
  selectedChannelId = ALL_CHANNEL_ID,
  scopesMap = null,
  unreadDocumentMap = {},
} = {}) {
  const context = buildOverviewContext({ selectedScopeId, selectedChannelId });
  const commentsByDocument = new Map();

  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment?.record_id || comment.record_state === 'deleted') continue;
    if (normalizeString(comment.target_record_family_hash) !== DOCUMENT_FAMILY) continue;
    if (!commentIsOpen(comment)) continue;
    const targetId = normalizeString(comment.target_record_id);
    if (!targetId) continue;
    const bucket = commentsByDocument.get(targetId) || [];
    bucket.push(comment);
    commentsByDocument.set(targetId, bucket);
  }

  const rows = [];
  let hiddenMissingContext = 0;

  for (const document of Array.isArray(documents) ? documents : []) {
    if (!document?.record_id || document.record_state === 'deleted') continue;
    if (isFileBackedDocument(document)) continue;
    const match = rowMatchesContext(document, context, scopesMap);
    if (!match.matches) {
      if (match.missing) hiddenMissingContext += 1;
      continue;
    }
    const commentsForDocument = commentsByDocument.get(document.record_id) || [];
    const latestComment = commentsForDocument.reduce((latest, comment) => (
      timestampMs(comment.updated_at) > timestampMs(latest?.updated_at) ? comment : latest
    ), null);
    const documentUpdatedAt = document.updated_at || document.created_at || '';
    const latestCommentAt = latestComment?.updated_at || '';
    const activityAt = newestIso(documentUpdatedAt, latestCommentAt);
    if (!activityAt) continue;
    const commentDrove = timestampMs(latestCommentAt) > timestampMs(documentUpdatedAt);
    rows.push({
      id: `document:${document.record_id}`,
      kind: 'document',
      recordId: document.record_id,
      title: readableTitle(document, 'Untitled document'),
      subtitle: document.summary || document.content || 'Document',
      reason: commentsForDocument.length > 0
        ? `${commentsForDocument.length} unresolved ${commentsForDocument.length === 1 ? 'comment' : 'comments'}`
        : (document.updated_at ? 'Document updated' : 'Document created'),
      activityAt,
      actorNpub: latestComment?.sender_npub || document.updated_by_npub || document.sender_npub || '',
      count: commentsForDocument.length,
      latestCommentAt,
      commentDrove,
      inboxSearchText: [
        document.title,
        document.name,
        document.subject,
        document.summary,
        document.content,
        document.body,
        latestComment?.body,
      ].filter(Boolean).join(' '),
      isUnread: unreadDocumentMap?.[document.record_id] === true,
      context: {
        scopeId: recordScopeId(document) || null,
        channelId: document.pg_channel_id || document.channel_id || null,
      },
      hrefTarget: { section: 'docs', recordId: document.record_id, focusId: latestComment?.record_id || null },
    });
  }

  rows.sort((left, right) => {
    const ts = timestampMs(right.activityAt) - timestampMs(left.activityAt);
    if (ts !== 0) return ts;
    return String(left.recordId || '').localeCompare(String(right.recordId || ''));
  });
  rows.diagnostics = hiddenMissingContext > 0
    ? [`${hiddenMissingContext} document ${hiddenMissingContext === 1 ? 'record is' : 'records are'} hidden because scope/channel is missing.`]
    : [];
  return rows;
}

export function countUnresolvedDocumentComments({ documents = [], comments = [] } = {}) {
  const documentIds = new Set(
    (Array.isArray(documents) ? documents : [])
      .filter((document) => document?.record_id && document.record_state !== 'deleted')
      .map((document) => document.record_id)
  );
  let count = 0;
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!comment?.record_id || comment.record_state === 'deleted') continue;
    if (!documentIds.has(comment.target_record_id)) continue;
    if (normalizeString(comment.target_record_family_hash) !== DOCUMENT_FAMILY) continue;
    if (commentIsOpen(comment)) count += 1;
  }
  return count;
}

export function buildAutopilotOverviewFiles(rows = [], {
  selectedScopeId = ALL_SCOPE_ID,
  selectedChannelId = ALL_CHANNEL_ID,
  scopesMap = null,
} = {}) {
  const context = buildOverviewContext({ selectedScopeId, selectedChannelId });
  const diagnostics = [];
  const filtered = [];
  let hiddenMissingContext = 0;
  for (const row of standaloneDeckFiles(Array.isArray(rows) ? rows : [])) {
    if (isDocumentBodyStorageRow(row)) continue;
    const match = rowMatchesContext(row, context, scopesMap);
    if (match.matches) {
      filtered.push({
        ...row,
        ...getOverviewFileSourceContract(row),
        isUnread: false,
        activityAt: row.updated_at || row.created_at || row.uploaded_at || '',
        reason: row.updated_at ? 'Edited file' : 'Uploaded file',
      });
    } else if (match.missing) {
      hiddenMissingContext += 1;
    }
  }
  if (hiddenMissingContext > 0) {
    diagnostics.push(`${hiddenMissingContext} file ${hiddenMissingContext === 1 ? 'record is' : 'records are'} hidden because scope/channel is missing.`);
  }
  const sorted = filtered.sort((left, right) => {
    const ts = timestampMs(right.activityAt) - timestampMs(left.activityAt);
    if (ts !== 0) return ts;
    const name = String(left.name || '').localeCompare(String(right.name || ''));
    if (name !== 0) return name;
    return String(left.object_id || '').localeCompare(String(right.object_id || ''));
  });
  sorted.diagnostics = diagnostics;
  return sorted;
}

export function getOverviewFileSourceContract(row = {}) {
  const sourceType = normalizeString(row.source_target_type || row.source_type);
  if (sourceType === 'task') {
    return {
      sourceDestinationType: 'task',
      sourceTypeLabel: 'Task attachment',
      sourceActionLabel: 'Open task',
      sourceAriaLabel: 'Open source task',
    };
  }
  if (sourceType === 'document' || sourceType === 'comment') {
    return {
      sourceDestinationType: 'document',
      sourceTypeLabel: 'Document attachment',
      sourceActionLabel: 'Open doc',
      sourceAriaLabel: 'Open source document',
    };
  }
  if (sourceType === 'chat' || (row.source_type === 'audio' && row.channel_id)) {
    return {
      sourceDestinationType: 'chat',
      sourceTypeLabel: 'Chat attachment',
      sourceActionLabel: 'Open chat',
      sourceAriaLabel: 'Open source chat',
    };
  }
  return {
    sourceDestinationType: 'files',
    sourceTypeLabel: 'File attachment',
    sourceActionLabel: 'Open files',
    sourceAriaLabel: 'Open Files',
  };
}

export function buildAutopilotOverviewInbox({ threads = [], files = [], documents = [], tasks = [], workingResourceKeys = null } = {}) {
  return [
    ...(Array.isArray(threads) ? threads : []).map((row) => ({
      ...row,
      inboxKind: 'chat',
      inboxActivityAt: row.latestMessageUpdatedAt || '',
    })).map((row) => ({ ...row, isWorking: isInboxRowWorking(row, workingResourceKeys) })),
    ...standaloneDeckFiles(Array.isArray(files) ? files : []).map((row) => ({
      ...row,
      ...getOverviewFileSourceContract(row),
      inboxKind: 'file',
      isUnread: false,
      inboxActivityAt: row.activityAt || row.updated_at || row.created_at || row.uploaded_at || '',
      isWorking: false,
    })),
    ...(Array.isArray(documents) ? documents : []).map((row) => ({
      ...row,
      inboxKind: 'document',
      inboxActivityAt: row.activityAt || '',
    })).map((row) => ({ ...row, isWorking: isInboxRowWorking(row, workingResourceKeys) })),
    ...(Array.isArray(tasks) ? tasks : [])
      .filter((row) => shouldIncludeInboxTask(row))
      .map((row) => ({
        ...row,
        inboxKind: 'task',
        inboxActivityAt: row.activityAt || '',
      })).map((row) => ({ ...row, isWorking: isInboxRowWorking(row, workingResourceKeys) })),
  ].sort((left, right) => {
    const ts = timestampMs(right.inboxActivityAt) - timestampMs(left.inboxActivityAt);
    if (ts !== 0) return ts;
    return String(left.id || left.recordId || left.object_id || '')
      .localeCompare(String(right.id || right.recordId || right.object_id || ''));
  });
}

function inboxRowSearchText(row = {}) {
  if (row.inboxKind === 'chat') {
    return [row.title, row.latestMessage, row.channelLabel, ...(row.messageBodies || [])].join(' ');
  }
  if (row.inboxKind === 'task') {
    return [row.title, row.subtitle, row.reason, row.inboxSearchText].join(' ');
  }
  if (row.inboxKind === 'document') {
    return [row.title, row.subtitle, row.reason, row.inboxSearchText].join(' ');
  }
  if (row.inboxKind === 'file') {
    return [
      row.name,
      row.display_name,
      row.title,
      row.source_label,
      row.source_type,
      row.reason,
      row.summary,
      row.description,
      row.content,
      row.body,
      row.mime_type,
    ].join(' ');
  }
  return '';
}

export const DECK_INBOX_TYPES = Object.freeze(['chat', 'task', 'document', 'file']);

// Accept the old in-memory single selection while allowing any combination.
export function normalizeDeckInboxTypes(value = 'all') {
  if (Array.isArray(value)) return DECK_INBOX_TYPES.filter(type => value.includes(type));
  return DECK_INBOX_TYPES.includes(value) ? [value] : [...DECK_INBOX_TYPES];
}

export function filterAutopilotOverviewInbox(rows = [], query = '', type = 'all') {
  const needle = normalizeInboxSearchText(query);
  const source = (Array.isArray(rows) ? rows : []).filter(row => normalizeDeckInboxTypes(type).includes(row.inboxKind));
  if (!needle) return source;
  return source.filter((row) => normalizeInboxSearchText(inboxRowSearchText(row)).includes(needle));
}

export function sliceAutopilotOverviewInbox(rows = [], visibleCount = DECK_INBOX_PAGE_SIZE) {
  const count = Math.max(0, Number(visibleCount) || 0);
  return (Array.isArray(rows) ? rows : []).slice(0, count);
}

export function nextDeckInboxVisibleCount(currentCount, totalCount, pageSize = DECK_INBOX_PAGE_SIZE) {
  const current = Math.max(0, Number(currentCount) || 0);
  const total = Math.max(0, Number(totalCount) || 0);
  const increment = Math.max(1, Number(pageSize) || DECK_INBOX_PAGE_SIZE);
  return Math.min(total, current + increment);
}

export function buildRecentChannels(threads = [], { limit = 10 } = {}) {
  const latestByChannel = new Map();
  const sortedThreads = (Array.isArray(threads) ? threads : [])
    .filter((thread) => normalizeString(thread?.channelId) && normalizeString(thread?.id || thread?.rootRecordId))
    .sort((left, right) => {
      const ts = timestampMs(right.latestMessageUpdatedAt) - timestampMs(left.latestMessageUpdatedAt);
      if (ts !== 0) return ts;
      return String(left.id || left.rootRecordId || '').localeCompare(String(right.id || right.rootRecordId || ''));
    });

  for (const thread of sortedThreads) {
    const channelId = normalizeString(thread.channelId);
    if (!latestByChannel.has(channelId)) latestByChannel.set(channelId, thread);
  }

  const boundedLimit = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 10;
  return [...latestByChannel.values()].slice(0, boundedLimit);
}

const DECK_MOBILE_CARDS = Object.freeze([
  { id: 'hello-links', label: 'Hello and Links' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'wapp-updates', label: 'Feed' },
  { id: 'recent', label: 'Recent' },
]);

export const autopilotOverviewManagerMixin = {
  deckThreadComposerOpen: false,
  deckThreadComposerChannelId: '',
  deckThreadComposerBusy: false,
  deckThreadComposerRouted: false,
  deckThreadTitleManuallyEdited: false,
  deckThreadCreateRequestId: '',
  deckThreadReturnContext: null,
  deckThreadNavigationRows: [],
  deckThreadSwipeStart: null,
  deckThreadChannelId: '',
  deckThreadChannelRecord: null,
  deckThreadChannelState: 'idle',
  deckThreadChannelError: '',
  deckThreadChannelRequestId: 0,
  deckThreadTowerId: '',
  deckMobileColumn: 'inbox',
  deckMobileCards: DECK_MOBILE_CARDS,
  deckMobileInitialized: false,
  deckMobileTrack: null,
  deckMobileHelloMarker: null,
  deckMobileMediaQuery: null,
  deckMobileMediaQueryHandler: null,
  deckMobileResizeObserver: null,
  deckMobileEntryResetToken: 0,
  deckMobileEntryResetPending: false,
  deckInboxType: 'all',
  recentChannelMessages: null,
  deckInboxSearchDraft: '',
  deckInboxSearchQuery: '',
  deckInboxVisibleCount: DECK_INBOX_PAGE_SIZE,
  deckInboxContextKey: '',
  deckInboxScopeId: '',
  deckInboxWorkingProjectionRevision: 0,
  deckInboxWorkingExpireTimer: null,

  get deckThreadComposerChannelOptions() {
    return (Array.isArray(this.channels) ? this.channels : [])
      .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
      .filter((channel) => channel.can_write !== false && channel.writable !== false);
  },

  captureDeckReturnContext() {
    const scrollArea = typeof document !== 'undefined'
      ? document.querySelector('.content-scroll-area')
      : null;
    const columnsTrack = typeof document !== 'undefined'
      ? document.querySelector('[data-deck-columns-track]')
      : null;
    const inboxColumn = typeof document !== 'undefined'
      ? document.querySelector('[data-deck-column="inbox"]')
      : null;
    const recentColumn = typeof document !== 'undefined'
      ? document.querySelector('[data-deck-column="recent"]')
      : null;
    const wappUpdatesColumn = typeof document !== 'undefined'
      ? document.querySelector('[data-deck-column="wapp-updates"]')
      : null;
    return {
      selectedBoardId: this.selectedBoardId || null,
      selectedChannelId: this.selectedChannelId || null,
      summaryCollapsedPanels: { ...(this.summaryCollapsedPanels || {}) },
      summaryPanelPages: { ...(this.summaryPanelPages || {}) },
      dailyScopeSelectedDate: this.dailyScopeSelectedDate || '',
      scrollTop: Number(scrollArea?.scrollTop || 0),
      deckMobileColumn: (this.deckMobileCards || DECK_MOBILE_CARDS).some((card) => card.id === this.deckMobileColumn) ? this.deckMobileColumn : 'inbox',
      deckColumnsScrollLeft: Number(columnsTrack?.scrollLeft || 0),
      deckInboxScrollTop: Number(inboxColumn?.scrollTop || 0),
      deckRecentScrollTop: Number(recentColumn?.scrollTop || 0),
      deckWappUpdatesScrollTop: Number(wappUpdatesColumn?.scrollTop || 0),
    };
  },

  restoreDeckReturnContext(context = this.deckThreadReturnContext) {
    if (!context) return;
    this.deckMobileEntryResetToken = Number(this.deckMobileEntryResetToken || 0) + 1;
    this.deckMobileEntryResetPending = false;
    this.selectedBoardId = context.selectedBoardId || null;
    this.selectedChannelId = context.selectedChannelId || null;
    this.summaryCollapsedPanels = { ...(context.summaryCollapsedPanels || {}) };
    this.summaryPanelPages = { ...(context.summaryPanelPages || {}) };
    this.dailyScopeSelectedDate = context.dailyScopeSelectedDate || '';
    this.deckMobileColumn = (this.deckMobileCards || DECK_MOBILE_CARDS).some((card) => card.id === context.deckMobileColumn) ? context.deckMobileColumn : 'inbox';
    this.persistSelectedBoardId?.(this.selectedBoardId);
    this.restoreChatComposerDraft?.('message');
    if (typeof document === 'undefined') return;
    const restore = () => {
      const scrollArea = document.querySelector('.content-scroll-area');
      if (scrollArea) scrollArea.scrollTop = Number(context.scrollTop || 0);
      const columnsTrack = document.querySelector('[data-deck-columns-track]');
      if (columnsTrack) columnsTrack.scrollLeft = Number(context.deckColumnsScrollLeft || 0);
      const inboxColumn = document.querySelector('[data-deck-column="inbox"]');
      if (inboxColumn) inboxColumn.scrollTop = Number(context.deckInboxScrollTop || 0);
      const recentColumn = document.querySelector('[data-deck-column="recent"]');
      if (recentColumn) recentColumn.scrollTop = Number(context.deckRecentScrollTop || 0);
      const wappUpdatesColumn = document.querySelector('[data-deck-column="wapp-updates"]');
      if (wappUpdatesColumn) wappUpdatesColumn.scrollTop = Number(context.deckWappUpdatesScrollTop || 0);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
  },

  async prepareDeckComposerChannel(channelId) {
    const normalizedChannelId = normalizeString(channelId);
    this.deckThreadComposerChannelId = normalizedChannelId;
    if (!normalizedChannelId) return false;
    await this.selectChannel(normalizedChannelId, {
      syncRoute: false,
      scrollToLatest: false,
      backgroundRemoteRefresh: true,
    });
    if (this.deckThreadReturnContext?.selectedBoardId) {
      this.selectedBoardId = this.deckThreadReturnContext.selectedBoardId;
      this.persistSelectedBoardId?.(this.selectedBoardId);
    }
    return String(this.selectedChannelId || '') === normalizedChannelId;
  },

  resetDeckThreadCreateState({ preserveRouting = false } = {}) {
    this.deckThreadComposerOpen = false;
    this.deckThreadComposerChannelId = '';
    this.deckThreadComposerBusy = false;
    if (!preserveRouting) this.deckThreadComposerRouted = false;
    this.deckThreadTitleManuallyEdited = false;
    this.deckThreadCreateRequestId = '';
    this.threadTitleDraft = '';
    this.threadTitleEditing = false;
    this.threadTitleError = '';
    this.threadInput = '';
    this.threadAudioDrafts = [];
    this.selectedAgentMentionsByComposer = {
      ...(this.selectedAgentMentionsByComposer || {}),
      thread: [],
    };
    if (typeof this.clearChatFileDrafts === 'function') this.clearChatFileDrafts('thread');
    else this.threadFileDrafts = [];
    this.scheduleComposerAutosize?.('thread');
  },

  updateDeckThreadCreateBody(value = this.threadInput) {
    if (this.deckThreadTitleManuallyEdited) return this.threadTitleDraft;
    this.threadTitleDraft = deriveDeckThreadCreateTitle(value);
    return this.threadTitleDraft;
  },

  editDeckThreadCreateTitle(value) {
    this.deckThreadTitleManuallyEdited = true;
    this.threadTitleDraft = String(value || '').slice(0, 120);
  },

  async beginDeckThreadCreate(channelId, { routed = false } = {}) {
    const normalizedChannelId = normalizeString(channelId);
    if (!normalizedChannelId || !this.deckThreadComposerChannelOptions.some((channel) => channel.record_id === normalizedChannelId)) {
      this.error = 'Choose a writable channel before starting the thread.';
      return false;
    }
    this.resetDeckThreadCreateState({ preserveRouting: true });
    this.deckThreadComposerRouted = routed;
    this.deckThreadComposerChannelId = normalizedChannelId;
    this.deckThreadComposerOpen = true;
    this.deckThreadCreateRequestId = crypto.randomUUID();
    this.error = null;
    const ready = await this.prepareDeckComposerChannel(normalizedChannelId);
    if (!ready) {
      this.deckThreadComposerOpen = false;
      this.error = 'Could not prepare that channel for a new thread.';
      return false;
    }
    const focusComposer = () => document.querySelector?.('[data-chat-composer="thread"]')?.focus?.();
    if (typeof document !== 'undefined') {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusComposer);
      else focusComposer();
    }
    return true;
  },

  async openDeckThreadComposer() {
    if (this.deckThreadComposerOpen || this.showWriteContextModal) return false;
    this.deckThreadReturnContext = this.captureDeckReturnContext();
    this.error = null;
    const resolved = this.resolvePgWriteContext?.({ boardId: this.selectedBoardId }) || null;
    if (resolved?.scopeId && resolved?.channelId) {
      return this.beginDeckThreadCreate(resolved.channelId, { routed: false });
    }
    const overviewScopeId = normalizeString(this.autopilotOverviewContext?.scopeId);
    const initialScopeId = overviewScopeId && overviewScopeId !== ALL_SCOPE_ID
      ? overviewScopeId
      : '';
    this.writeContextPendingAction = {
      type: 'deck-thread-create',
      payload: { options: { boardId: this.selectedBoardId } },
    };
    this.writeContextScopeId = initialScopeId;
    this.writeContextChannelId = '';
    this.writeContextError = '';
    this.showWriteContextModal = true;
    return false;
  },

  closeDeckThreadComposer() {
    if (this.deckThreadComposerBusy) return;
    const returnContext = this.deckThreadReturnContext;
    this.resetDeckThreadCreateState();
    this.restoreDeckReturnContext(returnContext);
    this.deckThreadReturnContext = null;
  },

  cancelDeckThreadRouting() {
    const returnContext = this.deckThreadReturnContext;
    this.showWriteContextModal = false;
    this.resetDeckThreadCreateState();
    this.restoreDeckReturnContext(returnContext);
    this.deckThreadReturnContext = null;
  },

  backDeckThreadComposerToRouting() {
    if (this.deckThreadComposerBusy || !this.deckThreadComposerRouted) return false;
    const channelId = normalizeString(this.deckThreadComposerChannelId);
    const channel = this.deckThreadComposerChannelOptions.find((entry) => entry.record_id === channelId) || null;
    const scopeId = normalizeString(getPgChannelScopeId(channel));
    this.resetDeckThreadCreateState();
    this.writeContextPendingAction = {
      type: 'deck-thread-create',
      payload: { options: { boardId: this.deckThreadReturnContext?.selectedBoardId || this.selectedBoardId } },
    };
    this.writeContextScopeId = scopeId;
    this.writeContextChannelId = channelId;
    this.writeContextError = '';
    this.showWriteContextModal = true;
    return true;
  },

  async sendDeckThread() {
    if (this.deckThreadComposerBusy || this.composerSendPending?.thread) return false;
    this.commitMentionComposerDraft?.('thread');
    const channelId = normalizeString(this.deckThreadComposerChannelId);
    if (!channelId) {
      this.error = 'Choose a channel before starting the thread.';
      return false;
    }
    this.deckThreadComposerBusy = true;
    try {
      if (String(this.selectedChannelId || '') !== channelId) {
        const ready = await this.prepareDeckComposerChannel(channelId);
        if (!ready) return false;
      }
      const title = normalizeString(this.threadTitleDraft) || deriveDeckThreadCreateTitle(this.threadInput) || 'Untitled thread';
      const created = await this.sendMessage({
        composerContext: 'thread-create',
        threadTitle: title,
        clientRequestId: this.deckThreadCreateRequestId,
        returnMessage: true,
      });
      if (!created?.record_id || !created?.pg_thread_id) return false;
      const returnContext = this.deckThreadReturnContext;
      const createdChannelId = channelId;
      this.resetDeckThreadCreateState();
      this.restoreDeckReturnContext(returnContext);
      this.deckThreadReturnContext = null;
      await this.openDeckThread(createdChannelId, created.record_id, {
        towerThreadId: created.pg_thread_id,
        captureReturnContext: false,
        syncRoute: false,
      });
      return true;
    } finally {
      this.deckThreadComposerBusy = false;
    }
  },

  async openDeckThread(channelId, threadId, options = {}) {
    const normalizedChannelId = normalizeString(channelId);
    const normalizedThreadId = normalizeString(threadId);
    if (!normalizedChannelId || !normalizedThreadId) return;
    if (options.requestId == null) {
      this.autopilotOverviewThreadOpenRequestId = Number(this.autopilotOverviewThreadOpenRequestId || 0) + 1;
    }
    if (!this.deckThreadReturnContext || options.captureReturnContext !== false) {
      this.deckThreadReturnContext = this.captureDeckReturnContext();
    }
    // Save under the outgoing channel before switching the modal destination.
    this.saveChatComposerDraft?.('thread');
    this.deckThreadChannelId = normalizedChannelId;
    this.deckThreadChannelRecord = null;
    this.deckThreadChannelState = 'loading';
    this.deckThreadChannelError = '';
    const channelMessages = (Array.isArray(this.fileMessages) ? this.fileMessages : [])
      .filter((message) => normalizeString(message?.channel_id) === normalizedChannelId);
    const matchingMessage = channelMessages.find((message) => (
      normalizeString(message?.record_id) === normalizedThreadId
      || normalizeString(message?.parent_message_id) === normalizedThreadId
    ));
    this.deckThreadTowerId = normalizeString(
      options.towerThreadId
      || matchingMessage?.pg_thread_id
      || ''
    );
    if (
      options.requestId != null
      && Number(this.autopilotOverviewThreadOpenRequestId || 0) !== Number(options.requestId)
    ) return false;
    this.focusMessageId = normalizedThreadId;
    this.openThread(normalizedThreadId, {
      syncRoute: false,
      preserveChannelContext: true,
      saveDraft: false,
      scrollToLatest: options.scrollToLatest,
    });
    void (this.resolveDeckThreadChannel || autopilotOverviewManagerMixin.resolveDeckThreadChannel)
      .call(this, normalizedChannelId);
    if (options.syncRoute !== false) this.syncRoute?.(options.replaceRoute === true);
    return true;
  },

  setDeckThreadChannelReady(channel) {
    if (!channel || normalizeString(channel.record_id) !== normalizeString(this.deckThreadChannelId)) return false;
    if (channel.record_state === 'deleted' || channel.can_read === false || channel.readable === false) {
      this.deckThreadChannelRecord = null;
      this.deckThreadChannelState = 'error';
      this.deckThreadChannelError = 'This thread channel is no longer available.';
      return false;
    }
    this.deckThreadChannelRecord = channel;
    this.deckThreadChannelState = 'ready';
    this.deckThreadChannelError = '';
    return true;
  },

  async resolveDeckThreadChannel(channelId = this.deckThreadChannelId, { force = false } = {}) {
    const normalizedChannelId = normalizeString(channelId);
    if (!normalizedChannelId || normalizedChannelId !== normalizeString(this.deckThreadChannelId)) return false;
    const requestId = Number(this.deckThreadChannelRequestId || 0) + 1;
    this.deckThreadChannelRequestId = requestId;
    this.deckThreadChannelState = 'loading';
    this.deckThreadChannelError = '';
    const context = resolveTowerPgWorkspaceContext(this);
    const sourceThreadId = this.activeThreadId;
    const sourceThreadGeneration = this.threadHistoryGeneration;
    const isCurrent = () => {
      const current = resolveTowerPgWorkspaceContext(this);
      return requestId === this.deckThreadChannelRequestId
        && normalizedChannelId === normalizeString(this.deckThreadChannelId)
        && Boolean(this.activeThreadId) && this.activeThreadId === sourceThreadId
        && this.threadHistoryGeneration === sourceThreadGeneration
        && ['workspaceId', 'baseUrl', 'appNpub', 'generation', 'sessionNpub'].every(key => current[key] === context[key]);
    };
    const findChannel = async () => (this.channels || []).find((channel) => normalizeString(channel?.record_id) === normalizedChannelId)
      || await getChannelById(normalizedChannelId).catch(() => null);
    try {
      let channel = await findChannel();
      if (!isCurrent()) return false;
      if (channel && this.setDeckThreadChannelReady(channel)) return true;
      if (typeof this.requestTowerSyncFamily !== 'function') throw new Error('Channel refresh is unavailable.');
      await this.requestTowerSyncFamily('channel', normalizedChannelId, { force: true });
      if (!isCurrent()) return false;
      channel = await findChannel();
      if (!isCurrent()) return false;
      if (channel && this.setDeckThreadChannelReady(channel)) return true;
      throw new Error('The thread channel could not be loaded.');
    } catch (error) {
      if (!isCurrent()) return false;
      this.deckThreadChannelRecord = null;
      this.deckThreadChannelState = 'error';
      this.deckThreadChannelError = error?.message || 'The thread channel could not be loaded.';
      return false;
    }
  },

  retryDeckThreadChannel() {
    return this.resolveDeckThreadChannel(this.deckThreadChannelId, { force: true });
  },

  captureDeckThreadNavigationRows(thread = {}) {
    const threadId = normalizeString(thread?.rootRecordId || thread?.id);
    const inboxRows = (Array.isArray(this.visibleAutopilotOverviewInbox) ? this.visibleAutopilotOverviewInbox : [])
      .filter((row) => row?.inboxKind === 'chat');
    const summaryRows = Array.isArray(this.pagedAutopilotOverviewThreads) ? this.pagedAutopilotOverviewThreads : [];
    const source = inboxRows.some((row) => normalizeString(row?.rootRecordId || row?.id) === threadId)
      ? inboxRows
      : summaryRows;
    this.deckThreadNavigationRows = source.map((row) => ({ ...row }));
    return this.deckThreadNavigationRows;
  },

  getDeckThreadNavigationNeighbour(direction) {
    return resolveVisibleThreadNeighbour(
      this.deckThreadNavigationRows,
      this.activeThreadId,
      direction,
    );
  },

  canNavigateDeckThread(direction) {
    return Boolean(this.navSection === 'status' && this.getDeckThreadNavigationNeighbour(direction));
  },

  async navigateDeckThread(direction) {
    const neighbour = this.getDeckThreadNavigationNeighbour(direction);
    if (!neighbour) return false;
    await this.openAutopilotOverviewThread(neighbour, {
      preserveNavigationRows: true,
      replaceRoute: true,
    });
    return this.activeThreadId === normalizeString(neighbour.rootRecordId || neighbour.id);
  },

  handleDeckThreadNavigationKeydown(event) {
    if (this.navSection !== 'status' || !this.activeThreadId || this.deckThreadComposerOpen) return false;
    if (event?.key !== 'ArrowRight' && event?.key !== 'ArrowLeft') return false;
    if (shouldSuppressThreadNavigation(event)) return false;
    const direction = event.key === 'ArrowRight' ? 'older' : 'newer';
    if (!this.canNavigateDeckThread(direction)) return false;
    event.preventDefault?.();
    void this.navigateDeckThread(direction);
    return true;
  },

  beginDeckThreadSwipe(event) {
    if (this.deckThreadComposerOpen || event?.touches?.length !== 1) {
      this.deckThreadSwipeStart = null;
      return;
    }
    if (shouldSuppressThreadNavigation({ ...event, target: event.target })) {
      this.deckThreadSwipeStart = null;
      return;
    }
    const touch = event.touches[0];
    this.deckThreadSwipeStart = { x: touch.clientX, y: touch.clientY };
  },

  endDeckThreadSwipe(event) {
    const start = this.deckThreadSwipeStart;
    this.deckThreadSwipeStart = null;
    if (!start || event?.changedTouches?.length !== 1 || String(event?.type || '') === 'touchcancel') return false;
    if (typeof window !== 'undefined' && window.getSelection?.()?.toString()) return false;
    const touch = event.changedTouches[0];
    const direction = resolveHorizontalSwipe(start, { x: touch.clientX, y: touch.clientY }, {
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
    });
    if (!direction || !this.canNavigateDeckThread(direction)) return false;
    void this.navigateDeckThread(direction);
    return true;
  },

  async reconcileDeckThreadMessages() {
    if (this.navSection !== 'status' || !this.activeThreadId || !this.deckThreadChannelId) return false;
    // Inbox activity can refresh while a detail is open. Its preview rows must
    // never replace the dedicated thread subscription's history window.
    this.startWorkspaceLiveQueries?.();
    return true;
  },

  closeDeckThread(options = {}) {
    const returnContext = this.deckThreadReturnContext;
    const canGoBack = options.fromRoute !== true
      && typeof window !== 'undefined'
      && window.history?.state?.deckThreadModal === true;
    if (canGoBack) {
      window.history.back();
      return true;
    }
    this.closeThread({ syncRoute: false });
    this.restoreDeckReturnContext(returnContext);
    this.deckThreadReturnContext = null;
    this.deckThreadChannelId = '';
    this.deckThreadChannelRecord = null;
    this.deckThreadChannelState = 'idle';
    this.deckThreadChannelError = '';
    this.deckThreadChannelRequestId = Number(this.deckThreadChannelRequestId || 0) + 1;
    this.deckThreadTowerId = '';
    this.deckThreadNavigationRows = [];
    this.deckThreadSwipeStart = null;
    if (options.syncRoute !== false) this.syncRoute?.(true);
    return true;
  },

  closeVisibleThread() {
    if (this.navSection === 'status') return this.closeDeckThread();
    return this.closeThread();
  },

  initMobileDeck(track) {
    if (!track || typeof document === 'undefined' || typeof window === 'undefined') return;
    if (this.deckMobileMediaQuery && this.deckMobileMediaQueryHandler) {
      if (this.deckMobileMediaQuery.removeEventListener) {
        this.deckMobileMediaQuery.removeEventListener('change', this.deckMobileMediaQueryHandler);
      } else {
        this.deckMobileMediaQuery.removeListener?.(this.deckMobileMediaQueryHandler);
      }
    }
    this.deckMobileResizeObserver?.disconnect?.();
    this.deckMobileTrack = track;
    const helloCard = document.querySelector('[data-deck-hello-card]');
    const helloExtras = [
      document.querySelector('.flightdeck-summary-daily'),
      document.querySelector('.workroom-browser'),
    ].filter(Boolean);
    const markerBelongsToCurrentDeck = Boolean(
      helloCard
      && this.deckMobileHelloMarker?.isConnected
      && this.deckMobileHelloMarker.parentNode
      && this.deckMobileHelloMarker.parentNode.contains?.(track)
    );
    if (helloCard && !markerBelongsToCurrentDeck) {
      this.deckMobileHelloMarker = document.createComment('deck-hello-card');
      helloCard.parentNode?.insertBefore(this.deckMobileHelloMarker, helloCard);
    }
    const extraMarkers = helloExtras.map((element) => {
      const marker = document.createComment('deck-hello-extra');
      element.parentNode?.insertBefore(marker, element);
      return { element, marker };
    });
    const applyLayout = () => {
      const mobile = this.deckMobileMediaQuery?.matches === true;
      const marker = this.deckMobileHelloMarker;
      if (mobile && helloCard && helloCard.parentNode !== track) track.insertBefore(helloCard, track.firstElementChild);
      if (!mobile && helloCard && marker?.parentNode && helloCard.parentNode !== marker.parentNode) {
        marker.parentNode.insertBefore(helloCard, marker.nextSibling);
      }
      for (const { element, marker: extraMarker } of extraMarkers) {
        if (mobile && helloCard && element.parentNode !== helloCard) helloCard.appendChild(element);
        if (!mobile && extraMarker.parentNode && element.parentNode !== extraMarker.parentNode) {
          extraMarker.parentNode.insertBefore(element, extraMarker.nextSibling);
        }
      }
      if (mobile) {
        const selectedCard = this.deckMobileEntryResetPending
          ? 'inbox'
          : (this.deckMobileInitialized ? this.deckMobileColumn : 'inbox');
        this.deckMobileColumn = selectedCard;
        this.positionDeckMobileCard(selectedCard);
        track.dataset.deckReady = 'true';
        this.deckMobileInitialized = true;
      } else {
        delete track.dataset.deckReady;
      }
    };
    this.deckMobileMediaQuery = window.matchMedia('(max-width: 720px)');
    this.deckMobileMediaQueryHandler = applyLayout;
    if (this.deckMobileMediaQuery.addEventListener) this.deckMobileMediaQuery.addEventListener('change', applyLayout);
    else this.deckMobileMediaQuery.addListener?.(applyLayout);
    if (typeof ResizeObserver === 'function') {
      this.deckMobileResizeObserver = new ResizeObserver(() => {
        if (this.deckMobileMediaQuery?.matches) this.positionDeckMobileCard(this.deckMobileColumn);
      });
      this.deckMobileResizeObserver.observe(track);
    }
    applyLayout();
    const settle = () => {
      if (!this.deckMobileMediaQuery?.matches) return;
      this.positionDeckMobileCard(this.deckMobileColumn);
      track.dataset.deckReady = 'true';
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(settle));
  },

  positionDeckMobileCard(cardId, { focus = false } = {}) {
    const track = this.deckMobileTrack || (typeof document !== 'undefined' ? document.querySelector('[data-deck-columns-track]') : null);
    if (!track) return false;
    const card = track.querySelector?.(`[data-deck-column="${cardId}"]`);
    if (!card) return false;
    const cardRect = card.getBoundingClientRect?.();
    const trackRect = track.getBoundingClientRect?.();
    const left = cardRect && trackRect
      ? Number(track.scrollLeft || 0) + cardRect.left - trackRect.left
      : Number(card.offsetLeft || 0) - Number(track.offsetLeft || 0);
    track.scrollLeft = Math.max(0, left);
    if (focus) card.querySelector?.('button, input, a, [tabindex]:not([tabindex="-1"])')?.focus?.({ preventScroll: true });
    return true;
  },

  resetDeckMobileEntry() {
    const token = Number(this.deckMobileEntryResetToken || 0) + 1;
    this.deckMobileEntryResetToken = token;
    this.deckMobileEntryResetPending = true;
    this.deckMobileColumn = 'inbox';
    this.positionDeckMobileCard('inbox');

    const settle = () => {
      if (this.deckMobileEntryResetToken !== token) return;
      this.deckMobileColumn = 'inbox';
      this.positionDeckMobileCard('inbox');
      this.deckMobileEntryResetPending = false;
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.deckMobileEntryResetToken !== token) return;
        this.deckMobileColumn = 'inbox';
        this.positionDeckMobileCard('inbox');
        requestAnimationFrame(settle);
      });
    } else {
      settle();
    }
    return true;
  },

  selectDeckMobileCard(cardId, options = {}) {
    if (!(this.deckMobileCards || DECK_MOBILE_CARDS).some((card) => card.id === cardId)) return false;
    this.deckMobileColumn = cardId;
    return this.positionDeckMobileCard(cardId, options);
  },

  handleDeckColumnsScroll(event) {
    if (this.deckMobileEntryResetPending) return;
    const track = event?.currentTarget;
    const width = Number(track?.clientWidth || 0);
    if (!width) return;
    const cards = this.deckMobileCards || DECK_MOBILE_CARDS;
    const index = Math.max(0, Math.min(cards.length - 1, Math.round(Number(track.scrollLeft || 0) / width)));
    this.deckMobileColumn = cards[index].id;
  },

  resetDeckInboxSources() {
    this.deckInboxVisibleCount = DECK_INBOX_PAGE_SIZE;
    this.inboxActivityVisibleCount = 100;
    this.inboxActivityPageHasMore = {};
    this.inboxActivityLoading = true;
    this.inboxActivityQueryRevision = (this.inboxActivityQueryRevision || 0) + 1;
    this.startWorkspaceLiveQueries?.();
  },

  deckInboxTypes: DECK_INBOX_TYPES,

  isDeckInboxTypeVisible(type) {
    return normalizeDeckInboxTypes(this.deckInboxType).includes(type);
  },

  toggleDeckInboxType(type) {
    if (!DECK_INBOX_TYPES.includes(type)) return;
    const shown = normalizeDeckInboxTypes(this.deckInboxType);
    this.deckInboxType = DECK_INBOX_TYPES.filter(value => value === type ? !shown.includes(value) : shown.includes(value));
    autopilotOverviewManagerMixin.resetDeckInboxSources.call(this);
  },

  setDeckInboxType(value) {
    this.deckInboxType = normalizeDeckInboxTypes(value);
    autopilotOverviewManagerMixin.resetDeckInboxSources.call(this);
  },

  setDeckInboxSearchDraft(value) {
    this.deckInboxSearchDraft = String(value || '');
    if (!this.deckInboxSearchDraft) {
      this.deckInboxSearchQuery = '';
      autopilotOverviewManagerMixin.resetDeckInboxSources.call(this);
    }
  },

  applyDeckInboxSearch() {
    const nextQuery = String(this.deckInboxSearchDraft || '');
    if (normalizeInboxSearchText(nextQuery) !== normalizeInboxSearchText(this.deckInboxSearchQuery)) {
      this.deckInboxSearchQuery = nextQuery;
      autopilotOverviewManagerMixin.resetDeckInboxSources.call(this);
    }
  },

  syncDeckInboxContext(contextKey, scopeId) {
    const nextKey = String(contextKey || '');
    const nextScopeId = String(scopeId || '');
    if (nextKey !== String(this.deckInboxContextKey || '')) {
      this.deckInboxContextKey = nextKey;
      this.deckInboxVisibleCount = DECK_INBOX_PAGE_SIZE;
      this.deckInboxSearchDraft = '';
      this.deckInboxSearchQuery = '';
      autopilotOverviewManagerMixin.resetDeckInboxSources.call(this);
    }
    this.deckInboxScopeId = nextScopeId;
  },

  revealMoreDeckInbox() {
    // One explicit click reveals up to 50 cards. When filters/grouping exhaust
    // the loaded cards, expand each bounded source prefix once, never auto-drain.
    const target = Math.max(DECK_INBOX_PAGE_SIZE,
      this.visibleAutopilotOverviewInbox.length + DECK_INBOX_PAGE_SIZE);
    const sourceHasMore = Object.values(this.inboxActivityPageHasMore || {}).some(Boolean);
    this.deckInboxVisibleCount = sourceHasMore
      ? target : Math.min(target, this.filteredAutopilotOverviewInbox.length);
    if (sourceHasMore && target > this.filteredAutopilotOverviewInbox.length) {
      this.inboxActivityVisibleCount = (this.inboxActivityVisibleCount || 100) + DECK_INBOX_PAGE_SIZE;
      this.startWorkspaceLiveQueries?.();
    }
  },

  scheduleDeckInboxWorkingProjectionRefresh() {
    this.deckInboxWorkingProjectionRevision = Number(this.deckInboxWorkingProjectionRevision || 0) + 1;
    if (this.deckInboxWorkingExpireTimer && typeof window !== 'undefined') {
      window.clearTimeout(this.deckInboxWorkingExpireTimer);
    }
    this.deckInboxWorkingExpireTimer = null;
    if (typeof window === 'undefined') return;
    const now = Date.now();
    const expiresAt = soonestInboxWorkingExpiry(this.agentActivities, now);
    if (!expiresAt) return;
    const delay = Math.min(Math.max(0, expiresAt - now + 50), MAX_TIMEOUT_MS);
    this.deckInboxWorkingExpireTimer = window.setTimeout(() => {
      this.deckInboxWorkingExpireTimer = null;
      this.scheduleDeckInboxWorkingProjectionRefresh();
    }, delay);
  },

  get autopilotOverviewDailyScopeDateKey() {
    return this.dailyScopeSelectedDate || this.getTodayDateKey?.() || new Date().toISOString().slice(0, 10);
  },

  get autopilotOverviewDailyScopeCanGoNext() {
    return true;
  },

  showPreviousDailyScopeNote() {
    this.dailyScopeSelectedDate = shiftDateKey(this.autopilotOverviewDailyScopeDateKey, -1);
    this.dailyScopeDatePickerValue = this.dailyScopeSelectedDate;
    this.dailyScopeDatePickerOpen = false;
  },

  showNextDailyScopeNote() {
    this.dailyScopeSelectedDate = shiftDateKey(this.autopilotOverviewDailyScopeDateKey, 1);
    this.dailyScopeDatePickerValue = this.dailyScopeSelectedDate;
    this.dailyScopeDatePickerOpen = false;
  },

  openDailyScopeDatePicker() {
    this.dailyScopeDatePickerValue = this.autopilotOverviewDailyScopeDateKey;
    this.dailyScopeDatePickerOpen = true;
  },

  closeDailyScopeDatePicker() {
    this.dailyScopeDatePickerOpen = false;
  },

  selectDailyScopeDate(dateKey = '') {
    const nextDate = normalizeString(dateKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return;
    this.dailyScopeSelectedDate = nextDate;
    this.dailyScopeDatePickerValue = nextDate;
    this.dailyScopeDatePickerOpen = false;
  },

  showTodayDailyScopeNote() {
    const today = this.getTodayDateKey?.() || new Date().toISOString().slice(0, 10);
    this.selectDailyScopeDate(today);
  },

  isSummaryPanelCollapsed(panelId = '') {
    const key = normalizeString(panelId);
    return Boolean(key && this.summaryCollapsedPanels?.[key]);
  },

  toggleSummaryPanel(panelId = '') {
    const key = normalizeString(panelId);
    if (!key) return;
    this.summaryCollapsedPanels = {
      ...(this.summaryCollapsedPanels || {}),
      [key]: !this.summaryCollapsedPanels?.[key],
    };
  },

  getSummaryPanelRows(panelId = '') {
    switch (normalizeString(panelId)) {
      case 'chats':
        return this.autopilotOverviewThreads;
      case 'tasks':
        return this.autopilotOverviewTasks;
      case 'docs':
        return this.autopilotOverviewDocuments;
      case 'files':
        return this.autopilotOverviewFiles;
      default:
        return [];
    }
  },

  getSummaryPanelPage(panelId = '') {
    const key = normalizeString(panelId);
    const page = Number(this.summaryPanelPages?.[key] || 0);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
  },

  getSummaryPanelMaxPage(panelId = '') {
    const total = this.getSummaryPanelRows(panelId).length;
    return Math.max(0, Math.ceil(total / OVERVIEW_PANEL_PAGE_SIZE) - 1);
  },

  getSummaryPanelPageRows(panelId = '') {
    const maxPage = this.getSummaryPanelMaxPage(panelId);
    const page = Math.min(this.getSummaryPanelPage(panelId), maxPage);
    const start = page * OVERVIEW_PANEL_PAGE_SIZE;
    return this.getSummaryPanelRows(panelId).slice(start, start + OVERVIEW_PANEL_PAGE_SIZE);
  },

  canShowPreviousSummaryPanelPage(panelId = '') {
    return this.getSummaryPanelPage(panelId) > 0;
  },

  canShowNextSummaryPanelPage(panelId = '') {
    return this.getSummaryPanelPage(panelId) < this.getSummaryPanelMaxPage(panelId);
  },

  showPreviousSummaryPanelPage(panelId = '') {
    const key = normalizeString(panelId);
    if (!key || !this.canShowPreviousSummaryPanelPage(key)) return;
    this.summaryPanelPages = {
      ...(this.summaryPanelPages || {}),
      [key]: this.getSummaryPanelPage(key) - 1,
    };
  },

  showNextSummaryPanelPage(panelId = '') {
    const key = normalizeString(panelId);
    if (!key || !this.canShowNextSummaryPanelPage(key)) return;
    this.summaryPanelPages = {
      ...(this.summaryPanelPages || {}),
      [key]: this.getSummaryPanelPage(key) + 1,
    };
  },

  get pagedAutopilotOverviewThreads() {
    return this.getSummaryPanelPageRows('chats');
  },

  get pagedAutopilotOverviewTasks() {
    return this.getSummaryPanelPageRows('tasks');
  },

  get pagedAutopilotOverviewDocuments() {
    return this.getSummaryPanelPageRows('docs');
  },

  get pagedAutopilotOverviewFiles() {
    return this.getSummaryPanelPageRows('files');
  },

  get autopilotOverviewContext() {
    const selectedScopeId = resolveOverviewScopeId(this);
    const selectedChannelId = resolveOverviewChannelId(this);
    return memoizedProjection(this, 'context', [selectedScopeId, selectedChannelId], () => (
      buildOverviewContext({ selectedScopeId, selectedChannelId })
    ));
  },

  get autopilotOverviewIsScoped() {
    return this.autopilotOverviewContext.mode !== 'all';
  },

  get autopilotOverviewContextLabel() {
    if (!this.autopilotOverviewIsScoped) return 'All workspace activity';
    const context = this.autopilotOverviewContext;
    const scope = context.scopeId ? this.scopesMap?.get?.(context.scopeId) : null;
    const channel = findActiveChannel(this.channels, context.channelId);
    const scopeLabel = scope ? (this.getScopeBreadcrumb?.(scope.record_id) || scope.title || 'Selected scope') : '';
    const channelLabelText = channel ? (this.getChannelLabel ? this.getChannelLabel(channel) : channelLabel(channel)) : '';
    if (scopeLabel && channelLabelText) return `${scopeLabel} / ${channelLabelText}`;
    return channelLabelText || scopeLabel || 'Selected context';
  },

  get autopilotOverviewGreeting() {
    const npub = normalizeString(this.session?.npub || this.signingNpub || this.workspaceOwnerNpub);
    const name = normalizeString(this.getSenderName?.(npub));
    const fallback = npub ? `${npub.slice(0, 10)}...` : 'there';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return `${greeting}, ${name && name !== npub ? name : fallback}`;
  },

  get autopilotOverviewComments() {
    return memoizedProjection(
      this,
      'comments',
      [this.fileComments, this.docComments, this.taskComments],
      () => mergeComments(this.fileComments, this.docComments, this.taskComments),
    );
  },

  get autopilotOverviewThreads() {
    const context = this.autopilotOverviewContext;
    const messages = this.navSection === 'status' ? (this.fileMessages || []) : (this.fileMessages?.length ? this.fileMessages : this.messages);
    const sessionNpub = this.session?.npub || this.signingNpub || '';
    return memoizedProjection(this, 'threads', [
      this.channels, messages, context.scopeId, context.channelId, this.scopesMap,
      this.groups, this.chatProfiles, this.addressBookPeople, this._wsKeyDisplayMap,
      sessionNpub, this._unreadChannels,
      this._unreadThreadItems, this.inboxUnreadThreads, Boolean(this.isTowerPgMode),
    ], () => buildAutopilotOverviewThreads({
      channels: this.channels,
      messages,
      selectedScopeId: context.scopeId,
      selectedChannelId: context.channelId,
      scopesMap: this.scopesMap,
      getChannelLabel: this.getChannelLabel?.bind?.(this),
      getParticipants: this.getChannelParticipants?.bind?.(this),
      getSenderName: this.getSenderName?.bind?.(this),
      sessionNpub,
      unreadChannelMap: this._unreadChannels || {},
      unreadThreadMap: mergeUnreadMaps(this._unreadThreadItems, this.inboxUnreadThreads),
      resourceViewStateMode: Boolean(this.isTowerPgMode),
    }));
  },

  get deckRecentChannels() {
    const contextScopeId = this.autopilotOverviewContext.scopeId || ALL_SCOPE_ID;
    const messages = this.recentChannelMessages ?? (this.navSection === 'status' ? (this.fileMessages || []) : (this.fileMessages?.length ? this.fileMessages : this.messages));
    const sessionNpub = this.session?.npub || this.signingNpub || '';
    return memoizedProjection(this, 'recent-channels', [
      this.channels, messages, contextScopeId, this.scopesMap, this.groups,
      this.chatProfiles, this.addressBookPeople, this._wsKeyDisplayMap,
      sessionNpub, this._unreadChannels, this._unreadThreadItems, this.recentChannelUnreadThreads,
      Boolean(this.isTowerPgMode),
    ], () => buildRecentChannels(buildAutopilotOverviewThreads({
      channels: this.channels,
      messages,
      selectedScopeId: contextScopeId,
      selectedChannelId: ALL_CHANNEL_ID,
      scopesMap: this.scopesMap,
      getChannelLabel: this.getChannelLabel?.bind?.(this),
      getParticipants: this.getChannelParticipants?.bind?.(this),
      getSenderName: this.getSenderName?.bind?.(this),
      sessionNpub,
      unreadChannelMap: this._unreadChannels || {},
      unreadThreadMap: mergeUnreadMaps(this._unreadThreadItems, this.recentChannelUnreadThreads),
      resourceViewStateMode: Boolean(this.isTowerPgMode),
    })));
  },

  get autopilotOverviewFiles() {
    const context = this.autopilotOverviewContext;
    const rows = this.fileBrowserRows;
    return memoizedProjection(this, 'files', [rows, context.scopeId, context.channelId, this.scopesMap], () => (
      buildAutopilotOverviewFiles(rows, {
        selectedScopeId: context.scopeId,
        selectedChannelId: context.channelId,
        scopesMap: this.scopesMap,
      })
    ));
  },

  get autopilotOverviewTasks() {
    const context = this.autopilotOverviewContext;
    const comments = this.autopilotOverviewComments;
    const viewerNpub = this.currentViewerNpub || this.session?.npub || '';
    return memoizedProjection(this, 'tasks', [
      this.tasks, comments, context.scopeId, context.channelId, this.scopesMap,
      this._unreadTaskItems, this.currentPgActorId, viewerNpub, this.pgWorkspaceMembers,
    ], () => buildAutopilotOverviewTasks({
      tasks: this.tasks,
      comments,
      selectedScopeId: context.scopeId,
      selectedChannelId: context.channelId,
      scopesMap: this.scopesMap,
      unreadTaskMap: this._unreadTaskItems || {},
      viewerActorId: this.currentPgActorId,
      viewerNpub,
      workspaceMembers: this.pgWorkspaceMembers,
    }));
  },

  get autopilotOverviewDocuments() {
    const context = this.autopilotOverviewContext;
    const comments = this.autopilotOverviewComments;
    return memoizedProjection(this, 'documents', [
      this.documents, comments, context.scopeId, context.channelId, this.scopesMap,
      this._unreadDocItems,
    ], () => buildAutopilotOverviewDocuments({
      documents: this.documents,
      comments,
      selectedScopeId: context.scopeId,
      selectedChannelId: context.channelId,
      scopesMap: this.scopesMap,
      unreadDocumentMap: this._unreadDocItems || {},
    }));
  },

  get autopilotOverviewInbox() {
    const threads = this.autopilotOverviewThreads;
    const files = this.autopilotOverviewFiles;
    const documents = this.autopilotOverviewDocuments;
    const tasks = this.autopilotOverviewTasks;
    const workingResourceKeys = this.deckInboxWorkingResourceKeys;
    return memoizedProjection(this, 'inbox', [threads, files, documents, tasks, workingResourceKeys], () => (
      buildAutopilotOverviewInbox({ threads, files, documents, tasks, workingResourceKeys })
    ));
  },

  get deckInboxWorkingResourceKeys() {
    return memoizedProjection(this, 'inbox-working-keys', [
      this.agentActivities,
      this.deckInboxWorkingProjectionRevision,
    ], () => buildInboxWorkingResourceKeys(this.agentActivities));
  },

  get deckInboxCurrentContextKey() {
    const context = this.autopilotOverviewContext;
    return `${context.mode}:${context.scopeId}:${context.channelId}`;
  },

  get filteredAutopilotOverviewInbox() {
    const inbox = this.autopilotOverviewInbox;
    return memoizedProjection(this, 'filtered-inbox', [inbox, this.deckInboxSearchQuery, this.deckInboxType], () => (
      filterAutopilotOverviewInbox(inbox, this.deckInboxSearchQuery, this.deckInboxType || 'all')
    ));
  },

  get visibleAutopilotOverviewInbox() {
    const filtered = this.filteredAutopilotOverviewInbox;
    return memoizedProjection(this, 'visible-inbox', [filtered, this.deckInboxVisibleCount], () => (
      sliceAutopilotOverviewInbox(filtered, this.deckInboxVisibleCount)
    ));
  },

  get hasMoreAutopilotOverviewInbox() {
    return this.visibleAutopilotOverviewInbox.length < this.filteredAutopilotOverviewInbox.length
      || Object.values(this.inboxActivityPageHasMore || {}).some(Boolean);
  },

  get autopilotOverviewDailyNote() {
    const selectedDate = this.autopilotOverviewDailyScopeDateKey;
    const notes = (this.dailyNotes || [])
      .filter((note) => note?.record_state !== 'deleted' && String(note.note_date || '') === selectedDate)
      .sort((left, right) => {
        const ts = timestampMs(right.updated_at) - timestampMs(left.updated_at);
        if (ts !== 0) return ts;
        return String(left.record_id || '').localeCompare(String(right.record_id || ''));
      });
    const note = notes[0] || null;
    const items = (Array.isArray(note?.items) ? note.items : [])
      .slice(0, 5)
      .map((item, index) => ({
        id: String(item?.id || `item-${index + 1}`),
        text: String(item?.text || item?.label || '').trim(),
        completed: Boolean(item?.completed),
      }))
      .filter((item) => item.text);
    const done = items.filter((item) => item?.completed === true).length;
    const updatedByNpub = normalizeString(note?.updated_by_actor_npub);
    const updatedBy = updatedByNpub || normalizeString(note?.updated_by_actor_id);
    const narrative = String(note?.body || note?.focus || '').replace(/\s+/g, ' ').trim();
    const source = String(note?.metadata?.source || note?.source || 'manual').trim();
    const titleWithDate = `My Focus ${formatDailyScopeDate(selectedDate)}`.trim();
    const resolvedUpdatedBy = updatedByNpub ? normalizeString(this.getSenderName?.(updatedByNpub)) : '';
    const selfNpubs = [
      this.session?.npub,
      this.signingNpub,
      this.ownerNpub,
      this.currentWorkspaceOwnerNpub,
      note?.owner_actor_npub,
    ].map(normalizeString).filter(Boolean);
    const updatedByLabel = resolvedUpdatedBy && !isKeyLikeDisplay(resolvedUpdatedBy)
      ? resolvedUpdatedBy
      : (updatedByNpub && selfNpubs.includes(updatedByNpub) ? 'you' : '');
    return {
      note,
      duplicateCount: Math.max(0, notes.length - 1),
      dateKey: selectedDate,
      title: titleWithDate,
      progress: items.length > 0 ? `${done}/${items.length} done` : 'No tasks yet',
      items,
      body: narrative || `Create Daily Note for ${formatDailyScopeDate(selectedDate)}.`,
      hasMoreBody: narrative.length > 120,
      source: source.toLowerCase() === 'manual note' ? 'manual' : source,
      updatedBy,
      updatedByLabel,
      updatedAt: note?.updated_at || '',
      metaLabel: note ? `Updated ${updatedByLabel || (source.toLowerCase() === 'manual note' ? 'manual' : source)}${note?.updated_at ? ` ${this.formatRelativeTime?.(note.updated_at) || ''}` : ''}`.trim() : 'Not created yet',
    };
  },

  async openAutopilotOverviewThread(thread = {}, options = {}) {
    const threadId = thread?.rootRecordId || thread?.id;
    if (!thread?.channelId || !threadId) return;
    const requestId = Number(this.autopilotOverviewThreadOpenRequestId || 0) + 1;
    this.autopilotOverviewThreadOpenRequestId = requestId;
    if (this.navSection === 'status') {
      if (options.preserveNavigationRows !== true) {
        if (typeof this.captureDeckThreadNavigationRows === 'function') this.captureDeckThreadNavigationRows(thread);
        else this.deckThreadNavigationRows = [{ ...thread }];
      }
      await this.openDeckThread(thread.channelId, threadId, {
        requestId,
        towerThreadId: thread.id,
        captureReturnContext: options.preserveNavigationRows !== true,
        replaceRoute: options.replaceRoute === true,
      });
      return;
    }
    this.navigateTo('chat', { syncRoute: false, skipChatChannelSelection: true });
    await this.selectChannel(thread.channelId, {
      syncRoute: false,
      backgroundRemoteRefresh: true,
    });
    if (
      this.autopilotOverviewThreadOpenRequestId !== requestId
      || String(this.selectedChannelId || '') !== String(thread.channelId)
    ) return;
    this.focusMessageId = threadId;
    this.openThread(threadId, { syncRoute: false });
    this.syncRoute?.();
  },

  async openDeckRecentChannel(thread = {}) {
    const threadId = normalizeString(thread?.rootRecordId || thread?.id);
    const channelId = normalizeString(thread?.channelId);
    if (!channelId || !threadId) return false;
    const requestId = Number(this.autopilotOverviewThreadOpenRequestId || 0) + 1;
    this.autopilotOverviewThreadOpenRequestId = requestId;
    this.navigateTo('chat', { syncRoute: false, skipChatChannelSelection: true });
    await this.selectChannel(channelId, {
      syncRoute: false,
      backgroundRemoteRefresh: true,
    });
    if (
      Number(this.autopilotOverviewThreadOpenRequestId || 0) !== requestId
      || String(this.selectedChannelId || '') !== channelId
    ) return false;
    this.focusMessageId = threadId;
    this.openThread(threadId, { syncRoute: false });
    this.syncRoute?.();
    return true;
  },

  openAutopilotOverviewTask(row = {}) {
    if (!row?.recordId) return;
    this.navigateTo('tasks', { syncRoute: false });
    this.openTaskDetail(row.recordId);
  },

  openAutopilotOverviewDocument(row = {}) {
    if (!row?.recordId) return;
    const source = (this.documents || []).find((doc) => doc.record_id === row.recordId);
    if (isFileBackedDocument(source || row)) {
      return this.openFilePreview({ ...(source || row), object_id: source?.pg_storage_object_id || row.pg_storage_object_id });
    }
    this.openDoc(row.recordId, {
      commentId: row.hrefTarget?.focusId || null,
      showComments: Boolean(row.count),
    });
  },

  openAutopilotOverviewDailyNote() {
    void this.openDailyNoteEditor?.();
  },
};
