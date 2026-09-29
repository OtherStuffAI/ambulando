import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectSSE,
  provideSSEToken,
  rejectSSEToken,
  disconnectSSE,
  flushOnly,
  setSSEStatusCallback,
  runSync,
  startWorkerFlushTimer,
  stopWorkerFlushTimer,
} from '../src/sync-worker-client.js';
import { syncManagerMixin } from '../src/sync-manager.js';
import { createNip98AuthHeader, createNip98AuthHeaderForSecret } from '../src/auth/nostr.js';
import { isTowerPgBackendMode } from '../src/backend-mode.js';
import { syncTowerPgWorkspace } from '../src/pg-read-hydrator.js';
import { flightDeckLog } from '../src/logging.js';
import { getSyncState } from '../src/db.js';

vi.mock('../src/api.js', () => ({
  downloadStorageObject: vi.fn(),
  fetchRecordHistory: vi.fn(),
  syncRecords: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPendingWrites: vi.fn(async () => []),
  getPendingWritesByFamilies: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null),
  updatePendingWrite: vi.fn(async () => 1),
  removePendingWrite: vi.fn(async () => {}),
  clearSyncState: vi.fn(async () => {}),
  clearRuntimeFamilies: vi.fn(async () => {}),
  clearSyncStateForFamilies: vi.fn(async () => {}),
  getSyncQuarantineEntries: vi.fn(async () => []),
  deleteSyncQuarantineEntry: vi.fn(async () => {}),
  clearSyncQuarantineForFamilies: vi.fn(async () => {}),
  deleteRuntimeRecordByFamily: vi.fn(async () => {}),
  upsertTask: vi.fn(async () => {}),
  getTaskById: vi.fn(async () => null),
  upsertWorkspaceSettings: vi.fn(async () => {}),
  upsertFlow: vi.fn(async () => {}),
  getFlowById: vi.fn(async () => null),
  upsertDocument: vi.fn(async () => {}),
  getDocumentById: vi.fn(async () => null),
  upsertDirectory: vi.fn(async () => {}),
  getDirectoryById: vi.fn(async () => null),
  upsertChannel: vi.fn(async () => {}),
  upsertMessage: vi.fn(async () => {}),
  upsertPerson: vi.fn(async () => {}),
  upsertOrganisation: vi.fn(async () => {}),
  upsertOpportunity: vi.fn(async () => {}),
  getOpportunityById: vi.fn(async () => null),
  getCommentsByTarget: vi.fn(async () => []),
  upsertComment: vi.fn(async () => {}),
  getApprovalById: vi.fn(async () => null),
}));

vi.mock('../src/sync-worker-client.js', () => ({
  runSync: vi.fn(),
  flushOnly: vi.fn(),
  pullRecordsForFamilies: vi.fn(),
  pruneOnLogin: vi.fn(),
  startWorkerFlushTimer: vi.fn(),
  stopWorkerFlushTimer: vi.fn(),
  connectSSE: vi.fn(),
  provideSSEToken: vi.fn(),
  rejectSSEToken: vi.fn(),
  acknowledgeSSEBatch: vi.fn(),
  disconnectSSE: vi.fn(),
  setSSEStatusCallback: vi.fn(),
  flushNow: vi.fn(),
}));

vi.mock('../src/auth/nostr.js', () => ({
  createNip98AuthHeader: vi.fn(async () => 'Nostr eyJraW5kIjoyNzIzNX0='),
  createNip98AuthHeaderForSecret: vi.fn(async () => 'Nostr eyJzZWNyZXQiOnRydWV9'),
}));

vi.mock('../src/pg-read-hydrator.js', () => ({
  hydrateTowerPgChannelAgentActivities: vi.fn(async () => []),
  hydrateTowerPgEventUpdates: vi.fn(async () => ({ appliedTargets: 0, fallbackEvents: 0, events: 0 })),
  syncTowerPgWorkspace: vi.fn(async () => ({ pages: 1, changed: 0 })),
  towerPgSyncCursorKey: vi.fn(() => 'tower_pg_sync_cursor:workspace-1:npub1viewer'),
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => false),
}));

vi.mock('../src/logging.js', () => ({
  flightDeckLog: vi.fn(),
  flightDeckTrace: vi.fn(),
  flightDeckSyncFailure: vi.fn(),
}));

vi.mock('../src/crypto/workspace-keys.js', () => ({
  getActiveWorkspaceKeySecretForAuth: vi.fn(() => null),
  isWorkspaceKeyRegistered: vi.fn(() => false),
}));

vi.mock('../src/translators/chat.js', () => ({
  outboundChannel: vi.fn(async (p) => p),
  outboundChatMessage: vi.fn(async (p) => p),
  recordFamilyHash: vi.fn((cs) => `mock:${cs}`),
}));

vi.mock('../src/translators/settings.js', () => ({
  outboundWorkspaceSettings: vi.fn(async (p) => ({ ...p, record_family_hash: 'mock:settings' })),
  recordFamilyHash: vi.fn((cs) => `mock:${cs}`),
}));

