import { clearPgAuthorityPresentation } from './pg-authority-presentation.js';
/**
 * Shell state module — owns app-level state that is not section-domain-specific.
 *
 * This is the first runtime boundary extraction from the monolithic Alpine store.
 * The state and methods defined here are spread into the assembled store via
 * applyMixins in src/app.js, so $store.chat.* template bindings continue to work.
 *
 * Ownership boundary:
 * - Shell owns: identity, session, workspace context, route, navigation, sync status,
 *   global error, login flow, connect modal, extension signer, build version, constants.
 * - Shell does NOT own: section data arrays, section selection state, domain mixin methods,
 *   editor buffers, section-specific modals.
 *
 * See docs/design/store-template-decomposition.md for the full decomposition plan.
 */

import { shutdownSyncWorker } from './sync-worker-client.js';
import { disposePipelineViewer } from './pipeline-viewer-view.js';
import { getRunningBuildId } from './version-check.js';
import {
  bootstrapWorkspaceSessionKey,
  clearActiveWorkspaceKey,
  getActiveWorkspaceKeyNpub,
  markCachedWorkspaceKeyRegistered,
  markWorkspaceKeyRegistered,
} from './crypto/workspace-keys.js';
import { parseRouteLocation } from './route-helpers.js';
import { normalizeEnabledFlightDeckSection } from './disabled-surfaces.js';
import { normalizeTaskSortMode } from './task-board-state.js';
import {
  normalizeBackendUrl,
} from './utils/state-helpers.js';
import { getShortNpub, getInitials } from './utils/naming.js';
import {
  getSettings,
  closeWorkspaceDb,
} from './db.js';
import { registerWorkspaceKey, setBaseUrl } from './api.js';
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
  setActiveSessionNpub,
  clearCryptoContext,
} from './crypto/group-keys.js';
import { buildFlightDeckDocumentTitle } from './page-title.js';
import { mergeWorkspaceEntries, workspaceFromToken, findWorkspaceById, findWorkspaceByKey, findWorkspaceBySlug } from './workspaces.js';
import { guessDefaultBackendUrl } from './workspace-manager.js';
import { parseSuperBasedToken } from './superbased-token.js';
import { extractInviteToken } from './invite-link.js';
import { flightDeckLog } from './logging.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { buildPgChannelTaskBoardId, parsePgTaskBoardId } from './pg-record-context.js';

/**
 * Canonical list of shell state keys (data properties and getters).
 * This list is the authoritative boundary — used by tests to verify
 * no domain keys leak in and no shell keys are omitted.
 */
