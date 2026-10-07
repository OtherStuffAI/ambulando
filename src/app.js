import { subscribedReaderMixin } from './feed/reader-manager.js';
import { driveManagerMixin } from './drive.js';
import { registerChatComposer, resolveChatUploadToken } from './chat-composer-draft.js';
/**
 * Alpine.js app store — the single source of reactive UI state.
 * All data comes from Dexie; network goes through the sync worker.
 *
 * Responsibility inventory:
 * - App bootstrap, route sync, auth/session setup, and top-level shell state.
 * - Section navigation and release of inactive section data.
 * - Remaining document/report/status/task orchestration that has not yet moved
 *   to a feature manager.
 * - Daily Scope, personal WApps, invocation modals, schedules, and
 *   cross-section glue.
 *
 * Extracted ownership notes:
 * - Chat messages/threads belong in chat-message-manager.js.
 * - Channels/settings belong in channels-manager.js.
 * - Docs editor and doc lifecycle belong in docs-manager.js and docs/editor/*.
 * - Files, storage image hydration, audio recording, reactions, people profiles,
 *   reports, notifications, workspace switching, sync, unread state, command
 *   palette, task board state, task detail, task comments, and section live
 *   queries each have matching manager/helper modules imported below.
 * - New feature code should go into the relevant manager/helper first. Add to
 *   this file only when the behavior is truly cross-cutting app glue.
 */

import Alpine from 'alpinejs';
import { liveQuery } from 'dexie';
import {
  CHAT_PRESENTATION_ROOT_LIMIT,
  createChatPresentationCache,
} from './chat-presentation-cache.js';
import { diffLines } from 'diff';
import { commentBelongsToDocBlock } from './doc-comment-anchors.js';
import { docsManagerMixin } from './docs-manager.js';
import {
  formatDocTableDateTime,
  nextDocTableSort,
  normalizeDocTableTimestamp,
  sortDocBrowserRows,
} from './docs-table.js';
import { scopeAccessManagerMixin } from './scope-access-manager.js';
import { scopesManagerMixin } from './scopes-manager.js';
import { channelsManagerMixin } from './channels-manager.js';
import { audioRecordingManagerMixin } from './audio-recording-manager.js';
import { storageImageManagerMixin } from './storage-image-manager.js';
import { jobsManagerMixin } from './jobs-manager.js';
import { workspaceManagerMixin, guessDefaultBackendUrl } from './workspace-manager.js';
import { chatMessageManagerMixin } from './chat-message-manager.js';
import { readAloudManagerMixin } from './read-aloud.js';
import { reactionsManagerMixin } from './reactions-manager.js';
import { syncManagerMixin } from './sync-manager.js';
import { peopleProfilesManagerMixin } from './people-profiles-manager.js';
import { connectSettingsManagerMixin } from './connect-settings-manager.js';
import { normalizedAutopilotLaunchUrl } from './autopilot-agents.js';
import { fetchDocumentAgentSessions } from './document-agent-sessions.js';
import { workspaceSelfIndexManagerMixin } from './workspace-self-index-manager.js';
import { onboardingAnnouncementsManagerMixin } from './onboarding-announcements-manager.js';
import { unreadStoreMixin } from './unread-store.js';
import { reportsManagerMixin } from './reports-manager.js';
import { filesManagerMixin } from './files-manager.js';
import { writeContextManagerMixin } from './write-context-manager.js';
import { autopilotOverviewManagerMixin } from './autopilot-overview-manager.js';
import { pipelineViewerManagerMixin } from './pipeline-viewer-manager.js';
import { agentSpaceManagerMixin } from './agent-space-manager.js';
import { threadLiveActivityManagerMixin } from './thread-live-activity-manager.js';
import { resolveDeckInboxEnabled } from './deck-inbox-preference.js';
import { resolveMyFocusEnabled } from './my-focus-preference.js';
import { notificationsManagerMixin } from './notifications-manager.js';
import { wappImageManagerMixin } from './wapp-image-manager.js';
import { wappPublishingManagerMixin } from './wapp-publishing-manager.js';
import { wappManagementManagerMixin } from './wapp-management-manager.js';
import { taskDetailManagerMixin } from './task-detail-manager.js';
import { withTaskActivityAuthor } from './task-attention-actor.js';
import { openTaskLinkFromChat } from './task-link-navigation.js';
import { beginInternalReferenceVisit, resolveInternalReference, rememberReferenceComposerDraft } from './internal-reference-navigation.js';
import {
  mapPgDailyNoteToLocal,
  mapPgPersonalWappToLocal,
  resolveTowerPgWorkspaceContext,
} from './pg-read-hydrator.js';
import {
  createTowerPgTaskFromLocal,
  deleteTowerPgDocFromLocal,
  deleteTowerPgTaskFromLocal,
  updateTowerPgTaskFromLocal,
} from './tower-command-intents.js';
import {
  isOnlineForPgEdit,
  isSyncedPgRecord,
  isUnsyncedLocalPgRecord,
  releasePgEditLeaseForRecord,
} from './pg-edit-session.js';
import { createShellState, detachLoggedOutWorkspace } from './shell-state.js';
import {
  checkoutErrorMessage,
  describeCheckoutHolder,
  formatLeaseRemaining,
  isCheckoutHeld,
} from './lock-managed-records.js';
import { FLIGHT_DECK_RECORD_CHECKOUT_POLICY_CONFIG } from './record-checkout-policy.js';
import {
  getTaskFlowInfo,
  buildAttachFlowPatch,
  buildDetachFlowPatch,
  findTaskForFlowRunStep,
} from './task-flow-helpers.js';
import {
  buildPredecessorTaskSuggestions,
  describePredecessorRelationship,
  getTaskPredecessorReferenceRows,
  normalizePredecessorTaskIds,
} from './task-predecessor-helpers.js';
import {
  taskBoardStateMixin,
  calculateTaskBoardOrderForInsertion,
  getTaskDropRecordId,
  buildTaskBoardReorderPatches,
  dedupeTasksByRecordId,
  ALL_TASK_BOARD_ID,
  RECENT_TASK_BOARD_ID,
  UNSCOPED_TASK_BOARD_ID,
  normalizeTaskAssigneeNpubs,
  normalizeTaskSortMode,
  WEEKDAY_OPTIONS,
} from './task-board-state.js';
import { renderDeckCardTextToHtml, renderMarkdownToHtml } from './markdown.js';
import {
  canonicalActorMentions,
  composerCaretOffset,
  composerMentionQueryAtSelection,
  insertMentionAtComposerSelection,
  createMentionPill,
  hydrateMentionComposer,
  insertPlainTextAtSelection,
  removeAdjacentMentionPill,
  replaceComposerTextRange,
  serializeMentionComposer,
  serializeMentionComposerState,
} from './mention-composer.js';
import { createRecentActorMentionResolver } from './recent-mentions.js';
import { resolveChannelLabel, resolveChannelParticipants } from './channel-labels.js';
import { isDmChannel } from './dm-scope.js';
import { buildFlightDeckDocumentTitle } from './page-title.js';
import {
  blockDisabledFlightDeckSurface,
  isFlightDeckSurfaceDisabled,
  normalizeEnabledFlightDeckSection,
} from './disabled-surfaces.js';
import { getRunningBuildId } from './version-check.js';
import { filterDocItemsByScope } from './docs-scope-filter.js';
import { sectionLiveQueryMixin } from './section-live-queries.js';
import {
  applySelectedDocumentUpdate,
  documentLinkViewState,
  preserveHydratedDocumentContent,
} from './document-selection.js';
import { createChatThreadFlowDispatchState } from './chat-thread-flow-dispatch.js';
import { createChatGetItDoneState } from './chat-get-it-done.js';
import { commandPaletteMixin, createCommandPaletteState } from './command-palette.js';
import { buildAttentionFeed, buildTimingFeed, summarizeAttentionFeed } from './attention-feed.js';
import { avatarStatusMixin } from './components/avatar-status.js';
import { loadTiptapEditorAdapter } from './docs/editor/lazy-tiptap-editor.js';
import { createDailyNoteTiptapToolbar } from './docs/editor/tiptap-toolbar.js';
import {
  toRaw,
  normalizeBackendUrl,
  workspaceSettingsRecordId,
  storageObjectIdFromRef,
  storageImageCacheKey,
  defaultRecordSignature,
  sameListBySignature,
  parseMarkdownBlocks,
} from './utils/state-helpers.js';

import { getShortNpub, getInitials } from './utils/naming.js';
import {
  getSettings,
  saveSettings,
  getWorkspaceSettings,
  upsertWorkspaceSettings,
  getCachedStorageImage,
  cacheStorageImage,
  getChannelsByOwner,
  getMessagesByChannel,
  getRecentChatMessagesSince,
  getRecentDocumentChangesSince,
  getRecentDirectoryChangesSince,
  getRecentReportChangesSince,
  getRecentTaskChangesSince,
  getRecentScheduleChangesSince,
  getRecentCommentsSince,
  getRecentScopeChangesSince,
  getRecentFlowChangesSince,
  upsertChannel,
  getAudioNotesByOwner,
  getDocumentsByOwner,
  getReportsByOwner,
  getReportById,
  upsertDocument,
  getDocumentById,
  getDirectoriesByOwner,
  upsertDirectory,
  getDirectoryById,
  getTasksByOwner,
  upsertTask,
  replaceTaskRecordId,
  getTaskById,
  getSchedulesByOwner,
  upsertSchedule,
  getScheduleById,
  upsertDailyNote,
  getScopesByOwner,
  getPendingWrites,
  removePendingWrite,
  getSyncState,
  setSyncState,
  deleteSyncState,
  getChannelById,
  getAddressBookPeople,
  isWorkspaceDbOpenForKey,
} from './db.js';
import {
  registerWorkspaceKey,
  setBaseUrl,
  prepareStorageObject,
  prepareTowerPgStorageObject,
  getTowerPgInvocations,
  getTowerPgDailyNoteVersions,
  getTowerPgDailyScopeAgentAccess,
  uploadStorageObject,
  completeStorageObject,
} from './api.js';
import {
  createTowerPgInvocation,
  createTowerPgPersonalWapp,
  deleteTowerPgPersonalWapp,
  reorderTowerPgPersonalWapps,
  updateTowerPgPersonalWapp,
  upsertTowerPgDailyScopeAgentAccess,
  upsertTowerPgDailyNote,
  queueTowerPendingWrite,
} from './tower-command-intents.js';
import {
  outboundChannel,
  recordFamilyHash,
} from './translators/chat.js';
import {
  outboundDocument,
  outboundDirectory,
} from './translators/docs.js';
import {
  outboundTask,
} from './translators/tasks.js';
import { outboundSchedule } from './translators/schedules.js';
import {
  recordFamilyHash as taskFamilyHash,
  parseReferencesFromDescription,
  resolveFlowDispatchAssignee,
  resolveFlowLinkage,
} from './translators/tasks.js';
import {
  isTaskUnscoped,
  matchesTaskBoardScope,
} from './task-board-scopes.js';
import {
  buildRecordLinkPayload,
  mergeRecordLinkLists,
  normalizeRecordLinkType,
} from './record-links.js';
import {
  buildCascadedSubtaskUpdate,
} from './task-scope-cascade.js';
import {
  getPendingRecordBaseVersion,
  getPendingRecordWrites,
  hasPendingRecordWrite,
  isTaskBlockedByPendingSave,
  markTaskEditSyncedAfterAcceptedFlush,
} from './task-save-helpers.js';
import {
  filterSelectableTaskIds,
  getSelectableColumnTaskIds,
  toggleColumnTaskSelection,
} from './task-selection-helpers.js';
import { parseSuperBasedToken } from './superbased-token.js';
import {
  signLoginEvent,
  getPubkeyFromEvent,
  pubkeyToNpub,
  tryAutoLoginFromStorage,
  clearAutoLogin,
  setAutoLogin,
  hasExtensionSigner,
  waitForExtensionSigner,
} from './auth/nostr.js';
import {
  bootstrapWrappedGroupKeys,
  clearCryptoContext,
  setActiveSessionNpub,
  wrapKnownGroupKeyForMember,
} from './crypto/group-keys.js';
import {
  getEncryptableRecordGroupRefsForStore,
  getRecordWriteFieldsForStore,
} from './preferred-write-group.js';
import {
  bootstrapWorkspaceSessionKey,
  clearActiveWorkspaceKey,
  getActiveWorkspaceKeyNpub,
  markCachedWorkspaceKeyRegistered,
  markWorkspaceKeyRegistered,
} from './crypto/workspace-keys.js';
import { findWorkspaceById, findWorkspaceByKey, mergeWorkspaceEntries, workspaceFromToken, findWorkspaceBySlug } from './workspaces.js';
import { buildSectionUrl, parseRouteLocation } from './route-helpers.js';
import { extractInviteToken } from './invite-link.js';
import {
  buildStoragePrepareBody,
} from './storage-payloads.js';
import { flightDeckLog } from './logging.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import {
  buildPgChannelTaskBoardId,
  parsePgTaskBoardId,
} from './pg-record-context.js';
import { createTowerPgFileFromLocal } from './tower-command-intents.js';
import {
  createWorkroomCreationState,
  workroomCreationMixin,
  workroomVisibleParticipantNpubs,
} from './workroom-creation-manager.js';
import { createWorkroomDetailState, workroomDetailMixin } from './workroom-detail-manager.js';
import { createRecordTransferState, recordTransferManagerMixin } from './record-transfer-manager.js';

const markdownRenderCaches = new WeakMap();

function renderMarkdownCached(store, source, inlineReferences) {
  let cache = markdownRenderCaches.get(store);
  if (!cache) {
    cache = new Map();
    markdownRenderCaches.set(store, cache);
  }
  const key = JSON.stringify([String(source || ''), inlineReferences]);
  if (cache.has(key)) return cache.get(key);
  const rendered = renderMarkdownToHtml(source, { inlineReferences });
  cache.set(key, rendered);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return rendered;
}

// Constants UNSCOPED_TASK_BOARD_ID, WEEKDAY_OPTIONS imported from task-board-state.js


/**
 * Merge mixin objects into a target, preserving getters/setters as accessors
 * instead of evaluating them (which plain object spread does).
 */
function applyMixins(target, ...mixins) {
  for (const mixin of mixins) {
    const descriptors = Object.getOwnPropertyDescriptors(mixin);
    Object.defineProperties(target, descriptors);
  }
  return target;
}

function documentRecordSignature(document = {}) {
  return [
    defaultRecordSignature(document),
    String(document?.title || ''),
    String(document?.content || ''),
    String(document?.content_storage_object_id || ''),
    String(document?.content_sha256_hex || ''),
    String(document?.content_storage_status || ''),
    String(document?.content_storage_error || ''),
  ].join('|');
}

const NUMBER_FORMATTER = new Intl.NumberFormat();
const RECENT_ACTOR_MENTION_RESOLVERS = new WeakMap();
const MENTION_PEOPLE_CACHE = new WeakMap();
const MENTION_COMPOSER_MODELS = new WeakMap();
const MENTION_COMPOSER_ELEMENTS = new WeakMap();
const MENTION_DOCUMENT_INDEX_MAX_AGE_MS = 30_000;
const PG_TASK_WRITE_QUEUE_SYNC_STATE_KEY = 'pg_task_write_queue:v1';
const PG_TASK_WRITE_BATCH_SIZE = 6;
const PG_TASK_DETAIL_DRAFT_PREFIX = 'pg_task_detail_draft:v1:';
const PG_TASK_DETAIL_DRAFT_AUTOSAVE_MS = 700;
const MAX_STATUS_RECENT_CHANGES = 50;
const STATUS_RECORD_TYPE_LABELS = Object.freeze({
  chat: 'Chat',
  task: 'Task',
  comment: 'Comment',
  doc: 'Doc',
  folder: 'Folder',
  report: 'Report',
  schedule: 'Schedule',
  scope: 'Scope',
  flow: 'Flow',
});
const STATUS_RECORD_TYPE_ORDER = Object.freeze([
  'task',
  'chat',
  'comment',
  'doc',
  'scope',
  'flow',
  'folder',
  'report',
  'schedule',
]);
const scopedReportsCache = new WeakMap();
const reportTimeseriesCache = new WeakMap();
const reportTableColumnsCache = new WeakMap();

function taskDetailDraftKey(recordId) {
  const clean = String(recordId || '').trim();
  return clean ? `${PG_TASK_DETAIL_DRAFT_PREFIX}${clean}` : '';
}

function normalizeTaskDraftPayload(task = {}) {
  if (!task?.record_id) return null;
  return {
    title: String(task.title || ''),
    description: String(task.description || ''),
    state: String(task.state || 'new'),
    priority: String(task.priority || 'sand'),
    scheduled_for: task.scheduled_for || null,
    tags: String(task.tags || ''),
    assigned_to_npubs: normalizeTaskAssigneeNpubs(task),
    predecessor_task_ids: normalizePredecessorTaskIds(task.predecessor_task_ids || [], task.record_id),
    scope_id: task.scope_id ?? null,
    scope_l1_id: task.scope_l1_id ?? null,
    scope_l2_id: task.scope_l2_id ?? null,
    scope_l3_id: task.scope_l3_id ?? null,
    scope_l4_id: task.scope_l4_id ?? null,
    scope_l5_id: task.scope_l5_id ?? null,
    scope_policy_group_ids: Array.isArray(task.scope_policy_group_ids) ? [...task.scope_policy_group_ids] : null,
    board_group_id: task.board_group_id ?? null,
    shares: Array.isArray(task.shares) ? toRaw(task.shares) : [],
    group_ids: Array.isArray(task.group_ids) ? [...task.group_ids] : [],
    flow_id: task.flow_id ?? null,
    flow_run_id: task.flow_run_id ?? null,
    flow_step: task.flow_step ?? null,
    source_links: Array.isArray(task.source_links) ? toRaw(task.source_links) : [],
    references: Array.isArray(task.references) ? toRaw(task.references) : [],
    deliverable_links: Array.isArray(task.deliverable_links) ? toRaw(task.deliverable_links) : [],
  };
}

function taskDraftSignature(task = {}) {
  return JSON.stringify(normalizeTaskDraftPayload(task) || {});
}

function getScopedReportsCacheEntry(store) {
  const existing = scopedReportsCache.get(store);
  if (existing) return existing;
  const created = {
    reports: null,
    selectedBoardId: '',
    selectedBoardScopeId: '',
    value: [],
  };
  scopedReportsCache.set(store, created);
  return created;
}

function getReportDerivedCache(cacheStore, store) {
  const existing = cacheStore.get(store);
  if (existing) return existing;
  const created = new Map();
  cacheStore.set(store, created);
  return created;
}

function createPgTaskWriteQueueId(recordId = '') {
  const prefix = String(recordId || 'task').trim() || 'task';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizePgTaskWriteQueue(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const recordId = String(item?.recordId || item?.updatedTask?.record_id || '').trim();
      if (!recordId || !item?.updatedTask || !item?.previousTask) return null;
      return {
        queueId: String(item.queueId || createPgTaskWriteQueueId(recordId)),
        recordId,
        updatedTask: toRaw(item.updatedTask),
        previousTask: toRaw(item.previousTask),
        patch: toRaw(item.patch || {}),
        options: toRaw(item.options || {}),
        createdAt: item.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function selectPgTaskWriteBatch(queue = [], size = PG_TASK_WRITE_BATCH_SIZE) {
  const seenRecordIds = new Set();
  const batch = [];
  for (const item of normalizePgTaskWriteQueue(queue)) {
    if (seenRecordIds.has(item.recordId)) continue;
    seenRecordIds.add(item.recordId);
    batch.push(item);
    if (batch.length >= size) break;
  }
  return batch;
}

function removePgTaskWriteQueueItems(queue = [], queueIds = new Set()) {
  return normalizePgTaskWriteQueue(queue).filter((item) => !queueIds.has(item.queueId));
}

function mergeTaskIntoList(tasks = [], nextTask) {
  const recordId = String(nextTask?.record_id || '').trim();
  if (!recordId) return Array.isArray(tasks) ? [...tasks] : [];
  const current = Array.isArray(tasks) ? tasks : [];
  const existingIndex = current.findIndex((task) => task?.record_id === recordId);
  if (existingIndex === -1) return [...current, nextTask];
  const merged = [...current];
  merged[existingIndex] = nextTask;
  return merged;
}

async function replaceLocalTaskWithAcceptedPgTask(store, localRecordId, acceptedTask) {
  const previousId = String(localRecordId || '').trim();
  const acceptedId = String(acceptedTask?.record_id || '').trim();
  if (!acceptedId) return acceptedTask;
  await replaceTaskRecordId(previousId, acceptedTask);
  store.tasks = mergeTaskIntoList(
    (Array.isArray(store.tasks) ? store.tasks : []).filter((task) => task?.record_id !== previousId),
    acceptedTask,
  );
  if (store.activeTaskId === previousId) store.activeTaskId = acceptedId;
  if (store.editingTask?.record_id === previousId) {
    store.editingTask = { ...acceptedTask };
    store.taskEditOriginal = { ...acceptedTask };
    store.taskDraftDirty = false;
    store.taskDraftSaveState = '';
    store.taskDraftRemoteChanged = false;
    store.destroyTaskRichDescriptionEditor?.();
  }
  if (Array.isArray(store.selectedTaskIds)) {
    store.selectedTaskIds = [...new Set(store.selectedTaskIds.map((taskId) => taskId === previousId ? acceptedId : taskId))];
  }
  return acceptedTask;
}

export function initApp() {
  const initialRoute = typeof window === 'undefined'
    ? { section: 'status' }
    : parseRouteLocation();
  const storeObj = {
    ...createRecordTransferState(),
    ...createWorkroomCreationState(),
    ...createWorkroomDetailState(),
    FAST_SYNC_MS: 15000,
    IDLE_SYNC_MS: 30000,
    SSE_HEARTBEAT_CADENCE_MS: 60000,
    BACKGROUND_GROUP_REFRESH_MS: 5 * 60 * 1000,
    GROUP_KEY_REFRESH_MAX_AGE_MS: 24 * 60 * 60 * 1000,
    MAIN_FEED_PAGE_SIZE: CHAT_PRESENTATION_ROOT_LIMIT,
    MESSAGE_PREVIEW_MAX_LINES: 15,
    TASK_COMMENT_PREVIEW_MAX_LINES: 12,
    COMPOSER_MAX_LINES: 5,
    THREAD_REPLY_PAGE_SIZE: 6,

    // settings
    appBuildId: getRunningBuildId(),
    backendUrl: '',
    ownerNpub: '',
    botNpub: '',
    session: null,
    get signingNpub() {
      if (isTowerPgBackendMode()) return this.session?.npub || null;
      return getActiveWorkspaceKeyNpub() || this.session?.npub || null;
    },
    settingsTab: 'connection',
    navSection: initialRoute.section,
    navCollapsed: true,
    mobileNavOpen: false,
    appHeaderHidden: false,
    routeSyncPaused: false,
    myFocusEnabled: false,
    popstateHandler: null,
    showAvatarMenu: false,
    showChannelSettingsModal: false,
    channelSettingsName: '',
    channelRenameSaving: false,
    deletingScopeId: null,
    scopeDeleteConfirmation: null,
    scopeDeleteNotice: '',
    scopeDeleteError: '',
    channelDeleteConfirmArmed: false,
    channelGrants: [],
    channelGrantsChannelId: null,
    channelGrantsLoading: false,
    channelGrantsSaving: false,
    channelGrantsError: null,
    channelGrantsNotice: '',
    channelGrantPrincipalType: 'actor',
    channelGrantActorId: '',
    channelGrantGroupId: '',
    channelGrantCapacity: 'viewer',
    channelBulkGrantPrincipalType: 'group',
    channelBulkGrantActorId: '',
    channelBulkGrantGroupId: '',
    channelBulkGrantCapacity: 'contributor',
    channelBulkGrantSelectedChannelIds: [],
    channelBulkGrantBusy: false,
    channelBulkGrantProgress: '',
    presetConnecting: false,
    // Connect modal (two-step)
    showConnectModal: false,
    connectStep: 1,
    connectPgOnboardingStep: 1,
    connectPgSelectedScopeIndex: 0,
    connectPgNewScopeName: '',
    connectPgNewChannelName: '',
    connectHostUrl: '',
    connectHostLabel: '',
    connectHostServiceNpub: '',
    connectHostTowerName: '',
    connectHostTowerDescription: '',
    connectHostError: null,
    connectHostBusy: false,
    connectManualUrl: '',
    connectWorkspaces: [],
    connectWorkspacesBusy: false,
    connectWorkspacesError: null,
    connectWorkspaceRequestDiagnostics: null,
    connectNewWorkspaceName: '',
    connectNewWorkspaceDescription: '',
    connectCreatingWorkspace: false,
    connectHostedConfig: null,
    connectHostedIntent: null,
    connectHostedPhase: 'idle',
    connectPgBootstrapTemplateId: 'company',
    connectPgBootstrapTemplates: [],
    connectPgBootstrapProgress: {
      active: false,
      phase: 'idle',
      label: '',
      completed: 0,
      total: 0,
      error: '',
    },
    connectTokenInput: '',
    connectShowTokenFallback: false,
    knownHosts: [],
    showAgentConnectModal: false,
    syncStatus: 'synced',
    syncSession: {
      state: 'synced',
      phase: 'idle',
      startedAt: null,
      finishedAt: null,
      lastSuccessAt: null,
      manual: false,
      currentFamily: null,
      currentFamilyHash: null,
      completedFamilies: 0,
      totalFamilies: 0,
      pushed: 0,
      pushTotal: 0,
      pulled: 0,
      heartbeat: false,
      error: null,
    },
    syncFamilyProgress: [],
    showSyncProgressModal: false,
    hasForcedInitialBackfill: false,
    hasForcedTaskFamilyBackfill: false,
    backgroundSyncTimer: null,
    backgroundSyncInFlight: false,
    syncBackoffMs: 0,
    sseStatus: 'disconnected',
    towerReachabilityState: 'online',
    towerFallbackReachable: false,
    towerReachabilityReason: '',
    towerReachabilityConnectionKey: '',
    offlineMessageResyncArmed: false,
    offlineMessageResyncConnectionKey: '',
    offlineMessageResyncScheduled: false,
    offlineMessageResyncTimer: null,
    offlineMessageResyncIdleHandle: null,
    offlineMessageResyncReason: '',
    offlineMessageLastResult: null,
    agentActivityRecoveryStartedAt: 0,
    agentActivityRecoveryError: '',
    agentActivityRecoveryAttempts: 0,
    agentActivityRecoveryPending: false,
    agentActivityHistoryLoads: {},
    agentActivityRunsLoads: {},
    agentActivityDetailsContext: null,
    catchUpSyncActive: false,
    applicationAssetError: null,
    startupSyncProgress: {
      active: false, visible: false, stage: 'idle', startedAt: null, elapsedMs: 0,
      page: 0, applied: 0, cursorPresent: false, fullSnapshot: false, error: null,
    },
    startupSyncProgressTimer: null,
    hasBootstrappedUnreadTracking: false,
    visibilityHandler: null,
    lastGroupsRefreshAt: 0,
    groupsLoading: false,
    groupsLoadError: null,
    docConnectorFrame: null,
    docConnectorScrollHandler: null,
    docConnectorResizeHandler: null,
    chatFeedScrollFrame: null,
    threadRepliesScrollFrame: null,
    chatPreviewMeasureFrame: null,
    taskCommentPreviewMeasureFrame: null,
    docCommentBackfillAttemptsByDocId: {},
    pendingChatScrollToLatest: false,
    pendingThreadScrollToLatest: false,
    responseActivityTick: 0,
    responseActivityTimer: null,

    // data
    channels: [],
    channelOrder: [],
    channelDragSourceId: '',
    channelDragTargetId: '',
    selectedChannelId: null,
    pendingChannelSelectionId: '',
    channelSelectionGeneration: 0,
    pendingNavigationPointer: null,
    recentNavigationTimings: [],
    chatPresentationCache: createChatPresentationCache(),
    messages: [],
    readAloudSupported: false,
    readAloudState: 'idle',
    readAloudMessageId: '',
    readAloudError: '',
    readAloudController: null,
    readAloudPageHideHandler: null,
    messageCollectionRevision: 0,
    reactionRows: [],
    channelResponseActivities: [],
    threadResponseActivities: [],
    agentActivities: [],
    agentSessionHealth: [],
    expandedAgentActivityIds: {},
    expandedAgentActivityHistoryIds: {},
    reactionPickerTargetKey: '',
    audioNotes: [],
    groups: [],
    documents: [],
    dailyNotes: [],
    dailyScopeSelectedDate: '',
    dailyScopeDatePickerOpen: false,
    dailyScopeDatePickerValue: '',
    summaryCollapsedPanels: {},
    summaryPanelPages: {},
    deckInboxEnabled: true,
    dailyNoteEditorOpen: false,
    dailyNoteEditorSaving: false,
    dailyNoteEditorError: '',
    dailyNoteEditorTitle: '',
    dailyNoteEditorBody: '',
    dailyNoteEditorFocus: '',
    dailyNoteEditorItems: [],
    dailyNoteEditorRecordId: '',
    dailyNoteEditorMode: 'preview',
    dailyNoteRichEditorAdapter: null,
    dailyNoteRichEditorToolbar: null,
    dailyNoteRichEditorMountEl: null,
    dailyNoteVersioningOpen: false,
    dailyNoteVersionHistory: [],
    dailyNoteVersioningLoading: false,
    dailyNoteVersioningError: null,
    dailyNoteVersioningSelectedIndex: -1,
    dailyNoteVersioningPreviewHtml: '',
    dailyNoteDiffMode: false,
    dailyNoteDiffHunks: [],
    dailyNoteDiffFromIndex: -1,
    dailyNoteDiffToIndex: -1,
    dailyScopeAgentAccess: [],
    dailyScopeAgentAccessSaving: false,
    directories: [],
    fileFolders: [],
    fileCurrentFolderId: '',
    fileMessages: [],
    fileComments: [],
    fileSearch: '',
    fileTypeFilter: 'all',
    fileSourceFilter: 'all',
    fileScopeFilter: 'all',
    fileChannelFilter: 'all',
    fileThreadFilter: 'all',
    fileSelectionMode: false,
    fileSelectedRowIds: [],
    fileDraggingRowIds: [],
    fileFolderDragOverId: '',
    fileUploadOpen: false,
    fileUploadItems: [],
    fileUploadError: '',
    fileUploadNotice: '',
    showFileEditModal: false,
    fileEditRow: null,
    fileEditName: '',
    fileEditScopeId: '',
    fileEditChannelId: '',
    fileEditFolderId: '',
    fileEditSubmitting: false,
    fileEditAction: '',
    fileEditProgressText: '',
    fileEditError: '',
    reports: [],
    addressBookPeople: [],
    nostrProfilesRefreshing: false,
    nostrProfilesRefreshMessage: '',
    activeThreadId: null,
    threadInput: '',
    threadMenuOpen: false,
    threadTitleEditing: false,
    threadTitleDraft: '',
    threadTitleSaving: false,
    threadTitleError: '',
    threadAudioDrafts: [],
    threadFileDrafts: [],
    threadImageUploadCount: 0,
    channelHangCallSending: false,
    channelHangCallError: '',
    channelHangCallRetryUrl: '',
    threadHangCallSending: false,
    threadHangCallError: '',
    threadHangCallRetryUrl: '',
    chatImagePreviewModal: { open: false, src: '', alt: '' },
    chatImagePreviewReturnFocus: null,
    chatImagePreviewCleanupHandler: null,
    threadVisibleReplyCount: 6,
    threadHistoryCursor: null,
    threadHistoryLoading: false,
    threadHistoryLoadAll: false,
    threadHistoryGeneration: 0,
    threadHistoryError: '',
    internalLinkOpenRequestId: 0,
    internalLinkOpening: false,
    internalLinkOpenError: '',
    linkedThreadOpenError: '',
    linkedThreadOpening: false,
    threadSize: 'default',
    focusMessageId: null,
    expandedChatMessageIds: [],
    truncatedChatMessageIds: [],
    messageActionsMenuId: null,
    messageResendPendingIds: [],
    messageEdit: {
      recordId: '',
      context: '',
      channelId: '',
      threadRootId: '',
      originalBody: '',
      draftBeforeEdit: '',
      mentionsBeforeEdit: [],
      submitting: false,
      error: '',
    },
    showArchivedChatThreads: false,
    chatThreadArchiveSubmittingId: '',
    chatThreadArchiveSubmittingAction: '',
    chatDeleteConfirm: {
      open: false,
      mode: '',
      recordId: '',
      title: '',
      message: '',
      submitting: false,
      error: '',
    },
    chatProfiles: {},
    identityCard: {
      open: false,
      npub: '',
      x: 0,
      y: 0,
      copied: false,
    },
    statusTimeRange: '1h',
    statusRecordTypeFilter: 'all',
    statusRecentChanges: [],
    reportModalReport: null,
    selectedReportId: null,
    reportActionsMenuId: '',
    reportDeleteConfirmReport: null,
    reportDeleteSubmitting: false,
    reportDeleteError: '',
    selectedDocType: null,
    selectedDocId: null,
    selectedDocCommentId: null,
    docDetailOriginRoute: '',
    chatDocModalOpen: false,
    chatDocModalTitle: '',
    chatDocModalFullScreen: false,
    docVersioningOpen: false,
    docVersionHistory: [],
    docVersioningLoading: false,
    docVersioningError: null,
    docVersioningSelectedIndex: -1,
    docVersioningPreviewHtml: '',
    flows: [],
    approvals: [],
    editingFlowId: null,
    showFlowEditor: false,
    flowDetailMode: 'view',
    flowEditOriginal: null,
    flowCheckoutPending: false,
    showFlowStartConfirm: false,
    flowStartTarget: null,
    flowStartContext: '',
    ...createChatThreadFlowDispatchState(),
    ...createChatGetItDoneState(),
    showFlowPicker: false,
    showApprovalDetail: false,
    activeApprovalId: null,
    approvalDecisionNote: '',
    showApprovalHistory: false,
    approvalHistoryFilter: '',
    approvalHistoryScope: 'all',
    approvalLinkedNames: {},
    approvalPreviewIndex: 0,
    approvalPreviewType: null,
    approvalPreviewRecord: null,
    approvalPreviewComments: [],
    approvalPreviewCommentBody: '',
    approvalPreviewAnchorLine: null,
    approvalPreviewExpanded: false,
    ...createCommandPaletteState(),
    recordVersionModalOpen: false,
    recordVersionFamilyId: '',
    recordVersionRecordId: '',
    recordVersionLabel: '',
    recordVersionHistory: [],
    recordVersionLoading: false,
    recordVersionError: null,
    recordVersionSelectedIndex: -1,
    persons: [],
    organisations: [],
    opportunities: [],
    wapps: [],
    personalWappsOverlayOpen: false,
    personalAgentsOverlayOpen: false,
    personalWappEditorOpen: false,
    personalWappEditorSaving: false,
    personalWappEditorError: '',
    personalWappEditingId: '',
    personalWappFormTitle: '',
    personalWappFormDescription: '',
    personalWappFormLaunchUrl: '',
    personalWappFormIconUrl: '',
    peopleSubTab: 'people',
    editingPersonId: null,
    editingOrgId: null,
    showPersonEditor: false,
    showOrgEditor: false,
    personFilter: '',
    orgFilter: '',
    personFormTitle: '',
    personFormDescription: '',
    personFormTags: '',
    personFormContacts: [],
    personFormScopeId: null,
    orgFormTitle: '',
    orgFormDescription: '',
    orgFormPositioning: '',
    orgFormTags: '',
    orgFormContacts: [],
    orgFormScopeId: null,
    activeOpportunityId: null,
    opportunityComments: [],
    opportunityFilter: '',
    showOpportunityEditor: false,
    opportunitySaving: false,
    opportunityCheckoutPending: false,
    opportunityDetailMode: 'view',
    opportunityEditOriginal: null,
    editingOpportunity: null,
    newOpportunityCommentBody: '',
    opportunityPersonQuery: '',
    opportunityOrganisationQuery: '',
    opportunityTaskQuery: '',
    opportunityResponsibleQuery: '',
    linkPickerOpen: false,
    linkPickerTarget: null,
    linkPickerRole: '',
    activeTaskId: null,
    taskDetailOriginRoute: '',
    chatTaskModalOpen: false,
    chatTaskModalTitle: '',
    chatTaskModalFullScreen: false,
    tasks: [],
    schedules: [],
    recordSyncConflictCount: 0,
    recordSyncConflicts: [],
    avatarSyncConflictCount: 0,
    avatarSyncConflicts: [],
    avatarSyncConflictDismissed: false,
    inboxActivityVisibleCount: 100,
    inboxActivityPageHasMore: {},
    filesActivityVisibleCount: 100,
    filesActivityPageHasMore: {},
    taskVisibleCount: 50,
    taskPageHasMore: false,
    taskPageCounts: {},
    taskComments: [],
    commentPageSize: 80,
    commentVisibleCount: 80,
    taskCommentsFullscreenOpen: false,
    taskCommentAudioDrafts: [],
    expandedTaskCommentIds: [],
    truncatedTaskCommentIds: [],
    taskFilter: '',
    taskFilterTags: [],
    taskFilterState: '',
    taskFilterAssignee: null,
    taskTagCloudOpen: false,
    selectedTaskIds: [],
    bulkTaskBusy: false,
    pgTaskWriteQueue: [],
    pgTaskWriteInFlight: false,
    pgTaskWriteProcessTimer: null,
    pgTaskWriteProgressTotal: 0,
    pgTaskWriteProgressDone: 0,
    pgTaskWriteFailedCount: 0,
    selectedBoardId: null,
    showBoardPicker: false,
    boardPickerQuery: '',
    showBoardDescendantTasks: false,
    taskViewMode: typeof window !== 'undefined' && window.innerWidth <= 768 ? 'list' : 'kanban',
    taskSortMode: 'manual',
    taskBoardSortPreferences: {},
    collapsedSections: { new: true },
    taskBoardScopeSetupInFlight: false,
    newTaskTitle: '',
    showWriteContextModal: false,
    writeContextPendingAction: null,
    writeContextScopeId: '',
    writeContextChannelId: '',
    writeContextError: '',
    writeContextSubmitting: false,
    newSubtaskTitle: '',
    newTaskCommentBody: '',
    copiedTaskLinkId: null,
    copiedFlightDeckRefKey: null,
    editingTask: null,
    taskDetailMode: 'view',
    taskDetailMobilePane: 'details',
    taskEditOriginal: null,
    taskDetailSaving: false,
    taskDetailCheckoutPending: false,
    taskDraftDirty: false,
    taskDraftSaveState: '',
    taskDraftSavedAt: '',
    taskDraftRemoteChanged: false,
    taskDraftAutosaveTimer: null,
    taskRichDescriptionAdapter: null,
    taskRichDescriptionToolbar: null,
    taskRichDescriptionModel: '',
    taskRichDescriptionUploadIds: [],
    taskRichDescriptionMountEl: null,
    taskRichDescriptionRecordId: '',
    taskAssigneeQuery: '',
    predecessorTaskQuery: '',
    showPredecessorTaskPicker: false,
    taskScopeCascadePending: false,
    taskScopeCascadeMessage: '',
    showNewScheduleModal: false,
    newScheduleTitle: '',
    newScheduleDescription: '',
    newScheduleStart: '09:00',
    newScheduleEnd: '10:00',
    newScheduleDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    newScheduleTimezone: 'Australia/Perth',
    newScheduleRepeat: 'daily',
    newScheduleAssignedGroupId: null,
    newScheduleGroupQuery: '',
    editingScheduleId: null,
    editingScheduleDraft: null,
    editingScheduleGroupQuery: '',
    showTaskDetail: false,
    taskDescriptionEditing: false,
    taskDescriptionEntryPending: false,
    _dragTaskId: null,
    _taskWasDragged: false,
    _dragDocBrowserItem: null,
    _docBrowserWasDragged: false,
    docBrowserDropTarget: '',

    // scopes
    scopes: [],
    scopesLoaded: false,
    scopePickerQuery: '',
    showScopePicker: false,
    showChannelScopePicker: false,
    scopePickerTarget: null, // 'task' or record family being scoped
    newScopeTitle: '',
    newScopeDescription: '',
    newScopeLevel: 'l1',
    newScopeParentId: null,
    newScopeAssignedGroupIds: [],
    newScopeGroupQuery: '',
    newScopeTemplateId: '',
    newScopeTemplateValues: {},
    newScopeTemplateError: '',
    newScopeSubmitting: false,
    newScopeWizardStep: 1,
    newScopeWizardAccessLoading: false,
    newScopeWizardAccessError: '',
    newScopeDefaultAccessPrincipalDraft: '',
    newScopeDefaultAccessRows: [],
    newScopeChannelDrafts: [],
    newScopeChannelNamesText: '',
    newScopeActiveChannelDraftId: '',
    newScopeActiveChannelAccessPrincipalDraft: '',
    showNewScopeForm: false,
    scopeNavFocus: null,
    editingScopeId: null,
    editingScopeTitle: '',
    editingScopeDescription: '',
    editingScopeAssignedGroupIds: [],
    editingScopeGroupQuery: '',
    editingScopeSaving: false,
    editingScopeError: '',
    scopePolicyRepairBusy: false,
    scopePolicyRepairSummary: '',
    legacyDocScopeRepairScopeId: null,
    legacyDocScopeRepairBusy: false,
    legacyDocScopeRepairNotice: '',
    legacyDocScopeRepairError: '',
    scopeRepairSession: {
      phase: 'idle',
      startedAt: null,
      finishedAt: null,
      currentFamily: null,
      completedFamilies: 0,
      totalFamilies: 0,
      processedRecords: 0,
      rewrittenRecords: 0,
      totalRecords: 0,
      error: null,
    },
    scopeRepairProgress: [],
    showScopeRepairModal: false,
    // @mentions
    mentionActive: false,
    mentionQuery: '',
    mentionResults: [],
    mentionSelectedIndex: 0,
    mentionDocumentIndex: [],
    _mentionDocumentIndexRefreshPromise: null,
    _mentionDocumentIndexOwnerNpub: '',
    _mentionDocumentIndexLoaded: false,
    _mentionDocumentIndexLoadedAt: 0,
    _mentionTargetEl: null,
    _mentionStartPos: -1,
    _mentionEndPos: -1,
    selectedAgentMentionsByComposer: { message: [], thread: [] },

    currentFolderId: null,
    docFilter: '',
    docTableSortField: 'name',
    docTableSortDirection: 'asc',
    docSelectionMode: false,
    selectedDocIds: [],
    docArchiveBusy: false,
    bulkDocBusy: false,
    docEditorTitle: '',
    docEditorContent: '',
    docEditorShares: [],
    docShareQuery: '',
    docEditorMode: 'preview',
    docMobilePane: 'document',
    docEditorRichFeatureEnabled: true,
    docEditorProseMirrorState: null,
    docEditorContentModel: null,
    wikiCreateBusy: false,
    wikiCreateTimings: [],
    docBacklinksOpen: false,
    docsHomeSaving: false,
    docsHomeVisit: 0,
    docsShowAll: false,
    docRichEditorAdapter: null,
    docRichEditorMountPromise: null,
    docEditorBodyLoaded: false,
    docRichEditorLoadState: '',
    docRichEditorLoadError: '',
    docRichEditorMountGeneration: 0,
    docRichImageUploadCount: 0,
    docRichEditorMountEl: null,
    docEditAccessGeneration: 0,
    docEditAccessState: 'ready',
    docEditAccessMessage: '',
    docEditDraftDirty: false,
    docEditBaseRecordId: null,
    docEditBaseRowVersion: 0,
    docEditBaseVersionId: null,
    docEditBaseBodySha256Hex: null,
    docEditBaseStorageObjectId: null,
    docEditBaseAvailable: false,
    docEditBaseContentSignature: null,
    docDraftWriteRevision: 0,
    docDraftUndoPromise: null,
    docEditConflict: null,
    docRecovery: null,
    docRecoveryActionState: '',
    docLocalDraft: null,
    docLocalDraftTimer: null,
    docEditLeaseInfo: null,
    docEditAcquirePromise: null,
    docEditAcquirePromiseRecordId: null,
    docEditorSharesDirty: false,
    docShareTargetType: '',
    docShareTargetId: '',
    showDocScopeModal: false,
    docScopeTargetType: '',
    docScopeTargetId: '',
    docScopeTargetIds: [],
    docScopeModalSelectedId: null,
    docScopeModalSubmitting: false,
    docEditorBlocks: [],
    docEditingBlockIndex: -1,
    docBlockBuffer: '',
    docBlockEditorMinHeightPx: 0,
    docEditingTitle: false,
    docComments: [],
    docCommentsVisible: false,
    showDocCommentModal: false,
    docSelectedBlockId: null,
    docCommentAnchorLine: null,
    docCommentAnchorEndLine: null,
    docCommentAnchorBlockId: null,
    docCommentAnchorQuote: '',
    docCommentAnchorStartOffset: null,
    docCommentAnchorEndOffset: null,
    docCommentAnchorRevealState: null,
    docCommentConnector: { visible: false, path: '' },
    docHydrationInFlightById: {},
    newDocCommentBody: '',
    docCommentAudioDrafts: [],
    newDocCommentReplyBody: '',
    docCommentReplyAudioDrafts: [],
    docAutosaveTimer: null,
    docAutosaveState: 'saved',
    recordCheckoutPolicyConfig: FLIGHT_DECK_RECORD_CHECKOUT_POLICY_CONFIG,
    lockManagedCheckoutSessions: {},
    pgEditLeaseSessions: {},
    pgEditLeaseAcquirePromises: {},
    pgEditLeaseInspectionPromises: {},
    pgEditLeaseRenewalTimers: {},
    showDocShareModal: false,
    showInvocationModal: false,
    invocationTargetType: '',
    invocationTargetId: '',
    invocationTargetTitle: '',
    invocationScopeId: '',
    invocationChannelId: '',
    invocationPrompt: '',
    invocationRecipientNpub: '',
    invocationClientRequestId: '',
    invocationSubmitting: false,
    invocationError: '',
    invocationSuccess: '',
    showInvocationHistoryModal: false,
    invocationHistoryTargetType: '',
    invocationHistoryTargetId: '',
    invocationHistoryTargetTitle: '',
    invocationHistoryRows: [],
    invocationHistoryLoading: false,
    invocationHistoryError: '',
    showDocumentSessionsModal: false,
    documentSessionRows: [],
    documentSessionsLoading: false,
    documentSessionsError: '',
    docMoveScopePrompt: null,
    showDocMoveModal: false,
    docMoveRecordIds: [],
    docMoveDirectoryQuery: '',
    docMoveModalSubmitting: false,
    newDocModalType: null,
    newDocModalTitle: '',
    newDocModalScopeId: null,
    newDocModalScopeQuery: '',
    newDocModalScopeDropdownOpen: false,
    newDocModalChannelId: null,
    newDocModalChannelQuery: '',
    newDocModalChannelDropdownOpen: false,
    newDocModalSubmitting: false,
    showNewGroupModal: false,
    newGroupName: '',
    newGroupMemberQuery: '',
    newGroupMembers: [],
    showEditGroupModal: false,
    editGroupId: '',
    editGroupName: '',
    editGroupMemberQuery: '',
    editGroupMembers: [],
    groupCreatePending: false,
    groupEditPending: false,
    groupDeletePendingId: null,
    shareInviteNpub: '',
    shareInviteGroupId: '',
    shareInviteUrl: '',
    shareInvitePending: false,
    shareInviteError: null,
    shareInviteCopied: false,
    pgWorkspaceMembers: [],
    pgWorkspaceMemberProfileEditingActorId: '',
    pgWorkspaceMemberProfileDraft: '',
    pgWorkspaceMemberProfileSaving: false,
    pgWorkspaceMemberProfileError: '',
    pgWorkspaceMemberNpub: '',
    pgGroupMemberDrafts: {},
    pgChildGroupDrafts: {},
    showNewChannelModal: false,
    newChannelMode: 'dm',
    newChannelDmNpub: '',
    newChannelName: '',
    newChannelDescription: '',
    newChannelBasePrompt: '',
    newChannelGroupId: '',
    newChannelAccessPrincipalDraft: '',
    newChannelAccessRows: [],
    newChannelAccessLoading: false,
    newChannelAccessError: '',
    showNewChannelScopePicker: false,
    newChannelScopeId: '',
    channelSettingsBasePrompt: '',
    channelSettingsAgentChatEnabled: false,
    channelSettingsSaving: false,
    channelPositionSaving: false,
    channelSettingsPosition: '',
    channelSettingsNotice: '',
    channelSettingsError: '',
    channelSettingsChannelId: '',
    channelSettingsWorkspaceId: '',
    channelDeleteSubmitting: false,
    channelThreadsMarkReadPending: false,
    showWorkspaceAccessGate: false,
    workspaceAccessGateStep: 'review',
    workspaceAccessGateWorkspaces: [],
    workspaceAccessGateProgress: {
      active: false,
      phase: 'idle',
      label: '',
      completed: 0,
      total: 0,
      error: '',
    },
    workspaceAccessGateBusy: false,
    superbasedTokenInput: '',
    superbasedError: null,
    knownWorkspaces: [],
    forgottenPgWorkspaces: [],
    workspaceProfileRowsByKey: {},
    selectedWorkspaceKey: '',
    localWorkspaceCoreLoadedForKey: '',
    currentWorkspaceOwnerNpub: '',
    showWorkspaceSwitcherMenu: false,
    workspaceSwitchPendingKey: '',
    workspaceSwitchPendingNpub: '',
    removingWorkspace: false,
    appManagementCleanupBusy: false,
    appManagementCleanupMessage: '',
    appManagementCleanupError: '',
    workspaceSettingsRecordId: '',
    workspaceSettingsVersion: 0,
    personalAgentSettingsRowVersion: 0,
    workspaceSettingsGroupIds: [],
    workspaceHarnessUrl: '',
    workspaceHarnessAgentNpub: '',
    workspaceHarnessAgents: [],
    workspaceProfileNameInput: '',
    workspaceProfileSlugInput: '',
    workspaceProfileDescriptionInput: '',
    workspaceProfileDashboardGreetingTemplateInput: '',
    workspaceWorkroomsEnabledInput: false,
    workspaceProfileAvatarInput: '',
    workspaceProfileAvatarPreviewUrl: '',
    workspaceProfilePendingAvatarFile: null,
    workspaceProfilePendingAvatarObjectUrl: '',
    workspaceProfileDirty: false,
    workspaceProfileSaving: false,
    workspaceProfileError: null,
    workspaceAdvancedOptionsEnabled: false,
    defaultAgentNpub: '',
    defaultAgentQuery: '',
    wingmanHarnessInput: '',
    wingmanHarnessDraftAgentNpub: '',
    wingmanHarnessAgentQuery: '',
    wingmanHarnessError: null,
    wingmanHarnessDirty: false,
    repairSelectedFamilyIds: ['comment', 'audio_note'],
    repairBusy: false,
    repairError: null,
    repairNotice: '',
    repairTaskIdInput: '',
    repairTaskProbeBusy: false,
    recordStatusModalOpen: false,
    recordStatusFamilyId: '',
    recordStatusTargetId: '',
    recordStatusTargetLabel: '',
    recordStatusBusy: false,
    recordStatusSyncBusy: false,
    recordStatusError: null,
    recordStatusNotice: '',
    recordStatusTowerVersionCount: 0,
    recordStatusTowerLatestVersion: 0,
    recordStatusTowerUpdatedAt: '',
    recordStatusLocalPresent: false,
    recordStatusLocalVersion: 0,
    recordStatusLocalSyncStatus: '',
    recordStatusPendingWriteCount: 0,
    recordStatusWriteGroupRef: '',
    recordStatusWriteGroupLabel: '',
    recordStatusWriteGroupKeyLoaded: false,
    recordStatusDeliveryGroupSummary: '',
    recordStatusDeliveryGroupKeySummary: '',
    pendingWritesModalOpen: false,
    pendingWritesBusy: false,
    pendingWritesError: null,
    pendingWritesNotice: '',
    pendingWriteDiagnostics: [],
    syncQuarantine: [],
    syncQuarantineBusy: false,
    syncQuarantineError: null,
    syncQuarantineNotice: '',
    pgWorkspaceSelfIndexDiscovering: false,
    pgWorkspaceSelfIndexError: null,
    pgWorkspaceSelfIndexSummary: null,
    pgOnboardingAnnouncementStatuses: [],
    pgOnboardingAnnouncementDiscovering: false,
    pgOnboardingAnnouncementError: null,
    pgOnboardingAnnouncementSummary: null,

    // Legacy workspace settings may still contain trigger rows; no runtime trigger publisher is mounted.
    workspaceTriggers: [],

    // jobs
    jobDefinitions: [],
    jobRuns: [],
    jobsLoading: false,
    jobRunsLoading: false,
    jobsError: null,
    jobsSuccess: null,
    _jobsTab: 'definitions',
    showNewJobModal: false,
    newJobId: '',
    newJobName: '',
    newJobWorkerPrompt: '',
    newJobManagerPrompt: '',
    newJobManagerGoal: '',
    newJobManagerDir: '',
    newJobCheckInterval: '300',
    showEditJobModal: false,
    editingJobId: null,
    editJobName: '',
    editJobWorkerPrompt: '',
    editJobManagerPrompt: '',
    editJobManagerGoal: '',
    editJobManagerDir: '',
    editJobCheckInterval: '300',
    showDispatchModal: false,
    dispatchJobId: null,
    dispatchGoal: '',
    jobRunsFilterJobId: '',
    jobRunsFilterStatus: '',

    showWorkspaceBootstrapModal: false,
    newWorkspaceName: '',
    newWorkspaceDescription: '',
    workspaceBootstrapSubmitting: false,
    agentConnectJson: '',
    agentConfigCopied: false,
    pendingInviteToken: null,
    useCvmSync: localStorage.getItem('use_cvm_sync') === 'true',
    extensionSignerAvailable: false,
    extensionSignerPollTimer: null,

    // ui
    messageInput: '',
    composerDraftHasText: { message: false, thread: false },
    chatComposerDrafts: {},
    messageAudioDrafts: [],
    messageFileDrafts: [],
    messageImageUploadCount: 0,
    mainFeedVisibleCount: CHAT_PRESENTATION_ROOT_LIMIT,
    chatFeedNearTop: false,
    selectedChannelUnreadCutoff: null,
    selectedChannelUnreadChannelId: null,
    syncing: false,
    isLoggingIn: false,
    error: null,
    showAudioRecorderModal: false,
    audioRecorderContext: null,
    audioRecorderState: 'idle',
    audioRecorderError: null,
    audioRecorderDurationSeconds: 0,
    audioRecorderPreviewUrl: '',
    audioRecorderTitle: 'Voice note',
    audioRecorderStatusLabel: '',
    loginError: null,
    storageImageUrlCache: {},
    storageImageLoadPromises: {},
    storageImageFailureCache: {},
    workspaceProfileHydrationPromises: {},
    _storageImageHydrateScheduled: false,

    get isLoggedIn() {
      return Boolean(this.session?.npub);
    },

    get displayName() {
      if (!this.session?.npub) return 'Anonymous';
      return this.getSenderName(this.session.npub) || 'Anonymous';
    },

    get greetingName() {
      if (!this.session?.npub) return 'there';
      return this.getSenderName(this.session.npub) || getShortNpub(this.session.npub) || 'there';
    },

    get dashboardGreetingText() {
      const template = String(
        this.currentWorkspace?.dashboardGreetingTemplate
        || 'Welcome $user.name,\\nwhere will we focus today?'
      );
      return template
        .replace(/\\n/g, '\n')
        .replace(/\$user\.name/g, this.greetingName);
    },

    get scopedReports() {
      const cache = getScopedReportsCacheEntry(this);
      const selectedBoardId = String(this.selectedBoardId || '');
      const selectedBoardScopeId = String(this.selectedBoardScope?.record_id || '');
      if (
        cache.reports === this.reports
        && cache.selectedBoardId === selectedBoardId
        && cache.selectedBoardScopeId === selectedBoardScopeId
      ) {
        return cache.value;
      }

      const visible = this.reports.filter((report) => {
        if (!report || report.record_state === 'deleted') return false;
        const surface = String(report.surface || report.metadata?.surface || '').trim().toLowerCase();
        if (surface && surface !== 'flightdeck') return false;
        if (this.selectedBoardId === UNSCOPED_TASK_BOARD_ID) return isTaskUnscoped(report, this.scopesMap);
        if (this.selectedBoardScope) {
          return matchesTaskBoardScope(report, this.selectedBoardScope, this.scopesMap, {
            includeDescendants: true,
          });
        }
        return true;
      });

      const sorted = visible.sort((left, right) => {
        const leftTs = Date.parse(left.generated_at || left.updated_at || 0) || 0;
        const rightTs = Date.parse(right.generated_at || right.updated_at || 0) || 0;
        return rightTs - leftTs;
      });
      cache.reports = this.reports;
      cache.selectedBoardId = selectedBoardId;
      cache.selectedBoardScopeId = selectedBoardScopeId;
      cache.value = sorted;
      return sorted;
    },

    get flightDeckReports() {
      return this.scopedReports;
    },

    get statusRecordTypeOptions() {
      const presentTypes = new Set(this.contextFilteredStatusRecentChanges.map((item) => item.recordTypeKey).filter(Boolean));
      return STATUS_RECORD_TYPE_ORDER
        .filter((value) => presentTypes.has(value))
        .map((value) => ({ value, label: STATUS_RECORD_TYPE_LABELS[value] || value }));
    },

    get contextFilteredStatusRecentChanges() {
      const board = parsePgTaskBoardId(this.selectedBoardId);
      const selectedChannelId = String(this.pgContextSelectedChannelId || '').trim();
      const selectedThreadId = String(this.pgContextSelectedThreadId || '').trim();
      const selectedScope = this.selectedBoardScope || null;
      const selectedScopeId = String(selectedScope?.record_id || '').trim();
      const isUnscopedBoard = this.selectedBoardId === UNSCOPED_TASK_BOARD_ID;

      return this.statusRecentChanges.filter((item) => {
        if (!item) return false;
        if (selectedChannelId && String(item.channelId || '').trim() !== selectedChannelId) return false;
        if (selectedThreadId && String(item.threadId || '').trim() !== selectedThreadId) return false;
        if (board.type === 'channel' || board.type === 'thread') return true;
        if (isUnscopedBoard) return isTaskUnscoped(item, this.scopesMap);
        if (selectedScopeId && selectedScope) {
          return matchesTaskBoardScope(item, selectedScope, this.scopesMap, { includeDescendants: true });
        }
        return true;
      });
    },

    get filteredStatusRecentChanges() {
      const scopedChanges = this.contextFilteredStatusRecentChanges;
      if (!this.statusRecordTypeFilter || this.statusRecordTypeFilter === 'all') {
        return scopedChanges;
      }
      return scopedChanges.filter((item) => item.recordTypeKey === this.statusRecordTypeFilter);
    },

    get attentionFeedGroups() {
      return buildAttentionFeed({
        session: this.session,
        defaultAgentNpub: this.defaultAgentNpub,
        botNpub: this.botNpub,
        tasks: this.tasks,
        boardScopedTasks: this.boardScopedTasks,
        statusRecentChanges: this.contextFilteredStatusRecentChanges,
      });
    },

    get attentionFeedSummary() {
      return summarizeAttentionFeed(this.attentionFeedGroups);
    },

    get attentionFeedItemCount() {
      return this.attentionFeedGroups.reduce((sum, group) => sum + group.items.length, 0);
    },

    get statusTimingFeed() {
      return buildTimingFeed({
        schedules: this.schedules,
        tasks: this.boardScopedTasks,
      });
    },

    get statusTimingItemCount() {
      const feed = this.statusTimingFeed;
      return feed.upcoming.length + feed.justGone.length;
    },

    get selectedReport() {
      if (!this.scopedReports.length) return null;
      return this.scopedReports.find((report) => report.record_id === this.selectedReportId) || this.scopedReports[0];
    },

    get avatarUrl() {
      return this.session?.npub ? this.getSenderAvatar(this.session.npub) : null;
    },

    get avatarFallback() {
      const source = this.displayName || this.session?.npub || 'cw';
      return this.getInitials(source);
    },

    get superbasedConnectionConfig() {
      if (!this.superbasedTokenInput) return null;
      const parsed = parseSuperBasedToken(this.superbasedTokenInput);
      return parsed.isValid ? parsed : null;
    },

    // workspace computed getters applied via workspaceManagerMixin (applyMixins)

    get superbasedTransportLabel() {
      if (this.useCvmSync && this.superbasedConnectionConfig?.relayUrl) return 'CVM relay';
      return this.backendUrl ? this.towerTransportStatus : 'Not configured';
    },

    get hasHarnessLink() {
      return Boolean(this.workspaceHarnessUrl);
    },

    get harnessAgentLabel() {
      return this.workspaceHarnessAgentNpub ? this.getSenderName(this.workspaceHarnessAgentNpub) : '';
    },

    get harnessAgentAvatarUrl() {
      return this.workspaceHarnessAgentNpub ? this.getSenderAvatar(this.workspaceHarnessAgentNpub) : null;
    },

    get visiblePersonalAgents() {
      const agents = [];
      const seen = new Set();
      const addAgent = (agent) => {
        const npub = String(agent?.npub || '').trim();
        const configuredUrl = String(agent?.launch_url || agent?.url || '').trim();
        const launchUrl = normalizedAutopilotLaunchUrl(configuredUrl);
        const key = npub || launchUrl;
        if (!key || seen.has(key)) return;
        seen.add(key);
        agents.push({
          npub,
          launch_url: launchUrl,
          configured_url: configuredUrl,
          title: String(agent?.title || '').trim() || (npub ? this.getSenderName(npub) : 'Autopilot agent'),
          description: launchUrl
            ? (String(agent?.description || '').trim() || 'Dive Deeper in Autopilot')
            : 'Autopilot URL unavailable',
        });
      };

      const configuredAgents = Array.isArray(this.workspaceHarnessAgents)
        && (this.workspaceHarnessAgents.length > 0 || this.wingmanHarnessDirty)
        ? this.workspaceHarnessAgents
        : ((this.workspaceHarnessUrl || this.workspaceHarnessAgentNpub) ? [{
            agent_npub: this.workspaceHarnessAgentNpub,
            url: this.workspaceHarnessUrl,
          }] : []);
      for (const entry of configuredAgents) {
        const npub = String(entry?.agent_npub || '').trim();
        addAgent({
          npub,
          launch_url: entry?.url,
          title: npub ? this.getSenderName(npub) : 'Autopilot agent',
          description: 'Dive Deeper in Autopilot',
        });
      }

      for (const row of this.dailyScopeAgentAccess || []) {
        if (row?.revoked_at != null || row?.can_read === false) continue;
        const npub = String(row.agent_actor_npub || row.agent_npub || '').trim();
        if (!npub) continue;
        addAgent({
          npub,
          launch_url: String(row.launch_url || row.agent_launch_url || '').trim(),
          title: row.agent_display_name || this.getSenderName(npub),
          description: row.can_write === false ? 'Daily Scope reader' : 'Daily Scope agent',
        });
      }

      return agents;
    },

    get invocablePersonalAgents() {
      return this.visiblePersonalAgents.filter((agent) => String(agent?.npub || '').trim());
    },

    get previewPersonalAgents() {
      return this.invocablePersonalAgents.slice(0, 3);
    },

    // chat message getters applied via chatMessageManagerMixin (applyMixins)

    get selectedDocument() {
      if (this.selectedDocType !== 'document' || !this.selectedDocId) return null;
      return this.documents.find((item) => item.record_id === this.selectedDocId) ?? null;
    },

    get docsEditorOpen() {
      return this.selectedDocType === 'document' && Boolean(this.selectedDocument);
    },

    get selectedDocComment() {
      if (!this.selectedDocCommentId) return null;
      return this.docComments.find((comment) => comment.record_id === this.selectedDocCommentId) ?? null;
    },

    get selectedDocCommentReplies() {
      const rootId = this.selectedDocComment?.record_id;
      if (!rootId) return [];
      return this.getDocCommentReplies(rootId);
    },

    get hasDocCommentConnector() {
      return Boolean(this.docCommentConnector?.visible && this.docCommentsVisible && this.selectedDocComment);
    },

    get selectedDirectory() {
      if (this.selectedDocType !== 'directory' || !this.selectedDocId) return null;
      return this.directories.find((item) => item.record_id === this.selectedDocId) ?? null;
    },

    get currentFolder() {
      if (!this.currentFolderId) return null;
      return this.directories.find((item) => item.record_id === this.currentFolderId) ?? null;
    },

    get currentFolderParentId() {
      return this.currentFolder?.parent_directory_id ?? null;
    },

    get currentFolderParentLabel() {
      if (!this.currentFolder) return '';
      const parent = this.directories.find((item) => item.record_id === this.currentFolderParentId);
      return parent?.title || 'Docs';
    },

    get selectedDocItem() {
      return this.selectedDocument ?? this.selectedDirectory ?? null;
    },

    get activeDocShareTarget() {
      if (this.docShareTargetType === 'document') return this.selectedDocument;
      if (this.docShareTargetType === 'directory') {
        return this.directories.find((item) => item.record_id === this.docShareTargetId) ?? null;
      }
      return this.selectedDocument ?? this.currentFolder ?? null;
    },

    get activeDocShareTargetTypeLabel() {
      return this.docShareTargetType === 'directory' ? 'Folder' : 'Document';
    },

    get activeDocShareTargetName() {
      const target = this.activeDocShareTarget;
      if (!target) return '';
      return target.title || (this.docShareTargetType === 'directory' ? 'Untitled folder' : 'Untitled document');
    },

    get isDirectoryShareTarget() {
      return this.docShareTargetType === 'directory';
    },

    get currentFolderBreadcrumbs() {
      const breadcrumbs = [];
      let folderId = this.currentFolderId;
      while (folderId) {
        const folder = this.directories.find((item) => item.record_id === folderId && item.record_state !== 'deleted');
        if (!folder) break;
        breadcrumbs.unshift(folder);
        folderId = folder.parent_directory_id || null;
      }
      return breadcrumbs;
    },

    get currentFolderTitleLabel() {
      if (this.currentFolderBreadcrumbs.length === 0) return '';
      return this.currentFolderBreadcrumbs
        .map((folder) => folder.title || 'Untitled folder')
        .join(' / ');
    },

    get currentDocumentTitle() {
      return buildFlightDeckDocumentTitle({
        section: this.navSection,
        channelLabel: this.navSection === 'chat' && this.selectedChannel
          ? this.getChannelLabel(this.selectedChannel)
          : '',
        folderLabel: this.navSection === 'docs' ? this.currentFolderTitleLabel : '',
        docTitle: this.navSection === 'docs'
          ? (this.selectedDocument?.title || this.selectedDirectory?.title || '')
          : '',
        workspaceLabel: this.activeWorkspaceOwnerNpub ? this.currentWorkspaceName : '',
      });
    },

    get scopeFilteredDocs() {
      return filterDocItemsByScope(
        this.documents, this.directories,
        this.selectedBoardId, this.selectedBoardScope, this.scopesMap,
      );
    },

    get currentFolderContents() {
      if (this.isTowerPgMode) {
        const channelId = String(this.pgContextSelectedChannelId || '').trim();
        const threadId = String(this.pgContextSelectedThreadId || '').trim();
        const docs = this.scopeFilteredDocs.documents
          .filter((item) => {
            if (item.record_state === 'deleted') return false;
            if (channelId && String(item.pg_channel_id || '').trim() !== channelId) return false;
            if (threadId && String(item.pg_thread_id || '').trim() !== threadId) return false;
            return true;
          })
          .map((item) => ({ type: 'document', item }))
          .sort((a, b) => String(a.item.title || '').localeCompare(String(b.item.title || '')));
        return docs;
      }
      const folderId = this.currentFolderId ?? null;
      const { documents, directories } = this.scopeFilteredDocs;
      const dirs = directories
        .filter((item) => (item.parent_directory_id ?? null) === folderId)
        .map((item) => ({ type: 'directory', item }))
        .sort((a, b) => String(a.item.title || '').localeCompare(String(b.item.title || '')));
      const docs = documents
        .filter((item) => (item.parent_directory_id ?? null) === folderId)
        .map((item) => ({ type: 'document', item }))
        .sort((a, b) => String(a.item.title || '').localeCompare(String(b.item.title || '')));
      return [...dirs, ...docs];
    },

    get filteredDocBrowserItems() {
      const query = String(this.docFilter || '').trim().toLowerCase();
      if (this.isTowerPgMode) {
        if (!query) return this.currentFolderContents;
        return this.currentFolderContents.filter((row) =>
          String(row.item?.title || '').toLowerCase().includes(query)
          || String(row.item?.content || '').toLowerCase().includes(query)
        );
      }
      if (!query) return this.currentFolderContents;

      const { documents: activeDocuments, directories: activeDirectories } = this.scopeFilteredDocs;
      const childDirsByParent = new Map();
      const childDocsByParent = new Map();

      for (const directory of activeDirectories) {
        const key = directory.parent_directory_id ?? '__root__';
        const list = childDirsByParent.get(key) ?? [];
        list.push(directory);
        childDirsByParent.set(key, list);
      }
      for (const document of activeDocuments) {
        const key = document.parent_directory_id ?? '__root__';
        const list = childDocsByParent.get(key) ?? [];
        list.push(document);
        childDocsByParent.set(key, list);
      }

      const matchesDirectory = (directory) =>
        String(directory.title || '').toLowerCase().includes(query);
      const matchesDocument = (document) =>
        String(document.title || '').toLowerCase().includes(query)
        || String(document.content || '').toLowerCase().includes(query);

      const directoryHasMatch = (directoryId) => {
        const childDirs = childDirsByParent.get(directoryId) ?? [];
        const childDocs = childDocsByParent.get(directoryId) ?? [];
        return childDirs.some((dir) => matchesDirectory(dir) || directoryHasMatch(dir.record_id))
          || childDocs.some((doc) => matchesDocument(doc));
      };

      const rows = [];
      const walk = (parentId = null) => {
        const dirKey = parentId ?? '__root__';
        const directories = (childDirsByParent.get(dirKey) ?? [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        const documents = (childDocsByParent.get(dirKey) ?? [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

        for (const directory of directories) {
          if (!matchesDirectory(directory) && !directoryHasMatch(directory.record_id)) continue;
          rows.push({ type: 'directory', item: directory });
          walk(directory.record_id);
        }
        for (const document of documents) {
          if (!matchesDocument(document)) continue;
          rows.push({ type: 'document', item: document });
        }
      };

      walk(this.currentFolderId ?? null);
      return rows;
    },

    get sortedDocBrowserItems() {
      return sortDocBrowserRows(
        this.filteredDocBrowserItems,
        this.docTableSortField,
        this.docTableSortDirection,
      );
    },

    setDocTableSort(field) {
      const next = nextDocTableSort(this.docTableSortField, this.docTableSortDirection, field);
      this.docTableSortField = next.field;
      this.docTableSortDirection = next.direction;
    },

    docTableAriaSort(field) {
      if (this.docTableSortField !== field) return 'none';
      return this.docTableSortDirection === 'desc' ? 'descending' : 'ascending';
    },

    docTableSortButtonLabel(field, label) {
      if (this.docTableSortField !== field) {
        const initialDirection = field === 'name' ? 'ascending' : 'descending';
        return `Sort by ${label}, initially ${initialDirection}`;
      }
      const currentDirection = this.docTableSortDirection === 'desc' ? 'descending' : 'ascending';
      const nextDirection = currentDirection === 'ascending' ? 'descending' : 'ascending';
      return `Sorted by ${label}, ${currentDirection}. Activate to sort ${nextDirection}`;
    },

    formatDocTableDateTime(value) {
      return formatDocTableDateTime(value);
    },

    normalizeDocTableTimestamp(value) {
      return normalizeDocTableTimestamp(value);
    },

    get visibleDocBrowserIds() {
      return this.sortedDocBrowserItems
        .filter((row) => row.type === 'document')
        .map((row) => row.item.record_id);
    },

    get selectedDocCount() {
      return this.selectedDocIds.length;
    },

    get activeDocMoveItems() {
      const selectedIds = new Set(this.docMoveRecordIds);
      return this.documents
        .filter((item) => selectedIds.has(item.record_id) && item.record_state !== 'deleted');
    },

    get docMoveSourceParentIds() {
      return [...new Set(this.activeDocMoveItems.map((item) => item.parent_directory_id ?? null))];
    },

    get docMoveDirectoryOptions() {
      const query = String(this.docMoveDirectoryQuery || '').trim().toLowerCase();
      const activeDirectories = this.directories.filter((item) => item.record_state !== 'deleted');
      const childDirsByParent = new Map();
      for (const directory of activeDirectories) {
        const key = directory.parent_directory_id ?? '__root__';
        const list = childDirsByParent.get(key) ?? [];
        list.push(directory);
        childDirsByParent.set(key, list);
      }

      const options = [{ record_id: null, title: 'Docs', breadcrumb: 'Root', depth: 0 }];
      const walk = (parentId = null, depth = 1) => {
        const key = parentId ?? '__root__';
        const directories = (childDirsByParent.get(key) ?? [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        for (const directory of directories) {
          options.push({
            record_id: directory.record_id,
            title: directory.title || 'Untitled folder',
            breadcrumb: this.getDirectoryMoveOptionBreadcrumb(directory.record_id),
            depth,
          });
          walk(directory.record_id, depth + 1);
        }
      };
      walk();
      if (!query) return options;
      return options.filter((option) => {
        const title = String(option.title || '').toLowerCase();
        const breadcrumb = String(option.breadcrumb || '').toLowerCase();
        return title.includes(query) || breadcrumb.includes(query);
      });
    },

    // --- task board computed (extracted to task-board-state.js) ---
    // taskBoardStateMixin applied via applyMixins (has getters)

    // workspaceManagerMixin applied via applyMixins (display, switcher, settings)

    get renderedDocPreview() {
      return this.renderMarkdown(this.docEditorContent || '');
    },

    get docEditorHasBlocks() {
      return this.docEditorBlocks.length > 0;
    },

    get docSyncStatusClass() {
      if (this.docAutosaveState === 'error') return 'doc-sync-dot-unsynced';
      if (this.docAutosaveState === 'pending') return 'doc-sync-dot-unsynced';
      if (this.docAutosaveState === 'saving') return 'doc-sync-dot-syncing';
      return 'doc-sync-dot-synced';
    },

    get docSyncStatusLabel() {
      if (this.docAutosaveState === 'error') return 'Save failed';
      if (this.docAutosaveState === 'pending') return 'Unsaved changes';
      if (this.docAutosaveState === 'saving') return 'Saving…';
      if (this.docEditAccessState === 'recovery') return this.docRecovery ? 'Recovery draft preserved' : 'Draft kept locally';
      return 'Saved';
    },

    get selectedDocPgLeaseSession() {
      const recordId = String(this.selectedDocument?.record_id || '').trim();
      return recordId ? this.pgEditLeaseSessions?.[`document:${recordId}`] || null : null;
    },

    get selectedDocEditStatusTone() {
      if (this.docEditAccessState === 'editing') return 'editing';
      if (this.docEditAccessState === 'acquiring') return 'acquiring';
      if (['blocked', 'conflict', 'recovery', 'recovery_available'].includes(this.docEditAccessState)) return 'blocked';
      if (this.selectedDocPgLeaseSession?.inspectionState === 'offline') return 'offline';
      if (this.docEditLeaseInfo) return 'blocked';
      return 'ready';
    },

    get selectedDocEditStatusLabel() {
      if (!isTowerPgBackendMode() || !isSyncedPgRecord(this.selectedDocument)) return '';
      if (this.docEditAccessState === 'acquiring') return 'Acquiring edit access…';
      if (this.docEditAccessState === 'editing') return this.docSyncStatusLabel;
      if (this.docEditAccessState === 'recovery') return this.docEditDraftDirty ? this.docSyncStatusLabel : 'Recovery saved';
      if (this.docEditAccessState === 'recovery_available') return 'Recovery available';
      if (this.docEditAccessState === 'conflict') return 'Draft preserved — document changed in Tower';
      if (this.docEditAccessState === 'blocked') {
        return this.docEditDraftDirty
          ? 'Draft preserved — edit access unavailable'
          : 'Edit access unavailable';
      }
      if (this.docRichEditorLoadState === 'error') return 'Document editor unavailable';
      if (this.selectedDocument?.content_storage_status === 'error' && !this.isSelectedDocContentReadyForEditor()) return 'Document body unavailable';
      if (!this.isSelectedDocContentReadyForEditor() || this.docRichEditorLoadState === 'loading') return 'Loading complete document…';
      const lease = this.docEditLeaseInfo || this.selectedDocPgLeaseSession?.inspectedLease || null;
      if (lease) {
        const holderNpub = String(lease.holder_actor_npub || lease.holder_npub || '').trim();
        const ownHolderNpubs = new Set([
          this.session?.npub,
          this.signingNpub,
          this.workspaceUserKeyNpub,
        ].map((value) => String(value || '').trim()).filter(Boolean));
        const holder = String(lease.holder_display_name || lease.holder_name || '').trim()
          || (holderNpub ? this.getSenderName(holderNpub) : '')
          || 'another person';
        const remaining = formatLeaseRemaining({
          lease_expires_at: lease.expires_at || lease.lease_expires_at || null,
        });
        return `${ownHolderNpubs.has(holderNpub) ? 'Edit access held by you' : `Being edited by ${holder}`}${remaining ? ` · ${remaining}` : ''}`;
      }
      if (this.selectedDocPgLeaseSession?.inspectionState === 'offline') return 'Offline · reconnect to edit';
      return 'Ready to edit';
    },

    get selectedDocRequiresCheckout() {
      return this.selectedDocType === 'document'
        && (
          typeof this.isCheckoutRequiredRecordFamily === 'function'
            ? this.isCheckoutRequiredRecordFamily(recordFamilyHash('document'), this.selectedDocument)
            : false
        );
    },

    get selectedDocIsLockManaged() {
      return this.selectedDocRequiresCheckout;
    },

    get selectedDocCheckoutSessionState() {
      const session = typeof this.getSelectedDocCheckoutSession === 'function'
        ? this.getSelectedDocCheckoutSession()
        : null;
      const submittedVersion = Number(session?.submittedVersion ?? 0) || 0;
      const localVersion = Number(this.selectedDocument?.version ?? 0) || 0;
      if (
        session
        && isCheckoutHeld(session.checkout)
        && submittedVersion > 0
        && String(this.selectedDocument?.sync_status || '').trim() === 'synced'
        && localVersion >= submittedVersion
      ) {
        return null;
      }
      return session;
    },

    get canCurrentActorEditSelectedLockManagedRecord() {
      if (!this.selectedDocRequiresCheckout) return true;
      if (isTowerPgBackendMode() && this.selectedDocument?.pg_backend) return true;
      return typeof this.canCurrentActorAcquireCheckoutRequiredRecord === 'function'
        ? this.canCurrentActorAcquireCheckoutRequiredRecord()
        : false;
    },

    get hasSelectedDocCheckout() {
      return isCheckoutHeld(this.selectedDocCheckoutSessionState?.checkout);
    },

    get selectedDocCheckoutHolderLabel() {
      const holder = describeCheckoutHolder(this.selectedDocCheckoutSessionState?.checkout);
      return holder.userNpub || '';
    },

    get selectedDocCheckoutLeaseLabel() {
      return formatLeaseRemaining(this.selectedDocCheckoutSessionState?.checkout);
    },

    get selectedDocPhaseOneStateTone() {
      if (!this.selectedDocRequiresCheckout) return 'info';
      if (!this.canCurrentActorEditSelectedLockManagedRecord) return 'blocked';
      const classification = String(this.selectedDocCheckoutSessionState?.classification || '').trim();
      if (classification) return 'blocked';
      if (this.hasSelectedDocCheckout) return 'held';
      return 'info';
    },

    get selectedDocPhaseOneStateLabel() {
      if (!this.selectedDocRequiresCheckout) return '';
      if (!this.canCurrentActorEditSelectedLockManagedRecord) {
        return checkoutErrorMessage('identity_alias_mismatch');
      }
      const session = this.selectedDocCheckoutSessionState;
      if (session?.message) return session.message;
      if (this.hasSelectedDocCheckout) {
        const lease = this.selectedDocCheckoutLeaseLabel;
        if (isTowerPgBackendMode() && this.selectedDocument?.pg_backend) {
          return lease ? `Edit lease held. ${lease}.` : 'Edit lease held. You can edit this document.';
        }
        return lease ? `Checkout held. ${lease}.` : 'Checkout held. You can edit this document.';
      }
      if (isTowerPgBackendMode() && this.selectedDocument?.pg_backend) {
        return 'Read mode. Click Edit to acquire an edit lease.';
      }
      return 'Read mode. Acquire checkout to enter edit mode.';
    },

    // peopleProfilesManagerMixin applied via applyMixins (suggestions, profile resolution)

    get groupActionsLocked() {
      return this.groupCreatePending || this.groupEditPending || !!this.groupDeletePendingId;
    },

    get filteredDocRows() {
      if (this.isTowerPgMode) {
        return this.sortedDocBrowserItems.map((row) => ({
          ...row,
          depth: row.depth ?? 0,
        }));
      }
      const { documents: activeDocuments, directories: activeDirectories } = this.scopeFilteredDocs;
      const query = String(this.docFilter || '').trim().toLowerCase();

      const childDirsByParent = new Map();
      const childDocsByParent = new Map();
      for (const directory of activeDirectories) {
        const key = directory.parent_directory_id ?? '__root__';
        const list = childDirsByParent.get(key) ?? [];
        list.push(directory);
        childDirsByParent.set(key, list);
      }
      for (const document of activeDocuments) {
        const key = document.parent_directory_id ?? '__root__';
        const list = childDocsByParent.get(key) ?? [];
        list.push(document);
        childDocsByParent.set(key, list);
      }

      const matchesDirectory = (directory) =>
        !query || String(directory.title || '').toLowerCase().includes(query);
      const matchesDocument = (document) =>
        !query
        || String(document.title || '').toLowerCase().includes(query)
        || String(document.content || '').toLowerCase().includes(query);

      const directoryHasMatch = (directoryId) => {
        const childDirs = childDirsByParent.get(directoryId) ?? [];
        const childDocs = childDocsByParent.get(directoryId) ?? [];
        return childDirs.some((dir) => matchesDirectory(dir) || directoryHasMatch(dir.record_id))
          || childDocs.some((doc) => matchesDocument(doc));
      };

      const rows = [];
      const walk = (parentId = null, depth = 0) => {
        const dirKey = parentId ?? '__root__';
        const directories = (childDirsByParent.get(dirKey) ?? [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        const documents = (childDocsByParent.get(dirKey) ?? [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

        for (const directory of directories) {
          if (query && !matchesDirectory(directory) && !directoryHasMatch(directory.record_id)) continue;
          rows.push({ type: 'directory', depth, item: directory });
          walk(directory.record_id, depth + 1);
        }
        for (const document of documents) {
          if (!matchesDocument(document)) continue;
          rows.push({ type: 'document', depth, item: document });
        }
      };

      walk(null, 0);
      return rows;
    },

    // workspace list, profile editing, settings, CRUD — extracted to workspace-manager.js

    // syncManagerMixin applied via applyMixins (repair UI, quarantine, sync lifecycle)
    // connectSettingsManagerMixin applied via applyMixins (connection, settings, agent connect)

    // --- lifecycle ---

    async init() {
      this.initDocEditLeaseLifecycle?.();
      this.initReadAloud();
      if (typeof window !== 'undefined' && !this.chatImagePreviewCleanupHandler) {
        this.chatImagePreviewCleanupHandler = () => this.cleanupChatImagePreviews();
        window.addEventListener('pagehide', this.chatImagePreviewCleanupHandler);
      }
      this.startExtensionSignerWatch();
      this.initCommandPaletteShortcuts();
      this.initRouteSync();
      this.routeSyncPaused = true; // pause until applyRouteFromLocation restores the URL
      this.initDocCommentConnector();
      this.startSharedLiveQueries();
      const settings = await getSettings();
      if (settings) {
        this.backendUrl = normalizeBackendUrl(settings.backendUrl ?? '');
        this.ownerNpub = settings.ownerNpub ?? '';
        this.botNpub = settings.botNpub ?? '';
        this.defaultAgentNpub = settings.defaultAgentNpub ?? '';
        this.superbasedTokenInput = settings.connectionToken ?? '';
        this.useCvmSync = settings.useCvmSync ?? this.useCvmSync;
        this.selectedWorkspaceKey = settings.currentWorkspaceKey ?? '';
        this.currentWorkspaceOwnerNpub = settings.currentWorkspaceOwnerNpub ?? '';
        this.knownWorkspaces = mergeWorkspaceEntries([], settings.knownWorkspaces ?? []);
        this.forgottenPgWorkspaces = Array.isArray(settings.forgottenPgWorkspaces)
          ? settings.forgottenPgWorkspaces
          : [];
        this.knownHosts = Array.isArray(settings.knownHosts) ? settings.knownHosts : [];
        this.taskBoardSortPreferences = settings.taskBoardSortPreferences && typeof settings.taskBoardSortPreferences === 'object'
          ? settings.taskBoardSortPreferences
          : {};
        this.deckInboxEnabled = resolveDeckInboxEnabled(settings);
        this.myFocusEnabled = resolveMyFocusEnabled(settings);
      }
      // Extract ?token= from URL (e.g. invite/share link) and bootstrap workspace
      if (typeof window !== 'undefined') {
        const invite = extractInviteToken(window.location.href);
        if (invite) {
          this.pendingInviteToken = invite;
          this.superbasedTokenInput = invite.token;
          this.backendUrl = invite.backendUrl;
          this.mergeKnownWorkspaces([invite.workspace]);
          if (invite.workspaceOwnerNpub) {
            // Force-select the invited workspace — overrides any previously saved selection
            this.selectedWorkspaceKey = invite.workspace.workspaceKey || '';
            this.currentWorkspaceOwnerNpub = invite.workspaceOwnerNpub;
            this.ownerNpub = invite.workspaceOwnerNpub;
          }
          window.history.replaceState(null, '', invite.cleanUrl);
        }
      }
      if (!this.pendingInviteToken && this.superbasedTokenInput) {
        const config = parseSuperBasedToken(this.superbasedTokenInput);
        if (config.isValid && config.directHttpsUrl) {
          this.backendUrl = normalizeBackendUrl(config.directHttpsUrl);
          const tokenWorkspace = workspaceFromToken(this.superbasedTokenInput);
          if (tokenWorkspace) {
            this.mergeKnownWorkspaces([tokenWorkspace]);
            this.selectedWorkspaceKey = this.selectedWorkspaceKey || tokenWorkspace.workspaceKey || '';
          }
          if (config.workspaceOwnerNpub) {
            this.currentWorkspaceOwnerNpub = this.currentWorkspaceOwnerNpub || config.workspaceOwnerNpub;
            this.ownerNpub = config.workspaceOwnerNpub;
          }
        }
      }
      if (!this.backendUrl) this.backendUrl = guessDefaultBackendUrl();
      if (this.backendUrl) setBaseUrl(this.backendUrl);
      this.loadTowerTransportSettings();
      if (!this.selectedWorkspaceKey && this.currentWorkspaceOwnerNpub) {
        const legacyMatch = this.knownWorkspaces.find((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub) || null;
        if (legacyMatch) this.selectedWorkspaceKey = legacyMatch.workspaceKey || '';
      }
      if (!this.selectedWorkspaceKey && this.knownWorkspaces.length > 0) {
        this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
        this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
      }
      if (!isTowerPgBackendMode()) {
        if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) {
          await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub, { refresh: false });
        }
        if (this.selectedWorkspaceKey) await this.bootstrapSelectedWorkspace({ runAccessPrune: false });
      }
      await this.maybeAutoLogin();
      if (isTowerPgBackendMode() && this.session?.npub && this.selectedWorkspaceKey) {
        await this.selectWorkspace(this.selectedWorkspaceKey, { refresh: false });
        await this.bootstrapSelectedWorkspace({ runAccessPrune: false });
      }
      this.updateWorkspaceBootstrapPrompt();
      if (this.session?.npub && (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal))) {
        this.openConnectModal();
      }
      this.pendingInviteToken = null; // invite bootstrap complete
      this.routeSyncPaused = false; // unpause route sync after init (no-op if applyRouteFromLocation already unpaused)
      Promise.resolve().then(async () => {
        await this.hydrateKnownWorkspaceProfiles();
        this.updateWorkspaceBootstrapPrompt();
        await this.loadRemoteWorkspaces();
        if (this.showWorkspaceAccessGate || this.prepareWorkspaceAccessGate?.()) {
          this.updateWorkspaceBootstrapPrompt();
          return;
        }
        if (this.knownWorkspaces.length === 0 && this.superbasedConnectionConfig?.workspaceOwnerNpub && this.session?.npub) {
          await this.tryRecoverWorkspace();
        }
        if (!this.selectedWorkspaceKey && this.currentWorkspaceOwnerNpub) {
          const legacyMatch = this.knownWorkspaces.find((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub) || null;
          if (legacyMatch) this.selectedWorkspaceKey = legacyMatch.workspaceKey || '';
        }
        if (!this.selectedWorkspaceKey && this.knownWorkspaces.length > 0) {
          this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
          this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
        }
        if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) {
          await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub, { refresh: false });
        }
        this.updateWorkspaceBootstrapPrompt();
        if (this.session?.npub && (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal))) {
          this.openConnectModal();
        }
        if (this.selectedWorkspaceKey) {
          await this.bootstrapSelectedWorkspace({ runAccessPrune: true });
        }
        this.ensureBackgroundSync();
      }).catch((error) => {
        console.debug('startup remote workspace refresh failed:', error?.message || error);
      });
    },

    async setDeckInboxEnabled(enabled) {
      this.deckInboxEnabled = Boolean(enabled);
      const settings = (await getSettings()) || {};
      await saveSettings({ ...settings, deckInboxEnabled: this.deckInboxEnabled });
    },

    async setMyFocusEnabled(enabled) {
      this.myFocusEnabled = Boolean(enabled);
      const settings = (await getSettings()) || {};
      await saveSettings({ ...settings, myFocusEnabled: this.myFocusEnabled });
    },

    async ensureWorkspaceSessionKey() {
      // PG authorizes the real actor. Its membership is not the legacy v4
      // workspace directory used by /user/workspace-keys registration.
      if (isTowerPgBackendMode()) {
        clearActiveWorkspaceKey();
        return null;
      }
      const workspaceOwnerNpub = this.workspaceOwnerNpub
        || this.currentWorkspaceOwnerNpub
        || this.ownerNpub
        || '';
      const userNpub = this.session?.npub || '';
      if (!workspaceOwnerNpub || !userNpub || !this.backendUrl) return null;

      try {
        return await bootstrapWorkspaceSessionKey({
          workspaceOwnerNpub,
          userNpub,
          onRegister: async (blob, key) => {
            const wsKeyNpub = key?.npub || blob?.ws_key_npub || '';
            if (!wsKeyNpub) throw new Error('Workspace key bootstrap did not produce ws_key_npub');
            await registerWorkspaceKey({
              workspace_owner_npub: workspaceOwnerNpub,
              ws_key_npub: wsKeyNpub,
            });
            markWorkspaceKeyRegistered();
            await markCachedWorkspaceKeyRegistered(workspaceOwnerNpub);
          },
        });
      } catch (error) {
        flightDeckLog('warn', 'workspace-key', 'workspace session key bootstrap failed', {
          workspaceOwnerNpub,
          userNpub,
          error: error?.message || String(error),
        });
        return null;
      }
    },

    async bootstrapSelectedWorkspace(options = {}) {
      if (!this.selectedWorkspaceKey && !this.currentWorkspaceOwnerNpub) return;
      if (!isTowerPgBackendMode()) {
        await this.ensureWorkspaceSessionKey();
        await this.refreshGroups({ maxAgeMs: this.GROUP_KEY_REFRESH_MAX_AGE_MS });
        // Fetch ws_key → user_npub mappings for display identity resolution
        this.refreshWorkspaceKeyMappings().catch(() => {});
        if (options.runAccessPrune === true) {
          this.runAccessPruneOnLogin().catch(() => {});
        }
      } else {
        if (this.session?.npub && typeof this.ensurePgWorkspaceAvailable === 'function') {
          const verifiedWorkspace = await this.ensurePgWorkspaceAvailable(this.currentWorkspace, { allowCached: true });
          if (!verifiedWorkspace) return;
        }
        await this.ensureWorkspaceSessionKey();
        const workspaceKey = this.currentWorkspaceKey || this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub;
        if (this.localWorkspaceCoreLoadedForKey !== workspaceKey) {
          await this.loadLocalWorkspaceCoreData?.({ syncRoute: false });
          this.localWorkspaceCoreLoadedForKey = workspaceKey;
        }
        this.startWorkspaceLiveQueries?.();
        await this.resumePgTaskWriteQueue();
      }
      await this.refreshAddressBook?.();
      this.selectedBoardId = this.readStoredTaskBoardId();
      this.collapsedSections = this.readStoredCollapsedSections();
      this.validateSelectedBoardId();
      await this.applyRouteFromLocation();
      await this.refreshSyncStatus();
      if (this.navSection === 'status') {
        await this.refreshStatusRecentChanges({ force: true });
      }
      if (this.navSection === 'chat' && this.selectedChannelId) {
        this.scheduleChatFeedScrollToBottom();
      }
      if (this.defaultAgentNpub) this.resolveChatProfile(this.defaultAgentNpub);
    },

    createLiveSubscription(query, onNext, options = {}) {
      let pending = null;
      let rafId = null;
      let delivered = false;
      let previous = null;
      const subscription = liveQuery(query).subscribe({
        next: (value) => {
          // Coalesce rapid-fire Dexie notifications into one callback per frame
          pending = value;
          if (rafId != null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            const current = pending;
            pending = null;
            if (delivered && typeof options.equals === 'function' && options.equals(previous, current)) return;
            delivered = true;
            previous = current;
            Promise.resolve(onNext(current)).catch((error) => {
              console.error('Live query update failed:', error?.message || error);
            });
          });
        },
        error: (error) => {
          console.error('Live query failed:', error?.message || error);
        },
      });
      return {
        unsubscribe() {
          if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          pending = null;
          previous = null;
          subscription.unsubscribe();
        },
      };
    },

    stopLiveSubscription(subscription) {
      if (!subscription) return;
      try {
        subscription.unsubscribe();
      } catch {
        /* ignore */
      }
    },

    initRouteSync() {
      if (typeof window === 'undefined' || this.popstateHandler) return;
      this.popstateHandler = () => {
        this.applyRouteFromLocation();
      };
      window.addEventListener('popstate', this.popstateHandler);
    },

    updatePageTitle() {
      if (typeof document === 'undefined') return;
      document.title = this.currentDocumentTitle;
    },

    initDocCommentConnector() {
      if (typeof window === 'undefined' || this.docConnectorScrollHandler || this.docConnectorResizeHandler) return;
      this.docConnectorScrollHandler = () => this.scheduleDocCommentConnectorUpdate();
      this.docConnectorResizeHandler = () => this.scheduleDocCommentConnectorUpdate();
      window.addEventListener('scroll', this.docConnectorScrollHandler, { passive: true });
      window.addEventListener('resize', this.docConnectorResizeHandler, { passive: true });

      document.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        const storageFileCard = e.target.closest('.md-storage-file-card[data-storage-object-id]');
        if (storageFileCard) {
          e.preventDefault();
          const objectId = storageFileCard.dataset.storageObjectId;
          const fileName = storageFileCard.dataset.storageFileName;
          this.downloadStorageObjectAsFile(objectId, fileName);
          return;
        }

        const routeLink = e.target.closest('a[href]');
        if (routeLink && this.handleInternalRouteReference(routeLink.href, e, routeLink.textContent?.trim(), { validateOnly: routeLink.classList.contains('mention-link') })) return;

        const link = e.target.closest('.mention-link');
        if (!link) return;
        this.handleMentionLinkClick(e, link);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const link = e.target.closest('.mention-link[role="link"]');
        if (!link || link.tagName === 'A') return;
        this.handleMentionLinkClick(e, link);
      });
      document.addEventListener('pointerover', (e) => {
        const link = e.target.closest('.mention-link[data-mention-type]');
        if (!link) return;
        if (normalizeRecordLinkType(link.dataset.mentionType) !== 'doc') return;
        this.prefetchFlightDeckDoc(link.dataset.mentionId);
      }, { passive: true });
      document.addEventListener('focusin', (e) => {
        const link = e.target.closest('.mention-link[data-mention-type]');
        if (!link) return;
        if (normalizeRecordLinkType(link.dataset.mentionType) !== 'doc') return;
        this.prefetchFlightDeckDoc(link.dataset.mentionId);
      });
    },

    clearDocCommentConnector() {
      this.docCommentConnector = { visible: false, path: '' };
    },

    scheduleDocCommentConnectorUpdate() {
      if (typeof window === 'undefined') return;
      if (this.docConnectorFrame) window.cancelAnimationFrame(this.docConnectorFrame);
      this.docConnectorFrame = window.requestAnimationFrame(() => {
        this.docConnectorFrame = null;
        this.updateDocCommentConnector();
      });
    },

    updateDocCommentConnector() {
      if (typeof document === 'undefined') {
        this.clearDocCommentConnector();
        return;
      }
      if (!this.docCommentsVisible || !this.selectedDocComment) {
        this.clearDocCommentConnector();
        return;
      }

      const layout = document.querySelector('[data-doc-content-layout]');
      const panel = document.querySelector('[data-doc-thread-panel]');
      const anchorBlockId = String(this.selectedDocComment?.anchor_block_id || '').trim();
      const anchorLine = this.selectedDocComment?.anchor_line_number || 1;
      const escapedBlockId = anchorBlockId && window.CSS?.escape
        ? window.CSS.escape(anchorBlockId)
        : anchorBlockId.replace(/"/g, '\\"');
      const marker = escapedBlockId
        ? document.querySelector(`[data-doc-anchor-block-id="${escapedBlockId}"]`)
        : document.querySelector(`[data-doc-anchor-line="${anchorLine}"]`);

      if (!layout || !panel || !marker) {
        this.clearDocCommentConnector();
        return;
      }

      const layoutRect = layout.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();

      const markerX = markerRect.left + (markerRect.width / 2) - layoutRect.left;
      const markerY = markerRect.top + (markerRect.height / 2) - layoutRect.top;
      const panelX = panelRect.left - layoutRect.left;
      const panelY = panelRect.top + 56 - layoutRect.top;
      const elbowX = Math.max(markerX + 24, panelX - 28);

      this.docCommentConnector = {
        visible: true,
        path: `M ${panelX} ${panelY} H ${elbowX} V ${markerY} H ${markerX}`,
      };
    },

    // currentWorkspaceSlug getter in workspaceManagerMixin

    getRoutePath(section = this.navSection) {
      const slug = this.currentWorkspaceSlug;
      const enabledSection = normalizeEnabledFlightDeckSection(section);
      if (enabledSection === 'workroom') {
        return this.activeWorkroomId
          ? `/${slug}/workroom/${encodeURIComponent(this.activeWorkroomId)}`
          : `/${slug}/workroom`;
      }
      const page = (() => {
        switch (enabledSection) {
          case 'status': return 'flight-deck';
          case 'context': return 'context';
          case 'tasks': return 'tasks';
          case 'chat': return 'chat';
          case 'docs': return 'docs';
          case 'files': return 'files';
          case 'workroom': return 'workroom';
          case 'reports': return 'reports';
          case 'opportunities': return 'opportunities';
          case 'people': return 'people';
          case 'settings': return 'settings';
          default: return 'flight-deck';
        }
      })();
      return `/${slug}/${page}`;
    },

    buildRouteUrl() {
      if (typeof window === 'undefined') return '';
      const url = new URL(window.location.href);
      url.pathname = this.getRoutePath();
      url.search = '';
      if (this.currentWorkspaceKey) url.searchParams.set('workspacekey', this.currentWorkspaceKey);

      // Always preserve scopeid across all sections so browser history
      // retains the active scope when navigating between tasks/chat/docs/etc.
      if (this.selectedBoardId) url.searchParams.set('scopeid', this.selectedBoardId);

      const enabledSection = normalizeEnabledFlightDeckSection(this.navSection);
      if (enabledSection !== this.navSection) this.navSection = enabledSection;

      if (this.navSection === 'chat') {
        if (this.selectedChannelId) url.searchParams.set('channelid', this.selectedChannelId);
        if (this.activeThreadId) url.searchParams.set('threadid', this.activeThreadId);
      } else if (this.navSection === 'docs') {
        if (this.selectedChannelId) url.searchParams.set('channelid', this.selectedChannelId);
        if (this.docsShowAll && !this.selectedDocId) url.searchParams.set('docsview', 'all');
        if (this.currentFolderId) url.searchParams.set('folderid', this.currentFolderId);
        if (this.selectedDocType === 'document' && this.selectedDocId) {
          url.searchParams.set('docid', this.selectedDocId);
        }
        if (this.docVersioningOpen) url.searchParams.set('versioning', '1');
        if (this.selectedDocCommentId) url.searchParams.set('commentid', this.selectedDocCommentId);
      } else if (this.navSection === 'reports') {
        if (this.selectedReport?.record_id) url.searchParams.set('reportid', this.selectedReport.record_id);
      } else if (this.navSection === 'opportunities') {
        if (this.activeOpportunityId) url.searchParams.set('opportunityid', this.activeOpportunityId);
      } else if (this.navSection === 'tasks') {
        if (this.showBoardDescendantTasks) url.searchParams.set('descendants', '1');
        if (this.navSection === 'tasks' && this.activeTaskId) url.searchParams.set('taskid', this.activeTaskId);
        if (this.navSection === 'tasks' && this.taskViewMode === 'list') url.searchParams.set('view', 'list');
        if (normalizeTaskSortMode(this.taskSortMode) !== 'manual') url.searchParams.set('sort', normalizeTaskSortMode(this.taskSortMode));
      }

      return `${url.pathname}${url.search}`;
    },

    syncRoute(replace = false) {
      this.updatePageTitle();
      if (this.routeSyncPaused || typeof window === 'undefined') return;
      const nextUrl = this.buildRouteUrl();
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (nextUrl === currentUrl) return;
      const state = { section: this.navSection };
      if (this.navSection === 'docs' && this.selectedDocId && this.docDetailOriginRoute) {
        state.docDetailOriginRoute = this.docDetailOriginRoute;
      }
      if (replace) window.history.replaceState(state, '', nextUrl);
      else window.history.pushState(state, '', nextUrl);
    },

    getTaskSortPreferenceKey() {
      return String(
        this.currentWorkspaceKey
        || this.selectedWorkspaceKey
        || this.currentWorkspaceSlug
        || this.workspaceOwnerNpub
        || 'default',
      ).trim() || 'default';
    },

    readPersistedTaskSortMode() {
      const key = this.getTaskSortPreferenceKey();
      const preferences = this.taskBoardSortPreferences && typeof this.taskBoardSortPreferences === 'object'
        ? this.taskBoardSortPreferences
        : {};
      return normalizeTaskSortMode(preferences[key]);
    },

    async persistTaskSortMode(mode = this.taskSortMode) {
      const normalizedMode = normalizeTaskSortMode(mode);
      const key = this.getTaskSortPreferenceKey();
      const nextPreferences = {
        ...(this.taskBoardSortPreferences && typeof this.taskBoardSortPreferences === 'object'
          ? this.taskBoardSortPreferences
          : {}),
        [key]: normalizedMode,
      };
      this.taskBoardSortPreferences = nextPreferences;
      try {
        const settings = await getSettings() || {};
        await saveSettings({
          ...settings,
          taskBoardSortPreferences: nextPreferences,
        });
      } catch (error) {
        console.warn('[flightdeck] failed to persist task board sort preference', error);
      }
    },

    async applyRouteFromLocation() {
      const route = parseRouteLocation();
      this.routeSyncPaused = true;
      try {
        if (route.params.workspacekey) {
          const targetByKey = findWorkspaceByKey(this.knownWorkspaces, route.params.workspacekey);
          if (targetByKey && targetByKey.workspaceKey !== this.currentWorkspaceKey) {
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(targetByKey.workspaceKey);
            return;
          }
        }

        if (route.params.workspaceid) {
          const targetById = findWorkspaceById(this.knownWorkspaces, route.params.workspaceid);
          if (targetById && targetById.workspaceKey !== this.currentWorkspaceKey) {
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(targetById.workspaceKey || targetById.workspaceOwnerNpub);
            return;
          }
        }

        // Handle workspace slug from URL
        if (route.workspaceSlug) {
          const target = findWorkspaceBySlug(this.knownWorkspaces, route.workspaceSlug);
          if (target && target.workspaceKey !== this.currentWorkspaceKey) {
            // Different workspace slug — switch workspace
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(target.workspaceKey || target.workspaceOwnerNpub);
            return;
          }
        } else if (!route.workspaceSlug && this.selectedWorkspaceKey) {
          // Bare /<page> URL (no slug) — redirect to /<slug>/<page>
          // This is handled by syncRoute(true) at the bottom
        }

        this.navSection = normalizeEnabledFlightDeckSection(route.section);
        this.mobileNavOpen = false;

        // Restore scopeid from URL for all sections so browser history
        // preserves the active scope across tasks/chat/docs/reports.
        if (route.params.scopeid || route.params.groupid) {
          this.selectedBoardId = route.params.scopeid
            || route.params.groupid
            || this.readStoredTaskBoardId()
            || this.preferredTaskBoardId;
          this.validateSelectedBoardId();
          this.persistSelectedBoardId(this.selectedBoardId);
        }

        if (this.navSection === 'chat') {
          const visibleChannels = Array.isArray(this.scopeFilteredChannels) ? this.scopeFilteredChannels : [];
          const isVisibleChannel = (channelId) => visibleChannels.some((channel) => channel.record_id === channelId);
          const routeChannelId = route.params.channelid || null;
          const selectedVisibleChannelId = this.selectedChannelId && isVisibleChannel(this.selectedChannelId)
            ? this.selectedChannelId
            : null;
          const selectedPgBoard = parsePgTaskBoardId(this.selectedBoardId);
          const pgScopeHome = Boolean((this.currentWorkspace?.pgBackendMode || this.pgBackendMode) && selectedPgBoard.type === 'scope' && selectedPgBoard.scopeId);
          const channelId = routeChannelId && isVisibleChannel(routeChannelId)
            ? routeChannelId
            : (pgScopeHome ? null : selectedVisibleChannelId || visibleChannels[0]?.record_id || null);
          if (channelId) {
            await this.selectChannel(channelId, { syncRoute: false });
            if (route.params.threadid) this.openThread(route.params.threadid, { syncRoute: false });
            else this.closeThread({ syncRoute: false });
          } else {
            this.selectedChannelId = null;
            this.closeThread({ syncRoute: false });
          }
        } else if (this.navSection === 'workroom') {
          if (route.params.workroomid && typeof this.openWorkroomDetail === 'function') {
            await this.openWorkroomDetail(route.params.workroomid, { syncRoute: false });
          } else if (this.workroomDetailOpen) {
            this.closeWorkroomDetail({ syncRoute: false, switchView: false });
          }
        } else if (this.navSection === 'docs') {
          this.docsHomeVisit++;
          this.docsShowAll = route.params.docsview === 'all';
          this.selectedDocCommentId = route.params.commentid || null;
          if (route.params.docid) {
            this.openDoc(route.params.docid, {
              syncRoute: false,
              commentId: route.params.commentid || null,
              captureOrigin: false,
              originRoute: window.history.state?.docDetailOriginRoute || '',
            });
            if (route.params.versioning) this.openDocVersioning();
          } else if (route.params.folderid) {
            this.navigateToFolder(route.params.folderid, { syncRoute: false });
          } else {
            this.closeDocEditor?.({ syncRoute: false });
            this.currentFolderId = null;
            this.loadDocEditorFromSelection();
            if (!this.docsShowAll) void this.openChannelDocsHome?.({ syncRoute: false });
          }
        } else if (this.navSection === 'reports') {
          this.selectedReportId = route.params.reportid || this.selectedReport?.record_id || null;
        } else if (this.navSection === 'tasks') {
          // Scope already restored above; apply task-specific params
          if (!route.params.scopeid && !route.params.groupid) {
            this.selectedBoardId = this.readStoredTaskBoardId() || this.preferredTaskBoardId;
            this.validateSelectedBoardId();
            this.persistSelectedBoardId(this.selectedBoardId);
          }
          this.showBoardDescendantTasks = route.params.descendants === '1';
          if (route.params.view === 'list') this.taskViewMode = 'list';
          else if (route.params.view === 'kanban') this.taskViewMode = 'kanban';
          else this.taskViewMode = typeof window !== 'undefined' && window.innerWidth <= 768 ? 'list' : 'kanban';
          if (route.params.sort) {
            this.taskSortMode = normalizeTaskSortMode(route.params.sort);
            this.persistTaskSortMode(this.taskSortMode);
          } else {
            this.taskSortMode = this.readPersistedTaskSortMode();
          }
          this.normalizeTaskFilterTags();
          if (route.params.taskid) {
            await this.openTaskDetailFromRoute(route.params.taskid, { syncRoute: false });
          } else {
            this.closeTaskDetail({ syncRoute: false });
          }
        }
      } finally {
        this.routeSyncPaused = false;
      }
      this.startWorkspaceLiveQueries();
      this.syncRoute(true);
    },

    startExtensionSignerWatch() {
      // Remove any previously registered listeners to avoid duplicates
      this.stopExtensionSignerWatch();

      this.refreshExtensionSignerAvailability();
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      if (this.extensionSignerPollTimer) clearInterval(this.extensionSignerPollTimer);
      this.extensionSignerPollTimer = window.setInterval(() => {
        this.refreshExtensionSignerAvailability();
      }, 1000);
      window.setTimeout(() => {
        if (this.extensionSignerPollTimer) {
          clearInterval(this.extensionSignerPollTimer);
          this.extensionSignerPollTimer = null;
        }
      }, 15000);

      const refresh = () => this.refreshExtensionSignerAvailability();
      this._extensionSignerRefresh = refresh;
      window.addEventListener('focus', refresh, { passive: true });
      window.addEventListener('pageshow', refresh, { passive: true });
      document.addEventListener('visibilitychange', refresh, { passive: true });
    },

    stopExtensionSignerWatch() {
      if (this.extensionSignerPollTimer) {
        clearInterval(this.extensionSignerPollTimer);
        this.extensionSignerPollTimer = null;
      }
      if (this._extensionSignerRefresh) {
        window.removeEventListener('focus', this._extensionSignerRefresh);
        window.removeEventListener('pageshow', this._extensionSignerRefresh);
        document.removeEventListener('visibilitychange', this._extensionSignerRefresh);
        this._extensionSignerRefresh = null;
      }
    },

    async refreshExtensionSignerAvailability() {
      this.extensionSignerAvailable = hasExtensionSigner();
      if (!this.extensionSignerAvailable) {
        this.extensionSignerAvailable = await waitForExtensionSigner(900, 120);
      }
      return this.extensionSignerAvailable;
    },

    async maybeAutoLogin() {
      try {
        const storedAuth = await tryAutoLoginFromStorage();
        if (!storedAuth) return;

        if (storedAuth.needsReconnect && storedAuth.method === 'bunker') {
          await this.login('bunker', storedAuth.bunkerUri);
          return;
        }

        const npub = await pubkeyToNpub(storedAuth.pubkey);
        this.session = {
          pubkey: storedAuth.pubkey,
          npub,
          method: storedAuth.method,
        };
        setActiveSessionNpub(npub);
        this.ownerNpub = this.currentWorkspaceOwnerNpub || this.superbasedConnectionConfig?.workspaceOwnerNpub || npub;
        this.resolveChatProfile(npub);
        await this.rememberPeople([npub], 'self');
        this.discoverPgOnboardingAnnouncements?.().catch?.(() => {});
        this.discoverPgWorkspaceSelfIndex?.().catch?.(() => {});
        if (!this.selectedWorkspaceKey && this.currentWorkspaceOwnerNpub) {
          const legacyMatch = this.knownWorkspaces.find((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub) || null;
          if (legacyMatch) this.selectedWorkspaceKey = legacyMatch.workspaceKey || '';
        }
        if (!this.selectedWorkspaceKey && this.knownWorkspaces.length > 0) {
          this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
          this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
        }
        this.updateWorkspaceBootstrapPrompt();
        if (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal)) {
          this.openConnectModal();
        }
      } catch (error) {
        this.loginError = error.message;
      }
    },

    // --- auth ---

    async login(method, supplemental = null) {
      this.isLoggingIn = true;
      this.loginError = null;
      try {
        const signedEvent = await signLoginEvent(method, supplemental);
        const pubkey = getPubkeyFromEvent(signedEvent);
        const npub = await pubkeyToNpub(pubkey);

        this.session = { pubkey, npub, method };
        setActiveSessionNpub(npub);
        this.ownerNpub = this.currentWorkspaceOwnerNpub || this.superbasedConnectionConfig?.workspaceOwnerNpub || npub;
        setAutoLogin(method, pubkey);
        this.resolveChatProfile(npub);
        await this.rememberPeople([npub], 'self');
        this.updateWorkspaceBootstrapPrompt();

        await this.discoverPgOnboardingAnnouncements();
        await this.discoverPgWorkspaceSelfIndex();
        await this.loadRemoteWorkspaces();
        if (this.showWorkspaceAccessGate || this.prepareWorkspaceAccessGate?.()) {
          this.updateWorkspaceBootstrapPrompt();
          return;
        }
        if (!this.selectedWorkspaceKey && this.currentWorkspaceOwnerNpub) {
          const legacyMatch = this.knownWorkspaces.find((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub) || null;
          if (legacyMatch) this.selectedWorkspaceKey = legacyMatch.workspaceKey || '';
        }
        if (!this.selectedWorkspaceKey && this.knownWorkspaces.length > 0) {
          this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
          this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
        }
        if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) {
          await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub, { refresh: false });
        }

        // A denied/failed selection must not mount or replay retained state.
        if (this.selectedWorkspaceKey && this.localWorkspaceCoreLoadedForKey !== this.selectedWorkspaceKey) return;

        await this.persistWorkspaceSettings();

        if (this.selectedWorkspaceKey) {
          await this.bootstrapSelectedWorkspace({ runAccessPrune: true });
        }
        this.updateWorkspaceBootstrapPrompt();
        if (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal)) {
          this.openConnectModal();
        }
        this.ensureBackgroundSync(true);
      } catch (error) {
        console.error('Login failed:', error);
        this.loginError = error.message || 'Login failed.';
      } finally {
        this.isLoggingIn = false;
      }
    },

    async logout() {
      try {
        if (this.docEditDraftDirty) await this.persistSelectedDocDraft?.({ immediate: true });
      } finally {
        // A draft-storage failure must still end authentication.
        detachLoggedOutWorkspace(this);
        await clearAutoLogin();
      }
      this.session = null;
      this.ownerNpub = '';
      this.channels = [];
      this.messages = [];
      this.chatPresentationCache?.clear?.();
      this.groups = [];
      this.documents = [];
      this.directories = [];
      this.fileFolders = [];
      this.fileCurrentFolderId = '';
      this.fileSelectionMode = false;
      this.fileSelectedRowIds = [];
      this.fileDraggingRowIds = [];
      this.fileFolderDragOverId = '';
      this.fileMessages = [];
      this.fileComments = [];
      this.addressBookPeople = [];
      this.jobDefinitions = [];
      this.jobRuns = [];
      this.jobsError = null;
      this.jobsSuccess = null;
      this.selectedChannelId = null;
      this.activeThreadId = null;
      this.selectedDocId = null;
      this.selectedDocType = null;
      this.closeChatDocModal();
      await this.closeChatTaskModal();
      this.messageInput = '';
      this.threadInput = '';
      this.cancelMessageEdit?.({ restoreDraft: false });
      this.docEditorTitle = '';
      this.docEditorContent = '';
      this.docEditorShares = [];
      this.docShareQuery = '';
      this.newGroupName = '';
      this.newGroupMemberQuery = '';
      this.newGroupMembers = [];
      this.chatProfiles = {};
      this.workspaceProfileRowsByKey = {};
      this.selectedWorkspaceKey = '';
      this.localWorkspaceCoreLoadedForKey = '';
      this.currentWorkspaceOwnerNpub = '';
      this.workspaceSwitchPendingKey = '';
      this.workspaceSwitchPendingNpub = '';
      this.workspaceSettingsRecordId = '';
      this.workspaceSettingsVersion = 0;
      this.personalAgentSettingsRowVersion = 0;
      this.workspaceSettingsGroupIds = [];
      this.workspaceHarnessUrl = '';
      this.workspaceHarnessAgentNpub = '';
      this.workspaceHarnessAgents = [];
      this.revokeWorkspaceAvatarPreviewObjectUrl();
      this.hasBootstrappedUnreadTracking = false;
      this.workspaceProfileNameInput = '';
      this.workspaceProfileSlugInput = '';
      this.workspaceProfileDescriptionInput = '';
      this.workspaceProfileAvatarInput = '';
      this.workspaceProfileAvatarPreviewUrl = '';
      this.workspaceProfilePendingAvatarFile = null;
      this.workspaceProfileDirty = false;
      this.workspaceProfileSaving = false;
      this.workspaceProfileError = null;
      this.defaultAgentQuery = '';
      this.hasForcedTaskFamilyBackfill = false;
      this.wingmanHarnessInput = '';
      this.wingmanHarnessDraftAgentNpub = '';
      this.wingmanHarnessAgentQuery = '';
      this.wingmanHarnessError = null;
      this.wingmanHarnessDirty = false;
      this.hasForcedInitialBackfill = false;
      this.docCommentBackfillAttemptsByDocId = {};
      this.loginError = null;
      this.error = null;
      this.showAvatarMenu = false;
      this.syncRoute(true);
    },

    hasExtensionSigner() {
      return this.extensionSignerAvailable;
    },

    // uploadWorkspaceAvatarFile, saveWorkspaceProfile, saveHarnessSettings — in workspaceManagerMixin

    openHarnessLink() {
      const launchUrl = normalizedAutopilotLaunchUrl(this.workspaceHarnessUrl);
      if (!launchUrl || typeof window === 'undefined') return;
      window.open(launchUrl, '_blank', 'noopener,noreferrer');
    },

    openPersonalAgentsOverlay() {
      const agents = this.visiblePersonalAgents;
      if (agents.length === 1) {
        this.openPersonalAgent(agents[0]);
        return;
      }
      if (agents.length > 1) {
        this.closePersonalWappsOverlay();
        this.personalAgentsOverlayOpen = !this.personalAgentsOverlayOpen;
      }
    },

    closePersonalAgentsOverlay() {
      this.personalAgentsOverlayOpen = false;
    },

    openPersonalAgent(agent) {
      const launchUrl = normalizedAutopilotLaunchUrl(agent?.launch_url);
      if (!launchUrl || typeof window === 'undefined') return;
      window.open(launchUrl, '_blank', 'noopener,noreferrer');
      this.closePersonalAgentsOverlay();
    },

    togglePrimaryNav() {
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        this.mobileNavOpen = !this.mobileNavOpen;
        return;
      }
      this.navCollapsed = !this.navCollapsed;
    },

    toggleAppHeaderHidden() {
      this.appHeaderHidden = !this.appHeaderHidden;
    },

    openChannelSettings(channelId = null) {
      const normalizedChannelId = String(channelId || '').trim();
      if (normalizedChannelId) this.selectedChannelId = normalizedChannelId;
      const selectedChannel = this.selectedChannel || this.channels?.find((channel) => channel?.record_id === this.selectedChannelId);
      if (!selectedChannel) return;
      this.closeScopePicker();
      this.closeChannelScopePicker();
      this.channelDeleteConfirmArmed = false;
      this.showChannelSettingsModal = true;
    },

    closeChannelSettings() {
      this.closeChannelScopePicker();
      this.channelDeleteConfirmArmed = false;
      this.showChannelSettingsModal = false;
    },

    // Release domain arrays for sections the user is leaving.
    // Keeps memory stable by not accumulating all sections simultaneously.
    // Data is re-fetched via liveQuery when navigating back.
    clearInactiveSectionData(activeSection) {
      if (activeSection !== 'chat') {
        this.cancelMessageEdit?.();
        this.messages = [];
        this.audioNotes = [];
      }
      if (activeSection !== 'tasks') {
        this.tasks = [];
        this.taskComments = [];
        this.taskCommentsFullscreenOpen = false;
        this.showTaskDetail = false;
        this.editingTask = null;
      }
      if (activeSection !== 'docs') {
        this.documents = [];
        this.directories = [];
        this.docComments = [];
      }
      if (activeSection !== 'files') {
        this.fileSelectionMode = false;
        this.fileSelectedRowIds = [];
        this.fileDraggingRowIds = [];
        this.fileFolderDragOverId = '';
        this.fileMessages = [];
        this.fileComments = [];
      }
      if (activeSection !== 'reports' && activeSection !== 'status') {
        this.reports = [];
      }
      if (activeSection !== 'settings') {
        this.schedules = [];
      }
      if (activeSection !== 'status') {
        this.statusRecentChanges = [];
      }
      if (activeSection !== 'opportunities') {
        this.opportunityComments = [];
        this.showOpportunityEditor = false;
        this.editingOpportunity = null;
        this.activeOpportunityId = null;
      }
    },

    navigateTo(section, options = {}) {
      const enabledSection = normalizeEnabledFlightDeckSection(section);
      if (enabledSection !== section) {
        const surfaceId = section === 'reports' ? 'reports' : section === 'people' ? 'people' : section === 'opportunities' ? 'opportunities' : '';
        if (surfaceId) blockDisabledFlightDeckSurface(this, surfaceId);
        section = enabledSection;
      }
      const previousSection = this.navSection;
      const docsVisit = this.docsHomeVisit = Number(this.docsHomeVisit || 0) + 1;
      if (previousSection === 'docs' && section !== 'docs' && this.docEditDraftDirty && !options.draftPreserved) {
        const originId = this.selectedDocId;
        return this.preserveWikiNavigationDraft().then((preserved) => {
          if (!preserved || docsVisit !== this.docsHomeVisit || originId !== this.selectedDocId || this.navSection !== previousSection) return false;
          return this.navigateTo(section, { ...options, draftPreserved: true });
        });
      }
      if (previousSection === 'docs' && section !== 'docs' && this.selectedDocId) {
        this.closeDocEditor?.({ syncRoute: false });
      }
      if (previousSection !== section) this.stopReadAloud();
      const pgTaskBoardFromChat = section === 'tasks'
        && this.navSection === 'chat'
        && isTowerPgBackendMode()
        && this.selectedChannelId
        ? buildPgChannelTaskBoardId(this.selectedChannelId)
        : '';
      if (previousSection !== section) {
        this.clearInactiveSectionData(section);
      }
      this.navSection = section;
      if (section !== 'workroom' && this.workroomDetailOpen && options.preserveWorkroom !== true) {
        this.closeWorkroomDetail?.({ syncRoute: false, switchView: false });
      }
      this.mobileNavOpen = false;
      this.showWorkspaceSwitcherMenu = false;
      if (section === 'tasks' || section === 'reports' || section === 'files' || section === 'workroom') {
        if (section === 'tasks' && pgTaskBoardFromChat) {
          this.selectedBoardId = pgTaskBoardFromChat;
          this.persistSelectedBoardId(this.selectedBoardId);
          this.showBoardDescendantTasks = false;
        }
        this.validateSelectedBoardId();
        this.normalizeTaskFilterTags();
      }
      if (section !== 'settings') {
        this.showNewScheduleModal = false;
        this.cancelEditSchedule();
      }
      if (section !== 'docs') {
        this.selectedDocCommentId = null;
      }
      if (section === 'chat') {
        const visibleChannels = Array.isArray(this.scopeFilteredChannels) ? this.scopeFilteredChannels : [];
        const selectedVisible = this.selectedChannelId
          && visibleChannels.some((channel) => channel.record_id === this.selectedChannelId);
        const selectedPgBoard = parsePgTaskBoardId(this.selectedBoardId);
        const pgScopeHome = Boolean((this.currentWorkspace?.pgBackendMode || this.pgBackendMode) && selectedPgBoard.type === 'scope' && selectedPgBoard.scopeId);
        if (!selectedVisible && !pgScopeHome) {
          this.ensureSelectedChatChannelInScope();
        } else if (this.selectedChannelId) {
          if (previousSection !== 'chat' && typeof this.selectChannel === 'function') {
            void this.selectChannel(this.selectedChannelId, { syncRoute: false });
          } else {
            this.pendingChatScrollToLatest = true;
            this.scheduleChatFeedScrollToBottom();
          }
        }
      }
      if (section === 'docs' && options.docsHome !== false) {
        void this.openChannelDocsHome?.();
      }
      if (section === 'status') {
        this.refreshStatusRecentChanges({ force: true });
      }
      if (section === 'agents') {
        void this.initializeControlledRestartLifecycle?.();
      }
      if (section === 'files' && isTowerPgBackendMode()) {
        Promise.resolve()
          .then(() => this.refreshDocuments())
          .catch((error) => {
            console.warn('Failed to refresh PG file folders', error);
          });
      }
      if (section === 'reports' && !this.selectedReportId) {
        this.selectedReportId = this.selectedReport?.record_id || null;
      }
      if (section === 'settings') {
        this.normalizeSettingsTab?.();
        if (this.settingsTab === 'schedules') this.refreshSchedules();
        if (this.settingsTab === 'scopes') this.refreshScopes();
        if (this.settingsTab === 'sharing') this.prepareWorkspaceSharingSettings?.();
        if (this.settingsTab === 'notifications') this.refreshNotificationSettings?.();
      }
      if (options.syncRoute !== false) this.syncRoute();
      this.startWorkspaceLiveQueries();
      this.ensureBackgroundSync(true);
    },

    // channelsManagerMixin applied via applyMixins

    // chatMessageManagerMixin applied via applyMixins (scroll, composer, messages, threads)

    // audioRecordingManagerMixin applied via applyMixins (has getters)
    // storageImageManagerMixin applied via applyMixins

    applyDirectories(directories = []) {
      const nextDirectories = Array.isArray(directories)
        ? directories.map((item) => this.normalizeDirectoryRowGroupRefs ? this.normalizeDirectoryRowGroupRefs(item) : item)
        : [];
      if (!sameListBySignature(this.directories, nextDirectories)) {
        this.directories = nextDirectories;
      }
      this.updatePageTitle();
    },

    async refreshDirectories() {
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return;
      this.applyDirectories(await getDirectoriesByOwner(ownerNpub));
    },

    applyDocuments(documents = []) {
      const currentDocumentsById = new Map((this.documents || [])
        .filter((item) => item?.record_id)
        .map((item) => [item.record_id, item]));
      const nextDocuments = Array.isArray(documents)
        ? documents.map((item) => {
          const normalized = this.normalizeDocumentRowGroupRefs ? this.normalizeDocumentRowGroupRefs(item) : item;
          return preserveHydratedDocumentContent(currentDocumentsById.get(normalized?.record_id), normalized);
        })
        : [];
      if (!sameListBySignature(this.documents, nextDocuments, documentRecordSignature)) {
        this.documents = nextDocuments;
      }
      this.docRichEditorAdapter?.refreshWikiLinks?.();
      this.refreshOpenDocFromLatestDocument({ force: false });
      this.updatePageTitle();
    },

    async refreshDocuments() {
      if (isTowerPgBackendMode()) {
        return this.requestTowerSyncFamily?.('documents') ?? [];
      }
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return;
      const documents = await getDocumentsByOwner(ownerNpub);
      this.applyDocuments(documents);
      return documents;
    },

    getTodayDateKey() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    },

    getDailyScopeDateKey() {
      return this.dailyScopeSelectedDate || this.getTodayDateKey();
    },

    getDailyNoteScopeMetadata() {
      const selectedChannelId = this.selectedChannelId || this.pgContextSelectedChannelId || '';
      const selectedChannel = selectedChannelId
        ? (this.channels || []).find((channel) => channel.record_id === selectedChannelId)
        : null;
      const scopeId = selectedChannel?.scope_id || this.selectedBoardId || this.selectedBoardScope?.record_id || '';
      return {
        scope_id: scopeId || null,
        channel_id: selectedChannelId || null,
      };
    },

    getDailyScopePersonalMetadata(metadata = {}) {
      const { scope_id: _scopeId, channel_id: _channelId, scopeId: _camelScopeId, channelId: _camelChannelId, ...rest } = metadata || {};
      return {
        ...rest,
        source: rest.source || 'manual',
      };
    },

    getCurrentDailyNote(noteDate = this.getDailyScopeDateKey()) {
      const context = resolveTowerPgWorkspaceContext(this);
      const ownerNpub = context.workspaceOwnerNpub || '';
      const notes = (this.dailyNotes || [])
        .filter((note) =>
          note?.record_state !== 'deleted'
          && String(note.note_date || '') === noteDate
          && (!ownerNpub || !note.owner_actor_npub || note.owner_actor_npub === ownerNpub || note.owner_npub === ownerNpub)
        )
        .sort((left, right) => {
          const ts = Date.parse(right.updated_at || '') - Date.parse(left.updated_at || '');
          if (Number.isFinite(ts) && ts !== 0) return ts;
          return String(left.record_id || '').localeCompare(String(right.record_id || ''));
        });
      return notes[0] || null;
    },

    get dailyNoteComponentTitle() {
      return this.getCurrentDailyNote()?.title || 'Daily note';
    },

    get dailyNoteComponentPreview() {
      const note = this.getCurrentDailyNote();
      if (!note) return 'Create your Daily Scope for today';
      const items = Array.isArray(note.items) ? note.items : [];
      const labels = items.map((item) => String(item?.text || item?.label || '').trim()).filter(Boolean).slice(0, 5);
      return labels.length > 0 ? labels.join(' • ') : (note.body || note.focus || 'Open today’s note');
    },

    get dailyNoteChecklistProgress() {
      const note = this.getCurrentDailyNote();
      const items = Array.isArray(note?.items) ? note.items.slice(0, 5) : [];
      const done = items.filter((item) => item?.completed === true).length;
      return items.length > 0 ? `${done}/${items.length} done` : 'No tasks yet';
    },

    get dailyNoteEditorVersionLabel() {
      const note = (this.dailyNotes || []).find((item) => item.record_id === this.dailyNoteEditorRecordId) || null;
      const version = Number(note?.version || note?.row_version || 0);
      return version > 0 ? `Version ${version}` : '';
    },

    get dailyNoteEditorPreviewHtml() {
      return this.renderMarkdown(this.dailyNoteEditorBody || '');
    },

    dailyNoteVersionSource(version) {
      if (!version) return '';
      const focus = String(version.focus || '').trim();
      const items = this.normalizeDailyNoteItemsForDisplay(version.items || []);
      const checklist = items.length > 0
        ? items.map((item) => `${item.completed ? '- [x]' : '- [ ]'} ${item.text}`).join('\n')
        : '';
      return [
        `# ${version.title || 'Daily note'}`,
        focus ? `Focus: ${focus}` : '',
        checklist,
        String(version.body || '').trim(),
      ].filter(Boolean).join('\n\n');
    },

    async openDailyNoteVersioning() {
      const note = (this.dailyNotes || []).find((item) => item.record_id === this.dailyNoteEditorRecordId) || this.getCurrentDailyNote();
      if (!note || !isTowerPgBackendMode()) return;
      this.dailyNoteVersioningOpen = true;
      this.dailyNoteVersionHistory = [];
      this.dailyNoteVersioningLoading = true;
      this.dailyNoteVersioningError = null;
      this.dailyNoteVersioningSelectedIndex = -1;
      this.dailyNoteVersioningPreviewHtml = '';
      this.dailyNoteDiffMode = false;
      this.dailyNoteDiffHunks = [];
      this.dailyNoteDiffFromIndex = -1;
      this.dailyNoteDiffToIndex = -1;
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId || !context.baseUrl) throw new Error('Flight Deck PG workspace is not connected.');
        const result = await getTowerPgDailyNoteVersions(context.workspaceId, note.record_id, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
          limit: 50,
        });
        const versions = Array.isArray(result?.versions) ? result.versions : [];
        this.dailyNoteVersionHistory = versions.map((version) => ({
          version: version.version ?? version.row_version ?? 0,
          title: version.title || 'Daily note',
          body: typeof version.body === 'string' ? version.body : '',
          focus: typeof version.focus === 'string' ? version.focus : '',
          items: this.normalizeDailyNoteItemsForDisplay(version.items),
          status: version.status || 'active',
          metadata: version.metadata && typeof version.metadata === 'object' ? version.metadata : {},
          note_date: version.note_date || note.note_date || this.getDailyScopeDateKey(),
          updated_at: version.updated_at || '',
          operation: version.operation || 'updated',
          actor_npub: version.actor_npub || null,
        })).sort((left, right) => Number(right.version || 0) - Number(left.version || 0));
        if (this.dailyNoteVersionHistory.length > 0) this.selectDailyNoteVersion(0);
      } catch (error) {
        this.dailyNoteVersioningError = error?.status === 404
          ? 'Daily Focus version history is not available yet.'
          : `Failed to load Daily Focus versions: ${error?.message || error}`;
      } finally {
        this.dailyNoteVersioningLoading = false;
      }
    },

    closeDailyNoteVersioning() {
      this.dailyNoteVersioningOpen = false;
      this.dailyNoteVersionHistory = [];
      this.dailyNoteVersioningSelectedIndex = -1;
      this.dailyNoteVersioningPreviewHtml = '';
      this.dailyNoteVersioningError = null;
      this.dailyNoteDiffMode = false;
      this.dailyNoteDiffHunks = [];
      this.dailyNoteDiffFromIndex = -1;
      this.dailyNoteDiffToIndex = -1;
    },

    selectDailyNoteVersion(index) {
      if (index < 0 || index >= this.dailyNoteVersionHistory.length) return;
      this.dailyNoteVersioningSelectedIndex = index;
      const version = this.dailyNoteVersionHistory[index];
      this.dailyNoteVersioningPreviewHtml = renderMarkdownToHtml(this.dailyNoteVersionSource(version));
      if (this.dailyNoteDiffMode) {
        this.dailyNoteDiffToIndex = index;
        this.computeDailyNoteDiff();
      }
    },

    toggleDailyNoteDiffMode() {
      this.dailyNoteDiffMode = !this.dailyNoteDiffMode;
      if (this.dailyNoteDiffMode) {
        const toIndex = this.dailyNoteVersioningSelectedIndex >= 0 ? this.dailyNoteVersioningSelectedIndex : 0;
        const fromIndex = Math.min(toIndex + 1, this.dailyNoteVersionHistory.length - 1);
        this.dailyNoteDiffToIndex = toIndex;
        this.dailyNoteDiffFromIndex = toIndex !== fromIndex ? fromIndex : -1;
        this.computeDailyNoteDiff();
      }
    },

    setDailyNoteDiffFromIndex(index) {
      this.dailyNoteDiffFromIndex = index;
      if (this.dailyNoteDiffMode) this.computeDailyNoteDiff();
    },

    setDailyNoteDiffToIndex(index) {
      this.dailyNoteDiffToIndex = index;
      if (index >= 0 && index < this.dailyNoteVersionHistory.length) {
        this.dailyNoteVersioningSelectedIndex = index;
        this.dailyNoteVersioningPreviewHtml = renderMarkdownToHtml(this.dailyNoteVersionSource(this.dailyNoteVersionHistory[index]));
      }
      if (this.dailyNoteDiffMode) this.computeDailyNoteDiff();
    },

    computeDailyNoteDiff() {
      const toIndex = this.dailyNoteDiffToIndex >= 0 ? this.dailyNoteDiffToIndex : this.dailyNoteVersioningSelectedIndex;
      const selected = this.dailyNoteVersionHistory[toIndex];
      if (!selected) {
        this.dailyNoteDiffHunks = [];
        return;
      }
      const fromIndex = this.dailyNoteDiffFromIndex >= 0 ? this.dailyNoteDiffFromIndex : toIndex + 1;
      const older = this.dailyNoteVersionHistory[fromIndex];
      if (!older) {
        this.dailyNoteDiffHunks = [{ value: this.dailyNoteVersionSource(selected), added: true }];
        return;
      }
      this.dailyNoteDiffHunks = diffLines(this.dailyNoteVersionSource(older), this.dailyNoteVersionSource(selected));
    },

    async restoreDailyNoteVersion() {
      const version = this.dailyNoteVersionHistory[this.dailyNoteVersioningSelectedIndex];
      if (!version) return;
      this.dailyNoteEditorTitle = version.title || 'Daily note';
      this.dailyNoteEditorBody = version.body || '';
      this.dailyNoteEditorFocus = version.focus || '';
      this.dailyNoteEditorItems = this.normalizeDailyNoteEditorItems(version.items || []);
      this.dailyNoteEditorMode = 'preview';
      this.closeDailyNoteVersioning();
      await this.saveDailyNoteEditor({ close: false });
    },

    copyDailyNoteVersionSource() {
      const version = this.dailyNoteVersionHistory[this.dailyNoteVersioningSelectedIndex];
      if (!version) return;
      navigator.clipboard.writeText(this.dailyNoteVersionSource(version)).catch(() => {});
    },

    applyDailyNotes(dailyNotes = []) {
      this.dailyNotes = Array.isArray(dailyNotes) ? dailyNotes : [];
    },

    applyWapps(wapps = []) {
      this.wapps = Array.isArray(wapps) ? wapps : [];
    },

    get currentPgActorId() {
      return String(
        this.currentWorkspace?.pgMe?.actor?.actor_id
        || this.currentWorkspace?.pgMe?.actor?.id
        || this.currentWorkspace?.pg_me?.actor?.actor_id
        || this.currentWorkspace?.pg_me?.actor?.id
        || ''
      ).trim();
    },

    get currentPgActorNpub() {
      return String(
        this.currentWorkspace?.pgMe?.actor?.npub
        || this.currentWorkspace?.pg_me?.actor?.npub
        || ''
      ).trim();
    },

    get currentViewerNpub() {
      return this.currentPgActorNpub || String(this.session?.npub || '').trim();
    },

    get visiblePersonalWapps() {
      const ownerActorId = this.currentPgActorId;
      return (this.wapps || [])
        .filter((wapp) =>
          wapp?.pg_backend === true
          && wapp?.pg_record_type === 'personal_wapp'
          && (!ownerActorId || String(wapp.owner_actor_id || wapp.pg_owner_actor_id || '') === ownerActorId)
          && wapp.record_state !== 'archived'
          && wapp.record_state !== 'deleted'
          && wapp.status !== 'archived'
          && String(wapp.launch_url || '').trim()
        )
        .sort((a, b) => {
          const orderDelta = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
          if (orderDelta !== 0) return orderDelta;
          return String(a.title || '').localeCompare(String(b.title || ''));
        });
    },

    get previewPersonalWapps() {
      return this.visiblePersonalWapps.slice(0, 3);
    },

    get remainingPersonalWappCount() {
      return Math.max(0, this.visiblePersonalWapps.length - this.previewPersonalWapps.length);
    },

    getPersonalWappIconUrl(wapp) {
      const explicitIcon = String(wapp?.icon_url || '').trim();
      if (explicitIcon) return explicitIcon;
      const metadata = wapp?.metadata && typeof wapp.metadata === 'object' && !Array.isArray(wapp.metadata) ? wapp.metadata : {};
      const metadataIcon = String(metadata.manifest_icon_url || metadata.icon_url || metadata.favicon_url || '').trim();
      if (metadataIcon) return metadataIcon;
      try {
        const launchUrl = new URL(String(wapp?.launch_url || '').trim());
        return `${launchUrl.origin}/favicon.ico`;
      } catch {
        return '';
      }
    },

    handlePersonalWappIconError(event) {
      const image = event?.currentTarget;
      if (!image) return;
      image.hidden = true;
      const fallback = image.nextElementSibling;
      if (fallback) fallback.hidden = false;
    },

    handlePersonalWappIconLoad(event) {
      const image = event?.currentTarget;
      if (!image) return;
      image.hidden = false;
      const fallback = image.nextElementSibling;
      if (fallback) fallback.hidden = true;
    },

    async refreshPersonalWapps() {
      if (!isTowerPgBackendMode()) return [];
      return this.requestTowerSyncFamily?.('personal-wapps') ?? [];
    },

    openPersonalWappsOverlay() {
      if (this.visiblePersonalWapps.length === 0) {
        this.openPersonalWappEditor();
        return;
      }
      this.closePersonalAgentsOverlay();
      this.personalWappsOverlayOpen = !this.personalWappsOverlayOpen;
    },

    closePersonalWappsOverlay() {
      this.personalWappsOverlayOpen = false;
    },

    openPersonalWapp(wapp) {
      const launchUrl = String(wapp?.launch_url || '').trim();
      if (!launchUrl) return;
      window.open(launchUrl, '_blank', 'noopener,noreferrer');
      this.closePersonalWappsOverlay();
    },

    openPersonalWappEditor(wapp = null) {
      if (this.personalWappEditorSaving) return;
      this.resetPersonalWappImage();
      this.closePersonalWappsOverlay();
      this.personalWappEditorError = '';
      this.personalWappEditingId = wapp?.record_id || '';
      this.personalWappFormTitle = wapp?.title || '';
      this.personalWappFormDescription = wapp?.description || '';
      this.personalWappFormLaunchUrl = wapp?.launch_url || '';
      this.personalWappFormIconUrl = wapp?.icon_url || '';
      this.personalWappEditorOpen = true;
    },

    closePersonalWappEditor() {
      if (this.personalWappEditorSaving) return;
      this.resetPersonalWappImage();
      this.personalWappEditorOpen = false;
      this.personalWappEditorSaving = false;
      this.personalWappEditorError = '';
    },

    async savePersonalWappEditor() {
      if (this.personalWappEditorSaving || this.personalWappImageBusy) return;
      if (this.personalWappImagePending) {
        this.personalWappEditorError = 'Upload or clear the selected image before saving.';
        return;
      }
      if (!isTowerPgBackendMode()) return;
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context.workspaceId || !context.baseUrl) {
        this.personalWappEditorError = 'Configure setup first';
        return;
      }
      const title = String(this.personalWappFormTitle || '').trim();
      const launchUrl = String(this.personalWappFormLaunchUrl || '').trim();
      if (!title) {
        this.personalWappEditorError = 'Title is required';
        return;
      }
      if (!/^https?:\/\//i.test(launchUrl)) {
        this.personalWappEditorError = 'Launch URL must start with http:// or https://';
        return;
      }
      this.personalWappEditorSaving = true;
      this.personalWappEditorError = '';
      try {
        const body = {
          title,
          description: String(this.personalWappFormDescription || '').trim() || null,
          launch_url: launchUrl,
          icon_url: String(this.personalWappFormIconUrl || '').trim() || null,
        };
        const response = this.personalWappEditingId
          ? await updateTowerPgPersonalWapp(this, context.workspaceId, this.personalWappEditingId, body, {
              baseUrl: context.baseUrl,
              appNpub: context.appNpub,
            })
          : await createTowerPgPersonalWapp(this, context.workspaceId, body, {
              baseUrl: context.baseUrl,
              appNpub: context.appNpub,
            });
        const next = response?.personal_wapp;
        if (next) {
          const row = mapPgPersonalWappToLocal(next, { workspaceOwnerNpub: context.workspaceOwnerNpub });
          this.wapps = [
            ...(this.wapps || []).filter((entry) => entry.record_id !== row.record_id),
            row,
          ];
        }
        this.personalWappEditorSaving = false;
        this.closePersonalWappEditor();
      } catch (error) {
        this.personalWappEditorError = error?.message || 'Failed to save WApp';
        this.error = this.personalWappEditorError;
      } finally {
        this.personalWappEditorSaving = false;
      }
    },

    async archivePersonalWapp(wapp) {
      const recordId = String(wapp?.record_id || '').trim();
      if (!recordId || !isTowerPgBackendMode()) return;
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context.workspaceId || !context.baseUrl) return;
      try {
        await deleteTowerPgPersonalWapp(this, context.workspaceId, recordId, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
        });
        this.wapps = (this.wapps || []).filter((entry) => entry.record_id !== recordId);
      } catch (error) {
        this.error = error?.message || 'Failed to archive WApp';
      }
    },

    async movePersonalWapp(wapp, direction) {
      const rows = this.visiblePersonalWapps;
      const index = rows.findIndex((entry) => entry.record_id === wapp?.record_id);
      const offset = direction === 'up' ? -1 : 1;
      const swapIndex = index + offset;
      if (index < 0 || swapIndex < 0 || swapIndex >= rows.length) return;
      const reordered = [...rows];
      [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
      await this.savePersonalWappOrder(reordered.map((entry) => entry.record_id));
    },

    async savePersonalWappOrder(orderedIds = []) {
      if (!isTowerPgBackendMode() || orderedIds.length === 0) return;
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context.workspaceId || !context.baseUrl) return;
      try {
        const response = await reorderTowerPgPersonalWapps(this, context.workspaceId, { ordered_ids: orderedIds }, {
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
        });
        const rows = (Array.isArray(response?.personal_wapps) ? response.personal_wapps : [])
          .map((wapp) => mapPgPersonalWappToLocal(wapp, { workspaceOwnerNpub: context.workspaceOwnerNpub }))
          .filter((wapp) => wapp.record_id);
        const ownerActorId = this.currentPgActorId;
        this.wapps = [
          ...(this.wapps || []).filter((entry) => !(
            entry?.pg_backend === true
            && entry?.pg_record_type === 'personal_wapp'
            && (!ownerActorId || String(entry.owner_actor_id || entry.pg_owner_actor_id || '') === ownerActorId)
          )),
          ...rows,
        ];
      } catch (error) {
        this.error = error?.message || 'Failed to reorder WApps';
      }
    },

    async refreshDailyNotes() {
      if (!isTowerPgBackendMode()) return [];
      const [result] = await Promise.all([
        this.requestTowerSyncFamily?.('daily-notes', '', { limit: 60 }),
        this.refreshPersonalWapps(),
      ]);
      await this.refreshDailyScopeAgentAccess();
      return result;
    },

    async refreshDailyScopeAgentAccess() {
      if (!isTowerPgBackendMode()) return [];
      const context = resolveTowerPgWorkspaceContext(this);
      if (!context.workspaceId || !context.baseUrl) return [];
      const response = await getTowerPgDailyScopeAgentAccess(context.workspaceId, {
        baseUrl: context.baseUrl,
        appNpub: context.appNpub,
      });
      this.dailyScopeAgentAccess = Array.isArray(response.access) ? response.access : [];
      return this.dailyScopeAgentAccess;
    },

    isHarnessAgentDailyScopeAccessEnabled(agentNpub) {
      const normalizedAgentNpub = String(agentNpub || '').trim();
      return Boolean(normalizedAgentNpub && (this.dailyScopeAgentAccess || []).some((row) =>
        (row.agent_actor_npub === normalizedAgentNpub || row.agent_npub === normalizedAgentNpub || row.agent_actor_id === this.getPgWorkspaceMemberActorId?.(normalizedAgentNpub)) && row.revoked_at == null && row.can_read !== false && row.can_write !== false
      ));
    },

    get harnessAgentDailyScopeAccessEnabled() {
      return this.isHarnessAgentDailyScopeAccessEnabled(this.workspaceHarnessAgentNpub);
    },

    async getHarnessAgentDailyScopeActorId(agentNpub) {
      const npub = String(agentNpub || '').trim();
      if (!npub) return '';
      let actorId = this.getPgWorkspaceMemberActorId?.(npub) || '';
      if (!actorId) {
        await this.refreshTowerPgWorkspaceMembers?.({ force: true, limit: 200 }).catch(() => []);
        actorId = this.getPgWorkspaceMemberActorId?.(npub) || '';
      }
      return String(actorId || '').trim();
    },

    async toggleHarnessAgentDailyScopeAccess(targetAgentNpub = this.workspaceHarnessAgentNpub) {
      const agentNpub = String(targetAgentNpub || '').trim();
      if (!agentNpub || !isTowerPgBackendMode()) return;
      this.dailyScopeAgentAccessSaving = true;
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId || !context.baseUrl) throw new Error('Flight Deck PG workspace is not connected.');
        const agentActorId = await this.getHarnessAgentDailyScopeActorId(agentNpub);
        await upsertTowerPgDailyScopeAgentAccess(this, context.workspaceId, {
          ...(agentActorId ? { agent_actor_id: agentActorId } : {}),
          agent_npub: agentNpub,
          can_read: !this.isHarnessAgentDailyScopeAccessEnabled(agentNpub),
          can_write: !this.isHarnessAgentDailyScopeAccessEnabled(agentNpub),
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        await this.refreshDailyScopeAgentAccess();
      } catch (error) {
        this.error = error?.message || 'Failed to update Daily Scope agent access';
      } finally {
        this.dailyScopeAgentAccessSaving = false;
      }
    },

    async openDailyNoteEditor() {
      if (!isTowerPgBackendMode()) {
        this.error = 'Daily notes are only available on the Flight Deck PG backend.';
        return;
      }
      this.dailyNoteEditorError = '';
      let note = this.getCurrentDailyNote();
      if (!note) note = await this.createDailyNoteForCurrentScope();
      if (!note) return;
      this.dailyNoteEditorRecordId = note.record_id;
      this.dailyNoteEditorTitle = note.title || 'Daily note';
      this.dailyNoteEditorBody = note.body || '';
      this.dailyNoteEditorFocus = note.focus || '';
      this.dailyNoteEditorItems = this.normalizeDailyNoteEditorItems(note.items);
      this.dailyNoteEditorMode = 'edit';
      this.destroyDailyNoteRichEditor();
      this.dailyNoteEditorOpen = true;
    },

    closeDailyNoteEditor() {
      this.destroyDailyNoteRichEditor();
      this.dailyNoteEditorOpen = false;
      this.dailyNoteEditorSaving = false;
      this.dailyNoteEditorError = '';
    },

    async setDailyNoteEditorMode(mode) {
      const nextMode = mode === 'edit' ? 'edit' : 'preview';
      if (nextMode === 'preview' && this.dailyNoteEditorMode === 'edit') {
        const saved = await this.saveDailyNoteEditor({ close: false });
        if (!saved) return;
      }
      if (nextMode !== 'edit') this.destroyDailyNoteRichEditor();
      this.dailyNoteEditorMode = nextMode;
    },

    destroyDailyNoteRichEditor() {
      if (!this.dailyNoteRichEditorAdapter) return;
      this.dailyNoteRichEditorToolbar?.destroy?.();
      this.dailyNoteRichEditorAdapter.destroy();
      this.dailyNoteRichEditorAdapter = null;
      this.dailyNoteRichEditorToolbar = null;
      this.dailyNoteRichEditorMountEl = null;
    },

    async mountDailyNoteRichEditor(element = null) {
      if (!element || this.dailyNoteEditorMode !== 'edit') return;
      if (this.dailyNoteRichEditorAdapter && this.dailyNoteRichEditorMountEl === element) return;
      this.destroyDailyNoteRichEditor();
      const editorMount = document.createElement('div');
      editorMount.className = 'daily-note-rich-editor-surface doc-rich-editor';
      element.replaceChildren(editorMount);
      this.dailyNoteRichEditorMountEl = element;
      const { createTiptapEditorAdapter } = await loadTiptapEditorAdapter();
      if (this.dailyNoteRichEditorMountEl !== element || this.dailyNoteEditorMode !== 'edit') return;
      this.dailyNoteRichEditorAdapter = createTiptapEditorAdapter({
        element: editorMount,
        document: { content: this.dailyNoteEditorBody || '' },
        editable: true,
        placeholder: 'Write the plan, progress, blockers, or anything the AI should track today.',
        onUpdate: (contentModel) => {
          this.dailyNoteEditorBody = contentModel?.content || '';
        },
      });
      this.dailyNoteRichEditorToolbar = createDailyNoteTiptapToolbar(this.dailyNoteRichEditorAdapter.editor);
      element.prepend(this.dailyNoteRichEditorToolbar.element);
    },

    normalizeDailyNoteEditorItems(items = []) {
      return (Array.isArray(items) ? items : [])
        .slice(0, 5)
        .map((item, index) => ({
          id: String(item?.id || `item-${Date.now()}-${index}`),
          text: String(item?.text || item?.label || '').trim(),
          completed: Boolean(item?.completed),
          source: item?.source || 'manual',
          created_at: item?.created_at || new Date().toISOString(),
          updated_at: item?.updated_at || new Date().toISOString(),
        }))
        .filter((item) => item.text);
    },

    addDailyNoteEditorItem() {
      if (this.dailyNoteEditorItems.length >= 5) return;
      this.dailyNoteEditorItems = [
        ...this.dailyNoteEditorItems,
        {
          id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: '',
          completed: false,
          source: 'manual',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
    },

    removeDailyNoteEditorItem(itemId) {
      this.dailyNoteEditorItems = this.dailyNoteEditorItems.filter((item) => item.id !== itemId);
    },

    toggleDailyNoteEditorItem(itemId) {
      const now = new Date().toISOString();
      this.dailyNoteEditorItems = this.dailyNoteEditorItems.map((item) => (
        item.id === itemId ? { ...item, completed: !item.completed, updated_at: now } : item
      ));
    },

    dailyNoteEditorItemsForSave() {
      const now = new Date().toISOString();
      return this.dailyNoteEditorItems
        .slice(0, 5)
        .map((item, index) => ({
          ...item,
          id: item.id || `item-${index + 1}`,
          text: String(item.text || '').trim(),
          completed: Boolean(item.completed),
          source: item.source || 'manual',
          created_at: item.created_at || now,
          updated_at: now,
        }))
        .filter((item) => item.text);
    },

    normalizeDailyNoteItemsForDisplay(items = []) {
      return (Array.isArray(items) ? items : [])
        .slice(0, 5)
        .map((item, index) => ({
          id: String(item?.id || `item-${index + 1}`),
          text: String(item?.text || item?.label || '').trim(),
          completed: Boolean(item?.completed),
          source: item?.source || 'manual',
          created_at: item?.created_at || new Date().toISOString(),
          updated_at: item?.updated_at || new Date().toISOString(),
        }))
        .filter((item) => item.text);
    },

    async createDailyNoteForCurrentScope() {
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId || !context.baseUrl) throw new Error('Flight Deck PG workspace is not connected.');
        const response = await upsertTowerPgDailyNote(this, context.workspaceId, {
          note_date: this.getDailyScopeDateKey(),
          scope_id: null,
          channel_id: null,
          title: 'Daily note',
          body: '',
          focus: '',
          items: [],
          status: 'active',
          metadata: this.getDailyScopePersonalMetadata(),
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        const note = mapPgDailyNoteToLocal(response.daily_note, { workspaceOwnerNpub: context.workspaceOwnerNpub });
        await upsertDailyNote(note);
        this.dailyNotes = [...(this.dailyNotes || []).filter((item) => item.record_id !== note.record_id), note];
        return note;
      } catch (error) {
        this.dailyNoteEditorError = error?.message || 'Failed to create daily note';
        this.error = this.dailyNoteEditorError;
        return null;
      }
    },

    async saveDailyNoteEditor(options = {}) {
      const { close = true } = options || {};
      const note = (this.dailyNotes || []).find((item) => item.record_id === this.dailyNoteEditorRecordId) || this.getCurrentDailyNote();
      if (this.dailyNoteEditorSaving) return null;
      if (!isTowerPgBackendMode()) {
        this.dailyNoteEditorError = 'Daily notes can only be saved while the Flight Deck PG backend is connected.';
        return null;
      }
      if (!note) {
        this.dailyNoteEditorError = 'This daily note is no longer available. Close the editor, reopen it, and try again.';
        return null;
      }
      this.dailyNoteEditorSaving = true;
      this.dailyNoteEditorError = '';
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId || !context.baseUrl) throw new Error('Flight Deck PG workspace is not connected.');
        const response = await upsertTowerPgDailyNote(this, context.workspaceId, {
          note_date: note.note_date || this.getDailyScopeDateKey(),
          scope_id: null,
          channel_id: null,
          owner_actor_id: note.owner_actor_id || note.pg_owner_actor_id || undefined,
          title: this.dailyNoteEditorTitle.trim() || 'Daily note',
          body: this.dailyNoteEditorBody,
          focus: this.dailyNoteEditorFocus || this.dailyNoteEditorItemsForSave().map((item) => item.text).slice(0, 3).join(', '),
          items: this.dailyNoteEditorItemsForSave(),
          status: note.status || 'active',
          metadata: this.getDailyScopePersonalMetadata(note.metadata || {}),
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        const saved = mapPgDailyNoteToLocal(response.daily_note, { workspaceOwnerNpub: context.workspaceOwnerNpub });
        await upsertDailyNote(saved);
        this.dailyNotes = [...(this.dailyNotes || []).filter((item) => item.record_id !== saved.record_id), saved];
        this.dailyNoteEditorRecordId = saved.record_id;
        if (close) {
          this.destroyDailyNoteRichEditor();
          this.dailyNoteEditorOpen = false;
        }
        return saved;
      } catch (error) {
        this.dailyNoteEditorError = `Could not save the daily note: ${error?.message || 'the request failed. Please try again.'}`;
        return null;
      } finally {
        this.dailyNoteEditorSaving = false;
      }
    },

    async toggleDailyNoteOverviewItem(itemId) {
      const note = this.getCurrentDailyNote();
      if (!note || !itemId || !isTowerPgBackendMode()) return;
      const items = this.normalizeDailyNoteItemsForDisplay(note.items);
      if (!items.some((item) => item.id === itemId)) return;
      const now = new Date().toISOString();
      const nextItems = items.map((item) => (
        item.id === itemId ? { ...item, completed: !item.completed, updated_at: now } : item
      ));
      const previousNotes = this.dailyNotes || [];
      const optimisticNote = { ...note, items: nextItems, updated_at: now };
      this.dailyNotes = previousNotes.map((item) => (
        item.record_id === note.record_id ? optimisticNote : item
      ));
      try {
        const context = resolveTowerPgWorkspaceContext(this);
        if (!context.workspaceId || !context.baseUrl) throw new Error('Flight Deck PG workspace is not connected.');
        const response = await upsertTowerPgDailyNote(this, context.workspaceId, {
          note_date: note.note_date || this.getDailyScopeDateKey(),
          scope_id: null,
          channel_id: null,
          owner_actor_id: note.owner_actor_id || note.pg_owner_actor_id || undefined,
          title: note.title || 'Daily note',
          body: note.body || '',
          focus: note.focus || nextItems.map((item) => item.text).slice(0, 3).join(', '),
          items: nextItems,
          status: note.status || 'active',
          metadata: this.getDailyScopePersonalMetadata(note.metadata || {}),
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        const saved = mapPgDailyNoteToLocal(response.daily_note, { workspaceOwnerNpub: context.workspaceOwnerNpub });
        await upsertDailyNote(saved);
        this.dailyNotes = [...(this.dailyNotes || []).filter((item) => item.record_id !== saved.record_id), saved];
      } catch (error) {
        this.dailyNotes = previousNotes;
        this.error = error?.message || 'Failed to update Daily Scope task';
      }
    },

    getInvocationTargetRecord(type = '', record = null) {
      const normalizedType = String(type || '').trim() || 'document';
      if (record) return record;
      if (normalizedType === 'task') return this.activeTaskDetail || this.editingTask || null;
      if (normalizedType === 'document') return this.selectedDocument || null;
      return null;
    },

    getInvocationTargetContext(type = '', record = null) {
      const targetType = String(type || '').trim() || 'document';
      const targetRecord = this.getInvocationTargetRecord(targetType, record);
      const pgContext = resolveTowerPgWorkspaceContext(this);
      const workspaceId = String(targetRecord?.pg_workspace_id || pgContext.workspaceId || '').trim();
      const baseUrl = String(pgContext.baseUrl || '').trim();
      const appNpub = String(pgContext.appNpub || '').trim();
      const targetId = String(targetRecord?.record_id || targetRecord?.id || '').trim();
      const scopeId = String(
        targetRecord?.scope_id
        || targetRecord?.pg_scope_id
        || targetRecord?.scope_l5_id
        || targetRecord?.scope_l4_id
        || targetRecord?.scope_l3_id
        || targetRecord?.scope_l2_id
        || targetRecord?.scope_l1_id
        || ''
      ).trim();
      const channelId = String(targetRecord?.pg_channel_id || targetRecord?.channel_id || '').trim();
      const title = String(targetRecord?.title || targetRecord?.filename || '').trim()
        || (targetType === 'task' ? 'Untitled task' : 'Untitled document');

      return {
        workspaceId,
        baseUrl,
        appNpub,
        targetType,
        targetId,
        scopeId,
        channelId,
        title,
        record: targetRecord,
      };
    },

    getInvocationDefaultPrompt(type = '') {
      if (String(type || '').trim() === 'task') {
        return 'Please review this task, its description, links, comments, and current state. Suggest improvements or next steps directly in the task thread.';
      }
      return 'Please review this document and its comments. Suggest improvements, identify gaps, and add comments or proposed changes where useful.';
    },

    getInvocationTargetTypeLabel(type = '') {
      const value = String(type || '').trim();
      if (value === 'task') return 'Task';
      if (value === 'file') return 'File';
      return 'Document';
    },

    getInvocationRecipientLabel(npub = '') {
      const clean = String(npub || '').trim();
      if (!clean) return 'Unknown recipient';
      const agent = (this.visiblePersonalAgents || []).find((item) => item.npub === clean);
      return agent?.title || this.getSenderName(clean) || clean.slice(0, 12);
    },

    openInvocationModal(type = 'document', record = null) {
      const context = this.getInvocationTargetContext(type, record);
      this.invocationError = '';
      this.invocationSuccess = '';
      if (!isTowerPgBackendMode() || !context.workspaceId || !context.baseUrl) {
        this.invocationError = 'Flight Deck PG workspace is not connected.';
        this.showInvocationModal = true;
        return;
      }
      if (!context.targetId || !context.scopeId || !context.channelId) {
        this.invocationError = 'This item is missing PG scope or channel metadata.';
        this.showInvocationModal = true;
        return;
      }
      this.invocationTargetType = context.targetType;
      this.invocationTargetId = context.targetId;
      this.invocationTargetTitle = context.title;
      this.invocationScopeId = context.scopeId;
      this.invocationChannelId = context.channelId;
      this.invocationPrompt = this.getInvocationDefaultPrompt(context.targetType);
      this.invocationRecipientNpub = context.targetType === 'document'
        ? String(this.defaultAgentNpub || '').trim()
        : (this.invocationRecipientNpub || this.invocablePersonalAgents[0]?.npub || '');
      this.invocationClientRequestId = context.targetType === 'document' ? crypto.randomUUID() : '';
      this.invocationSubmitting = false;
      this.showInvocationModal = true;
    },

    closeInvocationModal() {
      if (this.invocationSubmitting) return;
      this.showInvocationModal = false;
      this.invocationError = '';
      this.invocationSuccess = '';
    },

    async submitInvocation() {
      if (this.invocationSubmitting) return;
      const context = this.getInvocationTargetContext(this.invocationTargetType);
      const recipientNpub = String(this.invocationRecipientNpub || '').trim();
      const prompt = String(this.invocationPrompt || '').trim();
      this.invocationError = '';
      this.invocationSuccess = '';
      if (!context.workspaceId || !context.baseUrl) {
        this.invocationError = 'Flight Deck PG workspace is not connected.';
        return;
      }
      if (!context.targetId || !context.scopeId || !context.channelId) {
        this.invocationError = 'This item is missing PG scope or channel metadata.';
        return;
      }
      if (!recipientNpub) {
        this.invocationError = context.targetType === 'document'
          ? 'Set a default agent in Setup before requesting a document review.'
          : 'Select an agent.';
        return;
      }
      if (!prompt) {
        this.invocationError = 'Add a prompt for the invocation.';
        return;
      }
      this.invocationSubmitting = true;
      try {
        const response = await createTowerPgInvocation(this, context.workspaceId, {
          ...(context.targetType === 'document' ? {
            trigger: 'full_document_review_requested',
            client_request_id: this.invocationClientRequestId || crypto.randomUUID(),
          } : {}),
          scope_id: context.scopeId,
          channel_id: context.channelId,
          prompt,
          recipients: [{ type: 'agent', npub: recipientNpub }],
          targets: [{ type: context.targetType, id: context.targetId }],
          metadata: {
            source_surface: context.targetType === 'task' ? 'task_actions_invoke' : 'document_header_review',
            target_title: context.title,
            ...(context.targetType === 'document' ? { trigger: 'full_document_review_requested' } : {}),
          },
        }, { baseUrl: context.baseUrl, appNpub: context.appNpub });
        this.invocationSuccess = `Sent to ${this.getInvocationRecipientLabel(recipientNpub)}.`;
        const saved = response?.invocation;
        if (saved && this.showInvocationHistoryModal && this.invocationHistoryTargetId === context.targetId) {
          this.invocationHistoryRows = [saved, ...(this.invocationHistoryRows || []).filter((row) => row.invocation_id !== saved.invocation_id)];
        }
        this.showInvocationModal = false;
      } catch (error) {
        this.invocationError = error?.message || 'Failed to create invocation.';
      } finally {
        this.invocationSubmitting = false;
      }
    },

    async openInvocationHistoryModal(type = 'document', record = null) {
      const context = this.getInvocationTargetContext(type, record);
      this.invocationHistoryTargetType = context.targetType;
      this.invocationHistoryTargetId = context.targetId;
      this.invocationHistoryTargetTitle = context.title;
      this.invocationHistoryRows = [];
      this.invocationHistoryError = '';
      this.invocationHistoryLoading = true;
      this.showInvocationHistoryModal = true;
      try {
        if (!context.workspaceId || !context.baseUrl || !context.targetId) {
          throw new Error('Flight Deck PG workspace is not connected.');
        }
        const response = await getTowerPgInvocations(context.workspaceId, {
          role: 'visible',
          targetType: context.targetType,
          targetId: context.targetId,
          limit: 50,
          baseUrl: context.baseUrl,
          appNpub: context.appNpub,
        });
        this.invocationHistoryRows = Array.isArray(response?.invocations) ? response.invocations : [];
      } catch (error) {
        this.invocationHistoryError = error?.message || 'Failed to load invocations.';
      } finally {
        this.invocationHistoryLoading = false;
      }
    },

    closeInvocationHistoryModal() {
      this.showInvocationHistoryModal = false;
      this.invocationHistoryError = '';
      this.invocationHistoryLoading = false;
    },

    async openDocumentSessionsModal() {
      const context = this.getInvocationTargetContext('document');
      const towerService = String(
        this.currentWorkspace?.towerServiceNpub
        || this.currentWorkspace?.serviceNpub
        || this.currentWorkspace?.tower_service_npub
        || this.currentWorkspace?.service_npub
        || '',
      ).trim();
      this.showDocumentSessionsModal = true;
      this.documentSessionRows = [];
      this.documentSessionsError = '';
      this.documentSessionsLoading = true;
      try {
        this.documentSessionRows = await fetchDocumentAgentSessions({
          autopilotUrl: this.workspaceHarnessUrl,
          towerService,
          workspaceId: context.workspaceId,
          documentId: context.targetId,
        });
      } catch (error) {
        this.documentSessionsError = error?.message || 'Failed to load associated Autopilot sessions.';
      } finally {
        this.documentSessionsLoading = false;
      }
    },

    closeDocumentSessionsModal() {
      this.showDocumentSessionsModal = false;
      this.documentSessionsError = '';
    },

    openDocumentAgentSession(row) {
      const target = String(row?.openUrl || '').trim();
      if (!target || typeof window === 'undefined') return;
      window.open(target, '_blank', 'noopener,noreferrer');
    },

    applySelectedDocument(document = null) {
      applySelectedDocumentUpdate(this, document);
    },

    async applyReports(reports = []) {
      const nextReports = Array.isArray(reports) ? reports : [];
      if (!sameListBySignature(this.reports, nextReports, (report) => [
        String(report?.record_id || ''),
        String(report?.updated_at || ''),
        String(report?.version ?? ''),
        String(report?.record_state || ''),
        String(report?.declaration_type || ''),
      ].join('|'))) {
        this.reports = nextReports;
      }
      if (this.selectedReportId && !this.reports.some((report) => report?.record_id === this.selectedReportId)) {
        this.selectedReportId = null;
      }
    },

    async applySelectedReport(report = null) {
      const recordId = String(this.selectedReportId || '').trim();
      if (!recordId) return;
      const nextReports = this.reports.filter((item) => item?.record_id !== recordId);
      if (report && report.record_state !== 'deleted') {
        nextReports.push(report);
      }
      await this.applyReports(nextReports);
    },

    async refreshReports() {
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return;
      await this.applyReports(await getReportsByOwner(ownerNpub));
    },

    patchDirectoryLocal(nextDirectory) {
      const normalizedDirectory = this.normalizeDirectoryRowGroupRefs
        ? this.normalizeDirectoryRowGroupRefs(nextDirectory)
        : nextDirectory;
      const index = this.directories.findIndex((item) => item.record_id === nextDirectory.record_id);
      if (index >= 0) {
        this.directories.splice(index, 1, { ...this.directories[index], ...normalizedDirectory });
      } else {
        this.directories = [...this.directories, normalizedDirectory];
      }
    },

    patchDocumentLocal(nextDocument) {
      const normalizedDocument = this.normalizeDocumentRowGroupRefs
        ? this.normalizeDocumentRowGroupRefs(nextDocument)
        : nextDocument;
      const index = this.documents.findIndex((item) => item.record_id === nextDocument.record_id);
      const currentDocument = index >= 0 ? this.documents[index] : null;
      const reconciledDocument = preserveHydratedDocumentContent(
        currentDocument,
        currentDocument ? { ...currentDocument, ...normalizedDocument } : normalizedDocument,
      );
      this.patchMentionDocumentIndex(reconciledDocument);
      if (index >= 0) {
        this.documents = this.documents.map((document, itemIndex) => (
          itemIndex === index ? reconciledDocument : document
        ));
      } else {
        this.documents = [...this.documents, reconciledDocument];
      }
      this.docRichEditorAdapter?.refreshWikiLinks?.();
      this.refreshOpenDocFromLatestDocument({ force: false });
    },

    canRefreshOpenDocFromLatestDocument() {
      if (!this.docsEditorOpen || this.selectedDocType !== 'document' || !this.selectedDocId) return false;
      if (this.docEditDraftDirty) return false;
      if (this.docEditingTitle || this.docEditingBlockIndex >= 0) return false;
      if (this.docAutosaveState === 'pending' || this.docAutosaveState === 'saving') return false;
      return true;
    },

    refreshOpenDocFromLatestDocument(options = {}) {
      const force = options.force === true;
      if (!force) {
        if (!this.canRefreshOpenDocFromLatestDocument()) {
          if (this.docEditDraftDirty) this.observeSelectedDocAuthoritativeVersion?.();
          return false;
        }
        return this.observeSelectedDocAuthoritativeVersion?.() === true;
      }
      const item = this.selectedDocument;
      if (!item) {
        return false;
      }
      return this.applySelectedDocAuthoritativeContent(item, { preserveSelection: true });
    },

    getStatusRangeMs() {
      switch (this.statusTimeRange) {
        case '2h':
          return 2 * 60 * 60 * 1000;
        case '4h':
          return 4 * 60 * 60 * 1000;
        case '24h':
          return 24 * 60 * 60 * 1000;
        case '1h':
        default:
          return 60 * 60 * 1000;
      }
    },

    getFlightDeckReportTypeLabel(report) {
      switch (String(report?.declaration_type || '').trim().toLowerCase()) {
        case 'metric':
          return 'Metric';
        case 'timeseries':
          return 'Timeseries';
        case 'table':
          return 'Table';
        case 'text':
          return 'Text';
        default:
          return 'Report';
      }
    },

    getFlightDeckReportCardClass(report) {
      const type = String(report?.declaration_type || '').trim().toLowerCase();
      return {
        'flightdeck-report-card-metric': type === 'metric',
        'flightdeck-report-card-timeseries': type === 'timeseries',
        'flightdeck-report-card-table': type === 'table',
        'flightdeck-report-card-text': type === 'text',
        'flightdeck-report-card-wide': type === 'timeseries' || type === 'table',
        'flightdeck-report-card-unsupported': !['metric', 'timeseries', 'table', 'text'].includes(type),
      };
    },

    getReportScopeLabel(report) {
      if (!report) return '';
      if (isTaskUnscoped(report, this.scopesMap)) return 'Unscoped';
      const scopeRef = report.scope_id
        ?? report.scope_l5_id
        ?? report.scope_l4_id
        ?? report.scope_l3_id
        ?? report.scope_l2_id
        ?? report.scope_l1_id
        ?? null;
      if (!scopeRef) return '';
      return this.getTaskBoardLabel(scopeRef);
    },

    getReportMetricPayload(report) {
      if (report?.declaration_type !== 'metric') return null;
      const payload = report.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return payload;
    },

    getReportMetricLabel(report) {
      return this.getReportMetricPayload(report)?.label || 'Metric';
    },

    formatReportMetricValue(report) {
      const value = this.getReportMetricPayload(report)?.value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return NUMBER_FORMATTER.format(value);
      }
      return String(value ?? '—');
    },

    getReportMetricUnit(report) {
      return String(this.getReportMetricPayload(report)?.unit || '').trim();
    },

    getReportMetricTrend(report) {
      const trend = this.getReportMetricPayload(report)?.trend;
      if (!trend || typeof trend !== 'object' || Array.isArray(trend)) return null;
      return {
        direction: ['up', 'down', 'flat'].includes(trend.direction) ? trend.direction : 'flat',
        value: trend.value,
        label: String(trend.label || '').trim(),
      };
    },

    formatReportMetricTrend(report) {
      const trend = this.getReportMetricTrend(report);
      if (!trend) return '';
      if (typeof trend.value === 'number' && Number.isFinite(trend.value)) {
        const prefix = trend.value > 0 ? '+' : '';
        return `${prefix}${NUMBER_FORMATTER.format(trend.value)}`;
      }
      return String(trend.value ?? '');
    },

    getReportTextBody(report) {
      if (report?.declaration_type !== 'text') return '';
      return String(report?.payload?.body || '').trim();
    },

    getReportTimeseriesSeries(report) {
      if (report?.declaration_type !== 'timeseries') return [];
      const cache = getReportDerivedCache(reportTimeseriesCache, this);
      const cacheKey = `${String(report?.record_id || '')}:${String(report?.version ?? '')}:${String(report?.updated_at || '')}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const series = Array.isArray(report?.payload?.series) ? report.payload.series : [];
      const computed = series
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry, index) => {
          const points = Array.isArray(entry.points) ? entry.points : [];
          const numericValues = points
            .map((point) => (typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : null))
            .filter((value) => value != null);
          const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 0;
          const bars = points.map((point, pointIndex) => {
            const rawValue = typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : null;
            const label = String(point?.x ?? pointIndex + 1);
            const heightPct = rawValue == null || maxValue <= 0
              ? 8
              : Math.max(8, Math.round((rawValue / maxValue) * 100));
            return {
              key: `${entry.key || index}:${pointIndex}:${label}`,
              label,
              value: rawValue,
              heightPct,
              tooltip: rawValue == null ? `${label}: no value` : `${label}: ${NUMBER_FORMATTER.format(rawValue)}`,
            };
          });
          return {
            key: String(entry.key || `series-${index}`),
            label: String(entry.label || `Series ${index + 1}`),
            bars,
            firstLabel: bars[0]?.label || '',
            lastLabel: bars[bars.length - 1]?.label || '',
          };
        });
      cache.set(cacheKey, computed);
      if (cache.size > 100) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      return computed;
    },

    getReportTableColumns(report) {
      if (report?.declaration_type !== 'table') return [];
      const cache = getReportDerivedCache(reportTableColumnsCache, this);
      const cacheKey = `${String(report?.record_id || '')}:${String(report?.version ?? '')}:${String(report?.updated_at || '')}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const columns = Array.isArray(report?.payload?.columns) ? report.payload.columns : [];
      const computed = columns
        .filter((column) => column && typeof column === 'object' && !Array.isArray(column))
        .map((column) => ({
          key: String(column.key || ''),
          label: String(column.label || column.key || ''),
          align: ['left', 'center', 'right'].includes(column.align) ? column.align : 'left',
        }))
        .filter((column) => column.key);
      cache.set(cacheKey, computed);
      if (cache.size > 100) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      return computed;
    },

    getReportTableRows(report) {
      if (report?.declaration_type !== 'table') return [];
      return Array.isArray(report?.payload?.rows) ? report.payload.rows : [];
    },

    formatReportTableCell(value) {
      if (value == null) return '';
      if (typeof value === 'number' && Number.isFinite(value)) {
        return NUMBER_FORMATTER.format(value);
      }
      if (typeof value === 'boolean') {
        return value ? 'Yes' : 'No';
      }
      return String(value);
    },

    formatReportAbsoluteTime(iso) {
      const ts = Date.parse(iso || '');
      if (!Number.isFinite(ts)) return '';
      return new Date(ts).toLocaleString();
    },

    getReportRecentChangeSubtitle(report) {
      const scopeLabel = this.getReportScopeLabel(report);
      const typeLabel = this.getFlightDeckReportTypeLabel(report).toLowerCase();
      return scopeLabel ? `${typeLabel} on ${scopeLabel}` : `${typeLabel} on Flight Deck`;
    },

    selectReport(recordId, options = {}) {
      if (!recordId) return;
      const report = this.scopedReports.find((item) => item.record_id === recordId)
        || this.reports.find((item) => item.record_id === recordId);
      if (!report) return;
      this.selectedReportId = report.record_id;
      if (options.openModal === true) {
        this.openReportModal(report);
        return;
      }
      if (options.syncRoute !== false && this.navSection === 'reports') this.syncRoute();
    },

    openReportModal(report) {
      if (!report) return;
      this.selectedReportId = report.record_id;
      this.reportModalReport = report;
    },

    openReportModalById(recordId) {
      if (!recordId) return;
      const report = this.reports.find((r) => r.record_id === recordId);
      if (report) this.openReportModal(report);
    },

    closeReportModal() {
      this.reportModalReport = null;
    },

    async refreshStatusRecentChanges(options = {}) {
      // Skip if not on status section (unless forced)
      if (this.navSection !== 'status' && !options.force) return;
      if (!isWorkspaceDbOpenForKey(this.currentWorkspaceKey)) return;
      // Skip if we already have cached data and no new records were pulled
      if (this.statusRecentChanges.length > 0 && !options.force && !options.hasNewData) return;
      const sinceIso = new Date(Date.now() - this.getStatusRangeMs()).toISOString();
      const [messages, documents, directories, reports, tasks, schedules, comments, scopes, flows] = await Promise.all([
        getRecentChatMessagesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentDocumentChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentDirectoryChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentReportChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentTaskChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentScheduleChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentCommentsSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentScopeChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
        getRecentFlowChangesSince(sinceIso, { limit: MAX_STATUS_RECENT_CHANGES }),
      ]);
      const items = [];

      // Batch-load channels for messages instead of one query per message
      const messageChannelIds = [...new Set(messages.map((m) => m.channel_id).filter(Boolean))];
      const channelMap = new Map();
      await Promise.all(messageChannelIds.map(async (channelId) => {
        const ch = await getChannelById(channelId);
        if (ch) channelMap.set(channelId, ch);
      }));

      for (const message of messages) {
        const channel = channelMap.get(message.channel_id);
        if (!channel || channel.record_state === 'deleted') continue;

        this.resolveChatProfile(message.sender_npub);

        items.push({
          id: message.record_id,
          section: 'chat',
          recordType: message.parent_message_id ? 'Thread' : 'Chat',
          recordTypeKey: 'chat',
          title: message.body?.trim() || '(empty message)',
          subtitle: `${this.getSenderName(message.sender_npub)} in ${this.getChannelLabel(channel)}`,
          updatedAt: message.updated_at,
          updatedTs: Date.parse(message.updated_at) || 0,
          channelId: message.channel_id,
          threadId: message.pg_thread_id || message.parent_message_id || null,
          boardScopeId: channel.scope_id ?? channel.scope_l5_id ?? channel.scope_l4_id ?? channel.scope_l3_id ?? channel.scope_l2_id ?? channel.scope_l1_id ?? null,
          recordId: message.record_id,
          focusRecordId: message.record_id,
          senderNpub: message.sender_npub,
        });
      }

      for (const directory of directories) {
        items.push({
          id: `directory:${directory.record_id}`,
          section: 'docs',
          recordType: 'Folder',
          recordTypeKey: 'folder',
          title: directory.title?.trim() || 'Untitled folder',
          subtitle: directory.parent_directory_id
            ? `Updated in ${this.getDocItemLocationLabel(directory)}`
            : 'Updated in Root',
          updatedAt: directory.updated_at,
          updatedTs: Date.parse(directory.updated_at) || 0,
          recordId: directory.record_id,
          docType: 'directory',
          boardScopeId: directory.scope_id ?? directory.scope_l5_id ?? directory.scope_l4_id ?? directory.scope_l3_id ?? directory.scope_l2_id ?? directory.scope_l1_id ?? null,
          channelId: directory.pg_channel_id || null,
          threadId: directory.pg_thread_id || null,
        });
      }

      for (const document of documents) {
        items.push({
          id: `document:${document.record_id}`,
          section: 'docs',
          recordType: 'Doc',
          recordTypeKey: 'doc',
          title: document.title?.trim() || 'Untitled document',
          subtitle: document.parent_directory_id
            ? `Updated in ${this.getDocItemLocationLabel(document)}`
            : 'Updated in Root',
          updatedAt: document.updated_at,
          updatedTs: Date.parse(document.updated_at) || 0,
          recordId: document.record_id,
          docType: 'document',
          boardScopeId: document.scope_id ?? document.scope_l5_id ?? document.scope_l4_id ?? document.scope_l3_id ?? document.scope_l2_id ?? document.scope_l1_id ?? null,
          channelId: document.pg_channel_id || null,
          threadId: document.pg_thread_id || null,
        });
      }

      for (const report of reports) {
        items.push({
          id: `report:${report.record_id}:${report.version ?? 1}`,
          section: 'status',
          recordType: this.getFlightDeckReportTypeLabel(report),
          recordTypeKey: 'report',
          title: report.title?.trim() || this.getReportMetricLabel(report) || 'Untitled report',
          subtitle: this.getReportRecentChangeSubtitle(report),
          updatedAt: report.updated_at,
          updatedTs: Date.parse(report.updated_at) || 0,
          recordId: report.record_id,
          boardScopeId: report.scope_id ?? report.scope_l5_id ?? report.scope_l4_id ?? report.scope_l3_id ?? report.scope_l2_id ?? report.scope_l1_id ?? null,
        });
      }

      for (const task of tasks) {
        items.push({
          id: `task:${task.record_id}:${task.version ?? 1}`,
          section: 'tasks',
          recordType: 'Task',
          recordTypeKey: 'task',
          title: task.title?.trim() || 'Untitled task',
          subtitle: task.scope_id
            ? `Updated on ${this.getTaskBoardLabel(task)}`
            : 'Updated with no scope',
          updatedAt: task.updated_at,
          updatedTs: Date.parse(task.updated_at) || 0,
          recordId: task.record_id,
          boardScopeId: task.scope_id ?? task.scope_l5_id ?? task.scope_l4_id ?? task.scope_l3_id ?? task.scope_l2_id ?? task.scope_l1_id ?? null,
          channelId: task.pg_channel_id || null,
          threadId: task.pg_thread_id || null,
        });
      }

      for (const schedule of schedules) {
        items.push({
          id: `schedule:${schedule.record_id}:${schedule.version ?? 1}`,
          section: 'schedules',
          recordType: 'Schedule',
          recordTypeKey: 'schedule',
          title: schedule.title?.trim() || 'Untitled schedule',
          subtitle: `${this.formatScheduleDays(schedule.days)} ${schedule.time_start || '??:??'}-${schedule.time_end || '??:??'}`,
          updatedAt: schedule.updated_at,
          updatedTs: Date.parse(schedule.updated_at) || 0,
          recordId: schedule.record_id,
          boardScopeId: schedule.scope_id ?? schedule.scope_l5_id ?? schedule.scope_l4_id ?? schedule.scope_l3_id ?? schedule.scope_l2_id ?? schedule.scope_l1_id ?? null,
        });
      }

      for (const scope of scopes) {
        items.push({
          id: `scope:${scope.record_id}:${scope.version ?? 1}`,
          section: 'scopes',
          recordType: 'Scope',
          recordTypeKey: 'scope',
          title: scope.title?.trim() || 'Untitled scope',
          subtitle: this.getScopeBreadcrumb(scope.record_id) || this.scopeLevelLabel(scope.level),
          updatedAt: scope.updated_at,
          updatedTs: Date.parse(scope.updated_at) || 0,
          recordId: scope.record_id,
          boardScopeId: scope.record_id,
        });
      }

      for (const flow of flows) {
        items.push({
          id: `flow:${flow.record_id}:${flow.version ?? 1}`,
          section: 'flows',
          recordType: 'Flow',
          recordTypeKey: 'flow',
          title: flow.title?.trim() || 'Untitled flow',
          subtitle: flow.scope_id
            ? `Updated in ${this.getTaskBoardLabel(flow)}`
            : 'Updated with no scope',
          updatedAt: flow.updated_at,
          updatedTs: Date.parse(flow.updated_at) || 0,
          recordId: flow.record_id,
          boardScopeId: flow.scope_id ?? flow.scope_l5_id ?? flow.scope_l4_id ?? flow.scope_l3_id ?? flow.scope_l2_id ?? flow.scope_l1_id ?? null,
        });
      }

      // Batch-load targets for comments instead of one query per comment
      const taskComments = comments.filter((c) => String(c.target_record_family_hash || '').endsWith(':task'));
      const commentTaskIds = [...new Set(taskComments.map((c) => c.target_record_id).filter(Boolean))];
      const taskMap = new Map();
      await Promise.all(commentTaskIds.map(async (taskId) => {
        const t = await getTaskById(taskId);
        if (t) taskMap.set(taskId, t);
      }));
      const documentComments = comments.filter((c) => String(c.target_record_family_hash || '').endsWith(':document'));
      const commentDocumentIds = [...new Set(documentComments.map((c) => c.target_record_id).filter(Boolean))];
      const documentMap = new Map();
      await Promise.all(commentDocumentIds.map(async (documentId) => {
        const doc = await getDocumentById(documentId);
        if (doc) documentMap.set(documentId, doc);
      }));

      for (const comment of taskComments) {
        const task = taskMap.get(comment.target_record_id);
        if (!task || task.record_state === 'deleted') continue;

        this.resolveChatProfile(comment.sender_npub);

        items.push({
          id: `task-comment:${comment.record_id}`,
          section: 'tasks',
          recordType: 'Comment',
          recordTypeKey: 'comment',
          title: comment.body?.trim() || '(empty note)',
          subtitle: `${this.getSenderName(comment.sender_npub)} on ${task.title?.trim() || 'Untitled task'}`,
          updatedAt: comment.updated_at,
          updatedTs: Date.parse(comment.updated_at) || 0,
          recordId: task.record_id,
          focusRecordId: comment.record_id,
          boardScopeId: task.scope_id ?? task.scope_l5_id ?? task.scope_l4_id ?? task.scope_l3_id ?? task.scope_l2_id ?? task.scope_l1_id ?? null,
          channelId: task.pg_channel_id || null,
          threadId: task.pg_thread_id || null,
          senderNpub: comment.sender_npub,
        });
      }

      for (const comment of documentComments) {
        const document = documentMap.get(comment.target_record_id);
        if (!document || document.record_state === 'deleted') continue;

        this.resolveChatProfile(comment.sender_npub);

        items.push({
          id: `doc-comment:${comment.record_id}`,
          section: 'docs',
          recordType: 'Comment',
          recordTypeKey: 'comment',
          title: comment.body?.trim() || '(empty comment)',
          subtitle: `${this.getSenderName(comment.sender_npub)} on ${document.title?.trim() || 'Untitled document'}`,
          updatedAt: comment.updated_at,
          updatedTs: Date.parse(comment.updated_at) || 0,
          recordId: document.record_id,
          focusRecordId: comment.record_id,
          docType: 'document',
          boardScopeId: document.scope_id ?? document.scope_l5_id ?? document.scope_l4_id ?? document.scope_l3_id ?? document.scope_l2_id ?? document.scope_l1_id ?? null,
          channelId: document.pg_channel_id || null,
          threadId: document.pg_thread_id || null,
          senderNpub: comment.sender_npub,
        });
      }

      this.statusRecentChanges = items
        .sort((a, b) => b.updatedTs - a.updatedTs)
        .slice(0, MAX_STATUS_RECENT_CHANGES);
    },

    getAttentionIconSvg(icon) {
      const icons = {
        approval: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 4v5c0 4.5-2.8 7.8-7 9-4.2-1.2-7-4.5-7-9V7l7-4z"></path><path d="M9 12l2 2 4-5"></path></svg>',
        mention: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path></svg>',
        chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path></svg>',
        comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 1 1 17 0z"></path></svg>',
        task: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
        file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M7 13h10"></path></svg>',
        doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"></path><path d="M14 2v5a2 2 0 0 0 2 2h4"></path><path d="M8 13h8"></path><path d="M8 17h5"></path></svg>',
        report: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"></path><path d="M7 16l4-5 4 3 5-8"></path></svg>',
        flow: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="M9 6h3a6 6 0 0 1 6 6v3"></path></svg>',
        calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M3 10h18"></path><path d="M8 14h.01"></path><path d="M12 14h.01"></path><path d="M16 14h.01"></path></svg>',
        activity: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 8-6-16-3 8H2"></path></svg>',
      };
      return icons[icon] || icons.activity;
    },

    async openAttentionItem(item) {
      if (!item) return;
      if (item.section === 'approvals') {
        this.activeApprovalId = item.recordId;
        this.showApprovalDetail = true;
        return;
      }
      await this.openStatusChange(item);
    },

    async openTimingItem(item) {
      await this.openStatusChange(item);
    },

    formatRelativeTime(iso) {
      if (!iso) return '';
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) return '';
      const diffSec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
      if (diffSec < 60) return `${diffSec}s ago`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    },

    async openStatusChange(item) {
      if (!item) return;
      if (item.section === 'status') {
        this.navSection = 'status';
        this.mobileNavOpen = false;
        if (item.boardScopeId) {
          this.selectedBoardId = item.boardScopeId;
          this.persistSelectedBoardId(this.selectedBoardId);
          this.validateSelectedBoardId();
        }
        this.startWorkspaceLiveQueries();
        this.syncRoute();
        if (item.recordId) this.openReportModalById(item.recordId);
        return;
      }
      if (item.section === 'docs') {
        this.navSection = 'docs';
        this.mobileNavOpen = false;
        if (item.docType === 'directory') {
          this.navigateToFolder(item.recordId);
        } else if (item.recordId) {
          this.selectedDocCommentId = item.focusRecordId ?? null;
          this.openDoc(item.recordId);
        }
        return;
      }
      if (item.section === 'tasks') {
        this.navSection = 'tasks';
        this.mobileNavOpen = false;
        this.selectedBoardId = item.boardScopeId ?? this.preferredTaskBoardId;
        this.persistSelectedBoardId(this.selectedBoardId);
        this.validateSelectedBoardId();
        this.normalizeTaskFilterTags();
        if (item.recordId) {
          this.openTaskDetail(item.recordId);
        } else {
          this.syncRoute();
        }
        return;
      }
      if (item.section === 'schedules') {
        this.navSection = 'settings';
        this.settingsTab = 'schedules';
        this.mobileNavOpen = false;
        this.startWorkspaceLiveQueries();
        if (item.recordId) this.startEditSchedule(item.recordId);
        else this.syncRoute();
        return;
      }
      if (item.section === 'scopes') {
        this.navSection = 'settings';
        this.settingsTab = 'scopes';
        this.mobileNavOpen = false;
        this.startWorkspaceLiveQueries();
        this.syncRoute();
        this.$nextTick(() => {
          this.scopeNavFocus = item.recordId;
          document.getElementById('scope-' + item.recordId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return;
      }
      if (item.section !== 'chat') return;
      this.focusMessageId = item.focusRecordId ?? item.recordId ?? null;
      this.navSection = 'chat';
      this.mobileNavOpen = false;
      this.startWorkspaceLiveQueries();
      if (item.channelId) {
        await this.selectChannel(item.channelId);
      }
      if (item.threadId) {
        this.openThread(item.threadId, { scrollToLatest: false });
      } else {
        this.closeThread();
      }
    },

    isFocusedMessage(recordId) {
      return this.focusMessageId === recordId;
    },

    // getCachedPerson, getSenderName, getSenderIdentity, getSenderAvatar — in peopleProfilesManagerMixin

    getShortNpub(npub) {
      return getShortNpub(npub);
    },

    getInitials(label) {
      return getInitials(label);
    },

    getChannelLabel(channel) {
      return resolveChannelLabel(channel, {
        sessionNpub: this.session?.npub || null,
        getParticipants: (candidate) => this.getChannelParticipants(candidate),
        getSenderName: (npub) => this.getSenderName(npub),
      });
    },

    getChannelParticipants(channel) {
      if (!channel) return [];
      const direct = Array.isArray(channel.participant_npubs)
        ? channel.participant_npubs.filter(Boolean)
        : [];
      if (direct.length > 1) return [...new Set(direct)];

      const derived = new Set(direct);
      for (const groupId of channel.group_ids ?? []) {
        const group = this.groups.find((candidate) =>
          candidate.group_npub === groupId || candidate.group_id === groupId
        );
        for (const member of group?.member_npubs ?? []) {
          derived.add(member);
        }
      }
      const resolved = resolveChannelParticipants(channel, () => [...derived]);
      return resolved.length > 0 ? resolved : [...derived];
    },

    // rememberPeople, resolveChatProfile — in peopleProfilesManagerMixin

    // --- tasks ---

    async applyTasks(tasks = [], options = {}) {
      const pendingWrites = await getPendingWrites().catch(() => null);
      if (options.isCurrent && !options.isCurrent()) return false;
      const normalizedTasks = [];
      for (const task of (Array.isArray(tasks) ? tasks : [])) {
        const normalizedGroups = this.normalizeTaskRowGroupRefs(task);
        let normalized = this.normalizeTaskRowScopeRefs(normalizedGroups);
        if (
          Array.isArray(pendingWrites)
          && String(normalized?.sync_status || '').trim() === 'pending'
          && !isTaskBlockedByPendingSave(normalized, pendingWrites, taskFamilyHash('task'))
          && !hasPendingRecordWrite(pendingWrites, normalized?.record_id, taskFamilyHash('task'))
        ) {
          normalized = markTaskEditSyncedAfterAcceptedFlush(normalized, pendingWrites, taskFamilyHash('task')) || normalized;
        }
        normalizedTasks.push(normalized);
      }
      const dedupedTasks = dedupeTasksByRecordId(normalizedTasks);
      const hydratedTasks = dedupedTasks;
      if (!sameListBySignature(this.tasks, hydratedTasks, (task) => [
        String(task?.record_id || ''),
        String(task?.updated_at || ''),
        String(task?.version ?? ''),
        String(task?.record_state || ''),
        String(task?.state || ''),
        String(task?.board_order ?? ''),
        String(task?.sync_status || ''),
      ].join('|'))) {
        this.tasks = hydratedTasks;
      }
      // Resolve assignee profiles for display but do NOT write back to
      // Dexie (address book) from a liveQuery handler — that creates a
      // reactive cascade.  Profile resolution is fire-and-forget here.
      const assignedNpubs = [...new Set(hydratedTasks.flatMap((task) => this.getTaskAssigneeNpubs(task)))];
      for (const npub of assignedNpubs) {
        this.resolveChatProfile(npub);
      }
      this.selectedTaskIds = this.selectedTaskIds.filter((taskId) =>
        hydratedTasks.some((task) => task.record_id === taskId && task.record_state !== 'deleted' && !this.isParentTask(taskId))
      );
      this.normalizeTaskFilterTags();
      this.updatePageTitle();
      await this.recomputeTowerPgUnreadProjection?.();
    },

    async refreshTasks() {
      if (isTowerPgBackendMode()) {
        return this.requestTowerSyncFamily?.('tasks') ?? [];
      }
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return;
      const tasks = await getTasksByOwner(ownerNpub);
      await this.applyTasks(tasks);
      return tasks;
    },

    scheduleTasksRefresh(reason = 'background') {
      Promise.resolve()
        .then(() => this.refreshTasks())
        .catch((refreshError) => {
          console.warn(`[flightdeck] task refresh failed after ${reason}`, refreshError);
        });
    },

    scheduleTaskCommentsRefresh(taskId, reason = 'background') {
      const recordId = String(taskId || '').trim();
      if (!recordId) return;
      Promise.resolve()
        .then(() => this.requestTowerSyncFamily?.('task-comments', recordId, { force: true }))
        .catch((refreshError) => {
          console.warn(`[flightdeck] task comment refresh failed after ${reason}`, refreshError);
        });
    },

    scheduleDocumentsRefresh(reason = 'background') {
      Promise.resolve()
        .then(() => this.refreshDocuments())
        .catch((refreshError) => {
          console.warn(`[flightdeck] document refresh failed after ${reason}`, refreshError);
        });
    },

    scheduleDirectoriesAndDocumentsRefresh(reason = 'background') {
      Promise.resolve()
        .then(async () => {
          await this.refreshDirectories();
          await this.refreshDocuments();
        })
        .catch((refreshError) => {
          console.warn(`[flightdeck] document tree refresh failed after ${reason}`, refreshError);
        });
    },

    async applySelectedTask(task = null) {
      const recordId = String(this.activeTaskId || '').trim();
      if (!recordId) return;

      const nextTasks = this.tasks.filter((item) => item?.record_id !== recordId);
      if (task && task.record_state !== 'deleted') {
        nextTasks.push(task);
      }
      await this.applyTasks(nextTasks);

      if (this.activeTaskId !== recordId) return;
      const selectedTask = this.tasks.find((item) => item.record_id === recordId) || null;
      if (selectedTask) {
        const nextTask = toRaw(selectedTask);
        const hasStoredRefs = Array.isArray(nextTask.references) && nextTask.references.length > 0;
        if (!hasStoredRefs && nextTask.description) {
          nextTask.references = parseReferencesFromDescription(nextTask.description);
        }
        nextTask.predecessor_task_ids = normalizePredecessorTaskIds(nextTask.predecessor_task_ids || [], nextTask.record_id);
        if (!this.editingTask || this.editingTask.record_id !== nextTask.record_id) {
          this.editingTask = nextTask;
          this.taskEditOriginal = toRaw(nextTask);
        } else {
          this.replaceEditingTaskFromRecord(nextTask);
        }
      } else {
        this.editingTask = null;
      }
      for (const npub of this.getTaskAssigneeNpubs(this.editingTask)) {
        this.resolveChatProfile(npub);
      }
      this.predecessorTaskQuery = '';
      this.showPredecessorTaskPicker = false;
      this.showTaskDetail = Boolean(selectedTask);
    },

    formatScheduleDays(days = []) {
      const list = Array.isArray(days) ? days : [];
      if (list.length === 0 || list.length === 7) return 'Every day';
      return list.join(', ');
    },

    toggleNewScheduleDay(day) {
      if (this.newScheduleDays.includes(day)) {
        this.newScheduleDays = this.newScheduleDays.filter((value) => value !== day);
      } else {
        this.newScheduleDays = [...this.newScheduleDays, day];
      }
    },

    toggleEditingScheduleDay(day) {
      if (!this.editingScheduleDraft) return;
      const days = Array.isArray(this.editingScheduleDraft.days) ? this.editingScheduleDraft.days : [];
      this.editingScheduleDraft.days = days.includes(day)
        ? days.filter((value) => value !== day)
        : [...days, day];
    },

    resetNewScheduleForm() {
      this.newScheduleTitle = '';
      this.newScheduleDescription = '';
      this.newScheduleStart = '09:00';
      this.newScheduleEnd = '10:00';
      this.newScheduleDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
      this.newScheduleTimezone = 'Australia/Perth';
      this.newScheduleRepeat = 'daily';
      this.newScheduleAssignedGroupId = this.selectedBoardWriteGroup || this.scheduleAssignableGroups[0]?.groupId || null;
      this.newScheduleGroupQuery = '';
    },

    openNewScheduleModal() {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      this.error = null;
      try {
        this.cancelEditSchedule();
        this.resetNewScheduleForm();
        this.showNewScheduleModal = true;
        if (typeof window !== 'undefined') {
          window.requestAnimationFrame(() => {
            const input = document.querySelector('[data-new-schedule-title-input]');
            input?.focus();
            input?.select?.();
          });
        }
      } catch (error) {
        this.showNewScheduleModal = false;
        this.error = error?.message || 'Failed to open the new schedule form.';
      }
    },

    closeNewScheduleModal() {
      this.showNewScheduleModal = false;
      this.resetNewScheduleForm();
    },

    handleNewScheduleGroupInput(value) {
      this.newScheduleGroupQuery = value;
    },

    assignNewScheduleGroup(groupId) {
      const nextGroupId = this.resolveGroupId(groupId);
      this.newScheduleAssignedGroupId = nextGroupId || null;
      this.newScheduleGroupQuery = '';
    },

    clearNewScheduleGroup() {
      this.newScheduleAssignedGroupId = null;
      this.newScheduleGroupQuery = '';
    },

    handleEditingScheduleGroupInput(value) {
      this.editingScheduleGroupQuery = value;
    },

    assignEditingScheduleGroup(groupId) {
      if (!this.editingScheduleDraft) return;
      const nextGroupId = this.resolveGroupId(groupId);
      this.editingScheduleDraft.assigned_group_id = nextGroupId || null;
      this.editingScheduleGroupQuery = '';
    },

    clearEditingScheduleGroup() {
      if (!this.editingScheduleDraft) return;
      this.editingScheduleDraft.assigned_group_id = null;
      this.editingScheduleGroupQuery = '';
    },

    async applySchedules(schedules = []) {
      if (isFlightDeckSurfaceDisabled('schedules')) {
        this.schedules = [];
        return;
      }
      const normalizedSchedules = [];
      for (const schedule of (Array.isArray(schedules) ? schedules : [])) {
        const normalized = this.normalizeScheduleRowGroupRefs(schedule);
        normalizedSchedules.push(normalized);
      }
      if (!sameListBySignature(this.schedules, normalizedSchedules)) {
        this.schedules = normalizedSchedules;
      }
      this.updatePageTitle();
    },

    async refreshSchedules() {
      if (isFlightDeckSurfaceDisabled('schedules')) {
        this.schedules = [];
        return;
      }
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return;
      await this.applySchedules(await getSchedulesByOwner(ownerNpub));
    },

    async addSchedule() {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      const title = String(this.newScheduleTitle || '').trim();
      if (!title) {
        this.error = 'Schedule title is required.';
        return;
      }
      if (!this.session?.npub) {
        this.error = 'Sign in first.';
        return;
      }
      this.error = null;
      const ownerNpub = this.workspaceOwnerNpub;
      const defaultScheduleGroupRef = this.getPreferredRecordWriteGroup({
        group_ids: (this.currentWorkspaceContentGroups || []).map((group) => group.group_id || group.group_npub).filter(Boolean),
      });
      const groupId = this.resolveGroupId(
        this.newScheduleAssignedGroupId
        || this.selectedBoardWriteGroup
        || defaultScheduleGroupRef
        || this.groups[0]?.group_id
        || this.groups[0]?.group_npub,
      );
      if (!groupId) {
        this.error = 'Select a group for the schedule.';
        return;
      }
      const now = new Date().toISOString();
      const assignedToNpubs = [hasExplicitAssignee ? options.assignedToNpub : dispatchAssigneeNpub]
        .map((npub) => String(npub || '').trim())
        .filter(Boolean);

      const localRow = {
        record_id: crypto.randomUUID(),
        owner_npub: ownerNpub,
        title,
        description: String(this.newScheduleDescription || '').trim(),
        time_start: this.newScheduleStart,
        time_end: this.newScheduleEnd,
        days: [...this.newScheduleDays],
        timezone: this.newScheduleTimezone || 'Australia/Perth',
        assigned_group_id: groupId,
        active: true,
        last_run: null,
        repeat: this.newScheduleRepeat || 'daily',
        shares: groupId ? [groupId] : [],
        group_ids: groupId ? [groupId] : [],
        sync_status: 'pending',
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      };

      try {
        await upsertSchedule(localRow);
        this.schedules = [localRow, ...this.schedules];

        const writeFields = await getRecordWriteFieldsForStore(this, localRow, {
          label: 'Schedule write',
          writeGroupRef: groupId,
        });
        const envelope = await outboundSchedule({
          ...localRow,
          group_ids: writeFields.group_ids,
          signature_npub: this.signingNpub,
          write_group_ref: writeFields.write_group_ref,
        });
        await queueTowerPendingWrite(this, {
          record_id: localRow.record_id,
          record_family_hash: envelope.record_family_hash,
          envelope,
        });
        await this.flushAndBackgroundSync();
        await this.refreshSchedules();
        this.resetNewScheduleForm();
        this.showNewScheduleModal = false;
      } catch (err) {
        this.error = `Failed to create schedule: ${err.message}`;
      }
    },

    async startEditSchedule(scheduleId) {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      const schedule = this.schedules.find((item) => item.record_id === scheduleId);
      if (!schedule) return;
      this.editingScheduleId = scheduleId;
      this.editingScheduleDraft = toRaw(schedule);
      this.editingScheduleGroupQuery = '';
      this.syncRoute();
    },

    cancelEditSchedule() {
      this.editingScheduleId = null;
      this.editingScheduleDraft = null;
      this.editingScheduleGroupQuery = '';
    },

    async saveEditingSchedule() {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      if (!this.editingScheduleDraft || !this.session?.npub) return;
      this.error = null;
      const current = await getScheduleById(this.editingScheduleDraft.record_id);
      if (!current) {
        this.error = 'Schedule not found.';
        return;
      }
      const updated = toRaw({
        ...current,
        ...this.editingScheduleDraft,
        days: [...(this.editingScheduleDraft.days || [])],
        assigned_group_id: this.resolveGroupId(this.editingScheduleDraft.assigned_group_id),
        group_ids: this.resolveGroupId(this.editingScheduleDraft.assigned_group_id)
          ? [this.resolveGroupId(this.editingScheduleDraft.assigned_group_id)]
          : [...(current.group_ids || [])],
        shares: this.resolveGroupId(this.editingScheduleDraft.assigned_group_id)
          ? [this.resolveGroupId(this.editingScheduleDraft.assigned_group_id)]
          : [...(current.shares || [])],
        version: (current.version ?? 1) + 1,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });
      const writeFields = await getRecordWriteFieldsForStore(this, updated, {
        label: 'Schedule write',
        writeGroupRef: updated.assigned_group_id
          || this.getPreferredRecordWriteGroup(updated)
          || current.group_ids?.[0]
          || null,
      });
      if (!writeFields.write_group_ref) {
        this.error = 'Schedule is missing a writable group.';
        return;
      }
      try {
        await upsertSchedule(updated);
        this.schedules = this.schedules.map((item) => item.record_id === updated.record_id ? updated : item);
        this.editingScheduleDraft = toRaw(updated);

        const envelope = await outboundSchedule({
          ...updated,
          group_ids: writeFields.group_ids,
          previous_version: current.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: writeFields.write_group_ref,
        });
        await queueTowerPendingWrite(this, {
          record_id: updated.record_id,
          record_family_hash: envelope.record_family_hash,
          envelope,
        });
        await this.flushAndBackgroundSync();
        await this.refreshSchedules();
        this.cancelEditSchedule();
      } catch (err) {
        this.error = `Failed to save schedule: ${err.message}`;
      }
    },

    async toggleSchedule(scheduleId) {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      const schedule = this.schedules.find((item) => item.record_id === scheduleId);
      if (!schedule) return;
      this.editingScheduleDraft = toRaw({
        ...schedule,
        active: !schedule.active,
      });
      try {
        await this.saveEditingSchedule();
      } catch (err) {
        this.error = `Failed to toggle schedule: ${err.message}`;
      }
      if (this.editingScheduleId !== scheduleId) this.cancelEditSchedule();
    },

    async deleteSchedule(scheduleId) {
      if (blockDisabledFlightDeckSurface(this, 'schedules')) return;
      const schedule = this.schedules.find((item) => item.record_id === scheduleId);
      if (!schedule || !this.session?.npub) return;
      const updated = toRaw({
        ...schedule,
        record_state: 'deleted',
        version: (schedule.version ?? 1) + 1,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });
      try {
        await upsertSchedule(updated);
        this.schedules = this.schedules.filter((item) => item.record_id !== scheduleId);
        if (this.editingScheduleId === scheduleId) this.cancelEditSchedule();

        const writeFields = await getRecordWriteFieldsForStore(this, updated, {
          label: 'Schedule delete',
        });
        const envelope = await outboundSchedule({
          ...updated,
          group_ids: writeFields.group_ids,
          previous_version: schedule.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: writeFields.write_group_ref,
        });
        await queueTowerPendingWrite(this, {
          record_id: updated.record_id,
          record_family_hash: envelope.record_family_hash,
          envelope,
        });
        await this.flushAndBackgroundSync();
      } catch (err) {
        this.error = `Failed to delete schedule: ${err.message}`;
      }
    },

    async addTask(options = {}) {
      const title = String(this.newTaskTitle || '').trim();
      if (!title || !this.session?.npub) return null;
      const description = String(options.description || '').trim();
      let pgContext = null;
      let targetScopeId = String(options.scopeId || this.selectedBoardId || '').trim();
      if (isTowerPgBackendMode()) {
        pgContext = this.resolvePgWriteContext?.({
          scopeId: options.scopeId,
          boardId: options.boardId || this.selectedBoardId,
          channelId: options.channelId,
          threadId: options.threadId,
          includeActiveThread: options.includeActiveThread === true,
          threadMessageId: options.threadMessageId,
        }) || null;
        if (!pgContext) {
          return this.openWriteContextModal?.('task', { options }) || null;
        }
        targetScopeId = pgContext.scopeId;
      }
      if (!targetScopeId) {
        this.error = 'Select a scope board first.';
        return null;
      }
      const now = new Date().toISOString();
      const recordId = crypto.randomUUID();
      const ownerNpub = this.workspaceOwnerNpub;
      const assignment = this.buildTaskBoardAssignment(targetScopeId);
      if (targetScopeId !== UNSCOPED_TASK_BOARD_ID && !assignment.scope_id) {
        this.error = 'Select a valid scope board first.';
        return null;
      }

      const explicitReferences = Array.isArray(options.references) ? options.references : [];
      const flowLinkage = resolveFlowLinkage({
        title,
        description,
        references: [
          ...parseReferencesFromDescription(description),
          ...explicitReferences,
        ],
        flows: (this.flows || []).filter(f => f.record_state !== 'deleted'),
      });
      const dispatchAssigneeNpub = resolveFlowDispatchAssignee({
        flowId: flowLinkage.flow_id,
        flowRunId: flowLinkage.flow_run_id,
        defaultAgentNpub: this.defaultAgentNpub,
        botNpub: this.botNpub,
      });
      const hasExplicitAssignee = Object.prototype.hasOwnProperty.call(options, 'assignedToNpub');
      const assignedToNpubs = [hasExplicitAssignee ? options.assignedToNpub : dispatchAssigneeNpub]
        .map((npub) => String(npub || '').trim())
        .filter(Boolean);

      const localRow = {
        record_id: recordId,
        owner_npub: ownerNpub,
        title,
        description,
        state: String(options.state || 'new').trim() || 'new',
        priority: String(options.priority || 'sand').trim() || 'sand',
        board_order: Number.isFinite(Number(options.boardOrder ?? options.board_order))
          ? Number(options.boardOrder ?? options.board_order)
          : null,
        parent_task_id: null,
        ...assignment,
        assigned_to_npubs: assignedToNpubs,
        assigned_to_npub: assignedToNpubs[0] || null,
        scheduled_for: null,
        tags: '',
        predecessor_task_ids: null,
        flow_id: flowLinkage.flow_id,
        flow_run_id: flowLinkage.flow_run_id,
        flow_step: flowLinkage.flow_step,
        source_links: Array.isArray(options.sourceLinks) ? options.sourceLinks : [],
        references: flowLinkage.references,
        deliverable_links: Array.isArray(options.deliverableLinks) ? options.deliverableLinks : [],
        ...(pgContext ? {
          pg_backend: true,
          pg_record_type: 'task',
          pg_channel_id: pgContext.channelId,
          pg_thread_id: pgContext.threadId || null,
        } : {}),
        sync_status: 'pending',
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      };

      await upsertTask(localRow);
      this.tasks = mergeTaskIntoList(this.tasks, localRow);
      this.newTaskTitle = '';

      if (isTowerPgBackendMode()) {
        try {
          const createdTask = await createTowerPgTaskFromLocal(this, localRow);
          await replaceLocalTaskWithAcceptedPgTask(this, localRow.record_id, createdTask);
          return createdTask;
        } catch (error) {
          const failedRow = { ...localRow, sync_status: 'failed', updated_at: new Date().toISOString() };
          await upsertTask(failedRow);
          this.tasks = this.tasks.map((task) => task.record_id === localRow.record_id
            ? failedRow
            : task);
          this.error = isOnlineForPgEdit()
            ? (error?.message || 'Failed to create PG task')
            : 'PG task saved locally. Reconnect to sync it.';
          return failedRow;
        }
      }

      const taskWriteFields = await this.getTaskWriteFieldsForWrite(localRow);
      const envelope = await outboundTask({
        ...localRow,
        group_ids: taskWriteFields.group_ids,
        signature_npub: this.signingNpub,
        write_group_ref: taskWriteFields.write_group_ref,
      });
      await queueTowerPendingWrite(this, {
        record_id: recordId,
        record_family_hash: envelope.record_family_hash,
        envelope,
      });
      let createdTask = localRow;
      const flushResult = await this.flushAndBackgroundSync();
      if ((flushResult?.pushed ?? 0) > 0) {
        const pendingWrites = await getPendingWrites();
        const acceptedTask = markTaskEditSyncedAfterAcceptedFlush(localRow, pendingWrites, taskFamilyHash('task'));
        if (acceptedTask) {
          await upsertTask(acceptedTask);
          this.tasks = this.tasks.map((task) => task.record_id === acceptedTask.record_id ? acceptedTask : task);
          createdTask = acceptedTask;
        }
      }
      await this.refreshTasks();
      return createdTask;
    },

    getTaskDetailCheckoutPolicyConfig() {
      const baseConfig = this.recordCheckoutPolicyConfig || {};
      return {
        recordFamilyHashes: {
          ...(baseConfig.recordFamilyHashes || {}),
        },
        familySuffixes: {
          ...(baseConfig.familySuffixes || {}),
          task: 'checkout_required',
        },
      };
    },

    getCheckoutEditPolicyConfig(familySuffix) {
      const suffix = String(familySuffix || '').trim();
      const baseConfig = this.recordCheckoutPolicyConfig || {};
      return {
        recordFamilyHashes: {
          ...(baseConfig.recordFamilyHashes || {}),
        },
        familySuffixes: {
          ...(baseConfig.familySuffixes || {}),
          ...(suffix ? { [suffix]: 'checkout_required' } : {}),
        },
      };
    },

    getTaskPatchCheckoutPolicyConfig(updatedTask, previousTask = null, options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, 'checkoutPolicyConfig') && options.checkoutPolicyConfig) {
        return options.checkoutPolicyConfig;
      }
      return this.getTaskDetailCheckoutPolicyConfig();
    },

    async getEncryptableTaskGroupIdsForWrite(record = null) {
      return getEncryptableRecordGroupRefsForStore(this, record, {
        label: 'Task write',
      });
    },

    async getTaskWriteFieldsForWrite(record = null, options = {}) {
      return getRecordWriteFieldsForStore(this, record, {
        ...options,
        label: 'Task write',
      });
    },

    async getTaskUpdateWriteFieldsForWrite(updatedTask, previousTask = null) {
      const previousWriteGroupRef = previousTask?.record_id && Number(previousTask?.version ?? 0) > 0
        ? this.getPreferredRecordWriteGroup(previousTask)
        : null;
      if (previousWriteGroupRef) {
        const previousWriteFields = await this.getTaskWriteFieldsForWrite(updatedTask, {
          writeGroupRef: previousWriteGroupRef,
          allowedGroupIds: [previousWriteGroupRef],
        });
        if (previousWriteFields.write_group_ref) return previousWriteFields;
      }
      return this.getTaskWriteFieldsForWrite(updatedTask);
    },

    getPendingTaskWrites(pendingWrites = [], recordId) {
      return getPendingRecordWrites(pendingWrites, recordId, taskFamilyHash('task'));
    },

    getPendingTaskBaseVersion(pendingWrites = [], recordId) {
      return getPendingRecordBaseVersion(pendingWrites, recordId, taskFamilyHash('task'));
    },

    async replacePendingTaskWrites(recordId, pendingWrites = null) {
      const rows = this.getPendingTaskWrites(
        Array.isArray(pendingWrites) ? pendingWrites : await getPendingWrites(),
        recordId,
      );
      await Promise.all(rows
        .filter((row) => row?.row_id != null)
        .map((row) => removePendingWrite(row.row_id)));
    },

    isTaskDetailEditing() {
      return this.taskDetailMode === 'edit';
    },

    isPgTaskDetailDraftEnabled(task = this.editingTask) {
      return isTowerPgBackendMode() && Boolean(task?.record_id);
    },

    isEditingTaskDirty() {
      if (!this.editingTask?.record_id || !this.taskEditOriginal?.record_id) return false;
      return taskDraftSignature(this.editingTask) !== taskDraftSignature(this.taskEditOriginal);
    },

    refreshTaskDraftDirtyState() {
      this.taskDraftDirty = this.isEditingTaskDirty();
      if (!this.taskDraftDirty && !this.taskDraftRemoteChanged) {
        this.taskDraftSaveState = '';
      }
      return this.taskDraftDirty;
    },

    handleEditingTaskDraftChanged() {
      if (!this.editingTask?.record_id) return;
      const dirty = this.refreshTaskDraftDirtyState();
      if (!this.isPgTaskDetailDraftEnabled()) return;
      if (!dirty) {
        this.clearTaskLocalDraft(this.editingTask.record_id).catch(() => {});
        return;
      }
      this.taskDraftSaveState = 'pending';
      this.scheduleTaskLocalDraftSave();
    },

    scheduleTaskLocalDraftSave() {
      if (!this.isPgTaskDetailDraftEnabled() || !this.taskDraftDirty) return;
      if (this.taskDraftAutosaveTimer) clearTimeout(this.taskDraftAutosaveTimer);
      this.taskDraftAutosaveTimer = setTimeout(() => {
        this.taskDraftAutosaveTimer = null;
        void this.persistTaskLocalDraft();
      }, PG_TASK_DETAIL_DRAFT_AUTOSAVE_MS);
    },

    async persistTaskLocalDraft() {
      if (!this.isPgTaskDetailDraftEnabled() || !this.editingTask?.record_id) return false;
      if (!this.refreshTaskDraftDirtyState()) {
        await this.clearTaskLocalDraft(this.editingTask.record_id);
        return false;
      }
      const key = taskDetailDraftKey(this.editingTask.record_id);
      if (!key) return false;
      await setSyncState(key, {
        record_id: this.editingTask.record_id,
        base_version: this.taskEditOriginal?.version ?? null,
        base_updated_at: this.taskEditOriginal?.updated_at || null,
        saved_at: new Date().toISOString(),
        draft: normalizeTaskDraftPayload(this.editingTask),
      });
      this.taskDraftSaveState = 'local';
      this.taskDraftSavedAt = new Date().toISOString();
      return true;
    },

    async clearTaskLocalDraft(recordId = null) {
      const key = taskDetailDraftKey(recordId || this.editingTask?.record_id);
      if (!key) return false;
      if (this.taskDraftAutosaveTimer) {
        clearTimeout(this.taskDraftAutosaveTimer);
        this.taskDraftAutosaveTimer = null;
      }
      await deleteSyncState(key);
      if (!recordId || recordId === this.editingTask?.record_id) {
        this.taskDraftDirty = false;
        this.taskDraftSaveState = '';
        this.taskDraftSavedAt = '';
        this.taskDraftRemoteChanged = false;
      }
      return true;
    },

    async restoreTaskLocalDraft(task = null) {
      if (!this.isPgTaskDetailDraftEnabled(task)) return false;
      const recordId = String(task?.record_id || '').trim();
      const key = taskDetailDraftKey(recordId);
      if (!key) return false;
      const stored = await getSyncState(key);
      if (!stored?.draft || this.activeTaskId !== recordId || this.editingTask?.record_id !== recordId) return false;
      const draft = stored.draft;
      this.editingTask = this.withTaskAssigneeNpubs({
        ...this.editingTask,
        ...draft,
        record_id: recordId,
        predecessor_task_ids: normalizePredecessorTaskIds(draft.predecessor_task_ids || [], recordId),
      }, Array.isArray(draft.assigned_to_npubs) ? draft.assigned_to_npubs : []);
      this.taskDraftDirty = true;
      this.taskDraftSaveState = 'local';
      this.taskDraftSavedAt = stored.saved_at || '';
      this.destroyTaskRichDescriptionEditor();
      return true;
    },

    replaceEditingTaskFromRecord(task = null, options = {}) {
      if (!task?.record_id || this.editingTask?.record_id !== task.record_id) return false;
      if (!options.force && this.refreshTaskDraftDirtyState()) {
        this.taskDraftRemoteChanged = true;
        return false;
      }
      this.editingTask = toRaw(task);
      this.editingTask.predecessor_task_ids = normalizePredecessorTaskIds(this.editingTask.predecessor_task_ids || [], this.editingTask.record_id);
      this.taskEditOriginal = toRaw(task);
      this.taskDraftDirty = false;
      this.taskDraftSaveState = '';
      this.taskDraftSavedAt = '';
      this.taskDraftRemoteChanged = false;
      this.destroyTaskRichDescriptionEditor();
      return true;
    },

    destroyTaskRichDescriptionEditor() {
      this.taskRichDescriptionToolbar?.destroy();
      this.taskRichDescriptionToolbar = null;
      this.taskRichDescriptionModel = '';
      this.taskRichDescriptionUploadIds = [];
      if (this.taskRichDescriptionAdapter) {
        this.taskRichDescriptionAdapter.destroy();
      }
      this.taskRichDescriptionAdapter = null;
      this.taskRichDescriptionMountEl = null;
      this.taskRichDescriptionRecordId = '';
    },

    canEnterTaskDescriptionEdit() {
      return Boolean(this.editingTask?.record_id && this.session?.npub
        && !this.editingTask.read_only && !this.taskDetailSaving
        && !this.taskDetailCheckoutPending);
    },

    async editTaskDescription(event) {
      const target = event?.target;
      if (target?.closest?.('a, input, [data-mention-type]')) return false;
      const selection = target?.ownerDocument?.getSelection();
      if (event?.type === 'click' && selection && !selection.isCollapsed
        && event.currentTarget?.contains(selection.anchorNode)) return false;
      if (!this.canEnterTaskDescriptionEdit() || this.taskDescriptionEntryPending) return false;
      const recordId = this.editingTask.record_id;
      const document = target?.ownerDocument;
      const previewTop = event?.currentTarget?.getBoundingClientRect().top;
      const keys = [];
      event?.currentTarget?.focus?.({ preventScroll: true });
      // Keep immediate typing while Alpine and the lazy editor mount resolve.
      const capture = (keyEvent) => {
        if (this.editingTask?.record_id !== recordId) return;
        if (keyEvent.target?.closest?.('input, textarea, [contenteditable=true]')) return;
        if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey || keyEvent.isComposing) return;
        if (keyEvent.key.length === 1 || ['Enter', 'Backspace'].includes(keyEvent.key)) {
          keyEvent.preventDefault();
          keys.push(keyEvent.key);
        }
      };
      this.taskDescriptionEntryPending = true;
      document?.addEventListener('keydown', capture, true);
      try {
        const task = this.tasks.find(row => row.record_id === recordId);
        if (isTaskBlockedByPendingSave(task, await getPendingWrites(), taskFamilyHash('task'))) {
          this.error = 'This task has a pending save. Sync before editing it again.';
          return false;
        }
        if (this.editingTask?.record_id !== recordId || !this.canEnterTaskDescriptionEdit()) return false;
        if (!this.isTaskDetailEditing() && !await this.enterTaskDetailEditMode()) return false;
        if (this.editingTask?.record_id !== recordId) return false;
        this.taskDescriptionEditing = true;
        await new Promise(resolve => Alpine.nextTick(resolve));
        const element = document?.querySelector('.task-description-section .task-rich-editor');
        await this.mountTaskRichDescriptionEditor(element);
        const editor = this.taskRichDescriptionAdapter?.getEditor();
        if (!editor || this.editingTask?.record_id !== recordId) return false;
        let position = 'end';
        if (event?.type === 'click' && Number.isFinite(previewTop)) {
          const coords = editor.view.posAtCoords({
            left: event.clientX,
            top: event.clientY + editor.view.dom.getBoundingClientRect().top - previewTop,
          });
          if (coords) position = coords.pos;
        }
        editor.commands.focus(position, { scrollIntoView: false });
        // focus() schedules DOM focus; synchronously focus before releasing keys.
        editor.view.dom.focus({ preventScroll: true });
        for (const key of keys) {
          if (key === 'Enter') editor.commands.enter();
          else if (key === 'Backspace') editor.commands.keyboardShortcut('Backspace');
          else editor.commands.insertContent(key);
        }
        return true;
      } catch (error) {
        if (this.editingTask?.record_id === recordId) {
          this.taskDescriptionEditing = false;
          this.error = error?.userMessage || error?.message || 'Could not edit task description.';
        }
        return false;
      } finally {
        document?.removeEventListener('keydown', capture, true);
        this.taskDescriptionEntryPending = false;
      }
    },

    async mountTaskRichDescriptionEditor(element = null) {
      if (!element || !this.editingTask?.record_id || !this.isTaskDetailEditing() || !this.taskDescriptionEditing) return;
      if (
        this.taskRichDescriptionAdapter
        && this.taskRichDescriptionMountEl === element
        && this.taskRichDescriptionRecordId === this.editingTask.record_id
      ) {
        if (this.taskRichDescriptionModel !== this.editingTask.description) {
          this.taskRichDescriptionModel = this.editingTask.description || '';
          this.taskRichDescriptionAdapter.setDescription(this.taskRichDescriptionModel);
        }
        return;
      }
      this.destroyTaskRichDescriptionEditor();
      this.taskRichDescriptionMountEl = element;
      const recordId = this.editingTask.record_id;
      this.taskRichDescriptionRecordId = recordId;
      const { createTaskDescriptionEditor } = await import('./task-description-editor.js');
      if (this.taskRichDescriptionMountEl !== element || this.editingTask?.record_id !== recordId
        || !this.isTaskDetailEditing() || !this.taskDescriptionEditing) return;
      // Two Alpine effects can request a mount while the lazy import resolves.
      if (this.taskRichDescriptionAdapter) return;
      element.replaceChildren();
      const editorMount = element.ownerDocument.createElement('div');
      element.append(editorMount);
      this.taskRichDescriptionModel = this.editingTask.description || '';
      let editorContent = null;
      this.taskRichDescriptionAdapter = createTaskDescriptionEditor({
        element: editorMount,
        description: this.taskRichDescriptionModel,
        editable: true,
        onPaste: (event, editor) => this.handleTaskRichPaste?.(event, editor) === true,
        onKeydown: (event, editor) => {
          this.handleMentionKeydown({
            currentTarget: editor.view.dom,
            key: event.key,
            isComposing: event.isComposing,
            preventDefault: () => event.preventDefault(),
          });
          return event.defaultPrevented;
        },
        onUpdate: (contentModel) => {
          if (this.editingTask?.record_id !== recordId || !this.isTaskDetailEditing()) return;
          // Focus can assign internal block IDs without changing Markdown.
          if (contentModel?.content === editorContent) return;
          editorContent = contentModel?.content || '';
          this.taskRichDescriptionModel = contentModel?.content || '';
          this.editingTask.description = this.taskRichDescriptionModel;
          this.handleEditingTaskDraftChanged();
          this.scheduleStorageImageHydration?.();
        },
      });
      editorContent = this.taskRichDescriptionAdapter.getContentModel().content;
      const editor = this.taskRichDescriptionAdapter.getEditor();
      this.taskRichDescriptionToolbar = createDailyNoteTiptapToolbar(editor);
      this.taskRichDescriptionToolbar.element.setAttribute('aria-label', 'Task description formatting');
      element.prepend(this.taskRichDescriptionToolbar.element);
      editor.view.dom.setAttribute('aria-label', 'Task description');
      editor.view.dom.setAttribute('role', 'textbox');
      editor.view.dom.setAttribute('aria-multiline', 'true');
      this.scheduleStorageImageHydration?.();
    },

    // Task creates stay optimistic. Every existing-task mutation should use
    // this helper so checkout, write groups, and pending-write semantics stay aligned.
    async queueTaskWrite(updatedTask, previousTask, options = {}) {
      const checkoutPolicyConfig = Object.prototype.hasOwnProperty.call(options, 'checkoutPolicyConfig')
        ? options.checkoutPolicyConfig
        : this.getTaskDetailCheckoutPolicyConfig();
      const taskWriteFields = await this.getTaskUpdateWriteFieldsForWrite(updatedTask, previousTask);
      const envelope = await outboundTask({
        ...updatedTask,
        group_ids: taskWriteFields.group_ids,
        previous_version: previousTask?.version ?? 0,
        signature_npub: this.signingNpub,
        write_group_ref: taskWriteFields.write_group_ref,
      });
      let managedEnvelope = envelope;
      let checkoutPrepareState = checkoutPolicyConfig ? 'ready' : null;
      let checkoutPrepareError = null;
      if (options.existingCheckout) {
        managedEnvelope = { ...envelope, checkout: options.existingCheckout };
      } else if (checkoutPolicyConfig && typeof this.attachCheckoutRequiredCheckoutToEnvelope === 'function') {
        try {
          managedEnvelope = await this.attachCheckoutRequiredCheckoutToEnvelope(updatedTask, envelope, {
            intent: options.intent || 'edit',
            checkoutPolicyConfig,
          });
        } catch (error) {
          checkoutPrepareState = 'blocked';
          checkoutPrepareError = error?.classification || error?.towerCode || error?.code || error?.message || 'checkout_failed';
        }
      }
      const pendingWrite = {
        record_id: updatedTask.record_id,
        record_family_hash: managedEnvelope.record_family_hash,
        envelope: managedEnvelope,
      };
      if (checkoutPolicyConfig) {
        pendingWrite.checkout_policy_config = checkoutPolicyConfig;
        pendingWrite.checkout_prepare_state = checkoutPrepareState;
        if (checkoutPrepareError) pendingWrite.checkout_prepare_error = checkoutPrepareError;
      }
      await queueTowerPendingWrite(this, pendingWrite);
    },

    async applyTaskPatch(taskId, patch = {}, options = {}) {
      const task = this.tasks.find((entry) => entry.record_id === taskId);
      if (!task || !this.session?.npub) return null;

      const usePgBackgroundWrite = isTowerPgBackendMode()
        && isSyncedPgRecord(task)
        && options.backgroundPg === true;
      const releasePatchPgLease = false;

      const nextVersion = (task.version ?? 1) + 1;
      const patchHasAssignees = Object.prototype.hasOwnProperty.call(patch, 'assigned_to_npubs')
        || Object.prototype.hasOwnProperty.call(patch, 'assigned_to_npub');
      const nextAssignees = patchHasAssignees
        ? (Array.isArray(patch.assigned_to_npubs)
          ? patch.assigned_to_npubs
          : [patch.assigned_to_npub])
        : this.getTaskAssigneeNpubs(task);
      let updated = toRaw(this.withTaskAssigneeNpubs({
        ...task,
        ...patch,
        version: nextVersion,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      }, nextAssignees));

      if (updated.state === 'done' || updated.state === 'archive') {
        Object.assign(updated, this.withTaskAssigneeNpubs(updated, []));
      }
      if (isTowerPgBackendMode()) {
        updated = withTaskActivityAuthor(updated, {
          actorId: this.currentPgActorId,
          actorNpub: this.currentViewerNpub || this.session?.npub,
        });
      }

      await upsertTask(updated);
      this.tasks = this.tasks.map((entry) => entry.record_id === taskId ? updated : entry);
      await this.recomputeTowerPgUnreadProjection?.();

      if (this.editingTask?.record_id === taskId) {
        this.replaceEditingTaskFromRecord(updated, { force: true });
      }

      if (isTowerPgBackendMode()) {
        if (usePgBackgroundWrite) {
          await this.enqueuePgTaskPatch(updated, task, patch, {
            ...options,
            releasePatchPgLease,
          });
          return updated;
        }
        if (isUnsyncedLocalPgRecord(task)) {
          if (!isOnlineForPgEdit(options.env)) {
            const localOnlyTask = {
              ...updated,
              sync_status: String(task.sync_status || '').trim() || 'failed',
            };
            await upsertTask(localOnlyTask);
            this.tasks = this.tasks.map((entry) => entry.record_id === taskId ? localOnlyTask : entry);
            if (this.editingTask?.record_id === taskId) this.replaceEditingTaskFromRecord(localOnlyTask, { force: true });
            return localOnlyTask;
          }
          try {
            const createdTask = await createTowerPgTaskFromLocal(this, updated);
            await replaceLocalTaskWithAcceptedPgTask(this, updated.record_id, createdTask);
            return createdTask;
          } catch (error) {
            const failedTask = options.rollbackOnFailure
              ? task
              : { ...updated, sync_status: 'failed', updated_at: new Date().toISOString() };
            await upsertTask(failedTask);
            this.tasks = this.tasks.map((entry) => entry.record_id === taskId ? failedTask : entry);
            if (this.editingTask?.record_id === taskId) this.replaceEditingTaskFromRecord(failedTask, { force: true });
            this.error = error?.message || 'Failed to sync local PG task.';
            return null;
          }
        }
        try {
          const acceptedTask = await updateTowerPgTaskFromLocal(this, updated, task, patch);
          await upsertTask(acceptedTask);
          this.tasks = this.tasks.map((entry) => entry.record_id === taskId ? acceptedTask : entry);
          if (this.editingTask?.record_id === taskId) this.replaceEditingTaskFromRecord(acceptedTask, { force: true });
          if (releasePatchPgLease) await releasePgEditLeaseForRecord(this, task, 'task');
          return acceptedTask;
        } catch (error) {
          const failedTask = options.rollbackOnFailure
            ? task
            : { ...updated, sync_status: 'failed', updated_at: new Date().toISOString() };
          await upsertTask(failedTask);
          this.tasks = this.tasks.map((entry) => entry.record_id === taskId ? failedTask : entry);
          if (this.editingTask?.record_id === taskId) this.replaceEditingTaskFromRecord(failedTask, { force: true });
          this.error = error?.message || 'Failed to update PG task';
          if (releasePatchPgLease) await releasePgEditLeaseForRecord(this, task, 'task');
          return null;
        }
      }

      const queueOptions = {
        checkoutPolicyConfig: this.getTaskPatchCheckoutPolicyConfig(updated, task, options),
      };
      if (options.intent) queueOptions.intent = options.intent;
      await this.queueTaskWrite(updated, task, queueOptions);

      const newAssignees = this.getTaskAssigneeNpubs(updated);
      const oldAssignees = this.getTaskAssigneeNpubs(task);
      const addedAssignees = newAssignees.filter((npub) => !oldAssignees.includes(npub));
      if (addedAssignees.length > 0) {
        await this.rememberPeople(addedAssignees, 'task-assignee');
      }

      if (options.sync !== false) {
        await this.flushAndBackgroundSync();
      }
      if (options.refresh) {
        await this.refreshTasks();
      }
      return updated;
    },

    async readPersistedPgTaskWriteQueue() {
      try {
        return normalizePgTaskWriteQueue(await getSyncState(PG_TASK_WRITE_QUEUE_SYNC_STATE_KEY));
      } catch {
        return [];
      }
    },

    async persistPgTaskWriteQueue(queue = null) {
      const rows = normalizePgTaskWriteQueue(queue || this.pgTaskWriteQueue || []);
      if (rows.length === 0) {
        await deleteSyncState(PG_TASK_WRITE_QUEUE_SYNC_STATE_KEY);
      } else {
        await setSyncState(PG_TASK_WRITE_QUEUE_SYNC_STATE_KEY, rows);
      }
      return rows;
    },

    async resumePgTaskWriteQueue() {
      if (!isTowerPgBackendMode()) return 0;
      const generation = this._workspaceSelectionGeneration;
      const workspaceKey = this.currentWorkspaceKey;
      const actor = this.session?.npub;
      const persisted = await this.readPersistedPgTaskWriteQueue();
      if (!actor || this.session?.npub !== actor || this.currentWorkspaceKey !== workspaceKey
        || this._workspaceSelectionGeneration !== generation || persisted.length === 0) return 0;
      const currentById = new Map((this.pgTaskWriteQueue || []).map((item) => [item.queueId, item]));
      for (const item of persisted) {
        if (!currentById.has(item.queueId)) currentById.set(item.queueId, item);
      }
      this.pgTaskWriteQueue = normalizePgTaskWriteQueue([...currentById.values()]);
      this.pgTaskWriteProgressDone = 0;
      this.pgTaskWriteProgressTotal = this.pgTaskWriteQueue.length;
      this.pgTaskWriteFailedCount = 0;
      this.syncStatus = 'syncing';
      this.updateSyncSession?.({
        state: 'syncing',
        phase: 'pushing',
        currentFamily: 'tasks',
        pushed: 0,
        pushTotal: this.pgTaskWriteProgressTotal,
        error: null,
      });
      if (this.session?.npub) this.schedulePgTaskWriteQueueProcessing();
      return this.pgTaskWriteQueue.length;
    },

    async enqueuePgTaskPatch(updatedTask, previousTask, patch = {}, options = {}) {
      const item = {
        queueId: createPgTaskWriteQueueId(updatedTask.record_id),
        recordId: updatedTask.record_id,
        updatedTask: toRaw(updatedTask),
        previousTask: toRaw(previousTask),
        patch: { ...(patch || {}) },
        options: { ...(options || {}) },
        createdAt: new Date().toISOString(),
      };
      this.pgTaskWriteQueue = normalizePgTaskWriteQueue([
        ...(this.pgTaskWriteQueue || []),
        item,
      ]);
      await this.persistPgTaskWriteQueue();
      this.pgTaskWriteProgressTotal = Math.max(
        Number(this.pgTaskWriteProgressTotal || 0),
        Number(this.pgTaskWriteProgressDone || 0)
          + this.pgTaskWriteQueue.length,
      );
      this.syncStatus = 'syncing';
      this.updateSyncSession?.({
        state: 'syncing',
        phase: 'pushing',
        currentFamily: 'tasks',
        pushed: this.pgTaskWriteProgressDone,
        pushTotal: this.pgTaskWriteProgressTotal,
        error: null,
      });
      if (options.deferPgProcessing !== true) this.schedulePgTaskWriteQueueProcessing();
    },

    schedulePgTaskWriteQueueProcessing() {
      if (!this.session?.npub || !this.selectedWorkspaceKey || this.pgTaskWriteProcessTimer) return;
      const run = () => {
        this.pgTaskWriteProcessTimer = null;
        void this.processPgTaskWriteQueue();
      };
      if (typeof setTimeout === 'function') {
        this.pgTaskWriteProcessTimer = setTimeout(run, 0);
      } else {
        this.pgTaskWriteProcessTimer = true;
        Promise.resolve().then(run);
      }
    },

    async processPgTaskWriteQueueItem(item) {
      const generation = this._workspaceSelectionGeneration;
      const actor = this.session?.npub;
      const workspaceKey = this.currentWorkspaceKey;
      const isCurrent = () => Boolean(actor && this.session?.npub === actor
        && this.currentWorkspaceKey === workspaceKey && this._workspaceSelectionGeneration === generation);
      if (!isCurrent()) return { status: 'detached', item };
      const previousTask = item.previousTask;
      try {
        const currentBeforeWrite = await getTaskById(item.recordId) || this.tasks.find((task) => task.record_id === item.recordId);
        if (!isCurrent()) return { status: 'detached', item };
        const queuedVersion = Number(item.updatedTask?.version ?? 0) || 0;
        const currentVersionBeforeWrite = Number(currentBeforeWrite?.version ?? 0) || 0;
        const currentSyncStatus = String(currentBeforeWrite?.sync_status || '').trim();
        if (currentBeforeWrite && currentSyncStatus !== 'pending' && currentVersionBeforeWrite >= queuedVersion) {
          return { status: 'skipped', item };
        }
        const currentLocal = await getTaskById(item.recordId)
          || this.tasks.find((task) => task.record_id === item.recordId)
          || item.updatedTask;
        if (!isCurrent()) return { status: 'detached', item };
        const acceptedTask = await updateTowerPgTaskFromLocal(this, {
          ...currentLocal,
          record_id: item.recordId,
        }, previousTask, item.patch || {});
        if (!isCurrent()) return { status: 'detached', item };
        await upsertTask(acceptedTask);
        if (!isCurrent()) return { status: 'detached', item };
        const currentAfterWrite = this.tasks.find((task) => task.record_id === item.recordId);
        const currentVersion = Number(currentAfterWrite?.version ?? 0) || 0;
        if (!currentAfterWrite || currentVersion <= queuedVersion) {
          this.tasks = this.tasks.map((task) => task.record_id === item.recordId ? acceptedTask : task);
          if (!this.tasks.some((task) => task.record_id === item.recordId)) {
            this.tasks = mergeTaskIntoList(this.tasks, acceptedTask);
          }
        if (this.editingTask?.record_id === item.recordId) this.replaceEditingTaskFromRecord(acceptedTask, { force: true });
        }
        if (item.options?.releasePatchPgLease) await releasePgEditLeaseForRecord(this, previousTask, 'task');
        return { status: 'synced', item, acceptedTask };
      } catch (error) {
        if (!isCurrent()) return { status: 'detached', item };
        const failedTask = {
          ...(this.tasks.find((task) => task.record_id === item.recordId) || item.updatedTask),
          sync_status: 'failed',
          updated_at: new Date().toISOString(),
        };
        await upsertTask(failedTask);
        if (!isCurrent()) return { status: 'detached', item };
        this.tasks = this.tasks.map((task) => task.record_id === item.recordId ? failedTask : task);
        if (this.editingTask?.record_id === item.recordId) this.replaceEditingTaskFromRecord(failedTask, { force: true });
        this.error = error?.message || 'Failed to update PG task';
        this.pgTaskWriteFailedCount = Number(this.pgTaskWriteFailedCount || 0) + 1;
        if (item.options?.releasePatchPgLease) await releasePgEditLeaseForRecord(this, previousTask, 'task');
        return { status: 'failed', item, error };
      }
    },

    async processPgTaskWriteQueue() {
      if (!this.session?.npub || !this.selectedWorkspaceKey || this.pgTaskWriteInFlight) return;
      const generation = this._workspaceSelectionGeneration;
      const actor = this.session.npub;
      const workspaceKey = this.currentWorkspaceKey;
      const isCurrent = () => this.session?.npub === actor && this.currentWorkspaceKey === workspaceKey
        && this._workspaceSelectionGeneration === generation;
      this.pgTaskWriteInFlight = true;
      try {
        while (isCurrent() && (this.pgTaskWriteQueue || []).length > 0) {
          const batch = selectPgTaskWriteBatch(this.pgTaskWriteQueue);
          if (batch.length === 0) break;
          const completedQueueIds = new Set(batch.map((item) => item.queueId));
          await Promise.all(batch.map(async (item) => {
            await this.processPgTaskWriteQueueItem(item);
            if (!isCurrent()) return;
            this.pgTaskWriteProgressDone = Number(this.pgTaskWriteProgressDone || 0) + 1;
            this.updateSyncSession?.({
              state: 'syncing',
              phase: 'pushing',
              currentFamily: 'tasks',
              pushed: this.pgTaskWriteProgressDone,
              pushTotal: this.pgTaskWriteProgressTotal,
            });
          }));
          if (!isCurrent()) return;
          this.pgTaskWriteQueue = removePgTaskWriteQueueItems(this.pgTaskWriteQueue, completedQueueIds);
          await this.persistPgTaskWriteQueue();
        }
        if (!isCurrent()) return;
        const failedCount = Number(this.pgTaskWriteFailedCount || 0);
        this.syncStatus = failedCount > 0 ? 'error' : 'synced';
        this.updateSyncSession?.(failedCount > 0
          ? {
            state: 'error',
            phase: 'error',
            currentFamily: 'tasks',
            pushed: this.pgTaskWriteProgressDone,
            pushTotal: this.pgTaskWriteProgressTotal,
            error: `${failedCount} task update${failedCount === 1 ? '' : 's'} failed.`,
          }
          : {
            state: 'synced',
            phase: 'done',
            currentFamily: 'tasks',
            pushed: this.pgTaskWriteProgressDone,
            pushTotal: this.pgTaskWriteProgressTotal,
            lastSuccessAt: Date.now(),
            error: null,
          });
        this.pgTaskWriteProgressDone = 0;
        this.pgTaskWriteProgressTotal = 0;
        this.pgTaskWriteFailedCount = 0;
      } finally {
        if (isCurrent()) this.pgTaskWriteInFlight = false;
        if (isCurrent() && (this.pgTaskWriteQueue || []).length > 0) this.schedulePgTaskWriteQueueProcessing();
      }
    },

    async cascadeTaskScopeToSubtasks(parentTask, nextParentTask) {
      const subtasks = this.tasks.filter((task) =>
        task.parent_task_id === parentTask.record_id
        && task.record_state !== 'deleted'
      );
      if (subtasks.length === 0) return 0;

      const scopeRef = nextParentTask.scope_id
        ?? nextParentTask.scope_l5_id
        ?? nextParentTask.scope_l4_id
        ?? nextParentTask.scope_l3_id
        ?? nextParentTask.scope_l2_id
        ?? nextParentTask.scope_l1_id
        ?? null;
      const assignment = this.buildTaskBoardAssignment(scopeRef, nextParentTask);

      this.taskScopeCascadePending = true;
      this.taskScopeCascadeMessage = `Updating ${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}…`;

      const updates = new Map();
      try {
        for (const subtask of subtasks) {
          const updatedSubtask = toRaw(buildCascadedSubtaskUpdate(subtask, assignment));
          await upsertTask(updatedSubtask);
          updates.set(updatedSubtask.record_id, updatedSubtask);
          await this.queueTaskWrite(updatedSubtask, subtask);
        }
      } finally {
        this.taskScopeCascadePending = false;
      }

      if (updates.size > 0) {
        this.tasks = this.tasks.map((task) => updates.get(task.record_id) || task);
      }
      this.taskScopeCascadeMessage = `Updated ${updates.size} subtask${updates.size === 1 ? '' : 's'}.`;
      if (typeof window !== 'undefined') {
        window.setTimeout(() => {
          if (!this.taskScopeCascadePending) this.taskScopeCascadeMessage = '';
        }, 3000);
      }
      return updates.size;
    },

    async addSubtask(parentId) {
      const title = String(this.newSubtaskTitle || '').trim();
      if (!title || !this.session?.npub) return;

      const parent = this.tasks.find(t => t.record_id === parentId);
      if (parent && parent.parent_task_id) {
        this.error = 'Cannot nest subtasks more than one level deep.';
        return;
      }

      const now = new Date().toISOString();
      const recordId = crypto.randomUUID();
      const ownerNpub = this.workspaceOwnerNpub;

      const localRow = {
        record_id: recordId,
        owner_npub: ownerNpub,
        title,
        description: '',
        state: 'new',
        priority: 'sand',
        parent_task_id: parentId,
        ...this.buildTaskBoardAssignment(parent?.scope_id ?? parent?.scope_l5_id ?? parent?.scope_l4_id ?? parent?.scope_l3_id ?? parent?.scope_l2_id ?? parent?.scope_l1_id ?? null, parent),
        assigned_to_npubs: [],
        assigned_to_npub: null,
        scheduled_for: null,
        tags: '',
        predecessor_task_ids: null,
        source_links: [{ type: 'task', id: parentId }],
        references: [],
        deliverable_links: [],
        ...(isTowerPgBackendMode() ? {
          pg_backend: true,
          pg_record_type: 'task',
          pg_channel_id: parent?.pg_channel_id || parent?.channel_id || this.selectedChannelId || null,
          pg_thread_id: parent?.pg_thread_id || parent?.thread_id || null,
        } : {}),
        sync_status: 'pending',
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      };

      await upsertTask(localRow);
      this.tasks = mergeTaskIntoList(this.tasks, localRow);
      this.newSubtaskTitle = '';

      if (isTowerPgBackendMode()) {
        try {
          const createdTask = await createTowerPgTaskFromLocal(this, localRow);
          await replaceLocalTaskWithAcceptedPgTask(this, localRow.record_id, createdTask);
          return createdTask;
        } catch (error) {
          const failedRow = { ...localRow, sync_status: 'failed', updated_at: new Date().toISOString() };
          await upsertTask(failedRow);
          this.tasks = this.tasks.map((task) => task.record_id === localRow.record_id
            ? failedRow
            : task);
          this.error = isOnlineForPgEdit()
            ? (error?.message || 'Failed to create PG subtask')
            : 'PG subtask saved locally. Reconnect to sync it.';
          return failedRow;
        }
      }

      const taskWriteFields = await this.getTaskWriteFieldsForWrite(localRow);
      const envelope = await outboundTask({
        ...localRow,
        group_ids: taskWriteFields.group_ids,
        signature_npub: this.signingNpub,
        write_group_ref: taskWriteFields.write_group_ref,
      });
      await queueTowerPendingWrite(this, {
        record_id: recordId,
        record_family_hash: envelope.record_family_hash,
        envelope,
      });
      await this.flushAndBackgroundSync();
      await this.refreshTasks();
    },

    async updateTaskField(taskId, field, value) {
      await this.applyTaskPatch(taskId, { [field]: value }, {
        silent: true,
        sync: true,
        backgroundPg: isTowerPgBackendMode(),
        intent: `quick_${field}`,
      });
    },

    getTaskDueTodayDateKey() {
      return new Date().toISOString().slice(0, 10);
    },

    getTaskDueThisWeekDateKey() {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const daysUntilFriday = dayOfWeek <= 5 ? (5 - dayOfWeek) : 6;
      const friday = new Date(today);
      friday.setDate(today.getDate() + (daysUntilFriday === 0 ? 7 : daysUntilFriday));
      return friday.toISOString().slice(0, 10);
    },

    buildTaskDetailQuickActionPatch(action) {
      switch (action) {
        case 'blocked':
          return { state: 'blocked' };
        case 'done':
          return { state: 'done', assigned_to_npubs: [] };
        case 'archive':
          return { state: 'archive', assigned_to_npubs: [] };
        case 'today':
          return { scheduled_for: this.getTaskDueTodayDateKey() };
        case 'this_week':
          return { scheduled_for: this.getTaskDueThisWeekDateKey() };
        default:
          return null;
      }
    },

    setTaskDueToday() {
      if (!this.editingTask || !this.isTaskDetailEditing()) return;
      this.editingTask.scheduled_for = this.getTaskDueTodayDateKey();
      this.handleEditingTaskDraftChanged();
    },

    setTaskDueThisWeek() {
      if (!this.editingTask || !this.isTaskDetailEditing()) return;
      this.editingTask.scheduled_for = this.getTaskDueThisWeekDateKey();
      this.handleEditingTaskDraftChanged();
    },

    async quickSetTaskState(state) {
      if (!this.editingTask || !this.isTaskDetailEditing()) return;
      this.editingTask.state = state;
      if (state === 'done' || state === 'archive') {
        this.editingTask = this.withTaskAssigneeNpubs(this.editingTask, []);
      }
      this.handleEditingTaskDraftChanged();
    },

    async applyTaskDetailQuickAction(action) {
      if (!this.editingTask?.record_id || this.taskDetailSaving) return;

      if (this.isTaskDetailEditing()) {
        if (action === 'blocked' || action === 'done' || action === 'archive') this.quickSetTaskState(action);
        else if (action === 'today') this.setTaskDueToday();
        else if (action === 'this_week') this.setTaskDueThisWeek();
        return;
      }

      const patch = this.buildTaskDetailQuickActionPatch(action);
      if (!patch) return;

      const taskId = this.editingTask.record_id;
      this.taskDetailSaving = true;
      try {
        const updated = await this.applyTaskPatch(taskId, patch, {
          sync: false,
          intent: `quick_${action}`,
          backgroundPg: isTowerPgBackendMode(),
        });
        if (!isTowerPgBackendMode()) {
          await this.flushAndBackgroundSync();
          await this.refreshTasks();
        }
        if (this.activeTaskId === taskId) {
          const current = this.tasks.find((task) => task.record_id === taskId) || updated;
          if (current) {
            this.replaceEditingTaskFromRecord(toRaw(current), { force: true });
          }
        }
      } catch (error) {
        this.error = error?.message || 'Failed to update task.';
      } finally {
        this.taskDetailSaving = false;
      }
    },

    async enterTaskDetailEditMode() {
      if (!this.canEnterTaskDescriptionEdit()) return false;
      const task = this.tasks.find(t => t.record_id === this.editingTask.record_id);
      if (!task) return false;
      const pendingWrites = await getPendingWrites();
      if (isTaskBlockedByPendingSave(task, pendingWrites, taskFamilyHash('task'))) {
        this.error = 'This task has a pending save. Sync before editing it again.';
        return false;
      }
      const pendingTaskWrites = this.getPendingTaskWrites(pendingWrites, task.record_id);
      const taskForEdit = String(task.sync_status || '').trim() === 'pending'
        && pendingTaskWrites.length === 0
        ? markTaskEditSyncedAfterAcceptedFlush(task, pendingWrites, taskFamilyHash('task')) || task
        : task;
      if (taskForEdit !== task) {
        await upsertTask(taskForEdit);
        this.tasks = this.tasks.map(t => t.record_id === taskForEdit.record_id ? taskForEdit : t);
      }
      const checkoutPolicyConfig = this.getTaskDetailCheckoutPolicyConfig();
      this.taskDetailCheckoutPending = true;
      try {
        if (isTowerPgBackendMode()) {
          // PG tasks use local drafts and explicit saves; editing no longer waits
          // for a Tower edit lease.
        } else if (pendingTaskWrites.length === 0) {
          await this.ensureLockManagedCheckout(taskForEdit, taskFamilyHash('task'), {
            intent: 'edit',
            checkoutPolicyConfig,
          });
        }
        if (this.editingTask?.record_id !== taskForEdit.record_id) return false;
        this.taskEditOriginal = toRaw(taskForEdit);
        this.editingTask = toRaw(taskForEdit);
        this.editingTask.predecessor_task_ids = normalizePredecessorTaskIds(this.editingTask.predecessor_task_ids || [], this.editingTask.record_id);
        this.taskDetailMode = 'edit';
        this.taskDescriptionEditing = true;
        this.error = '';
        return true;
      } catch (error) {
        this.taskDetailMode = 'view';
        this.taskDescriptionEditing = false;
        if (error?.code === 'pg_synced_offline') this.error = 'Reconnect to edit synced PG tasks.';
        else if (error?.userMessage) this.error = error.userMessage;
        return false;
      } finally {
        this.taskDetailCheckoutPending = false;
      }
    },

    async cancelTaskDetailEdit(options = {}) {
      if (!this.editingTask) return;
      const task = this.tasks.find(t => t.record_id === this.editingTask.record_id) || this.taskEditOriginal;
      const checkoutPolicyConfig = this.getTaskDetailCheckoutPolicyConfig();
      if (task?.record_id) {
        if (isTowerPgBackendMode()) {
          await this.clearTaskLocalDraft(task.record_id);
          const latest = this.tasks.find(t => t.record_id === task.record_id) || task;
          this.replaceEditingTaskFromRecord(latest, { force: true });
          this.taskDetailMode = 'edit';
          this.taskDescriptionEditing = true;
          this.taskAssigneeQuery = '';
          this.predecessorTaskQuery = '';
          this.showPredecessorTaskPicker = false;
          this.showFlowPicker = false;
          this.closeScopePicker();
          return;
        } else {
          await this.releaseLockManagedCheckout(task, taskFamilyHash('task'), {
            reportError: options.reportError === true,
            force: true,
            checkoutPolicyConfig,
          });
        }
      }
      const latest = task?.record_id ? this.tasks.find(t => t.record_id === task.record_id) || task : null;
      this.editingTask = latest ? toRaw(latest) : null;
      if (this.editingTask) {
        this.editingTask.predecessor_task_ids = normalizePredecessorTaskIds(this.editingTask.predecessor_task_ids || [], this.editingTask.record_id);
      }
      this.taskEditOriginal = null;
      this.taskDetailMode = 'view';
      this.taskDescriptionEditing = false;
      this.taskAssigneeQuery = '';
      this.predecessorTaskQuery = '';
      this.showPredecessorTaskPicker = false;
      this.showFlowPicker = false;
      this.closeScopePicker();
    },

    async saveEditingTask() {
      if (!this.editingTask || !this.session?.npub) return;
      if (!this.isTaskDetailEditing()) {
        this.error = 'Click Edit before changing this task.';
        return;
      }
      if (this.taskDetailSaving) return;
      if (this.taskRichDescriptionUploadIds.length > 0 || this.containsInlineImageUploadToken(this.editingTask.description)) {
        this.error = 'Wait for image upload to finish.';
        return;
      }
      const task = this.tasks.find(t => t.record_id === this.editingTask.record_id);
      if (!task) return;
      const pendingWritesBeforeSave = await getPendingWrites();
      if (isTaskBlockedByPendingSave(task, pendingWritesBeforeSave, taskFamilyHash('task'))) {
        this.error = 'This task has a pending save. Sync before saving it again.';
        if (!isTowerPgBackendMode()) {
          this.taskDetailMode = 'view';
          this.taskEditOriginal = null;
          this.taskDescriptionEditing = false;
        }
        return;
      }
      const pendingTaskWrites = this.getPendingTaskWrites(pendingWritesBeforeSave, task.record_id);
      const pendingBaseVersion = this.getPendingTaskBaseVersion(pendingWritesBeforeSave, task.record_id);
      const taskForSave = String(task.sync_status || '').trim() === 'pending'
        && pendingTaskWrites.length === 0
        ? markTaskEditSyncedAfterAcceptedFlush(task, pendingWritesBeforeSave, taskFamilyHash('task')) || task
        : task;
      if (taskForSave !== task) {
        await upsertTask(taskForSave);
        this.tasks = this.tasks.map(t => t.record_id === taskForSave.record_id ? taskForSave : t);
      }
      if (this.editingTask.state === 'done' || this.editingTask.state === 'archive') {
        this.editingTask = this.withTaskAssigneeNpubs(this.editingTask, []);
      }

      const nextVersion = pendingBaseVersion == null
        ? (taskForSave.version ?? 1) + 1
        : pendingBaseVersion + 1;
      const descRefs = parseReferencesFromDescription(this.editingTask.description);
      const existingRecordLinks = buildRecordLinkPayload({
        source_links: this.editingTask.source_links ?? taskForSave.source_links ?? [],
        references: this.editingTask.references ?? taskForSave.references ?? [],
        deliverable_links: this.editingTask.deliverable_links ?? taskForSave.deliverable_links ?? [],
      });
      const baseReferences = mergeRecordLinkLists(existingRecordLinks.references, descRefs);
      const flowLinkage = resolveFlowLinkage({
        title: this.editingTask.title,
        description: this.editingTask.description,
        references: baseReferences,
        flows: (this.flows || []).filter(f => f.record_state !== 'deleted'),
      });
      const predecessorTaskIds = normalizePredecessorTaskIds(this.editingTask.predecessor_task_ids || [], this.editingTask.record_id);
      const draft = toRaw({
        ...taskForSave,
        title: this.editingTask.title,
        description: this.editingTask.description,
        state: this.editingTask.state,
        priority: this.editingTask.priority,
        scheduled_for: this.editingTask.scheduled_for,
        tags: this.editingTask.tags,
        predecessor_task_ids: predecessorTaskIds.length > 0 ? predecessorTaskIds : null,
        assigned_to_npubs: this.getTaskAssigneeNpubs(this.editingTask),
        assigned_to_npub: this.getPrimaryTaskAssigneeNpub(this.editingTask),
        scope_id: this.editingTask.scope_id ?? null,
        scope_l1_id: this.editingTask.scope_l1_id ?? null,
        scope_l2_id: this.editingTask.scope_l2_id ?? null,
        scope_l3_id: this.editingTask.scope_l3_id ?? null,
        scope_l4_id: this.editingTask.scope_l4_id ?? null,
        scope_l5_id: this.editingTask.scope_l5_id ?? null,
        scope_policy_group_ids: this.editingTask.scope_policy_group_ids ?? taskForSave.scope_policy_group_ids ?? null,
        board_group_id: this.editingTask.board_group_id ?? taskForSave.board_group_id ?? null,
        shares: toRaw(this.editingTask.shares ?? taskForSave.shares ?? []),
        group_ids: toRaw(this.editingTask.group_ids ?? taskForSave.group_ids ?? []),
        flow_id: flowLinkage.flow_id ?? taskForSave.flow_id ?? null,
        flow_run_id: flowLinkage.flow_run_id ?? taskForSave.flow_run_id ?? null,
        flow_step: flowLinkage.flow_step ?? taskForSave.flow_step ?? null,
        source_links: existingRecordLinks.source_links,
        references: flowLinkage.references,
        deliverable_links: existingRecordLinks.deliverable_links,
      });
      const scopePolicyPatch = draft.scope_id
        ? (() => {
          const previousScopeGroupIds = draft.scope_id !== taskForSave.scope_id && taskForSave.scope_id
            ? this.getResolvedScopePolicyGroupIds(taskForSave.scope_id)
            : [];
          if (
            draft.scope_id !== taskForSave.scope_id
            || this.shouldRefreshScopedPolicy(draft, draft.scope_id, { allowLegacyGroupFallback: true })
          ) {
            return this.buildScopedPolicyRepairPatch(draft, {
              scopeId: draft.scope_id,
              previousScopeGroupIds,
              includeBoardGroupId: true,
              fallbackPolicyGroupIds: taskForSave.group_ids || [],
            });
          }
          return {
            scope_policy_group_ids: this.getResolvedScopePolicyGroupIds(draft.scope_id),
            board_group_id: this.getPreferredRecordWriteGroup(draft),
          };
        })()
        : {
          scope_policy_group_ids: null,
        };
      let updated = toRaw({
        ...draft,
        ...scopePolicyPatch,
        version: nextVersion,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });
      if (isTowerPgBackendMode()) {
        updated = withTaskActivityAuthor(updated, {
          actorId: this.currentPgActorId,
          actorNpub: this.currentViewerNpub || this.session?.npub,
        });
      }

      this.taskDetailSaving = true;
      try {
        if (isTowerPgBackendMode()) {
          await upsertTask(updated);
          this.tasks = this.tasks.map(t => t.record_id === updated.record_id ? updated : t);
          await this.recomputeTowerPgUnreadProjection?.();
          this.replaceEditingTaskFromRecord(updated, { force: true });

          if (isUnsyncedLocalPgRecord(taskForSave)) {
            if (isOnlineForPgEdit()) {
              try {
                const createdTask = await createTowerPgTaskFromLocal(this, updated);
                await this.clearTaskLocalDraft(updated.record_id);
                await replaceLocalTaskWithAcceptedPgTask(this, updated.record_id, createdTask);
                await this.clearTaskLocalDraft(createdTask.record_id);
                this.replaceEditingTaskFromRecord(createdTask, { force: true });
              } catch (error) {
                const failed = { ...updated, sync_status: 'failed', updated_at: new Date().toISOString() };
                await upsertTask(failed);
                this.tasks = this.tasks.map(t => t.record_id === failed.record_id ? failed : t);
                this.replaceEditingTaskFromRecord(failed, { force: true });
                this.error = error?.message || 'Failed to sync local PG task.';
                return;
              }
            }
            await this.clearTaskLocalDraft(this.editingTask?.record_id || updated.record_id);
            this.taskDetailMode = 'edit';
            this.taskDescriptionEditing = true;
            return;
          }

          let acceptedTask = taskForSave;
          const stateChanged = updated.state !== taskForSave.state;
          const scalarPatch = {};
          if (updated.title !== taskForSave.title) scalarPatch.title = updated.title;
          if ((updated.description || '') !== (taskForSave.description || '')) scalarPatch.description = updated.description;
          if (updated.priority !== taskForSave.priority) scalarPatch.priority = updated.priority;
          if ((updated.scheduled_for || null) !== (taskForSave.scheduled_for || null)) scalarPatch.scheduled_for = updated.scheduled_for || null;
          if ((updated.tags || '') !== (taskForSave.tags || '')) scalarPatch.tags = updated.tags || '';
          if (JSON.stringify(this.getTaskAssigneeNpubs(updated)) !== JSON.stringify(this.getTaskAssigneeNpubs(taskForSave))) {
            scalarPatch.assigned_to_npubs = this.getTaskAssigneeNpubs(updated);
          }
          if (JSON.stringify(updated.predecessor_task_ids || null) !== JSON.stringify(taskForSave.predecessor_task_ids || null)) {
            scalarPatch.predecessor_task_ids = updated.predecessor_task_ids || null;
          }
          if ((updated.flow_id || null) !== (taskForSave.flow_id || null)) scalarPatch.flow_id = updated.flow_id || null;
          if ((updated.flow_run_id || null) !== (taskForSave.flow_run_id || null)) scalarPatch.flow_run_id = updated.flow_run_id || null;
          if ((updated.flow_step || null) !== (taskForSave.flow_step || null)) scalarPatch.flow_step = updated.flow_step || null;
          if (JSON.stringify(updated.source_links || []) !== JSON.stringify(taskForSave.source_links || [])) scalarPatch.source_links = updated.source_links || [];
          if (JSON.stringify(updated.references || []) !== JSON.stringify(taskForSave.references || [])) scalarPatch.references = updated.references || [];
          if (JSON.stringify(updated.deliverable_links || []) !== JSON.stringify(taskForSave.deliverable_links || [])) scalarPatch.deliverable_links = updated.deliverable_links || [];
          if (stateChanged) {
            acceptedTask = await updateTowerPgTaskFromLocal(this, updated, taskForSave, { state: updated.state });
          }
          if (Object.keys(scalarPatch).length > 0 || !stateChanged) {
            acceptedTask = await updateTowerPgTaskFromLocal(this, {
              ...updated,
              record_id: acceptedTask.record_id,
              version: acceptedTask.version,
            }, acceptedTask, scalarPatch);
          }
          await upsertTask(acceptedTask);
          this.tasks = this.tasks.map(t => t.record_id === updated.record_id ? acceptedTask : t);
          this.replaceEditingTaskFromRecord(acceptedTask, { force: true });
          await this.clearTaskLocalDraft(acceptedTask.record_id);
          this.taskDetailMode = 'edit';
          this.taskDescriptionEditing = true;
          return;
        }
        const hasQueuedTaskWrite = pendingTaskWrites.length > 0;
        const queuedCheckout = pendingTaskWrites.find((row) => row?.envelope?.checkout)?.envelope?.checkout || null;
        const queuedCheckoutPolicyConfig = pendingTaskWrites.find((row) => row?.checkout_policy_config)?.checkout_policy_config || null;
        const checkoutPolicyConfig = hasQueuedTaskWrite
          ? queuedCheckoutPolicyConfig
          : this.getTaskPatchCheckoutPolicyConfig(updated, taskForSave, { intent: 'edit' });
        await upsertTask(updated);
        this.tasks = this.tasks.map(t => t.record_id === updated.record_id ? updated : t);
        this.replaceEditingTaskFromRecord(updated, { force: true });
        if (this.activeTaskId === updated.record_id) this.scheduleStorageImageHydration();

        if (hasQueuedTaskWrite) {
          await this.replacePendingTaskWrites(updated.record_id, pendingWritesBeforeSave);
        }
        const previousTaskForWrite = pendingBaseVersion == null
          ? taskForSave
          : pendingBaseVersion > 0
            ? { ...taskForSave, version: pendingBaseVersion }
            : null;
        await this.queueTaskWrite(updated, previousTaskForWrite, {
          checkoutPolicyConfig,
          existingCheckout: queuedCheckout,
          intent: 'edit',
        });
        // Task checkout edits commit one task record. Subtask scope cascades
        // need their own explicit transaction if we bring them back here.
        const flushResult = await this.flushAndBackgroundSync();
        let pendingWrites = await getPendingWrites();
        let acceptedTask = (flushResult?.pushed ?? 0) > 0
          ? markTaskEditSyncedAfterAcceptedFlush(updated, pendingWrites, taskFamilyHash('task'))
          : null;
        if (!acceptedTask && typeof this.forceSyncPendingWriteTargets === 'function') {
          const result = await this.forceSyncPendingWriteTargets([{
            familyId: 'task',
            recordId: updated.record_id,
            label: updated.title || updated.record_id,
          }]);
          pendingWrites = await getPendingWrites();
          if (result.synced > 0) {
            const currentTask = this.tasks.find(t => t.record_id === updated.record_id) || updated;
            acceptedTask = markTaskEditSyncedAfterAcceptedFlush(currentTask, pendingWrites, taskFamilyHash('task'));
          }
        }
        if (acceptedTask) {
          await upsertTask(acceptedTask);
          this.tasks = this.tasks.map(t => t.record_id === acceptedTask.record_id ? acceptedTask : t);
          this.replaceEditingTaskFromRecord(acceptedTask, { force: true });
          if (isTowerPgBackendMode()) {
            await releasePgEditLeaseForRecord(this, updated, 'task');
          } else {
            this.clearLockManagedCheckoutSession(updated.record_id, taskFamilyHash('task'));
          }
          this.taskDetailMode = 'view';
          this.taskEditOriginal = null;
          this.taskDescriptionEditing = false;
        } else if (hasQueuedTaskWrite) {
          this.error = '';
          this.taskDetailMode = 'view';
          this.taskEditOriginal = null;
          this.taskDescriptionEditing = false;
        } else {
          this.error = 'Task save is still pending. Sync before editing it again.';
          this.taskDetailMode = 'view';
          this.taskEditOriginal = null;
          this.taskDescriptionEditing = false;
        }
        await this.refreshTasks();
      } catch (error) {
        this.error = error?.message || 'Failed to save task.';
      } finally {
        this.taskDetailSaving = false;
      }
    },

    async deleteTask(taskId) {
      const task = this.tasks.find(t => t.record_id === taskId);
      if (!task || !this.session?.npub) return;

      const subtasks = this.getSubtasks(taskId);
      let deleteSubtasks = false;

      if (subtasks.length > 0) {
        const answer = window.confirm(`This task has ${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}. Also delete subtasks?`);
        deleteSubtasks = answer;
      } else {
        if (!window.confirm('Delete this task?')) return;
      }

      // Delete the parent task
      await this._softDeleteTask(task);

      // Cascade to subtasks if confirmed
      if (deleteSubtasks) {
        for (const sub of subtasks) {
          await this._softDeleteTask(sub);
        }
      }

      if (this.activeTaskId === taskId) {
        this.closeTaskDetail();
      }

      await this.flushAndBackgroundSync();
    },

    async _softDeleteTask(task) {
      if (isTowerPgBackendMode() && task?.pg_backend) {
        const updated = toRaw({
          ...task,
          record_state: 'deleted',
          sync_status: 'pending',
          updated_at: new Date().toISOString(),
        });
        await upsertTask(updated);
        this.tasks = this.tasks.filter(t => t.record_id !== task.record_id);
        try {
          await deleteTowerPgTaskFromLocal(this, task);
        } catch (error) {
          const failed = { ...updated, sync_status: 'failed', updated_at: new Date().toISOString() };
          await upsertTask(failed);
          this.tasks = mergeTaskIntoList(this.tasks, failed);
          throw error;
        }
        return;
      }
      const nextVersion = (task.version ?? 1) + 1;
      const updated = toRaw({
        ...task,
        record_state: 'deleted',
        version: nextVersion,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });

      await upsertTask(updated);
      this.tasks = this.tasks.filter(t => t.record_id !== task.record_id);

      await this.queueTaskWrite(updated, task, { intent: 'delete' });
    },

    async openChatTaskModal(taskId, options = {}) {
      return openTaskLinkFromChat(this, taskId, options.deps || {});
    },

    async closeChatTaskModal() {
      if (this.chatTaskModalOpen) {
        await this.closeTaskDetail({ syncRoute: false });
      }
      this.chatTaskModalOpen = false;
      this.chatTaskModalTitle = '';
      this.chatTaskModalFullScreen = false;
    },

    toggleChatTaskModalFullScreen() {
      if (!this.chatTaskModalOpen) return;
      this.chatTaskModalFullScreen = !this.chatTaskModalFullScreen;
    },

    openChatTaskFullPage() {
      const taskId = String(this.activeTaskId || '').trim();
      if (!taskId) return;
      this.chatTaskModalOpen = false;
      this.chatTaskModalTitle = '';
      this.chatTaskModalFullScreen = false;
      this.navSection = 'tasks';
      this.mobileNavOpen = false;
      this.startWorkspaceLiveQueries();
      this.openTaskDetail(taskId);
    },

    // --- task ↔ flow linkage helpers ---

    getEditingTaskFlowInfo() {
      if (!this.editingTask) return null;
      return getTaskFlowInfo(
        this.editingTask,
        (this.flows || []).filter((f) => f.record_state !== 'deleted'),
      );
    },

    findEditingTaskFlowRunStepTask(flowRunId, stepNumber) {
      return findTaskForFlowRunStep(this.tasks, flowRunId, stepNumber);
    },

    openEditingTaskFlowRunStepTask(flowRunId, stepNumber) {
      const task = this.findEditingTaskFlowRunStepTask(flowRunId, stepNumber);
      if (task?.record_id) {
        this.openTaskDetail(task.record_id);
      }
    },

    async attachFlowToEditingTask(flowId) {
      if (!this.editingTask || !this.isTaskDetailEditing()) return;
      const patch = buildAttachFlowPatch(flowId, this.editingTask.references || []);
      Object.assign(this.editingTask, patch);
      this.showFlowPicker = false;
      this.handleEditingTaskDraftChanged();
    },

    async detachFlowFromEditingTask() {
      if (!this.editingTask || !this.isTaskDetailEditing()) return;
      const patch = buildDetachFlowPatch(this.editingTask.references || []);
      Object.assign(this.editingTask, patch);
      this.handleEditingTaskDraftChanged();
    },

    handleTaskAssigneeInput(value) {
      this.taskAssigneeQuery = value;
      if (this.taskAssigneeQuery.startsWith('npub1') && this.taskAssigneeQuery.length >= 20) {
        this.resolveChatProfile(this.taskAssigneeQuery);
      }
    },

    getEditingTaskPredecessorRows() {
      return getTaskPredecessorReferenceRows(this.editingTask, this.tasks);
    },

    getPredecessorTaskScopeMeta(task) {
      if (!task?.record_id || task.missing_predecessor) return 'Missing task';
      const relationship = describePredecessorRelationship(this.editingTask, task, this.scopesMap);
      const scopeId = task.scope_id
        ?? task.scope_l5_id
        ?? task.scope_l4_id
        ?? task.scope_l3_id
        ?? task.scope_l2_id
        ?? task.scope_l1_id
        ?? null;
      const scopeLabel = scopeId ? this.getScopeBreadcrumb(scopeId) : 'Unscoped';
      return `${relationship} • ${scopeLabel}`;
    },

    getTaskScopeId(task) {
      return task?.scope_id
        ?? task?.scope_l5_id
        ?? task?.scope_l4_id
        ?? task?.scope_l3_id
        ?? task?.scope_l2_id
        ?? task?.scope_l1_id
        ?? null;
    },

    getTaskScopeLevel(task) {
      const scopeId = this.getTaskScopeId(task);
      if (!scopeId) return '';
      return this.scopesMap.get(scopeId)?.level || '';
    },

    getTaskScopeLabel(task) {
      const scopeId = this.getTaskScopeId(task);
      if (!scopeId) return 'Unscoped';
      return this.getScopeBreadcrumb(scopeId) || this.scopesMap.get(scopeId)?.title || 'Scoped';
    },

    getTaskAssigneeLabel(task) {
      const npubs = this.getTaskAssigneeNpubs(task);
      if (npubs.length === 0) return 'Unassigned';
      if (npubs.length === 1) return this.getSenderName(npubs[0]) || npubs[0];
      return npubs.map((npub) => this.getSenderName(npub) || npub).join(', ');
    },

    getTaskAssigneeNpubs(task) {
      return normalizeTaskAssigneeNpubs(task);
    },

    getPrimaryTaskAssigneeNpub(task) {
      return this.getTaskAssigneeNpubs(task)[0] || null;
    },

    isLongTaskTitle(title) {
      const normalized = String(title || '').replace(/\s+/g, ' ').trim();
      if (!normalized) return false;
      return normalized.length > 64 || normalized.split(' ').some((word) => word.length > 22);
    },

    getTaskTitleLengthClass(title) {
      return { 'task-title-long': this.isLongTaskTitle(title) };
    },

    withTaskAssigneeNpubs(task, npubs = []) {
      const assigned_to_npubs = normalizeTaskAssigneeNpubs(npubs);
      return {
        ...task,
        assigned_to_npubs,
        assigned_to_npub: assigned_to_npubs[0] || null,
      };
    },

    formatTaskPriority(priority) {
      switch (String(priority || '').toLowerCase()) {
        case 'rock': return 'Rock';
        case 'pebble': return 'Pebble';
        case 'sand': return 'Sand';
        default: return 'Sand';
      }
    },

    formatTaskDueDate(value) {
      const raw = String(value || '').trim();
      if (!raw) return 'No due date';
      const [year, month, day] = raw.split('-').map((part) => Number(part));
      if (!year || !month || !day) return raw;
      const date = new Date(year, month - 1, day);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    },

    get predecessorTaskSuggestions() {
      if (!this.editingTask) return [];
      return buildPredecessorTaskSuggestions(this.tasks, this.editingTask, this.scopesMap, {
        query: this.predecessorTaskQuery,
        excludedIds: this.editingTask.predecessor_task_ids || [],
        scopeLabelForTask: (task) => {
          const scopeId = task.scope_id
            ?? task.scope_l5_id
            ?? task.scope_l4_id
            ?? task.scope_l3_id
            ?? task.scope_l2_id
            ?? task.scope_l1_id
            ?? null;
          return scopeId ? this.getScopeBreadcrumb(scopeId) : 'Unscoped';
        },
      });
    },

    openPredecessorTaskPicker() {
      this.showPredecessorTaskPicker = true;
    },

    closePredecessorTaskPicker() {
      this.showPredecessorTaskPicker = false;
      this.predecessorTaskQuery = '';
    },

    handlePredecessorTaskInput(value) {
      this.predecessorTaskQuery = value;
      this.showPredecessorTaskPicker = true;
    },

    async addEditingTaskPredecessor(taskId) {
      if (!this.editingTask || !this.session?.npub || !this.isTaskDetailEditing()) return;
      this.editingTask.predecessor_task_ids = normalizePredecessorTaskIds([
        ...(this.editingTask.predecessor_task_ids || []),
        taskId,
      ], this.editingTask.record_id);
      this.predecessorTaskQuery = '';
      this.showPredecessorTaskPicker = false;
      this.handleEditingTaskDraftChanged();
    },

    async removeEditingTaskPredecessor(taskId) {
      if (!this.editingTask || !this.session?.npub || !this.isTaskDetailEditing()) return;
      this.editingTask.predecessor_task_ids = normalizePredecessorTaskIds(
        (this.editingTask.predecessor_task_ids || []).filter((candidate) => candidate !== taskId),
        this.editingTask.record_id,
      );
      this.handleEditingTaskDraftChanged();
    },

    async assignEditingTask(npub) {
      if (!this.editingTask || !this.session?.npub || !this.isTaskDetailEditing()) return;
      const nextNpub = String(npub || '').trim();
      this.editingTask = this.withTaskAssigneeNpubs(this.editingTask, nextNpub ? [nextNpub] : []);
      this.taskAssigneeQuery = '';
      this.handleEditingTaskDraftChanged();
      if (nextNpub) {
        await this.rememberPeople([nextNpub], 'task-assignee');
      }
    },

    async clearEditingTaskAssignee() {
      await this.assignEditingTask(null);
    },

    async doTaskWithDefaultAgent() {
      if (!this.editingTask || !this.defaultAgentNpub || !this.session?.npub || !this.isTaskDetailEditing()) return;
      this.editingTask = this.withTaskAssigneeNpubs(this.editingTask, [this.defaultAgentNpub]);
      this.editingTask.state = 'ready';
      this.taskAssigneeQuery = '';
      this.handleEditingTaskDraftChanged();
      this.rememberPeople([this.defaultAgentNpub], 'task-assignee');
    },

    buildTaskUrl(taskId) {
      if (typeof window === 'undefined') return '';
      const task = this.tasks.find((item) => item.record_id === taskId);
      const scopeId = task?.scope_id ?? task?.scope_l5_id ?? task?.scope_l4_id ?? task?.scope_l3_id ?? task?.scope_l2_id ?? task?.scope_l1_id ?? this.selectedBoardId ?? null;
      const currentRoute = parseRouteLocation(window.location.href);
      const workspaceSlug = this.currentWorkspaceSlug || currentRoute.workspaceSlug || null;
      const workspaceKey = this.currentWorkspaceKey || currentRoute.params?.workspacekey || null;
      const href = buildSectionUrl({
        workspaceSlug,
        section: 'tasks',
        scopeid: scopeId,
        params: {
          taskid: taskId,
          workspacekey: workspaceKey,
        },
      });
      return new URL(href, window.location.origin).toString();
    },

    async copyTaskLink(taskId) {
      if (!taskId || typeof window === 'undefined') return;
      const url = this.buildTaskUrl(taskId);
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
        } else {
          const input = document.createElement('input');
          input.value = url;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          input.remove();
        }
        this.copiedTaskLinkId = taskId;
        window.setTimeout(() => {
          if (this.copiedTaskLinkId === taskId) this.copiedTaskLinkId = null;
        }, 1800);
      } catch {
        this.error = 'Could not copy task link.';
      }
    },

    // --- Scope management (extracted to scopes-manager.js) ---
    // scopesManagerMixin applied via applyMixins (has getters)

    // task board drag-drop

    handleTaskDragStart(e, taskId) {
      if (this.isParentTask(taskId)) {
        e.preventDefault();
        return;
      }
      this._dragTaskId = taskId;
      this._taskWasDragged = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', taskId);
      e.target.classList.add('dragging');
    },

    handleTaskDragEnd(e) {
      this._dragTaskId = null;
      e.target.classList.remove('dragging');
      document.querySelectorAll('.kanban-column-body.drag-over').forEach(el => el.classList.remove('drag-over'));
      this.clearTaskCardDropClasses();
    },

    handleTaskDragOver(e, targetState) {
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drag-over');
    },

    handleTaskDragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove('drag-over');
      }
    },

    clearTaskCardDropClasses() {
      if (typeof document === 'undefined') return;
      document.querySelectorAll('.kanban-card-drop-before, .kanban-card-drop-after').forEach((el) => {
        el.classList.remove('kanban-card-drop-before', 'kanban-card-drop-after');
      });
    },

    getTaskCardDropPosition(event) {
      const rect = event?.currentTarget?.getBoundingClientRect?.();
      if (!rect) return 'after';
      const midpoint = rect.top + (rect.height / 2);
      return event.clientY < midpoint ? 'before' : 'after';
    },

    handleTaskCardDragOver(event, targetState) {
      if (!this._dragTaskId || targetState === 'summary') return;
      event.dataTransfer.dropEffect = 'move';
      this.clearTaskCardDropClasses();
      const position = this.getTaskCardDropPosition(event);
      event.currentTarget.classList.add(position === 'before' ? 'kanban-card-drop-before' : 'kanban-card-drop-after');
    },

    handleTaskCardDragLeave(event) {
      event.currentTarget.classList.remove('kanban-card-drop-before', 'kanban-card-drop-after');
    },

    getTaskColumnTasksForReorder(targetState) {
      const column = this.boardColumns.find((candidate) => candidate.state === targetState);
      return column?.tasks || [];
    },

    calculateTaskBoardOrderForDrop(taskId, targetState, targetTaskId = null, position = 'end') {
      return calculateTaskBoardOrderForInsertion(this.getTaskColumnTasksForReorder(targetState), {
        taskId,
        targetTaskId,
        position,
      });
    },

    async handleTaskDrop(e, targetState, targetTaskId = null, position = 'end') {
      e.currentTarget.classList.remove('drag-over');
      this.clearTaskCardDropClasses();
      if (targetState === 'summary') return;
      const taskId = getTaskDropRecordId(e, this._dragTaskId);
      if (!taskId) return;
      const task = this.tasks.find(t => t.record_id === taskId);
      if (!task) return;
      if (this.isParentTask(taskId)) return;
      if (taskId === targetTaskId && task.state === targetState) return;

      if (!this.taskSortIsManual) {
        if (task.state === targetState) return;
        await this.applyTaskPatch(taskId, { state: targetState }, {
          silent: true,
          sync: true,
          backgroundPg: isTowerPgBackendMode(),
          intent: 'move',
          refresh: isTowerPgBackendMode(),
        });
        return;
      }

      const reorderPatches = buildTaskBoardReorderPatches(this.getTaskColumnTasksForReorder(targetState), {
        taskId,
        targetTaskId,
        position,
        targetState,
        draggedTask: task,
      });
      if (reorderPatches.length === 0) return;
      for (const { record_id, patch } of reorderPatches) {
        await this.applyTaskPatch(record_id, patch, { silent: true, sync: false, intent: 'move' });
      }
      const flushResult = await this.flushAndBackgroundSync();
      if ((flushResult?.pushed ?? 0) < reorderPatches.length && typeof this.forceSyncPendingWriteTargets === 'function') {
        await this.forceSyncPendingWriteTargets(reorderPatches.map(({ record_id }) => {
          const localTask = this.tasks.find((candidate) => candidate.record_id === record_id) || {};
          return {
            familyId: 'task',
            recordId: record_id,
            label: localTask.title || record_id,
          };
        }));
      }
    },

    isTaskSelected(taskId) {
      return this.selectedTaskIds.includes(taskId);
    },

    toggleTaskSelection(taskId) {
      if (!taskId || this.isParentTask(taskId)) return;
      if (this.isTaskSelected(taskId)) {
        this.selectedTaskIds = this.selectedTaskIds.filter((candidate) => candidate !== taskId);
      } else {
        this.selectedTaskIds = [...this.selectedTaskIds, taskId];
      }
    },

    selectVisibleTasks() {
      const visibleTaskIds = getSelectableColumnTaskIds(this.activeTasks, (taskId) => this.isParentTask(taskId));
      this.selectedTaskIds = [...new Set([...this.selectedTaskIds, ...visibleTaskIds])];
    },

    selectColumnTasks(columnState) {
      const col = this.boardColumns.find((c) => c.state === columnState)
        || this.listGroupedTasks.find((g) => g.state === columnState);
      if (!col) return;
      const colIds = getSelectableColumnTaskIds(col.tasks, (taskId) => this.isParentTask(taskId));
      this.selectedTaskIds = toggleColumnTaskSelection(this.selectedTaskIds, colIds);
    },

    clearSelectedTasks() {
      this.selectedTaskIds = [];
    },

    async applyBulkTaskAction(action) {
      if (this.bulkTaskBusy || this.selectedTaskIds.length === 0) return;
      const selectedIds = filterSelectableTaskIds(this.selectedTaskIds, (taskId) => this.isParentTask(taskId));
      if (selectedIds.length !== this.selectedTaskIds.length) {
        this.selectedTaskIds = selectedIds;
      }
      if (selectedIds.length === 0) {
        this.error = 'Summary tasks cannot be bulk changed. Select the child task cards instead.';
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const patchForAction = (taskId) => {
        switch (action) {
          case 'archive':
            return { state: 'archive', assigned_to_npubs: [] };
          case 'done':
            return { state: 'done', assigned_to_npubs: [] };
          case 'blocked':
            return { state: 'blocked' };
          case 'ready':
            return { state: 'ready', assigned_to_npubs: this.defaultAgentNpub ? [this.defaultAgentNpub] : [] };
          case 'today':
            return { scheduled_for: today };
          default:
            return null;
        }
      };

      if (action === 'ready' && !this.defaultAgentNpub) {
        this.error = 'Set a default agent in Setup first.';
        return;
      }

      this.bulkTaskBusy = true;
      try {
        let failedCount = 0;
        for (const taskId of selectedIds) {
          const patch = patchForAction(taskId);
          if (!patch) continue;
          const updated = await this.applyTaskPatch(taskId, patch, {
            sync: false,
            intent: `bulk_${action}`,
            backgroundPg: isTowerPgBackendMode(),
            deferPgProcessing: isTowerPgBackendMode(),
          });
          if (!updated) failedCount += 1;
        }
        if (isTowerPgBackendMode() && failedCount < selectedIds.length) {
          this.schedulePgTaskWriteQueueProcessing();
        }
        if (!isTowerPgBackendMode()) await this.flushAndBackgroundSync();
        if (failedCount > 0) {
          this.error = `${failedCount} selected task${failedCount === 1 ? '' : 's'} could not be updated.`;
        } else if (isTowerPgBackendMode()) {
          this.error = '';
        } else {
          await this.refreshTasks();
        }
        if (failedCount === 0) this.clearSelectedTasks();
      } finally {
        this.bulkTaskBusy = false;
      }
    },

    handleTaskCardClick(taskId) {
      if (this._taskWasDragged) {
        this._taskWasDragged = false;
        return;
      }
      this.openTaskDetail(taskId);
    },

    getDirectoryMoveOptionBreadcrumb(directoryId = null) {
      if (!directoryId) return 'Root';
      const breadcrumbs = [];
      let cursor = this.directories.find((item) => item.record_id === directoryId && item.record_state !== 'deleted') || null;
      while (cursor) {
        breadcrumbs.unshift(cursor.title || 'Untitled folder');
        cursor = cursor.parent_directory_id
          ? (this.directories.find((item) => item.record_id === cursor.parent_directory_id && item.record_state !== 'deleted') || null)
          : null;
      }
      return breadcrumbs.join(' / ');
    },

    getDirectoryMoveOptionSortKey(directory) {
      return this.getDirectoryMoveOptionBreadcrumb(directory?.record_id || null).toLowerCase();
    },

    isDocSelected(recordId) {
      return this.selectedDocIds.includes(recordId);
    },

    setDocSelectionMode(enabled) {
      this.docSelectionMode = enabled === true;
      if (!this.docSelectionMode) this.selectedDocIds = [];
    },

    toggleDocSelectionMode() {
      this.setDocSelectionMode(!this.docSelectionMode);
    },

    toggleDocSelection(recordId) {
      if (!recordId) return;
      if (this.isDocSelected(recordId)) {
        this.selectedDocIds = this.selectedDocIds.filter((candidate) => candidate !== recordId);
      } else {
        this.selectedDocIds = [...this.selectedDocIds, recordId];
      }
    },

    selectVisibleDocs() {
      this.selectedDocIds = [...new Set([...this.selectedDocIds, ...this.visibleDocBrowserIds])];
    },

    clearSelectedDocs() {
      this.selectedDocIds = [];
    },

    openBulkDocScopeModal() {
      this.openDocScopeModal({
        type: 'bulk-documents',
        ids: this.selectedDocIds,
      });
    },

    closeDocMoveModal() {
      this.showDocMoveModal = false;
      this.docMoveRecordIds = [];
      this.docMoveDirectoryQuery = '';
      this.docMoveModalSubmitting = false;
    },

    openDocMoveModal(recordIds = []) {
      const nextIds = [...new Set((Array.isArray(recordIds) ? recordIds : []).filter(Boolean))];
      if (nextIds.length === 0) {
        this.error = 'Select at least one document first';
        return;
      }
      this.docMoveRecordIds = nextIds;
      this.docMoveDirectoryQuery = '';
      this.docMoveModalSubmitting = false;
      this.showDocMoveModal = true;
    },

    canMoveActiveDocsToFolder(targetFolderId = null) {
      const items = this.activeDocMoveItems;
      if (items.length === 0) return false;
      return items.some((item) => (item.parent_directory_id ?? null) !== (targetFolderId ?? null));
    },

    async moveActiveDocsToFolder(targetFolderId = null) {
      if (this.docMoveModalSubmitting || !this.canMoveActiveDocsToFolder(targetFolderId)) return;
      this.docMoveModalSubmitting = true;
      const recordIds = this.activeDocMoveItems.map((item) => item.record_id);
      try {
        for (const recordId of recordIds) {
          await this.moveDocItemToFolder('document', recordId, targetFolderId, {
            applyDefaultScope: true,
            sync: false,
            refresh: false,
          });
        }
        this.closeDocMoveModal();
        await this.flushAndBackgroundSync();
        if (!isTowerPgBackendMode()) {
          await this.refreshDirectories();
          await this.refreshDocuments();
        }
        this.clearSelectedDocs();
      } finally {
        this.docMoveModalSubmitting = false;
      }
    },

    async deleteDocumentsByIds(recordIds = [], options = {}) {
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub || !this.session?.npub) {
        this.error = 'Select a document first';
        return false;
      }
      const items = [...new Set(recordIds)]
        .map((recordId) => this.documents.find((item) => item.record_id === recordId && item.record_state !== 'deleted'))
        .filter(Boolean);
      if (items.length === 0) {
        this.error = 'Select a document first';
        return false;
      }

      if (typeof window !== 'undefined' && options.confirmMessage) {
        const confirmed = window.confirm(options.confirmMessage);
        if (!confirmed) return false;
      }

      if (isTowerPgBackendMode()) {
        for (const item of items) {
          const pending = {
            ...item,
            record_state: 'deleted',
            sync_status: 'pending',
            updated_at: new Date().toISOString(),
          };
          await upsertDocument(pending);
          this.patchDocumentLocal(pending);
          try {
            const deleted = await deleteTowerPgDocFromLocal(this, item);
            await upsertDocument({
              ...pending,
              ...deleted,
              record_state: 'deleted',
              sync_status: 'synced',
            });
          } catch (error) {
            await upsertDocument({
              ...pending,
              sync_status: 'failed',
              updated_at: new Date().toISOString(),
            });
            this.error = error?.message || 'Failed to delete PG document.';
            return false;
          }
        }
        if (items.some((item) => item.record_id === this.selectedDocId)) {
          this.selectedDocId = null;
          this.selectedDocType = null;
        }
        return true;
      }

      for (const item of items) {
        this.assertCanMutateLockManagedRecord(item, recordFamilyHash('document'));
        await this.ensureLockManagedCheckout(item, recordFamilyHash('document'), { intent: 'delete' });
        const shares = this.getEffectiveDocShares(item);
        const now = new Date().toISOString();
        const nextVersion = (item.version ?? 1) + 1;
        const updated = this.normalizeDocumentRowGroupRefs({
          ...item,
          shares,
          group_ids: this.getShareGroupIds(shares),
          record_state: 'deleted',
          sync_status: 'pending',
          version: nextVersion,
          updated_at: now,
        });
        await upsertDocument(updated);
        this.patchDocumentLocal(updated);
        await queueTowerPendingWrite(this, {
          record_id: item.record_id,
          record_family_hash: recordFamilyHash('document'),
          envelope: await this.buildManagedDocumentEnvelope({
            record_id: item.record_id,
            owner_npub: ownerNpub,
            title: item.title,
            content: item.content,
            parent_directory_id: item.parent_directory_id,
            scope_id: item.scope_id ?? null,
            scope_l1_id: item.scope_l1_id ?? null,
            scope_l2_id: item.scope_l2_id ?? null,
            scope_l3_id: item.scope_l3_id ?? null,
            scope_l4_id: item.scope_l4_id ?? null,
            scope_l5_id: item.scope_l5_id ?? null,
            scope_policy_group_ids: item.scope_policy_group_ids ?? null,
            shares,
            group_ids: updated.group_ids,
            version: nextVersion,
            previous_version: item.version ?? 1,
            record_state: 'deleted',
            signature_npub: this.signingNpub,
            write_group_ref: this.getPreferredRecordWriteGroup(updated),
          }, item, { intent: 'delete' }),
        });
      }

      if (items.some((item) => item.record_id === this.selectedDocId)) {
        this.selectedDocId = null;
        this.selectedDocType = null;
      }
      return true;
    },

    async applyBulkDocAction(action) {
      if (this.bulkDocBusy || this.selectedDocIds.length === 0) return;
      if (action === 'move') {
        this.openDocMoveModal(this.selectedDocIds);
        return;
      }
      if (action !== 'archive' && action !== 'delete') return;
      this.bulkDocBusy = true;
      try {
        if (action === 'archive') {
          const archived = await this.archiveDocumentsByIds(this.selectedDocIds, true);
          if (!archived) return;
          this.clearSelectedDocs();
          return;
        }
        const removed = await this.deleteDocumentsByIds(this.selectedDocIds, {
          confirmMessage: `Delete ${this.selectedDocIds.length} document${this.selectedDocIds.length === 1 ? '' : 's'}?`,
        });
        if (!removed) return;
        await this.flushAndBackgroundSync();
        if (!isTowerPgBackendMode()) {
          await this.refreshDirectories();
          await this.refreshDocuments();
        }
        this.clearSelectedDocs();
      } finally {
        this.bulkDocBusy = false;
      }
    },

    toggleTaskFilterTag(tag) {
      const idx = this.taskFilterTags.indexOf(tag);
      if (idx >= 0) {
        this.taskFilterTags = this.taskFilterTags.filter((_, i) => i !== idx);
      } else {
        this.taskFilterTags = [...this.taskFilterTags, tag];
      }
      this.startWorkspaceLiveQueries?.();
    },

    clearTaskFilters() {
      this.taskFilter = '';
      this.taskFilterTags = [];
      this.taskFilterState = '';
      this.taskFilterAssignee = null;
      this.taskTagCloudOpen = false;
      this.startWorkspaceLiveQueries?.();
    },

    toggleFilterToMe() {
      if (this.taskFilterAssignee) {
        this.taskFilterAssignee = null;
      } else {
        this.taskFilterAssignee = this.currentViewerNpub || null;
      }
      this.startWorkspaceLiveQueries?.();
    },

    async moveTaskToBoard(taskId, boardScopeId) {
      const task = this.tasks.find(t => t.record_id === taskId);
      if (!task || !this.session?.npub) return;
      if (isTowerPgBackendMode()) {
        this.error = 'Moving PG tasks between scopes/channels is not available yet.';
        return;
      }

      const assignment = this.buildTaskBoardAssignment(boardScopeId, task);
      if (!assignment.scope_id) return;
      const nextVersion = (task.version ?? 1) + 1;

      const updated = toRaw({
        ...task,
        ...assignment,
        version: nextVersion,
        sync_status: 'pending',
        updated_at: new Date().toISOString(),
      });

      await upsertTask(updated);
      this.tasks = this.tasks.map(t => t.record_id === taskId ? updated : t);

      if (this.editingTask?.record_id === taskId) {
        this.replaceEditingTaskFromRecord(updated, { force: true });
      }

      // Move subtasks along with parent
      const subtasks = this.tasks.filter(t => t.parent_task_id === taskId && t.record_state !== 'deleted');
      for (const sub of subtasks) {
        const subVersion = (sub.version ?? 1) + 1;
        const subUpdated = toRaw({
          ...sub,
          ...assignment,
          version: subVersion,
          sync_status: 'pending',
          updated_at: new Date().toISOString(),
        });
        await upsertTask(subUpdated);
        this.tasks = this.tasks.map(t => t.record_id === sub.record_id ? subUpdated : t);
        await this.queueTaskWrite(subUpdated, sub, { intent: 'move' });
      }

      await this.queueTaskWrite(updated, task, { intent: 'move' });
      await this.flushAndBackgroundSync();
      await this.refreshTasks();
    },

    // docs browser drag-drop

    handleDocBrowserRowClick(type, recordId) {
      if (this._docBrowserWasDragged) {
        this._docBrowserWasDragged = false;
        return;
      }
      if (this.docSelectionMode && type === 'document') {
        this.toggleDocSelection(recordId);
        return;
      }
      this.selectDocItem(type, recordId);
    },

    handleDocItemDragStart(event, type, recordId) {
      this._dragDocBrowserItem = {
        type,
        recordId,
        sourceParentId: type === 'directory'
          ? (this.directories.find((item) => item.record_id === recordId)?.parent_directory_id ?? null)
          : (this.documents.find((item) => item.record_id === recordId)?.parent_directory_id ?? null),
      };
      this._docBrowserWasDragged = true;
      this.docBrowserDropTarget = '';
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `${type}:${recordId}`);
      event.currentTarget.classList.add('dragging');
    },

    handleDocItemDragEnd(event) {
      this._dragDocBrowserItem = null;
      this.docBrowserDropTarget = '';
      event.currentTarget.classList.remove('dragging');
      setTimeout(() => {
        this._docBrowserWasDragged = false;
      }, 0);
    },

    canMoveDocItemToFolder(dragItem, targetFolderId) {
      if (!dragItem?.recordId || (dragItem.type !== 'document' && dragItem.type !== 'directory')) return false;
      if ((dragItem.sourceParentId ?? null) === (targetFolderId ?? null)) return false;
      if (dragItem.type !== 'directory') return true;
      if (dragItem.recordId === targetFolderId) return false;

      let cursor = targetFolderId;
      while (cursor) {
        if (cursor === dragItem.recordId) return false;
        const folder = this.directories.find((item) => item.record_id === cursor);
        cursor = folder?.parent_directory_id || null;
      }
      return true;
    },

    handleDocItemDragOver(event, targetFolderId, targetKey = '') {
      if (!this.canMoveDocItemToFolder(this._dragDocBrowserItem, targetFolderId)) return;
      event.dataTransfer.dropEffect = 'move';
      this.docBrowserDropTarget = targetKey;
    },

    handleDocItemDragLeave(event, targetKey = '') {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      if (this.docBrowserDropTarget === targetKey) {
        this.docBrowserDropTarget = '';
      }
    },

    async handleDocItemDrop(event, targetFolderId, targetKey = '') {
      if (this.docBrowserDropTarget === targetKey) {
        this.docBrowserDropTarget = '';
      }
      const dragItem = this._dragDocBrowserItem;
      if (!this.canMoveDocItemToFolder(dragItem, targetFolderId)) return;
      await this.maybeMoveDocItemToFolder(dragItem.type, dragItem.recordId, targetFolderId);
    },

    async maybeMoveDocItemToFolder(type, recordId, targetFolderId = null) {
      const targetDirectory = targetFolderId
        ? this.directories.find((entry) => entry.record_id === targetFolderId && entry.record_state !== 'deleted')
        : null;
      const defaultScopeAssignment = this.getDirectoryDefaultScopeAssignment(targetDirectory);
      const hasDefaultScope = Boolean(defaultScopeAssignment.scope_id);
      const item = type === 'directory'
        ? this.directories.find((entry) => entry.record_id === recordId)
        : this.documents.find((entry) => entry.record_id === recordId);
      if (
        hasDefaultScope
        && item
        && !this.hasSameScopeAssignment(item, defaultScopeAssignment)
      ) {
        this.docMoveScopePrompt = {
          type,
          recordId,
          targetFolderId,
          targetFolderTitle: targetDirectory?.title || 'this folder',
          scopeId: defaultScopeAssignment.scope_id,
        };
        return;
      }
      await this.moveDocItemToFolder(type, recordId, targetFolderId);
    },

    closeDocMoveScopePrompt() {
      this.docMoveScopePrompt = null;
    },

    async confirmDocMoveScopePrompt(applyDefaultScope) {
      const prompt = this.docMoveScopePrompt;
      if (!prompt) return;
      this.docMoveScopePrompt = null;
      await this.moveDocItemToFolder(prompt.type, prompt.recordId, prompt.targetFolderId, {
        applyDefaultScope: applyDefaultScope === true,
      });
    },

    async moveDocItemToFolder(type, recordId, targetFolderId = null, options = {}) {
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub || !this.session?.npub) {
        this.error = 'Sign in first';
        return;
      }

      const isDirectory = type === 'directory';
      const item = isDirectory
        ? this.directories.find((entry) => entry.record_id === recordId)
        : this.documents.find((entry) => entry.record_id === recordId);
      if (!item) return;
      this.assertCanMutateLockManagedRecord(item, recordFamilyHash(isDirectory ? 'directory' : 'document'));
      await this.ensureLockManagedCheckout(item, recordFamilyHash(isDirectory ? 'directory' : 'document'), { intent: 'move' });

      const explicitShares = this.getExplicitDocShares(item);
      const inheritedShares = targetFolderId ? this.getInheritedDirectoryShares(targetFolderId) : [];
      let shares = this.mergeDocShareLists(explicitShares, inheritedShares);
      const nextVersion = (item.version ?? 1) + 1;
      const scopeAssignment = options.applyDefaultScope === true
        ? this.getDirectoryDefaultScopeAssignment(targetFolderId)
        : this.getDirectoryDefaultScopeAssignment(item);
      if (!scopeAssignment.scope_id) {
        this.error = 'Select a scope before moving this item.';
        return;
      }
      if (scopeAssignment.scope_id) {
        const scope = this.scopesMap.get(scopeAssignment.scope_id);
        if (scope) {
          const scopeShares = this.buildScopeDefaultShares(this.getScopeShareGroupIds(scope));
          shares = this.mergeDocShareLists(shares, scopeShares);
        }
      }
      if (shares.length === 0) shares = this.getDefaultPrivateShares();
      const groupIds = this.getShareGroupIds(shares);
      const baseUpdated = {
        ...item,
        parent_directory_id: targetFolderId,
        ...scopeAssignment,
        shares,
        group_ids: groupIds,
        scope_policy_group_ids: scopeAssignment.scope_id
          ? this.getResolvedScopePolicyGroupIds(scopeAssignment.scope_id)
          : null,
        sync_status: 'pending',
        version: nextVersion,
        updated_at: new Date().toISOString(),
      };
      const updated = isDirectory
        ? this.normalizeDirectoryRowGroupRefs(baseUpdated)
        : this.normalizeDocumentRowGroupRefs(baseUpdated);

      if (isDirectory) {
        await upsertDirectory(updated);
        this.patchDirectoryLocal(updated);
      } else {
        await upsertDocument(updated);
        this.patchDocumentLocal(updated);
        if (this.selectedDocId === recordId) {
          this.currentFolderId = targetFolderId ?? null;
        }
      }

      const envelope = isDirectory
        ? await this.buildManagedDirectoryEnvelope({
          record_id: updated.record_id,
          owner_npub: ownerNpub,
          title: updated.title,
          parent_directory_id: updated.parent_directory_id,
          scope_id: updated.scope_id ?? null,
          scope_l1_id: updated.scope_l1_id ?? null,
          scope_l2_id: updated.scope_l2_id ?? null,
          scope_l3_id: updated.scope_l3_id ?? null,
          scope_l4_id: updated.scope_l4_id ?? null,
          scope_l5_id: updated.scope_l5_id ?? null,
          scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
          shares: updated.shares,
          group_ids: updated.group_ids,
          version: nextVersion,
          previous_version: item.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredRecordWriteGroup(updated),
        }, item, { intent: 'move' })
        : await this.buildManagedDocumentEnvelope({
          record_id: updated.record_id,
          owner_npub: ownerNpub,
          title: updated.title,
          content: updated.content,
          parent_directory_id: updated.parent_directory_id,
          scope_id: updated.scope_id ?? null,
          scope_l1_id: updated.scope_l1_id ?? null,
          scope_l2_id: updated.scope_l2_id ?? null,
          scope_l3_id: updated.scope_l3_id ?? null,
          scope_l4_id: updated.scope_l4_id ?? null,
          scope_l5_id: updated.scope_l5_id ?? null,
          scope_policy_group_ids: updated.scope_policy_group_ids ?? null,
          shares: updated.shares,
          group_ids: updated.group_ids,
          version: nextVersion,
          previous_version: item.version ?? 1,
          signature_npub: this.signingNpub,
          write_group_ref: this.getPreferredRecordWriteGroup(updated),
        }, item, { intent: 'move' });

      await queueTowerPendingWrite(this, {
        record_id: updated.record_id,
        record_family_hash: envelope.record_family_hash,
        envelope,
      });

      if (options.sync !== false) {
        await this.flushAndBackgroundSync();
      }
      if (options.refresh !== false) {
        await this.refreshDirectories();
        await this.refreshDocuments();
      }
    },

    // --- docs ---

    selectDocItem(type, recordId) {
      if (type === 'document') this.setDocSelectionMode(false);
      if (type === 'directory') {
        this.navigateToFolder(recordId);
        return;
      }
      this.openDoc(recordId);
    },

    navigateToFolder(folderId = null, options = {}) {
      this.stopDocCommentsLiveQuery();
      this.closeDocScopeModal();
      this.closeDocMoveScopePrompt();
      this.closeDocMoveModal();
      this.setDocSelectionMode(false);
      this.currentFolderId = folderId || null;
      this.selectedDocType = null;
      this.selectedDocId = null;
      this.selectedDocCommentId = null;
      this.navSection = 'docs';
      this.mobileNavOpen = false;
      this.startWorkspaceLiveQueries();
      this.loadDocEditorFromSelection();
      if (options.syncRoute !== false) this.syncRoute();
    },

    navigateUpFolder() {
      if (!this.currentFolderId) return;
      const currentFolder = this.directories.find((item) => item.record_id === this.currentFolderId);
      this.navigateToFolder(currentFolder?.parent_directory_id || null);
    },

    // --- Document management (extracted to docs-manager.js) ---
    // docsManagerMixin applied via applyMixins

    // --- @mentions ---

    getMentionDocuments() {
      const byId = new Map();
      const add = (doc) => {
        const recordId = String(doc?.record_id || '').trim();
        if (!recordId || doc?.record_state === 'deleted') return;
        byId.set(recordId, doc);
      };
      for (const doc of (this.mentionDocumentIndex || [])) add(doc);
      for (const doc of (this.documents || [])) add(doc);
      return Array.from(byId.values());
    },

    getRecentMentionChips(composer = 'message', limit = 8) {
      const draft = composer === 'thread' ? this.threadInput : this.messageInput;
      let resolver = RECENT_ACTOR_MENTION_RESOLVERS.get(this);
      if (!resolver) {
        resolver = createRecentActorMentionResolver();
        RECENT_ACTOR_MENTION_RESOLVERS.set(this, resolver);
      }
      return resolver({
        sourceReferences: [
          this.currentWorkspaceKey,
          this.selectedChannelId,
          this.activeThreadId,
          this.activeWorkroomId,
          this.currentPgActorNpub,
          this.session?.npub,
          this.messages,
          this.messageCollectionRevision,
          this.threadReplies,
          this.channels,
          this.groups,
          this.pgWorkspaceMembers,
          this.addressBookPeople,
          this.workroomParticipants,
          this.channelGrants,
          this.chatProfiles,
          this._wsKeyDisplayMap,
        ],
        messages: this.messages,
        threadId: this.activeThreadId,
        currentUserNpub: this.currentPgActorNpub || this.session?.npub,
        draft,
        draftMentions: this.selectedAgentMentionsByComposer?.[composer] || [],
        limit,
        buildMentionPeople: () => this.getMentionPeople({ visibleOnly: true }),
        resolveAvatar: (person) => this.getSenderAvatar?.(person.id),
      });
    },

    insertRecentMention(composer, person, event = null, trailingText = '') {
      const inputBar = event?.currentTarget?.closest?.('.chat-input-bar, .thread-input-bar, .workroom-thread-composer');
      const el = inputBar?.querySelector?.(`[data-chat-composer="${composer}"]`)
        || document.querySelector(`[data-chat-composer="${composer}"]`);
      if (!el || !person?.id) return;
      insertMentionAtComposerSelection(el, {
        type: person.type,
        npub: person.id,
        label: person.label,
      }, trailingText);
      this.syncMentionComposerModel(el);
      this.closeMentionPopover();
    },

    patchMentionDocumentIndex(nextDocument) {
      const recordId = String(nextDocument?.record_id || '').trim();
      if (!recordId) return;
      const current = Array.isArray(this.mentionDocumentIndex) ? this.mentionDocumentIndex : [];
      if (nextDocument?.record_state === 'deleted') {
        this.mentionDocumentIndex = current.filter((doc) => doc?.record_id !== recordId);
        return;
      }
      const index = current.findIndex((doc) => doc?.record_id === recordId);
      if (index >= 0) {
        this.mentionDocumentIndex = current.map((doc, itemIndex) => (
          itemIndex === index ? { ...doc, ...nextDocument } : doc
        ));
        return;
      }
      this.mentionDocumentIndex = [...current, nextDocument];
    },

    async refreshMentionDocumentIndex() {
      const ownerNpub = this.workspaceOwnerNpub;
      if (!ownerNpub) return [];
      if (this._mentionDocumentIndexOwnerNpub !== ownerNpub) {
        this.mentionDocumentIndex = [];
        this._mentionDocumentIndexOwnerNpub = ownerNpub;
        this._mentionDocumentIndexLoaded = false;
        this._mentionDocumentIndexLoadedAt = 0;
        this._mentionDocumentIndexRefreshPromise = null;
      }
      if (
        this._mentionDocumentIndexLoaded
        && Date.now() - Number(this._mentionDocumentIndexLoadedAt || 0) < MENTION_DOCUMENT_INDEX_MAX_AGE_MS
      ) return this.mentionDocumentIndex || [];
      if (this._mentionDocumentIndexRefreshPromise) return this._mentionDocumentIndexRefreshPromise;
      const refreshPromise = getDocumentsByOwner(ownerNpub)
        .then((documents = []) => {
          if (this._mentionDocumentIndexOwnerNpub !== ownerNpub) return this.mentionDocumentIndex || [];
          this.mentionDocumentIndex = Array.isArray(documents)
            ? documents
                .map((item) => this.normalizeDocumentRowGroupRefs ? this.normalizeDocumentRowGroupRefs(item) : item)
                .filter((doc) => doc?.record_id && doc?.record_state !== 'deleted')
            : [];
          this._mentionDocumentIndexLoaded = true;
          this._mentionDocumentIndexLoadedAt = Date.now();
          return this.mentionDocumentIndex;
        })
        .catch((error) => {
          console.warn('[mentions] failed to refresh local document index', error);
          if (this._mentionDocumentIndexOwnerNpub === ownerNpub) {
            this._mentionDocumentIndexLoaded = true;
            this._mentionDocumentIndexLoadedAt = Date.now();
          }
          return this.mentionDocumentIndex || [];
        })
        .finally(() => {
          if (this._mentionDocumentIndexRefreshPromise === refreshPromise) {
            this._mentionDocumentIndexRefreshPromise = null;
          }
        });
      this._mentionDocumentIndexRefreshPromise = refreshPromise;
      return refreshPromise;
    },

    refreshActiveMentionResults() {
      if (!this.mentionActive || !this._mentionTargetEl) return;
      const options = {
        visibleOnly: this._mentionTargetEl.dataset?.workroomComposer === 'true'
          || this._mentionTargetEl.dataset?.channelVisibleMentions === 'true',
      };
      this.mentionResults = this.mentionQuery.length === 0
        ? this.getDefaultMentionResults(8, options)
        : this.searchMentions(this.mentionQuery, options);
      this.mentionSelectedIndex = 0;
    },

    refreshMentionResultsFromLocalIndex(query, targetEl) {
      if (this.currentWorkspace?.pgBackendMode || this.pgBackendMode) void this.ensureChatMentionRoster();
      const normalizedQuery = String(query || '');
      const previousDocumentIndex = this.mentionDocumentIndex;
      const mentionOptions = {
        visibleOnly: targetEl?.dataset?.workroomComposer === 'true'
          || targetEl?.dataset?.channelVisibleMentions === 'true',
      };
      this.refreshMentionDocumentIndex()
        .then(() => {
          if (!this.mentionActive || this._mentionTargetEl !== targetEl || this.mentionQuery !== normalizedQuery) return;
          if (this.mentionDocumentIndex === previousDocumentIndex) return;
          this.mentionResults = normalizedQuery.length === 0
            ? this.getDefaultMentionResults(8, mentionOptions)
            : this.searchMentions(normalizedQuery, mentionOptions);
          this.mentionSelectedIndex = 0;
        });
    },

    getMentionPeople({ visibleOnly = false, channelId = this.selectedChannelId } = {}) {
      const cacheKey = `${visibleOnly ? 'visible' : 'all'}:${String(channelId || '').trim()}`;
      const sourceReferences = [
        this.currentWorkspaceKey,
        this.workspaceOwnerNpub,
        this.activeWorkroomId,
        this.currentPgActorNpub,
        this.session?.npub,
        this.messages,
        this.threadReplies,
        this.channels,
        this.groups,
        this.pgWorkspaceMembers,
        this.addressBookPeople,
        this.workroomParticipants,
        this.channelGrants,
        this.channelGrantsChannelId,
        this.chatProfiles,
        this._wsKeyDisplayMap,
      ];
      const cached = MENTION_PEOPLE_CACHE.get(this);
      if (
        cached?.key === cacheKey
        && cached.sourceReferences.length === sourceReferences.length
        && sourceReferences.every((value, index) => Object.is(value, cached.sourceReferences[index]))
      ) return cached.people;

      const people = this.buildMentionPeople({ visibleOnly, channelId });
      MENTION_PEOPLE_CACHE.set(this, {
        key: cacheKey,
        sourceReferences: [...sourceReferences],
        people,
      });
      return people;
    },

    buildMentionPeople({ visibleOnly = false, channelId = this.selectedChannelId } = {}) {
      const byNpub = new Map();
      const channel = (this.channels || []).find((row) => row?.record_id === channelId);
      const currentWorkspaceActorNpubs = new Set((this.pgWorkspaceMembers || [])
        .map((member) => String(member?.npub || member?.actor?.npub || '').trim())
        .filter(Boolean));
      const hasCurrentWorkspaceActorRoster = currentWorkspaceActorNpubs.size > 0
        || Boolean(this.currentWorkspace?.pgBackendMode || this.pgBackendMode);
      const authoritativeIntegrationNpubs = new Set();
      const workspaceAgentNpubs = new Set();
      const durableLabels = new Map();
      const rememberLabel = (npub, label) => {
        const cleanNpub = String(npub || '').trim();
        const cleanLabel = String(label || '').trim();
        if (!cleanNpub || !cleanLabel || cleanLabel === cleanNpub || durableLabels.has(cleanNpub)) return;
        durableLabels.set(cleanNpub, cleanLabel);
      };
      for (const member of (this.pgWorkspaceMembers || [])) {
        rememberLabel(member?.npub || member?.user_npub || member?.member_npub, member?.display_name || member?.label || member?.name);
      }
      for (const person of (this.addressBookPeople || [])) rememberLabel(person?.npub, person?.label || person?.name);
      for (const message of [...(this.messages || []), ...(this.threadReplies || [])]) {
        const mentions = message?.pg_metadata?.mentions || message?.metadata?.mentions;
        for (const mention of (Array.isArray(mentions) ? mentions : [])) rememberLabel(mention?.npub, mention?.label);
      }
      for (const candidate of (this.channels || [])) {
        if (!isDmChannel(candidate)) continue;
        const participants = typeof this.getChannelParticipants === 'function'
          ? this.getChannelParticipants(candidate)
          : resolveChannelParticipants(candidate);
        const label = this.getChannelLabel?.(candidate) || candidate?.title || candidate?.name;
        for (const npub of (participants || [])) {
          const cleanNpub = String(npub || '').trim();
          const cleanLabel = String(label || '').trim();
          // An npub-derived DM title is an identifier, not a durable alias.
          if (cleanNpub && !cleanLabel.includes(cleanNpub)) rememberLabel(cleanNpub, cleanLabel);
        }
      }
      const add = (npub, fallbackLabel = '', sublabel = '', kind = 'human', preferFallbackLabel = false) => {
        const clean = String(npub || '').trim();
        if (!clean) return;
        // Tower's current workspace actor roster is authoritative for typed PG
        // mentions. Historical messages, DMs, groups, workrooms, and the local
        // address book can retain a retired identity for display, but it must
        // not become selectable after the actor has rotated to a new npub.
        if (hasCurrentWorkspaceActorRoster && !currentWorkspaceActorNpubs.has(clean)) return;
        const senderLabel = String(this.getSenderName?.(clean) || '').trim();
        const fallback = String(fallbackLabel || '').trim() || durableLabels.get(clean) || '';
        const label = (preferFallbackLabel ? fallback : '')
          || (senderLabel && senderLabel !== clean ? senderLabel : '')
          || fallback
          || clean;
        const type = String(kind || '').toLowerCase() === 'agent' ? 'agent' : 'person';
        const existing = byNpub.get(clean);
        if (existing && existing.type === 'agent') {
          // A profile or participant row may carry a useful display label even
          // when the authoritative agent source only knew the npub. Enrich the
          // existing result while retaining its agent classification.
          if (existing.label === clean && label !== clean) {
            byNpub.set(clean, { ...existing, label, sublabel: existing.sublabel || sublabel });
          }
          return;
        }
        if (existing && type !== 'agent') return;
        byNpub.set(clean, { type, id: clean, label, sublabel });
      };

      const mentionGroups = [
        ...(Array.isArray(this.currentWorkspaceGroups) ? this.currentWorkspaceGroups : []),
        ...(Array.isArray(this.groups) ? this.groups : []),
      ];
      for (const group of mentionGroups) {
        const groupIdentity = String(group?.name || group?.label || group?.group_kind || '')
          .toLowerCase().replace(/[^a-z0-9]/g, '');
        const groupActorKind = ['agent', 'agents', 'aiagent', 'aiagents', 'wingmen'].includes(groupIdentity)
          ? 'agent'
          : 'human';
        for (const npub of (group?.effective_member_npubs || group?.member_npubs || [])) {
          if (groupActorKind === 'agent') workspaceAgentNpubs.add(String(npub || '').trim());
        }
      }
      for (const npub of workspaceAgentNpubs) {
        add(npub, durableLabels.get(npub), 'Agent', 'agent', true);
      }
      for (const member of (this.pgWorkspaceMembers || [])) {
        const kind = member?.kind || member?.actor_kind || member?.actor?.kind;
        if (String(kind || '').toLowerCase() === 'agent') {
          workspaceAgentNpubs.add(String(member?.npub || member?.user_npub || member?.member_npub || '').trim());
        }
        add(
          member?.npub || member?.user_npub || member?.member_npub,
          member?.display_name || member?.label || member?.name,
          String(kind || '').toLowerCase() === 'agent' ? 'Agent' : 'User',
          kind,
          true,
        );
      }
      // The channel's workroom integration configuration is authoritative for
      // channel visibility. The People directory supplies identity and labels.
      const workroomDefaults = channel?.metadata?.workroom_defaults;
      if (workroomDefaults && typeof workroomDefaults === 'object') {
        const integrationNpubs = new Set([
          workroomDefaults.integration_autopilot_npub,
          channel?.metadata?.integration_autopilot_npub,
        ].map((value) => String(value || '').trim()).filter(Boolean));
        for (const participant of (Array.isArray(workroomDefaults.participants) ? workroomDefaults.participants : [])) {
          const role = String(participant?.role || '').toLowerCase();
          const kind = String(participant?.kind || '').toLowerCase();
          if (role !== 'integration' && !['agent', 'autopilot'].includes(kind)) continue;
          const npub = String(participant?.actor_npub || participant?.npub || participant?.actor?.npub || '').trim();
          if (npub) integrationNpubs.add(npub);
        }
        for (const npub of integrationNpubs) {
          authoritativeIntegrationNpubs.add(npub);
        }
      }
      for (const participant of (this.workroomParticipants || [])) {
        add(participant?.actor_npub, participant?.label, participant?.role ? `Workroom ${participant.role}` : 'Workroom participant');
      }
      // Channel access contributes visibility only. Mention identity and
      // labels remain sourced from the People directory.
      const channelAgentGrants = (this.channelGrantRows || this.channelGrants || [])
        .flatMap((grant) => Array.isArray(grant?.grants) && grant.grants.length > 0 ? grant.grants : [grant]);
      for (const person of (this.addressBookPeople || [])) {
        add(person?.npub, person?.label || person?.name, 'Person');
      }

      if (!visibleOnly) return Array.from(byNpub.values());

      if (!channel) return Array.from(byNpub.values());
      const visibleNpubs = new Set(workroomVisibleParticipantNpubs(channel, {
        baseParticipants: typeof this.getChannelParticipants === 'function'
          ? this.getChannelParticipants(channel)
          : [],
        groups: [
          ...(Array.isArray(this.currentWorkspaceGroups) ? this.currentWorkspaceGroups : []),
          ...(Array.isArray(this.groups) ? this.groups : []),
        ],
        channelGrants: typeof this.getSelectedChannelGrantRows === 'function'
          ? this.getSelectedChannelGrantRows(channelId)
          : (this.channelGrantRows || this.channelGrants || []),
        workspaceMembers: this.pgWorkspaceMembers,
        sessionNpub: this.session?.npub,
        currentViewerNpub: this.currentPgActorNpub,
      }));
      // The selected channel explicitly names these integration agents. Keep
      // them mentionable even before grants/groups finish hydrating; this does
      // not admit unrelated workspace agents.
      for (const npub of authoritativeIntegrationNpubs) visibleNpubs.add(npub);
      // Agent Direct Chat is universal across channels. Legacy persisted false
      // values must not hide otherwise available workspace agents.
      for (const npub of workspaceAgentNpubs) if (npub) visibleNpubs.add(npub);
      for (const grant of channelAgentGrants) {
        const capacity = String(grant?.capacity || grant?.access_level || '').toLowerCase();
        const kind = String(grant?.principal?.kind || grant?.principal_actor_kind || '').toLowerCase();
        if (capacity !== 'agent' && kind !== 'agent') continue;
        const npub = String(
          grant?.principal_npub || grant?.actor_npub || grant?.npub || grant?.principal?.npub || '',
        ).trim();
        if (npub) visibleNpubs.add(npub);
      }
      for (const participant of (this.workroomParticipants || [])) {
        if (!this.activeWorkroomId || participant?.workroom_id === this.activeWorkroomId) {
          const npub = String(participant?.actor_npub || '').trim();
          if (npub) visibleNpubs.add(npub);
        }
      }
      return Array.from(byNpub.values()).filter((person) => visibleNpubs.has(person.id));
    },

    searchMentions(rawQuery, options = {}) {
      if (!rawQuery) return [];

      // Parse type prefix: @scope:, @task:, @doc:, @channel:
      let typeFilter = null;
      let query = rawQuery;
      const prefixMatch = rawQuery.match(/^(scope|task|doc|person|agent|flow|opportunity|channel|chat):/i);
      if (prefixMatch) {
        typeFilter = prefixMatch[1].toLowerCase() === 'chat' ? 'channel' : prefixMatch[1].toLowerCase();
        query = rawQuery.slice(prefixMatch[0].length);
      }

      const needle = query.toLowerCase();
      const results = [];
      const limit = typeFilter === 'channel' ? Number.MAX_SAFE_INTEGER : 10;

      // People from groups
      if (!typeFilter || typeFilter === 'person' || typeFilter === 'agent') {
        for (const person of this.getMentionPeople(options)) {
          if (typeFilter === 'agent' && person.type !== 'agent') continue;
          if (
            !needle
            || person.label.toLowerCase().includes(needle)
            || person.id.toLowerCase().includes(needle)
            || String(person.sublabel || '').toLowerCase().includes(needle)
          ) {
            results.push(person);
          }
        }
      }

      // Documents
      if (!typeFilter || typeFilter === 'doc') {
        for (const doc of this.getMentionDocuments()) {
          if (doc.record_state === 'deleted') continue;
          if (!needle || (doc.title || '').toLowerCase().includes(needle)) {
            results.push({ type: 'doc', id: doc.record_id, label: doc.title || 'Untitled', sublabel: 'Doc' });
          }
        }
      }

      // Tasks
      if (!typeFilter || typeFilter === 'task') {
        for (const task of this.tasks) {
          if (task.record_state === 'deleted') continue;
          if (!needle || (task.title || '').toLowerCase().includes(needle)) {
            results.push({ type: 'task', id: task.record_id, label: task.title || 'Untitled', sublabel: 'Task' });
          }
        }
      }

      // Channels
      if (!typeFilter || typeFilter === 'channel') {
        for (const channel of this.channels) {
          if (channel.record_state === 'deleted') continue;
          const label = this.getChannelLabel?.(channel) || channel.title || channel.name || 'Untitled';
          if (
            !needle
            || label.toLowerCase().includes(needle)
            || String(channel.title || '').toLowerCase().includes(needle)
            || String(channel.name || '').toLowerCase().includes(needle)
          ) {
            results.push({ type: 'channel', id: channel.record_id, label, sublabel: 'Channel' });
          }
        }
      }

      // Scopes (products, projects, deliverables)
      if (!typeFilter || typeFilter === 'scope') {
        for (const scope of this.scopes) {
          if (scope.record_state === 'deleted') continue;
          if (!needle || (scope.title || '').toLowerCase().includes(needle)) {
            const levelLabel = scope.level === 'product' ? 'Product' : scope.level === 'project' ? 'Project' : 'Deliverable';
            results.push({ type: 'scope', id: scope.record_id, label: scope.title || 'Untitled', sublabel: levelLabel });
          }
        }
      }

      // Flows
      if (!typeFilter || typeFilter === 'flow') {
        for (const flow of this.flows) {
          if (flow.record_state === 'deleted') continue;
          if (!needle || (flow.title || '').toLowerCase().includes(needle)) {
            results.push({ type: 'flow', id: flow.record_id, label: flow.title || 'Untitled', sublabel: 'Flow' });
          }
        }
      }

      if (!typeFilter || typeFilter === 'opportunity') {
        for (const opportunity of this.opportunities) {
          if (opportunity.record_state === 'deleted') continue;
          if (
            !needle
            || String(opportunity.title || '').toLowerCase().includes(needle)
            || String(opportunity.opportunity_type || '').toLowerCase().includes(needle)
          ) {
            results.push({
              type: 'opportunity',
              id: opportunity.record_id,
              label: opportunity.title || 'Untitled',
              sublabel: 'Opportunity',
            });
          }
        }
      }

      // A deliberately selected actor is the natural target of an unqualified
      // @name. Keep explicit type-prefix ordering intact, but ensure an exact
      // person/agent match outranks a same-labelled channel.
      if (!typeFilter) {
        results.sort((left, right) => {
          const leftActor = left.type === 'agent' || left.type === 'person';
          const rightActor = right.type === 'agent' || right.type === 'person';
          const leftExactActor = leftActor && left.label.toLowerCase() === needle;
          const rightExactActor = rightActor && right.label.toLowerCase() === needle;
          if (leftExactActor !== rightExactActor) return leftExactActor ? -1 : 1;
          if (leftActor && right.type === 'channel') return -1;
          if (left.type === 'channel' && rightActor) return 1;
          return 0;
        });
      }
      return results.slice(0, limit);
    },

    getDefaultMentionResults(limit = 8, options = {}) {
      const results = [];
      const seen = new Set();
      const add = (result) => {
        const key = `${result?.type || ''}:${result?.id || ''}`;
        if (!result?.id || seen.has(key) || results.length >= limit) return;
        seen.add(key);
        results.push(result);
      };

      for (const person of this.getMentionPeople(options)) {
        add(person);
        if (results.length >= 2) break;
      }

      const recentDocs = [...this.getMentionDocuments()]
        .filter((doc) => doc.record_state !== 'deleted')
        .sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      for (const doc of recentDocs.slice(0, 3)) {
        add({ type: 'doc', id: doc.record_id, label: doc.title || 'Untitled', sublabel: 'Doc' });
      }

      const recentTasks = [...(this.tasks || [])]
        .filter((task) => task.record_state !== 'deleted')
        .sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      for (const task of recentTasks.slice(0, 2)) {
        add({ type: 'task', id: task.record_id, label: task.title || 'Untitled', sublabel: 'Task' });
      }

      const recentChannels = [...(this.channels || [])]
        .filter((channel) => channel.record_state !== 'deleted')
        .sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      for (const channel of recentChannels.slice(0, 2)) {
        add({
          type: 'channel',
          id: channel.record_id,
          label: this.getChannelLabel?.(channel) || channel.title || channel.name || 'Untitled',
          sublabel: 'Channel',
        });
      }

      for (const scope of (this.scopes || []).filter((scope) => scope.record_state !== 'deleted').slice(0, 2)) {
        const levelLabel = scope.level === 'product' ? 'Product' : scope.level === 'project' ? 'Project' : 'Deliverable';
        add({ type: 'scope', id: scope.record_id, label: scope.title || 'Untitled', sublabel: levelLabel });
      }

      if (results.length < limit) {
        for (const flow of (this.flows || []).filter((flow) => flow.record_state !== 'deleted').slice(0, 2)) {
          add({ type: 'flow', id: flow.record_id, label: flow.title || 'Untitled', sublabel: 'Flow' });
        }
      }

      return results;
    },

    handleMentionInput(el, event = null) {
      const contentEditable = el?.isContentEditable || el?.getAttribute?.('contenteditable') === 'true';
      const value = contentEditable ? '' : el.value;
      const continuingQuery = this.mentionActive && this._mentionTargetEl === el;
      if (
        contentEditable
        && event
        && !continuingQuery
        && event.inputType === 'insertText'
        && !String(event.data || '').includes('@')
      ) {
        this.closeMentionPopover();
        return;
      }
      // Contenteditable detection walks only the editable DOM up to the caret;
      // it does not clone the growing composer or cross an atomic mention pill.
      if ((!contentEditable && !value.includes('@')) || (contentEditable && !event && !String(el.textContent || '').includes('@'))) {
        this.closeMentionPopover();
        return;
      }
      const activeQuery = contentEditable ? composerMentionQueryAtSelection(el) : null;
      const cursorPos = contentEditable ? activeQuery?.end : el.selectionStart;

      // Find the @ that starts the current mention (allow spaces in query, break on newline).
      // A rendered mention pill is a boundary, not another editable @ trigger.
      let atPos = contentEditable ? activeQuery?.start ?? -1 : -1;
      if (!contentEditable) {
        for (let i = cursorPos - 1; i >= 0; i--) {
          const ch = value[i];
          if (ch === '\n' || ch === '\r') break;
          if (ch === '@') {
            // Only trigger if @ is at start of input or preceded by whitespace
            if (i === 0 || /\s/.test(value[i - 1])) {
              atPos = i;
            }
            break;
          }
        }
      }

      if (atPos === -1) {
        this.closeMentionPopover();
        return;
      }

      const query = contentEditable ? activeQuery.query : value.slice(atPos + 1, cursorPos);
      const mentionOptions = {
        visibleOnly: el.dataset.workroomComposer === 'true' || el.dataset.channelVisibleMentions === 'true',
      };
      if (query.length === 0) {
        // Show all results on bare @
        this.mentionActive = true;
        this._mentionTargetEl = el;
        this._mentionStartPos = atPos;
        this._mentionEndPos = cursorPos;
        this.mentionQuery = '';
        this.mentionResults = this.getDefaultMentionResults(8, mentionOptions);
        this.mentionSelectedIndex = 0;
        this.refreshMentionResultsFromLocalIndex('', el);
        return;
      }

      this.mentionActive = true;
      this._mentionTargetEl = el;
      this._mentionStartPos = atPos;
      this._mentionEndPos = cursorPos;
      this.mentionQuery = query;
      this.mentionResults = this.searchMentions(query, mentionOptions);
      this.mentionSelectedIndex = 0;
      this.refreshMentionResultsFromLocalIndex(query, el);
    },

    handleMentionKeydown(event) {
      if (event.isComposing || !this.mentionActive) return;

      const el = event.currentTarget;
      const contentEditable = el?.isContentEditable || el?.getAttribute?.('contenteditable') === 'true';
      const selection = contentEditable ? el?.ownerDocument?.getSelection?.() : null;
      const selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const caretPos = contentEditable ? composerCaretOffset(el) : el?.selectionEnd;
      const selectionIsCollapsed = contentEditable
        ? (!selectionRange || selectionRange.collapsed)
        : el?.selectionStart === el?.selectionEnd;

      // The mention popover is global and input events do not fire when the
      // user moves the caret or focuses another composer. Do not let stale
      // autocomplete state consume native multiline caret navigation.
      if (el !== this._mentionTargetEl || !selectionIsCollapsed || caretPos !== this._mentionEndPos) {
        this.closeMentionPopover();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.mentionSelectedIndex = Math.min(this.mentionSelectedIndex + 1, this.mentionResults.length - 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.mentionSelectedIndex = Math.max(this.mentionSelectedIndex - 1, 0);
      } else if (event.key === 'Enter' && this.mentionResults.length > 0) {
        event.preventDefault();
        this.selectMention(this.mentionResults[this.mentionSelectedIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeMentionPopover();
      }
    },

    handleComposerKeydown(event, sendAction) {
      if (event.isComposing) return;
      this.handleMentionKeydown(event);
      if (!event.defaultPrevented && ['Backspace', 'Delete'].includes(event.key)
        && (event.currentTarget?.isContentEditable || event.currentTarget?.getAttribute?.('contenteditable') === 'true')
        && removeAdjacentMentionPill(event.currentTarget, event.key === 'Backspace' ? 'backward' : 'forward')) {
        event.preventDefault();
        this.syncMentionComposerModel(event.currentTarget);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented) {
        event.preventDefault();
        sendAction();
      }
    },

    selectMention(result) {
      const el = this._mentionTargetEl;
      if (!el || this._mentionStartPos < 0 || this._mentionEndPos < this._mentionStartPos) return;

      const richEditor = this.taskRichDescriptionAdapter?.getEditor();
      if (richEditor?.view.dom === el) {
        const to = richEditor.state.selection.from;
        const from = to - this.mentionQuery.length - 1;
        richEditor.chain().focus().insertContentAt({ from, to }, [
          { type: 'text', text: result.label, marks: [{
            type: 'fdMention', attrs: { mentionType: result.type, mentionId: result.id, label: result.label },
          }] },
          { type: 'text', text: ' ' },
        ]).run();
        this.closeMentionPopover();
        return;
      }
      const contentEditable = el?.isContentEditable || el?.getAttribute?.('contenteditable') === 'true';
      if (contentEditable) {
        const pill = createMentionPill(el.ownerDocument, {
          type: result.type,
          npub: result.id,
          label: result.label,
        });
        replaceComposerTextRange(el, this._mentionStartPos, this._mentionEndPos, [pill, ' ']);
        this.syncMentionComposerModel(el);
        el.focus();
        this.closeMentionPopover();
        return;
      }

      const value = el.value;
      const before = value.slice(0, this._mentionStartPos);
      const after = value.slice(this._mentionEndPos);
      const tag = `@[${result.label}](mention:${result.type}:${result.id}) `;
      const newValue = before + tag + after;

      // Update the textarea value through Alpine's model
      el.value = newValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));

      const composer = String(el.dataset?.chatComposer || '').trim();
      if (['agent', 'person'].includes(result.type) && ['message', 'thread'].includes(composer)) {
        const current = Array.isArray(this.selectedAgentMentionsByComposer?.[composer])
          ? this.selectedAgentMentionsByComposer[composer]
          : [];
        const mention = { type: result.type, npub: result.id, label: result.label };
        this.selectedAgentMentionsByComposer = {
          ...(this.selectedAgentMentionsByComposer || {}),
          [composer]: [...current.filter((item) => item.npub !== mention.npub), mention],
        };
      }

      const newCursorPos = before.length + tag.length;
      el.setSelectionRange(newCursorPos, newCursorPos);
      el.focus();

      this.closeMentionPopover();
    },

    initMentionComposer(el, composer) {
      if (!el || !['message', 'thread', 'task-description', 'task-comment', 'doc-comment', 'doc-reply'].includes(composer)) return;
      el.dataset.chatComposer = composer;
      registerChatComposer(this, el, composer);
      const value = composer === 'thread' ? this.threadInput
        : composer === 'message' ? this.messageInput
          : composer === 'task-description' ? this.editingTask?.description
            : composer === 'task-comment' ? this.newTaskCommentBody
              : composer === 'doc-comment' ? this.newDocCommentBody
                : this.newDocCommentReplyBody;
      hydrateMentionComposer(el, value);
      MENTION_COMPOSER_MODELS.set(el, String(value || ''));
      if (['message', 'thread'].includes(composer)) {
        const hasText = Boolean(String(value || '').trim());
        if (this.composerDraftHasText[composer] !== hasText) this.composerDraftHasText[composer] = hasText;
      }
      let elements = MENTION_COMPOSER_ELEMENTS.get(this);
      if (!elements) {
        elements = new Map();
        MENTION_COMPOSER_ELEMENTS.set(this, elements);
      }
      elements.set(composer, el);
      this.autosizeComposer(el);
    },

    syncMentionComposerModel(el, options = {}) {
      const composer = String(el?.dataset?.chatComposer || '').trim();
      if (!['message', 'thread', 'task-description', 'task-comment', 'doc-comment', 'doc-reply'].includes(composer)) return '';
      registerChatComposer(this, el, composer);
      const previousValue = MENTION_COMPOSER_MODELS.get(el);
      const { value, actorMentions: mentions } = serializeMentionComposerState(el);
      MENTION_COMPOSER_MODELS.set(el, value);
      if (['message', 'thread'].includes(composer)) {
        const hasText = Boolean(value.trim());
        if (this.composerDraftHasText[composer] !== hasText) this.composerDraftHasText[composer] = hasText;
        let elements = MENTION_COMPOSER_ELEMENTS.get(this);
        if (!elements) {
          elements = new Map();
          MENTION_COMPOSER_ELEMENTS.set(this, elements);
        }
        elements.set(composer, el);
      }
      const deferReactive = options.deferReactive === true && ['message', 'thread'].includes(composer);
      if (composer === 'thread' && !deferReactive) this.threadInput = value;
      else if (composer === 'message' && !deferReactive) this.messageInput = value;
      else if (composer === 'task-description' && this.editingTask) {
        this.editingTask.description = value;
        this.handleEditingTaskDraftChanged();
      } else if (composer === 'task-comment') this.newTaskCommentBody = value;
      else if (composer === 'doc-comment') this.newDocCommentBody = value;
      else if (composer === 'doc-reply') this.newDocCommentReplyBody = value;
      const currentMentions = this.selectedAgentMentionsByComposer?.[composer] || [];
      const mentionsChanged = mentions.length !== currentMentions.length
        || mentions.some((mention, index) => (
          mention.type !== currentMentions[index]?.type
          || mention.npub !== currentMentions[index]?.npub
          || mention.label !== currentMentions[index]?.label
        ));
      if (mentionsChanged) {
        this.selectedAgentMentionsByComposer = {
          ...(this.selectedAgentMentionsByComposer || {}),
          [composer]: mentions,
        };
      }
      this.scheduleComposerElementAutosize(el, {
        canShrink: previousValue != null && value !== previousValue && value.length <= previousValue.length,
      });
      return value;
    },

    syncMentionComposerDraft(el) {
      return this.syncMentionComposerModel(el, { deferReactive: true });
    },

    hasMentionComposerDraftText(composer) {
      if (!['message', 'thread'].includes(composer)) return false;
      return Boolean(this.composerDraftHasText?.[composer]);
    },

    commitMentionComposerDraft(composer, el = null) {
      if (!['message', 'thread'].includes(composer)) return '';
      const registered = MENTION_COMPOSER_ELEMENTS.get(this)?.get(composer);
      const target = el || (registered?.isConnected ? registered : null);
      if (!target) return String(composer === 'thread' ? this.threadInput : this.messageInput || '');
      return this.syncMentionComposerModel(target);
    },

    syncMentionComposerFromModel(el, composer, value) {
      if (!el || !['message', 'thread', 'task-description', 'task-comment', 'doc-comment', 'doc-reply'].includes(composer)) return;
      registerChatComposer(this, el, composer, false);
      const normalizedValue = String(value || '');
      if (['message', 'thread'].includes(composer)) {
        const hasText = Boolean(normalizedValue.trim());
        if (this.composerDraftHasText[composer] !== hasText) this.composerDraftHasText[composer] = hasText;
      }
      const cachedValue = MENTION_COMPOSER_MODELS.get(el);
      if (cachedValue === normalizedValue) return;
      if (cachedValue == null && serializeMentionComposer(el) === normalizedValue) {
        MENTION_COMPOSER_MODELS.set(el, normalizedValue);
        return;
      }
      hydrateMentionComposer(el, normalizedValue);
      MENTION_COMPOSER_MODELS.set(el, normalizedValue);
      this.autosizeComposer(el);
    },

    async handleMentionComposerPaste(event, composer) {
      const clipboardItems = [...(event?.clipboardData?.items || [])];
      const hasImage = clipboardItems.some((item) => String(item?.type || '').startsWith('image/'));
      const hasChatFile = ['message', 'thread'].includes(composer)
        && clipboardItems.some((item) => item?.kind === 'file');
      if (hasImage || hasChatFile) {
        if (composer === 'task-description') await this.handleTaskDescriptionPaste(event);
        else if (composer === 'task-comment') await this.handleTaskCommentPaste(event);
        else if (composer === 'doc-comment') await this.handleDocCommentPaste(event);
        else if (composer === 'doc-reply') await this.handleDocCommentReplyPaste(event);
        else await this.handleChatPaste(event, composer);
        return;
      }
      event.preventDefault();
      insertPlainTextAtSelection(event.currentTarget, event.clipboardData?.getData('text/plain') || '');
      this.syncMentionComposerModel(event.currentTarget);
      this.handleMentionInput(event.currentTarget);
    },

    closeMentionPopover() {
      this.mentionActive = false;
      this.mentionQuery = '';
      this.mentionResults = [];
      this.mentionSelectedIndex = 0;
      this._mentionTargetEl = null;
      this._mentionStartPos = -1;
      this._mentionEndPos = -1;
    },

    handleInternalRouteReference(href, event, title = '', { validateOnly = false } = {}) {
      if (typeof window === 'undefined') return false;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return false;
      const route = parseRouteLocation(url.href);
      const params = route.params || {};
      let type = ''; let id = '';
      if (route.section === 'docs' && params.docid) { type = 'doc'; id = params.docid; }
      else if (route.section === 'tasks' && params.taskid) { type = 'task'; id = params.taskid; }
      else if (['chat', 'status'].includes(route.section) && params.threadid) { type = 'chat'; id = params.channelid ? `${params.channelid}#${params.threadid}` : params.threadid; }
      else if (route.section === 'chat' && params.channelid) { type = 'channel'; id = params.channelid; }
      else if (route.section === 'docs' && params.folderid) { type = 'directory'; id = params.folderid; }
      else if (route.section === 'reports' && params.reportid) { type = 'report'; id = params.reportid; }
      else if (route.section === 'settings' && params.scopeid) { type = 'scope'; id = params.scopeid; }
      if (!type) return false;
      event?.preventDefault?.();
      const workspace = resolveTowerPgWorkspaceContext(this);
      if ((params.workspacekey && params.workspacekey !== this.currentWorkspaceKey)
        || (params.workspaceid && params.workspaceid !== workspace.workspaceId)
        || (route.workspaceSlug && route.workspaceSlug !== this.currentWorkspaceSlug)) {
        beginInternalReferenceVisit(this);
        this.internalLinkOpening = false;
        this.internalLinkOpenError = 'This link belongs to another workspace. Open it in that workspace to keep workspace data isolated.';
        this.error = this.internalLinkOpenError;
        return true;
      }
      if (validateOnly) return false;
      void this.handleMentionNavigate(type, id, { commentId: params.commentid || null, title });
      return true;
    },

    async prepareInternalReferenceDeparture(linkType, visit) {
      if (this.docEditDraftDirty && !await this.preserveWikiNavigationDraft()) {
        if (visit.isCurrent()) {
          this.internalLinkOpenError = this.error || 'Could not preserve your document draft. Try opening the link again.';
          this.error = this.internalLinkOpenError;
        }
        return false;
      }
      if (!visit.isCurrent()) return false;
      if (this.showTaskDetail && this.taskDraftDirty) {
        const preserved = await this.persistTaskLocalDraft?.();
        if (!visit.isCurrent()) return false;
        if (!preserved && this.taskDraftDirty) {
          this.internalLinkOpenError = 'Could not preserve your task draft. Save your draft or try opening the link again.';
          this.error = this.internalLinkOpenError;
          return false;
        }
      }
      rememberReferenceComposerDraft(this, 'doc', this.selectedDocId);
      rememberReferenceComposerDraft(this, 'task', this.activeTaskId);
      // All asynchronous checkpoints finish before changing the source visit.
      if (linkType !== 'task' && this.showTaskDetail) {
        this.releaseCurrentPgTaskDetailLeaseBeforeSwitch?.('');
        void this.closeTaskDetail({ syncRoute: false, releaseCheckout: false });
      }
      if (linkType !== 'doc' && this.selectedDocId) this.closeDocEditor({ syncRoute: false });
      if (linkType !== 'chat' && this.deckThreadChannelId) this.closeDeckThread?.({ syncRoute: false, fromRoute: true });
      this.saveChatComposerDraft?.('message');
      this.saveChatComposerDraft?.('thread');
      return true;
    },

    async handleMentionNavigate(type, id, options = {}) {
      const linkType = normalizeRecordLinkType(type);
      const recordId = String(id || '').trim();
      if (!recordId) return false;
      const visit = beginInternalReferenceVisit(this);
      const originRoute = String(this.buildRouteUrl?.() || '').trim();
      this.internalLinkOpening = true;
      this.internalLinkOpenError = '';
      this.error = null;
      try {
        if (linkType === 'chat') return await this.openLinkedThread(recordId, {
          isCurrent: visit.workspaceCurrent,
          beforeOpen: () => this.prepareInternalReferenceDeparture(linkType, visit),
        });
        if (this.isStatusFamilyDisabled?.(linkType === 'doc' ? 'document' : linkType)) {
          throw new Error(`The ${linkType} surface is disabled in this Flight Deck build.`);
        }
        const row = await resolveInternalReference(this, linkType, recordId, { isCurrent: visit.isCurrent });
        if (!row || !visit.isCurrent()) return false;
        const destinationType = row.pg_record_type === 'file' ? 'file' : linkType;
        if (!await this.prepareInternalReferenceDeparture(destinationType, visit)) return false;
        this.mobileNavOpen = false;
        if (linkType === 'file' || (linkType === 'doc' && row.pg_record_type === 'file')) {
          this.navSection = 'files';
          if (row.pg_channel_id) this.selectPgChannelContext?.(row.pg_channel_id, { preserveDetail: true });
          this.startWorkspaceLiveQueries();
          void this.openFilePreview(row);
          this.syncRoute();
        } else if (linkType === 'doc') {
          this.openDoc(recordId, { ...documentLinkViewState(options.commentId), draftPreserved: true, captureOrigin: false, originRoute });
        } else if (linkType === 'task') {
          this.openTaskDetail(recordId, { captureOrigin: false, originRoute });
        } else if (linkType === 'scope') {
          this.navSection = 'settings';
          this.settingsTab = 'scopes';
          this.scopeNavFocus = recordId;
          this.startWorkspaceLiveQueries();
          this.syncRoute();
          this.$nextTick(() => document.getElementById('scope-' + recordId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        } else if (linkType === 'channel') {
          this.navSection = 'chat';
          this.startWorkspaceLiveQueries();
          const docGeneration = this.docOpenGeneration;
          const taskGeneration = this.taskDetailOpenGeneration;
          await this.selectChannel?.(recordId, {
            isCurrent: () => visit.workspaceCurrent() && this.navSection === 'chat'
              && this.docOpenGeneration === docGeneration && this.taskDetailOpenGeneration === taskGeneration,
          });
        } else if (linkType === 'directory') {
          if (row.pg_channel_id || row.channel_id) this.selectPgChannelContext?.(row.pg_channel_id || row.channel_id, { preserveDetail: true });
          this.navigateToFolder(recordId);
        } else if (linkType === 'report') {
          this.navSection = 'reports';
          this.startWorkspaceLiveQueries();
          this.openReportModal(row);
          this.syncRoute();
        }
        return true;
      } catch (error) {
        if (visit.isCurrent()) {
          this.internalLinkOpenError = `Could not open linked ${linkType}: ${error?.message || String(error)}`;
          this.error = this.internalLinkOpenError;
        }
        return false;
      } finally {
        if (this.internalLinkOpenRequestId === visit.request) this.internalLinkOpening = false;
      }
    },

    handleMentionLinkClick(event, link = event?.target?.closest?.('.mention-link')) {
      const type = String(link?.dataset?.mentionType || '').trim().toLowerCase();
      const id = String(link?.dataset?.mentionId || '').trim();
      if (!type || !id) return false;
      event?.preventDefault?.();
      if (type === 'person' || type === 'agent') {
        beginInternalReferenceVisit(this);
        this.internalLinkOpening = false;
        this.internalLinkOpenError = '';
        this.openIdentityCard({
          currentTarget: link,
          clientX: event?.clientX,
          clientY: event?.clientY,
        }, id);
      } else {
        this.handleMentionNavigate(type, id);
      }
      return true;
    },

    shouldOpenDeckCard(event) {
      return !event?.target?.closest?.('.mention-link, [data-deck-card-action]');
    },

    createOptimisticChatDoc(recordId, title = '') {
      const docId = String(recordId || '').trim();
      if (!docId) return null;
      const existing = this.documents.find((item) => item.record_id === docId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const placeholder = {
        record_id: docId,
        owner_npub: this.workspaceOwnerNpub || this.session?.npub || '',
        title: String(title || '').trim() || 'Flight Deck document',
        content: '',
        content_format: null,
        content_blocks: [],
        content_storage_object_id: null,
        content_storage_status: 'loading',
        content_storage_error: null,
        parent_directory_id: null,
        scope_id: null,
        scope_l1_id: null,
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
        sync_status: 'pending',
        record_state: 'active',
        version: 0,
        created_at: now,
        updated_at: now,
        pg_backend: true,
        pg_record_type: 'doc',
      };
      this.patchDocumentLocal(placeholder);
      return placeholder;
    },

    prefetchFlightDeckDoc(recordId, options = {}) {
      const docId = String(recordId || '').trim();
      if (!docId || !isTowerPgBackendMode()) return Promise.resolve(null);
      const existing = this.documents.find((item) => item.record_id === docId);
      if (existing?.content_storage_status === 'loaded' && options.force !== true) return Promise.resolve(existing);
      if (this.docHydrationInFlightById?.[docId]) return this.docHydrationInFlightById[docId];
      const hydration = this.requestTowerSyncFamily?.('document', docId, { force: true })
        .catch((error) => {
          console.warn('[flightdeck] PG document prefetch failed', error);
          return null;
        })
        .finally(() => {
          if (this.docHydrationInFlightById?.[docId] === hydration) {
            const next = { ...this.docHydrationInFlightById };
            delete next[docId];
            this.docHydrationInFlightById = next;
          }
        });
      this.docHydrationInFlightById = {
        ...this.docHydrationInFlightById,
        [docId]: hydration,
      };
      return hydration;
    },

    async openChatDocModal(recordId, options = {}) {
      return this.handleMentionNavigate('doc', recordId, options);
    },

    closeChatDocModal() {
      if (this.chatDocModalOpen) {
        this.closeDocEditor({ syncRoute: false });
      }
      this.chatDocModalOpen = false;
      this.chatDocModalTitle = '';
      this.chatDocModalFullScreen = false;
    },

    toggleChatDocModalFullScreen() {
      if (!this.chatDocModalOpen) return;
      this.chatDocModalFullScreen = !this.chatDocModalFullScreen;
    },

    async deleteCurrentDirectory() {
      const dir = this.currentFolder;
      const ownerNpub = this.workspaceOwnerNpub;
      if (!dir || !ownerNpub || !this.session?.npub) {
        this.error = 'No folder selected';
        return;
      }

      const confirmed = window.confirm(`Delete folder "${dir.title}" and all its contents? This cannot be undone.`);
      if (!confirmed) return;
      this.assertCanMutateLockManagedRecord(dir, recordFamilyHash('directory'));
      await this.ensureLockManagedCheckout(dir, recordFamilyHash('directory'), { intent: 'delete' });

      // Collect all descendant directory IDs recursively
      const allDirIds = new Set([dir.record_id]);
      let added = true;
      while (added) {
        added = false;
        for (const d of this.directories) {
          if (d.record_state === 'deleted') continue;
          if (d.parent_directory_id && allDirIds.has(d.parent_directory_id) && !allDirIds.has(d.record_id)) {
            allDirIds.add(d.record_id);
            added = true;
          }
        }
      }

      // Soft-delete all directories in the set
      for (const dirId of allDirIds) {
        const directory = this.directories.find((d) => d.record_id === dirId);
        if (!directory || directory.record_state === 'deleted') continue;
        const nextVersion = (directory.version ?? 1) + 1;
        const now = new Date().toISOString();
        const shares = this.getEffectiveDocShares(directory);
        const updated = this.normalizeDirectoryRowGroupRefs({
          ...directory,
          shares,
          group_ids: this.getShareGroupIds(shares),
          record_state: 'deleted',
          sync_status: 'pending',
          version: nextVersion,
          updated_at: now,
        });

        await upsertDirectory(updated);
        this.patchDirectoryLocal(updated);
        await queueTowerPendingWrite(this, {
          record_id: dirId,
          record_family_hash: recordFamilyHash('directory'),
          envelope: await this.buildManagedDirectoryEnvelope({
            ...updated,
            previous_version: directory.version ?? 1,
            signature_npub: this.signingNpub,
            shares,
            group_ids: updated.group_ids,
            write_group_ref: this.getPreferredRecordWriteGroup(updated),
          }, directory, { intent: 'delete' }),
        });
      }

      // Soft-delete all documents inside those directories
      for (const doc of this.documents) {
        if (doc.record_state === 'deleted') continue;
        if (!allDirIds.has(doc.parent_directory_id)) continue;
        const nextVersion = (doc.version ?? 1) + 1;
        const now = new Date().toISOString();
        const shares = this.getEffectiveDocShares(doc);
        const updated = this.normalizeDocumentRowGroupRefs({
          ...doc,
          shares,
          group_ids: this.getShareGroupIds(shares),
          record_state: 'deleted',
          sync_status: 'pending',
          version: nextVersion,
          updated_at: now,
        });

        await upsertDocument(updated);
        this.patchDocumentLocal(updated);
        await queueTowerPendingWrite(this, {
          record_id: doc.record_id,
          record_family_hash: recordFamilyHash('document'),
          envelope: await this.buildManagedDocumentEnvelope({
            ...updated,
            previous_version: doc.version ?? 1,
            signature_npub: this.signingNpub,
            shares,
            group_ids: updated.group_ids,
            write_group_ref: this.getPreferredRecordWriteGroup(updated),
          }, doc, { intent: 'delete' }),
        });
      }

      // Navigate up to parent
      this.navigateToFolder(dir.parent_directory_id || null);
      await this.flushAndBackgroundSync();
      await this.refreshDirectories();
      await this.refreshDocuments();
    },

    async deleteSelectedDocItem() {
      this.cancelDocAutosave();
      this.error = null;
      const item = this.selectedDocument;
      if (!item) {
        this.error = 'Select a document first';
        return;
      }
      const removed = await this.deleteDocumentsByIds([item.record_id], {
        confirmMessage: 'Delete this document?',
      });
      if (!removed) return;
      await this.flushAndBackgroundSync();
      if (!isTowerPgBackendMode()) {
        await this.refreshDirectories();
        await this.refreshDocuments();
      }
      const [first] = this.filteredDocRows;
      if (first) this.selectDocItem(first.type, first.item.record_id);
    },

    getInlineUploadCount(context) {
      return context === 'thread' ? this.threadImageUploadCount : this.messageImageUploadCount;
    },

    setInlineUploadCount(context, nextValue) {
      const normalized = Math.max(0, Number(nextValue) || 0);
      if (context === 'thread') this.threadImageUploadCount = normalized;
      else this.messageImageUploadCount = normalized;
    },

    incrementInlineUploadCount(context) {
      this.setInlineUploadCount(context, this.getInlineUploadCount(context) + 1);
    },

    decrementInlineUploadCount(context) {
      this.setInlineUploadCount(context, this.getInlineUploadCount(context) - 1);
    },

    defaultPastedImageName(file, context = 'chat') {
      const now = new Date();
      const stamp = now.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
      const mime = String(file?.type || '').toLowerCase();
      const ext = mime.includes('png')
        ? 'png'
        : mime.includes('jpeg') || mime.includes('jpg')
          ? 'jpg'
          : mime.includes('gif')
            ? 'gif'
            : mime.includes('webp')
              ? 'webp'
              : 'bin';
      return `${context}-image-${stamp}.${ext}`;
    },

    createStorageMarkdown(objectId, altText = 'Image') {
      const safeAlt = String(altText || 'Image').replace(/[\[\]]/g, '').trim() || 'Image';
      return `![${safeAlt}](storage://${objectId})`;
    },

    createStorageFileMarkdown(objectId, fileName = 'Uploaded file') {
      const safeLabel = String(fileName || 'Uploaded file')
        .replace(/\\/g, '\\\\')
        .replace(/([\[\]])/g, '\\$1')
        .trim() || 'Uploaded file';
      return `[${safeLabel}](storage://${objectId})`;
    },

    containsInlineImageUploadToken(value) {
      const text = String(value || '');
      return text.includes('[ Uploading image... ]') || text.includes('[ Uploading file... ]');
    },

    getModelValue(modelPath) {
      const parts = String(modelPath || '').split('.').filter(Boolean);
      return parts.reduce((acc, key) => (acc == null ? acc : acc[key]), this);
    },

    setModelValue(modelPath, value) {
      const parts = String(modelPath || '').split('.').filter(Boolean);
      if (parts.length === 0) return;
      if (parts.length === 1) {
        this[parts[0]] = value;
        return;
      }
      const parent = parts.slice(0, -1).reduce((acc, key) => (acc == null ? acc : acc[key]), this);
      if (parent && typeof parent === 'object') {
        parent[parts[parts.length - 1]] = value;
      }
    },

    insertTextIntoModel(modelKey, textarea, text) {
      const current = String(this.getModelValue(modelKey) || '');
      const start = typeof textarea?.selectionStart === 'number' ? textarea.selectionStart : current.length;
      const end = typeof textarea?.selectionEnd === 'number' ? textarea.selectionEnd : current.length;
      const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
      this.setModelValue(modelKey, next);
      const caret = start + text.length;
      if (textarea) {
        textarea.value = next;
        textarea.selectionStart = caret;
        textarea.selectionEnd = caret;
      }
      return { start, end, insertedText: text };
    },

    replaceTokenInModel(modelKey, token, replacement, textarea = null) {
      const current = String(this.getModelValue(modelKey) || '');
      const index = current.indexOf(token);
      if (index === -1) return false;
      const next = `${current.slice(0, index)}${replacement}${current.slice(index + token.length)}`;
      this.setModelValue(modelKey, next);
      if (textarea) {
        const caret = index + replacement.length;
        textarea.value = next;
        textarea.selectionStart = caret;
        textarea.selectionEnd = caret;
      }
      return true;
    },

    async sha256HexForBytes(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    },

    async prepareStorageObjectForCurrentWorkspace(body) {
      if (isTowerPgBackendMode() && this.currentWorkspace?.pgBackendMode) {
        const workspaceId = String(this.currentWorkspace?.workspaceId || '').trim();
        if (!workspaceId) throw new Error('Tower PG workspace id is required for file upload.');
        return prepareTowerPgStorageObject(workspaceId, body, {
          baseUrl: this.currentWorkspace?.directHttpsUrl || this.currentWorkspaceBackendUrl || this.backendUrl,
          appNpub: this.currentWorkspace?.appNpub || undefined,
        });
      }
      return prepareStorageObject(body);
    },

    async handleInlineImagePaste(event, options = {}) {
      const clipboardItems = [...(event?.clipboardData?.items || [])];
      const imageItem = clipboardItems.find((item) => String(item?.type || '').startsWith('image/'));
      if (!imageItem) return false;

      event.preventDefault();

      const file = imageItem.getAsFile?.();
      if (!file) {
        this.error = 'Could not read pasted image.';
        return true;
      }

      const modelKey = String(options.modelKey || '').trim();
      if (!modelKey) return true;
      const ownerNpub = String(options.ownerNpub || '').trim();
      if (!ownerNpub) {
        this.error = 'Missing storage owner for pasted image.';
        return true;
      }

      const token = '[ Uploading image... ]';
      this.insertTextIntoModel(modelKey, event.target, token);
      if (options.uploadCounterContext) this.incrementInlineUploadCount(options.uploadCounterContext);

      try {
        const uploaded = await this.uploadInlineImageFile(file, options);
        this.replaceTokenInModel(modelKey, token, uploaded.markdown, event.target);
        this.scheduleStorageImageHydration();
      } catch (error) {
        this.replaceTokenInModel(modelKey, token, '[ Upload failed ]', event.target);
        this.error = error?.message || 'Could not upload pasted image.';
      } finally {
        if (options.uploadCounterContext) this.decrementInlineUploadCount(options.uploadCounterContext);
      }
      return true;
    },

    async uploadInlineImageFile(file, options = {}) {
      if (!file) throw new Error('Could not read pasted image.');
      const ownerNpub = String(options.ownerNpub || '').trim();
      if (!ownerNpub) throw new Error('Missing storage owner for pasted image.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fileName = this.defaultPastedImageName(file, options.fileLabel || 'inline');
      const prepared = await this.prepareStorageObjectForCurrentWorkspace(buildStoragePrepareBody({
        ownerNpub,
        ownerGroupId: options.ownerGroupId,
        accessGroupIds: options.accessGroupIds ?? options.accessGroupNpubs ?? [],
        contentType: file.type || 'image/png',
        sizeBytes: file.size || bytes.byteLength,
        fileName,
      }));
      await uploadStorageObject(prepared, bytes, file.type || 'image/png');
      await completeStorageObject(prepared.object_id, {
        size_bytes: bytes.byteLength,
        sha256_hex: await this.sha256HexForBytes(bytes),
      });
      return {
        objectId: prepared.object_id,
        fileName,
        markdown: this.createStorageMarkdown(prepared.object_id, fileName),
      };
    },

    async uploadFileIntoModel(file, event, options = {}) {
      if (!file) return false;
      const modelKey = String(options.modelKey || '').trim();
      if (!modelKey) return false;
      const ownerNpub = String(options.ownerNpub || '').trim();
      if (!ownerNpub) {
        this.error = 'Missing storage owner for uploaded file.';
        return true;
      }
      let pgContext = null;
      if (isTowerPgBackendMode()) {
        pgContext = this.resolvePgWriteContext?.({
          scopeId: options.scopeId,
          channelId: options.channelId,
          threadId: options.threadId,
          threadMessageId: options.threadMessageId,
          includeActiveThread: options.includeActiveThread === true,
        }) || null;
        if (!pgContext) {
          return this.openWriteContextModal?.('inline-file', { file, event, options }) || true;
        }
      }

      const token = '[ Uploading file... ]';
      this.insertTextIntoModel(modelKey, event?.target, token);
      if (options.uploadCounterContext) this.incrementInlineUploadCount(options.uploadCounterContext);

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const fileName = String(file.name || '').trim() || this.defaultPastedImageName(file, options.fileLabel || 'file');
        const prepared = await this.prepareStorageObjectForCurrentWorkspace(buildStoragePrepareBody({
          ownerNpub,
          ownerGroupId: pgContext ? null : options.ownerGroupId,
          accessGroupIds: pgContext ? [] : options.accessGroupIds ?? options.accessGroupNpubs ?? [],
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size || bytes.byteLength,
          fileName,
        }));
        await uploadStorageObject(prepared, bytes, file.type || 'application/octet-stream');
        await completeStorageObject(prepared.object_id, {
          size_bytes: bytes.byteLength,
          sha256_hex: await this.sha256HexForBytes(bytes),
        });
        if (pgContext) {
          const acceptedFile = await createTowerPgFileFromLocal(this, {
            title: fileName,
            display_name: fileName,
            storage_object_id: prepared.object_id,
            content_storage_object_id: prepared.object_id,
            content: this.createStorageFileMarkdown(prepared.object_id, fileName),
            scope_id: pgContext.scopeId,
            pg_channel_id: pgContext.channelId,
            pg_thread_id: pgContext.threadId || null,
          });
          await upsertDocument(acceptedFile);
          if (typeof this.patchDocumentLocal === 'function') this.patchDocumentLocal(acceptedFile);
        }
        this.replaceTokenInModel(modelKey, token, this.createStorageFileMarkdown(prepared.object_id, fileName), event?.target);
      } catch (error) {
        this.replaceTokenInModel(modelKey, token, '[ Upload failed ]', event?.target);
        this.error = error?.message || 'Could not upload file.';
      } finally {
        if (options.uploadCounterContext) this.decrementInlineUploadCount(options.uploadCounterContext);
      }
      return true;
    },

    async handleChatFileDrop(event, context = 'message') {
      const files = [...(event?.dataTransfer?.files || [])].filter(Boolean);
      if (files.length === 0) return false;
      event.preventDefault();
      event.stopPropagation();

      const channel = context === 'thread' && !this.deckThreadComposerOpen
        ? this.activeThreadChannel
        : this.selectedChannel;
      if (!channel) {
        this.error = context === 'thread'
          ? 'Thread channel is still loading. Try the attachment again when it is ready.'
          : 'Select a channel first';
        return true;
      }

      for (const file of files) {
        this.addChatFileDraft(file, context);
      }
      this.scheduleComposerAutosize(context);
      return true;
    },

    getChatFileDrafts(context = 'message') {
      return context === 'thread' ? this.threadFileDrafts : this.messageFileDrafts;
    },

    setChatFileDrafts(context = 'message', drafts = []) {
      if (context === 'thread') this.threadFileDrafts = drafts;
      else this.messageFileDrafts = drafts;
    },

    handleChatAttachmentSelection(event, context = 'message') {
      const files = [...(event?.target?.files || [])].filter(Boolean);
      if (event?.target) event.target.value = '';
      for (const file of files) this.addChatFileDraft(file, context);
    },

    addChatFileDraft(file, context = 'message', options = {}) {
      if (!file) return;
      const kind = String(file.type || '').startsWith('image/') ? 'image' : 'file';
      const draft = {
        draft_id: crypto.randomUUID(),
        file,
        kind,
        filename: String(file.name || '').trim() || 'Attachment',
        content_type: file.type || 'application/octet-stream',
        size_bytes: Number(file.size) || 0,
        preview_url: kind === 'image' && typeof globalThis.URL?.createObjectURL === 'function'
          ? globalThis.URL.createObjectURL(file)
          : '',
        status: 'uploading',
        error: '',
        inline_upload_token: String(options.inlineUploadToken || ''),
        composer_draft_key: this.getChatComposerDraftKey(context),
      };
      this.setChatFileDrafts(context, [...this.getChatFileDrafts(context), draft]);
      this.uploadChatFileDraft(draft.draft_id, context);
      return draft;
    },

    async uploadChatFileDraft(draftId, context = 'message') {
      const draft = this.getChatFileDrafts(context).find((item) => item.draft_id === draftId);
      if (!draft?.file) return;
      this.setChatFileDrafts(context, this.getChatFileDrafts(context).map((item) => (
        item.draft_id === draftId ? { ...item, status: 'uploading', error: '' } : item
      )));
      try {
        const bytes = new Uint8Array(await draft.file.arrayBuffer());
        const ownerNpub = String(this.workspaceOwnerNpub || this.session?.npub || '').trim();
        if (!ownerNpub) throw new Error('Missing storage owner for attachment.');
        const prepared = await this.prepareStorageObjectForCurrentWorkspace(buildStoragePrepareBody({
          ownerNpub,
          accessGroupIds: [],
          contentType: draft.content_type,
          sizeBytes: draft.size_bytes || bytes.byteLength,
          fileName: draft.filename,
        }));
        await uploadStorageObject(prepared, bytes, draft.content_type);
        await completeStorageObject(prepared.object_id, {
          size_bytes: bytes.byteLength,
          sha256_hex: await this.sha256HexForBytes(bytes),
        });
        this.setChatFileDrafts(context, this.getChatFileDrafts(context).map((item) => (
          item.draft_id === draftId
            ? { ...item, storage_object_id: prepared.object_id, status: 'ready', error: '' }
            : item
        )));
        this.resolveChatFileDraftInlineToken(draftId, context, this.createStorageMarkdown(
          prepared.object_id,
          draft.filename,
        ), draft);
      } catch (error) {
        this.setChatFileDrafts(context, this.getChatFileDrafts(context).map((item) => (
          item.draft_id === draftId
            ? { ...item, status: 'error', error: error?.message || 'Upload failed.' }
            : item
        )));
        this.resolveChatFileDraftInlineToken(draftId, context, '[ Image upload failed ]', draft);
      }
    },

    resolveChatFileDraftInlineToken(draftId, context = 'message', replacement = '', sourceDraft = null) {
      const draft = sourceDraft || this.getChatFileDrafts(context).find((item) => item.draft_id === draftId);
      return resolveChatUploadToken(this, draft, context, replacement);
    },

    removeChatFileDraft(draftId, context = 'message') {
      const draft = this.getChatFileDrafts(context).find((item) => item.draft_id === draftId);
      this.resolveChatFileDraftInlineToken(draftId, context, '');
      this.revokeChatFileDraftPreview(draft);
      if (this.chatImagePreviewModal.open && this.chatImagePreviewModal.src === draft?.preview_url) {
        this.closeChatImagePreview();
      }
      this.setChatFileDrafts(context, this.getChatFileDrafts(context).filter((item) => item.draft_id !== draftId));
    },

    revokeChatFileDraftPreview(draft) {
      const previewUrl = String(draft?.preview_url || '');
      if (previewUrl && typeof globalThis.URL?.revokeObjectURL === 'function') globalThis.URL.revokeObjectURL(previewUrl);
    },

    clearChatFileDrafts(context = 'message') {
      for (const draft of this.getChatFileDrafts(context)) this.revokeChatFileDraftPreview(draft);
      this.setChatFileDrafts(context, []);
      if (this.chatImagePreviewModal.open) this.closeChatImagePreview({ restoreFocus: false });
    },

    cleanupChatImagePreviews() {
      this.clearChatFileDrafts('message');
      this.clearChatFileDrafts('thread');
    },

    focusChatImagePreviewClose() {
      (this.$nextTick || Alpine.nextTick)(() => document.querySelector('[data-chat-image-preview-close]')?.focus());
    },

    openChatImagePreview(draft, trigger = null) {
      const src = String(draft?.preview_url || '');
      if (!src) return;
      this.closeChatImagePreview({ restoreFocus: false });
      this.chatImagePreviewReturnFocus = trigger || (typeof document !== 'undefined' ? document.activeElement : null);
      this.chatImagePreviewModal = { open: true, src, alt: draft.filename || 'Image preview' };
      this.focusChatImagePreviewClose();
    },

    closeChatImagePreview(options = {}) {
      const returnFocus = this.chatImagePreviewReturnFocus;
      this.filePreviewRequestId = Number(this.filePreviewRequestId || 0) + 1;
      if (this.chatImagePreviewModal.ownedUrl) URL.revokeObjectURL(this.chatImagePreviewModal.src);
      this.filePreviewBlob = null;
      this.chatImagePreviewModal = { open: false, src: '', alt: '' };
      this.chatImagePreviewReturnFocus = null;
      if (options.restoreFocus !== false) (this.$nextTick || Alpine.nextTick)(() => returnFocus?.focus?.());
    },

    formatAttachmentSize(sizeBytes) {
      const bytes = Number(sizeBytes) || 0;
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },

    chatAttachmentMarkdown(attachment) {
      const objectId = String(attachment?.storage_object_id || '').trim();
      const filename = String(attachment?.filename || attachment?.name || 'Attachment').replace(/[\[\]]/g, '');
      if (!objectId) return '';
      return attachment?.kind === 'image' || String(attachment?.content_type || '').startsWith('image/')
        ? this.createStorageMarkdown(objectId, filename)
        : this.createStorageFileMarkdown(objectId, filename);
    },

    createChatImageUploadToken() {
      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return `[ Uploading image ${id}... ]`;
    },

    async handleChatPaste(event, context = 'message') {
      const fileItems = [...(event?.clipboardData?.items || [])]
        .filter((item) => item?.kind === 'file' || String(item?.type || '').startsWith('image/'));
      if (fileItems.length === 0) return false;
      event.preventDefault();

      const channel = context === 'thread' && !this.deckThreadComposerOpen
        ? this.activeThreadChannel
        : this.selectedChannel;
      if (!channel) {
        this.error = context === 'thread'
          ? 'Thread channel is still loading. Try the paste again when it is ready.'
          : 'Select a channel first';
        return true;
      }

      const files = fileItems
        .map((item) => item.getAsFile?.())
        .filter(Boolean);
      if (files.length === 0) {
        this.error = 'Could not read pasted attachment.';
        return true;
      }
      for (const file of files) {
        if (String(file?.type || '').startsWith('image/')) {
          const token = this.createChatImageUploadToken();
          if (event.currentTarget) {
            insertPlainTextAtSelection(event.currentTarget, token);
            this.syncMentionComposerModel(event.currentTarget);
            this.handleMentionInput(event.currentTarget);
          } else {
            const modelKey = context === 'thread' ? 'threadInput' : 'messageInput';
            this[modelKey] = `${this[modelKey] || ''}${token}`;
          }
          this.addChatFileDraft(file, context, { inlineUploadToken: token });
        } else {
          this.addChatFileDraft(file, context);
        }
      }
      return true;
    },

    async handleTaskDescriptionPaste(event) {
      if (!this.editingTask) return;
      await this.handleInlineImagePaste(event, {
        modelKey: 'editingTask.description',
        ownerNpub: this.editingTask.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: this.editingTask.group_ids ?? [],
        fileLabel: 'task',
      });
    },

    async handleTaskCommentPaste(event) {
      if (!this.editingTask) return;
      await this.handleInlineImagePaste(event, {
        modelKey: 'newTaskCommentBody',
        ownerNpub: this.editingTask.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: this.editingTask.group_ids ?? [],
        fileLabel: 'task-comment',
      });
    },

    handleTaskRichPaste(event, editor) {
      const clipboardItems = [...(event?.clipboardData?.items || [])];
      const imageItem = clipboardItems.find((item) => String(item?.type || '').startsWith('image/'));
      if (!imageItem) return false;
      event.preventDefault();

      const task = this.editingTask;
      if (!task) return true;
      const file = imageItem.getAsFile?.();
      if (!file) {
        this.error = 'Could not read pasted image.';
        return true;
      }

      const uploadId = globalThis.crypto?.randomUUID
        ? `task-rich-upload-${globalThis.crypto.randomUUID()}`
        : `task-rich-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.taskRichDescriptionUploadIds = [...this.taskRichDescriptionUploadIds, uploadId];
      editor?.chain?.()
        .focus()
        .insertContent({
          type: 'fdUploadPlaceholder',
          attrs: {
            uploadId,
            label: 'Uploading image...',
          },
        })
        .run();

      void (async () => {
        try {
          const uploaded = await this.uploadInlineImageFile(file, {
            ownerNpub: task.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
            accessGroupIds: task.group_ids ?? [],
            fileLabel: 'task-rich',
          });
          if (editor.isDestroyed || this.editingTask?.record_id !== task.record_id
            || this.taskRichDescriptionAdapter?.getEditor() !== editor) return;
          this.replaceDocRichUploadPlaceholder(editor, uploadId, {
            type: 'fdStorageImage',
            attrs: {
              src: `storage://${uploaded.objectId}`,
              objectId: uploaded.objectId,
              alt: uploaded.fileName,
              title: uploaded.fileName,
            },
          });
          const model = this.taskRichDescriptionAdapter?.getContentModel?.();
          if (model && this.editingTask) {
            this.editingTask.description = model.content || '';
            this.handleEditingTaskDraftChanged();
          }
          this.scheduleStorageImageHydration();
        } catch (error) {
          if (editor.isDestroyed || this.editingTask?.record_id !== task.record_id
            || this.taskRichDescriptionAdapter?.getEditor() !== editor) return;
          this.replaceDocRichUploadPlaceholder(editor, uploadId, {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Image upload failed.' }],
          });
          this.error = error?.message || 'Could not upload pasted image.';
        } finally {
          this.taskRichDescriptionUploadIds = this.taskRichDescriptionUploadIds.filter(id => id !== uploadId);
        }
      })();
      return true;
    },

    async handleDocSourcePaste(event) {
      const doc = this.selectedDocument;
      if (!doc) return;
      const handled = await this.handleInlineImagePaste(event, {
        modelKey: 'docEditorContent',
        ownerNpub: doc.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: doc.group_ids ?? [],
        fileLabel: 'doc',
      });
      if (handled) this.handleDocSourceInput(this.docEditorContent);
    },

    async handleDocBlockPaste(event) {
      const doc = this.selectedDocument;
      if (!doc) return;
      const handled = await this.handleInlineImagePaste(event, {
        modelKey: 'docBlockBuffer',
        ownerNpub: doc.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: doc.group_ids ?? [],
        fileLabel: 'doc-block',
      });
      if (handled) this.updateDocBlockBuffer(this.docBlockBuffer);
    },

    handleDocRichPaste(event, editor) {
      const clipboardItems = [...(event?.clipboardData?.items || [])];
      const imageItem = clipboardItems.find((item) => String(item?.type || '').startsWith('image/'));
      if (!imageItem) return false;
      event.preventDefault();

      const doc = this.selectedDocument;
      if (!doc) return true;
      const file = imageItem.getAsFile?.();
      if (!file) {
        this.error = 'Could not read pasted image.';
        return true;
      }

      const uploadId = globalThis.crypto?.randomUUID
        ? `doc-rich-upload-${globalThis.crypto.randomUUID()}`
        : `doc-rich-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.docRichImageUploadCount += 1;
      editor?.chain?.()
        .focus()
        .insertContent({
          type: 'fdUploadPlaceholder',
          attrs: {
            uploadId,
            label: 'Uploading image...',
          },
        })
        .run();

      void (async () => {
        try {
          const uploaded = await this.uploadInlineImageFile(file, {
            ownerNpub: doc.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
            accessGroupIds: doc.group_ids ?? [],
            fileLabel: 'doc-rich',
          });
          this.replaceDocRichUploadPlaceholder(editor, uploadId, {
            type: 'fdStorageImage',
            attrs: {
              src: `storage://${uploaded.objectId}`,
              objectId: uploaded.objectId,
              alt: uploaded.fileName,
              title: uploaded.fileName,
            },
          });
          this.syncDocRichEditorContentModel();
          this.scheduleStorageImageHydration();
        } catch (error) {
          this.replaceDocRichUploadPlaceholder(editor, uploadId, {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Image upload failed.' }],
          });
          this.error = error?.message || 'Could not upload pasted image.';
        } finally {
          this.docRichImageUploadCount = Math.max(0, this.docRichImageUploadCount - 1);
          this.syncDocRichEditorContentModel();
          this.scheduleDocAutosave();
        }
      })();
      return true;
    },

    replaceDocRichUploadPlaceholder(editor, uploadId, nextContent) {
      if (!editor || !uploadId) return false;
      let match = null;
      editor.state?.doc?.descendants?.((node, pos) => {
        if (node.type?.name !== 'fdUploadPlaceholder' || node.attrs?.uploadId !== uploadId) return true;
        match = { node, pos };
        return false;
      });
      if (!match) {
        editor.commands?.insertContent?.(nextContent);
        return false;
      }
      editor.chain?.()
        .focus()
        .insertContentAt({ from: match.pos, to: match.pos + match.node.nodeSize }, nextContent)
        .run();
      return true;
    },

    async handleDocCommentPaste(event) {
      const doc = this.selectedDocument;
      if (!doc) return;
      await this.handleInlineImagePaste(event, {
        modelKey: 'newDocCommentBody',
        ownerNpub: doc.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: doc.group_ids ?? [],
        fileLabel: 'doc-comment',
      });
    },

    async handleDocCommentReplyPaste(event) {
      const doc = this.selectedDocument;
      if (!doc) return;
      await this.handleInlineImagePaste(event, {
        modelKey: 'newDocCommentReplyBody',
        ownerNpub: doc.owner_npub || this.workspaceOwnerNpub || this.session?.npub,
        accessGroupIds: doc.group_ids ?? [],
        fileLabel: 'doc-reply',
      });
    },

    renderMarkdown(md) {
      const inlineReferences = (this.documents || [])
        .filter((doc) => doc?.record_state !== 'deleted')
        .map((doc) => ({
          type: 'doc',
          id: doc.record_id,
          label: doc.title || 'Untitled',
        }));
      return renderMarkdownCached(this, md, inlineReferences);
    },

    renderDeckCardText(text) {
      return renderDeckCardTextToHtml(text);
    },

    // createBotDm, deleteSelectedChannel, sendMessage, sendThreadReply, deleteActiveThread — in chatMessageManagerMixin

    // syncNow — in syncManagerMixin
  };

  // Shell state is applied first — it defines the canonical shell boundary
  // (identity, session, nav, route, sync status, connect modal, lifecycle methods).
  // The inline storeObj declarations still exist as fallback defaults;
  // see src/shell-state.js for the authoritative shell state definition.
  const shellState = createShellState({ initialSection: initialRoute.section });

  applyMixins(
    storeObj,
    shellState,
    avatarStatusMixin,
    taskBoardStateMixin,
    taskDetailManagerMixin,
    workspaceManagerMixin,
    chatMessageManagerMixin,
    readAloudManagerMixin,
    reactionsManagerMixin,
    syncManagerMixin,
    driveManagerMixin,
    peopleProfilesManagerMixin,
    connectSettingsManagerMixin,
    workspaceSelfIndexManagerMixin,
    onboardingAnnouncementsManagerMixin,
    channelsManagerMixin,
    scopesManagerMixin,
    scopeAccessManagerMixin,
    docsManagerMixin,
    jobsManagerMixin,
    audioRecordingManagerMixin,
    storageImageManagerMixin,
    filesManagerMixin,
    autopilotOverviewManagerMixin,
    agentSpaceManagerMixin,
    pipelineViewerManagerMixin,
    threadLiveActivityManagerMixin,
    notificationsManagerMixin,
    subscribedReaderMixin,
    wappPublishingManagerMixin,
    wappImageManagerMixin,
    wappManagementManagerMixin,
    writeContextManagerMixin,
    sectionLiveQueryMixin,
    unreadStoreMixin,
    reportsManagerMixin,
    commandPaletteMixin,
    workroomCreationMixin,
    workroomDetailMixin,
    recordTransferManagerMixin,
  );

  if (typeof window !== 'undefined') {
    window.Alpine = Alpine;
  }
  Alpine.store('chat', storeObj);
  if (typeof window !== 'undefined') {
    const storeAccessor = Alpine.store.bind(Alpine);
    window.$store = new Proxy(storeAccessor, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return Alpine.store(prop);
      },
      apply(target, thisArg, args) {
        return target.apply(thisArg, args);
      },
    });
  }
  Alpine.start();
}