beforeEach(() => {
  vi.clearAllMocks();
  isTowerPgBackendMode.mockReturnValue(false);
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Helper: create a fake store with all mixin methods applied
// ---------------------------------------------------------------------------
function createStore(overrides = {}) {
  const store = {
    session: null,
    backendUrl: '',
    navSection: 'chat',
    selectedChannelId: null,
    FAST_SYNC_MS: 15000,
    IDLE_SYNC_MS: 30000,
    SSE_HEARTBEAT_CADENCE_MS: 120000,
    BACKGROUND_GROUP_REFRESH_MS: 300000,
    backgroundSyncTimer: null,
    backgroundSyncInFlight: false,
    visibilityHandler: null,
    lastGroupsRefreshAt: 0,
    syncing: false,
    syncStatus: 'synced',
    showSyncProgressModal: false,
    syncFamilyProgress: [],
    syncSession: {
      state: 'idle',
      phase: 'idle',
      startedAt: null,
      finishedAt: null,
      lastSuccessAt: null,
      manual: false,
      error: null,
      heartbeat: false,
      pushed: 0,
      pushTotal: 0,
      pulled: 0,
      completedFamilies: 0,
      totalFamilies: 0,
      currentFamily: null,
      currentFamilyHash: null,
    },
    syncQuarantine: [],
    sseStatus: 'disconnected',
    catchUpSyncActive: false,
    syncBackoffMs: 0,
    error: null,
    groups: [],
    channels: [],
    messages: [],
    documents: [],
    directories: [],
    reports: [],
    tasks: [],
    taskComments: [],
    scopes: [],
    audioNotes: [],
    schedules: [],
    flows: [],
    persons: [],
    organisations: [],
    hasForcedInitialBackfill: false,
    hasForcedTaskFamilyBackfill: false,
    selectedBoardId: null,
    docsEditorOpen: false,
    selectedDocId: null,
    activeTaskId: null,
    wingmanHarnessDirty: false,
    workspaceOwnerNpub: 'npub1owner',
    currentWorkspaceKey: '',
    superbasedTokenInput: 'test-token-123',
    repairSelectedFamilyIds: [],
    repairError: null,
    repairNotice: '',
    repairBusy: false,
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
    syncQuarantineError: null,
    syncQuarantineNotice: '',
    syncQuarantineBusy: false,
    // Stubs for methods from other mixins
    refreshGroups: vi.fn().mockResolvedValue(undefined),
    refreshChannels: vi.fn().mockResolvedValue(undefined),
    refreshMessages: vi.fn().mockResolvedValue(undefined),
    refreshAudioNotes: vi.fn().mockResolvedValue(undefined),
    refreshDirectories: vi.fn().mockResolvedValue(undefined),
    refreshDocuments: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    refreshSchedules: vi.fn().mockResolvedValue(undefined),
    refreshScopes: vi.fn().mockResolvedValue(undefined),
    refreshWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    refreshStatusRecentChanges: vi.fn().mockResolvedValue(undefined),
    ensureTaskBoardScopeSetup: vi.fn().mockResolvedValue(undefined),
    getEffectiveDocShares: vi.fn((record) => record?.shares || []),
    patchDirectoryLocal: vi.fn(),
    patchDocumentLocal: vi.fn(),
    loadDocComments: vi.fn().mockResolvedValue(undefined),
    loadTaskComments: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  // Apply all mixin methods and getters
  const descriptors = Object.getOwnPropertyDescriptors(syncManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  return store;
}

function bindMethod(methodName, overrides = {}) {
  const store = createStore(overrides);
  const method = store[methodName];
  if (typeof method === 'function') {
    return { fn: method.bind(store), store };
  }
  return { store };
}

// ---------------------------------------------------------------------------
// SSE lifecycle — browser logging boundary
// ---------------------------------------------------------------------------
describe('logSSELifecycle', () => {
  it.each([
    ['connecting', { phase: 'initial-connect' }],
    ['connected', { phase: 'stream-open' }],
    ['reconnecting', { phase: 'backoff', attempt: 1, delayMs: 1000 }],
    ['token-needed', { phase: 'refresh-token' }],
    ['disconnected', { phase: 'client-disconnect' }],
    ['connected', { phase: 'connect-skipped' }],
  ])('does not log routine %s lifecycle status', (status, message) => {
    const { fn } = bindMethod('logSSELifecycle');

    fn(status, message);

    expect(flightDeckLog).not.toHaveBeenCalled();
  });

  it('keeps exhausted reconnect fallback visible with diagnostic context', () => {
    const { fn } = bindMethod('logSSELifecycle', {
      sseConnectionKey: 'active-connection',
    });

    fn('fallback-polling', {
      phase: 'fallback-entered',
      reason: 'reconnect-exhausted',
      attempt: 6,
      delayMs: 32000,
    });

    expect(flightDeckLog).toHaveBeenCalledWith(
      'warn',
      'sse',
      'SSE entered fallback polling mode',
      expect.objectContaining({
        connectionKey: 'active-connection',
        reason: 'reconnect-exhausted',
        attempt: 6,
        delayMs: 32000,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// SSE lifecycle — connectSSEStream
// ---------------------------------------------------------------------------
describe('connectSSEStream', () => {
  it('starts the worker handshake without minting or sending a token', async () => {
    const checkoutPolicyConfig = { familySuffixes: { task: 'checkout_required' } };
    const { fn } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      superbasedTokenInput: 'my-token',
      recordCheckoutPolicyConfig: checkoutPolicyConfig,
    });
    await fn();
    expect(connectSSE).toHaveBeenCalledTimes(1);
    const [ownerNpub, viewerNpub, backendUrl, workspaceDbKey, options] = connectSSE.mock.calls[0];
    expect(ownerNpub).toBe('npub1owner');
    expect(viewerNpub).toBe('npub1viewer');
    expect(backendUrl).toBe('https://tower.example.com');
    expect(workspaceDbKey).toBe('npub1owner');
    expect(options.checkoutPolicyConfig).toBe(checkoutPolicyConfig);
    expect(createNip98AuthHeader).not.toHaveBeenCalled();
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('registers the SSE status callback', async () => {
    const { fn } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    await fn();
    expect(setSSEStatusCallback).toHaveBeenCalledWith(expect.any(Function));
  });

  it('does not connect when session is missing', async () => {
    const { fn } = bindMethod('connectSSEStream', {
      session: null,
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    await fn();
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('does not connect when backendUrl is missing', async () => {
    const { fn } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: '',
      workspaceOwnerNpub: 'npub1owner',
    });
    await fn();
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('does not connect when workspaceOwnerNpub is missing', async () => {
    const { fn } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: '',
    });
    await fn();
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('does not issue a duplicate worker connect while the same handshake is in flight', async () => {
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });

    await Promise.all([store.connectSSEStream(), store.connectSSEStream()]);

    expect(connectSSE).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect a healthy stream for the same workspace/session/backend tuple', async () => {
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      sseStatus: 'connected',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();

    await store.connectSSEStream();

    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('connects SSE in Tower PG mode', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
      sseStatus: 'connected',
    });

    const connected = await fn({ force: true });

    expect(connected).toBe(true);
    expect(connectSSE).toHaveBeenCalledTimes(1);
    const options = connectSSE.mock.calls[0][4];
    expect(options.pgMode).toBe(true);
    expect(options.workspaceId).toBe('workspace-1');
    expect(createNip98AuthHeader).not.toHaveBeenCalled();
    expect(store.sseStatus).not.toBe('disabled');
  });

  it('passes the persisted workspace cursor to the worker with the exact active context', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    getSyncState.mockResolvedValueOnce('workspace-cursor-20420');
    const { fn } = bindMethod('connectSSEStream', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com/api/',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspaceKey: 'pg-workspace-db-key',
      currentWorkspace: { workspaceId: 'workspace-1' },
    });

    await fn();

    expect(connectSSE.mock.calls[0][4].workspaceCursorFallback).toEqual({
      cursor: 'workspace-cursor-20420',
      backendOrigin: 'https://tower.example.com',
      workspaceId: 'workspace-1',
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      workspaceDbKey: 'pg-workspace-db-key',
    });
  });
});

describe('getSSEConnectionContext', () => {
  it('returns the encrypted-record SSE context in default mode', () => {
    const checkoutPolicyConfig = { familySuffixes: { task: 'checkout_required' } };
    const { fn } = bindMethod('getSSEConnectionContext', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspaceKey: 'workspace:npub1owner',
      recordCheckoutPolicyConfig: checkoutPolicyConfig,
    });

    expect(fn()).toEqual({
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace:npub1owner',
      workspaceId: '',
      checkoutPolicyConfig,
    });
  });

  it('returns a SSE context in Tower PG mode', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn } = bindMethod('getSSEConnectionContext', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspaceKey: 'workspace:npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
    });

    expect(fn()).toEqual({
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace:npub1owner',
      workspaceId: 'workspace-1',
      checkoutPolicyConfig: null,
    });
  });

  it('does not return a PG SSE context until the PG workspace id is known', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn } = bindMethod('getSSEConnectionContext', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspaceKey: 'workspace:npub1owner',
    });

    expect(fn()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE lifecycle — disconnectSSEStream
// ---------------------------------------------------------------------------
describe('disconnectSSEStream', () => {
  it('calls disconnectSSE and resets sseStatus', () => {
    const { fn, store } = bindMethod('disconnectSSEStream', {
      sseStatus: 'connected',
    });
    fn();
    expect(disconnectSSE).toHaveBeenCalled();
    expect(store.sseStatus).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// SSE status callback — handleSSEStatus
// ---------------------------------------------------------------------------
describe('handleSSEStatus', () => {
  it('updates sseStatus when status message arrives', () => {
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'disconnected',
    });
    fn({ status: 'connected' });
    expect(store.sseStatus).toBe('connected');
  });

  it('sets catchUpSyncActive on catch-up-required', () => {
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'connected',
      catchUpSyncActive: false,
    });
    fn({ status: 'catch-up-required' });
    expect(store.catchUpSyncActive).toBe(true);
  });

  it('triggers group refresh on group-changed', () => {
    const refreshGroups = vi.fn().mockResolvedValue(undefined);
    const { fn } = bindMethod('handleSSEStatus', {
      sseStatus: 'connected',
      refreshGroups,
    });
    fn({ status: 'group-changed' });
    expect(refreshGroups).toHaveBeenCalledWith({ minIntervalMs: 0 });
  });

  it('widens polling cadence when SSE is connected', () => {
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'disconnected',
    });
    fn({ status: 'connected' });
    expect(store.sseStatus).toBe('connected');
  });

  it('does not scan failed outgoing messages on a healthy initial SSE connect', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const scheduleOfflineMessageResync = vi.fn();
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'disconnected',
      scheduleOfflineMessageResync,
    });
    fn({ status: 'connected' });
    await flushMicrotasks();
    expect(store.sseStatus).toBe('connected');
    expect(scheduleOfflineMessageResync).not.toHaveBeenCalled();
  });

  it('coalesces a background failed-message scan after SSE recovers from a degraded state', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const scheduleOfflineMessageResync = vi.fn();
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'connected',
      scheduleOfflineMessageResync,
    });

    fn({ status: 'reconnecting' });
    expect(store.offlineMessageResyncArmed).toBe(true);
    expect(store.towerReachabilityState).toBe('reconnecting');

    fn({ status: 'connected' });

    expect(store.sseStatus).toBe('connected');
    expect(scheduleOfflineMessageResync).toHaveBeenCalledTimes(1);
    expect(scheduleOfflineMessageResync).toHaveBeenCalledWith({
      refresh: false,
      reason: 'sse-connected',
      delayMs: undefined,
    });
  });

  it('keeps a mobile session usable after fallback sync while SSE probes continue reconnecting', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      workspaceDbKey: 'workspace-mobile',
      currentWorkspace: { workspaceId: 'mobile-space' },
      isEncryptedRecordSyncDisabled: true,
      isLoggedIn: true,
      requestTowerSyncFamily: vi.fn().mockResolvedValue({ ok: true }),
      recoverVisibleAgentActivities: vi.fn().mockResolvedValue(undefined),
      scheduleBackgroundSync: vi.fn(),
    });
    const connectionKey = store.buildSSEConnectionKey();

    store.handleSSEStatus({ status: 'reconnecting', connectionKey, reason: 'eventsource-error' });
    expect(store.towerConnectionIndicatorLabel).toBe('Reconnecting');

    await store.backgroundSyncTick();
    expect(store.towerFallbackReachable).toBe(true);
    expect(store.towerConnectionIndicatorLabel).toBe('');

    store.handleSSEStatus({ status: 'fallback-polling', connectionKey, reason: 'reconnect-exhausted' });
    store.handleSSEStatus({ status: 'reconnecting', connectionKey, reason: 'fallback-probe' });

    expect(store.sseStatus).toBe('reconnecting');
    expect(store.towerReachabilityState).toBe('online');
    expect(store.towerConnectionIndicatorLabel).toBe('');
  });

  it('clears reconnecting with a real workspace pull even when activity recovery fails', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace-mobile',
      currentWorkspace: { workspaceId: 'mobile-space' },
      isLoggedIn: true,
      requestTowerSyncFamily: vi.fn().mockResolvedValue({ applied: 0, pages: 1 }),
      recoverVisibleAgentActivities: vi.fn().mockRejectedValue(new Error('activity endpoint failed')),
      scheduleBackgroundSync: vi.fn(),
      scheduleOfflineMessageResync: vi.fn(),
    });
    const connectionKey = store.buildSSEConnectionKey();
    store.handleSSEStatus({ status: 'reconnecting', connectionKey });
    await store.backgroundSyncTick();

    expect(store.requestTowerSyncFamily).toHaveBeenCalledWith('workspace-bootstrap');
    expect(store.towerConnectionIndicatorLabel).toBe('');
    expect(store.towerFallbackReachable).toBe(true);
    store.handleSSEStatus({ status: 'fallback-polling', connectionKey });
    expect(store.towerConnectionIndicatorLabel).toBe('');
    expect(flightDeckLog).toHaveBeenCalledWith('warn', 'sync', 'activity recovery failed during background sync', expect.any(Object));

    store.requestTowerSyncFamily.mockRejectedValueOnce(new Error('Tower unavailable'));
    await store.backgroundSyncTick();
    expect(store.towerConnectionIndicatorLabel).toBe('Reconnecting');
    expect(store.towerFallbackReachable).toBe(false);
  });

  it('recovers a stale badge when a workspace pull completes outside the polling tick', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace-mobile',
      currentWorkspace: { workspaceId: 'mobile-space' },
      isLoggedIn: true,
      sseStatus: 'reconnecting',
      beginStartupSyncProgress: vi.fn(),
      finishStartupSyncProgress: vi.fn(),
      scheduleOfflineMessageResync: vi.fn(),
    });
    store.markTowerReachabilityDegraded('sse-reconnecting');
    await store.runTowerPgWorkspaceSync();
    expect(store.towerConnectionIndicatorLabel).toBe('');
    expect(store.towerFallbackReachable).toBe(true);
    store.disposeTowerSyncService();
  });

  it.each(['rejected', 'offline', 'switched'])('does not recover from a %s workspace pull', async (outcome) => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace-mobile',
      currentWorkspace: { workspaceId: 'mobile-space' },
      isLoggedIn: true,
      sseStatus: 'reconnecting',
      beginStartupSyncProgress: vi.fn(),
      finishStartupSyncProgress: vi.fn(),
      scheduleOfflineMessageResync: vi.fn(),
    });
    store.markTowerReachabilityDegraded('sse-reconnecting');
    try {
      if (outcome === 'rejected') {
        syncTowerPgWorkspace.mockRejectedValueOnce(new Error('Tower unavailable'));
        await expect(store.runTowerPgWorkspaceSync()).rejects.toThrow('Tower unavailable');
        expect(store.towerConnectionIndicatorLabel).toBe('Reconnecting');
      } else {
        syncTowerPgWorkspace.mockImplementationOnce(async () => {
          if (outcome === 'offline') vi.stubGlobal('navigator', { onLine: false });
          else store.currentWorkspace = { workspaceId: 'second-space' };
          return { applied: 0, pages: 1 };
        });
        await store.runTowerPgWorkspaceSync();
        if (outcome === 'offline') expect(store.towerConnectionIndicatorLabel).toBe('Offline');
        else expect(store.towerReachabilityState).toBe('reconnecting');
      }
      expect(store.towerFallbackReachable).toBe(false);
      expect(store.scheduleOfflineMessageResync).not.toHaveBeenCalled();
    } finally {
      store.disposeTowerSyncService();
      vi.unstubAllGlobals();
    }
  });

  it('shows reconnecting again when Tower fallback fails after a usable mobile recovery', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      workspaceDbKey: 'workspace-mobile',
      currentWorkspace: { workspaceId: 'mobile-space' },
      isEncryptedRecordSyncDisabled: true,
      isLoggedIn: true,
      sseStatus: 'reconnecting',
      towerReachabilityState: 'online',
      towerReachabilityReason: 'background-sync-success',
      towerReachabilityConnectionKey: '',
      towerFallbackReachable: true,
    });
    store.towerReachabilityConnectionKey = store.buildSSEConnectionKey();

    store.markTowerReachabilityOperationFailed('background-sync-failed');

    expect(store.towerFallbackReachable).toBe(false);
    expect(store.towerReachabilityState).toBe('reconnecting');
    expect(store.towerConnectionIndicatorLabel).toBe('Reconnecting');
  });

  it('ignores a late reconnect event from the previous workspace after the active stream recovered', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1active',
      workspaceDbKey: 'workspace-active',
      currentWorkspace: { workspaceId: 'active-space' },
      isEncryptedRecordSyncDisabled: true,
      isLoggedIn: true,
      scheduleBackgroundSync: vi.fn(),
    });
    const activeConnectionKey = store.buildSSEConnectionKey();
    store.sseConnectionKey = activeConnectionKey;

    store.handleSSEStatus({ status: 'connected', connectionKey: activeConnectionKey });
    store.handleSSEStatus({ status: 'reconnecting', connectionKey: 'obsolete-space-stream' });

    expect(store.sseStatus).toBe('connected');
    expect(store.sseConnectionKey).toBe(activeConnectionKey);
    expect(store.towerReachabilityState).toBe('online');
    expect(store.towerConnectionIndicatorLabel).toBe('');
  });

  it('does not run a delayed recovery retry after switching spaces', async () => {
    vi.useFakeTimers();
    isTowerPgBackendMode.mockReturnValue(true);
    const retryUnsyncedOutgoingMessages = vi.fn();
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1first',
      workspaceDbKey: 'workspace-first',
      currentWorkspace: { workspaceId: 'first-space' },
      isEncryptedRecordSyncDisabled: true,
      retryUnsyncedOutgoingMessages,
    });

    try {
      store.markTowerReachabilityDegraded('sse-disconnected', 'reconnecting');
      store.markTowerReachabilityRecovered('sse-connected', { delayMs: 25 });
      store.workspaceOwnerNpub = 'npub1second';
      store.workspaceDbKey = 'workspace-second';
      store.currentWorkspace = { workspaceId: 'second-space' };

      await vi.advanceTimersByTimeAsync(25);
      await vi.runOnlyPendingTimersAsync();

      expect(retryUnsyncedOutgoingMessages).not.toHaveBeenCalled();
      expect(store.offlineMessageResyncArmed).toBe(false);
      expect(store.towerConnectionIndicatorLabel).toBe('');
    } finally {
      store.cancelScheduledOfflineMessageResync();
      vi.useRealTimers();
    }
  });

  it('runs the failed-message scan as one delayed background job after recovery', async () => {
    vi.useFakeTimers();
    isTowerPgBackendMode.mockReturnValue(true);
    const retryUnsyncedOutgoingMessages = vi.fn().mockResolvedValue({ attempted: 0, sent: 0, failed: 0 });
    const { store } = bindMethod('scheduleOfflineMessageResync', {
      retryUnsyncedOutgoingMessages,
    });

    try {
      expect(store.scheduleOfflineMessageResync({ reason: 'healthy', delayMs: 1 })).toBe(false);
      store.markTowerReachabilityDegraded('background-sync-failed', 'reconnecting');
      expect(store.scheduleOfflineMessageResync({ reason: 'background-sync-success', delayMs: 25 })).toBe(true);
      expect(store.scheduleOfflineMessageResync({ reason: 'duplicate', delayMs: 25 })).toBe(false);
      expect(retryUnsyncedOutgoingMessages).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      await vi.runOnlyPendingTimersAsync();
      await flushMicrotasks();

      expect(retryUnsyncedOutgoingMessages).toHaveBeenCalledTimes(1);
      expect(retryUnsyncedOutgoingMessages).toHaveBeenCalledWith({ refresh: false });
      expect(store.offlineMessageResyncScheduled).toBe(false);
      expect(store.offlineMessageResyncArmed).toBe(false);
    } finally {
      store.cancelScheduledOfflineMessageResync();
      vi.useRealTimers();
    }
  });

  it('keeps the recovered current connection online when its delayed failed-message retry errors', async () => {
    vi.useFakeTimers();
    isTowerPgBackendMode.mockReturnValue(true);
    const retryUnsyncedOutgoingMessages = vi.fn(function retryFailedMessage() {
      this.markTowerReachabilityOperationFailed('chat-message-send-failed');
      return Promise.resolve({ attempted: 1, sent: 0, failed: 1 });
    });
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      workspaceDbKey: 'workspace-current',
      currentWorkspace: { workspaceId: 'current-space' },
      isEncryptedRecordSyncDisabled: true,
      isLoggedIn: true,
      sseStatus: 'connected',
      retryUnsyncedOutgoingMessages,
    });

    try {
      store.markTowerReachabilityDegraded('sse-reconnecting', 'reconnecting');
      expect(store.markTowerReachabilityRecovered('full-sync-success', { delayMs: 25 })).toBe(true);
      expect(store.towerConnectionIndicatorLabel).toBe('');

      await vi.advanceTimersByTimeAsync(25);
      await vi.runOnlyPendingTimersAsync();
      await flushMicrotasks();

      expect(retryUnsyncedOutgoingMessages).toHaveBeenCalledTimes(1);
      expect(store.offlineMessageLastResult).toEqual({ attempted: 1, sent: 0, failed: 1 });
      expect(store.sseStatus).toBe('connected');
      expect(store.towerReachabilityState).toBe('online');
      expect(store.towerReachabilityReason).toBe('full-sync-success');
      expect(store.towerConnectionIndicatorLabel).toBe('');
    } finally {
      store.cancelScheduledOfflineMessageResync();
      vi.useRealTimers();
    }
  });

  it('still marks command failure as reconnecting when the current stream is disconnected', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({ sseStatus: 'disconnected' });

    expect(store.markTowerReachabilityOperationFailed('chat-message-send-failed')).toBe(true);
    expect(store.towerReachabilityState).toBe('reconnecting');
    expect(store.towerReachabilityReason).toBe('chat-message-send-failed');
  });

  it('signs the exact legacy semantic URL requested by the worker', async () => {
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      sseStatus: 'reconnecting',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const signingUrl = 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=event+7%2F8';

    await store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-7',
      signingUrl,
    });

    expect(createNip98AuthHeader).toHaveBeenCalledWith(signingUrl, 'GET', null);
    expect(provideSSEToken).toHaveBeenCalledWith(
      'sse-token-7',
      store.sseConnectionKey,
      'eyJraW5kIjoyNzIzNX0=',
    );
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('signs the exact PG cursor URL with the scoped workspace key', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    getActiveWorkspaceKeySecretForAuth
      .mockReturnValueOnce('workspace-secret')
      .mockReturnValueOnce('workspace-secret');
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const signingUrl = 'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream?cursor=opaque+cursor%2F2';

    await store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-8',
      signingUrl,
    });

    expect(createNip98AuthHeaderForSecret).toHaveBeenCalledWith(signingUrl, 'GET', null, 'workspace-secret');
    expect(provideSSEToken).toHaveBeenCalledWith(
      'sse-token-8',
      store.sseConnectionKey,
      'eyJzZWNyZXQiOnRydWV9',
    );
  });

  it.each([
    'https://evil.example/api/v4/workspaces/npub1owner/stream',
    'https://tower.example.com/api/v4/workspaces/npub1other/stream',
    'https://tower.example.com/api/v4/workspaces/npub1owner/stream?next=https%3A%2F%2Fevil.example',
    'https://tower.example.com/api/v4/workspaces/npub1owner/stream?token=already-present',
  ])('rejects an unexpected worker signing target without exposing it in logs', async (signingUrl) => {
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();

    await store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-bad',
      signingUrl,
    });

    expect(createNip98AuthHeader).not.toHaveBeenCalled();
    expect(provideSSEToken).not.toHaveBeenCalled();
    expect(JSON.stringify(flightDeckLog.mock.calls)).not.toContain(signingUrl);
  });

  it('discards signing completion after the workspace context changes', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveAuth;
    createNip98AuthHeader.mockImplementationOnce(() => new Promise((resolve) => { resolveAuth = resolve; }));
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const pending = store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-old',
      signingUrl: 'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream?cursor=old',
    });

    store.currentWorkspace = { workspaceId: 'workspace-2' };
    resolveAuth('Nostr stale-token');
    await pending;

    expect(provideSSEToken).not.toHaveBeenCalled();
  });

  it('discards signing completion after disconnect', async () => {
    let resolveAuth;
    createNip98AuthHeader.mockImplementationOnce(() => new Promise((resolve) => { resolveAuth = resolve; }));
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const pending = store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-old',
      signingUrl: 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=old',
    });

    store.disconnectSSEStream();
    resolveAuth('Nostr stale-token');
    await pending;

    expect(provideSSEToken).not.toHaveBeenCalled();
  });

  it('discards signing completion after the scoped workspace key changes', async () => {
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    getActiveWorkspaceKeySecretForAuth
      .mockReturnValueOnce('old-workspace-secret')
      .mockReturnValueOnce('new-workspace-secret');
    let resolveAuth;
    createNip98AuthHeaderForSecret.mockImplementationOnce(() => new Promise((resolve) => { resolveAuth = resolve; }));
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const pending = store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-old-key',
      signingUrl: 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=old',
    });

    resolveAuth('Nostr stale-token');
    await pending;

    expect(provideSSEToken).not.toHaveBeenCalled();
  });

  it('discards an older signing completion after a newer cursor request', async () => {
    const resolvers = [];
    createNip98AuthHeader
      .mockImplementationOnce(() => new Promise((resolve) => { resolvers.push(resolve); }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();
    const first = store.handleSSEStatus({
      status: 'token-needed', connectionKey: store.sseConnectionKey, requestId: 'sse-token-1',
      signingUrl: 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=1',
    });
    const second = store.handleSSEStatus({
      status: 'token-needed', connectionKey: store.sseConnectionKey, requestId: 'sse-token-2',
      signingUrl: 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=2',
    });

    resolvers[0]('Nostr stale-token');
    resolvers[1]('Nostr current-token');
    await Promise.all([first, second]);

    expect(provideSSEToken).toHaveBeenCalledOnce();
    expect(provideSSEToken).toHaveBeenCalledWith('sse-token-2', store.sseConnectionKey, 'current-token');
  });

  it('keeps the token and complete signing URL out of lifecycle and auth-failure logs', async () => {
    const signingUrl = 'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=sensitive-cursor';
    createNip98AuthHeader.mockRejectedValueOnce(new Error(`failed to sign ${signingUrl}`));
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });
    store.sseConnectionKey = store.buildSSEConnectionKey();

    await store.handleSSEStatus({
      status: 'token-needed',
      connectionKey: store.sseConnectionKey,
      requestId: 'sse-token-sensitive',
      signingUrl,
      token: 'transport-token-must-not-log',
    });

    const logged = JSON.stringify(flightDeckLog.mock.calls);
    expect(logged).not.toContain(signingUrl);
    expect(logged).not.toContain('sensitive-cursor');
    expect(logged).not.toContain('transport-token-must-not-log');
  });

  it('runs bundled workspace sync on pull-complete in Tower PG mode', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    syncTowerPgWorkspace.mockResolvedValueOnce({ pages: 1, changed: 0 });
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'connected',
    });

    await fn({ status: 'pull-complete', families: ['family:channel'] });

    expect(syncTowerPgWorkspace).toHaveBeenCalledTimes(1);
    expect(syncTowerPgWorkspace.mock.calls[0][0]).toBe(store);
    expect(store.sseStatus).toBe('connected');
  });

  it('keeps the healthy SSE cadence across pull and cursor acknowledgement notifications', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const pgEvents = [{ entity_type: 'message', entity_id: 'message-1', channel_id: 'channel-1' }];
    const { fn, store } = bindMethod('handleSSEStatus', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      sseStatus: 'connected',
      navSection: 'chat',
      selectedChannelId: 'channel-1',
    });

    await fn({ status: 'pull-complete', families: ['flightdeck_pg'], pgEvents });
    fn({ status: 'cursor-acknowledged', batchId: 'batch-1' });

    expect(store.sseStatus).toBe('connected');
    expect(store.getSyncCadenceMs()).toBe(store.SSE_HEARTBEAT_CADENCE_MS);
  });

  it('falls back to polling-only on fallback-polling status', () => {
    const { fn, store } = bindMethod('handleSSEStatus', {
      sseStatus: 'connected',
    });
    fn({ status: 'fallback-polling' });
    expect(store.sseStatus).toBe('fallback-polling');
  });
});