export const SHELL_STATE_KEYS = Object.freeze([
  // Constants
  'FAST_SYNC_MS',
  'IDLE_SYNC_MS',
  'SSE_HEARTBEAT_CADENCE_MS',
  'BACKGROUND_GROUP_REFRESH_MS',
  'GROUP_KEY_REFRESH_MAX_AGE_MS',

  // Identity and session
  'appBuildId',
  'backendUrl',
  'ownerNpub',
  'botNpub',
  'session',
  'signingNpub',       // getter
  'isLoggedIn',        // getter
  'settingsTab',
  'extensionSignerAvailable',
  'extensionSignerPollTimer',
  'isLoggingIn',
  'loginError',
  'error',

  // Navigation
  'navSection',
  '_navSection',
  'lockedView',
  'canLockCurrentView',
  'isCurrentViewLocked',
  'navCollapsed',
  'mobileNavOpen',
  'mobileViewport',
  'routeSyncPaused',
  'popstateHandler',

  // Sync status indicators
  'syncStatus',
  'syncSession',
  'syncFamilyProgress',
  'sseStatus',
  'towerReachabilityState',
  'towerFallbackReachable',
  'towerReachabilityReason',
  'towerReachabilityConnectionKey',
  'offlineMessageResyncArmed',
  'offlineMessageResyncConnectionKey',
  'offlineMessageResyncScheduled',
  'offlineMessageResyncTimer',
  'offlineMessageResyncIdleHandle',
  'offlineMessageResyncReason',
  'offlineMessageLastResult',
  'catchUpSyncActive',
  'startupSyncProgress',
  'startupSyncProgressTimer',

  // Sync internals (owned by shell, consumed by sync mixin)
  'hasForcedInitialBackfill',
  'hasForcedTaskFamilyBackfill',
  'backgroundSyncTimer',
  'backgroundSyncInFlight',
  'syncBackoffMs',
  'hasBootstrappedUnreadTracking',
  'visibilityHandler',
  'lastGroupsRefreshAt',
  'groupsLoading',
  'groupsLoadError',

  // Shell UI
  'showAvatarMenu',
  'showSyncProgressModal',
  'showWorkspaceSwitcherMenu',
  'presetConnecting',

  // Connect modal (two-step)
  'showConnectModal',
  'connectStep',
  'connectPgOnboardingStep',
  'connectPgSelectedScopeIndex',
  'connectPgNewScopeName',
  'connectPgNewChannelName',
  'connectHostUrl',
  'connectHostLabel',
  'connectHostServiceNpub',
  'connectHostTowerName',
  'connectHostTowerDescription',
  'connectHostError',
  'connectHostBusy',
  'connectManualUrl',
  'connectWorkspaces',
  'connectWorkspacesBusy',
  'connectWorkspacesError',
  'connectWorkspaceRequestDiagnostics',
  'connectNewWorkspaceName',
  'connectNewWorkspaceDescription',
  'connectCreatingWorkspace',
  'connectPgBootstrapTemplateId',
  'connectPgBootstrapTemplates',
  'connectPgBootstrapProgress',
  'connectTokenInput',
  'connectShowTokenFallback',
  'knownHosts',
  'showAgentConnectModal',

  // Workspace access gate
  'showWorkspaceAccessGate',
  'workspaceAccessGateStep',
  'workspaceAccessGateWorkspaces',
  'workspaceAccessGateProgress',
  'workspaceAccessGateBusy',

  // Workspace bootstrap
  'showWorkspaceBootstrapModal',
  'newWorkspaceName',
  'newWorkspaceDescription',
  'workspaceBootstrapSubmitting',
  'agentConnectJson',
  'agentConfigCopied',
  'pendingInviteToken',

  // Workspace identity (read/write by shell, read by domain)
  'superbasedTokenInput',
  'superbasedError',
  'knownWorkspaces',
  'workspaceProfileRowsByKey',
  'selectedWorkspaceKey',
  'localWorkspaceCoreLoadedForKey',
  'currentWorkspaceOwnerNpub',
  'workspaceSwitchPendingKey',
  'workspaceSwitchPendingNpub',
  'removingWorkspace',
  'workspaceSettingsRecordId',
  'workspaceSettingsVersion',
  'personalAgentSettingsRowVersion',
  'workspaceSettingsGroupIds',
  'workspaceHarnessUrl',
  'workspaceHarnessAgentNpub',
  'workspaceHarnessAgents',
  'workspaceProfileNameInput',
  'workspaceProfileSlugInput',
  'workspaceProfileDescriptionInput',
  'workspaceProfileDashboardGreetingTemplateInput',
  'workspaceProfileAvatarInput',
  'workspaceProfileAvatarPreviewUrl',
  'workspaceProfilePendingAvatarFile',
  'workspaceProfilePendingAvatarObjectUrl',
  'workspaceProfileDirty',
  'workspaceProfileSaving',
  'workspaceProfileError',
  'workspaceAdvancedOptionsEnabled',
  'defaultAgentNpub',
  'defaultAgentQuery',
  'useCvmSync',

  // Harness
  'wingmanHarnessInput',
  'wingmanHarnessDraftAgentNpub',
  'wingmanHarnessAgentQuery',
  'wingmanHarnessError',
  'wingmanHarnessDirty',
]);

/**
 * Canonical list of shell methods (lifecycle, route, auth, nav).
 * These are functions defined directly on the shell state object.
 */
export const SHELL_METHOD_NAMES = Object.freeze([
  'init',
  'ensureWorkspaceSessionKey',
  'bootstrapSelectedWorkspace',
  'initRouteSync',
  'getRoutePath',
  'buildRouteUrl',
  'syncRoute',
  'applyRouteFromLocation',
  'updatePageTitle',
  'navigateTo',
  'togglePrimaryNav',
  'updateNavigationViewport',
  'toggleCurrentViewLock',
  'clearInactiveSectionData',
  'startExtensionSignerWatch',
  'stopExtensionSignerWatch',
  'refreshExtensionSignerAvailability',
  'maybeAutoLogin',
  'login',
  'logout',
  'hasExtensionSigner',
  'openHarnessLink',
]);

