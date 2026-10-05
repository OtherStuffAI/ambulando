import { requestTowerPgContext } from './api.js';
import { isContextAccessDenied } from './context-tree-errors.js';
import { materializeFeedReaderEvent } from './feed/materialize.js';
import { clampBranchEffectiveMessageIds, threadHistoryLineage, mergeThreadHistoryIds, threadHistoryAuthority as pgAuthorityToken } from './thread-history-coverage.js';
import { FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import { normalizeBackendUrl } from './utils/state-helpers.js';
import {
  getTowerPgChannelAudioNotes,
  getTowerPgChannelDocs,
  getTowerPgChannelFiles,
  getTowerPgChannelFileFolders,
  getTowerPgDailyNotes,
  getTowerPgPersonalWapps,
  getTowerPgWappPublishingGrants,
  getTowerPgWappActivityItems,
  getTowerPgWappActivityMutes,
  getTowerPgApprovals,
  getTowerPgDoc,
  getTowerPgDocBody,
  getTowerPgDocComments,
  getTowerPgWorkroom,
  getTowerPgWorkroomEvents,
  getTowerPgWorkroomLinks,
  getTowerPgWorkroomParticipants,
  getTowerPgWorkrooms,
  getTowerPgChannelMessages,
  getTowerPgReactions,
  getTowerPgResponseActivities,
  getTowerPgAgentActivities,
  getTowerPgAgentSessionHealth,
  getTowerPgChannelTasks,
  getTowerPgTask,
  getTowerPgTaskComments,
  getTowerPgChannelThreads,
  getTowerPgThread,
  getTowerPgScopeChannels,
  getTowerPgScopeTasks,
  getTowerPgWorkspaceMembers,
  getTowerPgWorkspaceGroups,
  getTowerPgWorkspaceScopes,
  getTowerPgWorkspaceSync,
  getTowerPgRecordSync,
  getTowerPgService,
  towerPgRecordClient,
  getTowerPgResourceViewStates,
  downloadStorageObject,
} from './api.js';
import {
  getWorkspaceDb,
  replaceAudioNotesForOwner,
  replaceChannelsForOwner,
  replaceDailyNotesForOwner,
  replaceDocumentsForOwner,
  replacePgAudioNotesForChannel,
  replacePgCommentsForTarget,
  getCommentsByTarget,
  replacePgDailyNotesForOwnerAndDate,
  replaceFileFoldersForWorkspace,
  replacePgPersonalWappsForOwner,
  replaceWappPublishingGrants,
  replaceWappActivityItems,
  replaceWappActivityMutes,
  replaceWorkspaceMembers,
  replacePgDocumentsForChannel,
  replacePgFileFoldersForChannel,
  replacePgMessagesForChannel,
  upsertMessage,
  replacePgReactionsForTarget,
  replacePgResponseActivitiesForChannel,
  replacePgResponseActivitiesForTarget,
  replacePgAgentActivitiesForChannel,
  replacePgAgentSessionHealthForChannel,
  getAgentActivitiesForChannel,
  mergeAgentActivityCommentary,
  replacePgTasksForChannel,
  replacePgWorkroomsForChannel,
  replacePgWorkroomsForWorkspace,
  replaceWorkroomApprovalsForRoom,
  replaceWorkroomEventsForRoom,
  replaceWorkroomLinksForRoom,
  replaceWorkroomParticipantsForRoom,
  upsertWorkroom,
  replaceTasksForOwner,
  replaceScopesForOwner,
  upsertChannel,
  upsertPgListedChannel,
  migrateLegacyAutopilotLaunchers,
  upsertScope,
  upsertPgListedScope,
  clearResponseActivity,
  upsertAgentActivity,
  upsertAgentSessionHealth,
  upsertDocument,
  upsertTask,
  upsertComment,
  upsertFileFolder,
  upsertAudioNote,
  upsertDailyNote,
  upsertResourceViewState,
  upsertGroup,
  runWorkspaceSyncTransaction,
  getSyncState,
  setSyncState,
  deleteSyncState,
  deleteTowerPgSyncTombstones,
  reconcileTowerPgSnapshot,
} from './db.js';
import { mapTowerResourceViewState } from './resource-view-state.js';
import { isTerminalAgentActivity, mapPgAgentActivity, mapPgAgentActivityCommentary, mapPgAgentSessionHealth } from './agent-activity.js';
import { recordFamilyHash } from './translators/chat.js';
import { recordFamilyHash as taskFamilyHash } from './translators/tasks.js';

const DOC_COMMENT_HYDRATION_GENERATIONS = new WeakMap();
const MISSING_REACTION_TARGETS = new WeakMap();
const MISSING_REACTION_TARGET_RETRY_MS = 30_000;

function beginDocCommentHydration(store, workspaceId, docId) {
  let generations = DOC_COMMENT_HYDRATION_GENERATIONS.get(store);
  if (!generations) {
    generations = new Map();
    DOC_COMMENT_HYDRATION_GENERATIONS.set(store, generations);
  }
  const key = `${workspaceId}:${docId}`;
  const generation = Number(generations.get(key) || 0) + 1;
  generations.set(key, generation);
  return () => generations.get(key) === generation;
}

function trimText(value) {
  return String(value ?? '').trim();
}

async function readAllTowerPgChannelMessages(readMessages, workspaceId, channelId, options = {}) {
  const messages = [];
  const seenCursors = new Set();
  let cursor = null;

  do {
    const pageOptions = cursor ? { ...options, cursor } : options;
    const result = await readMessages(workspaceId, channelId, pageOptions);
    messages.push(...(Array.isArray(result?.messages) ? result.messages : []));
    const nextCursor = trimText(result?.next_cursor);
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error('Tower PG message pagination returned a repeated cursor');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return messages;
}

async function readAllTowerPgWappActivityItems(readItems, workspaceId, options = {}) {
  const items = [];
  const seenCursors = new Set();
  let cursor = null;

  do {
    const page = await readItems(workspaceId, { ...options, cursor });
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    const nextCursor = trimText(page?.next_cursor);
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error('Tower PG WApp activity pagination returned a repeated cursor');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return items;
}

function isMissingPgReactionTargetError(error) {
  if (!error) return false;
  let payload = error.payload;
  try { payload = JSON.parse(error.responseText); } catch {}
  return (error.status === 404 && (payload?.code || payload?.error) === 'reaction_target_not_found')
    // Tower validates channel existence before checking its permission grants.
    // A 403 permission_denied is deliberately not a stale-target result.
    || (error.status === 400 && payload?.code === 'resource-not-found'
      && payload?.required_permission === 'channel.read');
}

function normalizeTextArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => trimText(entry))
    .filter(Boolean))];
}

function isoTimestamp(value) {
  return trimText(value) || new Date().toISOString();
}

function rowVersion(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function activityVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function currentPgActorId(store = {}) {
  return trimText(
    store?.currentWorkspaceActorId
    || store?.pgActorId
    || store?.currentActorId
    || store?.currentWorkspace?.pgMe?.actor?.actor_id
    || store?.currentWorkspace?.pgMe?.actor?.id
    || store?.currentWorkspace?.pg_me?.actor?.actor_id
    || store?.currentWorkspace?.pg_me?.actor?.id
  );
}

function mapPgResponseActivity(activity = {}) {
  const recordId = trimText(activity.id || activity.record_id);
  if (!recordId) return null;
  return {
    record_id: recordId,
    pg_backend: true,
    workspace_id: trimText(activity.workspace_id),
    scope_id: trimText(activity.scope_id),
    channel_id: trimText(activity.channel_id),
    target_type: trimText(activity.target_type),
    target_id: trimText(activity.target_id),
    thread_id: trimText(activity.thread_id),
    task_id: trimText(activity.task_id),
    doc_id: trimText(activity.doc_id),
    parent_comment_id: trimText(activity.parent_comment_id),
    actor_id: trimText(activity.actor_id),
    actor_npub: trimText(activity.actor_npub),
    activity_type: trimText(activity.activity_type) || 'agent_response',
    status: trimText(activity.status) || 'thinking',
    severity: trimText(activity.severity) || 'info',
    label: trimText(activity.label),
    message: trimText(activity.message),
    pipeline_run_id: trimText(activity.pipeline_run_id),
    source_message_id: trimText(activity.source_message_id),
    metadata: activity.metadata && typeof activity.metadata === 'object' ? activity.metadata : {},
    record_state: trimText(activity.record_state) || (activity.cleared_at ? 'cleared' : 'active'),
    row_version: rowVersion(activity.row_version),
    expires_at: isoTimestamp(activity.expires_at),
    created_at: isoTimestamp(activity.created_at),
    updated_at: isoTimestamp(activity.updated_at),
    cleared_at: trimText(activity.cleared_at),
  };
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || '').trim());
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pgMetadataThreadId(record = {}) {
  const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {};
  return trimText(record?.thread_id || metadata.thread_id || metadata.pg_thread_id) || null;
}

function shouldMaterializeFallbackThread(thread, messageCoverageByThreadId = new Map()) {
  if (!thread) return false;
  const recordState = trimText(thread?.record_state) || (thread?.archived_at ? 'archived' : 'active');
  if (recordState !== 'active') return false;
  const sourceMessageId = trimText(thread?.source_message_id);
  if (!sourceMessageId) return true;
  const threadId = trimText(thread?.id || thread?.record_id);
  if (!threadId) return false;
  const coverage = messageCoverageByThreadId.get(threadId);
  return coverage?.hasMessages === true && coverage.hasRootMessage !== true;
}

export function selectPgFallbackThreads(rawThreads = [], messageRows = []) {
  const messageCoverageByThreadId = new Map();
  for (const message of Array.isArray(messageRows) ? messageRows : []) {
    const threadId = trimText(message?.pg_thread_id);
    if (!threadId) continue;
    const coverage = messageCoverageByThreadId.get(threadId) || {
      hasMessages: false,
      hasRootMessage: false,
    };
    coverage.hasMessages = true;
    if (!trimText(message?.parent_message_id)) coverage.hasRootMessage = true;
    messageCoverageByThreadId.set(threadId, coverage);
  }
  return (Array.isArray(rawThreads) ? rawThreads : [])
    .filter((thread) => shouldMaterializeFallbackThread(thread, messageCoverageByThreadId));
}

function mergePgMessageRowsWithFallbackThreads(messageRows = [], fallbackThreads = [], sourceMessageIds = new Set()) {
  const messageIds = new Set(messageRows.map((message) => trimText(message?.record_id)).filter(Boolean));
  return [
    ...messageRows,
    ...fallbackThreads.filter((thread) => (
      !messageIds.has(trimText(thread?.record_id))
      && !sourceMessageIds.has(trimText(thread?.record_id))
    )),
  ];
}

function resolveActorId(record = {}) {
  return trimText(
    record?.sender_actor_id
    || record?.created_by_actor_id
    || record?.updated_by_actor_id
    || record?.actor_id,
  );
}

function resolveSenderNpub(record = {}, actorNpubByActorId = new Map()) {
  const directSender = trimText(
    record?.sender_npub
    || record?.npub
    || record?.creator?.npub
    || record?.created_by?.npub
    || record?.createdBy?.npub
    || record?.signature_actor?.npub
    || record?.signature_npub
    || record?.creator_npub
    || record?.creatorNpub
    || record?.created_by_npub
    || record?.createdByNpub
    || record?.actor_npub
    || record?.actorNpub
    || record?.actor?.npub
    || record?.sender?.npub
    || record?.senderNpub
    || record?.created_by_actor_npub
    || record?.createdByActorNpub
    || record?.metadata?.sender_npub
    || record?.metadata?.created_by_npub
    || record?.metadata?.actor_npub
    || record?.owner_npub,
  );
  if (directSender) return directSender;
  const actorId = resolveActorId(record);
  if (!actorId) return '';
  return trimText(actorNpubByActorId.get(actorId));
}

function getPgAssignmentActorId(assignment = {}) {
  return trimText(
    assignment?.actor_id
    || assignment?.actorId
    || assignment?.assignee_actor_id
    || assignment?.assigneeActorId
    || assignment?.actor?.actor_id
    || assignment?.actor?.id
    || assignment?.assignee?.actor_id
    || assignment?.assignee?.id
    || assignment?.member?.actor_id
    || assignment?.member?.id,
  );
}

function getPgAssignmentDirectNpub(assignment = {}) {
  return trimText(
    assignment?.actor_npub
    || assignment?.actorNpub
    || assignment?.assignee_npub
    || assignment?.assigneeNpub
    || assignment?.member_npub
    || assignment?.memberNpub
    || assignment?.npub
    || assignment?.actor?.npub
    || assignment?.assignee?.npub
    || assignment?.member?.npub
    || assignment?.user?.npub
    || assignment?.profile?.npub,
  );
}

function normalizePgTaskAssignmentRows(task = {}) {
  if (Array.isArray(task?.assignments)) return task.assignments;
  if (Array.isArray(task?.task_assignments)) return task.task_assignments;
  if (Array.isArray(task?.assigned_actors)) return task.assigned_actors;
  if (Array.isArray(task?.assignees)) return task.assignees;
  return [];
}

function normalizePgTaskAssignmentNpubs(task = {}, actorNpubByActorId = new Map()) {
  const metadata = task?.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
    ? task.metadata
    : {};
  if (Object.prototype.hasOwnProperty.call(task, 'assigned_to_npub') || Object.prototype.hasOwnProperty.call(metadata, 'assigned_to_npub')) {
    const primary = Object.prototype.hasOwnProperty.call(task, 'assigned_to_npub') ? task.assigned_to_npub : metadata.assigned_to_npub;
    return trimText(primary) ? [trimText(primary)] : [];
  }
  const assignments = normalizePgTaskAssignmentRows(task);
  const npubs = [];
  const seen = new Set();
  for (const assignment of assignments) {
    if (assignment.deleted_at || assignment.record_state === 'deleted') continue;
    const npub = getPgAssignmentDirectNpub(assignment)
      || trimText(actorNpubByActorId?.get?.(getPgAssignmentActorId(assignment)));
    if (!npub || seen.has(npub)) continue;
    seen.add(npub);
    npubs.push(npub);
  }
  return npubs.length === 1 ? npubs : [];
}

function normalizeActorEntry(entry = {}) {
  const actor = entry?.actor && typeof entry.actor === 'object' ? entry.actor : entry;
  const actorId = trimText(actor?.actor_id || actor?.id || entry?.actor_id || entry?.id);
  const npub = trimText(actor?.npub || entry?.npub);
  if (!actorId || !npub) return null;
  return [actorId, npub];
}

function mapPgWorkspaceMemberToLocal(entry = {}, context = {}) {
  const actor = entry?.actor && typeof entry.actor === 'object' ? entry.actor : entry;
  const actorId = trimText(actor?.actor_id || actor?.id || entry?.actor_id || entry?.id);
  const npub = trimText(actor?.npub || entry?.npub);
  if (!actorId || !npub) return null;
  return {
    ...actor,
    actor_id: actorId,
    id: actorId,
    npub,
    workspace_id: trimText(context.workspaceId || entry?.workspace_id),
    workspace_owner_npub: trimText(context.workspaceOwnerNpub || entry?.workspace_owner_npub),
    role: trimText(entry?.membership?.role || entry?.role) || 'member',
    joined_at: entry?.membership?.joined_at || entry?.membership?.created_at || entry?.joined_at || null,
  };
}

function resolveActorNpubByActorId(store = {}) {
  return new Map(
    (Array.isArray(store?.pgWorkspaceMembers) ? store.pgWorkspaceMembers : [])
      .map((member) => normalizeActorEntry(member))
      .filter(Boolean),
  );
}