// ---------------------------------------------------------------------------
// SSE-aware sync cadence
// ---------------------------------------------------------------------------
describe('getSyncCadenceMs with SSE', () => {
  it('returns SSE_HEARTBEAT_CADENCE_MS when SSE is connected', () => {
    const { fn } = bindMethod('getSyncCadenceMs', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'chat',
      selectedChannelId: 'ch1',
      sseStatus: 'connected',
    });
    expect(fn()).toBe(120000);
  });

  it('returns normal FAST_SYNC_MS when SSE is disconnected', () => {
    const { fn } = bindMethod('getSyncCadenceMs', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'chat',
      selectedChannelId: 'ch1',
      sseStatus: 'disconnected',
    });
    expect(fn()).toBe(15000);
  });

  it('returns normal FAST_SYNC_MS when SSE is in fallback-polling', () => {
    const { fn } = bindMethod('getSyncCadenceMs', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'tasks',
      sseStatus: 'fallback-polling',
    });
    expect(fn()).toBe(15000);
  });

  it('uses SSE heartbeat cadence when PG SSE is connected', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn } = bindMethod('getSyncCadenceMs', {
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'chat',
      selectedChannelId: 'ch1',
      sseStatus: 'connected',
    });
    expect(fn()).toBe(120000);
  });
});

