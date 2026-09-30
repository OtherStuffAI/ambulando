import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncManagerMixin } from '../src/sync-manager.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { hydrateTowerPgChannelAgentActivities, hydrateTowerPgAgentSessionHealth, hydrateTowerPgThreadMessages } from '../src/pg-read-hydrator.js';
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
  hydrateTowerPgThreadMessages: vi.fn(async () => ['materialized-message']),
  hydrateTowerPgChannelAgentActivities: vi.fn(async () => []),
  hydrateTowerPgAgentSessionHealth: vi.fn(async () => []),
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


function store() {
  const target = {
    selectedChannelId: 'channel-a', currentWorkspaceKey: 'workspace-a',
    sseConnectionKey: 'workspace-a', sseStatus: 'connected',
    towerPgLastReplayDeltaAt: Date.now(), agentActivityRecoveryStartedAt: 1,
    agentActivityRecoveryAttempts: 0, agentActivityRecoveryError: '',
    isEncryptedRecordSyncDisabled: true,
    buildSSEConnectionKey() { return this.currentWorkspaceKey; },
    scheduleBackgroundSync: vi.fn(), getSyncCadenceMs: () => 15000,
    markEncryptedRecordSyncDisabled: vi.fn(), logSSELifecycle: vi.fn(),
    runTowerPgWorkspaceSync: vi.fn(async () => ({})),
  };
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(syncManagerMixin))) {
    if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, descriptor);
  }
  target._towerSyncService = new TowerSyncService({
    workspaceKey: 'workspace-a',
    ports: { ensureLoaded: (family, id, options) => target.loadTowerSyncTarget(family === 'workspace-bootstrap' ? 'workspace' : family, id, options) },
  });
  return target;
}

beforeEach(() => {
  vi.clearAllMocks();
  hydrateTowerPgChannelAgentActivities.mockReset().mockResolvedValue([]);
  hydrateTowerPgAgentSessionHealth.mockReset().mockResolvedValue([]);
});

