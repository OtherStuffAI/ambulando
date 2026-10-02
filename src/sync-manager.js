import { resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import { getTowerPgScopeAccess } from './api.js';
import { disposeContextTreeView } from './context-tree-view.js';
import { loadTowerPgContext, loadTowerPgContextReferences, readTowerPgContextDeletePreview } from './pg-read-hydrator.js';
import { hydrateFeedReader } from './feed/tower.js';
import { hydrateDriveShares } from './drive.js';
import { resolveTowerSigningUrl } from './tower-transport.js';
import Dexie from 'dexie';
/**
 * Sync lifecycle, repair, and quarantine methods extracted from app.js.
 *
 * The syncManagerMixin object contains methods and getters that use `this`
 * (the Alpine store) and should be spread into the store definition via applyMixins.
 */

import {
  getPendingWrites,
  getPendingWritesByFamilies,
  getSyncState,
  updatePendingWrite,
  removePendingWrite,
  clearSyncState,
  clearRuntimeFamilies,
  clearSyncStateForFamilies,
  getSyncQuarantineEntries,
  deleteSyncQuarantineEntry,
  clearSyncQuarantineForFamilies,
  deleteRuntimeRecordByFamily,
  upsertTask,
  getTaskById,
  upsertWorkspaceSettings,
  upsertFlow,
  getFlowById,
  upsertDocument,
  getDocumentById,
  upsertDirectory,
  getDirectoryById,
  upsertChannel,
  upsertMessage,
  upsertScope,
  upsertPerson,
  upsertOrganisation,
  upsertOpportunity,
  getOpportunityById,
  getCommentsByTarget,
  upsertComment,
  getApprovalById,
  upsertWapp,
} from './db.js';
import { fetchRecordHistory, syncRecords } from './api.js';
import {
  runSync,
  flushOnly,
  pullRecordsForFamilies,
  pruneOnLogin,
  startWorkerFlushTimer,
  stopWorkerFlushTimer,
  connectSSE,
  provideSSEToken,
  rejectSSEToken,
  acknowledgeSSEBatch,
  disconnectSSE,
  setSSEStatusCallback,
} from './sync-worker-client.js';
import { createNip98AuthHeader, createNip98AuthHeaderForSecret } from './auth/nostr.js';
import { validateSSESigningUrl } from './sse-stream-protocol.js';
import { getActiveWorkspaceKeySecretForAuth } from './crypto/workspace-keys.js';
import { flightDeckLog, flightDeckTrace, flightDeckSyncFailure } from './logging.js';
import { SYNC_FAMILY_OPTIONS, getSyncFamily, getSyncFamilyHashes } from './sync-families.js';
import { outboundTask } from './translators/tasks.js';
import { outboundWorkspaceSettings } from './translators/settings.js';
import { outboundDocument, outboundDirectory } from './translators/docs.js';
import { outboundChannel, outboundChatMessage } from './translators/chat.js';
import { outboundFlow } from './translators/flows.js';
import { outboundScope } from './translators/scopes.js';
import { outboundPerson } from './translators/persons.js';
import { outboundOrganisation } from './translators/organisations.js';
import { outboundOpportunity } from './translators/opportunities.js';
import { outboundWapp } from './translators/wapps.js';
import { decryptRecordPayload } from './translators/record-crypto.js';
import { hasGroupKey } from './crypto/group-keys.js';
import { outboundComment } from './translators/comments.js';
import {
  hydrateTowerPgChannelDocumentsAndFiles,
  hydrateTowerPgChannelMessages,
  hydrateTowerPgChannelAgentActivities,
  hydrateTowerPgAgentSessionHealth,
  hydrateTowerPgScopeTasks,
  hydrateTowerPgChannelTasks,
  hydrateTowerPgChannels,
  hydrateTowerPgDailyNoteTarget,
  hydrateTowerPgDailyNotes,
  hydrateTowerPgDoc,
  hydrateTowerPgDocComments,
  hydrateTowerPgDocumentsAndFiles,
  hydrateTowerPgEventUpdates,
  hydrateTowerPgPersonalWapps,
  hydrateTowerPgReactionTarget,
  hydrateTowerPgScopes,
  hydrateTowerPgTask,
  hydrateTowerPgTasks,
  hydrateTowerPgTaskComments,
  hydrateTowerPgThreadMessages,
  readTowerPgThreadHistoryPage,
  hydrateTowerPgWappActivity,
  hydrateTowerPgWappPublishingGrants,
  hydrateTowerPgWorkroom,
  hydrateTowerPgWorkroomParticipants,
  hydrateTowerPgWorkrooms,
  syncTowerPgWorkspace,
  towerPgSyncCursorKey,
} from './pg-read-hydrator.js';
import {
  getRecordWriteFieldsForStore,
  getPreferredRecordWriteGroupForStore,
} from './preferred-write-group.js';
import { resolveFlightDeckRecordCheckoutPolicy } from './record-checkout-policy.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { isFlightDeckSurfaceDisabled } from './disabled-surfaces.js';
import { replaceTowerSyncService } from './tower-sync-service.js';
import { TowerPgMaterializationWorkerClient } from './tower-pg-materialization-worker-client.js';
import { prepareTowerWorkspaceCommand } from './tower-command-port.js';

const PG_RECORD_SYNC_DISABLED_MESSAGE = 'Tower PG mode active; encrypted record sync is disabled.';
const PG_RECORD_REPAIR_DISABLED_MESSAGE = 'Tower PG mode active; encrypted record repair is not available because encrypted record sync is disabled.';
const PG_FULL_SYNC_STEPS = Object.freeze([
  { id: 'pg-workspace-delta', label: 'Workspace changes' },
]);
const PG_FULL_SYNC_CHILD_CONCURRENCY = 4;
const PG_SSE_TARGETED_EVENT_LIMIT = 25;
const PG_SSE_MATERIALISATION_MAX_ATTEMPTS = 3;
const PG_SSE_TARGETED_ONLY_ENTITY_TYPES = new Set([
  'agent_activity',
  'agent_session_health',
  'response_activity',
  'reaction',
  'resource_view_state',
  'wapp_activity_item',
  'wapp_activity_mute',
  'personal_agent_settings',
  'workroom',
  'workroom_event',
  'workroom_link',
  'workroom_participant',
]);
const SSE_LIFECYCLE_STATUSES = new Set([
  'connecting',
  'connected',
  'reconnecting',
  'fallback-polling',
  'disconnected',
  'token-needed',
  'token-failed',
  'cursor-ack-failed',
]);
const WAPP_FAMILY_FRESH_MS = 30_000;
const COLLECTION_FAMILY_FRESH_MS = 30_000;
const DETAIL_FAMILY_FRESH_MS = 15_000;
const STARTUP_SYNC_PROGRESS_DELAY_MS = 1_500;
const OFFLINE_MESSAGE_RESYNC_DELAY_MS = 250;
const OFFLINE_MESSAGE_RESYNC_IDLE_TIMEOUT_MS = 1_500;

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator?.onLine === false;
}

function scheduleIdle(callback) {
  const scope = typeof window !== 'undefined' ? window : globalThis;
  if (typeof scope?.requestIdleCallback === 'function') {
    return {
      kind: 'idle',
      id: scope.requestIdleCallback(callback, { timeout: OFFLINE_MESSAGE_RESYNC_IDLE_TIMEOUT_MS }),
    };
  }
  return {
    kind: 'timeout',
    id: setTimeout(() => callback(), 0),
  };
}