// ---------------------------------------------------------------------------
// ensureBackgroundSync wires SSE
// ---------------------------------------------------------------------------
describe('ensureBackgroundSync wires SSE', () => {
  it('connects SSE when session and backend are available', async () => {
    const checkoutPolicyConfig = { familySuffixes: { task: 'checkout_required' } };
    const { fn } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      recordCheckoutPolicyConfig: checkoutPolicyConfig,
    });
    fn(false);
    await flushMicrotasks();
    expect(connectSSE).toHaveBeenCalledTimes(1);
    const [ownerNpub, viewerNpub, backendUrl, workspaceDbKey, options] = connectSSE.mock.calls[0];
    expect(ownerNpub).toBe('npub1owner');
    expect(viewerNpub).toBe('npub1viewer');
    expect(backendUrl).toBe('https://tower.example.com');
    expect(workspaceDbKey).toBe('npub1owner');
    expect(options.checkoutPolicyConfig).toBe(checkoutPolicyConfig);
    expect(createNip98AuthHeader).not.toHaveBeenCalled();
  });

  it('does not tear down and recreate SSE on repeated ensureBackgroundSync calls for the same stream', async () => {
    const store = createStore({
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });

    store.ensureBackgroundSync(false);
    await flushMicrotasks();
    expect(connectSSE).toHaveBeenCalledTimes(1);

    store.handleSSEStatus({
      status: 'connected',
      connectionKey: store.buildSSEConnectionKey(),
      phase: 'stream-open',
      reason: 'eventsource-open',
    });

    store.ensureBackgroundSync(true);

    expect(connectSSE).toHaveBeenCalledTimes(1);
  });

  it('does not show the blocking catch-up overlay when last success is only missing from memory', () => {
    const { fn, store } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      catchUpSyncActive: false,
      syncSession: {
        ...createStore().syncSession,
        lastSuccessAt: null,
      },
    });

    fn(true);

    expect(store.catchUpSyncActive).toBe(false);
    clearTimeout(store.backgroundSyncTimer);
  });

  it('does not replace usable local state with a catch-up overlay based only on age', () => {
    const { fn, store } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      catchUpSyncActive: false,
      syncSession: {
        ...createStore().syncSession,
        lastSuccessAt: Date.now() - (11 * 60 * 60 * 1000),
      },
    });

    fn(true);

    expect(store.catchUpSyncActive).toBe(false);
    clearTimeout(store.backgroundSyncTimer);
  });

  it('does not connect SSE when workspaceOwnerNpub is missing', () => {
    const { fn } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: '',
    });
    fn(false);
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('still starts worker flush timer alongside SSE', () => {
    const checkoutPolicyConfig = { familySuffixes: { task: 'checkout_required' } };
    const { fn } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      recordCheckoutPolicyConfig: checkoutPolicyConfig,
    });
    fn(false);
    expect(startWorkerFlushTimer).toHaveBeenCalledWith(
      'npub1owner',
      'https://tower.example.com',
      'npub1owner',
      { checkoutPolicyConfig },
    );
  });

  it('keeps PG in advisory mode while still opening SSE', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindMethod('ensureBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
      backgroundSyncTimer: setTimeout(() => {}, 1000),
      sseStatus: 'connected',
      catchUpSyncActive: true,
      backgroundSyncInFlight: true,
    });

    fn(true);
    await flushMicrotasks();

    expect(stopWorkerFlushTimer).not.toHaveBeenCalled();
    expect(startWorkerFlushTimer).not.toHaveBeenCalled();
    expect(connectSSE).toHaveBeenCalledTimes(1);
    expect(store.backgroundSyncTimer).not.toBeNull();
    clearTimeout(store.backgroundSyncTimer);
    expect(store.sseStatus).toBe('connected');
    expect(store.syncSession.state).toBe('disabled');
  });

  it('does not demote a healthy typed SSE stream during a PG heartbeat', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const requestTowerSyncFamily = vi.fn(async () => ({ applied: 0 }));
    const { fn, store } = bindMethod('backgroundSyncTick', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
      selectedChannelId: 'channel-1',
      sseStatus: 'connected',
      requestTowerSyncFamily,
    });

    await fn();

    expect(requestTowerSyncFamily).toHaveBeenCalledWith('workspace-bootstrap');
    expect(store.sseStatus).toBe('connected');
    expect(store.getSyncCadenceMs()).toBe(store.SSE_HEARTBEAT_CADENCE_MS);
    if (store.backgroundSyncTimer) clearTimeout(store.backgroundSyncTimer);
  });
});

