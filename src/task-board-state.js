/**
 * Task board computed state and filtering extracted from app.js.
 *
 * Pure utility functions are exported individually for direct testing.
 * The taskBoardStateMixin object contains methods that use `this` (the Alpine store)
 * and should be spread into the store definition.
 */

import { compareIndexedTasks } from './task-index-keys.js';
import {
  computeParentState,
  stateColor,
  formatStateLabel,
  parseTags as parseTaskTags,
  TASK_BOARD_STATES,
} from './translators/tasks.js';
import {
  resolveScopeChain,
  levelLabel,
  scopeDepth,
} from './translators/scopes.js';
import {
  buildScopeTags,
  normalizeGroupIds,
} from './scope-delivery.js';
import {
  separateScopeShares,
  rebuildAccessForScope,
  mergeShareLists,
} from './scope-move.js';
import {
  getTaskBoardScopeLabel,
  isTaskUnscoped,
  matchesTaskBoardScope,
  sortTaskBoardScopes,
} from './task-board-scopes.js';
import {
  buildTaskCalendar,
} from './task-calendar.js';
import {
  isActiveFlowParentTask,
} from './task-flow-helpers.js';
import { toRaw } from './utils/state-helpers.js';
import { flightDeckTrace } from './logging.js';
import { hasGroupKey } from './crypto/group-keys.js';
import {
  buildRecordLinkPayload,
  buildVisibleRecordLinkSections,
  mergeRecordLinkLists,
  normalizeRecordLinkType,
  recordLinkKey,
} from './record-links.js';
import {
  buildPgChannelTaskBoardId,
  buildPgThreadTaskBoardId,
  getPgChannelScopeId,
  parsePgTaskBoardId,
  resolvePgThreadId,
} from './pg-record-context.js';
import {
  DM_SCOPE_ID,
  createVirtualDmScope,
  findDmScope,
  isDmScope,
} from './dm-scope.js';
import {
  beginNavigationTiming,
  markNavigationTiming,
  publishNavigationTiming,
  recordNavigationPointer,
  waitForNavigationPaint,
} from './navigation-paint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MENTION_NAVIGABLE_RECORD_LINK_TYPES = new Set(['doc', 'task', 'scope', 'channel', 'chat', 'directory', 'report', 'flow', 'opportunity']);
const TASK_FILTER_TAG_LIMIT = 5;
const TASK_CARD_TAG_LIMIT = 3;

export function normalizeTaskAssigneeNpubs(value = null) {
  const raw = Array.isArray(value) ? value
    : value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'assigned_to_npub')
      ? [value.assigned_to_npub] : Array.isArray(value?.assigned_to_npubs) ? value.assigned_to_npubs : typeof value === 'object' ? [] : [value];
  return [...new Set(raw.map(npub => String(npub || '').trim()).filter(Boolean))].slice(0, 1);
}

function parseChatRecordLinkId(id, messages = []) {
  const raw = String(id || '').trim();
  if (!raw) return { channelId: null, threadId: null };
  const hashIndex = raw.indexOf('#');
  if (hashIndex > 0) {
    return {
      channelId: raw.slice(0, hashIndex) || null,
      threadId: raw.slice(hashIndex + 1) || null,
    };
  }
  const message = (messages || []).find((item) => item.record_id === raw);
  return {
    channelId: message?.channel_id || null,
    threadId: raw,
  };
}