function cancelIdle(handle) {
  if (!handle) return;
  const scope = typeof window !== 'undefined' ? window : globalThis;
  if (handle.kind === 'idle' && typeof scope?.cancelIdleCallback === 'function') {
    scope.cancelIdleCallback(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) return [];
  const results = new Array(rows.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), rows.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < rows.length) {
      const index = nextIndex++;
      results[index] = await mapper(rows[index], index);
    }
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Mixin — methods and getters that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const syncManagerMixin = {

  towerReachabilityState: 'online',
  towerReachabilityReason: '',
  towerReachabilityConnectionKey: '',
  towerFallbackReachable: false,
  offlineMessageResyncArmed: false,
  offlineMessageResyncConnectionKey: '',
  offlineMessageResyncScheduled: false,
  offlineMessageResyncTimer: null,
  offlineMessageResyncIdleHandle: null,
  offlineMessageResyncReason: '',
  offlineMessageLastResult: null,

  traceFlightDeckTiming(message, details = null) {
    flightDeckTrace('message-timing', message, details);
  },

  get towerConnectionIndicatorLabel() {
    if (!isTowerPgBackendMode() || !this.isLoggedIn) return '';
    if (isBrowserOffline() || this.towerReachabilityState === 'offline') return 'Offline';
    const currentConnectionKey = this.buildSSEConnectionKey?.() || '';
    if (
      this.towerReachabilityConnectionKey
      && currentConnectionKey
      && this.towerReachabilityConnectionKey !== currentConnectionKey
    ) return '';
    if (this.towerReachabilityState === 'reconnecting') return 'Reconnecting';
    return '';
  },

  get towerConnectionIndicatorTitle() {
    const label = this.towerConnectionIndicatorLabel;
    if (!label) return '';
    const reason = String(this.towerReachabilityReason || '').trim();
    return reason ? `${label}: ${reason}` : label;
  },

  markTowerReachabilityDegraded(reason = 'transport-unreachable', state = 'reconnecting') {
    if (!isTowerPgBackendMode()) return false;
    this.towerFallbackReachable = false;
    this.offlineMessageResyncArmed = true;
    this.towerReachabilityState = isBrowserOffline() || state === 'offline' ? 'offline' : 'reconnecting';
    this.towerReachabilityReason = String(reason || 'transport-unreachable');
    this.towerReachabilityConnectionKey = this.buildSSEConnectionKey?.() || '';
    this.offlineMessageResyncConnectionKey = this.towerReachabilityConnectionKey;
    return true;
  },

  markTowerReachabilityOperationFailed(reason = 'tower-operation-failed') {
    if (!isTowerPgBackendMode()) return false;
    if (isBrowserOffline()) {
      return this.markTowerReachabilityDegraded('browser-offline', 'offline');
    }
    // A rejected command, failed materialisation, or local retry error is not
    // evidence that the live transport is reconnecting. The SSE lifecycle is
    // authoritative while its current stream is connected.
    if (this.sseStatus === 'connected') return false;
    return this.markTowerReachabilityDegraded(reason, 'reconnecting');
  },

  markTowerReachabilityRecovered(reason = 'transport-recovered', options = {}) {
    if (!isTowerPgBackendMode()) return false;
    if (isBrowserOffline()) {
      return this.markTowerReachabilityDegraded('browser-offline', 'offline');
    }
    const connectionKey = this.buildSSEConnectionKey?.() || '';
    const shouldSchedule = this.offlineMessageResyncArmed === true
      && (!this.offlineMessageResyncConnectionKey || this.offlineMessageResyncConnectionKey === connectionKey);
    this.towerReachabilityState = 'online';
    this.towerReachabilityReason = String(reason || 'transport-recovered');
    this.towerReachabilityConnectionKey = connectionKey;
    this.towerFallbackReachable = options.fallbackUsable === true;
    if (!shouldSchedule && this.offlineMessageResyncConnectionKey !== connectionKey) {
      this.offlineMessageResyncArmed = false;
      this.offlineMessageResyncConnectionKey = '';
    }
    if (!shouldSchedule) return false;
    return this.scheduleOfflineMessageResync({
      refresh: options.refresh === true,
      reason,
      delayMs: options.delayMs,
    });
  },

  scheduleOfflineMessageResync(options = {}) {
    if (!isTowerPgBackendMode()) return false;
    if (isBrowserOffline()) {
      this.markTowerReachabilityDegraded('browser-offline', 'offline');
      return false;
    }
    if (!this.offlineMessageResyncArmed) return false;
    if (this.offlineMessageResyncScheduled || this.offlineMessageResyncInFlight) return false;

    const delayMs = Math.max(0, Number(options.delayMs ?? OFFLINE_MESSAGE_RESYNC_DELAY_MS) || 0);
    const refresh = options.refresh === true;
    const connectionKey = this.buildSSEConnectionKey?.() || '';
    this.offlineMessageResyncScheduled = true;
    this.offlineMessageResyncReason = String(options.reason || 'connectivity-recovered');
    this.offlineMessageResyncTimer = setTimeout(() => {
      this.offlineMessageResyncTimer = null;
      this.offlineMessageResyncIdleHandle = scheduleIdle(async () => {
        this.offlineMessageResyncIdleHandle = null;
        this.offlineMessageResyncScheduled = false;
        if (connectionKey && connectionKey !== (this.buildSSEConnectionKey?.() || '')) {
          if (this.offlineMessageResyncConnectionKey === connectionKey) {
            this.offlineMessageResyncArmed = false;
            this.offlineMessageResyncConnectionKey = '';
          }
          return;
        }
        this.offlineMessageResyncArmed = false;
        this.offlineMessageResyncConnectionKey = '';
        try {
          const result = await this.retryUnsyncedOutgoingMessages?.({ refresh });
          this.offlineMessageLastResult = result || null;
        } catch (error) {
          this.offlineMessageLastResult = {
            attempted: 0,
            sent: 0,
            failed: 0,
            error: error?.message || String(error),
          };
          this.markTowerReachabilityOperationFailed('offline-message-resync-failed');
        }
      });
    }, delayMs);
    return true;
  },

  cancelScheduledOfflineMessageResync() {
    if (this.offlineMessageResyncTimer) clearTimeout(this.offlineMessageResyncTimer);
    cancelIdle(this.offlineMessageResyncIdleHandle);
    this.offlineMessageResyncTimer = null;
    this.offlineMessageResyncIdleHandle = null;
    this.offlineMessageResyncScheduled = false;
  },

  getTowerSyncService() {
    const workspaceKey = [
      this.backendUrl,
      this.workspaceDbKey,
      this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id || '',
    ].map((value) => String(value || '').trim()).join('|');
    if (!this.backendUrl || !this.workspaceDbKey) return null;
    if (this._towerSyncService?.workspaceKey === workspaceKey && !this._towerSyncService.disposed) {
      return this._towerSyncService;
    }
    this._towerSyncService = replaceTowerSyncService(this._towerSyncService, {
      workspaceKey,
      families: {
        'feed-reader': { freshMs: 30000, load: () => hydrateFeedReader(this), materialize: r => r },
        'drive-shares': { freshMs: 30000, load: () => hydrateDriveShares(this), materialize: result => result },
        'workspace-bootstrap': {
          load: (_id, options) => this.runTowerPgWorkspaceSync(options),
          materialize: (result) => result,
        },
        'wapp-activity': {
          freshMs: WAPP_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgWappActivity(this, options),
          materialize: (result) => result,
        },
        'wapp-mutes': {
          freshMs: WAPP_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgWappActivity(this, options),
          materialize: (result) => result?.mutes || [],
        },
        'wapp-publishing-grants': {
          freshMs: WAPP_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgWappPublishingGrants(this, options),
          materialize: (result) => result,
        },
        'personal-wapps': {
          freshMs: WAPP_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgPersonalWapps(this, options),
          materialize: (result) => result,
        },
        scopes: {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgScopes(this, options),
          materialize: (result) => result,
        },
        channels: {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgChannels(this, options),
          materialize: (result) => result,
        },
        tasks: {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgTasks(this, options),
          materialize: (result) => result,
        },
        documents: {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgDocumentsAndFiles(this, options),
          materialize: (result) => result,
        },
        'channel-tasks': {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (channelId, options) => hydrateTowerPgChannelTasks(this, channelId, options),
          materialize: (result) => result,
        },
        'channel-documents': {
          freshMs: COLLECTION_FAMILY_FRESH_MS,
          load: (channelId, options) => hydrateTowerPgChannelDocumentsAndFiles(this, channelId, options),
          materialize: (result) => result,
        },
        'channel-messages': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (channelId, options) => hydrateTowerPgChannelMessages(this, channelId, options),
          materialize: (result) => result,
        },
        'channel-agent-activities': {
          load: (key, options) => this.loadTowerPgAgentActivities(options.channelId || key, options),
        },
        'channel-agent-session-health': {
          load: (key, options) => hydrateTowerPgAgentSessionHealth(this, options.channelId || key, options),
        },
        'agent-activity-history': {
          load: (_key, options) => this.loadTowerPgAgentActivities(options.channelId, { ...options, recover: false }),
        },
        'thread-history-page': {
          load: (_key, options) => readTowerPgThreadHistoryPage(this, options.channelId, options.threadId, options),
          materialize: async (bundle, { options }) => {
            const result = bundle ? await this.materializeTowerPgWorkspaceBundle(bundle) : null;
            if (!options.cursor) void this.ensureThreadAgentActivityCoverage(options.channelId, options.threadId);
            return result;
          },
        },
        'thread-history': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (_coverageKey, options) => this.loadThreadMessagesWithActivity(options),
          materialize: (result) => result,
        },
        task: {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (taskId, options) => hydrateTowerPgTask(this, taskId, options),
          materialize: (result) => result,
        },
        'task-comments': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (taskId, options) => hydrateTowerPgTaskComments(this, taskId, options),
          materialize: (result) => result,
        },
        document: {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (docId, options) => hydrateTowerPgDoc(this, docId, options),
          materialize: (result) => result,
        },
        'document-comments': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (docId, options) => hydrateTowerPgDocComments(this, docId, options),
          materialize: (result) => result,
        },
        reactions: {
          freshMs: 30_000,
          load: (targetKey, options) => hydrateTowerPgReactionTarget(this, options.targetType, options.targetId || targetKey, options),
          materialize: (result) => result,
        },
        'daily-notes': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgDailyNotes(this, options),
          materialize: (result) => result,
        },
        'daily-note': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (_targetKey, options) => hydrateTowerPgDailyNoteTarget(this, options.ownerActorId, options.noteDate, options),
          materialize: (result) => result,
        },
        workrooms: {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (_id, options) => hydrateTowerPgWorkrooms(this, options),
          materialize: (result) => result,
        },
        workroom: {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (workroomId, options) => hydrateTowerPgWorkroom(this, workroomId, options),
          materialize: (result) => result,
        },
        'workroom-participants': {
          freshMs: DETAIL_FAMILY_FRESH_MS,
          load: (workroomId, options) => hydrateTowerPgWorkroomParticipants(this, workroomId, options),
          materialize: (result) => result,
        },
      },
      ports: {
        connectSSE: ({ runSoon }) => this.connectSSEStream({
          reason: runSoon ? 'ensure-background-sync-soon' : 'ensure-background-sync',
        }),
        disconnectSSE: ({ reason }) => this.disconnectSSEStream(reason),
        startFlushTimer: () => {
          if (this.isEncryptedRecordSyncDisabled) return;
          startWorkerFlushTimer(this.workspaceOwnerNpub, this.backendUrl, this.workspaceDbKey, {
            checkoutPolicyConfig: this.recordCheckoutPolicyConfig,
          });
        },
        stopFlushTimer: () => stopWorkerFlushTimer(),
        getFallbackCadence: () => this.getSyncCadenceMs(),
        runFallbackPoll: () => this.backgroundSyncTick(),
        hydrateInitial: (options) => (
          this.isEncryptedRecordSyncDisabled
            ? this.runTowerPgWorkspaceSync(options)
            : this.performSync({ silent: true })
        ),
        ensureLoaded: (family, id, options) => this.loadTowerSyncTarget(family, id, options),
        recoverCursor: ({ events = [] } = {}) => this.queueTowerPgSSEHydration(events),
        materialize: (family, payload, options) => (
          family === 'workspace-bundle'
            ? this.materializeTowerPgWorkspaceBundle(payload, options)
            : payload
        ),
        disposeMaterializer: ({ reason }) => this.disposeTowerPgMaterializationWorker(reason),
        freshness: () => null,
        prepareCommand: (name, input, options) => prepareTowerWorkspaceCommand(this, name, input, options),
      },
      onStateChange: (state) => {
        this.towerSyncInstrumentation = state;
        this.backgroundSyncTimer = this._towerSyncService?.fallbackTimer || null;
      },
    });
    return this._towerSyncService;
  },

  getTowerPgMaterializationWorker() {
    const service = this._towerSyncService || this.getTowerSyncService();
    if (!service) throw new Error('TowerSyncService is unavailable for PG materialisation');
    if (
      this._towerPgMaterializationWorker?.workspaceKey === service.workspaceKey
      && !this._towerPgMaterializationWorker.disposed
    ) {
      return this._towerPgMaterializationWorker;
    }
    this._towerPgMaterializationWorker?.dispose('workspace-owner-replaced');
    this._towerPgMaterializationWorker = new TowerPgMaterializationWorkerClient({
      workspaceKey: service.workspaceKey,
    });
    return this._towerPgMaterializationWorker;
  },

  buildTowerPgMaterializationStoreSnapshot() {
    const scalar = value => {
      if (value == null) return '';
      if (typeof value !== 'string') throw new TypeError('Invalid Tower worker identity field');
      return value;
    };
    const workspace = this.currentWorkspace || {};
    const descriptor = workspace.pgDescriptor || {};
    const identity = descriptor.identity || {};
    const me = workspace.pgMe || workspace.pg_me;
    // Alpine wraps nested objects in Proxy instances. Worker postMessage
    // requires plain data, including on the expired-cursor reset path.
    const reader = me ? {
      actor: { actor_id: scalar(me.actor?.actor_id || me.actor?.id || ''), npub: scalar(me.actor?.npub || '') },
      identity: { workspace_id: scalar(me.identity?.workspace_id || '') },
      permissions: Array.from(Array.isArray(me.permissions) ? me.permissions : [], permission => {
        if (typeof permission !== 'string') throw new TypeError('Invalid Tower reader permission');
        return permission;
      }),
    } : null;
    return {
      backendUrl: scalar(this.backendUrl || ''),
      _workspaceSelectionGeneration: Number(this._workspaceSelectionGeneration || 0),
      workspaceOwnerNpub: scalar(this.workspaceOwnerNpub || workspace.workspaceOwnerNpub || identity.workspace_owner_npub || ''),
      session: { npub: scalar(this.session?.npub || '') },
      workspaceHarnessAgents: Array.from(this.workspaceHarnessAgents || [], entry => ({
        agent_npub: scalar(entry?.agent_npub || '').trim(),
        url: scalar(entry?.url || '').trim(),
      })),
      currentWorkspace: {
        pgMe: reader,
        pgSessionNpub: scalar(workspace.pgSessionNpub || ''),
        directHttpsUrl: scalar(workspace.directHttpsUrl || descriptor.tower_base_url || descriptor.towerBaseUrl || ''),
        appNpub: scalar(workspace.appNpub || identity.app_npub || identity.appNpub || ''),
        workspaceId: scalar(workspace.workspaceId || workspace.workspace_id || identity.workspace_id || identity.workspaceId || ''),
        workspaceOwnerNpub: scalar(workspace.workspaceOwnerNpub || identity.workspace_owner_npub || identity.workspaceOwnerNpub || this.workspaceOwnerNpub || ''),
      },
    };
  },

  materializeTowerPgWorkspaceBundle(bundle, options = {}) {
    return this.getTowerPgMaterializationWorker().materialize({
      workspaceDbKey: options.workspaceDbKey || this.workspaceDbKey,
      store: options.store || this.buildTowerPgMaterializationStoreSnapshot(),
      bundle,
    });
  },

  disposeTowerPgMaterializationWorker(reason = 'dispose') {
    const worker = this._towerPgMaterializationWorker;
    this._towerPgMaterializationWorker = null;
    worker?.dispose(reason);
  },

  disposeTowerSyncService(reason = 'dispose') {
    disposeContextTreeView(this);
    const service = this._towerSyncService;
    this._towerSyncService = null;
    service?.dispose(reason);
    this.disposeSubscribedReader?.();
    this.backgroundSyncTimer = null;
    this.agentActivityRecoveryStartedAt = 0;
    this.agentActivityRecoveryError = '';
    this.agentActivityRecoveryAttempts = 0;
    this.agentActivityRecoveryPending = false;
  },

  loadTowerSyncTarget(family, id, options = {}) {
    switch (family) {
      case 'context-references': return loadTowerPgContextReferences(this, options.scopeId, id);
      case 'scope-access': { const context = resolveTowerPgWorkspaceContext(this); return getTowerPgScopeAccess(context.workspaceId, id, {baseUrl:context.baseUrl,appNpub:context.appNpub}); }
      case 'context-tree': return loadTowerPgContext(this, id, options);
      case 'context-delete-preview': return readTowerPgContextDeletePreview(this, options.scopeId, id);
      case 'scopes': return hydrateTowerPgScopes(this, options);
      case 'channels': return hydrateTowerPgChannels(this, options);
      case 'tasks': return hydrateTowerPgTasks(this, options);
      case 'documents': return hydrateTowerPgDocumentsAndFiles(this, options);
      case 'scope-tasks': return hydrateTowerPgScopeTasks(this, id, options);
      case 'channel-tasks': return hydrateTowerPgChannelTasks(this, id, options);
      case 'channel-documents': return hydrateTowerPgChannelDocumentsAndFiles(this, id, options);
      case 'channel-messages': return hydrateTowerPgChannelMessages(this, id, options);
      case 'channel-agent-activities': return this.loadTowerPgAgentActivities(options.channelId || id, options);
      case 'channel-agent-session-health': return hydrateTowerPgAgentSessionHealth(this, options.channelId || id, options);
      case 'agent-activity-history': return this.loadTowerPgAgentActivities(options.channelId, { ...options, recover: false });
      case 'thread-history-page': return readTowerPgThreadHistoryPage(this, options.channelId, options.threadId, options)
        .then(async (bundle) => {
          const result = bundle ? await this.materializeTowerPgWorkspaceBundle(bundle) : null;
          if (!options.cursor) void this.ensureThreadAgentActivityCoverage(options.channelId, options.threadId);
          return result;
        });
      case 'thread-history': return this.loadThreadMessagesWithActivity(options);
      case 'task': return hydrateTowerPgTask(this, id, options);
      case 'task-comments': return hydrateTowerPgTaskComments(this, id, options);
      case 'document': return hydrateTowerPgDoc(this, id, options);
      case 'document-comments': return hydrateTowerPgDocComments(this, id, options);
      case 'reactions': return hydrateTowerPgReactionTarget(this, options.targetType, options.targetId || id, options);
      case 'daily-notes': return hydrateTowerPgDailyNotes(this, options);
      case 'daily-note': return hydrateTowerPgDailyNoteTarget(this, options.ownerActorId, options.noteDate, options);
      case 'workrooms': return hydrateTowerPgWorkrooms(this, options);
      case 'workroom': return hydrateTowerPgWorkroom(this, id, options);
      case 'workroom-participants': return hydrateTowerPgWorkroomParticipants(this, id, options);
      case 'workspace': return this.runTowerPgWorkspaceSync(options);
      case 'wapp-activity': return hydrateTowerPgWappActivity(this, options);
      case 'wapp-mutes': return hydrateTowerPgWappActivity(this, options).then((result) => result.mutes || []);
      case 'wapp-publishing-grants': return hydrateTowerPgWappPublishingGrants(this, options);
      case 'drive-shares': return hydrateDriveShares(this);
      case 'personal-wapps': return hydrateTowerPgPersonalWapps(this, options);
      default: throw new Error(`TowerSyncService loader is not registered for ${family}`);
    }
  },

  requestTowerSyncFamily(family, id = '', options = {}) {
    // Network reads and worker round-trips must never inherit a live Dexie
    // transaction zone from the UI write that requested the refresh.
    return Dexie.ignoreTransaction(async () => {
      const service = this._towerSyncService || null;
      for (let attempt = 0; ; attempt++) {
        try {
          return await (service?.ensureLoaded(family, id, options)
            ?? this.loadTowerSyncTarget(family === 'workspace-bootstrap' ? 'workspace' : family, id, options));
        } catch (error) {
          if (!['pg_read_authority_changed', 'pg_read_authority_resetting'].includes(error?.code)) throw error;
          // Staging owns replacement authority. Join its coalesced pull before
          // re-reading; never commit the cancelled list or mark it fresh.
          if (attempt >= 2) {
            this.scheduleBackgroundSync?.(1000);
            return { deferred: true, family, id };
          }
          if (error.code === 'pg_read_authority_resetting') {
            await (service?.ensureLoaded('workspace-bootstrap', '', { force: true })
              ?? this.loadTowerSyncTarget('workspace', '', { force: true }));
          }
        }
      }
    });
  },

  async ensureTowerPgControlPlaneHydrated(options = {}) {
    const workspace = this.currentWorkspace || {};
    const workspaceId = String(workspace.workspaceId || workspace.workspace_id || '').trim();
    const pgWorkspaceActive = Boolean(this.isTowerPgMode || (isTowerPgBackendMode() && workspace.pgBackendMode));
    if (!pgWorkspaceActive || !workspaceId) return { skipped: true };

    const force = options.force === true;
    const familyOptions = force ? { force: true } : {};
    const scopes = await this.requestTowerSyncFamily('scopes', '', familyOptions);
    const channels = await this.requestTowerSyncFamily('channels', '', familyOptions);
    await this.loadLocalWorkspaceCoreData?.({ syncRoute: false });
    this.validateSelectedBoardId?.();
    if (this.navSection === 'chat') {
      this.ensureSelectedChatChannelInScope?.({ syncRoute: options.syncRoute !== false });
    }
    return { scopes, channels };
  },

  async loadTowerPgAgentActivities(channelId, options = {}) {
    const workspaceKey = this.buildSSEConnectionKey();
    const service = this._towerSyncService;
    const recover = options.recover ?? (!options.cursor && !options.threadId && !options.activityId);
    const visibleTarget = this.visibleAgentActivityTarget();
    const selection = JSON.stringify(visibleTarget);
    const stillCurrent = () => recover && !options.activityId
      && (!visibleTarget.channelId || visibleTarget.channelId === channelId)
      && workspaceKey === this.buildSSEConnectionKey()
      && selection === JSON.stringify(this.visibleAgentActivityTarget())
      && service === this._towerSyncService && !service?.disposed;
    try {
      const result = await hydrateTowerPgChannelAgentActivities(this, channelId, { ...options, recover });
      if (stillCurrent()) {
        this.agentActivityRecoveryError = '';
        this.agentActivityRecoveryAttempts = 0;
        this.agentActivityRecoveryPending = result.recovery_pending === true;
        if (!result.recovery_pending && ['connected', 'fallback-polling'].includes(this.sseStatus)) this.agentActivityRecoveryStartedAt = 0;
        if (result.recovery_pending) this.scheduleBackgroundSync(1000);
      }
      return result;
    } catch (error) {
      if (stillCurrent()) {
        this.agentActivityRecoveryStartedAt ||= Date.now();
        this.agentActivityRecoveryAttempts = Number(this.agentActivityRecoveryAttempts || 0) + 1;
        this.agentActivityRecoveryError = this.agentActivityRecoveryAttempts < 3
          ? 'Activity updates could not be recovered. Retrying.'
          : 'Activity updates could not be recovered. Retrying with background sync.';
        // Reuse the service's sole fallback timer. Fast retries are bounded;
        // continued recovery uses the normal background cadence.
        this.scheduleBackgroundSync(this.agentActivityRecoveryAttempts < 3
          ? 1000 * (2 ** (this.agentActivityRecoveryAttempts - 1)) : null);
      }
      throw error;
    }
  },

  visibleAgentActivityTarget() {
    if (this.navSection === 'status' && this.deckThreadChannelId && this.activeThreadId) {
      return { channelId: this.deckThreadChannelId, threadId: this.deckThreadTowerId || this.activeThreadId };
    }
    return { channelId: this.selectedChannelId };
  },

  async recoverVisibleAgentActivities() {
    const target = this.visibleAgentActivityTarget();
    if (!target.channelId) return;
    return Promise.all([
      this.requestTowerSyncFamily('channel-agent-activities', `${target.channelId}${target.threadId ? `:${target.threadId}` : ''}`, {
        ...target, force: true, recover: true,
      }),
      this.requestTowerSyncFamily('channel-agent-session-health', `${target.channelId}${target.threadId ? `:${target.threadId}` : ''}`, {
        ...target, force: true,
      }),
    ]);
  },

  async ensureThreadAgentActivityCoverage(channelId, threadId) {
    if (!channelId || !threadId) return;
    try {
      await Promise.allSettled([
        this.requestTowerSyncFamily('channel-agent-activities', `${channelId}:${threadId}`, {
          channelId, threadId, recover: true,
        }),
        this.requestTowerSyncFamily('channel-agent-session-health', `${channelId}:${threadId}`, {
          channelId, threadId,
        }),
      ]);
    } catch {
      // The activity loader exposes retry state without discarding messages.
    }
  },

  async loadThreadMessagesWithActivity(options) {
    const result = await hydrateTowerPgThreadMessages(this, options.channelId, options.threadId, options);
    void this.ensureThreadAgentActivityCoverage(options.channelId, options.threadId);
    return result;
  },

  beginStartupSyncProgress() {
    const connectionKey = this.buildSSEConnectionKey?.() || '';
    if (this.startupSyncProgress?.active && this.startupSyncProgress.connectionKey === connectionKey) return;
    if (this.startupSyncProgressTimer) clearTimeout(this.startupSyncProgressTimer);
    const startedAt = Date.now();
    const previousError = this.startupSyncProgress?.connectionKey === connectionKey
      ? this.startupSyncProgress.error || null : null;
    this.startupSyncProgress = {
      connectionKey,
      active: true,
      visible: Boolean(previousError),
      stage: 'opening',
      startedAt,
      elapsedMs: 0,
      page: 0,
      applied: 0,
      cursorPresent: false,
      fullSnapshot: false,
      // Keep a real failure stable while automatic retries run. Only a
      // successful pull clears it, avoiding a blinking error on every retry.
      error: previousError,
    };
    this.startupSyncProgressTimer = setTimeout(() => {
      if (!this.startupSyncProgress?.active) return;
      this.startupSyncProgress.visible = true;
      this.startupSyncProgress.elapsedMs = Date.now() - startedAt;
    }, STARTUP_SYNC_PROGRESS_DELAY_MS);
    flightDeckTrace('startup-sync', 'workspace sync started', { startedAt });
  },

  updateStartupSyncProgress(update = {}) {
    if (!this.startupSyncProgress?.active) this.beginStartupSyncProgress();
    Object.assign(this.startupSyncProgress, update, {
      elapsedMs: Date.now() - Number(this.startupSyncProgress.startedAt || Date.now()),
    });
    flightDeckTrace('startup-sync', `workspace sync ${update.stage || 'progress'}`, {
      stage: update.stage || this.startupSyncProgress.stage,
      page: update.page ?? this.startupSyncProgress.page,
      applied: update.applied ?? this.startupSyncProgress.applied,
      cursorPresent: update.cursorPresent ?? this.startupSyncProgress.cursorPresent,
      fullSnapshot: update.fullSnapshot ?? this.startupSyncProgress.fullSnapshot,
      hasMore: update.hasMore ?? null,
      requestDurationMs: update.requestDurationMs ?? null,
      applyDurationMs: update.applyDurationMs ?? null,
      elapsedMs: this.startupSyncProgress.elapsedMs,
    });
  },

  finishStartupSyncProgress(error = null) {
    if (this.startupSyncProgressTimer) clearTimeout(this.startupSyncProgressTimer);
    this.startupSyncProgressTimer = null;
    const elapsedMs = Date.now() - Number(this.startupSyncProgress?.startedAt || Date.now());
    if (error) {
      Object.assign(this.startupSyncProgress, {
        active: false,
        visible: true,
        stage: 'error',
        elapsedMs,
        error: error?.message || String(error),
      });
      flightDeckSyncFailure(this, 'warn', 'startup-sync', 'workspace sync failed', error, {
        elapsedMs,
        page: this.startupSyncProgress.page,
        cursorPresent: this.startupSyncProgress.cursorPresent,
        error: this.startupSyncProgress.error,
      });
      return;
    }
    Object.assign(this.startupSyncProgress, {
      active: false,
      visible: false,
      stage: 'complete',
      elapsedMs,
      error: null,
    });
    flightDeckTrace('startup-sync', 'workspace sync completed', {
      elapsedMs,
      pages: this.startupSyncProgress.page,
      applied: this.startupSyncProgress.applied,
      cursorPresent: this.startupSyncProgress.cursorPresent,
      fullSnapshot: this.startupSyncProgress.fullSnapshot,
    });
  },

  async runTowerPgWorkspaceSync(options = {}) {
    const service = this.getTowerSyncService();
    // Before a workspace service is available, retain bootstrap's existing
    // validation/error path; there is no active cursor owner to share yet.
    if (!service) return this.performTowerPgWorkspaceSync(options);
    // Context loads, startup and SSE recovery share one cursor/worker. Family
    // request coalescing alone cannot prevent two different entrypoints racing.
    if (options.afterCurrent) {
      await service.inFlight.get('workspace-record-recovery')?.catch(() => {});
      service.assertActive();
    }
    return service.coalesce('workspace-record-recovery', () => this.performTowerPgWorkspaceSync(options));
  },

  async performTowerPgWorkspaceSync(options = {}) {
    const connectionKey = this.buildSSEConnectionKey();
    this.beginStartupSyncProgress();
    const progress = this.startupSyncProgress;
    const isCurrent = () => connectionKey === this.buildSSEConnectionKey() && this.startupSyncProgress === progress;
    try {
      const service = this.getTowerSyncService();
      const result = await syncTowerPgWorkspace(this, {
        ...options,
        onProgress: (update) => {
          if (!isCurrent()) return;
          this.updateStartupSyncProgress(update);
          options.onProgress?.(update);
        },
      }, {
        hydrateTowerPgSyncBundle: (_store, bundle) => service.materialize('workspace-bundle', bundle, {
          workspaceDbKey: this.workspaceDbKey,
          store: this.buildTowerPgMaterializationStoreSnapshot(),
        }),
      });
      if (isCurrent()) this.finishStartupSyncProgress();
      // Every committed workspace pull is connectivity evidence, including
      // startup and SSE catch-up pulls outside the background polling tick.
      if (connectionKey && connectionKey === this.buildSSEConnectionKey() && !service.disposed) {
        this.markTowerReachabilityRecovered('workspace-sync-success', {
          refresh: false,
          fallbackUsable: this.sseStatus !== 'connected',
        });
      }
      return result;
    } catch (error) {
      if (isCurrent()) this.finishStartupSyncProgress(error);
      throw error;
    }
  },

  async retryStartupSync() {
    // Preserve the last real failure until a pull commits successfully.
    if (this.startupSyncProgress.active) return;
    try {
      return await this.requestTowerSyncFamily?.('workspace-bootstrap', '', { force: true });
    } catch (error) {
      // The pull owns failure status. Handle the UI action's rejection so it
      // cannot be mistaken for a bootstrap asset failure.
      return { failed: true, error: error?.message || String(error) };
    }
  },

  startupSyncProgressLabel() {
    const progress = this.startupSyncProgress || {};
    if (progress.error && progress.active) return 'Retrying updates…';
    if (progress.stage === 'opening') return 'Opening workspace…';
    if (progress.stage === 'receiving') return progress.page > 1 ? `Receiving changes (page ${progress.page})…` : 'Receiving changes…';
    if (progress.stage === 'applying') return 'Applying updates…';
    if (progress.stage === 'error') return 'Update stalled';
    return 'Updating…';
  },

  startupSyncProgressMeta() {
    const progress = this.startupSyncProgress || {};
    const details = [];
    const page = Number(progress.page || 0);
    const applied = Number(progress.applied || 0);
    if (page > 0) details.push(`Page ${page}`);
    if (applied > 0) details.push(`${applied.toLocaleString()} ${applied === 1 ? 'change' : 'changes'} applied`);
    return details.join(' · ');
  },

  commandTowerWorkspace(name, input = {}, options = {}) {
    const service = this.getTowerSyncService();
    if (!service) throw new Error('TowerSyncService is unavailable for the active workspace');
    // A command owns its transport, acknowledgement writes, and forced
    // materialisation lifecycle. Detach it from any ambient Dexie zone so the
    // foreign Tower/worker promises cannot outlive and prematurely commit the
    // caller's transaction.
    return Dexie.ignoreTransaction(() => service.command(name, input, options).then(async (result) => {
      if (this._recordDeltaAttentionActive && !result?.stale && name !== 'record-conflict.accept-remote') {
        try {
          await service.materialize('workspace-bundle', { protocol_version: 1, reconcile_commands: true }, {
            workspaceDbKey: this.workspaceDbKey, store: this.buildTowerPgMaterializationStoreSnapshot(),
          });
        } catch (error) { flightDeckLog('warn', 'sync', 'Acknowledgement reconciliation remains pending', { error: error.message }); }
      }
      return result;
    }));
  },

  get workspaceDbKey() {
    return this.currentWorkspaceKey || this.workspaceOwnerNpub || '';
  },

  get isEncryptedRecordSyncDisabled() {
    return isTowerPgBackendMode();
  },

  markEncryptedRecordSyncDisabled() {
    this.syncing = false;
    this.backgroundSyncInFlight = false;
    this.catchUpSyncActive = false;
    this.syncStatus = 'disabled';
    this.updateSyncSession?.({
      state: 'disabled',
      phase: 'idle',
      finishedAt: Date.now(),
      error: null,
      heartbeat: false,
    });
  },

  encryptedRecordRepairDisabledResult(extra = {}) {
    return {
      disabled: true,
      message: PG_RECORD_REPAIR_DISABLED_MESSAGE,
      ...extra,
    };
  },

  // --- access pruning on login ---

  async runAccessPruneOnLogin() {
    if (this.isEncryptedRecordSyncDisabled) return;
    if (!this.session?.npub || !this.workspaceOwnerNpub) return;
    await pruneOnLogin(this.session.npub, this.workspaceOwnerNpub, {
      workspaceDbKey: this.workspaceDbKey,
    });
  },

  // --- repair UI ---

  get repairFamilyOptions() {
    return SYNC_FAMILY_OPTIONS.filter((family) => !this.isStatusFamilyDisabled(family.id));
  },

  isRepairFamilySelected(familyId) {
    return this.repairSelectedFamilyIds.includes(familyId);
  },

  toggleRepairFamily(familyId) {
    this.repairError = null;
    this.repairNotice = '';
    if (this.isRepairFamilySelected(familyId)) {
      this.repairSelectedFamilyIds = this.repairSelectedFamilyIds.filter((candidate) => candidate !== familyId);
      return;
    }
    this.repairSelectedFamilyIds = [...this.repairSelectedFamilyIds, familyId];
  },

  selectAllRepairFamilies() {
    this.repairError = null;
    this.repairNotice = '';
    this.repairSelectedFamilyIds = this.repairFamilyOptions.map((family) => family.id);
  },

  clearRepairFamilies() {
    this.repairError = null;
    this.repairNotice = '';
    this.repairSelectedFamilyIds = [];
  },

  async probeTaskOnTowerAndRepair() {
    const taskId = String(this.repairTaskIdInput || '').trim();
    if (!taskId) {
      this.repairError = 'Enter a task ID.';
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.repairError = 'Configure workspace sync first.';
      return;
    }

    this.repairError = null;
    this.repairNotice = '';
    this.repairTaskProbeBusy = true;
    try {
      const result = await fetchRecordHistory({
        record_id: taskId,
        owner_npub: this.workspaceOwnerNpub,
        viewer_npub: this.session.npub,
      });
      const versions = Array.isArray(result?.versions) ? result.versions : [];
      const localPresent = this.tasks.some((task) => task.record_id === taskId);

      if (versions.length === 0) {
        this.repairError = 'Task not found on Tower for the current workspace/user view.';
        return;
      }

      if (localPresent) {
        this.repairNotice = `Task exists on Tower with ${versions.length} version${versions.length === 1 ? '' : 's'} and is already present locally.`;
        return;
      }

      const repairResult = await this.restoreFamiliesFromSuperBased(['task'], { confirm: false });
      if (repairResult.cancelled) return;

      const repairedLocalPresent = this.tasks.some((task) => task.record_id === taskId);
      this.repairNotice = repairedLocalPresent
        ? `Task exists on Tower with ${versions.length} version${versions.length === 1 ? '' : 's'}. Rebuilt the Tasks family and restored it locally.`
        : `Task exists on Tower with ${versions.length} version${versions.length === 1 ? '' : 's'}. Rebuilt the Tasks family, but the task still did not materialize locally.`;
    } catch (error) {
      this.repairError = error?.message || 'Failed to probe task history on Tower.';
    } finally {
      this.repairTaskProbeBusy = false;
    }
  },

  getRecordStatusFamilyLabel(familyId) {
    return getSyncFamily(familyId)?.label || familyId || 'Record';
  },

  buildWorkspaceSettingsStatusRecord() {
    const workspaceOwnerNpub = String(this.workspaceOwnerNpub || '').trim();
    const recordId = String(this.workspaceSettingsRecordId || '').trim();
    if (!workspaceOwnerNpub || !recordId) return null;
    return {
      workspace_owner_npub: workspaceOwnerNpub,
      record_id: recordId,
      owner_npub: workspaceOwnerNpub,
      workspace_name: String(this.workspaceProfileNameInput || this.currentWorkspace?.name || '').trim(),
      workspace_description: String(this.workspaceProfileDescriptionInput || this.currentWorkspace?.description || '').trim(),
      workspace_avatar_url: String(this.workspaceProfileAvatarInput || this.currentWorkspace?.avatarUrl || '').trim() || null,
      wingman_harness_url: String(this.workspaceHarnessUrl || '').trim(),
      wingman_harness_agent_npub: String(this.workspaceHarnessAgentNpub || '').trim(),
      triggers: Array.isArray(this.workspaceTriggers) ? this.workspaceTriggers : [],
      channel_order: Array.isArray(this.channelOrder) ? this.channelOrder : [],
      group_ids: Array.isArray(this.workspaceSettingsGroupIds) ? this.workspaceSettingsGroupIds : [],
      sync_status: Number(this.workspaceSettingsVersion || 0) > 0 ? 'pending' : 'unknown',
      record_state: 'active',
      version: Number(this.workspaceSettingsVersion || 0) || 0,
      updated_at: new Date().toISOString(),
    };
  },

  getLocalRecordsForStatusFamily(familyId) {
    if (this.isStatusFamilyDisabled(familyId)) return [];
    switch (familyId) {
      case 'settings': {
        const record = this.buildWorkspaceSettingsStatusRecord();
        return record ? [record] : [];
      }
      case 'task':
        return this.tasks || [];
      case 'flow':
        return this.flows || [];
      case 'document':
        return this.documents || [];
      case 'directory':
        return this.directories || [];
      case 'channel':
        return this.channels || [];
      case 'chat_message':
        return this.messages || [];
      case 'schedule':
        return this.schedules || [];
      case 'scope':
        return this.scopes || [];
      case 'report':
        return this.reports || [];
      case 'wapp':
        return this.wapps || [];
      case 'person':
        return this.persons || [];
      case 'organisation':
        return this.organisations || [];
      case 'opportunity':
        return this.opportunities || [];
      default:
        return [];
    }
  },

  isStatusFamilyDisabled(familyId) {
    switch (String(familyId || '').trim()) {
      case 'flow':
        return isFlightDeckSurfaceDisabled('flows');
      case 'approval':
        return isFlightDeckSurfaceDisabled('approvals');
      case 'schedule':
        return isFlightDeckSurfaceDisabled('schedules');
      case 'report':
        return isFlightDeckSurfaceDisabled('reports');
      case 'person':
      case 'organisation':
        return isFlightDeckSurfaceDisabled('people');
      case 'opportunity':
        return isFlightDeckSurfaceDisabled('opportunities');
      default:
        return false;
    }
  },

  getLocalStatusRecord(familyId, recordId) {
    return this.getLocalRecordsForStatusFamily(familyId).find((record) => record?.record_id === recordId) ?? null;
  },

  getRecordStatusChannelForRecord(localRecord, familyId) {
    if (!localRecord) return null;
    if (familyId === 'channel') return localRecord;
    if (familyId !== 'chat_message') return null;
    return this.channels.find((channel) => channel?.record_id === localRecord.channel_id) ?? null;
  },

  async getRecordStatusPendingWrites() {
    return getPendingWrites();
  },

  async openPendingWritesModal() {
    this.showAvatarMenu = false;
    if (this.isEncryptedRecordSyncDisabled) {
      this.pendingWritesModalOpen = false;
      this.error = PG_RECORD_SYNC_DISABLED_MESSAGE;
      return;
    }
    this.pendingWritesModalOpen = true;
    await this.refreshPendingWriteDiagnostics();
  },

  closePendingWritesModal() {
    this.pendingWritesModalOpen = false;
    this.pendingWritesError = null;
    this.pendingWritesNotice = '';
  },

  describePendingWriteRow(row) {
    const envelope = row?.envelope || {};
    const familyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
    const family = getSyncFamily(familyHash);
    const familyId = family?.id || familyHash || 'unknown';
    const recordId = String(row?.record_id || envelope.record_id || '').trim();
    const localRecord = this.getLocalStatusRecord(familyId, recordId);
    const title = String(
      localRecord?.title
      || localRecord?.name
      || localRecord?.subject
      || localRecord?.body
      || localRecord?.content
      || ''
    ).trim();
    const policyConfig = row?.checkout_policy_config || this.recordCheckoutPolicyConfig;
    const policy = resolveFlightDeckRecordCheckoutPolicy(familyHash, policyConfig, { recordId });
    const checkoutId = String(envelope.checkout?.checkout_id || '').trim();
    const version = Number(envelope.version ?? 0) || 0;
    const previousVersion = Number(envelope.previous_version ?? 0) || 0;
    const isCreateWrite = previousVersion <= 0;
    const checkoutMissing = policy === 'checkout_required' && !checkoutId && !isCreateWrite;
    return {
      rowId: row?.row_id ?? null,
      recordId,
      familyId,
      familyHash,
      familyLabel: family?.label || familyId,
      title: title ? (title.length > 96 ? `${title.slice(0, 93)}...` : title) : '',
      version,
      previousVersion,
      createdAt: row?.created_at || '',
      policy,
      checkoutId,
      checkoutMissing,
      syncBlocker: checkoutMissing
        ? 'checkout_required write is missing checkout_id'
        : '',
    };
  },

  async refreshPendingWriteDiagnostics() {
    this.pendingWritesBusy = true;
    this.pendingWritesError = null;
    try {
      const rows = await getPendingWrites();
      this.pendingWriteDiagnostics = rows
        .map((row) => this.describePendingWriteRow(row))
        .sort((left, right) => {
          if (left.checkoutMissing !== right.checkoutMissing) return left.checkoutMissing ? -1 : 1;
          return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
        });
      this.pendingWritesNotice = rows.length === 0 ? 'No pending writes.' : '';
    } catch (error) {
      this.pendingWritesError = error?.message || 'Failed to load pending writes.';
    } finally {
      this.pendingWritesBusy = false;
    }
  },

  async removeRecordStatusPendingWrite(rowId) {
    return removePendingWrite(rowId);
  },

  async discardPendingWrite(rowId) {
    const id = Number(rowId);
    if (!Number.isFinite(id)) return;
    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm('Discard this queued local write? This only removes the pending sync envelope; the local record row is not deleted.');
    if (!confirmed) return;
    this.pendingWritesBusy = true;
    this.pendingWritesError = null;
    try {
      await removePendingWrite(id);
      this.pendingWritesNotice = `Discarded pending write row ${id}.`;
      await this.refreshPendingWriteDiagnostics();
      await this.refreshSyncStatus({ refreshUnread: false });
    } catch (error) {
      this.pendingWritesError = error?.message || 'Failed to discard pending write.';
    } finally {
      this.pendingWritesBusy = false;
    }
  },

  getPendingWriteForceSyncTargets(rows = []) {
    const targets = new Map();
    for (const row of rows) {
      const envelope = row?.envelope || {};
      const familyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
      const family = getSyncFamily(familyHash);
      const recordId = String(row?.record_id || envelope.record_id || '').trim();
      if (!family?.id || !recordId) continue;
      const key = `${family.id}\u0000${recordId}`;
      if (targets.has(key)) continue;
      const diagnostic = this.describePendingWriteRow(row);
      targets.set(key, {
        familyId: family.id,
        recordId,
        label: diagnostic.title || recordId,
      });
    }
    return [...targets.values()];
  },

  getPendingWriteRepairTargets(rows = []) {
    const targets = new Map();
    for (const row of rows) {
      const envelope = row?.envelope || {};
      const familyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
      const family = getSyncFamily(familyHash);
      const recordId = String(row?.record_id || envelope.record_id || '').trim();
      if (!family?.id || !recordId) continue;
      const key = `${family.id}\u0000${recordId}`;
      const diagnostic = this.describePendingWriteRow(row);
      const target = targets.get(key) || {
        familyId: family.id,
        familyHash,
        recordId,
        label: diagnostic.title || recordId,
        rowIds: [],
      };
      if (row?.row_id != null) target.rowIds.push(row.row_id);
      targets.set(key, target);
    }
    return [...targets.values()];
  },

  getPendingWriteRowsForTarget(pendingWrites = [], target = {}) {
    const familyId = String(target?.familyId || '').trim();
    const familyHash = String(target?.familyHash || getSyncFamily(familyId)?.hash || '').trim();
    const recordId = String(target?.recordId || '').trim();
    if (!familyHash || !recordId) return [];
    return pendingWrites.filter((row) => {
      const envelope = row?.envelope || {};
      const rowFamilyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
      const rowRecordId = String(row?.record_id || envelope.record_id || '').trim();
      return rowFamilyHash === familyHash && rowRecordId === recordId;
    });
  },

  async getRecordStatusRelatedComments(recordId, targetFamilyHash) {
    const comments = await getCommentsByTarget(recordId);
    return comments.filter((comment) => comment?.target_record_family_hash === targetFamilyHash);
  },

  isLocalStatusRecordPresent(familyId, recordId) {
    return Boolean(this.getLocalStatusRecord(familyId, recordId));
  },

  getRecordStatusWriteGroupRefFromRecord(localRecord, familyId) {
    if (!localRecord) return '';
    if (familyId === 'task') {
      const preferred = getPreferredRecordWriteGroupForStore(this, localRecord)
        || localRecord.board_group_id
        || localRecord.group_ids?.[0]
        || '';
      return String(preferred || '').trim();
    }
    if (familyId === 'chat_message') {
      const channel = this.getRecordStatusChannelForRecord(localRecord, familyId);
      const preferred = typeof this.getPreferredChannelWriteGroup === 'function'
        ? this.getPreferredChannelWriteGroup(channel)
        : (channel?.group_ids?.[0] || '');
      return String(preferred || '').trim();
    }
    const preferred = getPreferredRecordWriteGroupForStore(this, localRecord)
      || localRecord.group_ids?.[0]
      || '';
    return String(preferred || '').trim();
  },

  getRecordStatusDeliveryGroupRefsFromRecord(localRecord, familyId) {
    if (!localRecord) return [];
    const source = familyId === 'chat_message'
      ? this.getRecordStatusChannelForRecord(localRecord, familyId)
      : localRecord;
    const refs = Array.isArray(source?.group_ids) ? source.group_ids : [];
    const resolveGroup = (groupRef) => (
      typeof this.resolveGroupId === 'function'
        ? this.resolveGroupId(groupRef)
        : String(groupRef || '').trim() || null
    );
    return [...new Set(refs.map((groupRef) => resolveGroup(groupRef)).filter(Boolean))];
  },

  resolveRecordStatusTaskScopeRef(localRecord) {
    if (!localRecord) return null;
    const scope = typeof this.getTaskBoardScopeFromTask === 'function'
      ? this.getTaskBoardScopeFromTask(localRecord)
      : null;
    return scope?.record_id
      || localRecord.scope_id
      || localRecord.scope_l5_id
      || localRecord.scope_l4_id
      || localRecord.scope_l3_id
      || localRecord.scope_l2_id
      || localRecord.scope_l1_id
      || null;
  },

  buildRecordStatusLocalRecord(localRecord, familyId, options = {}) {
    if (!localRecord) return null;
    if (familyId !== 'task') return localRecord;

    const bootstrap = options.bootstrap === true;
    const scopeRef = this.resolveRecordStatusTaskScopeRef(localRecord);
    const assignment = bootstrap && scopeRef && typeof this.buildTaskBoardAssignment === 'function'
      ? this.buildTaskBoardAssignment(scopeRef, localRecord)
      : null;
    const resolveGroup = (groupRef) => (
      typeof this.resolveGroupId === 'function'
        ? this.resolveGroupId(groupRef)
        : String(groupRef || '').trim() || null
    );
    const assignmentGroupIds = Array.isArray(assignment?.group_ids) ? assignment.group_ids : [];
    const localGroupIds = Array.isArray(localRecord.group_ids) ? localRecord.group_ids : [];
    const candidateGroupIds = [...new Set((assignmentGroupIds.length > 0 ? assignmentGroupIds : localGroupIds)
      .map((groupId) => resolveGroup(groupId))
      .filter(Boolean))];
    const resolvedBoardGroupId = resolveGroup(assignment?.board_group_id) || candidateGroupIds[0] || resolveGroup(localRecord.board_group_id);
    const nextGroupIds = resolvedBoardGroupId && !candidateGroupIds.includes(resolvedBoardGroupId)
      ? [resolvedBoardGroupId, ...candidateGroupIds]
      : candidateGroupIds;
    const nextShares = nextGroupIds.length > 0 && typeof this.buildScopeDefaultShares === 'function'
      ? this.buildScopeDefaultShares(nextGroupIds)
      : (assignment?.shares || localRecord.shares || []);

    return {
      ...localRecord,
      ...(assignment || {}),
      board_group_id: resolvedBoardGroupId || null,
      group_ids: nextGroupIds,
      shares: nextShares,
    };
  },

  getRecordStatusLocalVersion(localRecord) {
    const version = Number(localRecord?.version ?? 0);
    return Number.isFinite(version) && version > 0 ? version : 0;
  },

  getRecordStatusSubmitVersion(localRecord, options = {}) {
    const bootstrap = options.bootstrap === true;
    if (bootstrap) {
      return { version: 1, previousVersion: 0 };
    }
    const latestTowerVersion = Object.prototype.hasOwnProperty.call(options, 'latestTowerVersion')
      ? Math.max(0, Number(options.latestTowerVersion ?? 0) || 0)
      : Math.max(0, Number(this.recordStatusTowerLatestVersion ?? 0) || 0);
    const fallbackLocalVersion = Math.max(1, this.getRecordStatusLocalVersion(localRecord) || 1);
    const version = latestTowerVersion > 0 ? latestTowerVersion + 1 : fallbackLocalVersion;
    return {
      version,
      previousVersion: Math.max(0, version - 1),
    };
  },

  describeRecordStatusGroup(groupRef) {
    const resolvedGroupRef = typeof this.resolveGroupId === 'function' ? this.resolveGroupId(groupRef) : String(groupRef || '').trim();
    if (!resolvedGroupRef) return { ref: '', label: '', keyLoaded: false };
    const group = (this.groups || []).find((entry) => entry.group_id === resolvedGroupRef || entry.group_npub === resolvedGroupRef);
    const canonicalRef = String(group?.group_id || resolvedGroupRef).trim();
    const shortRef = canonicalRef.length > 18
      ? `${canonicalRef.slice(0, 8)}…${canonicalRef.slice(-6)}`
      : canonicalRef;
    const label = group?.name
      ? `${group.name} (${shortRef})`
      : canonicalRef;
    return {
      ref: canonicalRef,
      label,
      keyLoaded: hasGroupKey(resolvedGroupRef),
    };
  },

  describeRecordStatusDeliveryGroups(groupRefs = []) {
    const groups = groupRefs.map((groupRef) => this.describeRecordStatusGroup(groupRef)).filter((entry) => entry.ref);
    if (groups.length === 0) {
      return { summary: '', keySummary: '' };
    }
    const labels = groups.map((group) => group.label || group.ref);
    const loadedCount = groups.filter((group) => group.keyLoaded).length;
    return {
      summary: labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`,
      keySummary: `${loadedCount}/${groups.length} loaded`,
    };
  },

  async refreshRecordStatusLocalContext() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const rawLocalRecord = this.getLocalStatusRecord(familyId, recordId);
    const localRecord = this.buildRecordStatusLocalRecord(rawLocalRecord, familyId, { bootstrap: true });
    const groupInfo = this.describeRecordStatusGroup(this.getRecordStatusWriteGroupRefFromRecord(localRecord, familyId));
    const deliveryInfo = this.describeRecordStatusDeliveryGroups(this.getRecordStatusDeliveryGroupRefsFromRecord(localRecord, familyId));
    const pendingWrites = await this.getRecordStatusPendingWrites();
    const familyHash = getSyncFamily(familyId)?.hash;

    this.recordStatusLocalPresent = Boolean(rawLocalRecord);
    this.recordStatusLocalVersion = this.getRecordStatusLocalVersion(rawLocalRecord);
    this.recordStatusLocalSyncStatus = String(rawLocalRecord?.sync_status || '').trim() || 'unknown';
    this.recordStatusWriteGroupRef = groupInfo.ref;
    this.recordStatusWriteGroupLabel = groupInfo.label;
    this.recordStatusWriteGroupKeyLoaded = groupInfo.keyLoaded;
    this.recordStatusDeliveryGroupSummary = deliveryInfo.summary;
    this.recordStatusDeliveryGroupKeySummary = deliveryInfo.keySummary;
    this.recordStatusPendingWriteCount = pendingWrites.filter((row) => row.record_id === recordId && row.record_family_hash === familyHash).length;
    return { localRecord, rawLocalRecord, groupInfo, deliveryInfo };
  },

  canForcePushRecordStatusTarget() {
    if (!this.recordStatusTargetId || !this.recordStatusFamilyId || !this.recordStatusLocalPresent) return false;
    const localVersion = Number(this.recordStatusLocalVersion || 0) || 0;
    const towerVersion = Number(this.recordStatusTowerLatestVersion || 0) || 0;
    const towerCount = Number(this.recordStatusTowerVersionCount || 0) || 0;
    const hasLocalWriteState = this.recordStatusPendingWriteCount > 0
      || this.recordStatusLocalSyncStatus === 'pending'
      || this.recordStatusLocalSyncStatus === 'failed';

    if (towerCount === 0) return true;
    if (localVersion > towerVersion) return true;
    if (localVersion === towerVersion && hasLocalWriteState) return true;
    return false;
  },

  canRepairRecordStatusTargetFromTower() {
    return Boolean(
      this.recordStatusTargetId
      && this.recordStatusFamilyId
      && Number(this.recordStatusTowerVersionCount || 0) > 0
      && (
        !this.recordStatusLocalPresent
        || this.recordStatusPendingWriteCount > 0
        || this.recordStatusLocalSyncStatus === 'pending'
        || this.recordStatusLocalSyncStatus === 'failed'
        || (
          Number(this.recordStatusLocalVersion || 0) > 0
          && Number(this.recordStatusLocalVersion || 0) !== Number(this.recordStatusTowerLatestVersion || 0)
        )
      )
    );
  },

  canDeleteRecordStatusLocalTarget() {
    return Boolean(
      this.recordStatusTargetId
      && this.recordStatusFamilyId
      && (this.recordStatusLocalPresent || Number(this.recordStatusPendingWriteCount || 0) > 0)
    );
  },

  canDeleteRecordStatusTowerTarget() {
    return Boolean(
      this.recordStatusTargetId
      && this.recordStatusFamilyId
      && this.recordStatusLocalPresent
      && Number(this.recordStatusTowerVersionCount || 0) > 0
    );
  },

  getRecordStatusRecommendedResolution() {
    const localVersion = Number(this.recordStatusLocalVersion || 0) || 0;
    const towerVersion = Number(this.recordStatusTowerLatestVersion || 0) || 0;
    const towerCount = Number(this.recordStatusTowerVersionCount || 0) || 0;
    const hasLocalWriteState = this.recordStatusPendingWriteCount > 0
      || this.recordStatusLocalSyncStatus === 'pending'
      || this.recordStatusLocalSyncStatus === 'failed';

    if (this.recordStatusLocalPresent && towerCount === 0) return 'force_submit';
    if (!this.recordStatusLocalPresent && towerCount > 0) return 'use_tower';
    if (localVersion > towerVersion) return 'force_submit';
    if (towerVersion > localVersion) return 'use_tower';
    if (hasLocalWriteState) return 'force_submit';
    return 'none';
  },

  isRecordStatusForceSubmitRecommended() {
    return this.getRecordStatusRecommendedResolution() === 'force_submit';
  },

  isRecordStatusTowerResolutionRecommended() {
    return this.getRecordStatusRecommendedResolution() === 'use_tower';
  },

  getRecordStatusResolutionHint(targetLabel = 'This record') {
    const resolution = this.getRecordStatusRecommendedResolution();
    if (resolution === 'force_submit') {
      return `${targetLabel} has the newer local copy. Force submit is the recommended repair if this browser copy should win.`;
    }
    if (resolution === 'use_tower') {
      return `${targetLabel} has a newer or better Tower copy. Use Tower copy is the recommended repair.`;
    }
    return '';
  },

  getRecordStatusSubmitCheckoutPolicyConfig(familyId, options = {}) {
    const id = String(familyId || '').trim();
    if (id === 'task' && options.bootstrap !== true) {
      if (typeof this.getTaskDetailCheckoutPolicyConfig === 'function') {
        return this.getTaskDetailCheckoutPolicyConfig();
      }
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
    }
    return this.recordCheckoutPolicyConfig || null;
  },

  getTaskForceSubmitWriteGroupRefs(localRecord = null) {
    const resolveGroup = (groupRef) => (
      typeof this.resolveGroupId === 'function'
        ? this.resolveGroupId(groupRef)
        : String(groupRef || '').trim() || null
    );
    const preferred = typeof this.getPreferredRecordWriteGroup === 'function'
      ? resolveGroup(this.getPreferredRecordWriteGroup(localRecord))
      : null;
    const groupIds = Array.isArray(localRecord?.group_ids)
      ? localRecord.group_ids.map((groupId) => resolveGroup(groupId)).filter(Boolean)
      : [];
    return [...new Set([preferred, ...groupIds].filter(Boolean))];
  },

  isPriorVersionWriteAccessRejection(rejection = {}) {
    const code = String(rejection?.code || '').trim();
    const reason = String(rejection?.reason || rejection?.message || '').trim().toLowerCase();
    return code === 'write_forbidden' && reason.includes('write access on prior version');
  },

  async buildRecordStatusEnvelope(localRecord, familyId, options = {}) {
    if (!localRecord) throw new Error('Local record not found.');

    const bootstrap = options.bootstrap === true;
    const effectiveLocalRecord = this.buildRecordStatusLocalRecord(localRecord, familyId, { bootstrap });
    const channelRecord = this.getRecordStatusChannelForRecord(effectiveLocalRecord, familyId);
    const ownerNpub = effectiveLocalRecord.owner_npub || channelRecord?.owner_npub || this.workspaceOwnerNpub;
    const submitVersionOptions = { bootstrap };
    if (Object.prototype.hasOwnProperty.call(options, 'latestTowerVersion')) {
      submitVersionOptions.latestTowerVersion = options.latestTowerVersion;
    }
    const { version, previousVersion } = this.getRecordStatusSubmitVersion(effectiveLocalRecord, submitVersionOptions);
    const signatureNpub = this.signingNpub || this.session?.npub || ownerNpub;
    // owner_npub is a workspace service identity, not a person's npub.
    // All writes are non-owner and need write_group_ref for Tower auth.
    const realUserNpub = String(this.session?.npub || '').trim();
    const isOwnerWrite = realUserNpub === String(ownerNpub || '').trim();

    if (familyId === 'task') {
      const checkoutPolicyConfig = Object.prototype.hasOwnProperty.call(options, 'checkoutPolicyConfig')
        ? options.checkoutPolicyConfig
        : this.getRecordStatusSubmitCheckoutPolicyConfig(familyId, { bootstrap });
      const explicitWriteGroupRef = String(options.writeGroupRef || '').trim() || null;
      const writeFields = await getRecordWriteFieldsForStore(this, {
        ...effectiveLocalRecord,
        board_group_id: effectiveLocalRecord.board_group_id || effectiveLocalRecord.group_ids?.[0] || null,
      }, {
        label: 'Task force submit',
        ...(explicitWriteGroupRef ? {
          writeGroupRef: explicitWriteGroupRef,
          allowedGroupIds: [explicitWriteGroupRef],
        } : {}),
      });
      const nextShares = effectiveLocalRecord.shares || [];
      const writeGroupRef = writeFields.write_group_ref;
      if (!writeGroupRef) throw new Error('Task is missing a writable group.');
      const envelope = await outboundTask({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        board_group_id: effectiveLocalRecord.board_group_id || writeGroupRef,
        group_ids: writeFields.group_ids,
        shares: nextShares,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      });
      return typeof this.attachCheckoutRequiredCheckoutToEnvelope === 'function'
        ? this.attachCheckoutRequiredCheckoutToEnvelope(effectiveLocalRecord, envelope, {
          intent: 'retry',
          checkoutPolicyConfig,
        })
        : envelope;
    }

    if (familyId === 'document') {
      const shares = typeof this.getEffectiveDocShares === 'function'
        ? this.getEffectiveDocShares(localRecord)
        : (localRecord.shares || []);
      const groupIds = typeof this.getShareGroupIds === 'function'
        ? this.getShareGroupIds(shares)
        : (localRecord.group_ids || []);
      const writeGroupRef = typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef({ ...localRecord, shares, group_ids: groupIds })
        : (localRecord.write_group_id || groupIds?.[0] || null);
      if (!writeGroupRef) throw new Error('Document is missing a writable group.');
      return this.buildManagedDocumentEnvelope({
        ...localRecord,
        owner_npub: ownerNpub,
        shares,
        group_ids: groupIds,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      }, localRecord, { intent: 'retry' });
    }

    if (familyId === 'directory') {
      const shares = typeof this.getEffectiveDocShares === 'function'
        ? this.getEffectiveDocShares(localRecord)
        : (localRecord.shares || []);
      const groupIds = typeof this.getShareGroupIds === 'function'
        ? this.getShareGroupIds(shares)
        : (localRecord.group_ids || []);
      const writeGroupRef = typeof this.getPreferredDocWriteGroupRef === 'function'
        ? this.getPreferredDocWriteGroupRef({ ...localRecord, shares, group_ids: groupIds })
        : (localRecord.write_group_id || groupIds?.[0] || null);
      if (!writeGroupRef) throw new Error('Folder is missing a writable group.');
      return this.buildManagedDirectoryEnvelope({
        ...localRecord,
        owner_npub: ownerNpub,
        shares,
        group_ids: groupIds,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      }, localRecord, { intent: 'retry' });
    }

    if (familyId === 'channel') {
      const writeFields = await getRecordWriteFieldsForStore(this, effectiveLocalRecord, {
        label: 'Channel force submit',
        writeGroupRef: this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId),
      });
      const writeGroupRef = writeFields.write_group_ref;
      if (!writeGroupRef) throw new Error('Channel is missing a writable group.');
      return outboundChannel({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        group_ids: writeFields.group_ids,
        participant_npubs: effectiveLocalRecord.participant_npubs ?? [],
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      });
    }

    if (familyId === 'chat_message') {
      if (!channelRecord) throw new Error('Chat message channel is missing locally.');
      const writeFields = await getRecordWriteFieldsForStore(this, channelRecord, {
        label: 'Chat message force submit',
        writeGroupRef: this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId),
      });
      const writeGroupRef = writeFields.write_group_ref;
      if (!writeGroupRef) throw new Error('Chat message channel is missing a writable group.');
      return outboundChatMessage({
        record_id: effectiveLocalRecord.record_id,
        owner_npub: ownerNpub,
        channel_id: effectiveLocalRecord.channel_id,
        parent_message_id: effectiveLocalRecord.parent_message_id ?? null,
        body: effectiveLocalRecord.body ?? '',
        attachments: Array.isArray(effectiveLocalRecord.attachments) ? effectiveLocalRecord.attachments : [],
        channel_group_ids: writeFields.group_ids,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        record_state: effectiveLocalRecord.record_state ?? 'active',
      });
    }

    if (familyId === 'settings') {
      const writeGroupRef = this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId);
      if (!writeGroupRef) throw new Error('Workspace settings is missing a writable group.');
      const writeFields = await getRecordWriteFieldsForStore(this, effectiveLocalRecord, {
        label: 'Workspace settings force submit',
        writeGroupRef,
      });
      return outboundWorkspaceSettings({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        workspace_owner_npub: effectiveLocalRecord.workspace_owner_npub || ownerNpub,
        group_ids: writeFields.group_ids,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeFields.write_group_ref,
      });
    }

    if (familyId === 'flow') {
      const writeFields = await getRecordWriteFieldsForStore(this, effectiveLocalRecord, {
        label: 'Flow force submit',
        writeGroupRef: this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId),
      });
      const writeGroupRef = writeFields.write_group_ref;
      return outboundFlow({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        group_ids: writeFields.group_ids,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      });
    }

    if (familyId === 'wapp') {
      const writeFields = await getRecordWriteFieldsForStore(this, effectiveLocalRecord, {
        label: 'WApp force submit',
        writeGroupRef: this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId),
      });
      const writeGroupRef = writeFields.write_group_ref;
      if (!writeGroupRef) throw new Error('WApp is missing a writable group.');
      return outboundWapp({
        ...effectiveLocalRecord,
        record_owner_npub: this.workspaceOwnerNpub || effectiveLocalRecord.workspace_owner_npub || ownerNpub,
        group_ids: writeFields.group_ids,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      });
    }

    if (familyId === 'scope') {
      const writeFields = await getRecordWriteFieldsForStore(this, effectiveLocalRecord, {
        label: 'Scope force submit',
        writeGroupRef: this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId),
      });
      const writeGroupRef = writeFields.write_group_ref;
      if (!writeGroupRef) throw new Error('Scope is missing a writable group.');
      return outboundScope({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        group_ids: writeFields.group_ids,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : writeGroupRef,
      });
    }

    if (familyId === 'person' || familyId === 'organisation' || familyId === 'opportunity') {
      let writeGroupRef = this.getRecordStatusWriteGroupRefFromRecord(effectiveLocalRecord, familyId);
      let groupIds = effectiveLocalRecord.group_ids ?? [];
      // Fall back to workspace default group if the record has none
      if (!writeGroupRef && typeof this.getWorkspaceSettingsGroupRef === 'function') {
        writeGroupRef = this.getWorkspaceSettingsGroupRef();
        if (writeGroupRef) groupIds = [writeGroupRef];
      }
      const writeFields = await getRecordWriteFieldsForStore(this, {
        ...effectiveLocalRecord,
        group_ids: groupIds,
      }, {
        label: `${familyId} force submit`,
        writeGroupRef,
      });
      const shares = groupIds.length > 0 && typeof this.buildScopeDefaultShares === 'function'
        ? this.buildScopeDefaultShares(writeFields.group_ids)
        : (effectiveLocalRecord.shares || []);
      const outbound = familyId === 'person'
        ? outboundPerson
        : familyId === 'organisation'
          ? outboundOrganisation
          : outboundOpportunity;
      return outbound({
        ...effectiveLocalRecord,
        owner_npub: ownerNpub,
        group_ids: writeFields.group_ids,
        shares,
        version,
        previous_version: previousVersion,
        signature_npub: signatureNpub,
        write_group_ref: isOwnerWrite ? null : (writeFields.write_group_ref || null),
      });
    }

    throw new Error(`Force push is not implemented for ${this.getRecordStatusFamilyLabel(familyId)} yet.`);
  },

  async markRecordStatusLocalRecordSynced(familyId, localRecord, options = {}) {
    if (!localRecord) return;

    const nextRecord = {
      ...localRecord,
      sync_status: 'synced',
      version: options.version ?? localRecord.version ?? 1,
    };

    if (familyId === 'task') {
      await upsertTask(nextRecord);
      this.tasks = this.tasks.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      if (this.editingTask?.record_id === nextRecord.record_id) {
        this.replaceEditingTaskFromRecord?.(nextRecord);
      }
      return;
    }

    if (familyId === 'flow') {
      await upsertFlow(nextRecord);
      this.flows = this.flows.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'wapp') {
      await upsertWapp(nextRecord);
      this.wapps = this.wapps.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'scope') {
      await upsertScope(nextRecord);
      this.scopes = this.scopes.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'document') {
      await upsertDocument(nextRecord);
      if (typeof this.patchDocumentLocal === 'function') this.patchDocumentLocal(nextRecord);
      return;
    }

    if (familyId === 'directory') {
      await upsertDirectory(nextRecord);
      if (typeof this.patchDirectoryLocal === 'function') this.patchDirectoryLocal(nextRecord);
      return;
    }

    if (familyId === 'channel') {
      await upsertChannel(nextRecord);
      this.channels = this.channels.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'chat_message') {
      await upsertMessage(nextRecord);
      if (typeof this.patchMessageLocal === 'function') this.patchMessageLocal(nextRecord);
      else this.messages = this.messages.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'settings') {
      await upsertWorkspaceSettings(nextRecord);
      this.applyWorkspaceSettingsRow?.(nextRecord);
      return;
    }

    if (familyId === 'person') {
      await upsertPerson(nextRecord);
      this.persons = this.persons.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'organisation') {
      await upsertOrganisation(nextRecord);
      this.organisations = this.organisations.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
      return;
    }

    if (familyId === 'opportunity') {
      await upsertOpportunity(nextRecord);
      this.opportunities = this.opportunities.map((entry) => entry.record_id === nextRecord.record_id ? nextRecord : entry);
    }
  },

  async markRecordStatusCommentsSynced(comments = []) {
    if (!Array.isArray(comments) || comments.length === 0) return;
    for (const comment of comments) {
      await upsertComment({
        ...comment,
        sync_status: 'synced',
        version: 1,
      });
    }
    if (this.activeTaskId && this.recordStatusFamilyId === 'task' && this.recordStatusTargetId === this.activeTaskId) {
      await this.loadTaskComments(this.activeTaskId);
    }
    if (this.docsEditorOpen && this.selectedDocId && this.recordStatusTargetId === this.selectedDocId) {
      await this.loadDocComments(this.selectedDocId);
    }
  },

  async buildRecordStatusCommentEnvelope(comment, options = {}) {
    const targetGroupIds = Array.isArray(options.targetGroupIds) ? options.targetGroupIds : [];
    return outboundComment({
      ...comment,
      version: 1,
      previous_version: 0,
      target_group_ids: targetGroupIds,
      signature_npub: this.session?.npub,
      write_group_ref: null,
    });
  },

  async openRecordStatusModal(target = {}) {
    if (this.isEncryptedRecordSyncDisabled) {
      this.recordStatusModalOpen = false;
      this.error = PG_RECORD_REPAIR_DISABLED_MESSAGE;
      return;
    }
    const familyId = String(target?.familyId || '').trim();
    const recordId = String(target?.recordId || '').trim();
    const label = String(target?.label || '').trim();

    this.recordStatusModalOpen = true;
    this.recordStatusFamilyId = familyId;
    this.recordStatusTargetId = recordId;
    this.recordStatusTargetLabel = label;
    this.recordStatusError = null;
    this.recordStatusNotice = '';
    this.recordStatusTowerVersionCount = 0;
    this.recordStatusTowerLatestVersion = 0;
    this.recordStatusTowerUpdatedAt = '';
    await this.refreshRecordStatusLocalContext();

    await this.checkRecordStatusOnTower();
  },

  closeRecordStatusModal() {
    this.recordStatusModalOpen = false;
    this.recordStatusFamilyId = '';
    this.recordStatusTargetId = '';
    this.recordStatusTargetLabel = '';
    this.recordStatusBusy = false;
    this.recordStatusSyncBusy = false;
    this.recordStatusError = null;
    this.recordStatusNotice = '';
    this.recordStatusTowerVersionCount = 0;
    this.recordStatusTowerLatestVersion = 0;
    this.recordStatusTowerUpdatedAt = '';
    this.recordStatusLocalPresent = false;
    this.recordStatusLocalVersion = 0;
    this.recordStatusLocalSyncStatus = '';
    this.recordStatusPendingWriteCount = 0;
    this.recordStatusWriteGroupRef = '';
    this.recordStatusWriteGroupLabel = '';
    this.recordStatusWriteGroupKeyLoaded = false;
    this.recordStatusDeliveryGroupSummary = '';
    this.recordStatusDeliveryGroupKeySummary = '';
  },

  async checkRecordStatusOnTower() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const familyLabel = this.getRecordStatusFamilyLabel(familyId);
    const targetLabel = this.recordStatusTargetLabel || `${familyLabel} record`;

    if (!familyId || !recordId) {
      this.recordStatusError = 'Select a record first.';
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.recordStatusError = 'Configure workspace sync first.';
      return;
    }

    this.recordStatusBusy = true;
    this.recordStatusError = null;
    this.recordStatusNotice = '';
    try {
      const {
        visibleVersionCount,
        latestVersionNumber,
        latestUpdatedAt,
      } = await this.getRecordStatusTowerVersionContext(recordId);

      this.recordStatusTowerVersionCount = visibleVersionCount;
      this.recordStatusTowerLatestVersion = latestVersionNumber;
      this.recordStatusTowerUpdatedAt = latestUpdatedAt;
      await this.refreshRecordStatusLocalContext();

      if (visibleVersionCount === 0) {
        if (this.recordStatusLocalPresent) {
          this.recordStatusNotice = `${targetLabel} is missing on Tower. You can force submit this local snapshot as version 1.`;
        } else {
          this.recordStatusError = `${targetLabel} is not on Tower for the current workspace/user view.`;
        }
        return;
      }

      const hint = this.getRecordStatusResolutionHint(targetLabel);
      const suffix = hint ? ` ${hint}` : '';
      this.recordStatusNotice = this.recordStatusLocalPresent
        ? `${targetLabel} is on Tower with ${visibleVersionCount} version${visibleVersionCount === 1 ? '' : 's'}, and the local copy is present.${suffix}`
        : `${targetLabel} is on Tower with ${visibleVersionCount} version${visibleVersionCount === 1 ? '' : 's'}, but the local copy is missing.${suffix}`;
    } catch (error) {
      this.recordStatusError = error?.message || 'Failed to check record status on Tower.';
    } finally {
      this.recordStatusBusy = false;
    }
  },

  async getRecordStatusTowerVersionContext(recordId) {
    const result = await fetchRecordHistory({
      record_id: recordId,
      owner_npub: this.workspaceOwnerNpub,
      viewer_npub: this.session.npub,
    });
    const versions = Array.isArray(result?.versions) ? result.versions : [];
    const latestVersionNumber = versions.reduce((latest, current) => {
      const version = Number(current?.version ?? 0) || 0;
      return version > latest ? version : latest;
    }, 0);
    const visibleVersionCount = Math.max(versions.length, latestVersionNumber);
    const latestVersion = versions.reduce((latest, current) => {
      if (!latest) return current;
      const currentTime = Date.parse(current?.updated_at || '') || 0;
      const latestTime = Date.parse(latest?.updated_at || '') || 0;
      return currentTime >= latestTime ? current : latest;
    }, null);
    return {
      versions,
      visibleVersionCount,
      latestVersionNumber,
      latestUpdatedAt: latestVersion?.updated_at || '',
    };
  },

  async forcePushLocalRecordSnapshot(input = {}) {
    const familyId = String(input.familyId || '').trim();
    const recordId = String(input.recordId || '').trim();
    const rawLocalRecord = this.getLocalStatusRecord(familyId, recordId);
    const localRecord = this.buildRecordStatusLocalRecord(rawLocalRecord, familyId, { bootstrap: true });
    if (!familyId || !recordId) {
      throw new Error('Select a record first.');
    }
    if (!rawLocalRecord || !localRecord) {
      throw new Error('No local record is available to push.');
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      throw new Error('Configure workspace sync first.');
    }

    const familyLabel = this.getRecordStatusFamilyLabel(familyId);
    const hasExplicitTowerLatestVersion = Object.prototype.hasOwnProperty.call(input, 'towerLatestVersion');
    const bootstrap = Math.max(0, Number(input.towerVersionCount ?? this.recordStatusTowerVersionCount ?? 0) || 0) === 0;
    const latestTowerVersion = Math.max(0, Number(input.towerLatestVersion ?? this.recordStatusTowerLatestVersion ?? 0) || 0);
    const checkoutPolicyConfig = this.getRecordStatusSubmitCheckoutPolicyConfig(familyId, { bootstrap });
    const envelopeOptions = { bootstrap };
    if (hasExplicitTowerLatestVersion) envelopeOptions.latestTowerVersion = latestTowerVersion;
    if (checkoutPolicyConfig) envelopeOptions.checkoutPolicyConfig = checkoutPolicyConfig;
    const submitVersionOptions = { bootstrap };
    if (hasExplicitTowerLatestVersion) submitVersionOptions.latestTowerVersion = latestTowerVersion;
    const { version: submittedVersion } = this.getRecordStatusSubmitVersion(localRecord, submitVersionOptions);
    const targetFamilyHash = getSyncFamily(familyId)?.hash || null;
    const relatedComments = bootstrap && targetFamilyHash
      ? await this.getRecordStatusRelatedComments(recordId, targetFamilyHash)
      : [];
    const relevantRecordIds = new Set([recordId, ...relatedComments.map((comment) => comment.record_id)]);
    const allPendingWrites = Array.isArray(input.pendingWrites)
      ? input.pendingWrites
      : await this.getRecordStatusPendingWrites();
    const pendingWrites = allPendingWrites.filter((row) => relevantRecordIds.has(row.record_id));
    const commentEnvelopes = [];
    const targetWriteFields = await getRecordWriteFieldsForStore(this, localRecord, {
      label: `${familyLabel} comment force submit`,
    });
    const targetGroupIds = targetWriteFields.group_ids;

    for (const comment of relatedComments
      .slice()
      .sort((left, right) => {
        if (left.parent_comment_id && !right.parent_comment_id) return 1;
        if (!left.parent_comment_id && right.parent_comment_id) return -1;
        return String(left.created_at || left.updated_at || '').localeCompare(String(right.created_at || right.updated_at || ''));
      })) {
      commentEnvelopes.push(await this.buildRecordStatusCommentEnvelope(comment, { targetGroupIds }));
    }

    const taskWriteGroupAttempts = familyId === 'task' && !bootstrap
      ? this.getTaskForceSubmitWriteGroupRefs(localRecord)
      : [null];
    const writeGroupAttempts = taskWriteGroupAttempts.length > 0 ? taskWriteGroupAttempts : [null];
    let syncResult = null;
    let rejected = [];
    let deferredIds = new Set();
    let rejectedIds = new Set();
    let hasUnscopedRejection = false;

    for (let attemptIndex = 0; attemptIndex < writeGroupAttempts.length; attemptIndex += 1) {
      const attemptWriteGroupRef = writeGroupAttempts[attemptIndex];
      const envelope = await this.buildRecordStatusEnvelope(localRecord, familyId, {
        ...envelopeOptions,
        ...(attemptWriteGroupRef ? { writeGroupRef: attemptWriteGroupRef } : {}),
      });
      const { checkout: _staleCheckout, ...forceEnvelope } = envelope || {};
      const syncRequest = {
        owner_npub: this.workspaceOwnerNpub,
        records: [{ ...forceEnvelope, force_write: true }, ...commentEnvelopes],
      };
      if (checkoutPolicyConfig) syncRequest.checkout_policy_config = checkoutPolicyConfig;
      syncResult = await syncRecords(syncRequest);

      rejected = Array.isArray(syncResult?.rejected) ? syncResult.rejected : [];
      deferredIds = new Set(Array.isArray(syncResult?.deferred) ? syncResult.deferred : []);
      rejectedIds = new Set(rejected.map((entry) => String(entry?.record_id || '').trim()).filter(Boolean));
      hasUnscopedRejection = rejected.some((entry) => !String(entry?.record_id || '').trim());

      const targetRejection = rejected.find((entry) => String(entry?.record_id || '').trim() === recordId) || null;
      const shouldTryNextWriteGroup = familyId === 'task'
        && attemptIndex < writeGroupAttempts.length - 1
        && targetRejection
        && this.isPriorVersionWriteAccessRejection(targetRejection);
      if (!shouldTryNextWriteGroup) break;
    }

    const recordIds = [recordId, ...relatedComments.map((comment) => String(comment?.record_id || '').trim()).filter(Boolean)];
    const failedRecordIds = recordIds.filter((id) => rejectedIds.has(id) || deferredIds.has(id));
    const targetRejected = rejectedIds.has(recordId);
    const targetDeferred = deferredIds.has(recordId);
    const clearedRecordIds = [];

    for (const row of pendingWrites) {
      const pendingRecordId = String(row?.record_id || '').trim();
      if (!pendingRecordId) continue;
      if (hasUnscopedRejection) continue;
      if (rejectedIds.has(pendingRecordId)) continue;
      if (deferredIds.has(pendingRecordId)) continue;
      if (row?.row_id != null) await this.removeRecordStatusPendingWrite(row.row_id);
      clearedRecordIds.push(pendingRecordId);
    }

    if (targetRejected || targetDeferred || hasUnscopedRejection) {
      const firstRejected = rejected.find((entry) => String(entry?.record_id || '').trim() === recordId) || rejected[0] || null;
      const code = String(firstRejected?.code || '').trim();
      const reason = String(firstRejected?.reason || '').trim() || String(firstRejected?.message || '').trim();
      const detail = targetDeferred
        ? 'group key for the selected write group is not loaded yet'
        : reason || code || (hasUnscopedRejection ? 'Tower rejected the sync batch without record-level details' : 'Tower rejected this write');
      throw new Error(`Force submit rejected for ${familyLabel} ${recordId}: ${detail}.`);
    }

    await this.markRecordStatusLocalRecordSynced(familyId, localRecord, { version: submittedVersion });
    await this.markRecordStatusCommentsSynced(relatedComments);
    return {
      familyId,
      familyLabel,
      recordId,
      submittedVersion,
      pendingWriteCount: pendingWrites.length,
      relatedCommentCount: relatedComments.length,
      failedRecordIds,
      clearedRecordIds,
    };
  },

  async forcePushRecordStatusTarget() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const rawLocalRecord = this.getLocalStatusRecord(familyId, recordId);
    const localRecord = this.buildRecordStatusLocalRecord(rawLocalRecord, familyId, { bootstrap: true });
    if (!familyId || !recordId) {
      this.recordStatusError = 'Select a record first.';
      return;
    }
    if (!rawLocalRecord || !localRecord) {
      this.recordStatusError = 'No local record is available to push.';
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.recordStatusError = 'Configure workspace sync first.';
      return;
    }

    this.recordStatusSyncBusy = true;
    this.recordStatusError = null;
    try {
      const result = await this.forcePushLocalRecordSnapshot({
        familyId,
        recordId,
      });
      await this.checkRecordStatusOnTower();
      if (!this.recordStatusError) {
        const commentSuffix = result.relatedCommentCount > 0
          ? ` Recreated ${result.relatedCommentCount} local ${result.relatedCommentCount === 1 ? 'comment' : 'comments'} too.`
          : '';
        const failureSuffix = result.failedRecordIds.length > 0
          ? ` ${result.failedRecordIds.length} related ${result.failedRecordIds.length === 1 ? 'record was' : 'records were'} not accepted and left pending.`
          : '';
        this.recordStatusNotice = result.pendingWriteCount > 0
          ? `Force-submitted the current local snapshot as ${result.familyLabel} version ${result.submittedVersion} and cleared accepted pending writes.${commentSuffix}${failureSuffix}`
          : `Force-submitted the current local snapshot as ${result.familyLabel} version ${result.submittedVersion}.${commentSuffix}${failureSuffix}`;
      }
    } catch (error) {
      this.recordStatusError = error?.message || 'Failed to force push this record to Tower.';
    } finally {
      await this.refreshRecordStatusLocalContext();
      this.recordStatusSyncBusy = false;
    }
  },

  async repairRecordStatusTargetFromTower() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const familyLabel = this.getRecordStatusFamilyLabel(familyId);
    const targetLabel = this.recordStatusTargetLabel || `${familyLabel} record`;
    if (!familyId || !recordId) {
      this.recordStatusError = 'Select a record first.';
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.recordStatusError = 'Configure workspace sync first.';
      return;
    }
    if (Number(this.recordStatusTowerVersionCount || 0) <= 0) {
      this.recordStatusError = `${targetLabel} is not on Tower, so there is no Tower copy to restore.`;
      return;
    }

    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(`Use the Tower copy for ${targetLabel}? This clears queued local writes for this record and reloads the Tower version.`);
    if (!confirmed) return;

    this.recordStatusSyncBusy = true;
    this.recordStatusError = null;
    this.recordStatusNotice = `Repairing ${targetLabel} from Tower...`;
    try {
      const pendingWrites = await this.getRecordStatusPendingWrites();
      const result = await this.repairPendingWriteTargetsFromTower([
        { familyId, recordId, label: targetLabel },
      ], { pendingWrites, requirePendingRows: false });
      if (result?.disabled) {
        this.recordStatusError = result.message || PG_RECORD_REPAIR_DISABLED_MESSAGE;
        return;
      }
      await this.checkRecordStatusOnTower();
      if (!this.recordStatusError) {
        const clearedSuffix = result.cleared > 0
          ? ` Cleared ${result.cleared} queued local ${result.cleared === 1 ? 'write' : 'writes'}.`
          : '';
        this.recordStatusNotice = `Restored ${targetLabel} from Tower.${clearedSuffix}`;
      }
    } catch (error) {
      this.recordStatusError = error?.message || 'Failed to repair this record from Tower.';
    } finally {
      await this.refreshRecordStatusLocalContext();
      this.recordStatusSyncBusy = false;
    }
  },

  async deleteRecordStatusLocalState(familyId, recordId) {
    const familyHash = getSyncFamily(familyId)?.hash || '';
    const pendingWrites = await this.getRecordStatusPendingWrites();
    let cleared = 0;
    for (const row of pendingWrites) {
      const envelope = row?.envelope || {};
      const rowRecordId = String(row?.record_id || envelope.record_id || '').trim();
      const rowFamilyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
      if (rowRecordId !== recordId || rowFamilyHash !== familyHash) continue;
      if (row?.row_id == null) continue;
      await this.removeRecordStatusPendingWrite(row.row_id);
      cleared += 1;
    }
    const deleted = await deleteRuntimeRecordByFamily(familyId, recordId);
    await this.refreshStateForFamilies([familyId]);
    return { deleted, cleared };
  },

  async deleteRecordStatusLocalTarget() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const familyLabel = this.getRecordStatusFamilyLabel(familyId);
    const targetLabel = this.recordStatusTargetLabel || `${familyLabel} record`;
    if (!familyId || !recordId) {
      this.recordStatusError = 'Select a record first.';
      return;
    }

    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(`Delete ${targetLabel} from this Flight Deck browser only? This clears the local row and queued writes, but does not change Tower.`);
    if (!confirmed) return;

    this.recordStatusSyncBusy = true;
    this.recordStatusError = null;
    try {
      const result = await this.deleteRecordStatusLocalState(familyId, recordId);
      await this.refreshRecordStatusLocalContext();
      const clearedSuffix = result.cleared > 0
        ? ` Cleared ${result.cleared} queued local ${result.cleared === 1 ? 'write' : 'writes'}.`
        : '';
      this.recordStatusNotice = `Deleted ${targetLabel} from this Flight Deck browser.${clearedSuffix}`;
    } catch (error) {
      this.recordStatusError = error?.message || 'Failed to delete this record from Flight Deck.';
    } finally {
      this.recordStatusSyncBusy = false;
    }
  },

  async deleteRecordStatusTowerTarget() {
    const familyId = String(this.recordStatusFamilyId || '').trim();
    const recordId = String(this.recordStatusTargetId || '').trim();
    const familyLabel = this.getRecordStatusFamilyLabel(familyId);
    const targetLabel = this.recordStatusTargetLabel || `${familyLabel} record`;
    const rawLocalRecord = this.getLocalStatusRecord(familyId, recordId);
    const localRecord = this.buildRecordStatusLocalRecord(rawLocalRecord, familyId, { bootstrap: false });
    if (!familyId || !recordId) {
      this.recordStatusError = 'Select a record first.';
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.recordStatusError = 'Configure workspace sync first.';
      return;
    }
    if (Number(this.recordStatusTowerVersionCount || 0) <= 0) {
      this.recordStatusError = `${targetLabel} is not on Tower for this view, so there is no Tower record to delete.`;
      return;
    }
    if (!rawLocalRecord || !localRecord) {
      this.recordStatusError = `${targetLabel} has no local copy to sign a Tower delete. Use Tower copy first, then delete it.`;
      return;
    }

    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(`Delete ${targetLabel} from Tower and this Flight Deck browser? This writes a deleted version to Tower and clears queued local writes.`);
    if (!confirmed) return;

    this.recordStatusSyncBusy = true;
    this.recordStatusError = null;
    this.recordStatusNotice = `Deleting ${targetLabel} from Tower...`;
    try {
      const latestTowerVersion = Math.max(0, Number(this.recordStatusTowerLatestVersion || 0) || 0);
      const checkoutPolicyConfig = this.getRecordStatusSubmitCheckoutPolicyConfig(familyId, { bootstrap: false });
      const envelope = await this.buildRecordStatusEnvelope({
        ...localRecord,
        record_state: 'deleted',
      }, familyId, {
        latestTowerVersion,
        ...(checkoutPolicyConfig ? { checkoutPolicyConfig } : {}),
      });
      const syncRequest = {
        owner_npub: this.workspaceOwnerNpub,
        records: [envelope],
      };
      if (checkoutPolicyConfig) syncRequest.checkout_policy_config = checkoutPolicyConfig;
      const syncResult = await syncRecords(syncRequest);
      const rejected = Array.isArray(syncResult?.rejected) ? syncResult.rejected : [];
      const deferred = Array.isArray(syncResult?.deferred) ? syncResult.deferred : [];
      const targetRejected = rejected.find((entry) => String(entry?.record_id || '').trim() === recordId) || null;
      if (targetRejected || deferred.includes(recordId) || rejected.some((entry) => !String(entry?.record_id || '').trim())) {
        const detail = String(targetRejected?.reason || targetRejected?.message || targetRejected?.code || '').trim()
          || (deferred.includes(recordId) ? 'group key for the selected write group is not loaded yet' : 'Tower rejected the delete');
        throw new Error(detail);
      }

      const result = await this.deleteRecordStatusLocalState(familyId, recordId);
      this.recordStatusTowerVersionCount = latestTowerVersion + 1;
      this.recordStatusTowerLatestVersion = latestTowerVersion + 1;
      await this.refreshRecordStatusLocalContext();
      const clearedSuffix = result.cleared > 0
        ? ` Cleared ${result.cleared} queued local ${result.cleared === 1 ? 'write' : 'writes'}.`
        : '';
      this.recordStatusNotice = `Deleted ${targetLabel} from Tower and this Flight Deck browser.${clearedSuffix}`;
    } catch (error) {
      this.recordStatusError = error?.message || 'Failed to delete this record from Tower.';
    } finally {
      this.recordStatusSyncBusy = false;
    }
  },

  async forceSyncAllPendingWrites() {
    if (this.pendingWritesBusy) return;
    if (this.isEncryptedRecordSyncDisabled) {
      this.pendingWritesError = PG_RECORD_SYNC_DISABLED_MESSAGE;
      return;
    }
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.pendingWritesError = 'Configure workspace sync first.';
      return;
    }

    this.pendingWritesBusy = true;
    this.pendingWritesError = null;
    this.pendingWritesNotice = 'Force syncing pending writes...';
    try {
      const pendingWrites = await this.getRecordStatusPendingWrites();
      const targets = this.getPendingWriteForceSyncTargets(pendingWrites);
      if (targets.length === 0) {
        this.pendingWritesNotice = 'No pending writes.';
        return;
      }

      const { synced, cleared, attempted, failures } = await this.forceSyncPendingWriteTargets(targets, { pendingWrites });

      await this.refreshPendingWriteDiagnostics();
      await this.refreshSyncStatus({ refreshUnread: false });
      this.pendingWritesNotice = `Force synced ${synced}/${attempted} pending ${attempted === 1 ? 'record' : 'records'} and cleared ${cleared} queued ${cleared === 1 ? 'write' : 'writes'}.`;
      if (failures.length > 0) {
        const details = failures
          .slice(0, 5)
          .map((failure) => `${failure.label || failure.recordId}: ${failure.message}`)
          .join(' | ');
        const suffix = failures.length > 5 ? ` | +${failures.length - 5} more` : '';
        this.pendingWritesError = `Force sync failed for ${failures.length}/${attempted}: ${details}${suffix}`;
      }
    } catch (error) {
      this.pendingWritesError = error?.message || 'Failed to force sync pending writes.';
    } finally {
      this.pendingWritesBusy = false;
    }
  },

  async repairAllPendingWritesFromTower() {
    if (this.pendingWritesBusy) return;
    if (!this.workspaceOwnerNpub || !this.session?.npub) {
      this.pendingWritesError = 'Configure workspace sync first.';
      return;
    }
    if (this.isEncryptedRecordSyncDisabled) {
      this.pendingWritesError = PG_RECORD_REPAIR_DISABLED_MESSAGE;
      return;
    }

    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm('Repair Tower-backed pending writes? This discards queued local writes for records that already exist on Tower, then reloads those records from Tower. Records missing on Tower stay pending.');
    if (!confirmed) return;

    this.pendingWritesBusy = true;
    this.pendingWritesError = null;
    this.pendingWritesNotice = 'Repairing Tower-backed pending writes...';
    try {
      const pendingWrites = await this.getRecordStatusPendingWrites();
      const targets = this.getPendingWriteRepairTargets(pendingWrites);
      if (targets.length === 0) {
        this.pendingWritesNotice = 'No pending writes.';
        return;
      }

      const result = await this.repairPendingWriteTargetsFromTower(targets, { pendingWrites });
      if (result?.disabled) {
        this.pendingWritesError = result.message || PG_RECORD_REPAIR_DISABLED_MESSAGE;
        return;
      }

      await this.refreshPendingWriteDiagnostics();
      await this.refreshSyncStatus({ refreshUnread: false });
      const skippedSuffix = result.skippedMissing > 0
        ? ` ${result.skippedMissing} ${result.skippedMissing === 1 ? 'record is' : 'records are'} missing on Tower and stayed pending.`
        : '';
      this.pendingWritesNotice = `Repaired ${result.repaired}/${result.attempted} Tower-backed pending ${result.attempted === 1 ? 'record' : 'records'} and cleared ${result.cleared} queued ${result.cleared === 1 ? 'write' : 'writes'}.${skippedSuffix}`;
      if (result.failures.length > 0) {
        const details = result.failures
          .slice(0, 5)
          .map((failure) => `${failure.label || failure.recordId}: ${failure.message}`)
          .join(' | ');
        const suffix = result.failures.length > 5 ? ` | +${result.failures.length - 5} more` : '';
        this.pendingWritesError = `Repair failed for ${result.failures.length}/${result.attempted}: ${details}${suffix}`;
      }
    } catch (error) {
      this.pendingWritesError = error?.message || 'Failed to repair pending writes from Tower.';
    } finally {
      this.pendingWritesBusy = false;
    }
  },

  async repairPendingWriteTargetsFromTower(targets = [], options = {}) {
    if (this.isEncryptedRecordSyncDisabled) {
      this.pendingWritesError = PG_RECORD_REPAIR_DISABLED_MESSAGE;
      return this.encryptedRecordRepairDisabledResult({
        repaired: 0,
        cleared: 0,
        attempted: 0,
        skippedMissing: 0,
        failures: [],
      });
    }

    const pendingWrites = Array.isArray(options.pendingWrites)
      ? options.pendingWrites
      : await this.getRecordStatusPendingWrites();
    const requirePendingRows = options.requirePendingRows !== false;
    const wanted = new Map();
    for (const target of targets) {
      const familyId = String(target?.familyId || '').trim();
      const familyHash = String(target?.familyHash || getSyncFamily(familyId)?.hash || '').trim();
      const recordId = String(target?.recordId || '').trim();
      if (!familyId || !familyHash || !recordId) continue;
      const key = `${familyId}\u0000${recordId}`;
      if (wanted.has(key)) continue;
      wanted.set(key, {
        familyId,
        familyHash,
        recordId,
        label: String(target?.label || '').trim() || recordId,
      });
    }
    if (wanted.size === 0) {
      return { repaired: 0, cleared: 0, attempted: 0, skippedMissing: 0, failures: [] };
    }

    let repaired = 0;
    let cleared = 0;
    let attempted = 0;
    let skippedMissing = 0;
    const failures = [];
    const familiesToPull = new Set();

    for (const target of wanted.values()) {
      attempted += 1;
      try {
        const pendingRows = this.getPendingWriteRowsForTarget(pendingWrites, target);
        if (requirePendingRows && pendingRows.length === 0) continue;

        const towerContext = await this.getRecordStatusTowerVersionContext(target.recordId);
        if (towerContext.visibleVersionCount <= 0) {
          skippedMissing += 1;
          continue;
        }

        for (const row of pendingRows) {
          if (row?.row_id == null) continue;
          await this.removeRecordStatusPendingWrite(row.row_id);
          cleared += 1;
        }
        familiesToPull.add(target.familyId);
        repaired += 1;
      } catch (error) {
        failures.push({
          ...target,
          message: error?.message || 'Repair failed.',
        });
      }
    }

    const familyIds = [...familiesToPull];
    if (familyIds.length > 0) {
      await this.pullFamiliesFromBackend(familyIds, { forceFull: true });
      await this.refreshStateForFamilies(familyIds);
    }

    return { repaired, cleared, attempted, skippedMissing, failures };
  },

  async forceSyncPendingWriteTargets(targets = [], options = {}) {
    const pendingWrites = Array.isArray(options.pendingWrites)
      ? options.pendingWrites
      : await this.getRecordStatusPendingWrites();
    const wanted = new Map();
    for (const target of targets) {
      const familyId = String(target?.familyId || '').trim();
      const recordId = String(target?.recordId || '').trim();
      if (!familyId || !recordId) continue;
      const key = `${familyId}\u0000${recordId}`;
      if (wanted.has(key)) continue;
      wanted.set(key, {
        familyId,
        recordId,
        label: String(target?.label || '').trim() || recordId,
      });
    }
    if (wanted.size === 0) {
      return { synced: 0, cleared: 0, attempted: 0, failures: [] };
    }

    const pendingTargets = this.getPendingWriteForceSyncTargets(pendingWrites)
      .filter((target) => wanted.has(`${target.familyId}\u0000${target.recordId}`))
      .map((target) => ({
        ...target,
        label: wanted.get(`${target.familyId}\u0000${target.recordId}`)?.label || target.label,
      }));

    let synced = 0;
    let cleared = 0;
    let attempted = 0;
    const skippedRecordIds = new Set();
    const failures = [];

    for (const target of pendingTargets) {
      const targetKey = `${target.familyId}\u0000${target.recordId}`;
      if (skippedRecordIds.has(targetKey)) continue;
      attempted += 1;
      try {
        const towerContext = await this.getRecordStatusTowerVersionContext(target.recordId);
        const result = await this.forcePushLocalRecordSnapshot({
          familyId: target.familyId,
          recordId: target.recordId,
          label: target.label,
          towerVersionCount: towerContext.visibleVersionCount,
          towerLatestVersion: towerContext.latestVersionNumber,
          pendingWrites,
        });
        synced += 1;
        cleared += result.clearedRecordIds.length;
        for (const clearedRecordId of result.clearedRecordIds) {
          const familyId = clearedRecordId === result.recordId ? result.familyId : 'comment';
          skippedRecordIds.add(`${familyId}\u0000${clearedRecordId}`);
        }
      } catch (error) {
        failures.push({
          ...target,
          message: error?.message || 'Force sync failed.',
        });
      }
    }

    return { synced, cleared, attempted, failures };
  },

  // --- generic record version history ---

  async openRecordVersionHistory({ familyId, recordId, label }) {
    this.recordVersionModalOpen = true;
    this.recordVersionFamilyId = String(familyId || '').trim();
    this.recordVersionRecordId = String(recordId || '').trim();
    this.recordVersionLabel = String(label || '').trim();
    this.recordVersionHistory = [];
    this.recordVersionLoading = true;
    this.recordVersionError = null;
    this.recordVersionSelectedIndex = -1;

    try {
      const ownerNpub = this.workspaceOwnerNpub || this.session?.npub;
      if (!ownerNpub) {
        this.recordVersionError = 'No workspace owner configured.';
        return;
      }
      const result = await fetchRecordHistory({
        record_id: this.recordVersionRecordId,
        owner_npub: ownerNpub,
        viewer_npub: this.session?.npub,
      });
      const versions = Array.isArray(result?.versions) ? result.versions : [];
      const decoded = [];
      for (const ver of versions) {
        try {
          const payload = await decryptRecordPayload(ver);
          const data = payload.data ?? payload;
          decoded.push({
            version: ver.version ?? 0,
            updated_at: ver.updated_at || '',
            data,
          });
        } catch {
          decoded.push({
            version: ver.version ?? 0,
            updated_at: ver.updated_at || '',
            data: null,
            decryptError: true,
          });
        }
      }
      decoded.sort((a, b) => b.version - a.version);
      this.recordVersionHistory = decoded;
      if (decoded.length > 0) this.recordVersionSelectedIndex = 0;
    } catch (error) {
      this.recordVersionError = error?.status === 404
        ? 'Version history not available — Tower may need redeployment.'
        : `Failed to load version history: ${error?.message || error}`;
    } finally {
      this.recordVersionLoading = false;
    }
  },

  closeRecordVersionHistory() {
    this.recordVersionModalOpen = false;
    this.recordVersionFamilyId = '';
    this.recordVersionRecordId = '';
    this.recordVersionLabel = '';
    this.recordVersionHistory = [];
    this.recordVersionLoading = false;
    this.recordVersionError = null;
    this.recordVersionSelectedIndex = -1;
  },

  selectRecordVersion(index) {
    if (index < 0 || index >= this.recordVersionHistory.length) return;
    this.recordVersionSelectedIndex = index;
  },

  get selectedRecordVersion() {
    if (this.recordVersionSelectedIndex < 0) return null;
    return this.recordVersionHistory[this.recordVersionSelectedIndex] ?? null;
  },

  formatRecordVersionField(key, value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) {
      if (value.length === 0) return '(empty)';
      return JSON.stringify(value, null, 2);
    }
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  },

  copyRecordVersionJson() {
    const ver = this.selectedRecordVersion;
    if (!ver?.data) return;
    navigator.clipboard.writeText(JSON.stringify(ver.data, null, 2)).catch(() => {});
  },

  // --- sync quarantine ---

  get hasSyncQuarantine() {
    return this.syncQuarantine.length > 0;
  },

  syncQuarantineFamilyLabel(entry) {
    return getSyncFamily(entry?.family_id || entry?.family_hash)?.label || entry?.family_id || entry?.family_hash || 'Unknown family';
  },

  syncQuarantineRecordLabel(entry) {
    const recordId = String(entry?.record_id || '').trim();
    if (!recordId) return 'Unknown record';
    return recordId.length > 16 ? `${recordId.slice(0, 8)}…${recordId.slice(-4)}` : recordId;
  },

  formatSyncQuarantineTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  },

  async refreshSyncQuarantine() {
    this.syncQuarantine = await getSyncQuarantineEntries();
    return this.syncQuarantine;
  },

  // --- SSE lifecycle ---

  get isSSEConnected() {
    return this.sseStatus === 'connected';
  },

  getSSEConnectionContext() {
    if (!this.session?.npub || !this.backendUrl || !this.workspaceOwnerNpub) return null;
    const workspaceId = String(this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id || '').trim();
    if (this.isEncryptedRecordSyncDisabled && !workspaceId) return null;
    return {
      ownerNpub: this.workspaceOwnerNpub,
      viewerNpub: this.session.npub,
      backendUrl: this.backendUrl,
      workspaceDbKey: this.workspaceDbKey,
      workspaceId,
      checkoutPolicyConfig: this.recordCheckoutPolicyConfig || null,
    };
  },

  buildSSEConnectionKey(context = this.getSSEConnectionContext()) {
    if (!context) return '';
    return JSON.stringify({
      ownerNpub: context.ownerNpub,
      viewerNpub: context.viewerNpub,
      backendUrl: context.backendUrl,
      workspaceDbKey: context.workspaceDbKey || context.ownerNpub,
      workspaceId: context.workspaceId || null,
      pgMode: this.isEncryptedRecordSyncDisabled,
      checkoutPolicyConfig: context.checkoutPolicyConfig || null,
    });
  },

  logSSELifecycle(status, message = {}) {
    const details = {
      connectionKey: message?.connectionKey || this.sseConnectionKey || null,
      phase: message?.phase || null,
      reason: message?.reason || null,
      attempt: message?.attempt ?? null,
      delayMs: message?.delayMs ?? null,
      probeDelayMs: message?.probeDelayMs ?? null,
      failure: message?.failure || null,
      forced: message?.forced ?? null,
    };
    flightDeckTrace('sse', `SSE ${status}`, details);
    if (status !== 'fallback-polling') return;

    flightDeckLog('warn', 'sse', 'SSE entered fallback polling mode', details);
  },

  async connectSSEStream(options = {}) {
    const context = this.getSSEConnectionContext();
    if (!context) return false;

    const reason = String(options?.reason || 'ensure-background-sync');
    const force = Boolean(options?.force);
    const connectionKey = this.buildSSEConnectionKey(context);
    const activeStatuses = new Set(['connecting', 'connected', 'reconnecting', 'token-needed']);

    if (!force && this.sseConnectInFlightKey === connectionKey) {
      this.logSSELifecycle('connecting', {
        connectionKey,
        phase: 'connect-skipped',
        reason: 'connect-in-flight',
      });
      return false;
    }

    if (!force && this.sseConnectionKey === connectionKey && activeStatuses.has(this.sseStatus)) {
      this.logSSELifecycle(this.sseStatus, {
        connectionKey,
        phase: 'connect-skipped',
        reason: 'connection-already-active',
      });
      return false;
    }

    this.sseConnectInFlightKey = connectionKey;

    let workspaceCursorFallback = null;
    if (this.isEncryptedRecordSyncDisabled) {
      let cursor = null;
      try {
        cursor = await getSyncState(towerPgSyncCursorKey(this));
      } catch {
        // The worker can still restore a durable SSE acknowledgement cursor.
      }
      if (connectionKey !== this.buildSSEConnectionKey(this.getSSEConnectionContext())) {
        if (this.sseConnectInFlightKey === connectionKey) this.sseConnectInFlightKey = null;
        return false;
      }
      if (cursor != null && String(cursor).trim()) {
        let backendOrigin = '';
        try { backendOrigin = new URL(context.backendUrl).origin; } catch { backendOrigin = ''; }
        workspaceCursorFallback = {
          cursor: String(cursor),
          backendOrigin,
          workspaceId: context.workspaceId,
          ownerNpub: context.ownerNpub,
          viewerNpub: context.viewerNpub,
          workspaceDbKey: context.workspaceDbKey,
        };
      }
    }

    setSSEStatusCallback((message) => this.handleSSEStatus(message));
    this.sseConnectionKey = connectionKey;
    connectSSE(
      context.ownerNpub,
      context.viewerNpub,
      context.backendUrl,
      context.workspaceDbKey,
      {
        force,
        reason,
        checkoutPolicyConfig: context.checkoutPolicyConfig,
        pgMode: this.isEncryptedRecordSyncDisabled,
        workspaceId: context.workspaceId,
        workspaceCursorFallback,
      },
    );
    return true;
  },

  async answerSSETokenRequest(message) {
    const requestId = String(message?.requestId || '').trim();
    const signingUrl = String(message?.signingUrl || '').trim();
    const connectionKey = String(message?.connectionKey || '').trim();
    const context = this.getSSEConnectionContext();
    if (!requestId || !signingUrl || !connectionKey || !context) return false;
    if (connectionKey !== this.sseConnectionKey || connectionKey !== this.buildSSEConnectionKey(context)) return false;
    if (!validateSSESigningUrl(signingUrl, {
      backendUrl: context.backendUrl,
      pgMode: this.isEncryptedRecordSyncDisabled,
      workspaceId: context.workspaceId,
      ownerNpub: context.ownerNpub,
    })) {
      flightDeckLog('error', 'sse', 'SSE signing target rejected', {
        connectionKey,
        reason: 'unexpected-stream-target',
      });
      rejectSSEToken(requestId, connectionKey, 'unexpected-stream-target');
      return false;
    }

    this.sseTokenRequestId = requestId;
    const workspaceSecret = getActiveWorkspaceKeySecretForAuth();
    let authHeader;
    try {
      authHeader = workspaceSecret
        ? await createNip98AuthHeaderForSecret(resolveTowerSigningUrl(signingUrl), 'GET', null, workspaceSecret)
        : await createNip98AuthHeader(resolveTowerSigningUrl(signingUrl), 'GET', null);
    } catch (err) {
      if (this.sseTokenRequestId === requestId) this.sseTokenRequestId = null;
      flightDeckLog('error', 'sse', 'SSE auth failed — cannot mint NIP-98 token', {
        connectionKey,
        reason: message?.reason || 'token-needed',
        error: err?.name || 'Error',
        errorCode: err?.code || null,
      });
      rejectSSEToken(requestId, connectionKey, err?.code || err?.name || 'signing-failed');
      return false;
    }

    const latestContext = this.getSSEConnectionContext();
    const latestWorkspaceSecret = getActiveWorkspaceKeySecretForAuth();
    if (
      this.sseTokenRequestId !== requestId
      || connectionKey !== this.sseConnectionKey
      || connectionKey !== this.buildSSEConnectionKey(latestContext)
      || latestWorkspaceSecret !== workspaceSecret
    ) {
      return false;
    }
    this.sseTokenRequestId = null;
    provideSSEToken(requestId, connectionKey, authHeader.replace(/^Nostr\s+/i, ''));
    return true;
  },

  disconnectSSEStream(reason = 'client-disconnect') {
    this.sseConnectInFlightKey = null;
    this.sseConnectionKey = null;
    this.sseTokenRequestId = null;
    disconnectSSE({ reason });
    this.sseStatus = 'disconnected';
  },

  handleSSEStatus(message) {
    const status = message?.status;
    if (!status) return;

    const messageConnectionKey = String(message?.connectionKey || '');
    const activeConnectionKey = this.buildSSEConnectionKey(this.getSSEConnectionContext());
    if (messageConnectionKey && activeConnectionKey && messageConnectionKey !== activeConnectionKey) {
      this.logSSELifecycle('stale-event-ignored', {
        ...message,
        reason: `stale-${status}`,
      });
      return;
    }

    if (message?.connectionKey) {
      if (status === 'disconnected') {
        if (this.sseConnectionKey === message.connectionKey) this.sseConnectionKey = null;
      } else {
        this.sseConnectionKey = message.connectionKey;
      }
      this.discardStaleTowerPgSSEHydrationWork(message.connectionKey);
    }

    if (message?.connectionKey && this.sseConnectInFlightKey === message.connectionKey) {
      this.sseConnectInFlightKey = null;
    }

    // Worker notifications such as pull-complete and cursor-acknowledged
    // describe work performed by an otherwise healthy EventSource. Keeping
    // them out of the connection lifecycle prevents the fallback poller from
    // treating every live PG event as an SSE disconnect.
    if (SSE_LIFECYCLE_STATUSES.has(status)) {
      this.sseStatus = status;
      if (status !== 'connected') this.agentActivityRecoveryStartedAt ||= Date.now();
    }
    this.logSSELifecycle(status, message);

    if (status === 'pull-complete') {
      if (this.isEncryptedRecordSyncDisabled) {
        return this.queueTowerPgSSEHydration(message?.pgEvents || [], message);
      }
      this.refreshStateForSyncFamilyHashes(message?.families || [], {
        refreshSyncStatus: false,
        refreshRecentChanges: false,
      }).catch((error) => {
        flightDeckLog('warn', 'sse', 'failed to refresh local state after SSE pull', {
          error: error?.message || String(error),
        });
      });
      return;
    }

    if (status === 'catch-up-required') {
      // Recover through the existing cursor path without replacing the usable
      // workspace with an interaction-blocking reconnect screen.
      this.catchUpSyncActive = false;
      this.markTowerReachabilityDegraded?.('sse-catch-up-required', 'reconnecting');
      this.scheduleBackgroundSync(50);
      return;
    }

    if (status === 'group-changed') {
      this.refreshGroups({ minIntervalMs: 0 });
      return;
    }

    if (status === 'token-needed') {
      return this.answerSSETokenRequest(message);
    }

    if (status === 'connected') {
      const pgHydration = this.isEncryptedRecordSyncDisabled
        ? this.queueTowerPgSSEHydration([])
        : null;
      this.markTowerReachabilityRecovered?.('sse-connected', { refresh: false, fallbackUsable: false });
      // Widen heartbeat polling now that SSE is live
      this.scheduleBackgroundSync();
      return pgHydration;
    }

    if (status === 'reconnecting' || status === 'disconnected') {
      const currentConnectionKey = this.buildSSEConnectionKey?.() || '';
      const fallbackIsUsable = this.towerFallbackReachable === true
        && (!this.towerReachabilityConnectionKey || this.towerReachabilityConnectionKey === currentConnectionKey);
      if (!fallbackIsUsable) {
        this.markTowerReachabilityDegraded?.(`sse-${status}`, 'reconnecting');
      }
      this.scheduleBackgroundSync(50);
      return;
    }

    if (status === 'fallback-polling') {
      const currentConnectionKey = this.buildSSEConnectionKey?.() || '';
      const fallbackIsUsable = this.towerFallbackReachable === true
        && (!this.towerReachabilityConnectionKey || this.towerReachabilityConnectionKey === currentConnectionKey);
      if (!fallbackIsUsable) {
        this.markTowerReachabilityDegraded?.('sse-fallback-polling', 'reconnecting');
      }
      // SSE gave up reconnecting — tighten polling back to normal cadence
      this.scheduleBackgroundSync();
      return;
    }
  },

  queueTowerPgSSEHydration(pgEvents = [], batch = null, options = {}) {
    if (!Array.isArray(this.pendingTowerPgSSEHydrations)) this.pendingTowerPgSSEHydrations = [];
    const events = Array.isArray(pgEvents) ? pgEvents : [];
    for (const event of events) {
      if (event?.entity_type === 'message' && event?.entity_id) {
        if (!(this.flightDeckTimingMessageIds instanceof Set)) this.flightDeckTimingMessageIds = new Set();
        this.flightDeckTimingMessageIds.add(String(event.entity_id));
      }
      flightDeckTrace('message-timing', 'PG SSE event received', {
        cursor: event?.cursor ?? null,
        entityType: event?.entity_type || null,
        entityId: event?.entity_id || null,
        channelId: event?.channel_id || event?.payload?.channel_id || null,
        outboxCreatedAt: event?.created_at || event?.outbox_created_at || null,
        rowVersion: event?.row_version ?? event?.version ?? null,
        browserReceivedAt: event?.browser_received_at || null,
      });
    }
    const batches = batch?.batchId
      ? [{
        batchId: batch.batchId,
        connectionKey: batch.connectionKey || this.sseConnectionKey || null,
        connectionGeneration: batch.connectionGeneration,
        requestedCursor: batch.requestedCursor || null,
        receivedCursor: batch.receivedCursor || null,
        receivedAt: batch.receivedAt || null,
      }]
      : [];
    if (events.length > 0 || options.drainOnly !== true) {
      this.pendingTowerPgSSEHydrations.push({
        events,
        batches,
        fallbackRefreshRequested: events.length === 0,
        connectionKey: batch?.connectionKey || this.sseConnectionKey || null,
        attempt: Number(options.attempt || 0),
        activationGeneration: this._workspaceSelectionGeneration,
        activationService: this._towerSyncService,
      });
    }
    if (this.towerPgSSEHydrationPromise) return this.towerPgSSEHydrationPromise;

    this.towerPgSSEHydrationPromise = this.drainTowerPgSSEHydrationQueue()
      .finally(() => {
        this.towerPgSSEHydrationPromise = null;
        if (this.pendingTowerPgSSEHydrations?.length) {
          this.queueTowerPgSSEHydration([], null, { drainOnly: true });
        }
      });
    return this.towerPgSSEHydrationPromise;
  },

  async drainTowerPgSSEHydrationQueue() {
    while (this.pendingTowerPgSSEHydrations?.length) {
      const item = this.pendingTowerPgSSEHydrations.shift();
      const events = item.events || [];
      const batches = item.batches || [];
      const fallbackRefreshRequested = item.fallbackRefreshRequested === true;
      const connectionKey = item.connectionKey || null;
      const isCurrent = () => (!connectionKey || connectionKey === this.sseConnectionKey)
        && item.activationGeneration === this._workspaceSelectionGeneration
        && item.activationService === this._towerSyncService && !item.activationService?.disposed;
      if (!isCurrent()) continue;
      if (connectionKey && connectionKey !== this.sseConnectionKey) {
        flightDeckLog('warn', 'sse', 'discarded stale PG SSE materialisation work after context switch', {
          materialisationBatchIds: batches.map((entry) => entry.batchId),
        });
        continue;
      }
      try {
        const hydrationStartedAt = new Date().toISOString();
        flightDeckTrace('message-timing', 'targeted hydration started', {
          hydrationStartedAt,
          messageIds: events.filter((event) => event?.entity_type === 'message').map((event) => event?.entity_id).filter(Boolean),
        });
        const replayBurst = events.length > PG_SSE_TARGETED_EVENT_LIMIT;
        const targetedOnlyEvents = replayBurst
          ? events.filter((event) => PG_SSE_TARGETED_ONLY_ENTITY_TYPES.has(String(event?.entity_type || '').trim()))
          : events;
        const eventResult = targetedOnlyEvents.length > 0
          ? await hydrateTowerPgEventUpdates(this, targetedOnlyEvents)
          : { fallbackEvents: 0 };
        if (!isCurrent()) continue;
        const targetRecoveryRequired = Boolean(eventResult?.absentTargets?.length || eventResult?.optionalFailures?.length);
        if (targetRecoveryRequired) flightDeckLog('warn', 'sse', 'reconciling failed optional targets through workspace sync', {
          absentTargets: eventResult.absentTargets?.map(({ family, id }) => ({ family, id })),
          failures: eventResult.optionalFailures?.map(({ family, id, error }) => ({ family, id, error: error?.message, code: error?.code, status: error?.status })),
        });
        const deltaRequested = targetRecoveryRequired || fallbackRefreshRequested
          || replayBurst
          || Number(eventResult?.fallbackEvents || 0) > 0;
        const recentEventDelta = !events.some(event => ['context_component', 'context_reference'].includes(event?.entity_type)) && !targetRecoveryRequired && deltaRequested
          && Date.now() - Number(this.towerPgLastReplayDeltaAt || 0) < 30_000;
        const ranWorkspaceDelta = deltaRequested && !recentEventDelta;
        if (ranWorkspaceDelta) {
          const recovery = await (this.requestTowerSyncFamily?.('workspace-bootstrap', '', { force: targetRecoveryRequired }) ?? this.runTowerPgWorkspaceSync());
          if (recovery?.deferred) throw Object.assign(new Error('Workspace recovery deferred'), { code: 'pg_read_authority_changed' });
          this.towerPgLastReplayDeltaAt = Date.now();
        }
        if (!isCurrent()) continue;
        if (eventResult?.optionalFailures?.length) throw eventResult.optionalFailures[0].error;
        // Activity recovery must run even when the workspace delta is fresh:
        // snapshots/commentary are a separately scoped authority read.
        const activityChannelIds = new Set(events
          .filter((event) => replayBurst && String(event?.entity_type || '').trim() === 'agent_activity')
          .map((event) => String(event?.channel_id || event?.payload?.channel_id || event?.payload?.agent_activity?.channel_id || '').trim())
          .filter(Boolean));
        for (const channelId of activityChannelIds) {
          await this.requestTowerSyncFamily('channel-agent-activities', channelId, { channelId, force: true, recover: true });
        }
        if (fallbackRefreshRequested) await this.recoverVisibleAgentActivities();
        const refreshWappActivity = events.some((event) => (
          String(event?.entity_type || '').trim() === 'wapp_activity_item'
        ));
        const refreshPersonalAgents = events.some((event) => (
          String(event?.entity_type || '').trim() === 'personal_agent_settings'
        ));
        if (refreshPersonalAgents) {
          await this.refreshWorkspaceSettings({ overwriteInput: !this.wingmanHarnessDirty });
        }
        if (refreshWappActivity && typeof this.reconcileWappActivity === 'function') {
          const workspaceId = String(this.currentWorkspace?.workspaceId || this.currentWorkspace?.workspace_id || '').trim();
          await (workspaceId
            ? this.requestTowerSyncFamily?.('wapp-activity')
            : this.reconcileWappActivity());
        }
        flightDeckTrace('message-timing', 'targeted hydration completed', {
          hydrationStartedAt,
          hydrationCompletedAt: new Date().toISOString(),
          messageIds: events.filter((event) => event?.entity_type === 'message').map((event) => event?.entity_id).filter(Boolean),
          materialisationBatchIds: batches.map((entry) => entry.batchId),
          renderState: {
            selectedChannelId: this.selectedChannelId || null,
            visibleAgentActivities: Array.isArray(this.activeThreadAgentActivities) ? this.activeThreadAgentActivities.length : null,
          },
        });
        if (isCurrent()) {
          for (const batch of batches) {
            acknowledgeSSEBatch({
              ...batch,
              committedAt: new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        if (!isCurrent()) continue;
        const attempt = Number(item.attempt || 0) + 1;
        const delayMs = Math.min(500 * (2 ** Math.min(attempt - 1, 6)), 30_000);
        flightDeckSyncFailure(this, 'warn', 'sse', 'failed to refresh PG records after SSE event', error, {
          error: error?.message || String(error),
          materialisationBatchIds: batches.map((entry) => entry.batchId),
          attempt,
          delayMs,
        });
        if (attempt < PG_SSE_MATERIALISATION_MAX_ATTEMPTS && (!connectionKey || connectionKey === this.sseConnectionKey)) {
          if (!(this.towerPgSSEHydrationRetryTimers instanceof Map)) this.towerPgSSEHydrationRetryTimers = new Map();
          const retryKey = batches.map((entry) => entry.batchId).filter(Boolean).join(',')
            || `${connectionKey || 'unscoped'}:${Date.now()}:${attempt}`;
          if (this.towerPgSSEHydrationRetryTimers.has(retryKey)) continue;
          const timerId = setTimeout(() => {
            this.towerPgSSEHydrationRetryTimers?.delete(retryKey);
            if (!isCurrent()) return;
            if (!Array.isArray(this.pendingTowerPgSSEHydrations)) this.pendingTowerPgSSEHydrations = [];
            this.pendingTowerPgSSEHydrations.push({ ...item, attempt });
            this.queueTowerPgSSEHydration([], null, { drainOnly: true });
          }, delayMs);
          this.towerPgSSEHydrationRetryTimers.set(retryKey, { timerId, connectionKey });
        } else {
          // Retain failed work without holding up later events. Successful
          // background/manual catchup retries it after a cooldown. Reload also
          // replays from the worker's unacknowledged durable cursor.
          if (!connectionKey || connectionKey === this.sseConnectionKey) {
            if (!(this.deferredTowerPgSSEHydrations instanceof Map)) this.deferredTowerPgSSEHydrations = new Map();
            const key = batches.map(entry => entry.batchId).join(',') || `${connectionKey || 'unscoped'}:${Date.now()}`;
            this.deferredTowerPgSSEHydrations.set(key, { ...item, attempt: 0, retryAfter: Date.now() + 30_000 });
            this.scheduleBackgroundSync?.(30_000);
          }
          const isolation = {
            materialisationBatchIds: batches.map((entry) => entry.batchId),
            attempt,
            connectionKey,
            cursorAcknowledged: false,
          };
          if (['pg_read_authority_changed', 'pg_read_authority_resetting'].includes(error?.code)) {
            flightDeckTrace('sse', 'deferred superseded PG SSE batch after bounded retries', isolation);
            this.scheduleBackgroundSync?.(1000);
          } else {
            flightDeckLog('error', 'sse', 'deferred PG SSE materialisation batch after bounded retries', isolation);
          }
        }
      }
    }
  },

  retryDeferredTowerPgSSEHydrations() {
    if (!(this.deferredTowerPgSSEHydrations instanceof Map)) return;
    for (const [key, item] of this.deferredTowerPgSSEHydrations) {
      if (item.connectionKey && item.connectionKey !== this.sseConnectionKey
        || item.activationGeneration !== this._workspaceSelectionGeneration
        || item.activationService !== this._towerSyncService || item.activationService?.disposed) {
        this.deferredTowerPgSSEHydrations.delete(key);
        continue;
      }
      if (Date.now() < item.retryAfter) continue;
      this.deferredTowerPgSSEHydrations.delete(key);
      if (!Array.isArray(this.pendingTowerPgSSEHydrations)) this.pendingTowerPgSSEHydrations = [];
      this.pendingTowerPgSSEHydrations.push(item);
    }
    if (this.pendingTowerPgSSEHydrations?.length) this.queueTowerPgSSEHydration([], null, { drainOnly: true });
  },

  discardStaleTowerPgSSEHydrationWork(connectionKey) {
    if (!connectionKey) return;
    if (Array.isArray(this.pendingTowerPgSSEHydrations)) {
      this.pendingTowerPgSSEHydrations = this.pendingTowerPgSSEHydrations.filter((item) => (
        !item?.connectionKey || item.connectionKey === connectionKey
      ));
    }
    if (this.deferredTowerPgSSEHydrations instanceof Map) {
      for (const [key, item] of this.deferredTowerPgSSEHydrations) {
        if (item.connectionKey && item.connectionKey !== connectionKey) this.deferredTowerPgSSEHydrations.delete(key);
      }
    }
    if (!(this.towerPgSSEHydrationRetryTimers instanceof Map)) return;
    for (const [key, retry] of this.towerPgSSEHydrationRetryTimers) {
      if (!retry?.connectionKey || retry.connectionKey === connectionKey) continue;
      clearTimeout(retry.timerId);
      this.towerPgSSEHydrationRetryTimers.delete(key);
    }
  },

  // --- sync lifecycle ---

  getSyncCadenceMs() {
    if (!this.session?.npub || !this.backendUrl) return null;
    if (typeof document !== 'undefined' && document.hidden) return null;
    if (this.isEncryptedRecordSyncDisabled) {
      if (this.isSSEConnected) return this.SSE_HEARTBEAT_CADENCE_MS;
      if (this.navSection === 'chat' && this.selectedChannelId) return this.FAST_SYNC_MS;
      return this.IDLE_SYNC_MS;
    }
    // When SSE is connected, widen heartbeat polling — SSE handles live refresh
    if (this.isSSEConnected) return this.SSE_HEARTBEAT_CADENCE_MS;
    if (this.navSection === 'chat' && this.selectedChannelId) return this.FAST_SYNC_MS;
    if (this.navSection === 'docs') return this.FAST_SYNC_MS;
    if (this.navSection === 'tasks') return this.FAST_SYNC_MS;
    if (this.navSection === 'settings' && this.settingsTab === 'schedules') return this.FAST_SYNC_MS;
    if (this.navSection === 'settings' && this.settingsTab === 'scopes') return this.FAST_SYNC_MS;
    if (this.navSection === 'settings' && this.settingsTab === 'flows') return this.FAST_SYNC_MS;
    return this.IDLE_SYNC_MS;
  },

  stopBackgroundSync() {
    const service = this._towerSyncService;
    if (this.backgroundSyncTimer) clearTimeout(this.backgroundSyncTimer);
    this.cancelScheduledOfflineMessageResync?.();
    this.disposeTowerSyncService('stop-background-sync');
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      window.removeEventListener('focus', this.visibilityHandler);
      window.removeEventListener('online', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    // Compatibility for callers/tests that stop the legacy lifecycle before a
    // workspace-scoped service has been created.
    if (!service) {
      this.disconnectSSEStream('stop-background-sync');
      stopWorkerFlushTimer();
    }
  },

  scheduleBackgroundSync(delayMs = null) {
    const service = this.getTowerSyncService();
    if (!service) {
      if (this.backgroundSyncTimer) clearTimeout(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
      return false;
    }
    return service.scheduleFallback(Math.max(delayMs ?? this.getSyncCadenceMs() ?? 0, this.syncBackoffMs || 0) || null);
  },

  ensureBackgroundSync(runSoon = false) {
    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = (event) => {
        if (document.hidden) return;
        this.ensureBackgroundSync(true);
        if (event?.type === 'online') {
          this.markTowerReachabilityRecovered?.('browser-online', { refresh: false });
        } else if (isBrowserOffline()) {
          this.markTowerReachabilityDegraded?.('browser-offline', 'offline');
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('focus', this.visibilityHandler, { passive: true });
      window.addEventListener('online', this.visibilityHandler, { passive: true });
    }
    if (this.isEncryptedRecordSyncDisabled) this.markEncryptedRecordSyncDisabled();
    // Data age alone must not replace usable local state with a blocking
    // catch-up screen. Replay/cursor recovery uses background pulls; only
    // explicit manual/full reconciliation opens its own progress dialog.
    if (this.session?.npub && this.backendUrl && this.workspaceOwnerNpub) {
      this.getTowerSyncService()?.start({ runSoon: runSoon && !this.syncBackoffMs });
    }
  },

  async backgroundSyncTick() {
    if(this.navSection==='files'){try{await this.requestTowerSyncFamily('drive-shares','',{force:true});}catch(_){}}
    const cadence = this.getSyncCadenceMs();
    if (!cadence) {
      this.catchUpSyncActive = false;
      return;
    }

    if (this.backgroundSyncInFlight) {
      this.scheduleBackgroundSync(cadence);
      return;
    }

    this.backgroundSyncInFlight = true;
    const fallbackStartedAt = new Date().toISOString();
    if (this.sseStatus === 'fallback-polling') {
      flightDeckTrace('message-timing', 'fallback tick started', {
        fallbackStartedAt,
        cadenceMs: cadence,
      });
    }
    try {
      if (this.isEncryptedRecordSyncDisabled) {
        this.markEncryptedRecordSyncDisabled();
        // Activity recovery has its own visible error and retry state. A
        // failed activity endpoint must not prevent the workspace fallback
        // pull from establishing whether Tower connectivity is usable.
        try {
          await this.recoverVisibleAgentActivities();
        } catch (error) {
          flightDeckLog('warn', 'sync', 'activity recovery failed during background sync', {
            error: error?.message || String(error),
          });
        }
        await (this.requestTowerSyncFamily?.('workspace-bootstrap') ?? this.runTowerPgWorkspaceSync());
        this.markTowerReachabilityRecovered?.('background-sync-success', {
          refresh: false,
          fallbackUsable: this.sseStatus !== 'connected',
        });
      } else {
        await this.performSync({ silent: true });
      }
      // checkForStaleness removed — heartbeat in runSync replaces it
      this.syncBackoffMs = 0;
      this.retryDeferredTowerPgSSEHydrations();
    } catch (error) {
      this.syncBackoffMs = Math.min(Math.max((this.syncBackoffMs || 0) * 2, 1000), 30000);
      flightDeckSyncFailure(this, 'error', 'sync', 'background sync failed', error, {
        backendUrl: this.backendUrl || null,
        ownerNpub: this.workspaceOwnerNpub || null,
        error: error?.message || String(error),
        nextRetryMs: this.syncBackoffMs,
      });
      this.markTowerReachabilityOperationFailed?.('background-sync-failed');
    } finally {
      if (this.sseStatus === 'fallback-polling') {
        flightDeckTrace('message-timing', 'fallback tick completed', {
          fallbackStartedAt,
          fallbackCompletedAt: new Date().toISOString(),
        });
      }
      this.backgroundSyncInFlight = false;
      this.catchUpSyncActive = false;
      const activityRetryDelay = this.agentActivityRecoveryError
        ? (this.agentActivityRecoveryAttempts < 3 ? 1000 * (2 ** (this.agentActivityRecoveryAttempts - 1)) : null)
        : this.agentActivityRecoveryPending ? 1000 : this.syncBackoffMs || null;
      this.scheduleBackgroundSync(Math.max(this.syncBackoffMs || 0, activityRetryDelay || 0) || null);
    }
  },

  // --- sync session UI ---

  updateSyncSession(updates) {
    Object.assign(this.syncSession, updates);
  },

  buildSyncFamilyProgressRows(families = SYNC_FAMILY_OPTIONS) {
    return (families || []).map((family) => ({
      id: family.id,
      hash: family.hash,
      label: family.label,
      status: 'pending',
    }));
  },

  initializeSyncFamilyProgress(families = SYNC_FAMILY_OPTIONS) {
    this.syncFamilyProgress = this.buildSyncFamilyProgressRows(families);
  },

  initializePgFullSyncProgress() {
    this.syncFamilyProgress = PG_FULL_SYNC_STEPS.map((step) => ({
      id: step.id,
      hash: step.id,
      label: step.label,
      status: 'pending',
    }));
  },

  markSyncFamilyProgress(familyHash, status) {
    const targetHash = String(familyHash || '').trim();
    if (!targetHash || !Array.isArray(this.syncFamilyProgress) || this.syncFamilyProgress.length === 0) return;
    this.syncFamilyProgress = this.syncFamilyProgress.map((family) => {
      if (family.hash !== targetHash) return family;
      return { ...family, status };
    });
  },

  syncProgressActiveFamilyLabel() {
    return this.syncFamilyProgress.find((family) => family.status === 'active')?.label || '';
  },

  handleSyncProgressUpdate(update = {}) {
    this.updateSyncSession(update);
    if (!this.syncSession.manual || !Array.isArray(this.syncFamilyProgress) || this.syncFamilyProgress.length === 0) return;

    const phase = String(update.phase || '').trim();
    const familyHash = String(update.currentFamilyHash || '').trim();

    if (phase === 'pulling' && familyHash) {
      const isCompleted = Number.isFinite(update.completedFamilies)
        && Number.isFinite(update.totalFamilies)
        && update.completedFamilies > 0
        && update.completedFamilies <= update.totalFamilies
        && update.currentFamily;
      this.markSyncFamilyProgress(familyHash, isCompleted ? 'done' : 'active');
      if (!isCompleted) return;
    }

    if (phase === 'applying' || phase === 'done') {
      this.syncFamilyProgress = this.syncFamilyProgress.map((family) => (
        family.status === 'active' ? { ...family, status: 'done' } : family
      ));
    }

    if (phase === 'error') {
      this.syncFamilyProgress = this.syncFamilyProgress.map((family) => (
        family.status === 'active' ? { ...family, status: 'error' } : family
      ));
    }
  },

  openSyncProgressModal() {
    this.showSyncProgressModal = true;
  },

  closeSyncProgressModal() {
    if (this.syncSession.phase === 'checking' || this.syncSession.phase === 'pushing' || this.syncSession.phase === 'pulling' || this.syncSession.phase === 'applying') {
      return;
    }
    this.showSyncProgressModal = false;
  },

  syncProgressLabel() {
    const s = this.syncSession;
    if (s.phase === 'idle') return '';
    if (s.phase === 'done') {
      if (s.state === 'quarantined') {
        const quarantined = Number(s.quarantined || 0);
        return quarantined > 0
          ? `${quarantined} pulled record${quarantined === 1 ? '' : 's'} need sync repair.`
          : 'Sync repair needed.';
      }
      return s.manual ? 'Full sync complete.' : '';
    }
    if (s.phase === 'checking') return s.manual ? 'Starting full sync...' : 'Checking...';
    if (s.phase === 'pushing') {
      if (this.isTowerPgMode && s.currentFamily === 'tasks') return `Updating tasks ${s.pushed} / ${s.pushTotal}`;
      return `Pushing ${s.pushed} / ${s.pushTotal}`;
    }
    if (s.phase === 'pulling') {
      if (s.heartbeat && s.totalFamilies === 0) return 'Up to date';
      if (this.isTowerPgMode && s.manual) {
        const familyPart = s.currentFamily ? `Refreshing ${s.currentFamily}` : 'Refreshing workspace';
        return `${familyPart} (${s.completedFamilies} / ${s.totalFamilies} collections)`;
      }
      const familyPart = s.currentFamily ? `Fetching ${s.currentFamily}` : 'Pulling';
      const suffix = s.heartbeat ? ' (heartbeat)' : '';
      return `${familyPart} (${s.completedFamilies} / ${s.totalFamilies} collections)${suffix}`;
    }
    if (s.phase === 'applying') return 'Applying...';
    if (s.phase === 'error') return 'Sync error';
    return '';
  },

  syncProgressPercent() {
    const s = this.syncSession;
    if (s.phase === 'pushing' && s.pushTotal > 0) return Math.round((s.pushed / s.pushTotal) * 50);
    if (s.phase === 'pulling' && s.totalFamilies > 0) return 50 + Math.round((s.completedFamilies / s.totalFamilies) * 45);
    if (s.phase === 'applying' || s.phase === 'done') return 100;
    if (s.phase === 'checking') return 5;
    return 0;
  },

  lastSyncTimeLabel() {
    if (this.isTowerPgMode) {
      if (this.avatarConnectionStatus === 'tower-pg-connected') return 'Live';
      if (this.avatarConnectionStatus === 'syncing') return 'In progress';
      return 'Local cache';
    }
    if (this.syncSession.state === 'disabled' || this.syncStatus === 'disabled') return 'Encrypted sync off';
    const t = this.syncSession.lastSuccessAt;
    if (!t) return 'Never';
    const diff = Date.now() - t;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(t).toLocaleTimeString();
  },

  // --- sync execution ---

  async prepareCheckoutRequiredPendingWrites(options = {}) {
    if (typeof this.attachCheckoutRequiredCheckoutToEnvelope !== 'function') {
      return { prepared: 0, blocked: 0, skipped: 0 };
    }

    const pendingWrites = Array.isArray(options.pendingWrites)
      ? options.pendingWrites
      : await getPendingWrites();
    let prepared = 0;
    let blocked = 0;
    let skipped = 0;

    for (const row of pendingWrites) {
      const rowId = row?.row_id;
      const envelope = row?.envelope || {};
      const recordId = String(row?.record_id || envelope.record_id || '').trim();
      const familyHash = String(row?.record_family_hash || envelope.record_family_hash || '').trim();
      if (rowId == null || !recordId || !familyHash) continue;
      if (Number(envelope.previous_version ?? 0) <= 0) continue;
      if (envelope.checkout?.checkout_id) continue;

      const family = getSyncFamily(familyHash)?.id || '';
      const checkoutPolicyConfig = row?.checkout_policy_config
        || (family === 'task' && typeof this.getTaskDetailCheckoutPolicyConfig === 'function'
          ? this.getTaskDetailCheckoutPolicyConfig()
          : this.recordCheckoutPolicyConfig || null);
      const policy = resolveFlightDeckRecordCheckoutPolicy(familyHash, checkoutPolicyConfig, { recordId });
      if (policy !== 'checkout_required') continue;

      let localRecord = null;
      switch (family) {
        case 'task':
          localRecord = (this.tasks || []).find((task) => task.record_id === recordId) || await getTaskById(recordId);
          break;
        case 'document':
          localRecord = (this.documents || []).find((document) => document.record_id === recordId) || await getDocumentById(recordId);
          break;
        case 'directory':
          localRecord = (this.directories || []).find((directory) => directory.record_id === recordId) || await getDirectoryById(recordId);
          break;
        case 'flow':
          localRecord = (this.flows || []).find((flow) => flow.record_id === recordId) || await getFlowById(recordId);
          break;
        case 'approval':
          localRecord = (this.approvals || []).find((approval) => approval.record_id === recordId) || await getApprovalById(recordId);
          break;
        case 'opportunity':
          localRecord = (this.opportunities || []).find((opportunity) => opportunity.record_id === recordId) || await getOpportunityById(recordId);
          break;
        default:
          skipped++;
          continue;
      }

      if (!localRecord) {
        blocked++;
        await updatePendingWrite(rowId, {
          checkout_prepare_state: 'blocked',
          checkout_prepare_error: 'local_record_missing',
        });
        continue;
      }

      try {
        const managedEnvelope = await this.attachCheckoutRequiredCheckoutToEnvelope(localRecord, envelope, {
          intent: row?.checkout_prepare_intent || row?.intent || 'sync',
          checkoutPolicyConfig,
          reportError: options.reportError === true,
        });
        if (!managedEnvelope?.checkout?.checkout_id) {
          blocked++;
          await updatePendingWrite(rowId, {
            checkout_prepare_state: 'blocked',
            checkout_prepare_error: 'checkout_missing',
          });
          continue;
        }
        await updatePendingWrite(rowId, {
          envelope: managedEnvelope,
          checkout_policy_config: checkoutPolicyConfig,
          checkout_prepare_state: 'ready',
          checkout_prepare_error: null,
        });
        prepared++;
      } catch (error) {
        blocked++;
        await updatePendingWrite(rowId, {
          checkout_prepare_state: 'blocked',
          checkout_prepare_error: error?.classification || error?.towerCode || error?.code || error?.message || 'checkout_failed',
        });
      }
    }

    return { prepared, blocked, skipped };
  },

  async runPgFullSyncStep(stepId) {
    switch (stepId) {
      case 'pg-groups':
        return this.refreshGroups?.({ force: true, minIntervalMs: 0 }) ?? [];
      case 'pg-scopes':
        return this.refreshScopes?.() ?? [];
      case 'pg-channels':
        return this.refreshChannels?.() ?? [];
      case 'pg-tasks':
        return this.refreshTasks?.() ?? [];
      case 'pg-task-comments': {
        const tasks = (Array.isArray(this.tasks) ? this.tasks : [])
          .filter((task) => task?.record_id && task.record_state !== 'deleted');
        await mapWithConcurrency(tasks, PG_FULL_SYNC_CHILD_CONCURRENCY, (task) => (
          this.requestTowerSyncFamily('task-comments', task.record_id, { force: true })
        ));
        return tasks;
      }
      case 'pg-documents':
        return this.refreshDocuments?.() ?? [];
      case 'pg-doc-comments': {
        const documents = (Array.isArray(this.documents) ? this.documents : [])
          .filter((document) => {
            if (!document?.record_id || document.record_state === 'deleted') return false;
            const pgType = String(document.pg_record_type || '').trim();
            return pgType === '' || pgType === 'document';
          });
        await mapWithConcurrency(documents, PG_FULL_SYNC_CHILD_CONCURRENCY, (document) => (
          this.requestTowerSyncFamily('document-comments', document.record_id, { force: true })
        ));
        return documents;
      }
      case 'pg-audio-notes':
        return this.refreshAudioNotes?.() ?? [];
      case 'pg-daily-notes':
        return this.refreshDailyNotes?.() ?? [];
      case 'pg-personal-wapps':
        return this.refreshPersonalWapps?.() ?? [];
      default:
        return [];
    }
  },

  async performTowerPgFullSync({ manual = true } = {}) {
    if (!this.session?.npub || !this.backendUrl) {
      this.error = 'Configure setup first';
      return { pushed: 0, pulled: 0 };
    }

    this.error = null;
    this.showAvatarMenu = false;
    this.initializePgFullSyncProgress();
    this.openSyncProgressModal();
    this.syncing = true;
    this.syncStatus = 'syncing';
    const startedAt = Date.now();
    this.updateSyncSession({
      state: 'syncing',
      phase: 'checking',
      startedAt,
      finishedAt: null,
      error: null,
      manual,
      heartbeat: false,
      pushed: 0,
      pushTotal: 0,
      pulled: 0,
      completedFamilies: 0,
      totalFamilies: PG_FULL_SYNC_STEPS.length,
      currentFamily: null,
      currentFamilyHash: null,
    });

    let pulled = 0;
    try {
      const step = PG_FULL_SYNC_STEPS[0];
      this.markSyncFamilyProgress(step.id, 'active');
      this.updateSyncSession({
        phase: 'pulling',
        currentFamily: step.label,
        currentFamilyHash: step.id,
        completedFamilies: 0,
        totalFamilies: 1,
        pulled: 0,
      });
      const result = await (this.requestTowerSyncFamily?.('workspace-bootstrap', '', { force: manual })
        ?? this.runTowerPgWorkspaceSync());
      pulled = Number(result?.applied || 0);
      await this.ensureTowerPgControlPlaneHydrated?.({ force: true, syncRoute: false });
      const workspaceKey = String(this.currentWorkspaceKey || '').trim();
      const needsWappBootstrap = this.wappActivityReconciledWorkspaceKey !== workspaceKey;
      if ((manual || !this.isSSEConnected || needsWappBootstrap) && typeof this.reconcileWappActivity === 'function') {
        await this.reconcileWappActivity({ force: manual });
      }
      if (this.canAdminWorkspace && typeof this.refreshWappPublishingGrants === 'function') {
        await this.refreshWappPublishingGrants();
      }
      this.retryDeferredTowerPgSSEHydrations();
      this.markTowerReachabilityRecovered?.('full-sync-success', {
        refresh: false,
        fallbackUsable: this.sseStatus !== 'connected',
      });
      this.markSyncFamilyProgress(step.id, 'done');
      this.updateSyncSession({
        phase: 'pulling',
        currentFamily: step.label,
        currentFamilyHash: step.id,
        completedFamilies: 1,
        totalFamilies: 1,
        pulled,
      });

      this.handleSyncProgressUpdate({ phase: 'applying' });
      if (this.navSection === 'status' && typeof this.refreshStatusRecentChanges === 'function') {
        await this.refreshStatusRecentChanges({ hasNewData: true });
      }
      this.handleSyncProgressUpdate({
        phase: 'done',
        state: 'synced',
        finishedAt: Date.now(),
        lastSuccessAt: Date.now(),
        pulled,
        error: null,
      });
      this.syncStatus = 'synced';
      return { pushed: 0, pulled, pruned: 0, pgMode: true };
    } catch (error) {
      this.error = error?.message || 'Full sync failed.';
      this.handleSyncProgressUpdate({
        phase: 'error',
        state: 'error',
        error: this.error,
        finishedAt: Date.now(),
      });
      this.syncStatus = 'error';
      throw error;
    } finally {
      this.catchUpSyncActive = false;
      this.syncing = false;
    }
  },

  async performSync({ silent = false, showBusy = !silent, forceFull = false, manual = false } = {}) {
    if (!this.session?.npub || !this.backendUrl) {
      if (!silent) this.error = 'Configure setup first';
      return { pushed: 0, pulled: 0 };
    }

    if (this.isEncryptedRecordSyncDisabled) {
      if (!silent) this.error = null;
      this.markEncryptedRecordSyncDisabled();
      flightDeckLog('info', 'sync', PG_RECORD_SYNC_DISABLED_MESSAGE, {
        backendUrl: this.backendUrl,
        ownerNpub: this.workspaceOwnerNpub || null,
        viewerNpub: this.session?.npub || null,
        manual,
      });
      return { pushed: 0, pulled: 0, pruned: 0, disabled: true };
    }

    if (!silent) this.error = null;
    if (manual) {
      this.initializeSyncFamilyProgress();
      this.openSyncProgressModal();
    }
    if (showBusy) this.syncing = true;
    this.updateSyncSession({
      state: 'syncing',
      phase: 'checking',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      manual,
      heartbeat: false,
      pushed: 0,
      pushTotal: 0,
      pulled: 0,
      completedFamilies: 0,
      totalFamilies: 0,
      currentFamily: null,
      currentFamilyHash: null,
    });
    flightDeckLog('info', 'sync', 'sync started', {
      silent,
      showBusy,
      forceFull,
      manual,
      backendUrl: this.backendUrl,
      ownerNpub: this.workspaceOwnerNpub || null,
      viewerNpub: this.session?.npub || null,
    });

    let result = null;
    let syncError = null;
    let refreshUnread = !silent;
    let refreshRecentChanges = !silent && this.navSection === 'status';
    const pulledFamilyIds = new Set();

    const onProgress = (update) => {
      const family = getSyncFamily(update?.currentFamilyHash);
      if (family?.id && update?.phase === 'pulling') pulledFamilyIds.add(family.id);
      this.handleSyncProgressUpdate(update);
    };

    try {
      await this.refreshGroups({
        minIntervalMs: silent ? this.BACKGROUND_GROUP_REFRESH_MS : 0,
        maxAgeMs: this.GROUP_KEY_REFRESH_MAX_AGE_MS,
      });
      await this.prepareCheckoutRequiredPendingWrites({ reportError: !silent });
      if (
        !this.hasForcedInitialBackfill
        && this.groups.length > 0
        && this.channels.length === 0
        && this.messages.length === 0
        && this.documents.length === 0
        && this.directories.length === 0
        && this.tasks.length === 0
        && this.taskComments.length === 0
      ) {
        await clearSyncState();
        this.hasForcedInitialBackfill = true;
      }
      result = await runSync(this.workspaceOwnerNpub, this.session.npub, onProgress, {
        authMethod: this.session?.method || '',
        backendUrl: this.backendUrl,
        workspaceDbKey: this.workspaceDbKey,
        forceFull,
        checkoutPolicyConfig: this.recordCheckoutPolicyConfig,
      });
      const hasRemoteDataChanges = (result?.pulled ?? 0) > 0 || (result?.pruned ?? 0) > 0;
      refreshUnread = refreshUnread || hasRemoteDataChanges;
      refreshRecentChanges = refreshRecentChanges || (hasRemoteDataChanges && this.navSection === 'status');
      this.handleSyncProgressUpdate({ phase: 'applying' });
      if (!silent || hasRemoteDataChanges) {
        if (hasRemoteDataChanges && pulledFamilyIds.size > 0) {
          await this.refreshStateForFamilies([...pulledFamilyIds], {
            refreshSyncStatus: false,
            refreshRecentChanges: false,
          });
        }
        await this.refreshWorkspaceSettings({ overwriteInput: !this.wingmanHarnessDirty });
        await this.refreshAudioNotes();
        await this.ensureTaskFamilyBackfill();
        await this.ensureTaskBoardScopeSetup();
        if (this.docsEditorOpen && this.selectedDocId) {
          await this.loadDocComments(this.selectedDocId);
        }
      }
      const quarantined = Number(result?.quarantined || 0);
      this.handleSyncProgressUpdate({
        phase: 'done',
        finishedAt: Date.now(),
        lastSuccessAt: Date.now(),
        state: quarantined > 0 ? 'quarantined' : 'synced',
        quarantined,
        error: quarantined > 0 ? `${quarantined} pulled record${quarantined === 1 ? '' : 's'} need sync repair.` : null,
      });
    } catch (error) {
      syncError = error;
      if (!silent) this.error = error.message;
      this.handleSyncProgressUpdate({ phase: 'error', state: 'error', error: error.message, finishedAt: Date.now() });
      flightDeckLog('error', 'sync', 'sync failed', {
        backendUrl: this.backendUrl,
        ownerNpub: this.workspaceOwnerNpub || null,
        error: error?.message || String(error),
      });
    } finally {
      this.catchUpSyncActive = false;
      if (showBusy) this.syncing = false;
      await this.refreshSyncStatus({ refreshUnread });
      if (refreshRecentChanges) {
        await this.refreshStatusRecentChanges({ hasNewData: true });
      }
    }

    if (syncError) throw syncError;

    flightDeckLog('info', 'sync', 'sync completed', {
      backendUrl: this.backendUrl,
      ownerNpub: this.workspaceOwnerNpub || null,
      pushed: result?.pushed ?? 0,
      pulled: result?.pulled ?? 0,
      syncStatus: this.syncStatus,
    });
    return result;
  },

  async syncNow() {
    this.showAvatarMenu = false;
    try {
      if (this.isTowerPgMode) {
        await this.performTowerPgFullSync({ manual: true });
      } else {
        await this.performSync({ silent: false, forceFull: true, manual: true });
      }
    } catch (e) {
      // performSync already surfaced the error state
    }
    this.ensureBackgroundSync();
  },

  /**
   * Flush pending writes to Tower and schedule a background sync.
   * Much faster than performSync — does NOT heartbeat or pull, so the
   * caller returns almost immediately after the write reaches the server.
   * SSE + the next background tick handle inbound updates.
   */
  async flushAndBackgroundSync() {
    if (!this.session?.npub || !this.backendUrl) return { pushed: 0 };
    if (this.isEncryptedRecordSyncDisabled) {
      this.markEncryptedRecordSyncDisabled();
      return { pushed: 0, disabled: true };
    }
    try {
      await this.prepareCheckoutRequiredPendingWrites({ reportError: false });
      const result = await flushOnly(this.workspaceOwnerNpub, null, {
        backendUrl: this.backendUrl,
        workspaceDbKey: this.workspaceDbKey,
        checkoutPolicyConfig: this.recordCheckoutPolicyConfig,
      });
      // A successful flush proves connectivity — update lastSuccessAt so
      // ensureBackgroundSync doesn't show the "Catching up" overlay.
      this.updateSyncSession({ lastSuccessAt: Date.now() });
      if ((result?.pushed ?? 0) > 0) {
        await this.refreshSyncStatus({ refreshUnread: false });
      }
      return result;
    } catch (error) {
      flightDeckLog('error', 'sync', 'flush-only failed, falling back to background sync', {
        error: error?.message || String(error),
      });
      return { pushed: 0 };
    } finally {
      this.ensureBackgroundSync(true);
    }
  },

  async refreshSyncStatus(options = {}) {
    const refreshUnread = options.refreshUnread !== false;
    if (this.isEncryptedRecordSyncDisabled) {
      this.markEncryptedRecordSyncDisabled();
      if (refreshUnread && typeof this.refreshUnreadFlags === 'function') {
        await this.refreshUnreadFlags();
      }
      return;
    }
    if (this.syncing) {
      this.syncStatus = 'syncing';
      return;
    }
    const pending = await getPendingWrites();
    const quarantine = await this.refreshSyncQuarantine();
    if (pending.length > 0) {
      this.syncStatus = 'unsynced';
    } else if (quarantine.length > 0) {
      this.syncStatus = 'quarantined';
    } else if (this.syncSession.state === 'error') {
      this.syncStatus = 'error';
    } else {
      this.syncStatus = 'synced';
    }
    if (pending.length > 0) {
      flightDeckLog('debug', 'sync', 'pending writes remain after sync status refresh', {
        pendingCount: pending.length,
        pending: pending.slice(0, 10).map((row) => ({
          recordId: row.record_id,
          family: row.record_family_hash,
          createdAt: row.created_at,
        })),
      });
    }
    // Refresh unread indicators after sync status settles
    if (refreshUnread && typeof this.refreshUnreadFlags === 'function') {
      await this.refreshUnreadFlags();
    }
  },

  // checkForStaleness removed — heartbeat-first sync in runSync replaces it

  // --- task family backfill ---

  async ensureTaskFamilyBackfill() {
    if (this.hasForcedTaskFamilyBackfill) return false;
    if (this.isEncryptedRecordSyncDisabled) return false;
    if (!this.session?.npub || !this.backendUrl || !this.workspaceOwnerNpub) return false;
    if (this.tasks.length > 0) return false;
    if (this.groups.length === 0) return false;
    if (this.scopes.length === 0 && !this.selectedBoardId) return false;

    this.hasForcedTaskFamilyBackfill = true;
    flightDeckLog('info', 'sync', 'forcing full task-family backfill on empty local task cache', {
      backendUrl: this.backendUrl,
      ownerNpub: this.workspaceOwnerNpub,
      scopesCount: this.scopes.length,
      selectedBoardId: this.selectedBoardId || null,
    });

    await clearSyncStateForFamilies(['task']);
    await this.pullFamiliesFromBackend(['task'], { forceFull: true });
    await this.refreshTasks();

    flightDeckLog('info', 'sync', 'task-family backfill completed', {
      ownerNpub: this.workspaceOwnerNpub,
      taskCount: this.tasks.length,
    });

    return true;
  },

  // --- repair / restore ---

  async restoreFamiliesFromSuperBased(familyIds, options = {}) {
    const dedupedFamilyIds = [...new Set((familyIds || []).filter(Boolean))];
    if (dedupedFamilyIds.length === 0) {
      throw new Error('Select at least one record family.');
    }
    if (this.isEncryptedRecordSyncDisabled) {
      this.repairError = PG_RECORD_REPAIR_DISABLED_MESSAGE;
      return this.encryptedRecordRepairDisabledResult({
        cancelled: true,
        restored: 0,
      });
    }

    const pending = await getPendingWritesByFamilies(dedupedFamilyIds);
    if (pending.length > 0) {
      const blockingFamilies = [...new Set(
        pending
          .map((row) => getSyncFamily(row.record_family_hash)?.label)
          .filter(Boolean)
      )];
      throw new Error(`Cannot restore while unsynced local changes exist in: ${blockingFamilies.join(', ')}. Sync or resolve them first.`);
    }

    if (options.confirm !== false && typeof window !== 'undefined') {
      const labels = dedupedFamilyIds.map((familyId) => getSyncFamily(familyId)?.label || familyId);
      const confirmed = window.confirm(`Restore ${labels.join(', ')} from SuperBased? This clears local cache for the selected families and rebuilds it from the backend.`);
      if (!confirmed) return { cancelled: true, restored: 0 };
    }

    await clearRuntimeFamilies(dedupedFamilyIds);
    await clearSyncStateForFamilies(dedupedFamilyIds);
    await clearSyncQuarantineForFamilies(dedupedFamilyIds);
    await this.pullFamiliesFromBackend(dedupedFamilyIds, { forceFull: true });
    await this.refreshStateForFamilies(dedupedFamilyIds);
    await this.refreshSyncQuarantine();
    return { cancelled: false, restored: dedupedFamilyIds.length };
  },

  async pullFamiliesFromBackend(familyIds, options = {}) {
    if (this.isEncryptedRecordSyncDisabled) {
      return this.encryptedRecordRepairDisabledResult({ pulled: 0 });
    }
    if (!this.session?.npub || !this.backendUrl || !this.workspaceOwnerNpub) {
      throw new Error('Configure setup first');
    }
    const hashes = getSyncFamilyHashes(familyIds);
    if (hashes.length === 0) return { pulled: 0 };
    return pullRecordsForFamilies(this.workspaceOwnerNpub, this.session.npub, hashes, {
      ...options,
      authMethod: this.session?.method || '',
      backendUrl: this.backendUrl,
      workspaceDbKey: this.workspaceDbKey,
      checkoutPolicyConfig: this.recordCheckoutPolicyConfig,
    });
  },

  async refreshStateForSyncFamilyHashes(familyHashes = [], options = {}) {
    const familyIds = [...new Set(
      (familyHashes || [])
        .map((familyHash) => getSyncFamily(familyHash)?.id)
        .filter(Boolean)
    )];
    if (familyIds.length === 0) return;
    await this.refreshStateForFamilies(familyIds, options);
  },

  async refreshStateForFamilies(familyIds = [], options = {}) {
    const selected = new Set(familyIds.filter((familyId) => !this.isStatusFamilyDisabled(familyId)));
    if (selected.has('settings')) {
      await this.refreshWorkspaceSettings({ overwriteInput: !this.wingmanHarnessDirty });
    }
    if (selected.has('channel')) await this.refreshChannels();
    if (selected.has('chat_message')) await this.refreshMessages();
    if (selected.has('audio_note')) await this.refreshAudioNotes();
    if (selected.has('directory')) await this.refreshDirectories();
    if (selected.has('document')) await this.refreshDocuments();
    if (selected.has('task')) await this.refreshTasks();
    if (selected.has('schedule')) await this.refreshSchedules();
    if (selected.has('scope')) await this.refreshScopes();
    if (selected.has('task') || selected.has('scope')) await this.ensureTaskBoardScopeSetup();
    if (selected.has('comment') && this.activeTaskId) {
      await this.loadTaskComments(this.activeTaskId);
    }
    if ((selected.has('comment') || selected.has('audio_note')) && this.docsEditorOpen && this.selectedDocId) {
      await this.loadDocComments(this.selectedDocId);
    }
    if (options.refreshRecentChanges !== false) {
      await this.refreshStatusRecentChanges({ hasNewData: true, force: true });
    }
    if (options.refreshSyncStatus !== false) {
      await this.refreshSyncStatus();
    }
  },

  async restoreSelectedFamiliesFromSuperBased() {
    const familyIds = [...new Set(this.repairSelectedFamilyIds)];
    if (familyIds.length === 0) {
      this.repairError = 'Select at least one record family.';
      return;
    }

    this.repairError = null;
    this.repairNotice = '';

    this.repairBusy = true;
    try {
      const result = await this.restoreFamiliesFromSuperBased(familyIds);
      if (result.cancelled) return;
      this.repairNotice = `Restored ${result.restored} record ${result.restored === 1 ? 'family' : 'families'} from SuperBased.`;
    } catch (error) {
      this.repairError = error?.message || 'Failed to restore selected record families.';
    } finally {
      this.repairBusy = false;
    }
  },

  // --- quarantine actions ---

  async dismissSyncQuarantineIssue(entry) {
    this.syncQuarantineError = null;
    this.syncQuarantineNotice = '';
    this.syncQuarantineBusy = true;
    try {
      await deleteSyncQuarantineEntry(entry.family_hash, entry.record_id);
      await this.refreshSyncStatus();
      this.syncQuarantineNotice = `Dismissed quarantine issue for ${this.syncQuarantineRecordLabel(entry)}.`;
    } catch (error) {
      this.syncQuarantineError = error?.message || 'Failed to dismiss quarantine issue.';
    } finally {
      this.syncQuarantineBusy = false;
    }
  },

  async retrySyncQuarantineIssue(entry) {
    const familyId = getSyncFamily(entry?.family_id || entry?.family_hash)?.id;
    if (!familyId) {
      this.syncQuarantineError = 'Unknown sync family for this quarantine issue.';
      return;
    }
    if (this.isEncryptedRecordSyncDisabled) {
      this.syncQuarantineError = PG_RECORD_REPAIR_DISABLED_MESSAGE;
      return;
    }

    this.syncQuarantineError = null;
    this.syncQuarantineNotice = '';
    this.syncQuarantineBusy = true;
    try {
      const result = await this.restoreFamiliesFromSuperBased([familyId], { confirm: false });
      if (result.cancelled) return;
      this.syncQuarantineNotice = `Rebuilt ${this.syncQuarantineFamilyLabel(entry)} from SuperBased.`;
    } catch (error) {
      this.syncQuarantineError = error?.message || 'Failed to retry quarantined family.';
    } finally {
      this.syncQuarantineBusy = false;
    }
  },

  async deleteLocalQuarantinedRecord(entry) {
    const family = getSyncFamily(entry?.family_id || entry?.family_hash);
    if (!family?.id) {
      this.syncQuarantineError = 'Unknown sync family for this quarantine issue.';
      return;
    }

    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(`Delete local ${this.syncQuarantineFamilyLabel(entry)} record ${this.syncQuarantineRecordLabel(entry)}? This only affects browser state.`);
      if (!confirmed) return;
    }

    this.syncQuarantineError = null;
    this.syncQuarantineNotice = '';
    this.syncQuarantineBusy = true;
    try {
      await deleteRuntimeRecordByFamily(family.id, entry.record_id);
      await deleteSyncQuarantineEntry(entry.family_hash, entry.record_id);
      await this.refreshStateForFamilies([family.id]);
      await this.refreshSyncStatus();
      this.syncQuarantineNotice = `Deleted local ${this.syncQuarantineFamilyLabel(entry)} record ${this.syncQuarantineRecordLabel(entry)}.`;
    } catch (error) {
      this.syncQuarantineError = error?.message || 'Failed to delete local quarantined record.';
    } finally {
      this.syncQuarantineBusy = false;
    }
  },
};