// Shared by the assembled shell and the inline fallback auth path. Durable rows,
// drafts and outbox remain in the signer/workspace partition, never in this runtime.
export function detachLoggedOutWorkspace(store) {
  clearPgAuthorityPresentation(store, { preserveDrafts: false });
  store._workspaceSelectionRequest = (store._workspaceSelectionRequest || 0) + 1;
  store._workspaceSelectionGeneration = (store._workspaceSelectionGeneration || 0) + 1;
  store.stopDrive?.();
  store.stopBackgroundSync();
  shutdownSyncWorker();
  store.stopAllLiveQueries();
  store.stopExtensionSignerWatch();
  store.clearDocCommentConnector();
  store.revokeStorageImageObjectUrls();
  if (store.pgTaskWriteProcessTimer) clearTimeout(store.pgTaskWriteProcessTimer);
  store.pgTaskWriteProcessTimer = null;
  store.pgTaskWriteInFlight = false;
  store.pgTaskWriteProgressDone = 0;
  store.pgTaskWriteProgressTotal = 0;
  store.pgTaskWriteFailedCount = 0;
  for (const timer of Object.values(store.pgEditLeaseRenewalTimers || {})) clearTimeout(timer);
  store.pgEditLeaseRenewalTimers = {};
  store.pgEditLeaseSessions = {};
  store.lockManagedCheckoutSessions = {};
  store.cancelDocAutosave?.();
  store.cancelDocLocalDraftPersistence?.();
  store.loadDocEditorFromSelection?.(null);
  store.chatComposerDrafts = {};
  store.selectedAgentMentionsByComposer = { message: [], thread: [] };
  store.pgEditLeaseAcquirePromises = {};
  store.pgEditLeaseInspectionPromises = {};
  store.scopeAccessScope = null;
  store.scopeAccessData = null;
  store.scopeAccessWorkspaceId = '';
  clearActiveWorkspaceKey();
  clearCryptoContext();
  store.session = null;
  store.ownerNpub = '';
  store.selectedWorkspaceKey = '';
  store.currentWorkspaceOwnerNpub = '';
  store.localWorkspaceCoreLoadedForKey = '';
  closeWorkspaceDb();
  store.chatPresentationCache?.clear?.();
  store.resetWappActivityProjection?.();
  store.closeMentionPopover?.();
  for (const key of [
    'channels', 'messages', 'groups', 'documents', 'directories', 'tasks',
    'schedules', 'scopes', 'reports', 'flows', 'approvals', 'persons',
    'organisations', 'opportunities', 'wapps', 'dailyNotes', 'audioNotes',
    'fileFolders', 'fileMessages', 'fileComments', 'docComments', 'taskComments',
    'opportunityComments', 'pgWorkspaceMembers', 'statusRecentChanges',
    'recentChannelMessages', 'reactionRows', 'channelResponseActivities',
    'threadResponseActivities', 'agentActivities', 'agentSessionHealth',
    'recordSyncConflicts', 'avatarSyncConflicts', 'pendingWriteDiagnostics',
    'syncQuarantine', 'pgTaskWriteQueue', 'connectWorkspaces', 'channelGrants',
    'docVersionHistory', 'recordVersionHistory', 'documentSessionRows',
    'invocationHistoryRows', 'workspaceAccessGateWorkspaces',
    'messageAudioDrafts', 'messageFileDrafts', 'threadAudioDrafts', 'threadFileDrafts',
    'taskCommentAudioDrafts', 'docCommentAudioDrafts', 'docCommentReplyAudioDrafts',
    'workrooms', 'workroomParticipants', 'workroomEvents', 'workroomLinks',
    'workroomApprovals', 'agentConnections', 'workspaceAgents',
  ]) store[key] = [];
  for (const key of ['messageInput', 'threadInput', 'newTaskTitle', 'newSubtaskTitle',
    'newScheduleTitle', 'newScheduleDescription', 'newDocModalTitle', 'newTaskCommentBody',
    'newDocCommentBody', 'newDocCommentReplyBody']) store[key] = '';
  for (const key of ['chatTaskModalOpen', 'chatDocModalOpen', 'personalWappsOverlayOpen',
    'personalAgentsOverlayOpen', 'workroomDetailOpen', 'workroomRoomDetailsOpen']) store[key] = false;
  store.chatTaskModalTitle = '';
  store.chatDocModalTitle = '';
  store.activeWorkroomId = '';
  store.editingTask = null;
  store.showTaskDetail = false;
  store.scopesLoaded = false;
  store.pgNavigationRecoveryPending = false;
  store.pgNavigationRecoverySelection = null;
  store.pgNavigationGeneration = null;
  store.pgNavigationWorkspaceKey = '';
  store.syncing = false;
  store.syncStatus = 'idle';
}

/**
 * Create the shell state object with all shell-owned state, getters, and methods.
 *
 * @param {object} options
 * @param {string} [options.initialSection='status'] - Initial nav section
 * @returns {object} Shell state suitable for spreading into the assembled Alpine store
 */