async function resolveActorNpubByActorIdWithFallback(store = {}, deps = {}, context = {}) {
  const actorNpubByActorId = resolveActorNpubByActorId(store);
  if (actorNpubByActorId.size > 0 || !context.workspaceId || !context.baseUrl) {
    return actorNpubByActorId;
  }
  const readWorkspaceMembers = deps.getTowerPgWorkspaceMembers || getTowerPgWorkspaceMembers;
  try {
    const membersResult = await readWorkspaceMembers(context.workspaceId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    const members = Array.isArray(membersResult?.members) ? membersResult.members : [];
    const refreshed = new Map(
      members
        .map((member) => normalizeActorEntry(member))
        .filter(Boolean),
    );
    const memberRows = members.map((member) => mapPgWorkspaceMemberToLocal(member, context)).filter(Boolean);
    assertTowerPgWorkspaceCurrent(store, context);
    if (memberRows.length > 0) await (deps.replaceWorkspaceMembers || replaceWorkspaceMembers)(context.workspaceId, memberRows);
    if (refreshed.size > 0) return new Map([...actorNpubByActorId, ...refreshed]);
  } catch {
    return actorNpubByActorId;
  }
  return actorNpubByActorId;
}

function uniqueNonEmpty(values = []) {
  return [...new Set(values.map((value) => trimText(value)).filter(Boolean))];
}

function descriptorLinks(workspace = {}) {
  const descriptor = workspace.pgDescriptor && typeof workspace.pgDescriptor === 'object'
    ? workspace.pgDescriptor
    : {};
  return descriptor.links && typeof descriptor.links === 'object' ? descriptor.links : {};
}

function assertTowerPgWorkspaceCurrent(store, context) {
  const current = resolveTowerPgWorkspaceContext(store);
  if (current.workspaceId !== context.workspaceId || current.baseUrl !== context.baseUrl
    || current.appNpub !== context.appNpub || current.sessionNpub !== context.sessionNpub
    || current.generation !== context.generation) {
    throw new Error('Workspace changed while loading Tower data');
  }
}

export function resolveTowerPgWorkspaceContext(store = {}) {
  const workspace = store.currentWorkspace || {};
  const descriptor = workspace.pgDescriptor && typeof workspace.pgDescriptor === 'object'
    ? workspace.pgDescriptor
    : {};
  const identity = descriptor.identity && typeof descriptor.identity === 'object'
    ? descriptor.identity
    : {};
  const workspaceId = trimText(workspace.workspaceId || identity.workspace_id || identity.workspaceId);
  const workspaceOwnerNpub = trimText(
    workspace.workspaceOwnerNpub
    || identity.workspace_owner_npub
    || identity.workspaceOwnerNpub
    || store.workspaceOwnerNpub
  );
  const baseUrl = normalizeBackendUrl(workspace.directHttpsUrl || descriptor.tower_base_url || descriptor.towerBaseUrl || store.backendUrl);
  const appNpub = trimText(workspace.appNpub || identity.app_npub || identity.appNpub || FLIGHT_DECK_PG_APP_NPUB);
  return {
    workspace,
    generation: store._workspaceSelectionGeneration || 0,
    sessionNpub: store.session?.npub || '',
    workspaceId,
    workspaceOwnerNpub,
    baseUrl,
    appNpub,
    links: descriptorLinks(workspace),
  };
}

export function mapPgScopeToLocal(scope, { workspaceOwnerNpub } = {}) {
  const recordId = trimText(scope?.id || scope?.record_id);
  const ownerNpub = trimText(workspaceOwnerNpub);
  const updatedAt = isoTimestamp(scope?.updated_at || scope?.created_at);
  const groupId = trimText(scope?.owner_group_id);
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    title: trimText(scope?.name || scope?.title) || 'Untitled scope',
    description: trimText(scope?.description),
    metadata: scope?.metadata && typeof scope.metadata === 'object' && !Array.isArray(scope.metadata)
      ? scope.metadata
      : {},
    default_channel_access_rows: Array.isArray(scope?.default_channel_access_rows)
      ? scope.default_channel_access_rows
      : (Array.isArray(scope?.defaultAccessRows) ? scope.defaultAccessRows : []),
    scope_channel_access_rows: Array.isArray(scope?.scope_channel_access_rows)
      ? scope.scope_channel_access_rows
      : (Array.isArray(scope?.scopeAccessRows) ? scope.scopeAccessRows : []),
    channel_access_rows: Array.isArray(scope?.channel_access_rows)
      ? scope.channel_access_rows
      : (Array.isArray(scope?.channelAccessRows) ? scope.channelAccessRows : []),
    default_channel_grants: Array.isArray(scope?.default_channel_grants)
      ? scope.default_channel_grants
      : (Array.isArray(scope?.defaultChannelGrants) ? scope.defaultChannelGrants : []),
    scope_channel_grants: Array.isArray(scope?.scope_channel_grants)
      ? scope.scope_channel_grants
      : (Array.isArray(scope?.scopeChannelGrants) ? scope.scopeChannelGrants : []),
    level: 'l1',
    parent_id: null,
    l1_id: null,
    l2_id: null,
    l3_id: null,
    l4_id: null,
    l5_id: null,
    group_ids: groupId ? [groupId] : [],
    sync_status: 'synced',
    record_state: 'active',
    version: rowVersion(scope?.row_version || scope?.version),
    created_at: isoTimestamp(scope?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'scope',
    pg_kind: trimText(scope?.kind),
    pg_workspace_id: trimText(scope?.workspace_id),
    ...(typeof scope?.can_manage === 'boolean' ? { pg_can_manage: scope.can_manage } : {}),
  };
}

export function mapPgChannelToLocal(channel, { workspaceOwnerNpub } = {}) {
  const recordId = trimText(channel?.id || channel?.record_id);
  const scopeId = trimText(channel?.scope_id);
  const ownerNpub = trimText(workspaceOwnerNpub);
  const updatedAt = isoTimestamp(channel?.updated_at || channel?.created_at);
  return {
    record_id: recordId,
    owner_npub: ownerNpub,
    title: trimText(channel?.name || channel?.title) || 'Untitled channel',
    description: trimText(channel?.description),
    metadata: channel?.metadata && typeof channel.metadata === 'object' && !Array.isArray(channel.metadata)
      ? channel.metadata
      : {},
    channel_type: trimText(channel?.kind),
    position: Number.isInteger(Number(channel?.position)) && Number(channel.position) >= 1
      ? Number(channel.position)
      : null,
    group_ids: normalizeTextArray(channel?.group_ids || channel?.groupIds),
    participant_npubs: normalizeTextArray(channel?.participant_npubs || channel?.participantNpubs),
    channel_grants: Array.isArray(channel?.channel_grants)
      ? channel.channel_grants
      : (Array.isArray(channel?.grants) ? channel.grants : []),
    member_npubs: normalizeTextArray(channel?.member_npubs || channel?.memberNpubs),
    scope_id: scopeId || null,
    scope_l1_id: scopeId || null,
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    sync_status: 'synced',
    record_state: 'active',
    version: rowVersion(channel?.row_version || channel?.version),
    created_at: isoTimestamp(channel?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'channel',
    pg_kind: trimText(channel?.kind),
    pg_workspace_id: trimText(channel?.workspace_id),
    ...(typeof channel?.can_read === 'boolean' ? { can_read: channel.can_read } : {}),
    ...(typeof channel?.readable === 'boolean' ? { readable: channel.readable } : {}),
  };
}

export function mapPgThreadToLocal(thread, {
  workspaceOwnerNpub,
  senderNpub,
  actorNpubByActorId = new Map(),
} = {}) {
  const recordId = trimText(thread?.id || thread?.record_id);
  const updatedAt = isoTimestamp(thread?.updated_at || thread?.created_at);
  const title = trimText(thread?.title);
  const latest = trimText(thread?.latest);
  return {
    record_id: recordId,
    owner_npub: trimText(workspaceOwnerNpub),
    channel_id: trimText(thread?.channel_id),
    parent_message_id: null,
    title: title || latest || 'Untitled thread',
    body: title || latest || 'Untitled thread',
    attachments: [],
    sender_npub: resolveSenderNpub(thread, actorNpubByActorId)
      || trimText(senderNpub),
    sync_status: 'synced',
    record_state: trimText(thread?.record_state) || (thread?.archived_at ? 'archived' : 'active'),
    version: rowVersion(thread?.row_version || thread?.version),
    created_at: isoTimestamp(thread?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'thread',
    pg_workspace_id: trimText(thread?.workspace_id),
    pg_scope_id: trimText(thread?.scope_id),
    pg_source_message_id: trimText(thread?.source_message_id) || null,
    pg_parent_thread_id: trimText(thread?.parent_thread_id) || null,
    pg_branch_point_message_id: trimText(thread?.branch_point_message_id) || null,
    pg_client_request_id: trimText(thread?.client_request_id) || null,
    pg_metadata: thread?.metadata && typeof thread.metadata === 'object' && !Array.isArray(thread.metadata) ? thread.metadata : {},
    pg_thread_id: recordId || null,
    activity_version: activityVersion(thread?.activity_version),
    pg_archived_at: trimText(thread?.archived_at) || null,
  };
}

export function mapPgMessageToLocal(message, {
  workspaceOwnerNpub,
  senderNpub,
  actorNpubByActorId = new Map(),
  threadById = new Map(),
} = {}) {
  const recordId = trimText(message?.id || message?.record_id);
  const threadId = trimText(message?.thread_id);
  const thread = threadId ? threadById.get(threadId) || null : null;
  const sourceMessageId = trimText(thread?.source_message_id || message?.thread_source_message_id || message?.source_message_id);
  const updatedAt = isoTimestamp(message?.updated_at || message?.created_at);
  const isThreadSourceMessage = Boolean(threadId && sourceMessageId && sourceMessageId === recordId);
  const threadRecordState = trimText(thread?.record_state) || (thread?.archived_at ? 'archived' : '');
  const messageRecordState = trimText(message?.record_state) || (message?.deleted_at ? 'deleted' : 'active');
  const sourceMetadata = message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata
    : {};
  const metadata = Array.isArray(message?.mentions)
    ? { ...sourceMetadata, mentions: message.mentions }
    : sourceMetadata;
  return {
    record_id: recordId,
    owner_npub: trimText(workspaceOwnerNpub),
    channel_id: trimText(message?.channel_id),
    parent_message_id: threadId
      ? (sourceMessageId && sourceMessageId !== recordId ? sourceMessageId : (!sourceMessageId ? threadId : null))
      : null,
    title: isThreadSourceMessage ? (trimText(thread?.title) || trimText(message?.body) || 'Untitled thread') : '',
    body: trimText(message?.body),
    attachments: Array.isArray(message?.attachments) && message.attachments.length > 0
      ? message.attachments
      : (Array.isArray(sourceMetadata.attachments) ? sourceMetadata.attachments : []),
    sender_npub: resolveSenderNpub(message, actorNpubByActorId)
      || trimText(senderNpub),
    sync_status: 'synced',
    record_state: messageRecordState === 'deleted'
      ? 'deleted'
      : (isThreadSourceMessage && threadRecordState ? threadRecordState : messageRecordState),
    version: rowVersion(message?.row_version || message?.version),
    created_at: isoTimestamp(message?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'message',
    pg_workspace_id: trimText(message?.workspace_id),
    pg_scope_id: trimText(message?.scope_id),
    pg_thread_id: threadId || null,
    pg_thread_version: isThreadSourceMessage ? rowVersion(thread?.row_version || thread?.version) : null,
    pg_thread_activity_version: isThreadSourceMessage ? activityVersion(thread?.activity_version) : null,
    pg_archived_at: isThreadSourceMessage ? (trimText(thread?.archived_at) || null) : null,
    pg_created_by_actor_id: trimText(message?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(message?.updated_by_actor_id),
    pg_created_by_actor_npub: trimText(message?.created_by_actor_npub),
    pg_created_by_actor_label: trimText(message?.created_by_actor_label),
    pg_client_record_id: trimText(metadata.client_record_id),
    pg_owning_thread_id: trimText(message?.owning_thread_id || message?.thread_id) || null,
    pg_effective_thread_id: trimText(message?.effective_thread_id) || null,
    pg_inherited: message?.inherited === true,
    read_only: message?.read_only === true || message?.inherited === true,
    pg_metadata: metadata,
  };
}

export function mapPgTaskToLocal(task, {
  workspaceOwnerNpub,
  actorNpubByActorId = new Map(),
} = {}) {
  const scopeId = trimText(task?.scope_id);
  const updatedAt = isoTimestamp(task?.updated_at || task?.created_at);
  const metadata = task?.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
    ? task.metadata
    : {};
  const assignedToNpubs = normalizePgTaskAssignmentNpubs(task, actorNpubByActorId);
  return {
    record_id: trimText(task?.id || task?.record_id),
    pg_attention: task?.attention || null,
    activity_version: activityVersion(task?.activity_version),
    owner_npub: trimText(workspaceOwnerNpub),
    title: trimText(task?.title) || 'Untitled task',
    description: trimText(task?.description),
    state: trimText(task?.state) || 'new',
    priority: trimText(task?.priority) || 'sand',
    board_order: Number.isFinite(Number(metadata.board_order)) ? Number(metadata.board_order) : null,
    parent_task_id: trimText(task?.parent_task_id || metadata.parent_task_id) || null,
    board_group_id: null,
    assigned_to_npubs: assignedToNpubs,
    assigned_to_npub: assignedToNpubs[0] || null,
    scheduled_for: trimText(metadata.scheduled_for) || null,
    tags: typeof metadata.tags === 'string' ? metadata.tags : '',
    scope_id: scopeId || null,
    scope_l1_id: scopeId || null,
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    scope_policy_group_ids: null,
    predecessor_task_ids: Array.isArray(metadata.predecessor_task_ids) ? metadata.predecessor_task_ids : null,
    flow_id: trimText(metadata.flow_id) || null,
    flow_run_id: trimText(metadata.flow_run_id) || null,
    flow_step: trimText(metadata.flow_step) || null,
    source_links: Array.isArray(metadata.source_links) ? metadata.source_links : [],
    references: Array.isArray(metadata.references) ? metadata.references : [],
    deliverable_links: Array.isArray(metadata.deliverable_links) ? metadata.deliverable_links : [],
    shares: [],
    group_ids: [],
    sync_status: 'synced',
    record_state: 'active',
    version: rowVersion(task?.row_version || task?.version),
    created_at: isoTimestamp(task?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'task',
    pg_workspace_id: trimText(task?.workspace_id),
    pg_channel_id: trimText(task?.channel_id),
    pg_thread_id: trimText(task?.thread_id) || null,
    pg_created_by_actor_id: trimText(task?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(task?.updated_by_actor_id),
    pg_created_by_actor_npub: trimText(task?.created_by_actor_npub)
      || trimText(actorNpubByActorId.get(trimText(task?.created_by_actor_id))),
    pg_updated_by_actor_npub: trimText(task?.updated_by_actor_npub)
      || trimText(actorNpubByActorId.get(trimText(task?.updated_by_actor_id))),
    pg_metadata: metadata,
    pg_client_record_id: trimText(metadata.client_record_id),
  };
}

export function mergePgHydratedTasksWithLocal(hydratedTasks = [], localTasks = []) {
  const mergedById = new Map();
  for (const task of Array.isArray(hydratedTasks) ? hydratedTasks : []) {
    if (task?.record_id) mergedById.set(task.record_id, task);
  }

  for (const localTask of Array.isArray(localTasks) ? localTasks : []) {
    const recordId = trimText(localTask?.record_id);
    if (!recordId || localTask?.pg_backend !== true || localTask?.record_state === 'deleted') continue;
    const hydratedTask = mergedById.get(recordId);
    const localSyncStatus = trimText(localTask?.sync_status || 'synced') || 'synced';
    const isLocalPending = localSyncStatus !== 'synced';
    if (!hydratedTask) {
      if (isLocalPending) mergedById.set(recordId, localTask);
      continue;
    }

    const localVersion = Number(localTask.version ?? 0) || 0;
    const hydratedVersion = Number(hydratedTask.version ?? 0) || 0;
    if (localVersion > hydratedVersion || (isLocalPending && localVersion >= hydratedVersion)) {
      mergedById.set(recordId, localTask);
    }
  }

  return [...mergedById.values()];
}

export function mapPgTaskCommentToLocal(comment, {
  workspaceOwnerNpub,
  senderNpub,
  actorNpubByActorId = new Map(),
} = {}) {
  const updatedAt = isoTimestamp(comment?.updated_at || comment?.created_at);
  const metadata = comment?.metadata && typeof comment.metadata === 'object' && !Array.isArray(comment.metadata)
    ? comment.metadata
    : {};
  return {
    record_id: trimText(comment?.id || comment?.record_id),
    owner_npub: trimText(workspaceOwnerNpub),
    target_record_id: trimText(comment?.task_id || comment?.target_record_id),
    target_record_family_hash: taskFamilyHash('task'),
    parent_comment_id: null,
    body: trimText(comment?.body),
    attachments: [],
    sender_npub: resolveSenderNpub(comment, actorNpubByActorId)
      || trimText(senderNpub),
    sync_status: 'synced',
    record_state: 'active',
    version: rowVersion(comment?.row_version || comment?.version),
    created_at: isoTimestamp(comment?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'task_comment',
    pg_workspace_id: trimText(comment?.workspace_id),
    pg_scope_id: trimText(comment?.scope_id),
    pg_channel_id: trimText(comment?.channel_id),
    pg_thread_id: trimText(comment?.thread_id) || null,
    pg_created_by_actor_id: trimText(comment?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(comment?.updated_by_actor_id),
    pg_created_by_actor_npub: trimText(comment?.created_by_actor_npub)
      || trimText(actorNpubByActorId.get(trimText(comment?.created_by_actor_id))),
    pg_updated_by_actor_npub: trimText(comment?.updated_by_actor_npub)
      || trimText(actorNpubByActorId.get(trimText(comment?.updated_by_actor_id))),
    pg_client_record_id: trimText(metadata.client_record_id),
    pg_metadata: metadata,
  };
}

export function mapPgDocCommentToLocal(comment, {
  workspaceOwnerNpub,
  senderNpub,
  actorNpubByActorId = new Map(),
} = {}) {
  const updatedAt = isoTimestamp(comment?.updated_at || comment?.created_at);
  const sourceMetadata = comment?.metadata && typeof comment.metadata === 'object' && !Array.isArray(comment.metadata)
    ? comment.metadata
    : {};
  const metadata = Array.isArray(comment?.mentions)
    ? { ...sourceMetadata, mentions: comment.mentions }
    : sourceMetadata;
  const anchorLine = Number(metadata.anchor_line_number);
  const anchorEndLine = Number(metadata.anchor_end_line_number);
  const anchorStartOffset = Number(metadata.anchor_start_offset);
  const anchorEndOffset = Number(metadata.anchor_end_offset);
  return {
    record_id: trimText(comment?.id || comment?.record_id),
    owner_npub: trimText(workspaceOwnerNpub),
    target_record_id: trimText(comment?.doc_id || comment?.target_record_id),
    target_record_family_hash: recordFamilyHash('document'),
    parent_comment_id: trimText(comment?.parent_comment_id) || null,
    anchor_block_id: trimText(metadata.anchor_block_id) || null,
    anchor_line_number: Number.isFinite(anchorLine) && anchorLine > 0 ? anchorLine : null,
    anchor_end_line_number: Number.isFinite(anchorEndLine) && anchorEndLine > 0 ? anchorEndLine : null,
    anchor_quote: typeof metadata.anchor_quote === 'string' ? metadata.anchor_quote : '',
    anchor_start_offset: Number.isFinite(anchorStartOffset) && anchorStartOffset >= 0 ? anchorStartOffset : null,
    anchor_end_offset: Number.isFinite(anchorEndOffset) && anchorEndOffset >= 0 ? anchorEndOffset : null,
    comment_status: trimText(metadata.comment_status) || 'open',
    body: trimText(comment?.body),
    attachments: [],
    sender_npub: resolveSenderNpub(comment, actorNpubByActorId)
      || trimText(senderNpub),
    sync_status: 'synced',
    record_state: 'active',
    version: rowVersion(comment?.row_version || comment?.version),
    created_at: isoTimestamp(comment?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'doc_comment',
    pg_workspace_id: trimText(comment?.workspace_id),
    pg_scope_id: trimText(comment?.scope_id),
    pg_channel_id: trimText(comment?.channel_id),
    pg_created_by_actor_id: trimText(comment?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(comment?.updated_by_actor_id),
    pg_client_record_id: trimText(metadata.client_record_id),
    pg_metadata: metadata,
  };
}

export function mapPgDocToLocal(doc, { workspaceOwnerNpub } = {}) {
  const scopeId = trimText(doc?.scope_id);
  const updatedAt = isoTimestamp(doc?.updated_at || doc?.created_at);
  const storageObjectId = trimText(doc?.storage_object_id || doc?.body?.object_id);
  const storageObject = doc?.body?.storage_object && typeof doc.body.storage_object === 'object'
    ? doc.body.storage_object
    : {};
  const sourceMetadata = doc?.metadata && typeof doc.metadata === 'object' && !Array.isArray(doc.metadata)
    ? doc.metadata
    : {};
  const metadata = Array.isArray(doc?.mentions)
    ? { ...sourceMetadata, mentions: doc.mentions }
    : sourceMetadata;
  const recordId = trimText(doc?.id || doc?.record_id);
  const canonicalVersion = doc?.canonical_version && typeof doc.canonical_version === 'object'
    ? doc.canonical_version
    : {};
  const canonicalRowVersion = rowVersion(canonicalVersion.row_version || doc?.row_version || doc?.version);
  return {
    record_id: recordId,
    pg_attention: doc?.attention || null,
    activity_version: activityVersion(doc?.activity_version),
    owner_npub: trimText(workspaceOwnerNpub),
    title: trimText(doc?.title) || 'Untitled document',
    content: trimText(doc?.summary),
    content_format: null,
    content_blocks: [],
    editor_state: null,
    editor_state_format: null,
    editor_state_version: null,
    content_storage_object_id: storageObjectId || null,
    content_storage_format: storageObjectId ? 'flightdeck_pg_doc_body' : null,
    content_storage_content_type: trimText(storageObject.content_type),
    content_size_bytes: Number.isFinite(Number(storageObject.size_bytes)) ? Number(storageObject.size_bytes) : null,
    content_sha256_hex: trimText(canonicalVersion.body_sha256_hex || storageObject.sha256_hex),
    content_storage_status: storageObjectId ? 'remote' : null,
    content_storage_error: null,
    parent_directory_id: null,
    scope_id: scopeId || null,
    scope_l1_id: scopeId || null,
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    scope_policy_group_ids: null,
    source_links: [],
    references: [],
    deliverable_links: [],
    shares: [],
    group_ids: [],
    sync_status: 'synced',
    record_state: doc?.archived_at || doc?.record_state === 'archived' ? 'archived' : 'active',
    archived_at: doc?.archived_at ? isoTimestamp(doc.archived_at) : null,
    version: canonicalRowVersion,
    created_at: isoTimestamp(doc?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'doc',
    pg_workspace_id: trimText(doc?.workspace_id),
    pg_channel_id: trimText(doc?.channel_id),
    pg_thread_id: pgMetadataThreadId(doc),
    pg_body_route: trimText(doc?.body?.route),
    pg_created_by_actor_id: trimText(doc?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(doc?.updated_by_actor_id),
    pg_canonical_version_id: trimText(canonicalVersion.version_id) || (recordId && canonicalRowVersion ? `${recordId}:${canonicalRowVersion}` : null),
    pg_canonical_storage_object_id: trimText(canonicalVersion.storage_object_id || storageObjectId) || null,
    pg_canonical_body_sha256_hex: trimText(canonicalVersion.body_sha256_hex || storageObject.sha256_hex) || null,
    pg_canonical_size_bytes: Number.isFinite(Number(canonicalVersion.size_bytes))
      ? Number(canonicalVersion.size_bytes)
      : (Number.isFinite(Number(storageObject.size_bytes)) ? Number(storageObject.size_bytes) : null),
    pg_metadata: metadata,
  };
}

function resolveStoredDocumentContent(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw);
    const model = parsed?.content_model && typeof parsed.content_model === 'object'
      ? parsed.content_model
      : parsed;
    if (typeof model?.content === 'string') {
      return {
        content: model.content,
        content_format: model.content_format ?? fallback.content_format ?? null,
        content_blocks: Array.isArray(model.content_blocks)
          ? model.content_blocks
          : (Array.isArray(fallback.content_blocks) ? fallback.content_blocks : []),
        editor_state: model.editor_state && typeof model.editor_state === 'object'
          ? model.editor_state
          : (fallback.editor_state || null),
        editor_state_format: model.editor_state_format ?? fallback.editor_state_format ?? null,
        editor_state_version: model.editor_state_version ?? fallback.editor_state_version ?? null,
      };
    }
  } catch {
    // Older PG agent helpers wrote raw Markdown. Treat it as the document body.
  }
  return {
    content: raw,
    content_format: fallback.content_format ?? null,
    content_blocks: Array.isArray(fallback.content_blocks) ? fallback.content_blocks : [],
    editor_state: fallback.editor_state || null,
    editor_state_format: fallback.editor_state_format ?? null,
    editor_state_version: fallback.editor_state_version ?? null,
  };
}

async function hydratePgDocStorageContent(row, deps = {}) {
  const objectId = trimText(row?.content_storage_object_id);
  if (!objectId || row?.pg_record_type !== 'doc') return row;
  const readStorageObject = deps.downloadStorageObject || downloadStorageObject;
  try {
    const bytes = await readStorageObject(objectId);
    const raw = new TextDecoder().decode(bytes);
    const resolved = resolveStoredDocumentContent(raw, row);
    return {
      ...row,
      ...resolved,
      content_storage_status: 'loaded',
      content_storage_error: null,
    };
  } catch (error) {
    return {
      ...row,
      content_storage_status: 'error',
      content_storage_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function hydratePgDocStorageContents(rows, deps = {}) {
  return Promise.all((Array.isArray(rows) ? rows : []).map((row) => hydratePgDocStorageContent(row, deps)));
}

async function hydratePgDocBodyContent(row, bodyResult = null) {
  const encoded = trimText(bodyResult?.body?.base64_data);
  if (!encoded) return hydratePgDocStorageContent(row);
  try {
    const raw = new TextDecoder().decode(base64ToBytes(encoded));
    const resolved = resolveStoredDocumentContent(raw, row);
    return {
      ...row,
      ...resolved,
      content_storage_status: 'loaded',
      content_storage_error: null,
      content_storage_object_id: trimText(bodyResult?.body?.object_id) || row.content_storage_object_id,
      content_storage_content_type: trimText(bodyResult?.body?.content_type) || row.content_storage_content_type,
      content_size_bytes: Number.isFinite(Number(bodyResult?.body?.size_bytes))
        ? Number(bodyResult.body.size_bytes)
        : row.content_size_bytes,
      content_sha256_hex: trimText(bodyResult?.body?.sha256_hex) || row.content_sha256_hex,
    };
  } catch (error) {
    return {
      ...row,
      content_storage_status: 'error',
      content_storage_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mapPgFileToLocalDocument(file, { workspaceOwnerNpub } = {}) {
  const scopeId = trimText(file?.scope_id);
  const updatedAt = isoTimestamp(file?.updated_at || file?.created_at);
  const storageObjectId = trimText(file?.storage_object_id || file?.object?.object_id);
  const displayName = trimText(file?.display_name || file?.object?.storage_object?.file_name) || 'File';
  const storageObject = file?.object?.storage_object && typeof file.object.storage_object === 'object'
    ? file.object.storage_object
    : {};
  return {
    record_id: trimText(file?.id || file?.record_id),
    owner_npub: trimText(workspaceOwnerNpub),
    title: displayName,
    content: storageObjectId ? `[${displayName}](storage://${storageObjectId})` : trimText(file?.description),
    content_format: null,
    content_blocks: [],
    content_storage_object_id: null,
    content_storage_format: null,
    content_storage_content_type: trimText(storageObject.content_type),
    content_size_bytes: Number.isFinite(Number(storageObject.size_bytes)) ? Number(storageObject.size_bytes) : null,
    content_sha256_hex: trimText(storageObject.sha256_hex),
    content_storage_status: storageObjectId ? 'remote' : null,
    content_storage_error: null,
    parent_directory_id: null,
    scope_id: scopeId || null,
    scope_l1_id: scopeId || null,
    scope_l2_id: null,
    scope_l3_id: null,
    scope_l4_id: null,
    scope_l5_id: null,
    scope_policy_group_ids: null,
    source_links: [],
    references: [],
    deliverable_links: [],
    shares: [],
    group_ids: [],
    sync_status: 'synced',
    record_state: file?.archived_at || file?.record_state === 'archived' ? 'archived' : 'active',
    archived_at: file?.archived_at ? isoTimestamp(file.archived_at) : null,
    version: rowVersion(file?.row_version || file?.version),
    created_at: isoTimestamp(file?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'file',
    pg_workspace_id: trimText(file?.workspace_id),
    pg_channel_id: trimText(file?.channel_id),
    pg_thread_id: pgMetadataThreadId(file),
    pg_task_id: trimText(file?.task_id || file?.metadata?.task_id || file?.metadata?.pg_task_id) || null,
    pg_folder_id: trimText(file?.folder_id),
    pg_storage_object_id: storageObjectId || null,
    pg_object_route: trimText(file?.object?.route),
    pg_created_by_actor_id: trimText(file?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(file?.updated_by_actor_id),
  };
}

export function mapPgFileFolderToLocal(folder) {
  return {
    record_id: trimText(folder?.id || folder?.record_id),
    workspace_id: trimText(folder?.workspace_id),
    scope_id: trimText(folder?.scope_id),
    channel_id: trimText(folder?.channel_id),
    parent_folder_id: trimText(folder?.parent_folder_id),
    title: trimText(folder?.title) || 'Untitled folder',
    metadata: folder?.metadata && typeof folder.metadata === 'object' && !Array.isArray(folder.metadata)
      ? folder.metadata
      : {},
    version: rowVersion(folder?.row_version || folder?.version),
    created_at: isoTimestamp(folder?.created_at || folder?.updated_at),
    updated_at: isoTimestamp(folder?.updated_at || folder?.created_at),
    record_state: 'active',
  };
}

function pgAudioTargetFamily(targetType) {
  const normalized = trimText(targetType);
  if (normalized === 'message') return recordFamilyHash('chat_message');
  if (normalized === 'task') return recordFamilyHash('task');
  if (normalized === 'doc') return recordFamilyHash('document');
  if (normalized === 'file') return recordFamilyHash('document');
  if (normalized === 'task_comment') return recordFamilyHash('comment');
  if (normalized === 'audio_note') return recordFamilyHash('audio_note');
  return null;
}

export function mapPgAudioNoteToLocal(audioNote, {
  workspaceOwnerNpub,
  senderNpub,
  actorNpubByActorId = new Map(),
} = {}) {
  const updatedAt = isoTimestamp(audioNote?.updated_at || audioNote?.created_at);
  const targetType = trimText(audioNote?.target_type);
  return {
    record_id: trimText(audioNote?.id || audioNote?.record_id),
    owner_npub: trimText(workspaceOwnerNpub),
    target_record_id: trimText(audioNote?.target_id) || null,
    target_record_family_hash: pgAudioTargetFamily(targetType),
    title: trimText(audioNote?.title) || 'Voice note',
    storage_object_id: trimText(audioNote?.storage_object_id || audioNote?.media?.object_id) || null,
    mime_type: trimText(audioNote?.mime_type) || 'audio/webm;codecs=opus',
    duration_seconds: Number.isFinite(Number(audioNote?.duration_seconds)) ? Number(audioNote.duration_seconds) : null,
    size_bytes: Number.isFinite(Number(audioNote?.size_bytes)) ? Number(audioNote.size_bytes) : 0,
    media_encryption: audioNote?.media_encryption || null,
    waveform_preview: Array.isArray(audioNote?.waveform_preview) ? audioNote.waveform_preview : [],
    transcript_status: trimText(audioNote?.transcript_status) || 'not_requested',
    transcript_preview: trimText(audioNote?.transcript_preview) || null,
    transcript: trimText(audioNote?.transcript) || null,
    summary: trimText(audioNote?.summary) || null,
    sender_npub: resolveSenderNpub(audioNote, actorNpubByActorId)
      || trimText(senderNpub),
    group_ids: [],
    sync_status: 'synced',
    record_state: trimText(audioNote?.record_state) || 'active',
    version: rowVersion(audioNote?.row_version || audioNote?.version),
    created_at: isoTimestamp(audioNote?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'audio_note',
    pg_workspace_id: trimText(audioNote?.workspace_id),
    pg_channel_id: trimText(audioNote?.channel_id),
    pg_thread_id: trimText(audioNote?.thread_id) || null,
    pg_media_route: trimText(audioNote?.media?.route),
    pg_created_by_actor_id: trimText(audioNote?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(audioNote?.updated_by_actor_id),
  };
}

export function mapPgDailyNoteToLocal(note, { workspaceOwnerNpub } = {}) {
  const ownerActorNpub = trimText(note?.owner_actor_npub || note?.owner_npub);
  return {
    record_id: trimText(note?.id),
    owner_npub: ownerActorNpub || trimText(workspaceOwnerNpub),
    owner_actor_id: trimText(note?.owner_actor_id),
    owner_actor_npub: ownerActorNpub,
    note_date: trimText(note?.note_date),
    title: trimText(note?.title) || 'Daily note',
    body: trimText(note?.body),
    focus: trimText(note?.focus),
    items: Array.isArray(note?.items) ? note.items : [],
    status: trimText(note?.status) || 'active',
    metadata: note?.metadata && typeof note.metadata === 'object' && !Array.isArray(note.metadata) ? note.metadata : {},
    sync_status: 'synced',
    record_state: note?.deleted_at ? 'deleted' : 'active',
    version: rowVersion(note?.row_version || note?.version),
    created_at: isoTimestamp(note?.created_at),
    updated_at: isoTimestamp(note?.updated_at),
    pg_backend: true,
    pg_record_type: 'daily_note',
    pg_workspace_id: trimText(note?.workspace_id),
    pg_owner_actor_id: trimText(note?.owner_actor_id),
    pg_scope_id: trimText(note?.scope_id),
    pg_channel_id: trimText(note?.channel_id),
    pg_created_by_actor_id: trimText(note?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(note?.updated_by_actor_id),
    updated_by_actor_id: trimText(note?.updated_by_actor_id),
    updated_by_actor_npub: trimText(note?.updated_by_actor_npub),
  };
}

export function mapPgPersonalWappToLocal(wapp, { workspaceOwnerNpub } = {}) {
  const ownerActorNpub = trimText(wapp?.owner_actor_npub || wapp?.owner_npub);
  const updatedAt = isoTimestamp(wapp?.updated_at);
  const status = trimText(wapp?.status || wapp?.record_state) || 'active';
  return {
    record_id: trimText(wapp?.id || wapp?.record_id),
    owner_npub: ownerActorNpub || trimText(workspaceOwnerNpub),
    workspace_owner_npub: trimText(workspaceOwnerNpub),
    owner_actor_id: trimText(wapp?.owner_actor_id),
    owner_actor_npub: ownerActorNpub,
    title: trimText(wapp?.title) || 'Untitled WApp',
    description: trimText(wapp?.description),
    launch_url: trimText(wapp?.launch_url),
    icon_url: trimText(wapp?.icon_url),
    app_id: trimText(wapp?.app_id),
    wapp_id: trimText(wapp?.wapp_id || wapp?.id || wapp?.record_id),
    source_wingman_url: trimText(wapp?.source_wingman_url),
    scope_id: trimText(wapp?.scope_id),
    channel_id: trimText(wapp?.channel_id),
    sort_order: Number.isFinite(Number(wapp?.sort_order)) ? Number(wapp.sort_order) : 0,
    status,
    record_state: status,
    metadata: wapp?.metadata && typeof wapp.metadata === 'object' && !Array.isArray(wapp.metadata) ? wapp.metadata : {},
    group_ids: [],
    sync_status: 'synced',
    version: rowVersion(wapp?.row_version || wapp?.version),
    created_at: isoTimestamp(wapp?.created_at || updatedAt),
    updated_at: updatedAt,
    pg_backend: true,
    pg_record_type: 'personal_wapp',
    pg_workspace_id: trimText(wapp?.workspace_id),
    pg_owner_actor_id: trimText(wapp?.owner_actor_id),
    pg_scope_id: trimText(wapp?.scope_id),
    pg_channel_id: trimText(wapp?.channel_id),
    pg_created_by_actor_id: trimText(wapp?.created_by_actor_id),
    pg_updated_by_actor_id: trimText(wapp?.updated_by_actor_id),
    updated_by_actor_id: trimText(wapp?.updated_by_actor_id),
    updated_by_actor_npub: trimText(wapp?.updated_by_actor_npub),
  };
}

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => trimText(value))
    .filter(Boolean))];
}

function normalizeWappPublishingDestinations(destinations) {
  const rows = [];
  for (const destination of (Array.isArray(destinations) ? destinations : [])) {
    const scopeId = trimText(destination?.scope_id || destination?.scopeId);
    const channelIds = Array.isArray(destination?.channel_ids)
      ? destination.channel_ids
      : [destination?.channel_id || destination?.channelId];
    for (const channelIdValue of channelIds) {
      const channelId = trimText(channelIdValue);
      if (!scopeId || !channelId) continue;
      rows.push({
        scope_id: scopeId,
        channel_id: channelId,
        scope_title: trimText(destination?.scope_title || destination?.scope_name),
        channel_title: trimText(destination?.channel_title || destination?.channel_name),
      });
    }
  }
  return [...new Map(rows.map((row) => [`${row.scope_id}:${row.channel_id}`, row])).values()];
}

export function mapPgWappPublishingGrantToLocal(input) {
  const grant = input?.grant && typeof input.grant === 'object' ? input.grant : input || {};
  const installation = input?.installation && typeof input.installation === 'object' ? input.installation : {};
  const source = { ...installation, ...grant };
  const wappInstallationId = trimText(source.wapp_installation_id || source.installation_id || source.id);
  return {
    ...source,
    wapp_installation_id: wappInstallationId,
    grant_id: trimText(source.grant_id || (grant !== input ? grant.id : '')),
    app_id: trimText(source.app_id),
    publisher_npub: trimText(source.publisher_npub),
    flightdeck_app_npub: trimText(source.flightdeck_app_npub),
    owner_npub: trimText(source.owner_npub),
    display_name: trimText(source.display_name || source.title || source.app_id) || 'WApp installation',
    capabilities: normalizeStringList(source.capabilities),
    destinations: normalizeWappPublishingDestinations(source.destinations),
    registered_open_origins: normalizeStringList(source.registered_open_origins),
    grant_version: Number(source.grant_version || source.version || 0),
    status: trimText(source.status || source.grant_status) || 'unconfigured',
    last_successful_publication_at: source.last_successful_publication_at || source.last_published_at || source.last_publication_at || source.last_success_at || null,
    last_rejected_publication_at: source.last_rejected_publication_at || source.last_rejected_at || source.last_rejection_at || null,
    last_rejection_reason: trimText(source.last_rejection_reason || source.last_rejection_code || source.last_rejection?.reason || source.last_rejection?.code),
    disable_open_links: source.disable_open_links === true,
    created_at: source.created_at || null,
    updated_at: source.updated_at || source.created_at || null,
    pg_backend: true,
    pg_record_type: 'wapp_publishing_grant',
  };
}

export function mapPgWappActivityItemToLocal(input) {
  const item = input?.item && typeof input.item === 'object' ? input.item : input || {};
  const readAt = item.read_at || item.user_state?.read_at || null;
  const dismissedAt = item.dismissed_at || item.user_state?.dismissed_at || null;
  const state = trimText(item.state) || 'active';
  return {
    ...item,
    record_id: trimText(item.id || item.record_id),
    workspace_id: trimText(item.workspace_id),
    wapp_installation_id: trimText(item.wapp_installation_id || item.installation_id),
    publisher_npub: trimText(item.publisher_npub),
    source_name: trimText(item.display_name || item.source_name || item.wapp_name || item.app_id) || 'WApp',
    category: trimText(item.category) || 'update',
    title: trimText(item.title) || 'WApp update',
    summary: trimText(item.summary),
    scope_id: trimText(item.scope_id),
    channel_id: trimText(item.channel_id),
    scope_title: trimText(item.scope_title || item.scope_name),
    channel_title: trimText(item.channel_title || item.channel_name),
    priority: trimText(item.priority) || 'normal',
    state,
    version: Number(item.version || 1),
    open_url: trimText(item.open_url),
    registered_open_origins: normalizeStringList(item.registered_open_origins || item.approved_open_origins),
    grant_status: trimText(item.grant_status || item.source_status),
    open_url_allowed: item.open_url_allowed === true,
    open_links_disabled: item.open_links_disabled === true,
    read_at: readAt,
    dismissed_at: dismissedAt,
    unread: typeof item.unread === 'boolean' ? item.unread : !readAt,
    muted: item.muted === true,
    occurred_at: item.occurred_at || item.created_at || null,
    updated_at: item.updated_at || item.occurred_at || item.created_at || null,
    withdrawn_at: item.withdrawn_at || (state === 'withdrawn' ? item.updated_at || null : null),
    resolved_at: item.resolved_at || (state === 'resolved' ? item.updated_at || null : null),
    pg_backend: true,
    pg_record_type: 'wapp_activity_item',
  };
}

export function mapPgWappActivityMuteToLocal(input) {
  const mute = input?.mute && typeof input.mute === 'object' ? input.mute : input || {};
  const targetType = trimText(mute.target_type || mute.targetType);
  const targetValue = trimText(mute.target_value || mute.targetValue);
  return {
    ...mute,
    record_id: trimText(mute.id || mute.record_id) || `${targetType}:${targetValue}`,
    target_type: targetType,
    target_value: targetValue,
    created_at: mute.created_at || null,
    updated_at: mute.updated_at || mute.created_at || null,
    pg_backend: true,
    pg_record_type: 'wapp_activity_mute',
  };
}

export function mapPgReactionToLocal(reaction, {
  workspaceOwnerNpub,
  targetType,
  targetId,
} = {}) {
  const now = new Date().toISOString();
  const resolvedTargetType = trimText(targetType || reaction?.target_type);
  return {
    record_id: trimText(reaction?.id || reaction?.record_id),
    owner_npub: trimText(workspaceOwnerNpub),
    target_record_id: trimText(targetId || reaction?.target_id),
    target_record_family_hash: pgAudioTargetFamily(resolvedTargetType),
    emoji: trimText(reaction?.emoji),
    emoji_shortcode: trimText(reaction?.emoji_shortcode),
    reactor_npub: trimText(reaction?.reactor_npub || reaction?.reactor_actor_id),
    sender_npub: trimText(reaction?.reactor_npub || reaction?.reactor_actor_id),
    record_state: trimText(reaction?.record_state) || 'active',
    version: rowVersion(reaction?.row_version || reaction?.version),
    created_at: isoTimestamp(reaction?.created_at || reaction?.updated_at || now),
    updated_at: isoTimestamp(reaction?.updated_at || reaction?.created_at || now),
    pg_backend: true,
    pg_record_type: 'reaction',
    pg_workspace_id: trimText(reaction?.workspace_id),
    pg_channel_id: trimText(reaction?.channel_id),
    pg_thread_id: trimText(reaction?.thread_id) || null,
  };
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function mapPgWorkroomToLocal(workroom) {
  const updatedAt = isoTimestamp(workroom?.updated_at || workroom?.created_at);
  const recordId = trimText(workroom?.id || workroom?.record_id);
  const metadata = objectOrEmpty(workroom?.metadata);
  return {
    record_id: recordId,
    workspace_id: trimText(workroom?.workspace_id),
    scope_id: trimText(workroom?.scope_id),
    channel_id: trimText(workroom?.channel_id),
    title: trimText(workroom?.title) || 'Untitled workroom',
    goal: trimText(workroom?.goal),
    status: trimText(workroom?.status) || 'draft',
    integration_autopilot_npub: trimText(workroom?.integration_autopilot_npub),
    repo: objectOrEmpty(workroom?.repo),
    branches: objectOrEmpty(workroom?.branches),
    app_targets: objectOrEmpty(workroom?.app_targets),
    approval_policy: objectOrEmpty(workroom?.approval_policy),
    archive_policy: objectOrEmpty(workroom?.archive_policy),
    metadata,
    announcement_message_id: trimText(workroom?.announcement_message_id || metadata.announcement_message_id),
    announcement_thread_id: trimText(workroom?.announcement_thread_id || metadata.announcement_thread_id),
    announcement_channel_id: trimText(workroom?.announcement_channel_id || metadata.announcement_channel_id || workroom?.channel_id),
    announcement_link: trimText(workroom?.announcement_link || metadata.announcement_link),
    created_by_actor_id: trimText(workroom?.created_by_actor_id),
    updated_by_actor_id: trimText(workroom?.updated_by_actor_id),
    row_version: rowVersion(workroom?.row_version || workroom?.version),
    version: rowVersion(workroom?.row_version || workroom?.version),
    created_at: isoTimestamp(workroom?.created_at || updatedAt),
    updated_at: updatedAt,
    completed_at: trimText(workroom?.completed_at),
    archived_at: trimText(workroom?.archived_at),
    deleted_at: trimText(workroom?.deleted_at),
    record_state: trimText(workroom?.deleted_at) ? 'deleted' : (trimText(workroom?.status) || 'draft'),
    pg_backend: true,
    pg_record_type: 'workroom',
  };
}

export function mapPgWorkroomParticipantToLocal(participant) {
  const updatedAt = isoTimestamp(participant?.updated_at || participant?.created_at);
  return {
    record_id: trimText(participant?.id || participant?.record_id),
    workspace_id: trimText(participant?.workspace_id),
    workroom_id: trimText(participant?.workroom_id),
    actor_npub: trimText(participant?.actor_npub),
    actor_id: trimText(participant?.actor_id),
    kind: trimText(participant?.kind) || 'human',
    role: trimText(participant?.role) || 'contributor',
    label: trimText(participant?.label),
    status: trimText(participant?.status) || 'active',
    access_status: trimText(participant?.access_status) || 'pending',
    access_issue: trimText(participant?.access_issue),
    metadata: objectOrEmpty(participant?.metadata),
    created_at: isoTimestamp(participant?.created_at || updatedAt),
    updated_at: updatedAt,
    record_state: trimText(participant?.status) === 'removed' ? 'deleted' : 'active',
    pg_backend: true,
    pg_record_type: 'workroom_participant',
  };
}

export function mapPgWorkroomEventToLocal(event) {
  return {
    record_id: trimText(event?.id || event?.record_id),
    workspace_id: trimText(event?.workspace_id),
    workroom_id: trimText(event?.workroom_id),
    scope_id: trimText(event?.scope_id),
    channel_id: trimText(event?.channel_id),
    event_type: trimText(event?.event_type) || 'note',
    actor_npub: trimText(event?.actor_npub),
    actor_id: trimText(event?.actor_id),
    target_type: trimText(event?.target_type),
    target_ref: trimText(event?.target_ref),
    title: trimText(event?.title),
    body: trimText(event?.body),
    payload: objectOrEmpty(event?.payload),
    visibility: trimText(event?.visibility) || 'room',
    created_at: isoTimestamp(event?.created_at),
    record_state: 'active',
    pg_backend: true,
    pg_record_type: 'workroom_event',
  };
}

export function mapPgWorkroomLinkToLocal(link) {
  const updatedAt = isoTimestamp(link?.updated_at || link?.created_at);
  return {
    record_id: trimText(link?.id || link?.record_id),
    workspace_id: trimText(link?.workspace_id),
    workroom_id: trimText(link?.workroom_id),
    scope_id: trimText(link?.scope_id),
    channel_id: trimText(link?.channel_id),
    link_type: trimText(link?.link_type),
    target_type: trimText(link?.target_type),
    target_id: trimText(link?.target_id),
    external_url: trimText(link?.external_url),
    label: trimText(link?.label),
    status: trimText(link?.status),
    metadata: objectOrEmpty(link?.metadata),
    created_by_actor_id: trimText(link?.created_by_actor_id),
    created_at: isoTimestamp(link?.created_at || updatedAt),
    updated_at: updatedAt,
    record_state: 'active',
    pg_backend: true,
    pg_record_type: 'workroom_link',
  };
}

export function mapPgWorkroomApprovalToLocal(approval) {
  const updatedAt = isoTimestamp(approval?.updated_at || approval?.created_at || approval?.requested_at);
  return {
    record_id: trimText(approval?.id || approval?.record_id),
    workspace_id: trimText(approval?.workspace_id),
    scope_id: trimText(approval?.scope_id),
    channel_id: trimText(approval?.channel_id),
    target_type: trimText(approval?.target_type),
    target_id: trimText(approval?.target_id),
    action: trimText(approval?.action),
    status: trimText(approval?.status) || 'requested',
    title: trimText(approval?.title),
    summary: trimText(approval?.summary),
    requested_by_actor_id: trimText(approval?.requested_by_actor_id),
    requested_by_npub: trimText(approval?.requested_by_npub),
    reviewer_actor_id: trimText(approval?.reviewer_actor_id),
    reviewer_npub: trimText(approval?.reviewer_npub),
    approver_actor_id: trimText(approval?.approver_actor_id),
    approver_npub: trimText(approval?.approver_npub),
    decision_note: trimText(approval?.decision_note),
    metadata: objectOrEmpty(approval?.metadata),
    row_version: rowVersion(approval?.row_version || approval?.version),
    version: rowVersion(approval?.row_version || approval?.version),
    requested_at: isoTimestamp(approval?.requested_at || updatedAt),
    reviewed_at: trimText(approval?.reviewed_at),
    approved_at: trimText(approval?.approved_at),
    rejected_at: trimText(approval?.rejected_at),
    superseded_at: trimText(approval?.superseded_at),
    cancelled_at: trimText(approval?.cancelled_at),
    created_at: isoTimestamp(approval?.created_at || updatedAt),
    updated_at: updatedAt,
    record_state: ['superseded', 'cancelled'].includes(trimText(approval?.status)) ? 'archived' : 'active',
    pg_backend: true,
    pg_record_type: 'workroom_approval',
  };
}

export function towerPgSyncCursorKey(store = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const viewerNpub = trimText(store?.session?.npub);
  return `tower_pg_sync_cursor:${context.workspaceId || 'unknown'}:${viewerNpub || 'unknown'}`;
}

function mapPgSyncGroup(group = {}, workspaceOwnerNpub = '') {
  const mapActor = (actor = {}) => ({
    actor_id: trimText(actor.actor_id || actor.id),
    id: trimText(actor.actor_id || actor.id),
    npub: trimText(actor.npub),
    kind: trimText(actor.kind) || 'human',
    display_name: trimText(actor.display_name) || null,
  });
  const members = (Array.isArray(group.members) ? group.members : []).map(mapActor).filter((actor) => actor.npub);
  const effectiveMembers = (Array.isArray(group.effective_members) ? group.effective_members : group.members || []).map(mapActor).filter((actor) => actor.npub);
  const groupId = trimText(group.group_id || group.id);
  return {
    group_id: groupId,
    group_npub: groupId,
    current_epoch: 1,
    owner_npub: workspaceOwnerNpub,
    name: trimText(group.name) || 'Untitled group',
    group_kind: trimText(group.group_kind || group.kind) || 'custom',
    private_member_npub: null,
    member_npubs: members.map((member) => member.npub),
    effective_member_npubs: effectiveMembers.map((member) => member.npub),
    members,
    effective_members: effectiveMembers,
    child_group_ids: (Array.isArray(group.child_group_ids) ? group.child_group_ids : []).map(String).filter(Boolean),
    parent_group_ids: (Array.isArray(group.parent_group_ids) ? group.parent_group_ids : []).map(String).filter(Boolean),
  };
}

export async function hydrateTowerPgSyncBundle(store, bundle = {}, deps = {}) {
  if (bundle.device_lock) return (await import('./pg-device-checkpoints.js')).commitDeviceLease(bundle.device_lock);
  if (bundle.thread_history_page) return materializeThreadHistoryPage(store, bundle.thread_history_page);
  if (bundle.device_action) {
    const { commitDeviceMetadata } = await import('./pg-device-checkpoints.js');
    const { recordDeltaCursorKey } = await import('./pg-record-delta.js');
    return commitDeviceMetadata(recordDeltaCursorKey(store), { ...bundle.device_action, deviceLease: bundle.local_apply_options?.deviceLease });
  }
  if ([1, 2].includes(bundle.protocol_version)) {
    const { applyPgRecordChanges, resetPgRecordAuthority, reconcilePgRecordConflicts, rebuildPgRecordSummaries, retireSnapshotOmissions } = await import('./pg-record-delta.js');
    if (bundle.resume_snapshot_retirement) return retireSnapshotOmissions(store, bundle.local_apply_options);
    if (bundle.rebuild_summaries) return rebuildPgRecordSummaries(store);
    if (bundle.reconcile_commands) return reconcilePgRecordConflicts(store, { acceptRemoteKey: bundle.accept_remote_key || null });
    if (bundle.reference_directory) {
      const context = resolveTowerPgWorkspaceContext(store);
      const db = getWorkspaceDb();
      const { assertDeviceLease } = await import('./pg-device-checkpoints.js');
      await db.transaction('rw', db.workspace_members, db.groups, db.sync_state, async () => {
        await assertDeviceLease(db, bundle.local_apply_options?.deviceLease);
        const members = (bundle.members || []).map(row => mapPgWorkspaceMemberToLocal(row, context)).filter(Boolean);
        const groups = (bundle.groups || []).map(row => mapPgSyncGroup(row, context.workspaceOwnerNpub));
        if (members.length) await db.workspace_members.bulkPut(members);
        if (groups.length) await db.groups.bulkPut(groups);
      });
      return { applied: (bundle.members?.length || 0) + (bundle.groups?.length || 0), cursor: null, hasMore: false };
    }
    if (bundle.reset_authority === true) { const reset = await resetPgRecordAuthority(store, bundle.local_apply_options); return { applied: 0, cursor: null, hasMore: false, ...reset }; }
    const context = resolveTowerPgWorkspaceContext(store);
    await (deps.migrateLegacyAutopilotLaunchers || migrateLegacyAutopilotLaunchers)(
      context.workspaceId,
      store.workspaceHarnessAgents || [],
    );
    const result = await applyPgRecordChanges(store, bundle, bundle.local_apply_options || {});
    // Also retire saved warnings when no new delta for that record arrives.
    if (!result.staged) await reconcilePgRecordConflicts(store);
    return result;
  }
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub) return { applied: 0, cursor: null };

  if (bundle?.full_snapshot === true || bundle?.mode === 'snapshot') {
    const nonpaged = !Object.hasOwn(bundle, 'snapshot_complete');
    if ((nonpaged || bundle.snapshot_complete === true) && bundle.identity?.workspace_id !== context.workspaceId) throw new Error('Unverified Tower PG snapshot authority');
    validatePgRows(bundle, 'scopes', context, { complete: nonpaged, cap: Infinity });
    validatePgRows(bundle, 'channels', context, { complete: nonpaged, cap: Infinity });
    if (!Array.isArray(bundle.channel_bundles)) throw new Error('Incomplete Tower PG snapshot');
    for (const channel of bundle.channel_bundles) {
      if (!channel.channel_id) throw new Error('Invalid Tower PG snapshot channel');
      validatePgRows(channel, 'threads', context, { channelId: channel.channel_id });
      validatePgRows(channel, 'messages', context, { channelId: channel.channel_id });
    }
  }
  const memberRows = Array.isArray(bundle?.members) ? bundle.members : [];
  const groups = (Array.isArray(bundle?.groups) ? bundle.groups : [])
    .map((group) => mapPgSyncGroup(group, context.workspaceOwnerNpub))
    .filter((group) => group.group_id);
  const actorNpubByActorId = new Map(memberRows
    .map((entry) => {
      const actor = entry?.actor || entry || {};
      return [trimText(actor.actor_id || actor.id), trimText(actor.npub)];
    })
    .filter(([actorId, npub]) => actorId && npub));
  const scopes = (Array.isArray(bundle?.scopes) ? bundle.scopes : [])
    .map((scope) => mapPgScopeToLocal(scope, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((scope) => scope.record_id);
  const channels = (Array.isArray(bundle?.channels) ? bundle.channels : [])
    .map((channel) => mapPgChannelToLocal(channel, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((channel) => channel.record_id);
  const channelBundles = (Array.isArray(bundle?.channel_bundles) ? bundle.channel_bundles : []).map((channelBundle) => {
    const channelId = trimText(channelBundle?.channel_id);
    const rawThreads = Array.isArray(channelBundle?.threads) ? channelBundle.threads : [];
    const threadById = new Map(rawThreads.map((thread) => [trimText(thread?.id), thread]).filter(([id]) => id));
    const messages = (Array.isArray(channelBundle?.messages) ? channelBundle.messages : [])
      .map((message) => mapPgMessageToLocal(message, {
        workspaceOwnerNpub: context.workspaceOwnerNpub,
        senderNpub: '',
        threadById,
        actorNpubByActorId,
      }))
      .filter((message) => message.record_id && message.channel_id);
    const sourceMessageIds = new Set(rawThreads.map((thread) => trimText(thread?.source_message_id)).filter(Boolean));
    const fallbackThreads = selectPgFallbackThreads(rawThreads, messages)
      .map((thread) => mapPgThreadToLocal(thread, {
        workspaceOwnerNpub: context.workspaceOwnerNpub,
        senderNpub: '',
        actorNpubByActorId,
      }))
      .filter((thread) => thread.record_id && thread.channel_id);
    const fallbackThreadIds = new Set(fallbackThreads.map((thread) => trimText(thread?.pg_thread_id)).filter(Boolean));
    const normalizedMessages = messages.map((message) => (
      fallbackThreadIds.has(trimText(message?.pg_thread_id)) && trimText(message?.parent_message_id)
        ? { ...message, parent_message_id: trimText(message?.pg_thread_id) }
        : message
    ));
    const tasks = (Array.isArray(channelBundle?.tasks) ? channelBundle.tasks : [])
      .map((task) => mapPgTaskToLocal(task, { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId }))
      .filter((task) => task.record_id);
    const documents = [
      ...(Array.isArray(channelBundle?.docs) ? channelBundle.docs : [])
        .map((doc) => mapPgDocToLocal(doc, { workspaceOwnerNpub: context.workspaceOwnerNpub })),
      ...(Array.isArray(channelBundle?.files) ? channelBundle.files : [])
        .map((file) => mapPgFileToLocalDocument(file, { workspaceOwnerNpub: context.workspaceOwnerNpub })),
    ].filter((document) => document.record_id);
    const folders = (Array.isArray(channelBundle?.file_folders) ? channelBundle.file_folders : [])
      .map(mapPgFileFolderToLocal)
      .filter((folder) => folder.record_id);
    const audioNotes = (Array.isArray(channelBundle?.audio_notes) ? channelBundle.audio_notes : [])
      .map((note) => mapPgAudioNoteToLocal(note, {
        workspaceOwnerNpub: context.workspaceOwnerNpub,
        senderNpub: '',
        actorNpubByActorId,
      }))
      .filter((note) => note.record_id);
    const taskComments = (Array.isArray(channelBundle?.task_comments) ? channelBundle.task_comments : [])
      .map((comment) => mapPgTaskCommentToLocal(comment, {
        workspaceOwnerNpub: context.workspaceOwnerNpub,
        senderNpub: '',
        actorNpubByActorId,
      }))
      .filter((comment) => comment.record_id && comment.target_record_id);
    const docComments = (Array.isArray(channelBundle?.doc_comments) ? channelBundle.doc_comments : [])
      .map((comment) => mapPgDocCommentToLocal(comment, {
        workspaceOwnerNpub: context.workspaceOwnerNpub,
        senderNpub: '',
        actorNpubByActorId,
      }))
      .filter((comment) => comment.record_id && comment.target_record_id);
    return {
      channelId,
      messages: mergePgMessageRowsWithFallbackThreads(normalizedMessages, fallbackThreads, sourceMessageIds),
      tasks,
      documents,
      folders,
      audioNotes,
      comments: [...taskComments, ...docComments],
    };
  }).filter((entry) => entry.channelId);
  const dailyNotes = (Array.isArray(bundle?.daily_notes) ? bundle.daily_notes : [])
    .map((note) => mapPgDailyNoteToLocal(note, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((note) => note.record_id);
  const personalWapps = (Array.isArray(bundle?.personal_wapps) ? bundle.personal_wapps : [])
    .map((wapp) => mapPgPersonalWappToLocal(wapp, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((wapp) => wapp.record_id && wapp.launch_url);
  const cursor = trimText(bundle?.next_cursor || bundle?.through_cursor) || null;
  const fullSnapshot = bundle?.full_snapshot === true || bundle?.mode === 'snapshot';
  const pagedSnapshot = fullSnapshot && Object.hasOwn(bundle || {}, 'snapshot_complete');
  const snapshotComplete = pagedSnapshot && bundle?.snapshot_complete === true;
  const snapshotManifestKey = `${towerPgSyncCursorKey(store)}:snapshot_manifest`;
  const fallbackAuthority = bundle.local_record_fallback;
  const fallbackCursorKey = fallbackAuthority
    ? (await import('./pg-record-delta.js')).recordDeltaCursorKey(store)
    : null;

  assertTowerPgWorkspaceCurrent(store, context);
  await (deps.runWorkspaceSyncTransaction || runWorkspaceSyncTransaction)(async () => {
    if (fallbackAuthority) {
      const authority = await (deps.getSyncState || getSyncState)(fallbackCursorKey);
      if (authority?.resetting || Number(authority?.localGeneration || 0) !== fallbackAuthority.expectedGeneration
        || (authority?.cursor || null) !== fallbackAuthority.expectedCursor) {
        throw new Error('Record-delta authority changed before legacy fallback commit');
      }
      // Preserve the resumable v1 cursor, but do not let its now-stale
      // pg_resource_attention rows suppress the resource-view-state authority
      // while this Tower is serving the legacy workspace sync contract.
      await (deps.setSyncState || setSyncState)(fallbackCursorKey, {
        ...authority,
        cursor: authority?.cursor || null,
        legacyFallbackActive: true,
      });
    }
    const previousManifest = pagedSnapshot
      ? (await (deps.getSyncState || getSyncState)(snapshotManifestKey) || {})
      : {};
    const manifest = { ...previousManifest };
    const remember = (family, rows) => {
      if (!pagedSnapshot) return;
      manifest[family] = [...new Set([
        ...(Array.isArray(manifest[family]) ? manifest[family] : []),
        ...rows.map((row) => trimText(row?.record_id)).filter(Boolean),
      ])];
    };
    remember('scopes', scopes);
    remember('channels', channels);
    remember('daily_notes', dailyNotes);
    remember('personal_wapps', personalWapps);
    for (const channelBundle of channelBundles) {
      remember('messages', channelBundle.messages);
      remember('tasks', channelBundle.tasks);
      remember('documents', channelBundle.documents);
      remember('folders', channelBundle.folders);
      remember('audio_notes', channelBundle.audioNotes);
      remember('comments', channelBundle.comments);
    }
    if (fullSnapshot && !pagedSnapshot) {
      await (deps.replaceScopesForOwner || replaceScopesForOwner)(context.workspaceOwnerNpub, scopes);
      await (deps.replaceChannelsForOwner || replaceChannelsForOwner)(context.workspaceOwnerNpub, channels);
    } else {
      for (const scope of scopes) await (deps.upsertScope || upsertScope)(scope);
      for (const channel of channels) await (deps.upsertChannel || upsertChannel)(channel);
    }
    for (const group of groups) await (deps.upsertGroup || upsertGroup)(group);
    if ((!pagedSnapshot || snapshotComplete) && (memberRows.length > 0 || bundle?.refreshed?.directory === true)) {
      const workspaceMembers = memberRows.map((entry) => mapPgWorkspaceMemberToLocal(entry, context)).filter(Boolean);
      await (deps.replaceWorkspaceMembers || replaceWorkspaceMembers)(context.workspaceId, workspaceMembers);
    }
    for (const channelBundle of channelBundles) {
      if (pagedSnapshot) {
        for (const row of channelBundle.messages) await (deps.upsertMessage || upsertMessage)(row);
        for (const row of channelBundle.tasks) await (deps.upsertTask || upsertTask)(row);
        for (const row of channelBundle.documents) await (deps.upsertDocument || upsertDocument)(row);
        for (const row of channelBundle.folders) await (deps.upsertFileFolder || upsertFileFolder)(row);
        for (const row of channelBundle.audioNotes) await (deps.upsertAudioNote || upsertAudioNote)(row);
        for (const row of channelBundle.comments) await (deps.upsertComment || upsertComment)(row);
      } else {
        await (deps.replacePgMessagesForChannel || replacePgMessagesForChannel)(channelBundle.channelId, channelBundle.messages);
        await (deps.replacePgTasksForChannel || replacePgTasksForChannel)(channelBundle.channelId, channelBundle.tasks);
        await (deps.replacePgDocumentsForChannel || replacePgDocumentsForChannel)(channelBundle.channelId, channelBundle.documents);
        await (deps.replacePgFileFoldersForChannel || replacePgFileFoldersForChannel)(channelBundle.channelId, channelBundle.folders);
        await (deps.replacePgAudioNotesForChannel || replacePgAudioNotesForChannel)(channelBundle.channelId, channelBundle.audioNotes);
      }
      const commentsByTarget = new Map();
      for (const comment of channelBundle.comments) {
        const targetId = trimText(comment.target_record_id);
        if (!commentsByTarget.has(targetId)) commentsByTarget.set(targetId, []);
        commentsByTarget.get(targetId).push(comment);
      }
      for (const task of pagedSnapshot ? [] : channelBundle.tasks) {
        await (deps.replacePgCommentsForTarget || replacePgCommentsForTarget)(task.record_id, commentsByTarget.get(task.record_id) || []);
      }
      for (const document of (pagedSnapshot ? [] : channelBundle.documents).filter((item) => item.pg_record_type === 'doc')) {
        await (deps.replacePgCommentsForTarget || replacePgCommentsForTarget)(document.record_id, commentsByTarget.get(document.record_id) || []);
      }
    }
    if ((!pagedSnapshot || snapshotComplete) && (fullSnapshot || bundle?.refreshed?.daily_notes === true)) {
      await (deps.replaceDailyNotesForOwner || replaceDailyNotesForOwner)(context.workspaceOwnerNpub, dailyNotes);
    }
    const wappsByOwner = new Map();
    for (const wapp of personalWapps) {
      const ownerActorId = trimText(wapp.owner_actor_id || wapp.pg_owner_actor_id);
      if (!ownerActorId) continue;
      if (!wappsByOwner.has(ownerActorId)) wappsByOwner.set(ownerActorId, []);
      wappsByOwner.get(ownerActorId).push(wapp);
    }
    for (const [ownerActorId, rows] of (pagedSnapshot && !snapshotComplete ? [] : wappsByOwner)) {
      await (deps.replacePgPersonalWappsForOwner || replacePgPersonalWappsForOwner)(ownerActorId, rows);
    }
    if ((!pagedSnapshot || snapshotComplete) && bundle?.refreshed?.personal_wapps === true && wappsByOwner.size === 0) {
      const ownerActorId = currentPgActorId(store);
      if (ownerActorId) await (deps.replacePgPersonalWappsForOwner || replacePgPersonalWappsForOwner)(ownerActorId, []);
    }
    await (deps.deleteTowerPgSyncTombstones || deleteTowerPgSyncTombstones)(bundle?.tombstones || []);
    if (pagedSnapshot) await (deps.setSyncState || setSyncState)(snapshotManifestKey, manifest);
    if (snapshotComplete) {
      await (deps.reconcileTowerPgSnapshot || reconcileTowerPgSnapshot)(manifest);
      await (deps.deleteSyncState || deleteSyncState)(snapshotManifestKey);
    }
    await deps.beforeCursorCommit?.();
    if (cursor) await (deps.setSyncState || setSyncState)(towerPgSyncCursorKey(store), cursor);
  });

  // Stage 5 boundary: Tower reads stop at Dexie. Section/detail live queries
  // project the transaction into Alpine after the workspace guard succeeds.
  return {
    applied: channelBundles.reduce((count, channelBundle) => (
      count + channelBundle.messages.length + channelBundle.tasks.length + channelBundle.documents.length
      + channelBundle.folders.length + channelBundle.audioNotes.length + channelBundle.comments.length
    ), scopes.length + channels.length + dailyNotes.length + personalWapps.length),
    cursor,
    fullSnapshot,
    hasMore: bundle?.has_more === true,
  };
}

async function syncTowerPgRecordWorkspace(store, options, deps) {
  const context = resolveTowerPgWorkspaceContext(store);
  const { recordDeltaCursorKey, PG_RECORD_DELTA_FAMILIES } = await import('./pg-record-delta.js');
  assertTowerPgWorkspaceCurrent(store, context);
  const { discoverRecordProtocol, syncDeviceRecords, withDeviceCacheLock, withWorkerDeviceLease } = await import('./pg-device-checkpoints.js');
  // Existing v1-only injected ports do not imply a discovery capability.
  const protocol = deps.getTowerPgRecordSync && !deps.getTowerPgService ? 1
    : await discoverRecordProtocol(context, deps.getTowerPgService || getTowerPgService);
  assertTowerPgWorkspaceCurrent(store, context);
  const deviceMaterialize = bundle => (deps.hydrateTowerPgSyncBundle || hydrateTowerPgSyncBundle)(store, bundle, deps);
  const runDevice = lease => syncDeviceRecords({
    context, options, cursorKey: recordDeltaCursorKey(store),
    readState: deps.getSyncState || getSyncState,
    materialize: bundle => deviceMaterialize({ ...bundle, local_apply_options: { ...bundle.local_apply_options, ...(lease?.token ? { deviceLease: lease.token } : {}) } }),
    assertHeld: lease?.assertHeld,
    readPage: deps.getTowerPgRecordSync || getTowerPgRecordSync,
    client: deps.towerPgRecordClient || towerPgRecordClient,
    assertCurrent: () => assertTowerPgWorkspaceCurrent(store, context),
    preparePage: async (page, state) => {
      if (state.viewBaselineInitialized) return;
      await (deps.getTowerPgResourceViewStates || getTowerPgResourceViewStates)(context.workspaceId, {
        baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 1, useWorkspaceKey: false,
      });
      const canReadDirectory = store.currentWorkspace?.pgMe?.permissions?.includes('workspace.read') === true;
      if (Array.isArray(page.actors) && !canReadDirectory) return;
      const readDirectory = async (read, field) => {
        try { return (await read(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 200 }))[field] || []; }
        catch (error) { if (error.status === 403) return []; throw error; }
      };
      const members = await readDirectory(deps.getTowerPgWorkspaceMembers || getTowerPgWorkspaceMembers, 'members');
      const groups = await readDirectory(deps.getTowerPgWorkspaceGroups || getTowerPgWorkspaceGroups, 'groups');
      for (let offset = 0; offset < Math.max(members.length, groups.length); offset += 200) {
        assertTowerPgWorkspaceCurrent(store, context);
        await (deps.hydrateTowerPgSyncBundle || hydrateTowerPgSyncBundle)(store, { protocol_version: 2,
          local_apply_options: { deviceLease: lease?.token },
          reference_directory: true, members: members.slice(offset, offset + 200), groups: groups.slice(offset, offset + 200) }, deps);
      }
    },
  });
  if (protocol === 2) {
    const locks = deps.deviceLocks || globalThis.navigator?.locks;
    return locks?.request ? withDeviceCacheLock(store.workspaceDbKey || context.workspaceId, () => runDevice(), locks)
      : withWorkerDeviceLease(deviceMaterialize, () => assertTowerPgWorkspaceCurrent(store, context), runDevice);
  }
  const read = deps.getTowerPgRecordSync || getTowerPgRecordSync;
  let state = await (deps.getSyncState || getSyncState)(recordDeltaCursorKey(store));
  if (state?.device) {
    // A rolled-back server cannot consume a v2 token. Replace its generation
    // through a v1 snapshot while retaining current views and local intent.
    await (deps.hydrateTowerPgSyncBundle || hydrateTowerPgSyncBundle)(store, { protocol_version: 1, reset_authority: true,
      local_apply_options: { preserveViews: true, expectedCursor: state.cursor, expectedGeneration: Number(state.localGeneration || 0) } }, deps);
    state = await (deps.getSyncState || getSyncState)(recordDeltaCursorKey(store));
  }
  let cursor = state?.cursor || null;
  let applied = 0;
  let localGeneration = Number(state?.localGeneration || 0);
  let resets = 0;
  let authorityResetting = Boolean(state?.resetting);
  let directoryReady = Boolean(cursor);
  let viewBaselineInitialized = Boolean(state?.viewBaselineInitialized);
  const materialize = deps.hydrateTowerPgSyncBundle || hydrateTowerPgSyncBundle;
  // Older clients could retire typed-hydrated views on ordinary delta catch-up
  // while retaining canonical versions. A delta replay cannot restore those
  // missing views (equal canonical versions are skipped). Recover once through
  // a fresh authorized snapshot, preserving all current views until handover.
  if (state?.staging || state?.snapshotComplete && !Object.hasOwn(state, 'snapshotReconciliationPending')) {
    assertTowerPgWorkspaceCurrent(store, context);
    const reset = await materialize(store, { protocol_version: 1, reset_authority: true,
      local_apply_options: { preserveViews: true, expectedCursor: cursor, expectedGeneration: localGeneration } }, deps);
    localGeneration = reset.localGeneration;
    authorityResetting = true;
    cursor = null;
    directoryReady = false;
  }
  // Finish an already-authorized handover before asking Tower for another
  // page. Its committed prefix may otherwise see a different live delta after
  // reconnect. Retirement checkpoints contain no unapplied wire changes.
  if (state?.snapshotRetirement) {
    const result = await materialize(store, { protocol_version: 1, mode: 'delta',
      families: PG_RECORD_DELTA_FAMILIES, changes: [], has_more: false,
      next_cursor: state.snapshotRetirement.nextCursor, snapshot_id: null,
      local_apply_options: { expectedCursor: cursor, expectedGeneration: localGeneration } }, deps);
    cursor = result.cursor;
    applied += result.applied;
  }
  // forceSnapshot is a legacy refresh hint. V1 resumes its server-owned cursor;
  // authority/reset responses and the one-time upgrade repair discard download state.
  // In particular, probing a rolled-back server must never purge the cache.
  for (let pages = 1; pages <= (options.maxPages || 1000); pages++) {
    options.onProgress?.({ stage: 'receiving', page: pages, applied, cursorPresent: Boolean(cursor) });
    let page;
    try {
      page = await read(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub, cursor, limit: options.limit || 200, timeoutMs: options.timeoutMs || 30000 });
    } catch (error) {
      if (!authorityResetting && resets === 0 && [404, 406, 501].includes(error.status)) {
        return { unsupported: true, fallbackAuthority: { expectedCursor: cursor, expectedGeneration: localGeneration } };
      }
      let payload = error.payload || {};
      try { payload = JSON.parse(error.responseText || '{}'); } catch {}
      const code = error.code || payload.code || payload.error;
      const matchingWorkspace = !payload.identity?.workspace_id || payload.identity.workspace_id === context.workspaceId;
      const revoked = matchingWorkspace && error.status === 403 && code === 'workspace_membership_required';
      if (revoked || (error.status === 409 && String(error.responseText || error.message).includes('reset_required'))) {
        assertTowerPgWorkspaceCurrent(store, context);
        const reset = await materialize(store, { protocol_version: 1, reset_authority: true, local_apply_options: { preserveViews: !revoked, expectedCursor: cursor, expectedGeneration: localGeneration } }, deps);
        localGeneration = reset.localGeneration;
        if (revoked || ++resets > 2) throw error;
        cursor = null;
        directoryReady = false;
        continue;
      }
      throw error;
    }
    if (page.protocol_version !== 1) throw new Error('Tower did not negotiate record-delta v1');
    if (!viewBaselineInitialized) {
      // Retain the existing first-view baseline semantics. The typed read seeds
      // visible resource watermarks once; its journal changes join the snapshot
      // handover. Only one returned state is needed, not a second history pull.
      await (deps.getTowerPgResourceViewStates || getTowerPgResourceViewStates)(context.workspaceId, {
        baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 1,
      });
      viewBaselineInitialized = true;
    }
    // Actor sidecars resolve record attribution; they are not the workspace
    // member directory used by People and agent mentions. Rehydrate that
    // directory after a fresh/ACL-reset snapshot when membership permits it.
    const canReadDirectory = store.currentWorkspace?.pgMe?.permissions?.includes('workspace.read') === true;
    if (Array.isArray(page.actors) && !canReadDirectory) directoryReady = true;
    if (!directoryReady) {
      let members = { members: [] };
      try { members = await (deps.getTowerPgWorkspaceMembers || getTowerPgWorkspaceMembers)(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 200 }); }
      catch (error) { if (error.status !== 403) throw error; }
      let groups = { groups: [] };
      try { groups = await (deps.getTowerPgWorkspaceGroups || getTowerPgWorkspaceGroups)(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub, limit: 200 }); }
      catch (error) { if (error.status !== 403) throw error; }
      const memberRows = members.members || [], groupRows = groups.groups || [];
      for (let offset = 0; offset < Math.max(memberRows.length, groupRows.length); offset += 200) {
        assertTowerPgWorkspaceCurrent(store, context);
        await materialize(store, { protocol_version: 1, reference_directory: true, members: memberRows.slice(offset, offset + 200), groups: groupRows.slice(offset, offset + 200) }, deps);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      directoryReady = true;
    }
    options.onProgress?.({ stage: 'applying', page: pages, applied });
    assertTowerPgWorkspaceCurrent(store, context);
    if (page.has_more && page.next_cursor === cursor) throw new Error('Tower record sync repeated its cursor');
    const result = await materialize(store, { ...page, local_apply_options: { expectedCursor: cursor, expectedGeneration: localGeneration, viewBaselineInitialized, incrementalSnapshot: true } }, deps);
    applied += result.applied;
    cursor = result.cursor;
    if (!result.hasMore) {
      assertTowerPgWorkspaceCurrent(store, context);
      if (result.needsSummaryBackfill) await materialize(store, { protocol_version: 1, rebuild_summaries: true }, deps);
      options.onProgress?.({ stage: 'complete', page: pages, applied });
      return { ...result, applied, pages };
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Tower record sync exceeded the maximum page count');
}

export async function syncTowerPgWorkspace(store, options = {}, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl) return { applied: 0, cursor: null };
  // Existing injected legacy ports remain legacy-only. Production negotiates the
  // versioned endpoint once per service sync, never reuses the legacy cursor.
  let fallbackAuthority = null;
  if (!deps.getTowerPgWorkspaceSync || deps.getTowerPgRecordSync) {
    const result = await syncTowerPgRecordWorkspace(store, options, deps);
    if (!result.unsupported) return result;
    assertTowerPgWorkspaceCurrent(store, context);
    fallbackAuthority = result.fallbackAuthority;
  }
  const readSync = deps.getTowerPgWorkspaceSync || getTowerPgWorkspaceSync;
  // Rollback resumes only the persisted legacy cursor, regardless of caller
  // hints. Never reinterpret a v1 cursor or force a destructive legacy snapshot.
  let cursor = fallbackAuthority
    ? (await (deps.getSyncState || getSyncState)(towerPgSyncCursorKey(store)) || null)
    : options.forceSnapshot
    ? null
    : (options.cursor || await (deps.getSyncState || getSyncState)(towerPgSyncCursorKey(store)) || null);
  let totalApplied = 0;
  let pageCount = 0;
  const seenCursors = new Set();
  do {
    const requestStartedAt = Date.now();
    options.onProgress?.({
      stage: 'receiving',
      page: pageCount + 1,
      cursorPresent: Boolean(cursor),
      applied: totalApplied,
    });
    const bundle = await readSync(context.workspaceId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
      cursor,
      limit: options.limit || 500,
      timeoutMs: options.timeoutMs || 30_000,
    });
    const requestDurationMs = Date.now() - requestStartedAt;
    const applyStartedAt = Date.now();
    options.onProgress?.({
      stage: 'applying',
      page: pageCount + 1,
      cursorPresent: Boolean(cursor),
      requestDurationMs,
      fullSnapshot: bundle?.full_snapshot === true || bundle?.mode === 'snapshot',
      hasMore: bundle?.has_more === true,
      applied: totalApplied,
    });
    const materializeBundle = deps.hydrateTowerPgSyncBundle || hydrateTowerPgSyncBundle;
    assertTowerPgWorkspaceCurrent(store, context);
    const applied = await materializeBundle(store, { ...bundle, local_record_fallback: fallbackAuthority }, deps);
    totalApplied += applied.applied;
    pageCount += 1;
    cursor = applied.cursor;
    if (applied.hasMore && (!cursor || seenCursors.has(cursor))) {
      throw new Error('Tower PG sync returned a repeated pagination cursor');
    }
    if (cursor) seenCursors.add(cursor);
    options.onProgress?.({
      stage: applied.hasMore ? 'receiving' : 'complete',
      page: pageCount,
      cursorPresent: Boolean(cursor),
      requestDurationMs,
      applyDurationMs: Date.now() - applyStartedAt,
      fullSnapshot: applied.fullSnapshot,
      hasMore: applied.hasMore,
      applied: totalApplied,
    });
    if (!applied.hasMore) return { ...applied, applied: totalApplied, pages: pageCount };
  } while (pageCount < (options.maxPages || 1_000));
  throw new Error('Tower PG sync exceeded the maximum page count');
}

function validatePgRows(result, field, context, { complete = false, cap = 100, channelId, scopeId } = {}) {
  const rows = result?.[field];
  if (!Array.isArray(rows) || complete && (result.next_cursor || result.has_more || rows.length >= cap)) {
    throw new Error(`Incomplete Tower PG ${field} response`);
  }
  if (result.identity?.workspace_id && result.identity.workspace_id !== context.workspaceId) throw new Error('Tower response belongs to another workspace');
  if (complete && !rows.length && result.identity?.workspace_id !== context.workspaceId) throw new Error('Unverified empty Tower PG response');
  const ids = new Set();
  for (const row of rows) {
    const id = trimText(row?.id || row?.record_id);
    if (!id || ids.has(id) || row.workspace_id && row.workspace_id !== context.workspaceId
      || channelId && row.channel_id !== channelId || scopeId && row.scope_id !== scopeId) {
      throw new Error(`Invalid Tower PG ${field} row`);
    }
    ids.add(id);
  }
  return rows;
}

function tagPgSnapshotRead(row, authority) {
  return authority?.snapshotReconciliationPending && authority?.generation
    ? { ...row, pg_delta_generation: authority.generation } : row;
}


function pgReadAuthorityCancellation(message, code = 'pg_read_authority_changed') {
  return Object.assign(new Error(message), { code });
}

async function readPgAuthority(store, deps, allowReset = false) {
  const state = await (deps.getSyncState || getSyncState)(`${towerPgSyncCursorKey(store)}:record-delta-v1`);
  if (!allowReset && state?.resetting) throw pgReadAuthorityCancellation('Workspace authority is resetting', 'pg_read_authority_resetting');
  const commands = store._towerSyncService?.instrumentation;
  return { ...state, commandRevision: commands ? [commands.commandsStarted, commands.commandsAcknowledged, commands.commandsFailed] : null };
}

async function commitPgRead(store, context, authority, deps, callback) {
  return (deps.runWorkspaceSyncTransaction || runWorkspaceSyncTransaction)(async () => {
    assertTowerPgWorkspaceCurrent(store, context);
    if (pgAuthorityToken(await readPgAuthority(store, deps, true)) !== pgAuthorityToken(authority)) throw pgReadAuthorityCancellation('Workspace authority changed while loading Tower data');
    return callback();
  });
}

export async function hydrateTowerPgScopes(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readScopes = deps.getTowerPgWorkspaceScopes || getTowerPgWorkspaceScopes;
  const putScope = deps.upsertPgListedScope || upsertPgListedScope;
  const authority = await readPgAuthority(store, deps);
  const result = await readScopes(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    path: context.links.scopes || null,
  });
  const scopes = validatePgRows(result, 'scopes', context, { complete: true })
    .map((scope) => mapPgScopeToLocal(scope, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((scope) => scope.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  // Typed list reads describe what is visible at request time. Record-delta
  // owns authoritative retirement; replacing here can erase pending local
  // creates and race a newer materialized snapshot.
  await commitPgRead(store, context, authority, deps, async () => {
    for (const scope of scopes) await putScope(tagPgSnapshotRead(scope, authority));
  });
  return scopes;
}

export async function hydrateTowerPgChannels(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readChannels = deps.getTowerPgScopeChannels || getTowerPgScopeChannels;
  const putChannel = deps.upsertPgListedChannel || upsertPgListedChannel;
  const authority = await readPgAuthority(store, deps);

  // Alpine may still hold an empty/partial scope list after the scope read
  // commits to Dexie. A coalesced refresh may also return only a freshness
  // marker. Neither is an authority boundary for replacing workspace channels.
  // Read the complete authorized scope list and retain the current partition's
  // channels until every channel read succeeds. Record-delta reconciles
  // removals; a typed list can only update rows it actually returned.
  const scopeResult = await (deps.getTowerPgWorkspaceScopes || getTowerPgWorkspaceScopes)(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    path: context.links.scopes || null,
  });
  assertTowerPgWorkspaceCurrent(store, context);
  if (!Array.isArray(scopeResult?.scopes) || scopeResult.next_cursor || scopeResult.has_more || scopeResult.scopes.length >= 100) {
    throw new Error('Incomplete Tower PG scopes response; workspace sync must reconcile channels');
  }
  validatePgRows(scopeResult, 'scopes', context, { complete: true });
  const scopes = scopeResult.scopes.map((scope) => mapPgScopeToLocal(scope, { workspaceOwnerNpub: context.workspaceOwnerNpub }));

  const channels = [];
  for (const scope of scopes.filter((entry) => entry?.record_id && entry.record_state !== 'deleted')) {
    const result = await readChannels(context.workspaceId, scope.record_id, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    assertTowerPgWorkspaceCurrent(store, context);
    if (!Array.isArray(result?.channels) || result.next_cursor || result.has_more || result.channels.length >= 100) {
      throw new Error('Incomplete Tower PG channels response; workspace sync must reconcile channels');
    }
    validatePgRows(result, 'channels', context, { complete: true, scopeId: scope.record_id });
    const mapped = result.channels
      .map((channel) => mapPgChannelToLocal(channel, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
      .filter((channel) => channel.record_id);
    channels.push(...mapped);
  }

  assertTowerPgWorkspaceCurrent(store, context);
  await (deps.runWorkspaceSyncTransaction || runWorkspaceSyncTransaction)(async () => {
    assertTowerPgWorkspaceCurrent(store, context);
    // A newer delta/tombstone or ACL reset outranks this older list request.
    // Check in the replacement transaction so a late response cannot revive it.
    if (pgAuthorityToken(await readPgAuthority(store, deps, true)) !== pgAuthorityToken(authority)) {
      throw pgReadAuthorityCancellation('Channel authority changed while loading Tower data');
    }
    for (const channel of channels) await putChannel(tagPgSnapshotRead(channel, authority));
  });
  return channels;
}

export async function hydrateTowerPgChannelMessages(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];
  const trace = typeof store?.traceFlightDeckTiming === 'function'
    ? store.traceFlightDeckTiming.bind(store)
    : null;
  const startedAt = new Date().toISOString();
  trace?.('channel hydration request started', { channelId: targetChannelId, startedAt });

  const authority = await readPgAuthority(store, deps);
  const readThreads = deps.getTowerPgChannelThreads || getTowerPgChannelThreads;
  const readMessages = deps.getTowerPgChannelMessages || getTowerPgChannelMessages;
  const readActivities = deps.getTowerPgResponseActivities || getTowerPgResponseActivities;
  const readAgentActivities = deps.getTowerPgAgentActivities || getTowerPgAgentActivities;
  const replaceMessages = deps.replacePgMessagesForChannel || replacePgMessagesForChannel;
  const replaceActivities = deps.replacePgResponseActivitiesForChannel || replacePgResponseActivitiesForChannel;
  const replaceAgentActivities = deps.replacePgAgentActivitiesForChannel || replacePgAgentActivitiesForChannel;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);

  const result = await readThreads(context.workspaceId, targetChannelId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    includeArchived: true,
  });
  const rawThreads = validatePgRows(result, 'threads', context, { channelId: targetChannelId });
  const threadById = new Map(rawThreads.map((thread) => [trimText(thread?.id), thread]).filter(([id]) => id));
  // Selected-channel hydration is deliberately windowed. The workspace sync
  // owns complete local history; opening a channel only refreshes its newest
  // remote page instead of walking every historical cursor on the UI thread.
  const messagePage = await readMessages(context.workspaceId, targetChannelId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    limit: Number(store?.MAIN_FEED_PAGE_SIZE || 21),
  });
  const rawMessages = validatePgRows(messagePage, 'messages', context, { channelId: targetChannelId });
  const sourceMessageIds = new Set(rawThreads.map((thread) => trimText(thread?.source_message_id)).filter(Boolean));
  const messageRows = rawMessages
    .map((message) => mapPgMessageToLocal(message, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      threadById,
      actorNpubByActorId,
    }))
    .filter((message) => message.record_id && message.channel_id);
  const fallbackThreads = selectPgFallbackThreads(rawThreads, messageRows)
    .map((thread) => mapPgThreadToLocal(thread, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      actorNpubByActorId,
    }))
    .filter((thread) => thread.record_id && thread.channel_id);
  const fallbackThreadIds = new Set(fallbackThreads.map((thread) => trimText(thread?.pg_thread_id)).filter(Boolean));
  const normalizedMessageRows = messageRows.map((message) => (
    fallbackThreadIds.has(trimText(message?.pg_thread_id)) && trimText(message?.parent_message_id)
      ? { ...message, parent_message_id: trimText(message?.pg_thread_id) }
      : message
  ));
  const rows = mergePgMessageRowsWithFallbackThreads(normalizedMessageRows, fallbackThreads, sourceMessageIds);
  assertTowerPgWorkspaceCurrent(store, context);
  await commitPgRead(store, context, authority, deps, () => replaceMessages(targetChannelId, rows.map(row => tagPgSnapshotRead(row, authority))));
  const tracedMessageIds = rows
    .map((row) => row.record_id)
    .filter((recordId) => store?.flightDeckTimingMessageIds?.has?.(recordId));
  trace?.('message Dexie transaction committed', {
    channelId: targetChannelId,
    messageIds: tracedMessageIds,
    startedAt,
    committedAt: new Date().toISOString(),
  });
  // Activity indicators are optional chat adornments. Keep their signer work
  // sequential and do not discard an already-materialized message snapshot if
  // either request times out.
  await Promise.allSettled([
    hydrateTowerPgChannelResponseActivities(store, targetChannelId, {
      ...deps,
      getTowerPgResponseActivities: readActivities,
      replacePgResponseActivitiesForChannel: replaceActivities,
    }),
  ]);
  try {
    await (store?.requestTowerSyncFamily
      ? store.requestTowerSyncFamily('channel-agent-activities', targetChannelId, { channelId: targetChannelId, force: true })
      : hydrateTowerPgChannelAgentActivities(store, targetChannelId, {
        ...deps,
        getTowerPgAgentActivities: readAgentActivities,
        replacePgAgentActivitiesForChannel: replaceAgentActivities,
      }));
  } catch (error) {
    // Messages have committed; expose and retry activity failure separately.
    if (!store.requestTowerSyncFamily) {
      store.agentActivityRecoveryStartedAt ||= Date.now();
      store.agentActivityRecoveryError = 'Activity updates could not be recovered. Retrying.';
      store.scheduleBackgroundSync?.(1000);
    }
  }

  return rows;
}

// One explicit history page. The current Tower contract is oldest-first; never
// drain cursors to manufacture a newest page when the local cache is incomplete.
export async function readTowerPgThreadHistoryPage(store, channelId, threadId, options = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl || !channelId || !threadId) return null;
  const authorityState = await getSyncState(`${towerPgSyncCursorKey(store)}:record-delta-v1`);
  const expectedGeneration = Number(authorityState?.localGeneration || 0);
  const request = { baseUrl: context.baseUrl, appNpub: context.appNpub };
  const threadResult = await (options.getTowerPgThread || getTowerPgThread)(context.workspaceId, threadId, request);
  const thread = threadResult?.thread || threadResult;
  if (!thread?.id || thread.channel_id !== channelId) throw new Error('Thread does not belong to this channel');
  const page = await (options.getTowerPgChannelMessages || getTowerPgChannelMessages)(context.workspaceId, channelId, {
    ...request, threadId, effectiveTranscript: true, cursor: options.cursor || null,
    limit: Math.min(100, Math.max(1, Number(options.limit) || 100)),
  });
  if (page?.next_cursor && page.next_cursor === options.cursor) throw new Error('Conversation history cursor did not advance');
  validatePgRows(page, 'messages', context, { channelId });
  assertTowerPgWorkspaceCurrent(store, context);
  return { thread_history_page: { channelId, thread, messages: page.messages,
    cursor: options.cursor || null, nextCursor: page?.next_cursor || null, expectedGeneration, expectedAuthority: pgAuthorityToken(authorityState) } };
}

async function materializeThreadHistoryPage(store, page) {
  const context = resolveTowerPgWorkspaceContext(store);
  const db = getWorkspaceDb();
  const threadId = page.thread.id;
  const threadById = new Map([[threadId, page.thread]]);
  const rows = page.messages.map(message => mapPgMessageToLocal(message, { ...context, threadById }));
  const key = `thread-history-page:${threadId}`;
  return db.transaction('rw', db.chat_messages, db.pending_writes, db.sync_state, db.pg_record_rows, async () => {
    const authorityState = (await db.sync_state.get(`${towerPgSyncCursorKey(store)}:record-delta-v1`))?.value;
    if (page.expectedAuthority !== undefined && page.expectedAuthority !== pgAuthorityToken(authorityState))
      throw new Error('Conversation history authority changed; reopen to retry');
    if (authorityState?.resetting || (page.expectedGeneration !== undefined
      && page.expectedGeneration !== Number(authorityState?.localGeneration || 0))) {
      throw new Error('Conversation history authority changed; reopen to retry');
    }
    const previous = (await db.sync_state.get(key))?.value;
    const local = await db.chat_messages.get(threadId);
    const thread = mapPgThreadToLocal(page.thread, context);
    const lineage = threadHistoryLineage(thread);
    const [canonical, channel] = await db.pg_record_rows.bulkGet([`thread:${threadId}`, `channel:${page.channelId}`]);
    const revoked = record => record && (record.operation === 'delete' || record.row?.deleted_at);
    if (revoked(canonical) || revoked(channel) || local?.record_state === 'deleted'
      || Number(canonical?.row?.row_version || canonical?.row?.version || 0) > thread.version
      || Number(local?.version || 0) > thread.version
      || Number(previous?.version || 0) > thread.version
      || (local && Number(local.version || 0) === thread.version && threadHistoryLineage(local) !== lineage)
      || (canonical?.row && Number(canonical.row.row_version || canonical.row.version || 0) === thread.version
        && threadHistoryLineage(canonical.row) !== lineage)) {
      throw new Error('Conversation history is older than current authority; reopen to retry');
    }
    const sameLineage = threadHistoryLineage(local) === lineage;
    const priorCoverage = previous?.lineage === lineage ? previous : null;
    // Unbound legacy coverage cannot establish inherited membership. A persisted
    // full transcript on the matching thread can, without scanning message rows.
    const known = mergeThreadHistoryIds(sameLineage ? local?.pg_effective_message_ids || [] : [], priorCoverage?.messageIds || []);
    const candidates = rows;
    const authority = await db.pg_record_rows.bulkGet(candidates.map(row => `message:${row.record_id}`));
    const current = candidates.filter((row, index) => {
      const record = authority[index];
      return !revoked(record) && (!record || Number(record.row?.row_version || record.row?.version || 0) <= Number(row.version || 0));
    });
    const tombstones = new Set(rows.filter((row, index) => revoked(authority[index]) || row.record_state === 'deleted').map(row => row.record_id));
    const ids = clampBranchEffectiveMessageIds(
      mergeThreadHistoryIds(known.filter(id => !tombstones.has(id)), current.filter(row => row.record_state !== 'deleted').map(row => row.record_id), !page.cursor),
      current,
      thread,
    );
    // Only the expected forward edge may move continuation. Replayed first or
    // reordered pages can add membership but cannot move the cursor backwards.
    if (page.cursor && !priorCoverage) throw new Error('Conversation history lineage changed; reopen to retry');
    const advances = !priorCoverage || (page.cursor && page.cursor === priorCoverage.nextCursor);
    const nextCursor = advances ? page.nextCursor : priorCoverage.nextCursor;
    assertTowerPgWorkspaceCurrent(store, context);
    await replacePgMessagesForChannel(page.channelId, [...current, { ...thread, pg_effective_message_ids: ids }].map(row => tagPgSnapshotRead(row, authorityState)));
    await db.sync_state.put({ key, value: { lineage, version: thread.version, nextCursor, messageIds: ids, loadedAt: Date.now(), activityVersion: thread.activity_version, authority: pgAuthorityToken(authorityState) } });
    return { nextCursor, count: rows.length };
  });
}

export async function hydrateTowerPgThreadMessages(store, channelId, threadId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  const targetThreadId = trimText(threadId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId || !targetThreadId) return [];
  const authority = await readPgAuthority(store, deps);
  const readThreads = deps.getTowerPgChannelThreads || getTowerPgChannelThreads;
  const readThread = deps.getTowerPgThread || (!deps.getTowerPgChannelThreads ? getTowerPgThread : null);
  const readMessages = deps.getTowerPgChannelMessages || getTowerPgChannelMessages;
  const persistMessage = deps.upsertMessage || (row => replacePgMessagesForChannel(targetChannelId, [tagPgSnapshotRead(row, authority)]));
  const messageId = trimText(deps.messageId);
  const threadResult = messageId
    ? null
    : readThread
      ? await readThread(context.workspaceId, targetThreadId, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
        })
      : await readThreads(context.workspaceId, targetChannelId, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
          includeArchived: true,
          limit: Number(deps.threadLimit || 100),
        });
  const rawThreads = messageId
    ? [{ id: targetThreadId, source_message_id: messageId, channel_id: targetChannelId }]
    : readThread
      ? [threadResult?.thread || threadResult].filter((thread) => thread?.id)
      : (Array.isArray(threadResult?.threads) ? threadResult.threads : []);
  const threadById = new Map(rawThreads.map((thread) => [trimText(thread?.id), thread]).filter(([id]) => id));
  const rawMessages = [];
  let cursor = null;
  do {
    const result = await readMessages(context.workspaceId, targetChannelId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
      threadId: targetThreadId,
      effectiveTranscript: true,
      cursor,
      limit: Number(deps.limit || 200),
    });
    rawMessages.push(...validatePgRows(result, 'messages', context, { channelId: targetChannelId }));
    if (result.next_cursor && result.next_cursor === cursor) throw new Error('Conversation history cursor did not advance');
    cursor = trimText(result?.next_cursor) || null;
  } while (cursor);
  const rows = rawMessages
    .map((message) => mapPgMessageToLocal(message, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      threadById,
    }))
    .filter((message) => message.record_id && message.channel_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await commitPgRead(store, context, authority, deps, async () => {
    await Promise.all(rows.map((row) => persistMessage(row)));
    const rawThread = rawThreads.find((thread) => trimText(thread?.id) === targetThreadId);
    if (rawThread) {
      assertTowerPgWorkspaceCurrent(store, context);
      await persistMessage({
        ...mapPgThreadToLocal(rawThread, {
          workspaceOwnerNpub: context.workspaceOwnerNpub,
          senderNpub: '',
        }),
        pg_effective_message_ids: clampBranchEffectiveMessageIds(rows.map((row) => row.record_id), rows, rawThread),
      });
    }
  });
  return rows;
}

export async function hydrateTowerPgChannelAgentActivities(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];
  const readActivities = deps.getTowerPgAgentActivities || getTowerPgAgentActivities;
  const replaceActivities = deps.replacePgAgentActivitiesForChannel || replacePgAgentActivitiesForChannel;
  const readLocalActivities = deps.getAgentActivitiesForChannel
    || (deps.replacePgAgentActivitiesForChannel ? async () => [] : getAgentActivitiesForChannel);
  const mergeCommentary = deps.mergeAgentActivityCommentary || mergeAgentActivityCommentary;
  const requestSnapshot = (await readLocalActivities(targetChannelId)).filter((row) => !deps.threadId || row.thread_id === deps.threadId);
  const result = await readActivities(context.workspaceId, {
    channelId: targetChannelId,
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    threadId: deps.threadId,
    activityId: deps.activityId,
    cursor: deps.cursor,
    beforeSequence: deps.beforeSequence,
    afterSequence: deps.afterSequence,
    afterCommentaryCursor: deps.afterCommentaryCursor,
    historyLimit: deps.historyLimit ?? 50,
  });
  const activities = (Array.isArray(result?.agent_activities) ? result.agent_activities : [])
    .map(mapPgAgentActivity)
    .filter((activity) => activity?.record_id
      && (!activity.workspace_id || activity.workspace_id === context.workspaceId)
      && activity.channel_id === targetChannelId
      && (!deps.activityId || activity.activity_id === deps.activityId)
      && (!deps.turnId || activity.turn_id === deps.turnId)
      && (!deps.threadId || activity.thread_id === deps.threadId));
  // Incremental forward recovery cannot declare older history fully loaded.
  if (deps.afterSequence != null || deps.afterCommentaryCursor != null) {
    for (const activity of activities) delete activity.commentary_next_before_sequence;
  }
  const currentContext = resolveTowerPgWorkspaceContext(store);
  if (
    currentContext.workspaceId !== context.workspaceId
    || currentContext.workspaceOwnerNpub !== context.workspaceOwnerNpub
    || currentContext.baseUrl !== context.baseUrl
  ) {
    return activities;
  }
  const pagination = result?.pagination && typeof result.pagination === 'object' ? result.pagination : null;
  const authoritative = Boolean(
    result
    && typeof result === 'object'
    && Object.prototype.hasOwnProperty.call(result, 'agent_activities')
    && Array.isArray(result.agent_activities)
    && result.partial !== true
    && result.complete !== false
    && result.truncated !== true
    && !result.next_cursor
    && result.has_more !== true
    && (!pagination || (
      !pagination.next_cursor
      && pagination.has_more !== true
      && pagination.complete !== false
      && pagination.partial !== true
    ))
  );
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceActivities(targetChannelId, activities, {
    authoritative,
    requestSnapshot,
  });
  const rawActivities = Array.isArray(result?.agent_activities) ? result.agent_activities : [];
  const commentary = rawActivities.flatMap((rawActivity) => {
    const activity = mapPgAgentActivity(rawActivity);
    if (!activity || !activities.some((row) => row.record_id === activity.record_id)) return [];
    return (Array.isArray(rawActivity.commentary_history) ? rawActivity.commentary_history : [])
      .map((item) => mapPgAgentActivityCommentary(item, activity, {
        workspaceId: context.workspaceId,
        backendUrl: context.baseUrl,
      }))
      .filter(Boolean);
  });
  assertTowerPgWorkspaceCurrent(store, context);
  await mergeCommentary(commentary);
  Object.defineProperty(activities, 'next_cursor', { value: result?.next_cursor || null });
  Object.defineProperty(activities, 'next_after_sequence', {
    value: rawActivities[0]?.commentary_next_after_sequence ?? null,
  });
  Object.defineProperty(activities, 'next_commentary_cursor', { value: rawActivities[0]?.commentary_next_cursor ?? null });
  if (deps.recover === true && !deps.activityId) {
    const pending = await recoverTowerPgAgentCommentary(store, targetChannelId, requestSnapshot, activities, deps);
    Object.defineProperty(activities, 'recovery_pending', { value: pending });
  }
  return activities;
}

export async function hydrateTowerPgAgentSessionHealth(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];
  // Session health is optional and absent on current Tower. Re-evaluate the
  // live descriptor each time so a later capability refresh enables recovery.
  const workspace = store.currentWorkspace || {};
  if (!workspace.capabilities?.includes('pg_agent_session_health')
    && !workspace.pgDescriptor?.capabilities?.includes('pg_agent_session_health')) return [];
  const readHealth = deps.getTowerPgAgentSessionHealth || getTowerPgAgentSessionHealth;
  const replaceHealth = deps.replacePgAgentSessionHealthForChannel || replacePgAgentSessionHealthForChannel;
  const result = await readHealth(context.workspaceId, {
    channelId: targetChannelId,
    threadId: deps.threadId,
    sessionId: deps.sessionId,
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const sessions = (Array.isArray(result?.agent_sessions) ? result.agent_sessions : [])
    .map(mapPgAgentSessionHealth)
    .filter((health) => health?.record_id
      && (!health.workspace_id || health.workspace_id === context.workspaceId)
      && health.channel_id === targetChannelId
      && (!deps.threadId || health.thread_id === deps.threadId)
      && (!deps.sessionId || health.session_id === deps.sessionId));
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceHealth(targetChannelId, sessions);
  return sessions;
}

async function recoverTowerPgAgentCommentary(store, channelId, previous, received, deps) {
  const context = resolveTowerPgWorkspaceContext(store);
  const readState = deps.getSyncState || getSyncState;
  const saveState = deps.setSyncState || setSyncState;
  const keyFor = (row) => `agent-commentary-recovery:${context.workspaceId}:${context.baseUrl}:${row.activity_id}:${row.turn_id}`;
  const previousIds = new Set(previous.map((row) => row.activity_id));
  for (const row of received) {
    if (previousIds.has(row.activity_id) || !row.turn_id) continue;
    assertTowerPgWorkspaceCurrent(store, context);
    // Initial hydration is a bounded latest page. Older history stays on demand.
    const existing = await readState(keyFor(row));
    assertTowerPgWorkspaceCurrent(store, context);
    if (!existing) await saveState(keyFor(row), { sequence: row.sequence, deliveryCursor: row.commentary_cursor, checkedAt: Date.now() });
  }
  const candidates = [];
  for (const row of previous) {
    if (!row.turn_id) continue;
    const checkpoint = await readState(keyFor(row));
    const snapshot = received.find((item) => item.activity_id === row.activity_id);
    const latest = snapshot || row;
    const caughtUp = latest.commentary_cursor != null
      ? checkpoint?.deliveryCursor != null && BigInt(checkpoint.deliveryCursor) >= BigInt(latest.commentary_cursor)
      : checkpoint && checkpoint.sequence >= latest.sequence;
    if (isTerminalAgentActivity(latest) && caughtUp
      && (snapshot || Date.now() - Number(checkpoint?.checkedAt || 0) < 60_000)) continue;
    candidates.push({ row: latest, checkpoint });
  }
  candidates.sort((a, b) => (a.checkpoint?.checkedAt || 0) - (b.checkpoint?.checkedAt || 0));
  let pending = candidates.length > 10;
  for (const { row, checkpoint } of candidates.slice(0, 10)) {
    assertTowerPgWorkspaceCurrent(store, context);
    const page = await hydrateTowerPgChannelAgentActivities(store, channelId, {
      ...deps, recover: false, activityId: row.activity_id, turnId: row.turn_id,
      afterSequence: row.commentary_cursor == null ? checkpoint?.sequence ?? -1 : undefined,
      afterCommentaryCursor: row.commentary_cursor != null ? checkpoint?.deliveryCursor ?? '0' : undefined,
      beforeSequence: undefined, historyLimit: 200,
    });
    assertTowerPgWorkspaceCurrent(store, context);
    if (!page.length) continue; // Absence is not a terminal state.
    if (page.next_after_sequence != null || page.next_commentary_cursor != null) pending = true;
    await saveState(keyFor(row), {
      sequence: page.next_after_sequence ?? page[0].sequence,
      deliveryCursor: page.next_commentary_cursor ?? page[0].commentary_cursor,
      checkedAt: Date.now(),
    });
  }
  return pending;
}

export async function hydrateTowerPgChannelResponseActivities(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];

  const readActivities = deps.getTowerPgResponseActivities || getTowerPgResponseActivities;
  const replaceActivities = deps.replacePgResponseActivitiesForChannel || replacePgResponseActivitiesForChannel;
  const result = await readActivities(context.workspaceId, {
    channelId: targetChannelId,
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const activities = (Array.isArray(result?.response_activities) ? result.response_activities : [])
    .map((activity) => mapPgResponseActivity(activity))
    .filter((activity) => activity?.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceActivities(targetChannelId, activities);
  return activities;
}

export async function hydrateTowerPgResponseActivitiesForTarget(store, targetType, targetId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const resolvedTargetType = trimText(targetType);
  const resolvedTargetId = trimText(targetId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !resolvedTargetType || !resolvedTargetId) return [];

  const readActivities = deps.getTowerPgResponseActivities || getTowerPgResponseActivities;
  const replaceActivities = deps.replacePgResponseActivitiesForTarget || replacePgResponseActivitiesForTarget;
  const result = await readActivities(context.workspaceId, {
    targetType: resolvedTargetType,
    targetId: resolvedTargetId,
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const activities = (Array.isArray(result?.response_activities) ? result.response_activities : [])
    .map((activity) => mapPgResponseActivity(activity))
    .filter((activity) => activity?.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceActivities(resolvedTargetType, resolvedTargetId, activities);
  return activities;
}

export async function hydrateTowerPgChannelTasks(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];

  const readChannelTasks = deps.getTowerPgChannelTasks || getTowerPgChannelTasks;
  const replaceTasks = deps.replacePgTasksForChannel || replacePgTasksForChannel;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await readChannelTasks(context.workspaceId, targetChannelId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const tasks = (Array.isArray(result?.tasks) ? result.tasks : [])
    .map((task) => mapPgTaskToLocal(task, { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId }))
    .filter((task) => task.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceTasks(targetChannelId, tasks);
  return tasks;
}

// Context reference browsing includes scope-owned tasks outside channels.
export async function hydrateTowerPgScopeTasks(store, scopeId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const read = deps.getTowerPgScopeTasks || getTowerPgScopeTasks;
  const write = deps.upsertTask || upsertTask;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await read(context.workspaceId, scopeId, {baseUrl:context.baseUrl,appNpub:context.appNpub});
  const rows = (result?.tasks || []).map(task => mapPgTaskToLocal(task, {workspaceOwnerNpub:context.workspaceOwnerNpub,actorNpubByActorId}));
  assertTowerPgWorkspaceCurrent(store, context);
  for (const row of rows) { assertTowerPgWorkspaceCurrent(store, context); await write(row); }
  return rows;
}

export async function hydrateTowerPgTask(store, taskId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const recordId = trimText(taskId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !recordId) return null;

  const readTask = deps.getTowerPgTask || getTowerPgTask;
  const writeTask = deps.upsertTask || upsertTask;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await readTask(context.workspaceId, recordId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const sourceTask = result?.task || result;
  const task = mapPgTaskToLocal(sourceTask, { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId });
  if (!task.record_id) return null;

  assertTowerPgWorkspaceCurrent(store, context);
  await writeTask(task);
  return task;
}

export async function hydrateTowerPgChannelDocumentsAndFiles(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];

  const readDocs = deps.getTowerPgChannelDocs || getTowerPgChannelDocs;
  const readFiles = deps.getTowerPgChannelFiles || getTowerPgChannelFiles;
  const readFolders = deps.getTowerPgChannelFileFolders || getTowerPgChannelFileFolders;
  const replaceDocuments = deps.replacePgDocumentsForChannel || replacePgDocumentsForChannel;
  const replaceFolders = deps.replacePgFileFoldersForChannel || replacePgFileFoldersForChannel;
  const [docsResult, archivedDocsResult, filesResult, archivedFilesResult, foldersResult] = await Promise.all([
    readDocs(context.workspaceId, targetChannelId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    }),
    readDocs(context.workspaceId, targetChannelId, { baseUrl: context.baseUrl, appNpub: context.appNpub, archived: true }),
    readFiles(context.workspaceId, targetChannelId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    }),
    readFiles(context.workspaceId, targetChannelId, { baseUrl: context.baseUrl, appNpub: context.appNpub, archived: true }),
    readFolders(context.workspaceId, targetChannelId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    }),
  ]);
  const docRows = [...(Array.isArray(docsResult?.docs) ? docsResult.docs : []), ...(Array.isArray(archivedDocsResult?.docs) ? archivedDocsResult.docs : [])]
    .map((doc) => mapPgDocToLocal(doc, { workspaceOwnerNpub: context.workspaceOwnerNpub }));
  const mappedDocuments = [
    ...docRows,
    ...[...(Array.isArray(filesResult?.files) ? filesResult.files : []), ...(Array.isArray(archivedFilesResult?.files) ? archivedFilesResult.files : [])]
      .map((file) => mapPgFileToLocalDocument(file, { workspaceOwnerNpub: context.workspaceOwnerNpub })),
  ].filter((doc) => doc.record_id);
  const documents = [...new Map(mappedDocuments.map((doc) => [doc.record_id, doc])).values()];
  const folders = (Array.isArray(foldersResult?.folders) ? foldersResult.folders : [])
    .map(mapPgFileFolderToLocal)
    .filter((folder) => folder.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceDocuments(targetChannelId, documents);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceFolders(targetChannelId, folders);
  return documents;
}

export async function hydrateTowerPgDoc(store, docId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const recordId = trimText(docId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !recordId) return null;

  const readDoc = deps.getTowerPgDoc || getTowerPgDoc;
  const readDocBody = deps.getTowerPgDocBody || getTowerPgDocBody;
  let result = null;
  let doc = null;
  try {
    result = await readDocBody(context.workspaceId, recordId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    doc = result?.doc || null;
  } catch (bodyError) {
    result = null;
    const fallback = await readDoc(context.workspaceId, recordId, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    doc = fallback?.doc || null;
  }

  if (!doc) return null;
  const row = mapPgDocToLocal({
    ...doc,
    canonical_version: result?.canonical_version || null,
  }, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  if (!row.record_id) return null;
  const hydrated = result?.body
    ? await hydratePgDocBodyContent(row, result)
    : await hydratePgDocStorageContent(row, deps);
  if (hydrated.content_sha256_hex && !hydrated.pg_canonical_body_sha256_hex) {
    hydrated.pg_canonical_body_sha256_hex = hydrated.content_sha256_hex;
  }

  assertTowerPgWorkspaceCurrent(store, context);
  await (deps.upsertDocument || upsertDocument)(hydrated);
  return hydrated;
}

export async function hydrateTowerPgChannelAudioNotes(store, channelId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetChannelId = trimText(channelId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetChannelId) return [];

  const readAudioNotes = deps.getTowerPgChannelAudioNotes || getTowerPgChannelAudioNotes;
  const replaceAudioNotes = deps.replacePgAudioNotesForChannel || replacePgAudioNotesForChannel;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await readAudioNotes(context.workspaceId, targetChannelId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const audioNotes = (Array.isArray(result?.audio_notes) ? result.audio_notes : [])
    .map((audioNote) => mapPgAudioNoteToLocal(audioNote, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      actorNpubByActorId,
    }))
    .filter((audioNote) => audioNote.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceAudioNotes(targetChannelId, audioNotes);
  return audioNotes;
}

export async function hydrateTowerPgDailyNoteTarget(store, ownerActorId, noteDate, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetOwnerActorId = trimText(ownerActorId);
  const targetNoteDate = trimText(noteDate);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !targetOwnerActorId || !targetNoteDate) return [];

  const readDailyNotes = deps.getTowerPgDailyNotes || getTowerPgDailyNotes;
  const replaceDailyNotes = deps.replacePgDailyNotesForOwnerAndDate || deps.replacePgDailyNotesForChannelAndDate || replacePgDailyNotesForOwnerAndDate;
  const result = await readDailyNotes(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    ownerActorId: targetOwnerActorId,
    channelId: deps.legacyChannelId || null,
    noteDate: targetNoteDate,
    limit: deps.limit || 10,
  });
  const dailyNotes = (Array.isArray(result?.daily_notes) ? result.daily_notes : [])
    .map((note) => mapPgDailyNoteToLocal(note, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((note) => note.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceDailyNotes(targetOwnerActorId, targetNoteDate, dailyNotes);
  return dailyNotes;
}

export async function hydrateTowerPgReactionTarget(store, targetType, targetId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const resolvedTargetType = trimText(targetType);
  const resolvedTargetId = trimText(targetId);
  const targetFamilyHash = pgAudioTargetFamily(resolvedTargetType);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !resolvedTargetType || !resolvedTargetId || !targetFamilyHash) return [];

  let missingTargets = MISSING_REACTION_TARGETS.get(store);
  if (!missingTargets) {
    missingTargets = new Map();
    MISSING_REACTION_TARGETS.set(store, missingTargets);
  }
  const missingKey = JSON.stringify([context.workspaceId, context.baseUrl, context.appNpub,
    store.session?.npub, store._workspaceSelectionGeneration, resolvedTargetType, resolvedTargetId]);
  // Duplicate/replayed SSE hints cannot revive an absent target immediately.
  // This short negative cache expires so restored targets remain recoverable.
  for (const [key, retryAt] of missingTargets) if (Date.now() >= retryAt) missingTargets.delete(key);
  if (missingTargets.has(missingKey)) return [];

  const readReactions = deps.getTowerPgReactions || getTowerPgReactions;
  const replaceReactions = deps.replacePgReactionsForTarget || replacePgReactionsForTarget;
  let result;
  try {
    result = await readReactions(context.workspaceId, {
      targetType: resolvedTargetType,
      targetId: resolvedTargetId,
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
  } catch (error) {
    if (isMissingPgReactionTargetError(error)) {
      assertTowerPgWorkspaceCurrent(store, context);
      await replaceReactions(targetFamilyHash, resolvedTargetId, []);
      missingTargets.set(missingKey, Date.now() + MISSING_REACTION_TARGET_RETRY_MS);
      return [];
    }
    throw error;
  }
  const reactions = (Array.isArray(result?.reactions) ? result.reactions : [])
    .map((reaction) => mapPgReactionToLocal(reaction, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      targetType: resolvedTargetType,
      targetId: resolvedTargetId,
    }))
    .filter((reaction) => reaction.record_id && reaction.target_record_family_hash && reaction.target_record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceReactions(targetFamilyHash, resolvedTargetId, reactions);
  return reactions;
}

export async function hydrateTowerPgWorkrooms(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl) return [];
  const channelId = trimText(deps.channelId);
  const readWorkrooms = deps.getTowerPgWorkrooms || getTowerPgWorkrooms;
  const replaceChannel = deps.replacePgWorkroomsForChannel || replacePgWorkroomsForChannel;
  const replaceWorkspace = deps.replacePgWorkroomsForWorkspace || replacePgWorkroomsForWorkspace;
  const result = await readWorkrooms(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    scopeId: deps.scopeId || null,
    channelId: channelId || null,
    status: deps.status || null,
    limit: deps.limit || 100,
  });
  const workrooms = (Array.isArray(result?.workrooms) ? result.workrooms : [])
    .map(mapPgWorkroomToLocal)
    .filter((workroom) => workroom.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  if (channelId) await replaceChannel(channelId, workrooms);
  else await replaceWorkspace(context.workspaceId, workrooms);
  return workrooms;
}

export async function hydrateTowerPgWorkroomApprovals(store, workroomId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetWorkroomId = trimText(workroomId);
  if (!context.workspaceId || !context.baseUrl || !targetWorkroomId) return [];
  const readApprovals = deps.getTowerPgApprovals || getTowerPgApprovals;
  const replaceApprovals = deps.replaceWorkroomApprovalsForRoom || replaceWorkroomApprovalsForRoom;
  const result = await readApprovals(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    targetType: 'workroom',
    targetId: targetWorkroomId,
    limit: deps.limit || 100,
  });
  const approvals = (Array.isArray(result?.approvals) ? result.approvals : [])
    .map(mapPgWorkroomApprovalToLocal)
    .filter((approval) => approval.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceApprovals(targetWorkroomId, approvals);
  return approvals;
}

export async function hydrateTowerPgWorkroomParticipants(store, workroomId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetWorkroomId = trimText(workroomId);
  if (!context.workspaceId || !context.baseUrl || !targetWorkroomId) return [];
  const readParticipants = deps.getTowerPgWorkroomParticipants || getTowerPgWorkroomParticipants;
  const replaceParticipants = deps.replaceWorkroomParticipantsForRoom || replaceWorkroomParticipantsForRoom;
  const result = await readParticipants(context.workspaceId, targetWorkroomId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const participants = (Array.isArray(result?.participants) ? result.participants : [])
    .map(mapPgWorkroomParticipantToLocal)
    .filter((participant) => participant.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceParticipants(targetWorkroomId, participants);
  return participants;
}

export async function hydrateTowerPgWorkroomEvents(store, workroomId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetWorkroomId = trimText(workroomId);
  if (!context.workspaceId || !context.baseUrl || !targetWorkroomId) return [];
  const readEvents = deps.getTowerPgWorkroomEvents || getTowerPgWorkroomEvents;
  const replaceEvents = deps.replaceWorkroomEventsForRoom || replaceWorkroomEventsForRoom;
  const result = await readEvents(context.workspaceId, targetWorkroomId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    limit: deps.limit || 200,
  });
  const events = (Array.isArray(result?.events) ? result.events : [])
    .map(mapPgWorkroomEventToLocal)
    .filter((event) => event.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceEvents(targetWorkroomId, events);
  return events;
}

export async function hydrateTowerPgWorkroomLinks(store, workroomId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetWorkroomId = trimText(workroomId);
  if (!context.workspaceId || !context.baseUrl || !targetWorkroomId) return [];
  const readLinks = deps.getTowerPgWorkroomLinks || getTowerPgWorkroomLinks;
  const replaceLinks = deps.replaceWorkroomLinksForRoom || replaceWorkroomLinksForRoom;
  const result = await readLinks(context.workspaceId, targetWorkroomId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    limit: deps.limit || 200,
  });
  const links = (Array.isArray(result?.links) ? result.links : [])
    .map(mapPgWorkroomLinkToLocal)
    .filter((link) => link.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceLinks(targetWorkroomId, links);
  return links;
}

export async function hydrateTowerPgWorkroom(store, workroomId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const targetWorkroomId = trimText(workroomId);
  if (!context.workspaceId || !context.baseUrl || !targetWorkroomId) return null;
  const readWorkroom = deps.getTowerPgWorkroom || getTowerPgWorkroom;
  const writeWorkroom = deps.upsertWorkroom || upsertWorkroom;
  const replaceParticipants = deps.replaceWorkroomParticipantsForRoom || replaceWorkroomParticipantsForRoom;
  const replaceEvents = deps.replaceWorkroomEventsForRoom || replaceWorkroomEventsForRoom;
  const replaceLinks = deps.replaceWorkroomLinksForRoom || replaceWorkroomLinksForRoom;

  const result = await readWorkroom(context.workspaceId, targetWorkroomId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    limit: deps.limit || 200,
  });
  const workroom = mapPgWorkroomToLocal(result?.workroom || result);
  if (!workroom.record_id) return null;

  const participants = (Array.isArray(result?.participants) ? result.participants : [])
    .map(mapPgWorkroomParticipantToLocal)
    .filter((participant) => participant.record_id);
  const events = (Array.isArray(result?.events) ? result.events : [])
    .map(mapPgWorkroomEventToLocal)
    .filter((event) => event.record_id);
  const links = (Array.isArray(result?.links) ? result.links : [])
    .map(mapPgWorkroomLinkToLocal)
    .filter((link) => link.record_id);

  assertTowerPgWorkspaceCurrent(store, context);
  await Promise.all([
    writeWorkroom(workroom),
    replaceParticipants(targetWorkroomId, participants),
    replaceEvents(targetWorkroomId, events),
    replaceLinks(targetWorkroomId, links),
    hydrateTowerPgWorkroomApprovals(store, targetWorkroomId, deps),
  ]);
  return workroom;
}

export async function hydrateTowerPgEventUpdates(store, events = [], deps = {}) {
  const pgEvents = Array.isArray(events) ? events : [];
  const writeAgentActivity = deps.upsertAgentActivity || upsertAgentActivity;
  const writeAgentSessionHealth = deps.upsertAgentSessionHealth || upsertAgentSessionHealth;
  const mergeCommentary = deps.mergeAgentActivityCommentary || mergeAgentActivityCommentary;
  const activityContext = resolveTowerPgWorkspaceContext(store);
  const optionalFailures = [];
  const absentTargets = [];
  // These reads are hints, not deletion authority. Reconcile missing resources
  // through the workspace journal before acknowledging their SSE batch.
  const optionalTarget = async (family, id, load) => {
    try { return await load(); }
    catch (error) {
      let payload = error?.payload;
      try { payload = JSON.parse(error.responseText); } catch {}
      const absent = ['workroom', 'response-activity'].includes(family) && error?.status === 400 && payload?.code === 'resource-not-found'
        && payload?.required_permission === 'channel.read'
        && payload?.identity?.workspace_id === activityContext.workspaceId;
      (absent ? absentTargets : optionalFailures).push({ family, id, error });
    }
  };
  const feedEvents = [];
  const commentaryUpdates = [];
  const messageChannels = new Set();
  const taskChannels = new Set();
  const taskIds = new Set();
  const documentChannels = new Set();
  const audioChannels = new Set();
  const taskCommentTargets = new Set();
  const docCommentTargets = new Set();
  const dailyTargets = new Map();
  const reactionTargets = new Map();
  const personalWappOwnerIds = new Set();
  const responseActivityWrites = [];
  const responseActivityDeletes = [];
  const agentActivityUpdates = [];
  const agentSessionHealthUpdates = [];
  const workroomIds = new Set();
  const workroomChannels = new Set();
  const workroomEventIds = new Set();
  const workroomLinkIds = new Set();
  const workroomParticipantIds = new Set();
  const resourceViewStateUpdates = [];
  let workspaceMembersChanged = false;
  let groupsChanged = false;
  let dailyScopeAccessChanged = false;
  const channelGrantChannels = new Set();
  let channelsChanged = false;
  let attentionStateChanged = false;
  let fallbackEvents = 0;

  for (const event of pgEvents) {
    const entityType = trimText(event?.entity_type);
    const channelId = trimText(event?.channel_id || event?.payload?.channel_id);
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
    if (Number.isSafeInteger(Number(payload.activity_version)) && Number(payload.activity_version) >= 0) {
      attentionStateChanged = true;
    }

    if (
      ['workspace_member', 'workspace_member_profile', 'actor_profile', 'actor'].includes(entityType)
      || trimText(event?.event_type) === 'actor.profile.updated'
    ) {
      workspaceMembersChanged = true;
    } else if (['group', 'group_member', 'workspace_group_member'].includes(entityType)) {
      groupsChanged = true;
    } else if (['daily_scope_agent_access', 'daily_scope_access'].includes(entityType)) {
      dailyScopeAccessChanged = true;
    } else if (entityType === 'channel_grant' && channelId) {
      channelGrantChannels.add(channelId);
    } else if (entityType === 'channel') {
      channelsChanged = true;
    } else if (['message', 'thread'].includes(entityType) && channelId) {
      messageChannels.add(channelId);
    } else if (['task', 'task_assignment'].includes(entityType)) {
      const taskId = trimText(event?.entity_id || payload.task_id || payload.id);
      if (taskId) taskIds.add(taskId);
      else if (channelId) taskChannels.add(channelId);
      else fallbackEvents += 1;
    } else if (['doc', 'file', 'file_folder'].includes(entityType) && channelId) {
      documentChannels.add(channelId);
    } else if (entityType === 'audio_note' && channelId) {
      audioChannels.add(channelId);
    } else if (entityType === 'task_comment' && trimText(payload.task_id)) {
      const taskId = trimText(payload.task_id);
      taskCommentTargets.add(taskId);
      // Task activity_version is the completeness boundary for actor-aware
      // attention. Hydrate it with the comments so an older local comment
      // cannot be promoted while the corresponding task event is still queued.
      taskIds.add(taskId);
    } else if (entityType === 'doc_comment' && (trimText(payload.doc_id) || trimText(event?.entity_id))) {
      docCommentTargets.add(trimText(payload.doc_id) || trimText(event?.entity_id));
    } else if (entityType === 'daily_note' && (trimText(payload.owner_actor_id) || channelId) && trimText(payload.note_date)) {
      const noteDate = trimText(payload.note_date);
      const ownerActorId = trimText(payload.owner_actor_id) || channelId;
      dailyTargets.set(`${ownerActorId}:${noteDate}`, { ownerActorId, noteDate, legacyChannelId: trimText(payload.owner_actor_id) ? null : channelId });
    } else if (['feed_subscription', 'feed_item_state'].includes(entityType)) {
      feedEvents.push(event);
    } else if (entityType === 'personal_wapp') {
      const ownerActorId = trimText(payload.owner_actor_id) || currentPgActorId(store);
      if (ownerActorId) personalWappOwnerIds.add(ownerActorId);
      else fallbackEvents += 1;
    } else if (['wapp_activity_item', 'wapp_activity_mute'].includes(entityType)) {
      // The WApp projection has its own bounded reconciliation path. Treat its
      // SSE events as recognized so they do not also trigger a workspace delta.
    } else if (entityType === 'reaction' && trimText(payload.target_type) && trimText(payload.target_id)) {
      const targetType = trimText(payload.target_type);
      const targetId = trimText(payload.target_id);
      reactionTargets.set(`${targetType}:${targetId}`, { targetType, targetId });
    } else if (entityType === 'resource_view_state') {
      // Tower only exposes these outbox rows to the matching viewer.
      const state = mapTowerResourceViewState(payload);
      if (state) {
        resourceViewStateUpdates.push(state);
        attentionStateChanged = true;
      }
      else fallbackEvents += 1;
    } else if (entityType === 'response_activity') {
      const activity = mapPgResponseActivity(payload.response_activity || payload.activity || payload);
      const operation = trimText(event?.operation);
      if (operation === 'cleared' || activity?.status === 'cleared' || activity?.record_state === 'cleared') {
        const recordId = activity?.record_id || trimText(event?.entity_id);
        if (recordId) responseActivityDeletes.push(recordId);
      } else if (activity) {
        responseActivityWrites.push(activity);
      } else {
        fallbackEvents += 1;
      }
    } else if (entityType === 'agent_activity') {
      const rawActivity = payload.agent_activity || payload.activity || payload;
      const activity = mapPgAgentActivity(rawActivity);
      if (activity && activity.workspace_id && activity.workspace_id !== activityContext.workspaceId) continue;
      if (activity) {
        const entries = Array.isArray(rawActivity.commentary_history)
          ? rawActivity.commentary_history
          : [rawActivity];
        commentaryUpdates.push(...entries.map((entry) => mapPgAgentActivityCommentary(entry, activity, {
          workspaceId: activityContext.workspaceId, backendUrl: activityContext.baseUrl,
        })).filter(Boolean));
      }
      const recordId = activity?.record_id || trimText(event?.entity_id);
      if (activity && isTerminalAgentActivity(activity)) {
        if (recordId) agentActivityUpdates.push({ activity, recordId, terminal: true });
      } else if (activity) {
        agentActivityUpdates.push({ activity, recordId, terminal: false });
      } else {
        fallbackEvents += 1;
      }
    } else if (entityType === 'agent_session_health') {
      const health = mapPgAgentSessionHealth(payload.agent_session_health || payload.session_health || payload);
      if (health && (!health.workspace_id || health.workspace_id === activityContext.workspaceId)) {
        agentSessionHealthUpdates.push(health);
      } else {
        fallbackEvents += 1;
      }
    } else if (entityType === 'workroom') {
      const workroomId = trimText(event?.entity_id || payload.workroom_id || payload.id);
      if (workroomId) workroomIds.add(workroomId);
      else if (channelId) workroomChannels.add(channelId);
      else fallbackEvents += 1;
    } else if (entityType === 'workroom_event') {
      const workroomId = trimText(payload.workroom_id || payload.workroomId);
      if (workroomId) workroomEventIds.add(workroomId);
      else fallbackEvents += 1;
    } else if (entityType === 'workroom_link') {
      const workroomId = trimText(payload.workroom_id || payload.workroomId);
      if (workroomId) workroomLinkIds.add(workroomId);
      else fallbackEvents += 1;
    } else if (entityType === 'workroom_participant') {
      const workroomId = trimText(payload.workroom_id || payload.workroomId);
      if (workroomId) workroomParticipantIds.add(workroomId);
      else fallbackEvents += 1;
    } else {
      fallbackEvents += 1;
    }
  }

  assertTowerPgWorkspaceCurrent(store, activityContext);
  // Save every received entry before coalescing replaceable current snapshots.
  if (commentaryUpdates.length) await mergeCommentary(commentaryUpdates);
  assertTowerPgWorkspaceCurrent(store, activityContext);
  const latestAgentActivityUpdates = [...agentActivityUpdates.reduce((latest, update) => {
    const key = `${update.activity.activity_id || update.recordId}\u0000${update.activity.turn_id || ''}`;
    const current = latest.get(key);
    if (!current || Number(update.activity.sequence) > Number(current.activity.sequence)) latest.set(key, update);
    return latest;
  }, new Map()).values()];
  const accessMaterializationChanged = groupsChanged || channelGrantChannels.size > 0;

  const jobs = [
    ...(channelsChanged && typeof store?.refreshChannels === 'function'
      ? [store.refreshChannels()]
      : []),
    ...(workspaceMembersChanged && typeof store?.refreshTowerPgWorkspaceMembers === 'function'
      ? [store.refreshTowerPgWorkspaceMembers({ force: true, limit: 200 })]
      : []),
    ...(groupsChanged && typeof store?.refreshGroups === 'function'
      ? [store.refreshGroups({ force: true, minIntervalMs: 0 })]
      : []),
    ...(accessMaterializationChanged && typeof store?.refreshPgChannelAccessMaterialization === 'function'
      ? [store.refreshPgChannelAccessMaterialization()]
      : []),
    ...(dailyScopeAccessChanged && typeof store?.refreshDailyScopeAgentAccess === 'function'
      ? [store.refreshDailyScopeAgentAccess()]
      : []),
    ...[...channelGrantChannels].flatMap((grantChannelId) => [
      ...(grantChannelId === trimText(store?.selectedChannelId) && typeof store?.refreshChannelGrants === 'function'
        ? [store.refreshChannelGrants()]
        : []),
    ]),
    ...[...messageChannels].map(async (channelId) => {
      // Use the same coalesced read recovery as navigation during startup
      // staging. A deferred read has no commit and cannot acknowledge SSE.
      const result = await (store.requestTowerSyncFamily
        ? store.requestTowerSyncFamily('channel-messages', channelId, { ...deps, force: true })
        : hydrateTowerPgChannelMessages(store, channelId, deps));
      if (result?.deferred) throw pgReadAuthorityCancellation('SSE message read deferred until authority settles');
      return result;
    }),
    ...[...taskIds].map((taskId) => hydrateTowerPgTask(store, taskId, deps)),
    ...[...taskChannels].map((channelId) => hydrateTowerPgChannelTasks(store, channelId, deps)),
    ...[...documentChannels].map((channelId) => hydrateTowerPgChannelDocumentsAndFiles(store, channelId, deps)),
    ...[...audioChannels].map((channelId) => hydrateTowerPgChannelAudioNotes(store, channelId, deps)),
    ...[...taskCommentTargets].map((taskId) => hydrateTowerPgTaskComments(store, taskId, deps)),
    ...[...docCommentTargets].map((docId) => hydrateTowerPgDocComments(store, docId, deps)),
    ...[...dailyTargets.values()].map(({ ownerActorId, noteDate, legacyChannelId }) => hydrateTowerPgDailyNoteTarget(store, ownerActorId, noteDate, { ...deps, legacyChannelId })),
    ...[...personalWappOwnerIds].map(() => hydrateTowerPgPersonalWapps(store, deps)),
    ...[...reactionTargets.values()].map(({ targetType, targetId }) => hydrateTowerPgReactionTarget(store, targetType, targetId, deps)),
    ...feedEvents.map(event => optionalTarget('feed-reader', event.entity_id, () => materializeFeedReaderEvent(store, event))),
    ...responseActivityWrites.map((activity) => optionalTarget('response-activity', activity.target_id || activity.channel_id, () => (
      activity.target_type && activity.target_id
        ? hydrateTowerPgResponseActivitiesForTarget(store, activity.target_type, activity.target_id, deps)
        : hydrateTowerPgChannelResponseActivities(store, activity.channel_id, deps)
    ))),
    ...responseActivityDeletes.map((recordId) => clearResponseActivity(recordId)),
    ...latestAgentActivityUpdates.map((update) => writeAgentActivity(update.activity)),
    ...agentSessionHealthUpdates.map((health) => writeAgentSessionHealth(health)),
    ...[...workroomIds].map((workroomId) => optionalTarget('workroom', workroomId, () => hydrateTowerPgWorkroom(store, workroomId, deps))),
    ...[...workroomChannels].map((channelId) => hydrateTowerPgWorkrooms(store, { ...deps, channelId })),
    ...[...workroomEventIds].map((workroomId) => optionalTarget('workroom', workroomId, () => hydrateTowerPgWorkroomEvents(store, workroomId, deps))),
    ...[...workroomEventIds].map((workroomId) => optionalTarget('workroom', workroomId, () => hydrateTowerPgWorkroomApprovals(store, workroomId, deps))),
    ...[...workroomLinkIds].map((workroomId) => optionalTarget('workroom', workroomId, () => hydrateTowerPgWorkroomLinks(store, workroomId, deps))),
    ...[...workroomParticipantIds].map((workroomId) => optionalTarget('workroom', workroomId, () => hydrateTowerPgWorkroomParticipants(store, workroomId, deps))),
    ...resourceViewStateUpdates.map((state) => upsertResourceViewState(state)),
  ];

  const results = await Promise.allSettled(jobs);
  assertTowerPgWorkspaceCurrent(store, activityContext);
  const failedCore = results.find(result => result.status === 'rejected');
  if (failedCore) throw failedCore.reason;
  if (attentionStateChanged) await store?.refreshUnreadFlags?.();
  return {
    ...(absentTargets.length ? { absentTargets } : {}),
    ...(optionalFailures.length ? { optionalFailures } : {}),
    channels: messageChannels.size,
    appliedTargets: jobs.length,
    fallbackEvents,
    events: pgEvents.length,
  };
}

export async function hydrateTowerPgTasks(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readChannelTasks = deps.getTowerPgChannelTasks || getTowerPgChannelTasks;
  const readScopeTasks = deps.getTowerPgScopeTasks || getTowerPgScopeTasks;
  const replaceTasks = deps.replaceTasksForOwner || replaceTasksForOwner;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);

  let channels = Array.isArray(store.channels) ? store.channels : [];
  if (channels.length === 0 && typeof store.refreshChannels === 'function') {
    const refreshed = await store.refreshChannels();
    channels = Array.isArray(refreshed) ? refreshed : (Array.isArray(store.channels) ? store.channels : []);
  }
  let scopes = Array.isArray(store.scopes) ? store.scopes : [];
  if (scopes.length === 0 && typeof store.refreshScopes === 'function') {
    const refreshed = await store.refreshScopes();
    scopes = Array.isArray(refreshed) ? refreshed : (Array.isArray(store.scopes) ? store.scopes : []);
  }

  const taskById = new Map();
  for (const channel of channels.filter((entry) => entry?.record_id && entry.record_state !== 'deleted')) {
    const result = await readChannelTasks(context.workspaceId, channel.record_id, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    for (const task of (Array.isArray(result?.tasks) ? result.tasks : [])) {
      const row = mapPgTaskToLocal(task, { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId });
      if (row.record_id) taskById.set(row.record_id, row);
    }
  }
  for (const scope of scopes.filter((entry) => entry?.record_id && entry.record_state !== 'deleted')) {
    const result = await readScopeTasks(context.workspaceId, scope.record_id, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    for (const task of (Array.isArray(result?.tasks) ? result.tasks : [])) {
      const row = mapPgTaskToLocal(task, { workspaceOwnerNpub: context.workspaceOwnerNpub, actorNpubByActorId });
      if (row.record_id) taskById.set(row.record_id, row);
    }
  }

  const tasks = mergePgHydratedTasksWithLocal([...taskById.values()], store.tasks);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceTasks(context.workspaceOwnerNpub, tasks);
  return tasks;
}

export async function hydrateTowerPgTaskComments(store, taskId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const recordId = trimText(taskId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !recordId) return [];
  const readTaskComments = deps.getTowerPgTaskComments || getTowerPgTaskComments;
  const replaceComments = deps.replacePgCommentsForTarget || replacePgCommentsForTarget;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await readTaskComments(context.workspaceId, recordId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const comments = (Array.isArray(result?.comments) ? result.comments : [])
    .map((comment) => mapPgTaskCommentToLocal(comment, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      actorNpubByActorId,
    }))
    .filter((comment) => comment.record_id && comment.target_record_id);
  const currentContext = resolveTowerPgWorkspaceContext(store);
  if (
    currentContext.workspaceId !== context.workspaceId
    || currentContext.workspaceOwnerNpub !== context.workspaceOwnerNpub
    || currentContext.baseUrl !== context.baseUrl
  ) {
    return comments;
  }
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceComments(recordId, comments);
  return comments;
}

export async function hydrateTowerPgDocComments(store, docId, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const recordId = trimText(docId);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !recordId) return [];
  const isLatestHydration = beginDocCommentHydration(store, context.workspaceId, recordId);
  const readDocComments = deps.getTowerPgDocComments || getTowerPgDocComments;
  const replaceComments = deps.replacePgCommentsForTarget || replacePgCommentsForTarget;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  const result = await readDocComments(context.workspaceId, recordId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  });
  const comments = (Array.isArray(result?.comments) ? result.comments : [])
    .map((comment) => mapPgDocCommentToLocal(comment, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: '',
      actorNpubByActorId,
    }))
    .filter((comment) => comment.record_id && comment.target_record_id);
  const currentContext = resolveTowerPgWorkspaceContext(store);
  if (
    !isLatestHydration()
    || currentContext.workspaceId !== context.workspaceId
    || currentContext.workspaceOwnerNpub !== context.workspaceOwnerNpub
    || currentContext.baseUrl !== context.baseUrl
  ) {
    return comments;
  }
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceComments(recordId, comments);
  return comments;
}

export async function hydrateTowerPgDailyNotes(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readDailyNotes = deps.getTowerPgDailyNotes || getTowerPgDailyNotes;
  const replaceDailyNotes = deps.replaceDailyNotesForOwner || replaceDailyNotesForOwner;
  const result = await readDailyNotes(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    noteDate: deps.noteDate || null,
    limit: deps.limit || 30,
  });
  const dailyNotes = (Array.isArray(result?.daily_notes) ? result.daily_notes : [])
    .map((note) => mapPgDailyNoteToLocal(note, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((note) => note.record_id);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceDailyNotes(context.workspaceOwnerNpub, dailyNotes);
  return dailyNotes;
}

export async function hydrateTowerPgPersonalWapps(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const ownerActorId = currentPgActorId(store);
  const readPersonalWapps = deps.getTowerPgPersonalWapps || getTowerPgPersonalWapps;
  const replacePersonalWapps = deps.replacePgPersonalWappsForOwner || replacePgPersonalWappsForOwner;
  const result = await readPersonalWapps(context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    ownerActorId: ownerActorId || null,
    limit: 100,
  });
  const targetOwnerActorId = ownerActorId || trimText(result?.personal_wapps?.[0]?.owner_actor_id);
  const personalWapps = (Array.isArray(result?.personal_wapps) ? result.personal_wapps : [])
    .map((wapp) => mapPgPersonalWappToLocal(wapp, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
    .filter((wapp) => wapp.record_id && wapp.launch_url);
  if (targetOwnerActorId) {
    assertTowerPgWorkspaceCurrent(store, context);
    await replacePersonalWapps(targetOwnerActorId, personalWapps);
  }
  return personalWapps;
}

export async function hydrateTowerPgWappPublishingGrants(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl) return [];
  const readGrants = deps.getTowerPgWappPublishingGrants || getTowerPgWappPublishingGrants;
  const replaceGrants = deps.replaceWappPublishingGrants || replaceWappPublishingGrants;
  const result = await readGrants(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub });
  const sourceRows = Array.isArray(result?.grants)
    ? result.grants
    : (Array.isArray(result?.installations) ? result.installations : []);
  const grants = sourceRows.map(mapPgWappPublishingGrantToLocal).filter((grant) => grant.wapp_installation_id);
  const currentContext = resolveTowerPgWorkspaceContext(store);
  if (currentContext.workspaceId !== context.workspaceId || currentContext.baseUrl !== context.baseUrl) return grants;
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceGrants(grants);
  return grants;
}

export async function hydrateTowerPgWappActivity(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.baseUrl) return { items: [], counts: {}, mutes: [] };
  const readItems = deps.getTowerPgWappActivityItems || getTowerPgWappActivityItems;
  const readMutes = deps.getTowerPgWappActivityMutes || getTowerPgWappActivityMutes;
  const replaceItems = deps.replaceWappActivityItems || replaceWappActivityItems;
  const replaceMutes = deps.replaceWappActivityMutes || replaceWappActivityMutes;
  const sourceRows = await readAllTowerPgWappActivityItems(readItems, context.workspaceId, {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
    limit: deps.limit || 100,
    includeResolved: true,
  });
  const items = sourceRows.map(mapPgWappActivityItemToLocal);
  const muteResult = await readMutes(context.workspaceId, { baseUrl: context.baseUrl, appNpub: context.appNpub });
  const mutes = (Array.isArray(muteResult?.mutes) ? muteResult.mutes : [])
    .map(mapPgWappActivityMuteToLocal)
    .filter((mute) => mute.target_type && mute.target_value);
  const currentContext = resolveTowerPgWorkspaceContext(store);
  const counts = {
    unread: items.filter((item) => item?.unread === true && !item?.dismissed_at && item?.muted !== true).length,
  };
  if (currentContext.workspaceId !== context.workspaceId || currentContext.baseUrl !== context.baseUrl) {
    return { items, counts, mutes };
  }
  assertTowerPgWorkspaceCurrent(store, context);
  await Promise.all([replaceItems(items, { authoritative: true }), replaceMutes(mutes)]);
  return { items, counts, mutes };
}

export async function hydrateTowerPgDocumentsAndFiles(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readDocs = deps.getTowerPgChannelDocs || getTowerPgChannelDocs;
  const readFiles = deps.getTowerPgChannelFiles || getTowerPgChannelFiles;
  const readFolders = deps.getTowerPgChannelFileFolders || getTowerPgChannelFileFolders;
  const replaceDocuments = deps.replaceDocumentsForOwner || replaceDocumentsForOwner;
  const replaceFolders = deps.replaceFileFoldersForWorkspace || replaceFileFoldersForWorkspace;
  let channels = Array.isArray(store.channels) ? store.channels : [];
  if (channels.length === 0 && typeof store.refreshChannels === 'function') {
    const refreshed = await store.refreshChannels();
    channels = Array.isArray(refreshed) ? refreshed : (Array.isArray(store.channels) ? store.channels : []);
  }

  const documents = [];
  const fileFolders = [];
  for (const channel of channels.filter((entry) => entry?.record_id && entry.record_state !== 'deleted')) {
    const [docsResult, filesResult, foldersResult] = await Promise.all([
      readDocs(context.workspaceId, channel.record_id, { baseUrl: context.baseUrl, appNpub: context.appNpub }),
      readFiles(context.workspaceId, channel.record_id, { baseUrl: context.baseUrl, appNpub: context.appNpub }),
      readFolders(context.workspaceId, channel.record_id, { baseUrl: context.baseUrl, appNpub: context.appNpub }),
    ]);
    const docRows = (Array.isArray(docsResult?.docs) ? docsResult.docs : [])
      .map((doc) => mapPgDocToLocal(doc, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
      .filter((doc) => doc.record_id);
    documents.push(
      ...docRows,
      ...(Array.isArray(filesResult?.files) ? filesResult.files : [])
        .map((file) => mapPgFileToLocalDocument(file, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
        .filter((doc) => doc.record_id),
    );
    fileFolders.push(
      ...(Array.isArray(foldersResult?.folders) ? foldersResult.folders : [])
        .map(mapPgFileFolderToLocal)
        .filter((folder) => folder.record_id),
    );
  }

  assertTowerPgWorkspaceCurrent(store, context);
  await replaceDocuments(context.workspaceOwnerNpub, documents);
  assertTowerPgWorkspaceCurrent(store, context);
  await replaceFolders(context.workspaceId, fileFolders);
  return documents;
}

export async function hydrateTowerPgAudioNotes(store, deps = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) return [];
  const readAudioNotes = deps.getTowerPgChannelAudioNotes || getTowerPgChannelAudioNotes;
  const replaceAudioNotes = deps.replaceAudioNotesForOwner || replaceAudioNotesForOwner;
  const actorNpubByActorId = await resolveActorNpubByActorIdWithFallback(store, deps, context);
  let channels = Array.isArray(store.channels) ? store.channels : [];
  if (channels.length === 0 && typeof store.refreshChannels === 'function') {
    const refreshed = await store.refreshChannels();
    channels = Array.isArray(refreshed) ? refreshed : (Array.isArray(store.channels) ? store.channels : []);
  }

  const audioNotes = [];
  for (const channel of channels.filter((entry) => entry?.record_id && entry.record_state !== 'deleted')) {
    const result = await readAudioNotes(context.workspaceId, channel.record_id, {
      baseUrl: context.baseUrl,
      appNpub: context.appNpub,
    });
    audioNotes.push(
      ...(Array.isArray(result?.audio_notes) ? result.audio_notes : [])
        .map((audioNote) => mapPgAudioNoteToLocal(audioNote, {
          workspaceOwnerNpub: context.workspaceOwnerNpub,
          senderNpub: '',
          actorNpubByActorId,
        }))
        .filter((audioNote) => audioNote.record_id),
    );
  }

  assertTowerPgWorkspaceCurrent(store, context);
  await replaceAudioNotes(context.workspaceOwnerNpub, audioNotes);
  return audioNotes;
}


// Structure recovery is exclusively the canonical workspace worker. This typed
// read provides capabilities and an ACL check, never a competing list snapshot.
export async function loadTowerPgContext(store, scopeId, options = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const service = store.getTowerSyncService();
  const db = getWorkspaceDb();
  const guard = () => {
    service.assertActive();
    if (getWorkspaceDb() !== db) throw new Error('Context workspace changed');
  };
  guard();
  await db.context_coverage.put({ scope_id: scopeId, workspace_id: context.workspaceId, status: 'loading' });
  try {
    const result = await requestTowerPgContext(context.workspaceId, scopeId, '?limit=1', {
      baseUrl: context.baseUrl, appNpub: context.appNpub,
    });
    guard();
    await store.runTowerPgWorkspaceSync(options);
    guard();
    const coverage = await db.context_coverage.get(scopeId);
    if (coverage?.status !== 'complete') throw new Error('Context record recovery is unavailable or incomplete');
    await db.context_coverage.put({ ...coverage, capabilities: result.capabilities });
    return { scopeId, status: 'complete', capabilities: result.capabilities };
  } catch (error) {
    guard();
    const denied = isContextAccessDenied(error);
    await db.transaction('rw', db.context_components, db.context_references, db.context_coverage, db.context_reference_resolutions, async () => {
      if (denied) {
        await db.context_components.where('scope_id').equals(scopeId).delete();
        await db.context_references.where('scope_id').equals(scopeId).delete();
        await db.context_reference_resolutions.where('scope_id').equals(scopeId).delete();
      }
      await db.context_coverage.put({ scope_id: scopeId, workspace_id: context.workspaceId, status: denied ? 'denied' : 'error' });
    });
    throw error;
  }
}

export async function readTowerPgContextDeletePreview(store, scopeId, componentId) {
  const context = resolveTowerPgWorkspaceContext(store);
  return requestTowerPgContext(context.workspaceId, scopeId, `/${encodeURIComponent(componentId)}/delete-preview`, {
    baseUrl: context.baseUrl, appNpub: context.appNpub,
  });
}


// Only the ACL-checked reference route can supply target titles. Identifiers in
// record-delta and SSE hints never serve as target access or resolution.
export async function loadTowerPgContextReferences(store, scopeId, componentId) {
  const context = resolveTowerPgWorkspaceContext(store), db = getWorkspaceDb();
  const service = store.getTowerSyncService();
  const guard = () => { service.assertActive(); if (getWorkspaceDb() !== db) throw new Error('Context workspace changed'); };
  guard();
  await db.context_reference_resolutions.where('component_id').equals(componentId).delete();
  let cursor = null; const references = [], seen = new Set();
  do {
    const suffix = `/${encodeURIComponent(componentId)}/references?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result = await requestTowerPgContext(context.workspaceId, scopeId, suffix, { baseUrl: context.baseUrl, appNpub: context.appNpub });
    guard(); references.push(...result.references); cursor = result.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error('Repeated context reference cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  guard();
  await db.transaction('rw', db.context_references, db.context_reference_resolutions, async () => {
    await db.context_reference_resolutions.where('component_id').equals(componentId).delete();
    for (const row of references) {
      const cached = await db.context_references.get(row.id);
      if (cached?.workspace_id === context.workspaceId && cached.scope_id === scopeId && cached.row_version === row.row_version) {
        await db.context_reference_resolutions.put({ record_id: row.id, workspace_id: context.workspaceId, scope_id: scopeId,
          component_id: componentId, row_version: row.row_version, resolution: row.resolution || { status: 'unavailable' } });
      }
    }
  });
  return { componentId, complete: true };
}