describe('Tower PG sync lifecycle guard', () => {
  it('skips performSync before encrypted-record worker sync can run', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindMethod('performSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });

    const result = await fn({ manual: true });

    expect(result).toMatchObject({ pushed: 0, pulled: 0, pruned: 0, disabled: true });
    expect(runSync).not.toHaveBeenCalled();
    expect(store.syncStatus).toBe('disabled');
    expect(store.syncSession.state).toBe('disabled');
  });

  it('skips flushAndBackgroundSync before encrypted-record flush can run', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindMethod('flushAndBackgroundSync', {
      session: { npub: 'npub1viewer' },
      backendUrl: 'https://tower.example.com',
      workspaceOwnerNpub: 'npub1owner',
    });

    const result = await fn();

    expect(result).toMatchObject({ pushed: 0, disabled: true });
    expect(flushOnly).not.toHaveBeenCalled();
    expect(store.syncStatus).toBe('disabled');
    expect(store.syncSession.state).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// stopBackgroundSync disconnects SSE
// ---------------------------------------------------------------------------
describe('stopBackgroundSync disconnects SSE', () => {
  it('disconnects SSE when stopping background sync', () => {
    const timer = setTimeout(() => {}, 10000);
    const { fn, store } = bindMethod('stopBackgroundSync', {
      backgroundSyncTimer: timer,
      sseStatus: 'connected',
    });
    fn();
    expect(disconnectSSE).toHaveBeenCalled();
    expect(store.sseStatus).toBe('disconnected');
    expect(store.backgroundSyncTimer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE status getter
// ---------------------------------------------------------------------------
describe('isSSEConnected', () => {
  it('returns true when sseStatus is connected', () => {
    const store = createStore({ sseStatus: 'connected' });
    expect(store.isSSEConnected).toBe(true);
  });

  it('returns false when sseStatus is disconnected', () => {
    const store = createStore({ sseStatus: 'disconnected' });
    expect(store.isSSEConnected).toBe(false);
  });

  it('returns false when sseStatus is reconnecting', () => {
    const store = createStore({ sseStatus: 'reconnecting' });
    expect(store.isSSEConnected).toBe(false);
  });

  it('returns false when sseStatus is fallback-polling', () => {
    const store = createStore({ sseStatus: 'fallback-polling' });
    expect(store.isSSEConnected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Steady-state sync contract summary
// ---------------------------------------------------------------------------
describe('sync contract: SSE-first with heartbeat fallback', () => {
  it('widens polling interval when SSE is connected (heartbeat for catch-up only)', () => {
    const store = createStore({
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'tasks',
      sseStatus: 'connected',
    });
    const cadence = store.getSyncCadenceMs();
    // When SSE is connected, heartbeat cadence should be much wider than normal
    expect(cadence).toBeGreaterThan(store.FAST_SYNC_MS);
    expect(cadence).toBe(store.SSE_HEARTBEAT_CADENCE_MS);
  });

  it('returns to aggressive polling when SSE falls back', () => {
    const store = createStore({
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'tasks',
      sseStatus: 'fallback-polling',
    });
    const cadence = store.getSyncCadenceMs();
    expect(cadence).toBe(store.FAST_SYNC_MS);
  });

  it('returns to aggressive polling when SSE is disconnected', () => {
    const store = createStore({
      session: { npub: 'npub1me' },
      backendUrl: 'https://backend.example.com',
      navSection: 'tasks',
      sseStatus: 'disconnected',
    });
    const cadence = store.getSyncCadenceMs();
    expect(cadence).toBe(store.FAST_SYNC_MS);
  });
});