export function createShellState(options = {}) {
  const initialSection = options.initialSection || 'status';

  return {
    // ── Constants ──────────────────────────────────────────────
    FAST_SYNC_MS: 15000,
    IDLE_SYNC_MS: 30000,
    SSE_HEARTBEAT_CADENCE_MS: 60000,
    BACKGROUND_GROUP_REFRESH_MS: 5 * 60 * 1000,
    GROUP_KEY_REFRESH_MAX_AGE_MS: 24 * 60 * 60 * 1000,

    // ── Identity and session ──────────────────────────────────
    appBuildId: getRunningBuildId(),
    backendUrl: '',
    ownerNpub: '',
    botNpub: '',
    session: null,
    get signingNpub() {
      return getActiveWorkspaceKeyNpub() || this.session?.npub || null;
    },
    get isLoggedIn() {
      return Boolean(this.session?.npub);
    },
    settingsTab: 'connection',
    extensionSignerAvailable: false,
    extensionSignerPollTimer: null,
    isLoggingIn: false,
    loginError: null,
    error: null,

    // ── Navigation ────────────────────────────────────────────
    _navSection: initialSection,
    lockedView: null,
    get navSection() { return this._navSection; },
    set navSection(section) {
      // Backlog expansion lasts only for the current visit to Tasks.
      if (section === 'tasks' && section !== this._navSection) {
        this.collapsedSections = { ...this.collapsedSections, new: true };
      }
      if (section !== this._navSection) this.lockedView = null;
      if(section!=='agents')disposePipelineViewer(this);
      this._navSection = section;
    },
    get canLockCurrentView() {
      return (this.mobileViewport || !this.navCollapsed || this.mobileNavOpen)
        && ['chat', 'tasks', 'docs', 'files'].includes(this.navSection);
    },
    get isCurrentViewLocked() {
      return this.canLockCurrentView && this.lockedView === this.navSection;
    },
    toggleCurrentViewLock() {
      this.lockedView = this.canLockCurrentView && !this.isCurrentViewLocked
        ? this.navSection : null;
    },
    navCollapsed: true,
    mobileNavOpen: false,
    mobileViewport: typeof window !== 'undefined' && window.innerWidth <= 768,
    routeSyncPaused: false,
    popstateHandler: null,

    // ── Sync status indicators ────────────────────────────────
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
    catchUpSyncActive: false,
    startupSyncProgress: {
      active: false, visible: false, stage: 'idle', startedAt: null, elapsedMs: 0,
      page: 0, applied: 0, cursorPresent: false, fullSnapshot: false, error: null,
    },
    startupSyncProgressTimer: null,

    // ── Sync internals ────────────────────────────────────────
    hasForcedInitialBackfill: false,
    hasForcedTaskFamilyBackfill: false,
    backgroundSyncTimer: null,
    backgroundSyncInFlight: false,
    syncBackoffMs: 0,
    hasBootstrappedUnreadTracking: false,
    visibilityHandler: null,
    lastGroupsRefreshAt: 0,
    groupsLoading: false,
    groupsLoadError: null,

    // ── Shell UI ──────────────────────────────────────────────
    showAvatarMenu: false,
    showSyncProgressModal: false,
    showWorkspaceSwitcherMenu: false,
    presetConnecting: false,

    // ── Connect modal (two-step) ──────────────────────────────
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

    // ── Workspace access gate ─────────────────────────────────
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

    // ── Workspace bootstrap ───────────────────────────────────
    showWorkspaceBootstrapModal: false,
    newWorkspaceName: '',
    newWorkspaceDescription: '',
    workspaceBootstrapSubmitting: false,
    agentConnectJson: '',
    agentConfigCopied: false,
    pendingInviteToken: null,

    // ── Workspace identity ────────────────────────────────────
    superbasedTokenInput: '',
    superbasedError: null,
    knownWorkspaces: [],
    workspaceProfileRowsByKey: {},
    selectedWorkspaceKey: '',
    localWorkspaceCoreLoadedForKey: '',
    currentWorkspaceOwnerNpub: '',
    workspaceSwitchPendingKey: '',
    workspaceSwitchPendingNpub: '',
    removingWorkspace: false,
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
    useCvmSync: typeof localStorage !== 'undefined' ? localStorage.getItem('use_cvm_sync') === 'true' : false,

    // ── Harness ───────────────────────────────────────────────
    wingmanHarnessInput: '',
    wingmanHarnessDraftAgentNpub: '',
    wingmanHarnessAgentQuery: '',
    wingmanHarnessError: null,
    wingmanHarnessDirty: false,

    // ── Lifecycle methods ─────────────────────────────────────

    async init() {
      this.initDocEditLeaseLifecycle?.();
      this.startExtensionSignerWatch();
      this.initCommandPaletteShortcuts?.();
      this.initRouteSync();
      this.routeSyncPaused = true;
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
        this.knownHosts = Array.isArray(settings.knownHosts) ? settings.knownHosts : [];
      }
      if (typeof window !== 'undefined') {
        const invite = extractInviteToken(window.location.href);
        if (invite) {
          this.pendingInviteToken = invite;
          this.superbasedTokenInput = invite.token;
          this.backendUrl = invite.backendUrl;
          this.mergeKnownWorkspaces([invite.workspace]);
          if (invite.workspaceOwnerNpub) {
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
          if (typeof this.addKnownHost === 'function') {
            this.addKnownHost({
              url: config.directHttpsUrl,
              label: config.towerName || config.directHttpsUrl,
              serviceNpub: config.serviceNpub,
              towerName: config.towerName,
              towerDescription: config.towerDescription,
            });
          }
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
      if (typeof this.refreshKnownHostsMetadata === 'function') {
        this.refreshKnownHostsMetadata().catch(() => {});
      }
      const towerPgMode = isTowerPgBackendMode();
      // Restore identity before opening retained caches. Refresh can reuse this
      // signer's verified selection when Tower is temporarily unreachable.
      if (!towerPgMode) {
        if (!this.selectedWorkspaceKey && this.currentWorkspaceOwnerNpub) {
          const legacyMatch = this.knownWorkspaces.find((workspace) => workspace.workspaceOwnerNpub === this.currentWorkspaceOwnerNpub) || null;
          if (legacyMatch) this.selectedWorkspaceKey = legacyMatch.workspaceKey || '';
        }
        if (!this.selectedWorkspaceKey && this.knownWorkspaces.length > 0) {
          this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
          this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
        }
        if (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub) {
          await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub, {
            refresh: false,
            skipPgVerification: false,
          });
        }
        if (this.selectedWorkspaceKey) {
          await this.bootstrapSelectedWorkspace({ runAccessPrune: false });
        }
      }
      await this.maybeAutoLogin();
      if (towerPgMode && this.session?.npub) {
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
        if (this.selectedWorkspaceKey) {
          await this.bootstrapSelectedWorkspace({ runAccessPrune: false });
        }
      }
      this.updateWorkspaceBootstrapPrompt();
      if (this.session?.npub && (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal))) {
        this.openConnectModal();
      }
      this.pendingInviteToken = null;
      this.routeSyncPaused = false;
      Promise.resolve().then(async () => {
        await this.hydrateKnownWorkspaceProfiles();
        this.filterKnownWorkspacesForActiveSession?.();
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
        if (
          (!isTowerPgBackendMode() || this.session?.npub)
          && !this.selectedWorkspaceKey
          && this.knownWorkspaces.length > 0
        ) {
          this.selectedWorkspaceKey = this.knownWorkspaces[0].workspaceKey || '';
          this.currentWorkspaceOwnerNpub = this.knownWorkspaces[0].workspaceOwnerNpub;
        }
        if (
          (!isTowerPgBackendMode() || this.session?.npub)
          && (this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub)
        ) {
          await this.selectWorkspace(this.selectedWorkspaceKey || this.currentWorkspaceOwnerNpub, { refresh: false });
        }
        this.updateWorkspaceBootstrapPrompt();
        if (this.session?.npub && (!this.backendUrl || (!this.selectedWorkspaceKey && !this.showWorkspaceBootstrapModal))) {
          this.openConnectModal();
        }
        if ((!isTowerPgBackendMode() || this.session?.npub) && this.selectedWorkspaceKey) {
          await this.bootstrapSelectedWorkspace({ runAccessPrune: true });
        }
        this.ensureBackgroundSync();
      }).catch((error) => {
        console.debug('startup remote workspace refresh failed:', error?.message || error);
      });
    },

    async ensureWorkspaceSessionKey() {
      // PG uses actor signing; legacy delegation registration cannot verify
      // PG membership. Clear a key left by a previous legacy activation.
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
      if (isTowerPgBackendMode()) {
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
        await this.ensureTowerPgControlPlaneHydrated?.({ force: true, syncRoute: false });
        await this.resumePgTaskWriteQueue?.();
      } else {
        await this.ensureWorkspaceSessionKey();
        await this.refreshGroups({ maxAgeMs: this.GROUP_KEY_REFRESH_MAX_AGE_MS });
        this.refreshWorkspaceKeyMappings().catch(() => {});
        if (options.runAccessPrune === true) {
          this.runAccessPruneOnLogin().catch(() => {});
        }
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
      if (this.navSection === 'settings' && this.canAdminWorkspace) await this.refreshWappPublishingGrants?.();
      if (this.navSection === 'chat' && this.selectedChannelId) {
        this.scheduleChatFeedScrollToBottom();
      }
      if (this.defaultAgentNpub) this.resolveChatProfile(this.defaultAgentNpub);
    },

    // ── Route lifecycle ───────────────────────────────────────

    initRouteSync() {
      if (typeof window === 'undefined' || this.popstateHandler) return;
      this.popstateHandler = () => {
        this.applyRouteFromLocation();
      };
      window.addEventListener('popstate', this.popstateHandler);
      window.addEventListener('hashchange', this.popstateHandler);
    },

    updatePageTitle() {
      if (typeof document === 'undefined') return;
      document.title = this.currentDocumentTitle;
    },

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
          case 'toolbox': return 'toolbox';
          case 'tasks': return 'tasks';
          case 'chat': return 'chat';
          case 'docs': return 'docs';
          case 'files': return 'files';
          case 'agents': return 'agents';
          case 'drive':
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
      if (this.selectedBoardId) url.searchParams.set('scopeid', this.selectedBoardId);

      const enabledSection = normalizeEnabledFlightDeckSection(this.navSection);
      if (enabledSection !== this.navSection) this.navSection = enabledSection;

      if (this.navSection === 'chat') {
        if (this.selectedChannelId) url.searchParams.set('channelid', this.selectedChannelId);
        if (this.activeThreadId) url.searchParams.set('threadid', this.activeThreadId);
      } else if (this.navSection === 'status' && this.activeThreadId && this.deckThreadChannelId) {
        url.searchParams.set('channelid', this.deckThreadChannelId);
        url.searchParams.set('threadid', this.activeThreadId);
      } else if (this.navSection === 'docs') {
        if (this.selectedChannelId) url.searchParams.set('channelid', this.selectedChannelId);
        if (this.docsShowAll) url.searchParams.set('docsview', 'all');
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
      } else if (this.navSection === 'agents') {
        if (this.selectedWorkspaceAgentId) url.searchParams.set('agentid', this.selectedWorkspaceAgentId);
        if (this.agentSpaceView && this.agentSpaceView !== 'overview') url.searchParams.set('agentview', this.agentSpaceView);
        if(this.pipelineViewerEnabled && this.pipelineViewerOpen){url.searchParams.set('viewer','1');for(const [key,value] of Object.entries(this.pipelineViewerRoute||{}))if(value)url.searchParams.set(key,value);}
      }

      return `${url.pathname}${url.search}${this.navSection === 'files' && url.hash.startsWith('#drive?') ? url.hash : ''}`;
    },

    syncRoute(replace = false) {
      this.updatePageTitle();
      if (this.routeSyncPaused || typeof window === 'undefined') return;
      const nextUrl = this.buildRouteUrl();
      const currentHash = window.location.hash?.startsWith('#drive?') ? window.location.hash : '';
      const currentUrl = `${window.location.pathname}${window.location.search}${currentHash}`;
      if (nextUrl === currentUrl) return;
      const state = { section: this.navSection };
      if (this.navSection === 'docs' && this.selectedDocId && this.docDetailOriginRoute) {
        state.docDetailOriginRoute = this.docDetailOriginRoute;
      }
      if (this.navSection === 'tasks' && this.activeTaskId && this.taskDetailOriginRoute) {
        state.taskDetailOriginRoute = this.taskDetailOriginRoute;
      }
      if (this.navSection === 'status' && this.activeThreadId && this.deckThreadChannelId) {
        state.deckThreadModal = true;
      }
      if (replace) window.history.replaceState(state, '', nextUrl);
      else window.history.pushState(state, '', nextUrl);
    },

    async applyRouteFromLocation() {
      const route = parseRouteLocation();
      const routeSection = normalizeEnabledFlightDeckSection(route.section);
      this.routeSyncPaused = true;
      try {
        if (route.params.workspacekey) {
          const targetByKey = findWorkspaceByKey(this.knownWorkspaces, route.params.workspacekey);
          if (targetByKey && targetByKey.workspaceKey !== this.currentWorkspaceKey) {
            this.navSection = routeSection;
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(targetByKey.workspaceKey);
            return;
          }
        }
        if (route.params.workspaceid) {
          const targetById = findWorkspaceById(this.knownWorkspaces, route.params.workspaceid);
          if (targetById && targetById.workspaceKey !== this.currentWorkspaceKey) {
            this.navSection = routeSection;
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(targetById.workspaceKey || targetById.workspaceOwnerNpub);
            return;
          }
        }
        if (route.workspaceSlug) {
          const target = findWorkspaceBySlug(this.knownWorkspaces, route.workspaceSlug);
          if (target && target.workspaceKey !== this.currentWorkspaceKey) {
            this.navSection = routeSection;
            this.routeSyncPaused = false;
            await this.handleWorkspaceSwitcherSelect(target.workspaceKey || target.workspaceOwnerNpub);
            return;
          }
        }

        this.navSection = routeSection;
        this.mobileNavOpen = false;
        if (this.navSection !== 'tasks' && this.showTaskDetail) {
          await this.closeTaskDetail({ syncRoute: false });
        }

        if (route.params.scopeid || route.params.groupid) {
          this.selectedBoardId = route.params.scopeid
            || route.params.groupid
            || this.readStoredTaskBoardId()
            || this.preferredTaskBoardId;
          this.validateSelectedBoardId();
          this.persistSelectedBoardId(this.selectedBoardId);
        }

        if (this.navSection === 'chat') {
          let visibleChannels = Array.isArray(this.scopeFilteredChannels) ? this.scopeFilteredChannels : [];
          const isVisibleChannel = (channelId) => visibleChannels.some((channel) => channel.record_id === channelId);
          const routeChannelId = route.params.channelid || null;
          const routeChannel = routeChannelId
            ? (this.channels || []).find((channel) => channel?.record_id === routeChannelId && channel.record_state !== 'deleted') || null
            : null;
          if (routeChannel && !isVisibleChannel(routeChannelId)) {
            this.selectedBoardId = buildPgChannelTaskBoardId(routeChannelId);
            this.persistSelectedBoardId(this.selectedBoardId);
            visibleChannels = Array.isArray(this.scopeFilteredChannels) ? this.scopeFilteredChannels : [];
          }
          const selectedVisibleChannelId = this.selectedChannelId && isVisibleChannel(this.selectedChannelId)
            ? this.selectedChannelId
            : null;
          const selectedPgBoard = parsePgTaskBoardId(this.selectedBoardId);
          const pgScopeHome = Boolean((this.currentWorkspace?.pgBackendMode || this.pgBackendMode) && selectedPgBoard.type === 'scope' && selectedPgBoard.scopeId);
          const channelId = routeChannelId && (routeChannel || isVisibleChannel(routeChannelId))
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
        } else if (this.navSection === 'status') {
          if (route.params.channelid && route.params.threadid) {
            await this.openDeckThread?.(route.params.channelid, route.params.threadid, {
              syncRoute: false,
              captureReturnContext: !this.deckThreadReturnContext,
            });
          } else if (this.activeThreadId) {
            if (this.deckThreadChannelId && typeof this.closeDeckThread === 'function') {
              this.closeDeckThread({ syncRoute: false, fromRoute: true });
            } else {
              this.closeThread?.({ syncRoute: false });
            }
          }
        } else if (this.navSection === 'workroom') {
          if (route.params.workroomid && typeof this.openWorkroomDetail === 'function') {
            await this.openWorkroomDetail(route.params.workroomid, { syncRoute: false });
          } else if (this.workroomDetailOpen) {
            this.closeWorkroomDetail({ syncRoute: false, switchView: false });
          }
        } else if (this.navSection === 'docs') {
          const channelId = route.params.channelid || parsePgTaskBoardId(this.selectedBoardId).channelId;
          if (channelId) {
            const channel = (this.channels || []).find((item) => item.record_id === channelId && item.record_state !== 'deleted');
            this.selectedChannelId = channel ? channelId : null;
            if (channel) this.selectedBoardId = buildPgChannelTaskBoardId(channelId);
          } else {
            this.syncSelectedChannelForPgBoard?.(this.selectedBoardId);
          }
          this.docsHomeVisit = Number(this.docsHomeVisit || 0) + 1;
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
          if (!route.params.scopeid && !route.params.groupid) {
            this.selectedBoardId = this.readStoredTaskBoardId() || this.preferredTaskBoardId;
            this.validateSelectedBoardId();
            this.persistSelectedBoardId(this.selectedBoardId);
          }
          this.showBoardDescendantTasks = route.params.descendants === '1';
          if (route.params.view === 'list') this.taskViewMode = 'list';
          else if (route.params.view === 'kanban') this.taskViewMode = 'kanban';
          else this.taskViewMode = this.mobileViewport ? 'list' : 'kanban';
          this.taskSortMode = normalizeTaskSortMode(route.params.sort);
          this.normalizeTaskFilterTags();
          if (route.params.taskid) {
            await this.openTaskDetailFromRoute(route.params.taskid, {
              syncRoute: false,
              captureOrigin: false,
              originRoute: window.history.state?.taskDetailOriginRoute || '',
            });
          } else {
            this.closeTaskDetail({ syncRoute: false });
          }
        } else if (this.navSection === 'agents') {
          this.selectedWorkspaceAgentId = route.params.agentid || this.workspaceAgents?.[0]?.id || '';
          this.agentSpaceView = ['overview', 'pipelines', 'schedules', 'triggers'].includes(route.params.agentview)
            ? route.params.agentview : 'overview';
          this.pipelineViewerActivationPending=route.params.viewer==='1' && !this.pipelineViewerEnabled;
          this.pipelineViewerOpen=route.params.viewer==='1' && this.pipelineViewerEnabled===true;
          this.pipelineViewerRoute=this.pipelineViewerOpen?{service:route.params.service,signer:route.params.signer,run:route.params.run,definition:route.params.definition}:{};
          if (this.selectedWorkspaceAgentId && !this.pipelineViewerOpen) await this.loadSelectedAgentSpaceView?.();
        }
      } finally {
        this.routeSyncPaused = false;
      }
      this.startWorkspaceLiveQueries();
      this.syncRoute(true);
      if (this.navSection === 'files') await this.startDrive?.();
    },

    // ── Navigation ────────────────────────────────────────────

    navigateTo(section, options = {}) {
      section = normalizeEnabledFlightDeckSection(section);
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
      if(previousSection==='files' && section!=='files') this.stopDrive?.();
      if (section === 'status' && options.preserveDeckMobileCard !== true) {
        this.resetDeckMobileEntry?.();
      }
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
      if (section === 'chat' && options.skipChatChannelSelection !== true) {
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
            this.scheduleChatFeedScrollToBottom();
          }
        }
      }
      if (section === 'docs' && options.docsHome !== false) {
        void this.openChannelDocsHome?.();
      }
      if (section === 'status' && previousSection !== 'status') {
        this.refreshStatusRecentChanges({ force: true });
      }
      if (section === 'reports' && !this.selectedReportId) {
        this.selectedReportId = this.selectedReport?.record_id || null;
      }
      if (section === 'settings') {
        this.normalizeSettingsTab?.();
        if (this.canAdminWorkspace) void this.refreshWappPublishingGrants?.();
        if (this.settingsTab === 'schedules') this.refreshSchedules();
        if (this.settingsTab === 'scopes') this.refreshScopes();
        if (this.settingsTab === 'sharing') this.prepareWorkspaceSharingSettings?.();
      }
      if (options.syncRoute !== false) this.syncRoute();
      this.startWorkspaceLiveQueries();
      this.ensureBackgroundSync(true);
    },

    updateNavigationViewport() {
      this.mobileViewport = typeof window !== 'undefined' && window.innerWidth <= 768;
      if (!this.canLockCurrentView) this.lockedView = null;
    },

    togglePrimaryNav() {
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        this.mobileNavOpen = !this.mobileNavOpen;
        return;
      }
      this.lockedView = null;
      this.navCollapsed = !this.navCollapsed;
    },

    clearInactiveSectionData(activeSection) {
      const keepsChatData = activeSection === 'chat';
      const keepsDocsData = activeSection === 'docs';
      const keepsFilesData = activeSection === 'files';
      if (!keepsChatData) {
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
      if (!keepsDocsData) {
        this.documents = [];
        this.directories = [];
        this.docComments = [];
      }
      if (!keepsFilesData) {
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
    },

    // ── Extension signer ──────────────────────────────────────

    startExtensionSignerWatch() {
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
      if (!this.extensionSignerAvailable && this.session?.method === 'extension') this.lockSubscribedReader?.();
      return this.extensionSignerAvailable;
    },

    // ── Auth ──────────────────────────────────────────────────

    async maybeAutoLogin() {
      try {
        const storedAuth = await tryAutoLoginFromStorage();
        if (!storedAuth) return;

        if (storedAuth.needsReconnect && storedAuth.method === 'bunker') {
          await this.login('bunker', storedAuth.bunkerUri);
          return;
        }

        const npub = await pubkeyToNpub(storedAuth.pubkey);
        if (this.session?.npub && this.session.npub !== npub) {
          clearActiveWorkspaceKey();
        }
        this.session = {
          pubkey: storedAuth.pubkey,
          npub,
          method: storedAuth.method,
        };
        setActiveSessionNpub(npub);
        this.ownerNpub = this.currentWorkspaceOwnerNpub || this.superbasedConnectionConfig?.workspaceOwnerNpub || npub;
        this.resolveChatProfile(npub);
        await this.rememberPeople([npub], 'self');
        this.filterKnownWorkspacesForActiveSession?.();
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

    async login(method, supplemental = null) {
      this.isLoggingIn = true;
      this.loginError = null;
      try {
        const signedEvent = await signLoginEvent(method, supplemental);
        const pubkey = getPubkeyFromEvent(signedEvent);
        const npub = await pubkeyToNpub(pubkey);

        if (this.session?.npub && this.session.npub !== npub) {
          clearActiveWorkspaceKey();
        }
        this.session = { pubkey, npub, method };
        setActiveSessionNpub(npub);
        this.ownerNpub = this.currentWorkspaceOwnerNpub || this.superbasedConnectionConfig?.workspaceOwnerNpub || npub;
        setAutoLogin(method, pubkey);
        this.resolveChatProfile(npub);
        await this.rememberPeople([npub], 'self');
        this.filterKnownWorkspacesForActiveSession?.();
        this.updateWorkspaceBootstrapPrompt();

        await this.discoverPgOnboardingAnnouncements?.();
        await this.discoverPgWorkspaceSelfIndex?.();
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
      this.groups = [];
      this.documents = [];
      this.directories = [];
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
      this.messageInput = '';
      this.threadInput = '';
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
      this.workspaceProfileDashboardGreetingTemplateInput = '';
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

    openHarnessLink() {
      if (!this.workspaceHarnessUrl || typeof window === 'undefined') return;
      window.open(this.workspaceHarnessUrl, '_blank', 'noopener,noreferrer');
    },
  };
}