describe('authoritative agent activity recovery through the sync owner', () => {
  it('recovers on reconnect even when workspace delta ran less than 30 seconds ago', async () => {
    const target = store();
    await target.handleSSEStatus({ status: 'connected' });
    expect(target.runTowerPgWorkspaceSync).not.toHaveBeenCalled();
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledTimes(1);
    expect(hydrateTowerPgChannelAgentActivities.mock.calls[0][1]).toBe('channel-a');
    expect(hydrateTowerPgChannelAgentActivities.mock.calls[0][2].recover).toBe(true);
    expect(target.agentActivityRecoveryStartedAt).toBe(0);
  });

  it('fallback tick recovers missed activity before workspace delta', async () => {
    const target = store();
    target.sseStatus = 'fallback-polling';
    await target.backgroundSyncTick();
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledTimes(1);
    expect(target.runTowerPgWorkspaceSync).toHaveBeenCalledTimes(1);
    expect(hydrateTowerPgChannelAgentActivities.mock.invocationCallOrder[0]).toBeLessThan(target.runTowerPgWorkspaceSync.mock.invocationCallOrder[0]);
  });

  it('recovers the open Inbox thread rather than an unrelated selected chat channel', async () => {
    const target = store();
    Object.assign(target, { navSection: 'status', deckThreadChannelId: 'inbox-channel', activeThreadId: 'message-root', deckThreadTowerId: 'inbox-thread' });
    await target.handleSSEStatus({ status: 'connected' });
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledWith(expect.anything(), 'inbox-channel', expect.objectContaining({ threadId: 'inbox-thread', recover: true }));
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledTimes(1);
  });

  it('loads activity alongside initial thread messages and keeps messages after an activity failure', async () => {
    const target = store();
    Object.assign(target, { navSection: 'status', deckThreadChannelId: 'inbox-channel', activeThreadId: 'root', deckThreadTowerId: 'inbox-thread' });
    hydrateTowerPgChannelAgentActivities.mockRejectedValueOnce(new Error('offline'));
    const result = await target.loadThreadMessagesWithActivity({ channelId: 'inbox-channel', threadId: 'inbox-thread' });
    expect(result).toEqual(['materialized-message']);
    expect(hydrateTowerPgThreadMessages).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(target.agentActivityRecoveryError).toContain('Retrying'));
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledWith(expect.anything(), 'inbox-channel', expect.objectContaining({ threadId: 'inbox-thread', recover: true }));
  });

  it('publishes thread readiness while unrelated activity and health remain pending', async () => {
    const target = store();
    let release;
    hydrateTowerPgChannelAgentActivities.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = await target.loadThreadMessagesWithActivity({ channelId: 'inbox-channel', threadId: 'inbox-thread' });
    expect(result).toEqual(['materialized-message']);
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledTimes(1);
    release([]);
  });

  it('coalesces simultaneous recovery requests within the same service', async () => {
    const target = store();
    let resolve;
    hydrateTowerPgChannelAgentActivities.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = target.recoverVisibleAgentActivities();
    const duplicate = target.recoverVisibleAgentActivities();
    await Promise.resolve();
    expect(hydrateTowerPgChannelAgentActivities).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([first, duplicate]);
    expect(target._towerSyncService.instrumentation.coalescedRequests).toBe(2);
  });

  it('shows sanitized failures, limits fast retries and clears failure after recovery', async () => {
    const target = store();
    hydrateTowerPgChannelAgentActivities.mockRejectedValue(new Error('private token must never enter UI'));
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await target.backgroundSyncTick();
      expect(target.agentActivityRecoveryAttempts).toBe(attempt);
      expect(target.agentActivityRecoveryError).not.toContain('private token');
      expect(target.scheduleBackgroundSync).toHaveBeenLastCalledWith(attempt < 3 ? 1000 * (2 ** (attempt - 1)) : null);
    }
    expect(target.agentActivityRecoveryError).toBe('Activity updates could not be recovered. Retrying with background sync.');
    hydrateTowerPgChannelAgentActivities.mockResolvedValue([]);
    await target.backgroundSyncTick();
    expect(target.agentActivityRecoveryError).toBe('');
    expect(target.agentActivityRecoveryStartedAt).toBe(0);
  });

  it('continues bounded forward recovery pages on the sole background schedule', async () => {
    const target = store();
    hydrateTowerPgChannelAgentActivities.mockResolvedValueOnce(Object.assign([], { recovery_pending: true }));
    await target.backgroundSyncTick();
    expect(target.agentActivityRecoveryPending).toBe(true);
    expect(target.agentActivityRecoveryStartedAt).toBe(1);
    expect(target.scheduleBackgroundSync).toHaveBeenLastCalledWith(1000);
    await target.backgroundSyncTick();
    expect(target.agentActivityRecoveryPending).toBe(false);
    expect(target.agentActivityRecoveryStartedAt).toBe(0);
  });

  it('keeps current recovery status when a different channel completion arrives or older history loads', async () => {
    const target = store();
    let resolve;
    hydrateTowerPgChannelAgentActivities.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = target.loadTowerPgAgentActivities('channel-a');
    target.selectedChannelId = 'channel-b';
    target.agentActivityRecoveryError = 'current channel recovery';
    resolve([]);
    await pending;
    expect(target.agentActivityRecoveryError).toBe('current channel recovery');
    await target.loadTowerPgAgentActivities('channel-b', { activityId: 'finished-activity', beforeSequence: 20, recover: false });
    expect(target.agentActivityRecoveryError).toBe('current channel recovery');
  });

  it('ignores stale completion after leaving and returning to the same workspace', async () => {
    const target = store();
    let resolve;
    hydrateTowerPgChannelAgentActivities.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = target.loadTowerPgAgentActivities('channel-a');
    target._towerSyncService = new TowerSyncService({ workspaceKey: 'workspace-a' });
    target.agentActivityRecoveryError = 'new owner recovery';
    resolve([]);
    await pending;
    expect(target.agentActivityRecoveryError).toBe('new owner recovery');
  });

  it.each(['resolve', 'reject'])('does not leak late %s status after workspace switch', async (outcome) => {
    const target = store();
    let settle;
    hydrateTowerPgChannelAgentActivities.mockImplementationOnce(() => new Promise((resolve, reject) => { settle = outcome === 'resolve' ? resolve : reject; }));
    const pending = target.loadTowerPgAgentActivities('channel-a').catch(() => {});
    target.currentWorkspaceKey = 'workspace-b';
    target.agentActivityRecoveryStartedAt = 123;
    target.agentActivityRecoveryError = 'new workspace state';
    settle(outcome === 'resolve' ? [] : new Error('old workspace failure'));
    await pending;
    expect(target.agentActivityRecoveryStartedAt).toBe(123);
    expect(target.agentActivityRecoveryError).toBe('new workspace state');
    expect(target.scheduleBackgroundSync).not.toHaveBeenCalled();
  });
});