/** Shallow-compare two arrays of primitives or share objects (avoids JSON.stringify). */
function sameShallowArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      // For object entries (shares), compare by stringified key fields only
      if (typeof a[i] === 'object' && typeof b[i] === 'object') {
        const ak = a[i], bk = b[i];
        if ((ak?.group_npub ?? null) !== (bk?.group_npub ?? null)
          || (ak?.via_group_npub ?? null) !== (bk?.via_group_npub ?? null)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

function normalizeResolvedGroupRefs(groupRefs = [], resolveGroupId = (value) => String(value || '').trim() || null) {
  const seen = new Set();
  const result = [];
  for (const raw of groupRefs || []) {
    const resolved = resolveGroupId(raw) || String(raw || '').trim() || null;
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function getShareWriteGroupIds(shares = []) {
  return (shares || [])
    .filter((share) => share?.access === 'write')
    .map((share) => share.type === 'person'
      ? (share.via_group_id || share.group_id || share.via_group_npub || share.group_npub)
      : (share.group_id || share.group_npub))
    .filter(Boolean);
}

const REVERSE_SOURCE_COLLECTIONS = Object.freeze([
  { type: 'task', key: 'tasks' },
  { type: 'doc', key: 'documents' },
  { type: 'directory', key: 'directories' },
  { type: 'flow', key: 'flows' },
  { type: 'opportunity', key: 'opportunities' },
  { type: 'report', key: 'reports' },
  { type: 'schedule', key: 'schedules' },
]);

function inferRecordLinkType(record, store) {
  const explicit = String(record?.record_link_type || record?.link_type || record?.type || '').trim().toLowerCase();
  if (explicit === 'document') return 'doc';
  if (explicit) return explicit;
  const recordId = String(record?.record_id || '').trim();
  if (!recordId || !store) return '';
  for (const collection of REVERSE_SOURCE_COLLECTIONS) {
    const rows = Array.isArray(store[collection.key]) ? store[collection.key] : [];
    if (rows.some((row) => row === record || row?.record_id === recordId)) return collection.type;
  }
  return '';
}

function getReverseSourceDeliverables(record, store) {
  const sourceType = inferRecordLinkType(record, store);
  const sourceId = String(record?.record_id || '').trim();
  if (!sourceType || !sourceId || !store) return [];
  const sourceKey = `${sourceType}:${sourceId}`;
  const deliverables = [];

  for (const collection of REVERSE_SOURCE_COLLECTIONS) {
    const rows = Array.isArray(store[collection.key]) ? store[collection.key] : [];
    for (const row of rows) {
      const rowId = String(row?.record_id || '').trim();
      if (!rowId || rowId === sourceId || row?.record_state === 'deleted') continue;
      const links = buildRecordLinkPayload(row);
      if (!links.source_links.some((link) => recordLinkKey(link) === sourceKey)) continue;
      deliverables.push({ type: collection.type, id: rowId });
    }
  }

  return deliverables;
}

export function selectPreferredWritableGroupRef(input = {}) {
  const resolveGroupId = typeof input.resolveGroupId === 'function'
    ? input.resolveGroupId
    : (value) => String(value || '').trim() || null;
  const hasKey = typeof input.hasKey === 'function' ? input.hasKey : hasGroupKey;
  const allowedGroupIds = normalizeResolvedGroupRefs(input.allowedGroupIds || [], resolveGroupId);
  const hasAllowedFilter = allowedGroupIds.length > 0;
  const allowedSet = new Set(allowedGroupIds);
  const isAllowed = (groupId) => !hasAllowedFilter || allowedSet.has(groupId);
  const deliveryGroupIds = normalizeResolvedGroupRefs(input.groupIds || [], resolveGroupId);
  const scopePolicyGroupIds = normalizeResolvedGroupRefs(input.scopePolicyGroupIds || [], resolveGroupId);
  const writeShareGroupIds = normalizeResolvedGroupRefs(getShareWriteGroupIds(input.shares || []), resolveGroupId);
  const candidateDeliveryGroupIds = deliveryGroupIds.filter(isAllowed);
  const candidateScopePolicyGroupIds = scopePolicyGroupIds.filter(isAllowed);
  const candidateWriteShareGroupIds = writeShareGroupIds.filter(isAllowed);
  const writableCandidateSet = new Set(candidateWriteShareGroupIds);
  const hasWritableCandidates = writableCandidateSet.size > 0;
  const explicitWriteGroupId = normalizeResolvedGroupRefs([input.writeGroupId], resolveGroupId)
    .find((groupId) => isAllowed(groupId)) || null;
  const boardGroupId = normalizeResolvedGroupRefs([input.boardGroupId], resolveGroupId)
    .find((groupId) => isAllowed(groupId)) || null;
  const deliverySet = new Set(candidateDeliveryGroupIds);
  const prioritizedDeliveryGroupIds = hasAllowedFilter
    ? allowedGroupIds.filter((groupId) => candidateDeliveryGroupIds.includes(groupId))
    : candidateDeliveryGroupIds;
  const prioritizedScopePolicyGroupIds = hasAllowedFilter
    ? allowedGroupIds.filter((groupId) => candidateScopePolicyGroupIds.includes(groupId))
    : candidateScopePolicyGroupIds;
  const prioritizedWriteShareGroupIds = hasAllowedFilter
    ? allowedGroupIds.filter((groupId) => candidateWriteShareGroupIds.includes(groupId))
    : candidateWriteShareGroupIds;
  const preferActorAllowedOrder = hasAllowedFilter && prioritizedDeliveryGroupIds.length > 1;

  const candidates = [
    preferActorAllowedOrder ? null : explicitWriteGroupId,
    preferActorAllowedOrder ? null : boardGroupId,
    ...prioritizedScopePolicyGroupIds.filter((groupId) => deliverySet.has(groupId)),
    ...prioritizedWriteShareGroupIds.filter((groupId) => deliverySet.has(groupId)),
    ...prioritizedDeliveryGroupIds,
  ].filter(Boolean);

  for (const groupId of normalizeResolvedGroupRefs(candidates, resolveGroupId)) {
    if (hasWritableCandidates && !writableCandidateSet.has(groupId)) continue;
    if (hasKey(groupId)) return groupId;
  }

  const fallback = normalizeResolvedGroupRefs([
    ...(hasWritableCandidates
      ? [
          ...candidateWriteShareGroupIds.filter((groupId) => deliverySet.has(groupId)),
          ...candidateWriteShareGroupIds,
        ]
      : [
          ...(preferActorAllowedOrder ? [] : [explicitWriteGroupId, boardGroupId]),
          ...prioritizedWriteShareGroupIds.filter((groupId) => deliverySet.has(groupId)),
          ...prioritizedScopePolicyGroupIds.filter((groupId) => deliverySet.has(groupId)),
          ...prioritizedDeliveryGroupIds,
          ...prioritizedScopePolicyGroupIds,
          ...prioritizedWriteShareGroupIds,
        ]),
  ], resolveGroupId)[0] || null;

  if (fallback) return fallback;
  if (hasAllowedFilter) return null;

  return normalizeResolvedGroupRefs([
    normalizeResolvedGroupRefs([input.writeGroupId], resolveGroupId)[0] || null,
    normalizeResolvedGroupRefs([input.boardGroupId], resolveGroupId)[0] || null,
    ...writeShareGroupIds.filter((groupId) => deliveryGroupIds.includes(groupId)),
    ...scopePolicyGroupIds.filter((groupId) => deliveryGroupIds.includes(groupId)),
    ...deliveryGroupIds,
    ...scopePolicyGroupIds,
    ...writeShareGroupIds,
  ], resolveGroupId)[0] || null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TASK_BOARD_STORAGE_KEY_SUFFIX = 'last-task-board-id';
/** @deprecated Use namespacedBoardKey() instead */
export const TASK_BOARD_STORAGE_KEY = 'coworker:last-task-board-id';

function namespacedBoardKey(slug) {
  return slug
    ? `coworker:${slug}:${TASK_BOARD_STORAGE_KEY_SUFFIX}`
    : TASK_BOARD_STORAGE_KEY;
}

export const UNSCOPED_TASK_BOARD_ID = '__unscoped__';
export const RECENT_TASK_BOARD_ID = '__recent__';
export const ALL_TASK_BOARD_ID = '__all__';
export const WEEKDAY_OPTIONS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const TASK_BOARD_SORT_MODES = Object.freeze([
  'manual',
  'created_asc',
  'created_desc',
  'modified_desc',
  'modified_asc',
  'alpha_asc',
  'alpha_desc',
]);

const EMPTY_ARRAY = Object.freeze([]);
const scopesMapCache = new WeakMap();
const taskGraphCache = new WeakMap();
const taskBoardDerivedCache = new WeakMap();

function chooseTaskRecord(current, candidate) {
  const currentVersion = Number(current?.version ?? 0);
  const candidateVersion = Number(candidate?.version ?? 0);
  if (candidateVersion !== currentVersion) {
    return candidateVersion > currentVersion ? candidate : current;
  }
  const currentUpdatedAt = String(current?.updated_at || '');
  const candidateUpdatedAt = String(candidate?.updated_at || '');
  if (candidateUpdatedAt !== currentUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
  }
  return current;
}

export function dedupeTasksByRecordId(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length <= 1) return Array.isArray(tasks) ? tasks : [];
  const deduped = [];
  const indexByRecordId = new Map();
  for (const task of tasks) {
    const recordId = String(task?.record_id || '').trim();
    if (!recordId) {
      deduped.push(task);
      continue;
    }
    const existingIndex = indexByRecordId.get(recordId);
    if (existingIndex === undefined) {
      indexByRecordId.set(recordId, deduped.length);
      deduped.push(task);
      continue;
    }
    deduped[existingIndex] = chooseTaskRecord(deduped[existingIndex], task);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Pure utility functions (no `this` dependency)
// ---------------------------------------------------------------------------

function getCachedScopesMap(store) {
  const scopes = Array.isArray(store?.scopes) ? store.scopes : EMPTY_ARRAY;
  let cached = scopesMapCache.get(scopes);
  if (cached) return cached;
  cached = new Map();
  for (const scope of scopes) cached.set(scope.record_id, scope);
  if (!findDmScope(scopes)) {
    const dmScope = createVirtualDmScope(store?.workspaceOwnerNpub || store?.ownerNpub || '');
    cached.set(dmScope.record_id, dmScope);
  }
  scopesMapCache.set(scopes, cached);
  return cached;
}

function getTaskGraph(store) {
  const tasks = Array.isArray(store?.tasks) ? store.tasks : EMPTY_ARRAY;
  let cached = taskGraphCache.get(tasks);
  if (cached) return cached;

  const taskById = new Map();
  const parentIds = new Set();
  const subtasksByParent = new Map();
  for (const task of tasks) {
    if (task?.record_state !== 'deleted' && task?.record_id) {
      taskById.set(task.record_id, task);
    }
    if (task?.record_state === 'deleted' || !task?.parent_task_id) continue;
    parentIds.add(task.parent_task_id);
    const subtasks = subtasksByParent.get(task.parent_task_id);
    if (subtasks) subtasks.push(task);
    else subtasksByParent.set(task.parent_task_id, [task]);
  }

  const parentStateByParent = new Map();
  for (const [parentId, subtasks] of subtasksByParent.entries()) {
    parentStateByParent.set(parentId, computeParentDisplayState(taskById.get(parentId) || null, subtasks));
  }

  cached = {
    parentIds,
    subtasksByParent,
    parentStateByParent,
  };
  taskGraphCache.set(tasks, cached);
  return cached;
}

function isPgWorkspaceStore(store) {
  return Boolean(store?.currentWorkspace?.pgBackendMode || store?.pgBackendMode);
}

function getTaskPgChannelId(task = {}) {
  return String(task?.pg_channel_id || task?.channel_id || '').trim() || null;
}

function getTaskPgThreadId(task = {}) {
  return String(task?.pg_thread_id || task?.thread_id || '').trim() || null;
}

function getMessagePgThreadId(message = {}) {
  return String(message?.pg_thread_id || message?.thread_id || '').trim() || null;
}

function getBoardChannel(store, boardContext) {
  const channelId = boardContext?.channelId || store?.selectedChannelId || null;
  return (store?.channels || []).find((channel) => channel?.record_id === channelId && channel.record_state !== 'deleted') || null;
}

const SORT_NUMBER_KEYS = Object.freeze([
  'sort_order',
  'display_order',
  'order',
  'position',
  'rank',
  'board_order',
]);

function getSortNumber(record = {}, fallbackLabel = '') {
  const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  for (const source of [record, metadata]) {
    for (const key of SORT_NUMBER_KEYS) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  const leadingNumber = String(fallbackLabel || record?.title || record?.name || '').trim().match(/^(\d+(?:\.\d+)?)/);
  if (leadingNumber) {
    const value = Number(leadingNumber[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function compareNumberThenLabel(left = {}, right = {}, leftLabel = '', rightLabel = '') {
  const leftNumber = getSortNumber(left, leftLabel);
  const rightNumber = getSortNumber(right, rightLabel);
  if (leftNumber !== null || rightNumber !== null) {
    if (leftNumber === null) return 1;
    if (rightNumber === null) return -1;
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  }
  return String(leftLabel || left?.title || left?.name || '').localeCompare(
    String(rightLabel || right?.title || right?.name || ''),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
}

function comparePgContextChannels(store, left = {}, right = {}) {
  const leftScopeId = getPgChannelScopeId(left) || '';
  const rightScopeId = getPgChannelScopeId(right) || '';
  if (leftScopeId !== rightScopeId) {
    const leftScope = leftScopeId ? store?.scopesMap?.get(leftScopeId) || {} : {};
    const rightScope = rightScopeId ? store?.scopesMap?.get(rightScopeId) || {} : {};
    const scopeOrder = compareNumberThenLabel(
      leftScope,
      rightScope,
      leftScope?.title || leftScopeId || 'Unscoped',
      rightScope?.title || rightScopeId || 'Unscoped',
    );
    if (scopeOrder !== 0) return scopeOrder;
    return leftScopeId.localeCompare(rightScopeId, undefined, { numeric: true, sensitivity: 'base' });
  }
  const leftLabel = String(store?.getChannelLabel?.(left) || left?.title || left?.name || '').trim();
  const rightLabel = String(store?.getChannelLabel?.(right) || right?.title || right?.name || '').trim();
  const channelOrder = compareNumberThenLabel(left, right, leftLabel, rightLabel);
  if (channelOrder !== 0) return channelOrder;
  return String(left?.record_id || '').localeCompare(String(right?.record_id || ''));
}

export function prioritizeUnreadChannels(channels = [], isUnread = () => false, enabled = false) {
  if (!enabled) return channels;
  const unread = [];
  const read = [];
  for (const channel of channels) {
    (isUnread(channel?.record_id) ? unread : read).push(channel);
  }
  return [...unread, ...read];
}

function getDerivedSelectedBoardScope(store, scopesMap) {
  const selectedBoardId = store?.selectedBoardId;
  const boardContext = parsePgTaskBoardId(selectedBoardId);
  if (boardContext.type !== 'scope') return null;
  if (!selectedBoardId
    || selectedBoardId === ALL_TASK_BOARD_ID
    || selectedBoardId === RECENT_TASK_BOARD_ID
    || selectedBoardId === UNSCOPED_TASK_BOARD_ID) {
    return null;
  }
  return scopesMap.get(selectedBoardId) || null;
}

function isSystemScopeBoard(board = {}) {
  return board.type === 'scope'
    && (board.scopeId === ALL_TASK_BOARD_ID
      || board.scopeId === RECENT_TASK_BOARD_ID
      || board.scopeId === UNSCOPED_TASK_BOARD_ID);
}

function getTaskBoardDerived(store) {
  const tasks = Array.isArray(store?.tasks) ? store.tasks : EMPTY_ARRAY;
  const scopes = Array.isArray(store?.scopes) ? store.scopes : EMPTY_ARRAY;
  const taskFilterTags = Array.isArray(store?.taskFilterTags) ? store.taskFilterTags : EMPTY_ARRAY;
  const scopesMap = getCachedScopesMap(store);
  const selectedBoardId = store?.selectedBoardId ?? null;
  const selectedBoardScope = getDerivedSelectedBoardScope(store, scopesMap);

  const previous = taskBoardDerivedCache.get(store);
  if (previous
    && previous.tasks === tasks
    && previous.scopes === scopes
    && previous.selectedBoardId === selectedBoardId
    && previous.showBoardDescendantTasks === store?.showBoardDescendantTasks
    && previous.taskFilter === store?.taskFilter
    && previous.taskFilterTags === taskFilterTags
    && previous.taskFilterState === store?.taskFilterState
    && previous.taskFilterAssignee === store?.taskFilterAssignee
    && previous.taskSortMode === normalizeTaskSortMode(store?.taskSortMode)) {
    return previous.value;
  }

  const graph = getTaskGraph(store);
  const normalizedSelectedBoardId = selectedBoardId === UNSCOPED_TASK_BOARD_ID
    ? UNSCOPED_TASK_BOARD_ID
    : selectedBoardId;
  const boardScopedTasks = computeBoardScopedTasks(
    tasks,
    normalizedSelectedBoardId,
    selectedBoardScope,
    scopesMap,
    Boolean(store?.showBoardDescendantTasks),
  );
  const filteredTasks = computeFilteredTasks(
    boardScopedTasks,
    store?.taskFilter,
    taskFilterTags,
    store?.taskFilterAssignee,
    store?.taskFilterState,
  );
  const activeTasks = filteredTasks.filter((task) =>
    task.state !== 'done' && task.state !== 'archive' && !graph.parentIds.has(task.record_id)
  );
  const doneTasks = filteredTasks.filter((task) =>
    task.state === 'done' && !graph.parentIds.has(task.record_id)
  );
  const summaryTasks = filteredTasks.filter((task) =>
    task.state !== 'archive' && graph.parentIds.has(task.record_id)
  );
  const boardColumns = computeBoardColumns(activeTasks, doneTasks, summaryTasks, {
    sortMode: store?.taskSortMode,
  });
  const listGroupedTasks = boardColumns.filter((column) => column.tasks.length > 0);

  let visibleBoardTasks = boardScopedTasks.filter((task) => task.state !== 'archive');
  const query = String(store?.taskFilter || '').trim().toLowerCase();
  if (query) {
    visibleBoardTasks = visibleBoardTasks.filter((task) =>
      String(task.title || '').toLowerCase().includes(query)
      || String(task.description || '').toLowerCase().includes(query)
      || String(task.tags || '').toLowerCase().includes(query)
    );
  }

  const allTaskTagStats = computeTaskTagStats(visibleBoardTasks);
  const allTaskTagCounts = Object.fromEntries(allTaskTagStats.map(({ tag, count }) => [tag, count]));

  const calendarScheduledTasks = filteredTasks.filter((task) =>
    task.record_state !== 'deleted'
    && task.state !== 'archive'
    && !graph.parentIds.has(task.record_id)
    && Boolean(task.scheduled_for)
  );

  const value = {
    boardScopedTasks,
    filteredTasks,
    activeTasks,
    doneTasks,
    summaryTasks,
    boardColumns,
    listGroupedTasks,
    visibleBoardTasks,
    allTaskTags: allTaskTagStats.map(({ tag }) => tag),
    allTaskTagCounts,
    calendarScheduledTasks,
  };

  taskBoardDerivedCache.set(store, {
    tasks,
    scopes,
    selectedBoardId,
    showBoardDescendantTasks: store?.showBoardDescendantTasks,
    taskFilter: store?.taskFilter,
    taskFilterTags,
    taskFilterState: store?.taskFilterState,
    taskFilterAssignee: store?.taskFilterAssignee,
    taskSortMode: normalizeTaskSortMode(store?.taskSortMode),
    value,
  });

  return value;
}

export function computeParentDisplayState(parentTask, subtasks) {
  if (isActiveFlowParentTask(parentTask, subtasks)) {
    return parentTask?.state || 'new';
  }
  return computeParentState(subtasks);
}

export function resolveGroupId(groupRef, groups) {
  const value = String(groupRef || '').trim();
  if (!value) return null;
  const group = groups.find((item) => item.group_id === value || item.group_npub === value);
  return group?.group_id || group?.group_npub || value;
}

export function getScopeAncestorPath(scopeId, scopesMap) {
  const parts = [];
  let current = scopeId ? scopesMap.get(scopeId) || null : null;
  current = current?.parent_id ? scopesMap.get(current.parent_id) || null : null;
  while (current) {
    parts.unshift(current.title);
    current = current.parent_id ? scopesMap.get(current.parent_id) || null : null;
  }
  return parts.length > 0 ? `${parts.join(' > ')} >` : '';
}

export function formatTaskBoardScopeDisplay(scope, scopesMap) {
  if (!scope?.record_id) return '';
  const title = String(scope.title || '').trim() || 'Untitled scope';
  if (scopeDepth(scope.level) === 1) return title;
  const level = levelLabel(scope.level) || 'Scope';
  const ancestorPath = getScopeAncestorPath(scope.record_id, scopesMap);
  return ancestorPath ? `${title} (${level}): ${ancestorPath}` : `${title} (${level})`;
}

export function formatFocusedScopeMeta(scope, scopesMap) {
  if (!scope?.record_id) return '';
  const level = levelLabel(scope.level) || 'Scope';
  const ancestorPath = getScopeAncestorPath(scope.record_id, scopesMap).replace(/\s*>\s*$/, '');
  return ancestorPath ? `${level} · ${ancestorPath}` : level;
}

export function getTaskBoardOptionLabel(scopeId, scopesMap) {
  if (scopeId === ALL_TASK_BOARD_ID) return 'All';
  if (scopeId === RECENT_TASK_BOARD_ID) return 'Recent';
  if (scopeId === UNSCOPED_TASK_BOARD_ID) return 'Unscoped';
  const scope = scopesMap.get(scopeId);
  if (!scope) return 'Scope board';
  return formatTaskBoardScopeDisplay(scope, scopesMap);
}

export function getTaskBoardSearchText(scopeId, scopesMap) {
  if (scopeId === ALL_TASK_BOARD_ID) return 'all tasks everything';
  if (scopeId === RECENT_TASK_BOARD_ID) return 'recent updated today';
  if (scopeId === UNSCOPED_TASK_BOARD_ID) return 'unscoped no scope unsorted';
  const scope = scopesMap.get(scopeId);
  if (!scope) return '';
  return [
    scope.title,
    scope.description,
    scope.level,
    getTaskBoardScopeLabel(scope, scopesMap),
    getScopeAncestorPath(scope.record_id, scopesMap),
  ].filter(Boolean).join(' ').toLowerCase();
}

function getRecordScopeId(record) {
  return record?.boardScopeId
    ?? record?.scope_id
    ?? record?.scope_l5_id
    ?? record?.scope_l4_id
    ?? record?.scope_l3_id
    ?? record?.scope_l2_id
    ?? record?.scope_l1_id
    ?? null;
}

export function buildRecentFocusAreas(tasks = [], scopes = [], scopesMap = new Map(), { limit = 5, recentChanges = [] } = {}) {
  const maxItems = Math.max(0, Number(limit) || 0);
  if (maxItems === 0 || !scopesMap?.size) return [];

  const entries = new Map();
  const upsert = (scope, sourceTs = 0, taskCountDelta = 0) => {
    if (!scope?.record_id || scope.record_state === 'deleted') return;
    const existing = entries.get(scope.record_id) || {
      scope,
      updatedTs: 0,
      taskCount: 0,
    };
    existing.updatedTs = Math.max(existing.updatedTs, sourceTs || 0);
    existing.taskCount += taskCountDelta;
    entries.set(scope.record_id, existing);
  };

  for (const item of recentChanges || []) {
    const scopeId = String(getRecordScopeId(item) || '').trim();
    if (!scopeId) continue;
    const scope = scopesMap.get(scopeId);
    if (!scope || scope.record_state === 'deleted') continue;
    upsert(scope, Date.parse(item.updatedAt || item.updated_at || '') || 0, item.recordTypeKey === 'task' ? 1 : 0);
  }

  for (const task of tasks || []) {
    if (!task || task.record_state === 'deleted') continue;
    const scopeId = String(getRecordScopeId(task) || '').trim();
    if (!scopeId) continue;
    const scope = scopesMap.get(scopeId);
    if (!scope || scope.record_state === 'deleted') continue;
    upsert(scope, Date.parse(task.updated_at || '') || 0, 1);
  }

  for (const scope of scopes || []) {
    if (!scope || scope.record_state === 'deleted') continue;
    upsert(scope, Date.parse(scope.updated_at || '') || 0, 0);
  }

  return [...entries.values()]
    .sort((left, right) => {
      if (right.updatedTs !== left.updatedTs) return right.updatedTs - left.updatedTs;
      const leftLabel = getTaskBoardScopeLabel(left.scope, scopesMap) || left.scope.title || '';
      const rightLabel = getTaskBoardScopeLabel(right.scope, scopesMap) || right.scope.title || '';
      return leftLabel.localeCompare(rightLabel);
    })
    .slice(0, maxItems)
    .map(({ scope, updatedTs, taskCount }) => {
      const label = String(scope.title || '').trim() || 'Untitled scope';
      const breadcrumb = getTaskBoardScopeLabel(scope, scopesMap) || label;
      const level = levelLabel(scope.level) || 'Scope';
      return {
        id: scope.record_id,
        label,
        breadcrumb,
        meta: taskCount > 0 ? `${level} - ${taskCount}` : level,
        updatedTs,
        taskCount,
      };
    });
}

export function normalizeTaskRowGroupRefs(task, resolverFn) {
  if (!task || typeof task !== 'object') return task;

  const nextBoardId = resolverFn(task.board_group_id);
  const nextGroupIds = [...new Set((task.group_ids || [])
    .map((value) => resolverFn(value))
    .filter(Boolean))];
  const nextShares = Array.isArray(task.shares)
    ? task.shares.map((share) => ({
        ...share,
        group_npub: resolverFn(share?.group_npub),
        via_group_npub: resolverFn(share?.via_group_npub),
      }))
    : task.shares;

  const changed = nextBoardId !== (task.board_group_id ?? null)
    || !sameShallowArray(nextGroupIds, task.group_ids || [])
    || !sameShallowArray(nextShares, task.shares || []);

  if (!changed) return task;

  return {
    ...task,
    board_group_id: nextBoardId,
    group_ids: nextGroupIds,
    shares: nextShares,
  };
}

export function normalizeTaskRowScopeRefs(task, scopesMap) {
  if (!task || typeof task !== 'object') return task;
  if (!task.scope_id || !scopesMap.has(task.scope_id)) return task;

  const chain = resolveScopeChain(task.scope_id, scopesMap);
  const changed = (task.scope_l1_id ?? null) !== (chain.scope_l1_id ?? null)
    || (task.scope_l2_id ?? null) !== (chain.scope_l2_id ?? null)
    || (task.scope_l3_id ?? null) !== (chain.scope_l3_id ?? null)
    || (task.scope_l4_id ?? null) !== (chain.scope_l4_id ?? null)
    || (task.scope_l5_id ?? null) !== (chain.scope_l5_id ?? null);

  if (!changed) return task;

  return {
    ...task,
    scope_l1_id: chain.scope_l1_id,
    scope_l2_id: chain.scope_l2_id,
    scope_l3_id: chain.scope_l3_id,
    scope_l4_id: chain.scope_l4_id,
    scope_l5_id: chain.scope_l5_id,
  };
}

export function normalizeScheduleRowGroupRefs(schedule, resolverFn) {
  if (!schedule || typeof schedule !== 'object') return schedule;

  const nextAssignedGroupId = resolverFn(schedule.assigned_group_id);
  const nextGroupIds = [...new Set((schedule.group_ids || [])
    .map((value) => resolverFn(value))
    .filter(Boolean))];
  const nextShares = Array.isArray(schedule.shares)
    ? schedule.shares.map((share) => {
        if (typeof share === 'string') return resolverFn(share);
        return {
          ...share,
          group_npub: resolverFn(share?.group_npub),
          via_group_npub: resolverFn(share?.via_group_npub),
        };
      })
    : schedule.shares;

  const changed = nextAssignedGroupId !== (schedule.assigned_group_id ?? null)
    || !sameShallowArray(nextGroupIds, schedule.group_ids || [])
    || !sameShallowArray(nextShares, schedule.shares || []);

  if (!changed) return schedule;

  return {
    ...schedule,
    assigned_group_id: nextAssignedGroupId,
    group_ids: nextGroupIds,
    shares: nextShares,
  };
}

export function normalizeScopeRowGroupRefs(scope, resolverFn) {
  if (!scope || typeof scope !== 'object') return scope;

  const nextGroupIds = normalizeGroupIds((scope.group_ids || [])
    .map((value) => resolverFn(value))
    .filter(Boolean));

  const changed = JSON.stringify(nextGroupIds) !== JSON.stringify(scope.group_ids || []);
  if (!changed) return scope;

  return {
    ...scope,
    group_ids: nextGroupIds,
  };
}

export function computeBoardScopedTasks(tasks, selectedBoardId, selectedBoardScope, scopesMap, showBoardDescendantTasks) {
  const live = tasks.filter((task) => task.record_state !== 'deleted');
  const boardContext = parsePgTaskBoardId(selectedBoardId);
  if (boardContext.type === 'thread') {
    return live.filter((task) =>
      getTaskPgChannelId(task) === boardContext.channelId
      && getTaskPgThreadId(task) === boardContext.threadId
    );
  }
  if (boardContext.type === 'channel') {
    return live.filter((task) => getTaskPgChannelId(task) === boardContext.channelId);
  }
  if (selectedBoardId === ALL_TASK_BOARD_ID) {
    return live;
  }
  if (selectedBoardId === RECENT_TASK_BOARD_ID) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return live.filter(task => task.updated_at >= cutoff);
  }
  if (selectedBoardId === UNSCOPED_TASK_BOARD_ID) {
    return live.filter((task) => isTaskUnscoped(task, scopesMap));
  }
  if (!selectedBoardScope) return live;
  return live.filter((task) => matchesTaskBoardScope(task, selectedBoardScope, scopesMap, {
    includeDescendants: showBoardDescendantTasks,
  }));
}

export function computeFilteredTasks(boardScopedTasks, query, filterTags, assigneeNpub, stateFilter = '') {
  let tasks = boardScopedTasks;

  const q = String(query || '').trim().toLowerCase();
  if (q) {
    tasks = tasks.filter(t =>
      String(t.title || '').toLowerCase().includes(q)
      || String(t.description || '').toLowerCase().includes(q)
      || String(t.tags || '').toLowerCase().includes(q)
    );
  }
  if (filterTags.length > 0) {
    tasks = tasks.filter(t => {
      const tags = parseTaskTags(t.tags);
      return filterTags.some(ft => tags.includes(ft.toLowerCase()));
    });
  }
  if (assigneeNpub) {
    tasks = tasks.filter(t => normalizeTaskAssigneeNpubs(t).includes(assigneeNpub));
  }
  const normalizedStateFilter = String(stateFilter || '').trim();
  if (normalizedStateFilter) {
    tasks = tasks.filter((task) => String(task?.state || 'new').trim() === normalizedStateFilter);
  }
  return tasks;
}

export function computeTaskTagStats(tasks = []) {
  const counts = new Map();
  for (const task of tasks || []) {
    for (const tag of parseTaskTags(task?.tags)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
}

export function sortTagsByPopularity(tags = [], tagCounts = {}) {
  const counts = tagCounts instanceof Map
    ? tagCounts
    : new Map(Object.entries(tagCounts || {}));
  return [...new Set(tags || [])].sort((left, right) => {
    const leftCount = Number(counts.get(left) ?? 0) || 0;
    const rightCount = Number(counts.get(right) ?? 0) || 0;
    return rightCount - leftCount || String(left).localeCompare(String(right));
  });
}

export function getTaskBoardOrder(task) {
  const order = Number(task?.board_order);
  return Number.isFinite(order) ? order : null;
}

export function normalizeTaskSortMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'created') return 'created_asc';
  if (normalized === 'modified') return 'modified_desc';
  if (normalized === 'alpha') return 'alpha_asc';
  return TASK_BOARD_SORT_MODES.includes(normalized) ? normalized : 'manual';
}

function parseTaskTime(task, key) {
  const ts = Date.parse(task?.[key] || '');
  return Number.isFinite(ts) ? ts : 0;
}

function compareTaskTitleNatural(left = {}, right = {}) {
  const labelDelta = String(left?.title || '').localeCompare(
    String(right?.title || ''),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );
  if (labelDelta !== 0) return labelDelta;
  return String(left?.record_id || '').localeCompare(String(right?.record_id || ''));
}

export function sortTasksByBoardOrder(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length <= 1) return Array.isArray(tasks) ? tasks : [];
  return (tasks || [])
    .map((task, index) => ({ task, index, order: getTaskBoardOrder(task) }))
    .sort((left, right) => {
      const leftHasOrder = left.order !== null;
      const rightHasOrder = right.order !== null;
      if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1;
      if (leftHasOrder && left.order !== right.order) return left.order - right.order;
      return left.index - right.index;
    })
    .map((entry) => entry.task);
}

export function sortTasksForBoard(tasks = [], sortMode = 'manual') {
  const normalizedMode = normalizeTaskSortMode(sortMode);
  if (normalizedMode === 'manual') return sortTasksByBoardOrder(tasks);
  if (!Array.isArray(tasks) || tasks.length <= 1) return Array.isArray(tasks) ? tasks : [];

  return [...tasks].sort((left, right) => compareIndexedTasks(left, right, normalizedMode));
}

export function getTaskVirtualBoardOrder(task, index) {
  const order = getTaskBoardOrder(task);
  return order !== null ? order : (index + 1) * 1000;
}

export function calculateTaskBoardOrderForInsertion(tasks = [], options = {}) {
  const taskId = String(options.taskId || '').trim();
  const targetTaskId = String(options.targetTaskId || '').trim();
  const position = options.position === 'after' ? 'after' : options.position === 'before' ? 'before' : 'end';
  const siblings = (tasks || []).filter((task) => !taskId || task?.record_id !== taskId);
  let insertIndex = siblings.length;
  if (targetTaskId) {
    const targetIndex = siblings.findIndex((task) => task.record_id === targetTaskId);
    if (targetIndex >= 0) insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
  }

  const previousTask = insertIndex > 0 ? siblings[insertIndex - 1] : null;
  const nextTask = insertIndex < siblings.length ? siblings[insertIndex] : null;
  const previousOrder = previousTask ? getTaskVirtualBoardOrder(previousTask, insertIndex - 1) : null;
  const nextOrder = nextTask ? getTaskVirtualBoardOrder(nextTask, insertIndex) : null;

  if (previousOrder === null && nextOrder === null) return 1000;
  if (previousOrder === null) return nextOrder > 1 ? nextOrder / 2 : nextOrder - 1000;
  if (nextOrder === null) return previousOrder + 1000;
  if (nextOrder > previousOrder) return previousOrder + ((nextOrder - previousOrder) / 2);
  return previousOrder + 0.001;
}

export function getTaskDropRecordId(event, fallbackTaskId = '') {
  return String(event?.dataTransfer?.getData?.('text/plain') || fallbackTaskId || '').trim();
}

export function buildTaskBoardReorderPatches(tasks = [], options = {}) {
  const taskId = String(options.taskId || '').trim();
  if (!taskId) return [];

  const targetTaskId = String(options.targetTaskId || '').trim();
  const position = options.position === 'after' ? 'after' : options.position === 'before' ? 'before' : 'end';
  const targetState = String(options.targetState || '').trim();
  const draggedTask = options.draggedTask || (tasks || []).find((task) => task?.record_id === taskId) || null;
  if (!draggedTask) return [];

  const siblings = (tasks || []).filter((task) => task?.record_id !== taskId);
  let insertIndex = siblings.length;
  if (targetTaskId) {
    const targetIndex = siblings.findIndex((task) => task?.record_id === targetTaskId);
    if (targetIndex >= 0) insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
  }

  const ordered = [...siblings];
  ordered.splice(insertIndex, 0, draggedTask);
  const hasUnrankedTasks = ordered.some((task) => getTaskBoardOrder(task) === null);

  if (!hasUnrankedTasks) {
    const nextBoardOrder = calculateTaskBoardOrderForInsertion(tasks, {
      taskId,
      targetTaskId,
      position,
    });
    const patch = {};
    if (targetState && draggedTask.state !== targetState) patch.state = targetState;
    if (Number.isFinite(nextBoardOrder)
      && Math.abs(Number(draggedTask.board_order ?? NaN) - nextBoardOrder) > 0.000001) {
      patch.board_order = nextBoardOrder;
    }
    return Object.keys(patch).length > 0 ? [{ record_id: taskId, patch }] : [];
  }

  return ordered
    .map((task, index) => {
      const patch = {};
      const nextBoardOrder = (index + 1) * 1000;
      const currentBoardOrder = getTaskBoardOrder(task);
      if (currentBoardOrder === null || Math.abs(currentBoardOrder - nextBoardOrder) > 0.000001) {
        patch.board_order = nextBoardOrder;
      }
      if (task?.record_id === taskId && targetState && task.state !== targetState) {
        patch.state = targetState;
      }
      return Object.keys(patch).length > 0 ? { record_id: task.record_id, patch } : null;
    })
    .filter(Boolean);
}

export function computeBoardColumns(activeTasks, doneTasks, summaryTasks, options = {}) {
  const sortMode = normalizeTaskSortMode(options.sortMode);
  const normalizedSummaryTasks = sortTasksForBoard(dedupeTasksByRecordId(summaryTasks), sortMode);
  const normalizedActiveTasks = sortTasksForBoard(dedupeTasksByRecordId(activeTasks), sortMode);
  const normalizedDoneTasks = sortTasksForBoard(dedupeTasksByRecordId(doneTasks), sortMode);
  const cols = [];
  if (normalizedSummaryTasks.length > 0) {
    cols.push({ state: 'summary', label: 'Summary', color: stateColor('summary'), tasks: normalizedSummaryTasks });
  }
  const states = TASK_BOARD_STATES;
  for (const state of states) {
    const tasks = state === 'done'
      ? normalizedDoneTasks
      : normalizedActiveTasks.filter((task) => (
        task.state === state
        || (state === 'new' && !TASK_BOARD_STATES.includes(task.state))
      ));
    cols.push({ state, label: formatStateLabel(state), color: stateColor(state), tasks });
  }
  return cols;
}

export function resolveTaskBoardColumn(task = {}, columns = []) {
  const taskId = String(task?.record_id || task?.recordId || '').trim();
  if (taskId) {
    const containingColumn = (Array.isArray(columns) ? columns : []).find((column) => (
      (Array.isArray(column?.tasks) ? column.tasks : []).some((candidate) => (
        String(candidate?.record_id || candidate?.recordId || '').trim() === taskId
      ))
    ));
    if (containingColumn) return containingColumn;
  }

  const taskState = String(task?.taskState || task?.state || '').trim();
  if (!taskState) return null;
  return (Array.isArray(columns) ? columns : []).find((column) => column?.state === taskState) || null;
}

export function resolveTaskBoardColumnColor(task = {}, columns = []) {
  const column = resolveTaskBoardColumn(task, columns);
  if (column?.color) return String(column.color);
  return stateColor(task?.taskState || task?.state);
}

// ---------------------------------------------------------------------------
// Mixin — methods that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const taskBoardStateMixin = {
  // --- subtask handling ---

  isParentTask(taskId) {
    return getTaskGraph(this).parentIds.has(taskId);
  },

  getSubtasks(parentId) {
    return getTaskGraph(this).subtasksByParent.get(parentId) || EMPTY_ARRAY;
  },

  computedParentState(parentId) {
    return getTaskGraph(this).parentStateByParent.get(parentId) || 'new';
  },

  stateColor(state) {
    return stateColor(state);
  },

  resolveTaskBoardColumnColor(task) {
    return resolveTaskBoardColumnColor(task, this.boardColumns);
  },

  formatState(state) {
    return formatStateLabel(state);
  },

  resolveReferenceLabel(ref) {
    if (!ref || !ref.type || !ref.id) return ref?.id || 'Unknown';
    const type = normalizeRecordLinkType(ref.type);
    if (type === 'task') {
      const task = (this.tasks || []).find(t => t.record_id === ref.id);
      return task?.title || ref.id.slice(0, 8);
    }
    if (type === 'doc') {
      const doc = (this.documents || []).find(d => d.record_id === ref.id);
      return doc?.title || ref.id.slice(0, 8);
    }
    if (type === 'directory') {
      const directory = (this.directories || []).find(d => d.record_id === ref.id);
      return directory?.title || ref.id.slice(0, 8);
    }
    if (type === 'report') {
      const report = (this.reports || []).find(item => item.record_id === ref.id);
      return report?.title || ref.id.slice(0, 8);
    }
    if (type === 'scope') {
      const scope = this.scopesMap?.get(ref.id);
      return scope?.title || ref.id.slice(0, 8);
    }
    if (type === 'flow') {
      const flow = (this.flows || []).find(f => f.record_id === ref.id);
      return flow?.title || ref.id.slice(0, 8);
    }
    if (type === 'opportunity') {
      const opportunity = (this.opportunities || []).find((item) => item.record_id === ref.id);
      return opportunity?.title || ref.id.slice(0, 8);
    }
    if (type === 'chat') {
      const { channelId } = parseChatRecordLinkId(ref.id, this.messages || []);
      const channel = (this.channels || []).find((item) => item.record_id === channelId);
      return channel?.title || channel?.name || 'Chat thread';
    }
    return ref.id.slice(0, 8);
  },

  getRecordLinkTypeLabel(ref) {
    if (!ref?.type) return 'Record';
    const type = normalizeRecordLinkType(ref.type);
    if (type === 'doc') return 'Doc';
    if (type === 'directory') return 'Folder';
    if (type === 'chat') return 'Chat';
    return String(type).charAt(0).toUpperCase() + String(type).slice(1);
  },

  getVisibleRecordLinkSections(record) {
    if (!record || typeof record !== 'object') return [];
    const reverseDeliverables = getReverseSourceDeliverables(record, this);
    const sections = buildVisibleRecordLinkSections(reverseDeliverables.length === 0 ? record : {
      ...record,
      deliverable_links: mergeRecordLinkLists(record?.deliverable_links || [], reverseDeliverables),
    });
    return sections
      .map((section) => ({
        ...section,
        links: section.links.filter((link) => {
          const isNavigable = typeof this.isNavigableRecordLink === 'function'
            ? this.isNavigableRecordLink
            : taskBoardStateMixin.isNavigableRecordLink;
          return isNavigable.call(this, link);
        }),
      }))
      .filter((section) => section.links.length > 0);
  },

  isNavigableRecordLink(ref) {
    const type = normalizeRecordLinkType(ref?.type);
    const id = String(ref?.id || '').trim();
    if (!type || !id) return false;
    if (MENTION_NAVIGABLE_RECORD_LINK_TYPES.has(type)) return true;
    if (type === 'chat') return typeof this.selectChannel === 'function' && typeof this.openThread === 'function';
    if (type === 'directory') return typeof this.navigateToFolder === 'function';
    if (type === 'report') return typeof this.openReportModalById === 'function';
    return false;
  },

  async navigateReference(ref) {
    if (!ref || !ref.type || !ref.id) return;
    const normalizedRef = { ...ref, type: normalizeRecordLinkType(ref.type) };
    const isNavigable = typeof this.isNavigableRecordLink === 'function'
      ? this.isNavigableRecordLink
      : taskBoardStateMixin.isNavigableRecordLink;
    if (!isNavigable.call(this, normalizedRef)) return;
    return await this.handleMentionNavigate(normalizedRef.type, normalizedRef.id);
  },

  // --- board computation ---

  get taskBoards() {
    const dmScope = findDmScope(this.scopes) || createVirtualDmScope(this.workspaceOwnerNpub);
    const boardScopes = findDmScope(this.scopes)
      ? this.scopes
      : [...(this.scopes || []), dmScope];
    const scopeBoards = sortTaskBoardScopes(
      boardScopes.filter((scope) => scope.record_state !== 'deleted'),
      this.scopesMap,
    ).map((scope) => ({
      id: scope.record_id,
      level: scope.level,
      zoom: 'scope',
      label: this.formatTaskBoardScopeDisplay(scope),
      breadcrumb: this.getScopeAncestorPath(scope.record_id),
      description: scope.description || '',
      isDmScope: isDmScope(scope),
    }));
    const boards = [...scopeBoards];
    if (isPgWorkspaceStore(this)) {
      const scopeLabel = (scopeId) => getTaskBoardOptionLabel(scopeId, this.scopesMap) || this.scopesMap.get(scopeId)?.title || 'Scope';
      const channelBoards = (this.channels || [])
        .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
        .map((channel) => {
          const scopeId = getPgChannelScopeId(channel);
          const title = String(channel.title || channel.name || '').trim() || 'Untitled channel';
          return {
            id: buildPgChannelTaskBoardId(channel.record_id),
            level: 'pg-channel',
            zoom: 'channel',
            channelId: channel.record_id,
            scopeId,
            label: `${title}`,
            breadcrumb: scopeId ? `${scopeLabel(scopeId)} > ${title}` : title,
            description: channel.description || 'Channel task board',
          };
        })
        .sort((left, right) => String(left.breadcrumb || '').localeCompare(String(right.breadcrumb || '')));
      const threadIds = new Set();
      const threadBoards = [];
      for (const task of this.tasks || []) {
        const channelId = getTaskPgChannelId(task);
        const threadId = getTaskPgThreadId(task);
        if (!channelId || !threadId || task.record_state === 'deleted') continue;
        const key = `${channelId}:${threadId}`;
        if (threadIds.has(key)) continue;
        threadIds.add(key);
        const channel = (this.channels || []).find((item) => item.record_id === channelId) || null;
        const channelTitle = String(channel?.title || channel?.name || '').trim() || 'Channel';
        threadBoards.push({
          id: buildPgThreadTaskBoardId(channelId, threadId),
          level: 'pg-thread',
          zoom: 'thread',
          channelId,
          threadId,
          scopeId: getPgChannelScopeId(channel),
          label: `Thread ${threadId.slice(0, 8)}`,
          breadcrumb: `${channelTitle} > Thread ${threadId.slice(0, 8)}`,
          description: 'Thread task board',
        });
      }
      if (parsePgTaskBoardId(this.selectedBoardId).type === 'thread'
        && !threadBoards.some((board) => board.id === this.selectedBoardId)) {
        const selected = parsePgTaskBoardId(this.selectedBoardId);
        const channel = (this.channels || []).find((item) => item.record_id === selected.channelId) || null;
        const channelTitle = String(channel?.title || channel?.name || '').trim() || 'Channel';
        threadBoards.push({
          id: this.selectedBoardId,
          level: 'pg-thread',
          zoom: 'thread',
          channelId: selected.channelId,
          threadId: selected.threadId,
          scopeId: getPgChannelScopeId(channel),
          label: `Thread ${String(selected.threadId || '').slice(0, 8)}`,
          breadcrumb: `${channelTitle} > Thread ${String(selected.threadId || '').slice(0, 8)}`,
          description: 'Thread task board',
        });
      }
      boards.push(...channelBoards, ...threadBoards);
    }
    const hasUnscopedTasks = this.tasks.some((task) => task.record_state !== 'deleted' && isTaskUnscoped(task, this.scopesMap));
    if (hasUnscopedTasks) {
      boards.unshift({
        id: UNSCOPED_TASK_BOARD_ID,
        level: 'system',
        zoom: 'system',
        label: 'Unscoped',
        breadcrumb: 'Unscoped',
        description: 'Tasks with no scope assignment',
      });
    }
    boards.unshift(
      {
        id: ALL_TASK_BOARD_ID,
        level: 'system',
        zoom: 'system',
        label: 'All',
        breadcrumb: 'All',
        description: 'All tasks regardless of scope',
      },
      {
        id: RECENT_TASK_BOARD_ID,
        level: 'system',
        zoom: 'system',
        label: 'Recent',
        breadcrumb: 'Recent',
        description: 'Tasks updated in the last 24 hours',
      },
    );
    return boards;
  },

  get selectedBoardScope() {
    if (parsePgTaskBoardId(this.selectedBoardId).type !== 'scope') return null;
    if (!this.selectedBoardId || this.selectedBoardId === UNSCOPED_TASK_BOARD_ID || this.selectedBoardId === ALL_TASK_BOARD_ID || this.selectedBoardId === RECENT_TASK_BOARD_ID) return null;
    return this.scopesMap.get(this.selectedBoardId) || null;
  },

  get selectedBoardIsUnscoped() {
    return this.selectedBoardId === UNSCOPED_TASK_BOARD_ID;
  },

  get selectedBoardLabel() {
    if (this.selectedBoardId === ALL_TASK_BOARD_ID) return 'All';
    if (this.selectedBoardId === RECENT_TASK_BOARD_ID) return 'Recent';
    if (this.selectedBoardIsUnscoped) return 'Unscoped';
    const board = this.taskBoards.find((item) => item.id === this.selectedBoardId);
    if (board?.label) return board.label;
    if (!this.selectedBoardScope) return 'Scope board';
    return this.formatTaskBoardScopeDisplay(this.selectedBoardScope);
  },

  get flightDeckScopeOptions() {
    const options = this.taskBoards.filter((board) =>
      (board.zoom === 'scope' || board.level === 'system')
      && (board.level !== 'system' || board.id === ALL_TASK_BOARD_ID)
    );
    const allOption = options.find((board) => board.id === ALL_TASK_BOARD_ID);
    const dmOption = options.find((board) => board.isDmScope || board.id === DM_SCOPE_ID);
    const remainingOptions = options
      .filter((board) => board.id !== ALL_TASK_BOARD_ID && board !== dmOption)
      .sort((left, right) => {
        const labelDelta = String(left.label || '').localeCompare(String(right.label || ''));
        if (labelDelta !== 0) return labelDelta;
        return String(left.id || '').localeCompare(String(right.id || ''));
      });
    return [allOption, dmOption, ...remainingOptions].filter(Boolean);
  },

  get filteredFlightDeckScopeOptions() {
    const query = String(this.boardPickerQuery || '').trim().toLowerCase();
    if (!query) return this.flightDeckScopeOptions;
    return this.flightDeckScopeOptions.filter((board) => this.getTaskBoardSearchText(board.id).includes(query));
  },

  get recentFocusAreas() {
    return buildRecentFocusAreas(this.tasks, this.scopes, this.scopesMap, {
      limit: 5,
      recentChanges: this.statusRecentChanges,
    });
  },

  filterFlightDeckScopeOptions(query = '') {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return this.flightDeckScopeOptions;
    return this.flightDeckScopeOptions.filter((board) => this.getTaskBoardSearchText(board.id).includes(needle));
  },

  isFlightDeckScopeOptionActive(board = {}) {
    if (!board?.id) return false;
    if (this.selectedBoardId === board.id) return true;
    return isPgWorkspaceStore(this) && this.pgContextScopeId === board.id;
  },

  get focusScopeTitle() {
    if (this.selectedBoardScope) {
      return String(this.selectedBoardScope.title || '').trim() || 'Untitled scope';
    }
    if (this.pgContextScope) {
      return String(this.pgContextScope.title || '').trim() || 'Untitled scope';
    }
    if (this.selectedBoardId === ALL_TASK_BOARD_ID) return 'All';
    if (this.selectedBoardId === RECENT_TASK_BOARD_ID) return 'Recent work';
    if (this.selectedBoardIsUnscoped) return 'Unscoped work';
    return 'No scope selected';
  },

  get focusScopeMeta() {
    if (this.selectedBoardScope) {
      return formatFocusedScopeMeta(this.selectedBoardScope, this.scopesMap);
    }
    if (this.pgContextScope) {
      return formatFocusedScopeMeta(this.pgContextScope, this.scopesMap);
    }
    if (this.selectedBoardId === ALL_TASK_BOARD_ID) return 'Every scope';
    if (this.selectedBoardId === RECENT_TASK_BOARD_ID) return 'Tasks updated in the last 24 hours';
    if (this.selectedBoardIsUnscoped) return 'Tasks without scope assignment';
    return 'Select a scope to focus the day';
  },

  get focusScopeSidebarMeta() {
    return 'Scope';
  },

  get canToggleBoardDescendants() {
    if (this.selectedBoardId === ALL_TASK_BOARD_ID || this.selectedBoardId === RECENT_TASK_BOARD_ID || this.selectedBoardId === UNSCOPED_TASK_BOARD_ID) return false;
    const depth = scopeDepth(this.selectedBoardScope?.level);
    return depth >= 1 && depth < 5;
  },

  get boardDescendantToggleTitle() {
    if (!this.canToggleBoardDescendants) return '';
    return this.showBoardDescendantTasks ? 'Hide lower levels' : 'Show lower levels';
  },

  get taskBoardZoomMode() {
    const board = parsePgTaskBoardId(this.selectedBoardId);
    if (board.type === 'thread') return 'thread';
    if (board.type === 'channel') return 'channel';
    return 'scope';
  },

  get showPgTaskBoardZoomControls() {
    return isPgWorkspaceStore(this) && (this.channels || []).some((channel) => channel?.record_id && channel.record_state !== 'deleted');
  },

  get pgContextScopeId() {
    if (!isPgWorkspaceStore(this)) return null;
    const board = parsePgTaskBoardId(this.selectedBoardId);
    if (board.type === 'scope') {
      if (board.scopeId === ALL_TASK_BOARD_ID || board.scopeId === RECENT_TASK_BOARD_ID || board.scopeId === UNSCOPED_TASK_BOARD_ID) return null;
      return board.scopeId || null;
    }
    const channel = getBoardChannel(this, board);
    return getPgChannelScopeId(channel);
  },

  get pgContextScope() {
    return this.pgContextScopeId ? this.scopesMap.get(this.pgContextScopeId) || null : null;
  },

  get pgContextAllScopesSelected() {
    const board = parsePgTaskBoardId(this.selectedBoardId);
    return board.type === 'scope' && board.scopeId === ALL_TASK_BOARD_ID;
  },

  get pgContextHomeSelected() {
    if (!isPgWorkspaceStore(this)) return false;
    return !this.pgContextSelectedChannelId && !this.pgContextSelectedThreadId;
  },

  get pgContextChannels() {
    if (!this.showPgTaskBoardZoomControls) return [];
    const scopeId = this.pgContextScopeId;
    const channels = (this.channels || [])
      .filter((channel) => {
        if (!channel?.record_id || channel.record_state === 'deleted') return false;
        return !scopeId || getPgChannelScopeId(channel) === scopeId;
      })
      .sort((left, right) => comparePgContextChannels(this, left, right));
    return prioritizeUnreadChannels(
      channels,
      (channelId) => this.isChannelUnread?.(channelId) === true,
      this.pgContextAllScopesSelected,
    );
  },

  get pgContextSelectedChannelId() {
    const board = parsePgTaskBoardId(this.selectedBoardId);
    if (board.channelId) return board.channelId;
    return null;
  },

  get pgContextThreads() {
    const channelId = this.pgContextSelectedChannelId;
    if (!channelId) return [];
    const channel = (this.channels || []).find((entry) => entry.record_id === channelId) || null;
    const rows = (this.messages || []).filter((message) => message?.channel_id === channelId && message.record_state !== 'deleted');
    const taskRows = (this.tasks || []).filter((task) => getTaskPgChannelId(task) === channelId && getTaskPgThreadId(task));
    const docRows = (this.documents || []).filter((doc) => String(doc?.pg_channel_id || '').trim() === channelId && String(doc?.pg_thread_id || '').trim());
    const threadIds = new Set();

    for (const message of rows) {
      const threadId = getMessagePgThreadId(message) || (message?.pg_record_type === 'thread' ? message.record_id : null);
      if (threadId) threadIds.add(threadId);
    }
    for (const task of taskRows) threadIds.add(getTaskPgThreadId(task));
    for (const doc of docRows) threadIds.add(String(doc.pg_thread_id || '').trim());

    const threads = [];
    for (const threadId of threadIds) {
      const root = rows.find((message) => getMessagePgThreadId(message) === threadId && !message.parent_message_id)
        || rows.find((message) => message.record_id === threadId)
        || null;
      const rootMessageId = root?.record_id || null;
      const replies = rootMessageId
        ? rows.filter((message) => message.parent_message_id === rootMessageId)
        : rows.filter((message) => getMessagePgThreadId(message) === threadId);
      const latest = [...replies, root].filter(Boolean)
        .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))[0] || null;
      const title = String(root?.body || latest?.body || '').trim().split('\n')[0] || `Thread ${String(threadId).slice(0, 8)}`;
      threads.push({
        id: threadId,
        channelId,
        channel,
        rootMessageId,
        label: title.length > 72 ? `${title.slice(0, 69)}...` : title,
        replyCount: Math.max(0, replies.length),
        latestPreview: String(latest?.body || '').trim(),
        updatedAt: latest?.updated_at || root?.updated_at || '',
      });
    }
    return threads.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  },

  get pgContextSelectedThreadId() {
    const board = parsePgTaskBoardId(this.selectedBoardId);
    if (board.threadId) return board.threadId;
    return null;
  },

  get canSelectPgThreadTaskBoard() {
    if (!this.showPgTaskBoardZoomControls) return false;
    const board = parsePgTaskBoardId(this.selectedBoardId);
    if (board.type === 'thread' && board.channelId && board.threadId) return true;
    return Boolean(this.selectedChannelId && resolvePgThreadId(this, this.activeThreadId));
  },

  selectPgTaskBoardZoom(mode) {
    const nextMode = String(mode || '').trim();
    const board = parsePgTaskBoardId(this.selectedBoardId);
    const selectedChannelId = board.channelId || this.selectedChannelId || null;
    const selectedChannel = (this.channels || []).find((channel) => channel.record_id === selectedChannelId) || this.selectedChannel || null;
    if (nextMode === 'scope') {
      const scopeId = getPgChannelScopeId(selectedChannel) || (board.type === 'scope' ? board.scopeId : null);
      if (scopeId) this.selectBoard(scopeId);
      return;
    }
    if (nextMode === 'channel') {
      const channelId = selectedChannel?.record_id || board.channelId || null;
      if (channelId) this.selectBoard(buildPgChannelTaskBoardId(channelId));
      return;
    }
    if (nextMode === 'thread') {
      const channelId = selectedChannel?.record_id || board.channelId || null;
      const threadId = board.threadId || resolvePgThreadId(this, this.activeThreadId);
      if (channelId && threadId) this.selectBoard(buildPgThreadTaskBoardId(channelId, threadId));
    }
  },

  selectPgChannelContext(channelId, { preserveDetail = false } = {}) {
    const normalizedChannelId = String(channelId || '').trim();
    if (!normalizedChannelId) return;
    this.selectedChannelId = normalizedChannelId;
    const boardId = buildPgChannelTaskBoardId(normalizedChannelId);
    if (preserveDetail) {
      // Opening a record follows its context; it is not a board navigation
      // that should close the just-opened detail after a paint.
      this.selectedBoardId = boardId;
      this.persistSelectedBoardId?.(boardId);
      this.showBoardDescendantTasks = false;
      this.clearSelectedTasks?.();
      this.normalizeTaskFilterTags?.();
      return;
    }
    return this.selectBoard(boardId);
  },

  selectWorkContextScope(boardId, event = null) {
    const normalizedBoardId = String(boardId || '').trim();
    if (!normalizedBoardId) return;
    if (event) recordNavigationPointer(this, 'scope', normalizedBoardId, event);
    return this.selectWorkContextBoard(normalizedBoardId);
  },

  selectWorkContextChannel(channelId, event = null) {
    const normalizedChannelId = String(channelId || '').trim();
    if (!normalizedChannelId) return;
    if (event) recordNavigationPointer(this, 'channel', normalizedChannelId, event);
    return this.selectWorkContextBoard(buildPgChannelTaskBoardId(normalizedChannelId));
  },

  async selectWorkContextBoard(boardId) {
    const normalizedBoardId = String(boardId || '').trim();
    if (!normalizedBoardId) return;
    const previousSection = this.navSection;
    const docsVisit = this.docsHomeVisit = Number(this.docsHomeVisit || 0) + 1;
    if (previousSection === 'docs' && this.docEditDraftDirty) {
      const originId = this.selectedDocId;
      const originBoardId = this.selectedBoardId;
      if (!await this.preserveWikiNavigationDraft?.()) return false;
      if (docsVisit !== this.docsHomeVisit || this.navSection !== previousSection || this.selectedDocId !== originId || this.selectedBoardId !== originBoardId) return false;
    }
    if (previousSection === 'chat') {
      const previousChannelId = String(this.selectedChannelId || '').trim();
      this.saveCurrentChatPresentation?.(
        previousChannelId ? this.getChatPresentationKey?.(previousChannelId) : `scope:${this.selectedBoardId}`,
      );
      this.saveChatComposerDraft?.('message');
      this.saveChatComposerDraft?.('thread');
    }

    // A locked content view keeps using the existing board selection/filtering
    // path. Unlocked context navigation still opens Deck before follow-up work.
    const destination = this.isCurrentViewLocked ? previousSection : 'status';
    // Close the old thread before board selection clears its id, so its draft,
    // subscriptions and Deck overlay state are cleaned up in the old context.
    if (this.activeThreadId) {
      if (this.deckThreadChannelId) this.closeDeckThread?.({ syncRoute: false, fromRoute: true });
      else this.closeThread?.({ syncRoute: false });
    }
    this.navSection = destination;
    this.mobileNavOpen = false;
    this.showWorkspaceSwitcherMenu = false;
    const selection = this.selectBoard(normalizedBoardId);
    return Promise.resolve(selection).then(async () => {
      if (String(this.selectedBoardId || '') !== normalizedBoardId || this.navSection !== destination) return;
      if (previousSection !== destination) this.clearInactiveSectionData?.(destination);
      if (this.chatTaskModalOpen) await this.closeChatTaskModal?.();
      else if (this.showTaskDetail) await this.closeTaskDetail?.({ syncRoute: false });
      if (String(this.selectedBoardId || '') !== normalizedBoardId || this.navSection !== destination) return;
      if (destination === 'status') void this.refreshStatusRecentChanges?.({ force: true });
      if (destination === 'docs') await this.openChannelDocsHome?.({ syncRoute: false });
      if (String(this.selectedBoardId || '') !== normalizedBoardId || this.navSection !== destination) return;
      this.syncRoute();
      this.startWorkspaceLiveQueries?.();
      this.ensureBackgroundSync?.(true);
    });
  },

  openWorkContextHome(event = null) {
    const scopeId = this.pgContextScopeId || ALL_TASK_BOARD_ID;
    return this.selectWorkContextScope(scopeId, event);
  },

  selectDeckScope(boardId, event = null) {
    if (event) recordNavigationPointer(this, 'scope', boardId, event);
    if (typeof this.navigateTo === 'function') this.navigateTo('status', { syncRoute: false });
    this.selectBoard(boardId);
  },

  async selectDeckChannel(channelId) {
    const normalizedChannelId = String(channelId || '').trim();
    if (!normalizedChannelId) return;
    if (this.chatTaskModalOpen && typeof this.closeChatTaskModal === 'function') {
      await this.closeChatTaskModal();
    } else if (this.showTaskDetail && typeof this.closeTaskDetail === 'function') {
      await this.closeTaskDetail({ syncRoute: false });
    }
    if (this.activeThreadId) {
      if (this.deckThreadChannelId && typeof this.closeDeckThread === 'function') {
        this.closeDeckThread({ syncRoute: false, fromRoute: true });
      } else {
        this.closeThread?.({ syncRoute: false });
      }
    }
    if (typeof this.navigateTo === 'function') this.navigateTo('status', { syncRoute: false });
    this.selectPgChannelContext(normalizedChannelId);
  },

  openDeckScopeHome() {
    if (typeof this.navigateTo === 'function') this.navigateTo('status', { syncRoute: false });
    this.openPgScopeHome();
  },

  openPgScopeHome(event = null) {
    if (!isPgWorkspaceStore(this)) {
      this.openAllScopesOverview();
      return;
    }
    const scopeId = this.pgContextScopeId || ALL_TASK_BOARD_ID;
    this.selectedChannelId = null;
    this.activeThreadId = null;
    this.focusMessageId = null;
    if (event) recordNavigationPointer(this, 'scope', scopeId, event);
    this.selectBoard(scopeId);
  },

  openAllScopesOverview() {
    if (!this.isCurrentViewLocked) this.resetDeckMobileEntry?.();
    this.currentFolderId = null;
    this.fileCurrentFolderId = '';
    this.fileScopeFilter = 'all';
    this.fileChannelFilter = 'all';
    this.fileThreadFilter = 'all';
    return this.selectWorkContextBoard(ALL_TASK_BOARD_ID);
  },

  selectPgThreadContext(channelId, threadId) {
    const normalizedChannelId = String(channelId || '').trim();
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedChannelId || !normalizedThreadId) return;
    this.selectBoard(buildPgThreadTaskBoardId(normalizedChannelId, normalizedThreadId));
  },

  get preferredTaskBoardId() {
    const activeTasks = this.tasks.filter((task) => task.record_state !== 'deleted');
    const boards = this.taskBoards.filter((b) => b.id !== UNSCOPED_TASK_BOARD_ID);
    if (isPgWorkspaceStore(this)) {
      const channelBoards = boards.filter((board) => board.zoom === 'channel' && board.channelId);
      if (channelBoards.length > 0) {
        let bestBoard = channelBoards[0];
        let bestCount = -1;
        for (const board of channelBoards) {
          const count = activeTasks.filter((task) => getTaskPgChannelId(task) === board.channelId).length;
          if (count > bestCount) {
            bestCount = count;
            bestBoard = board;
          }
        }
        return bestBoard.id;
      }
    }
    if (boards.length > 0) {
      let bestBoard = boards[0];
      let bestCount = 0;
      for (const board of boards) {
        const scope = this.scopesMap.get(board.id);
        if (!scope) continue;
        const count = activeTasks.filter((task) => matchesTaskBoardScope(task, scope, this.scopesMap, { includeDescendants: true })).length;
        if (count > bestCount) {
          bestCount = count;
          bestBoard = board;
        }
      }
      return bestBoard.id;
    }
    if (activeTasks.some((task) => isTaskUnscoped(task, this.scopesMap))) {
      return UNSCOPED_TASK_BOARD_ID;
    }
    return this.taskBoards[0]?.id || null;
  },

  toggleBoardDescendantTasks() {
    this.showBoardDescendantTasks = !this.showBoardDescendantTasks;
    this.startWorkspaceLiveQueries?.();
    this.normalizeTaskFilterTags();
    if (this.showTaskDetail) this.closeTaskDetail();
    else this.syncRoute();
  },

  toggleTaskViewMode() {
    this.collapsedSections = { ...this.collapsedSections, new: true };
    this.taskViewMode = this.taskViewMode === 'kanban' ? 'list' : 'kanban';
    this.syncRoute();
  },

  setTaskSortMode(mode) {
    this.taskSortMode = normalizeTaskSortMode(mode);
    this.startWorkspaceLiveQueries?.();
    if (typeof this.persistTaskSortMode === 'function') {
      this.persistTaskSortMode(this.taskSortMode);
    }
    this.syncRoute();
  },

  get taskSortIsManual() {
    return normalizeTaskSortMode(this.taskSortMode) === 'manual';
  },

  get listGroupedTasks() {
    return getTaskBoardDerived(this).listGroupedTasks;
  },

  getTaskBoardOptionLabel(scopeId) {
    const board = this.taskBoards.find((item) => item.id === scopeId);
    if (board?.label) return board.label;
    return getTaskBoardOptionLabel(scopeId, this.scopesMap);
  },

  getTaskBoardSearchText(scopeId) {
    const board = this.taskBoards.find((item) => item.id === scopeId);
    if (board) return `${board.label || ''} ${board.breadcrumb || ''} ${board.description || ''}`.toLowerCase();
    return getTaskBoardSearchText(scopeId, this.scopesMap);
  },

  getScopeAncestorPath(scopeId) {
    return getScopeAncestorPath(scopeId, this.scopesMap);
  },

  formatTaskBoardScopeDisplay(scope) {
    return formatTaskBoardScopeDisplay(scope, this.scopesMap);
  },

  getTaskBoardWriteGroup(scopeId) {
    const pgBoard = parsePgTaskBoardId(scopeId);
    if (pgBoard.type !== 'scope') {
      const channel = (this.channels || []).find((entry) => entry.record_id === pgBoard.channelId) || null;
      return channel ? this.getPreferredChannelWriteGroup(channel) : null;
    }
    if (scopeId === ALL_TASK_BOARD_ID || scopeId === RECENT_TASK_BOARD_ID || scopeId === UNSCOPED_TASK_BOARD_ID) return this.getWorkspaceSettingsGroupRef();
    const scope = this.scopesMap.get(scopeId);
    if (!scope) return null;
    const groupIds = this.getScopeShareGroupIds(scope);
    const allowedGroupIds = typeof this.getActorWritableGroupRefs === 'function'
      ? this.getActorWritableGroupRefs()
      : [];
    return selectPreferredWritableGroupRef({
      groupIds,
      scopePolicyGroupIds: groupIds,
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      allowedGroupIds,
    });
  },

  buildTaskBoardAssignment(scopeId, fallbackTask = null) {
    const pgBoard = parsePgTaskBoardId(scopeId);
    if (pgBoard.type !== 'scope') {
      const channel = (this.channels || []).find((entry) => entry.record_id === pgBoard.channelId) || null;
      const channelScopeId = getPgChannelScopeId(channel);
      return this.buildTaskBoardAssignment(channelScopeId, fallbackTask);
    }
    if (scopeId === ALL_TASK_BOARD_ID || scopeId === RECENT_TASK_BOARD_ID || scopeId === UNSCOPED_TASK_BOARD_ID) {
      // Moving to unscoped — strip old scope shares, keep explicit
      const groupId = this.getWorkspaceSettingsGroupRef();
      const fromScope = fallbackTask?.scope_id ? this.scopesMap.get(fallbackTask.scope_id) : null;
      const fromGroupIds = fromScope ? this.getScopeShareGroupIds(fromScope) : [];
      const { explicitShares } = separateScopeShares(toRaw(fallbackTask?.shares ?? []), fromGroupIds);
      const defaultShares = groupId ? this.buildScopeDefaultShares([groupId]) : this.getDefaultPrivateShares();
      const merged = mergeShareLists(defaultShares, explicitShares);
      return {
        scope_id: null,
        scope_l1_id: null,
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        board_group_id: groupId || fallbackTask?.board_group_id || null,
        group_ids: this.getShareGroupIds(merged),
        shares: toRaw(merged),
      };
    }
    const scope = this.scopesMap.get(scopeId) || null;
    if (!scope) {
      return {
        scope_id: fallbackTask?.scope_id ?? null,
        scope_l1_id: fallbackTask?.scope_l1_id ?? null,
        scope_l2_id: fallbackTask?.scope_l2_id ?? null,
        scope_l3_id: fallbackTask?.scope_l3_id ?? null,
        scope_l4_id: fallbackTask?.scope_l4_id ?? null,
        scope_l5_id: fallbackTask?.scope_l5_id ?? null,
        scope_policy_group_ids: toRaw(fallbackTask?.scope_policy_group_ids ?? null),
        board_group_id: fallbackTask?.board_group_id ?? null,
        group_ids: toRaw(fallbackTask?.group_ids ?? []),
        shares: toRaw(fallbackTask?.shares ?? []),
      };
    }

    // Scope move: separate old scope shares from explicit, rebuild for destination
    const fromScope = fallbackTask?.scope_id ? this.scopesMap.get(fallbackTask.scope_id) : null;
    const fromGroupIds = fromScope ? this.getScopeShareGroupIds(fromScope) : [];
    const { explicitShares } = separateScopeShares(toRaw(fallbackTask?.shares ?? []), fromGroupIds);
    const rebuilt = rebuildAccessForScope(explicitShares, scope, this.groups);
    const groupIds = rebuilt.group_ids.map((id) => this.resolveGroupId(id)).filter(Boolean);
    const boardGroupId = selectPreferredWritableGroupRef({
      boardGroupId: fallbackTask?.board_group_id,
      groupIds,
      scopePolicyGroupIds: groupIds,
      shares: rebuilt.shares,
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      allowedGroupIds: typeof this.getActorWritableGroupRefs === 'function'
        ? this.getActorWritableGroupRefs()
        : [],
    });

    return {
      ...buildScopeTags(scope),
      scope_policy_group_ids: groupIds,
      board_group_id: boardGroupId,
      group_ids: groupIds,
      shares: toRaw(rebuilt.shares),
    };
  },

  getTaskBoardScopeFromTask(task) {
    if (!task) return null;
    if (task.scope_id && this.scopesMap.has(task.scope_id)) return this.scopesMap.get(task.scope_id) || null;
    for (const key of ['scope_l5_id', 'scope_l4_id', 'scope_l3_id', 'scope_l2_id', 'scope_l1_id']) {
      if (task[key] && this.scopesMap.has(task[key])) return this.scopesMap.get(task[key]) || null;
    }
    return null;
  },

  get filteredTaskBoards() {
    const query = String(this.boardPickerQuery || '').trim().toLowerCase();
    if (!query) return this.taskBoards;
    return this.taskBoards.filter((board) => this.getTaskBoardSearchText(board.id).includes(query));
  },

  get weekdayOptions() {
    return WEEKDAY_OPTIONS;
  },

  // --- group resolution ---

  resolveGroupId(groupRef) {
    return resolveGroupId(groupRef, this.groups);
  },

  normalizeTaskRowGroupRefs(task) {
    return normalizeTaskRowGroupRefs(task, (ref) => this.resolveGroupId(ref));
  },

  normalizeTaskRowScopeRefs(task) {
    return normalizeTaskRowScopeRefs(task, this.scopesMap);
  },

  normalizeScheduleRowGroupRefs(schedule) {
    return normalizeScheduleRowGroupRefs(schedule, (ref) => this.resolveGroupId(ref));
  },

  normalizeScopeRowGroupRefs(scope) {
    return normalizeScopeRowGroupRefs(scope, (ref) => this.resolveGroupId(ref));
  },

  // --- section collapse ---

  isSectionCollapsed(state) {
    return Boolean(this.collapsedSections[state]);
  },

  toggleSectionCollapse(state) {
    this.collapsedSections = {
      ...this.collapsedSections,
      [state]: !this.collapsedSections[state],
    };
    this.persistCollapsedSections();
  },

  persistCollapsedSections() {
    if (typeof window === 'undefined') return;
    const slug = this.currentWorkspaceSlug;
    const key = slug
      ? `coworker:${slug}:collapsed-sections`
      : 'coworker:collapsed-sections';
    const active = Object.fromEntries(
      Object.entries(this.collapsedSections).filter(([, v]) => v)
    );
    if (Object.keys(active).length > 0) {
      window.localStorage.setItem(key, JSON.stringify(active));
    } else {
      window.localStorage.removeItem(key);
    }
  },

  readStoredCollapsedSections() {
    if (typeof window === 'undefined') return { new: true };
    const slug = this.currentWorkspaceSlug;
    const key = slug
      ? `coworker:${slug}:collapsed-sections`
      : 'coworker:collapsed-sections';
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { new: true };
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? { ...parsed, new: true } : { new: true };
    } catch {
      return { new: true };
    }
  },

  // --- board picker ---

  toggleBoardPicker() {
    this.showBoardPicker = !this.showBoardPicker;
    if (!this.showBoardPicker) this.boardPickerQuery = '';
  },

  closeBoardPicker() {
    this.showBoardPicker = false;
    this.boardPickerQuery = '';
  },

  syncSelectedChannelForPgBoard(boardId = this.selectedBoardId) {
    if (!isPgWorkspaceStore(this)) return;
    const board = parsePgTaskBoardId(boardId);
    const channels = Array.isArray(this.channels) ? this.channels : [];
    const activeChannel = (channelId) => channels.find((channel) => channel?.record_id === channelId && channel.record_state !== 'deleted') || null;
    if (board.type === 'channel' || board.type === 'thread') {
      if (activeChannel(board.channelId)) this.selectedChannelId = board.channelId;
      return;
    }
    if (board.type === 'scope' && board.scopeId) {
      this.selectedChannelId = null;
      this.activeThreadId = null;
      this.focusMessageId = null;
      return;
    }
    if (board.type !== 'scope'
      || !board.scopeId
      || board.scopeId === ALL_TASK_BOARD_ID
      || board.scopeId === RECENT_TASK_BOARD_ID
      || board.scopeId === UNSCOPED_TASK_BOARD_ID) {
      this.selectedChannelId = null;
      this.activeThreadId = null;
      this.focusMessageId = null;
      return;
    }
    const selected = activeChannel(this.selectedChannelId);
    if (selected && getPgChannelScopeId(selected) === board.scopeId) return;
    const scopedChannel = channels.find((channel) => channel?.record_id
      && channel.record_state !== 'deleted'
      && getPgChannelScopeId(channel) === board.scopeId) || null;
    if (scopedChannel?.record_id) this.selectedChannelId = scopedChannel.record_id;
  },

  async selectBoard(boardId) {
    const scopeSelectionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    let nextBoardId = boardId;
    const nextBoard = parsePgTaskBoardId(nextBoardId);
    const scopeTiming = beginNavigationTiming(this, 'scope', nextBoard.scopeId || nextBoardId);
    const previousBoardId = this.selectedBoardId;
    const previousChannelId = this.selectedChannelId;
    if (this.navSection === 'chat') {
      this.saveCurrentChatPresentation?.(
        previousChannelId ? this.getChatPresentationKey?.(previousChannelId) : `scope:${previousBoardId}`,
      );
      this.saveChatComposerDraft?.('message');
      this.saveChatComposerDraft?.('thread');
    }
    const openDocument = nextBoardId !== previousBoardId
      && this.navSection === 'docs'
      && this.docsEditorOpen
      && this.selectedDocument?.record_id
      ? this.selectedDocument
      : null;
    if (nextBoardId !== previousBoardId) {
      this.collapsedSections = { ...this.collapsedSections, new: true };
    }
    this.taskVisibleCount = 50;
    this.selectedBoardId = nextBoardId;
    this.syncSelectedChannelForPgBoard(nextBoardId);
    if (this.navSection === 'chat' && isPgWorkspaceStore(this) && nextBoard.type === 'scope') {
      const generation = Number(this.channelSelectionGeneration || 0) + 1;
      this.channelSelectionGeneration = generation;
      const presentationKey = `scope:${nextBoardId}`;
      const cachedPresentation = this.chatPresentationCache?.get?.(presentationKey) || null;
      scopeTiming.cacheHit = Boolean(cachedPresentation);
      this.applyChatPresentation?.(null, cachedPresentation, {
        pending: !cachedPresentation,
        scrollToLatest: false,
      });
      if (!cachedPresentation) this.pendingChannelSelectionId = presentationKey;
      markNavigationTiming(scopeTiming, 'stateAssignedAt');
      flightDeckTrace('scope-selection', 'visible selection state', {
        scopeId: nextBoard.scopeId,
        generation,
        cacheHit: Boolean(cachedPresentation),
        messageCount: this.messages?.length || 0,
        renderedRootCount: this.visibleMainFeedMessages?.length || 0,
        sinceSelectionMs: (globalThis.performance?.now?.() ?? Date.now()) - scopeSelectionStartedAt,
      });
    } else {
      markNavigationTiming(scopeTiming, 'stateAssignedAt');
    }

    const paintResult = await waitForNavigationPaint(this, {
      afterNextTick: () => markNavigationTiming(scopeTiming, 'alpineTickAt'),
    });
    scopeTiming.browserPaintBoundary = paintResult.browserPaintBoundary;
    markNavigationTiming(scopeTiming, 'paintAt');
    if (this.selectedBoardId !== nextBoardId) return;
    markNavigationTiming(scopeTiming, 'postPaintStartAt');

    this.persistSelectedBoardId(nextBoardId);
    this.showBoardDescendantTasks = false;
    this.clearSelectedTasks();
    this.normalizeTaskFilterTags();
    this.closeBoardPicker();
    if (this.navSection === 'chat' && isPgWorkspaceStore(this) && nextBoard.type === 'scope') {
      const generation = Number(this.channelSelectionGeneration || 0);
      const presentationKey = `scope:${nextBoardId}`;
      const cachedPresentation = this.chatPresentationCache?.get?.(presentationKey) || null;
      this.restoreChatComposerDraft?.('message');
      this.restoreChatComposerDraft?.('thread');
      if (cachedPresentation) this.startWorkspaceLiveQueries?.();
      else {
        const readStartedAt = globalThis.performance?.now?.() ?? Date.now();
        void Promise.resolve(this.refreshMessages?.({
          scrollToLatest: false,
          selectionGeneration: generation,
          deferEnrichment: true,
        })).then(() => {
          if (Number(this.channelSelectionGeneration || 0) !== generation || this.selectedChannelId) return;
          this.pendingChannelSelectionId = '';
          this.saveCurrentChatPresentation?.(presentationKey);
          this.startWorkspaceLiveQueries?.();
          flightDeckTrace('scope-selection', 'local read end', {
            scopeId: nextBoard.scopeId,
            generation,
            queryDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - readStartedAt,
            messageCount: this.messages?.length || 0,
          });
        });
      }
    } else if (this.navSection === 'chat') {
      this.ensureSelectedChatChannelInScope?.({ syncRoute: false });
      if (this.selectedChannelId && this.selectedChannelId !== previousChannelId) {
        this.selectChannel?.(this.selectedChannelId, { syncRoute: false });
      } else if (this.selectedChannelId) {
        this.restoreChatComposerDraft?.('message');
      } else if (!this.selectedChannelId) {
        this.stopSelectedChannelLiveQuery?.();
        void this.applyMessages?.([], { scrollToLatest: false });
      }
    }
    if (openDocument
      && typeof this.resetOpenDocumentForContextChange === 'function') {
      await this.resetOpenDocumentForContextChange(openDocument, { syncRoute: false });
    }
    if (this.selectedBoardId !== nextBoardId) return;
    if (this.showTaskDetail) await this.closeTaskDetail();
    else this.syncRoute();
    markNavigationTiming(scopeTiming, 'postPaintEndAt');
    publishNavigationTiming(this, scopeTiming);
  },

  readStoredTaskBoardId() {
    if (typeof window === 'undefined') return null;
    const slug = this.currentWorkspaceSlug;
    const key = namespacedBoardKey(slug);
    // Migrate: if namespaced key is empty but legacy key has a value, copy it over
    if (slug) {
      const namespaced = window.localStorage.getItem(key);
      if (!namespaced) {
        const legacy = window.localStorage.getItem(TASK_BOARD_STORAGE_KEY);
        if (legacy) {
          window.localStorage.setItem(key, legacy);
          window.localStorage.removeItem(TASK_BOARD_STORAGE_KEY);
          return legacy;
        }
      }
    }
    return window.localStorage.getItem(key) || null;
  },

  persistSelectedBoardId(boardId) {
    if (typeof window === 'undefined') return;
    const key = namespacedBoardKey(this.currentWorkspaceSlug);
    if (boardId) window.localStorage.setItem(key, boardId);
    else window.localStorage.removeItem(key);
  },

  validateSelectedBoardId() {
    if (!this.selectedBoardId) {
      this.selectedBoardId = this.preferredTaskBoardId;
      this.persistSelectedBoardId(this.selectedBoardId);
      return;
    }
    const isSystemBoard = this.selectedBoardId === ALL_TASK_BOARD_ID
      || this.selectedBoardId === RECENT_TASK_BOARD_ID
      || this.selectedBoardId === UNSCOPED_TASK_BOARD_ID;
    // If scopes haven't loaded yet, don't invalidate a scope-based board ID —
    // it may become valid once scopes arrive from the DB or sync.
    if (!isSystemBoard && !this.scopesLoaded) return;
    const exists = isSystemBoard
      || this.taskBoards.some((board) => board.id === this.selectedBoardId);
    if (!exists) {
      this.selectedBoardId = this.preferredTaskBoardId;
      this.persistSelectedBoardId(this.selectedBoardId);
    }
  },

  normalizeTaskFilterTags() {
    const availableTags = new Set(this.allTaskTags);
    this.taskFilterTags = this.taskFilterTags.filter((tag) => availableTags.has(tag));
  },

  // --- task filtering ---

  get boardScopedTasks() {
    return getTaskBoardDerived(this).boardScopedTasks;
  },

  get filteredTasks() {
    return getTaskBoardDerived(this).filteredTasks;
  },

  get activeTasks() {
    return getTaskBoardDerived(this).activeTasks;
  },

  get doneTasks() {
    return getTaskBoardDerived(this).doneTasks;
  },

  get summaryTasks() {
    return getTaskBoardDerived(this).summaryTasks;
  },

  get selectedTasks() {
    return this.tasks.filter((task) => this.selectedTaskIds.includes(task.record_id));
  },

  get selectedTaskCount() {
    return this.selectedTasks.length;
  },

  get canBulkAssignToDefaultAgent() {
    return Boolean(this.defaultAgentNpub && this.selectedTaskCount > 0 && !this.bulkTaskBusy);
  },

  get boardColumns() {
    return getTaskBoardDerived(this).boardColumns;
  },

  // --- calendar ---

  get calendarScheduledTasks() {
    return getTaskBoardDerived(this).calendarScheduledTasks;
  },

  get taskCalendar() {
    return buildTaskCalendar(this.calendarScheduledTasks, {
      view: this.calendarView,
      anchorDateKey: this.calendarAnchorDate,
    });
  },

  // --- visible board tasks / tags ---

  get visibleBoardTasks() {
    return getTaskBoardDerived(this).visibleBoardTasks;
  },

  get allTaskTags() {
    return getTaskBoardDerived(this).allTaskTags;
  },

  get allTaskTagCounts() {
    return getTaskBoardDerived(this).allTaskTagCounts;
  },

  get primaryTaskFilterTags() {
    return this.allTaskTags.slice(0, TASK_FILTER_TAG_LIMIT);
  },

  get hasTaskFilterTagOverflow() {
    return this.allTaskTags.length > TASK_FILTER_TAG_LIMIT;
  },

  getTaskTags(task) {
    return parseTaskTags(task?.tags);
  },

  getTaskTagsByPopularity(task) {
    return sortTagsByPopularity(this.getTaskTags(task), this.allTaskTagCounts);
  },

  getTaskCardVisibleTags(task) {
    return this.getTaskTagsByPopularity(task).slice(0, TASK_CARD_TAG_LIMIT);
  },

  getTaskCardOverflowCount(task) {
    return Math.max(0, this.getTaskTagsByPopularity(task).length - TASK_CARD_TAG_LIMIT);
  },

  openTaskTagCloud() {
    this.taskTagCloudOpen = true;
  },

  closeTaskTagCloud() {
    this.taskTagCloudOpen = false;
  },

  toggleTaskTagCloud() {
    this.taskTagCloudOpen = !this.taskTagCloudOpen;
  },

  getTaskBoardLabel(taskOrScopeRef) {
    if (!taskOrScopeRef) return 'Scope board';
    if (typeof taskOrScopeRef !== 'string' && isTaskUnscoped(taskOrScopeRef, this.scopesMap)) return 'Unscoped';
    if (taskOrScopeRef === UNSCOPED_TASK_BOARD_ID) return 'Unscoped';
    const scope = typeof taskOrScopeRef === 'string'
      ? this.scopesMap.get(taskOrScopeRef) || null
      : this.getTaskBoardScopeFromTask(taskOrScopeRef);
    if (!scope) return 'Scope board';
    return this.getTaskBoardOptionLabel(scope.record_id);
  },

  get selectedBoardWriteGroup() {
    return this.getTaskBoardWriteGroup(this.selectedBoardId)
      || this.getWorkspaceSettingsGroupRef()
      || null;
  },

  async ensureTaskBoardScopeSetup() {
    if (this.taskBoardScopeSetupInFlight) return;
    this.taskBoardScopeSetupInFlight = true;
    try {
      this.validateSelectedBoardId();
    } finally {
      this.taskBoardScopeSetupInFlight = false;
    }
  },

  // --- schedule/scope group suggestions ---

  getScheduleAssignedGroupLabel(groupId) {
    const resolvedGroupId = this.resolveGroupId(groupId);
    if (!resolvedGroupId) return 'Unassigned';
    if (resolvedGroupId === this.memberPrivateGroupRef) return 'Private group';
    return this.scheduleAssignableGroups.find((group) => group.groupId === resolvedGroupId)?.label || resolvedGroupId;
  },

  getActorWritableGroupRefs() {
    const viewerNpub = String(this.session?.npub || '').trim();
    const workspaceOwnerNpub = String(this.workspaceOwnerNpub || '').trim();
    if (!viewerNpub) return [];

    const candidateGroups = Array.isArray(this.currentWorkspaceContentGroups) && this.currentWorkspaceContentGroups.length > 0
      ? this.currentWorkspaceContentGroups
      : (Array.isArray(this.groups) ? this.groups : []);
    const resolveGroupRef = (groupRef) => this.resolveGroupId(groupRef);

    if (viewerNpub === workspaceOwnerNpub) {
      return [...new Set(candidateGroups
        .map((group) => resolveGroupRef(group?.group_id || group?.group_npub))
        .filter(Boolean))];
    }

    const sharedRefs = [];
    const privateRefs = [];
    const seen = new Set();

    for (const group of candidateGroups) {
      const isViewerPrivate = String(group?.private_member_npub || '').trim() === viewerNpub;
      const hasMembership = Array.isArray(group?.member_npubs) && group.member_npubs.includes(viewerNpub);
      if (!isViewerPrivate && !hasMembership) continue;

      const groupRef = resolveGroupRef(group?.group_id || group?.group_npub);
      if (!groupRef || seen.has(groupRef)) continue;
      seen.add(groupRef);

      if (isViewerPrivate) {
        privateRefs.push(groupRef);
      } else {
        sharedRefs.push(groupRef);
      }
    }

    return [...sharedRefs, ...privateRefs];
  },

  getPreferredChannelWriteGroup(channel) {
    const allowedGroupIds = typeof this.getActorWritableGroupRefs === 'function'
      ? this.getActorWritableGroupRefs()
      : [];
    return selectPreferredWritableGroupRef({
      writeGroupId: channel?.write_group_id,
      boardGroupId: channel?.board_group_id,
      groupIds: channel?.group_ids || [],
      scopePolicyGroupIds: channel?.scope_policy_group_ids || [],
      shares: channel?.shares || [],
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      allowedGroupIds,
    });
  },

  getPreferredRecordWriteGroup(record = null) {
    const allowedGroupIds = typeof this.getActorWritableGroupRefs === 'function'
      ? this.getActorWritableGroupRefs()
      : [];
    return selectPreferredWritableGroupRef({
      writeGroupId: record?.write_group_id,
      boardGroupId: record?.board_group_id,
      groupIds: record?.group_ids || [],
      scopePolicyGroupIds: record?.scope_policy_group_ids || [],
      shares: record?.shares || [],
      resolveGroupId: (groupId) => this.resolveGroupId(groupId),
      allowedGroupIds,
    });
  },

  get activeTaskDetail() {
    if (!this.activeTaskId) return null;
    return this.tasks.find(t => t.record_id === this.activeTaskId) ?? null;
  },

  get scheduleAssignableGroups() {
    return this.currentWorkspaceContentGroups.map((group) => ({
      groupId: group.group_id || group.group_npub,
      label: group.name || 'Group',
      subtitle: group.group_kind === 'private'
        ? 'Private group'
        : `${(group.member_npubs || []).length} members`,
    }));
  },

  get scopeAssignableGroups() {
    return this.currentWorkspaceContentGroups.map((group) => ({
      groupId: group.group_id || group.group_npub,
      label: group.name || 'Group',
      subtitle: group.group_kind === 'private'
        ? 'Private group'
        : `${(group.member_npubs || []).length} members`,
    }));
  },

  get newScheduleGroupSuggestions() {
    return this.findScheduleGroupSuggestions(
      this.newScheduleGroupQuery,
      [this.newScheduleAssignedGroupId],
    );
  },

  get editingScheduleGroupSuggestions() {
    return this.findScheduleGroupSuggestions(
      this.editingScheduleGroupQuery,
      [this.editingScheduleDraft?.assigned_group_id],
    );
  },

  get newScopeGroupSuggestions() {
    return this.findScopeGroupSuggestions(
      this.newScopeGroupQuery,
      this.newScopeAssignedGroupIds,
    );
  },

  get editingScopeGroupSuggestions() {
    return this.findScopeGroupSuggestions(
      this.editingScopeGroupQuery,
      this.editingScopeAssignedGroupIds,
    );
  },

  findScheduleGroupSuggestions(query, excludeGroupIds = []) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const existing = new Set((excludeGroupIds || []).map((value) => this.resolveGroupId(value)).filter(Boolean));
    return this.scheduleAssignableGroups
      .filter((group) => !existing.has(group.groupId))
      .filter((group) =>
        String(group.label || '').toLowerCase().includes(needle)
        || String(group.groupId || '').toLowerCase().includes(needle)
        || String(group.subtitle || '').toLowerCase().includes(needle)
      )
      .slice(0, 8);
  },

  findScopeGroupSuggestions(query, excludeGroupIds = []) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const existing = new Set((excludeGroupIds || []).map((value) => this.resolveGroupId(value)).filter(Boolean));
    return this.scopeAssignableGroups
      .filter((group) => !existing.has(group.groupId))
      .filter((group) =>
        String(group.label || '').toLowerCase().includes(needle)
        || String(group.groupId || '').toLowerCase().includes(needle)
        || String(group.subtitle || '').toLowerCase().includes(needle)
      )
      .slice(0, 8);
  },

  getScopeAssignedGroupLabel(groupId) {
    const resolvedGroupId = this.resolveGroupId(groupId);
    if (!resolvedGroupId) return 'Group';
    return this.scopeAssignableGroups.find((group) => group.groupId === resolvedGroupId)?.label || resolvedGroupId;
  },

  getScopeAssignedGroupSubtitle(groupId) {
    const resolvedGroupId = this.resolveGroupId(groupId);
    if (!resolvedGroupId) return '';
    return this.scopeAssignableGroups.find((group) => group.groupId === resolvedGroupId)?.subtitle || resolvedGroupId;
  },

  getScopeGroupSummary(scope) {
    const groupIds = normalizeGroupIds(scope?.group_ids).map((groupId) => this.resolveGroupId(groupId)).filter(Boolean);
    if (groupIds.length === 0) return 'No groups';
    return groupIds.map((groupId) => this.getScopeAssignedGroupLabel(groupId)).join(', ');
  },

  // --- scope helpers ---

  get scopesMap() {
    return getCachedScopesMap(this);
  },

  get scopeTree() {
    const active = this.scopes.filter(s => s.record_state !== 'deleted');
    const buildChildren = (parentId) =>
      active
        .filter(s => (s.parent_id || null) === (parentId || null) && scopeDepth(s.level) > (parentId ? scopeDepth(this.scopesMap.get(parentId)?.level) : 0))
        .map(s => ({ ...s, children: buildChildren(s.record_id) }));
    // Root nodes are depth-1 scopes with no parent
    return active
      .filter(s => scopeDepth(s.level) === 1 && !s.parent_id)
      .map(s => ({ ...s, children: buildChildren(s.record_id) }));
  },

  scopeLevelLabel(level) {
    return levelLabel(level);
  },

  get editingScope() {
    if (!this.editingScopeId) return null;
    return this.scopesMap.get(this.editingScopeId) || null;
  },

  get editingScopeLevelLabel() {
    return this.scopeLevelLabel(this.editingScope?.level || '');
  },

};
