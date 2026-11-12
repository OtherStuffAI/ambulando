import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  broadcastWorkspaceSelfIndexEventMock,
  publishWorkspaceSelfIndexMock,
  publishWorkspaceSelfIndexTombstoneMock,
  queryWorkspaceSelfIndexCandidatesMock,
} = vi.hoisted(() => ({
  broadcastWorkspaceSelfIndexEventMock: vi.fn(),
  publishWorkspaceSelfIndexMock: vi.fn(),
  publishWorkspaceSelfIndexTombstoneMock: vi.fn(),
  queryWorkspaceSelfIndexCandidatesMock: vi.fn(),
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => true),
}));

vi.mock('../src/nostr-workspace-self-index.js', () => ({
  broadcastWorkspaceSelfIndexEvent: broadcastWorkspaceSelfIndexEventMock,
  flightDeckSelfIndexAppPubkeyHex: vi.fn(() => 'b'.repeat(64)),
  publishWorkspaceSelfIndex: publishWorkspaceSelfIndexMock,
  publishWorkspaceSelfIndexTombstone: publishWorkspaceSelfIndexTombstoneMock,
  queryWorkspaceSelfIndexCandidates: queryWorkspaceSelfIndexCandidatesMock,
  workspaceSelfIndexRelayUrls: vi.fn((...lists) => lists.flat().filter(Boolean)),
}));

const descriptor = {
  type: 'wingman_workspace_locator',
  version: 1,
  tower_base_url: 'https://tower.example',
  identity: {
    tower_service_npub: 'npub1tower',
    workspace_service_npub: 'npub1workspace',
    workspace_owner_npub: 'npub1owner',
    workspace_id: 'workspace-1',
    app_npub: 'flightdeck_pg',
  },
  label: 'Wingers',
  links: {
    descriptor: '/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
    me: '/api/v4/flightdeck-pg/workspaces/workspace-1/me',
  },
};

const workspace = {
  workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg::id:workspace-1',
  workspaceOwnerNpub: 'npub1owner',
  name: 'Wingers',
  directHttpsUrl: 'https://tower.example',
  towerServiceNpub: 'npub1tower',
  serviceNpub: 'npub1tower',
  workspaceServiceNpub: 'npub1workspace',
  workspaceId: 'workspace-1',
  appNpub: 'flightdeck_pg',
  pgSessionNpub: 'npub1user',
  pgBackendMode: true,
  pgDescriptor: descriptor,
};

function createStore(overrides = {}) {
  return {
    session: { npub: 'npub1user', pubkey: 'a'.repeat(64) },
    currentWorkspace: null,
    knownWorkspaces: [workspace],
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    persistWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    verifyPgDescriptor: vi.fn().mockResolvedValue({
      descriptor,
      me: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
    }),
    rememberVerifiedPgWorkspace: vi.fn(async () => workspace),
    ...overrides,
  };
}

describe('workspace self-index manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    publishWorkspaceSelfIndexMock.mockReset();
    publishWorkspaceSelfIndexTombstoneMock.mockReset();
    broadcastWorkspaceSelfIndexEventMock.mockReset();
    queryWorkspaceSelfIndexCandidatesMock.mockReset();
  });

  async function bindStore(overrides = {}) {
    const { workspaceSelfIndexManagerMixin } = await import('../src/workspace-self-index-manager.js');
    const store = createStore(overrides);
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workspaceSelfIndexManagerMixin));
    return store;
  }

  it('marks a verified PG workspace indexed after successful publish', async () => {
    publishWorkspaceSelfIndexMock.mockResolvedValue({
      event: { id: 'event-1' },
      acceptedRelays: ['wss://relay.test'],
      publishedAt: '2026-06-07T00:00:00.000Z',
    });
    const store = await bindStore();

    await store.publishPgWorkspaceSelfIndex(workspace);

    expect(publishWorkspaceSelfIndexMock).toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'indexed',
      pgSelfIndexEventId: 'event-1',
      pgSelfIndexSignedEvent: { id: 'event-1' },
      pgSelfIndexRelays: ['wss://relay.test'],
    });
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('keeps the workspace local and records failure when relay publish fails', async () => {
    publishWorkspaceSelfIndexMock.mockRejectedValue(new Error('relay rejected'));
    const store = await bindStore();

    const result = await store.publishPgWorkspaceSelfIndex(workspace);

    expect(result).toBeNull();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'failed',
      pgSelfIndexError: 'relay rejected',
      workspaceKey: workspace.workspaceKey,
    });
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('records pending state before publishing in the background', async () => {
    let finishPublish;
    publishWorkspaceSelfIndexMock.mockReturnValue(new Promise((resolve) => {
      finishPublish = resolve;
    }));
    const store = await bindStore();

    const pending = await store.markPgWorkspaceSelfIndexPending(workspace);
    const task = store.schedulePgWorkspaceSelfIndexPublish(pending);

    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'pending',
      pgSelfIndexError: null,
    });
    expect(task).toBe(store.pgWorkspaceSelfIndexPublishPromise);
    expect(publishWorkspaceSelfIndexMock).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(publishWorkspaceSelfIndexMock).toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'pending',
    });

    finishPublish({
      event: { id: 'event-queued' },
      acceptedRelays: ['wss://relay.test'],
      publishedAt: '2026-06-07T00:00:00.000Z',
    });
    await task;

    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'indexed',
      pgSelfIndexEventId: 'event-queued',
    });
  });

  it('backfills known PG workspaces that were connected before 33356 support existed', async () => {
    publishWorkspaceSelfIndexMock.mockResolvedValue({
      event: { id: 'event-backfill' },
      acceptedRelays: ['wss://relay.test'],
      publishedAt: '2026-06-07T00:00:00.000Z',
    });
    const store = await bindStore({
      knownWorkspaces: [
        { ...workspace, pgSelfIndexStatus: null },
        { ...workspace, workspaceKey: 'pg:indexed', workspaceId: 'workspace-indexed', workspaceServiceNpub: 'npub1indexed', pgSelfIndexStatus: 'indexed', pgSelfIndexLastBroadcastAt: new Date().toISOString() },
        { ...workspace, workspaceKey: 'pg:other-user', workspaceId: 'workspace-other', workspaceServiceNpub: 'npub1otherworkspace', pgSessionNpub: 'npub1other', pgSelfIndexStatus: null },
      ],
    });

    const summary = await store.ensureKnownPgWorkspacesSelfIndexed();

    expect(summary).toEqual({ queued: 1 });
    expect(store.knownWorkspaces.find((entry) => entry.workspaceKey === workspace.workspaceKey)).toMatchObject({
      pgSelfIndexStatus: 'pending',
      pgSelfIndexError: null,
    });
    await Promise.resolve();
    await store.pgWorkspaceSelfIndexPublishPromise;
    expect(publishWorkspaceSelfIndexMock).toHaveBeenCalledTimes(1);
    expect(store.knownWorkspaces.find((entry) => entry.workspaceKey === workspace.workspaceKey)).toMatchObject({
      pgSelfIndexStatus: 'indexed',
      pgSelfIndexEventId: 'event-backfill',
    });
  });

  it('rebroadcasts an indexed signed event after the freshness window', async () => {
    const signedEvent = { kind: 33356, id: 'event-existing', content: 'encrypted' };
    broadcastWorkspaceSelfIndexEventMock.mockResolvedValue({
      event: signedEvent,
      acceptedRelays: ['wss://relay.test'],
      publishedAt: '2026-06-09T00:00:00.000Z',
    });
    const store = await bindStore({
      knownWorkspaces: [{
        ...workspace,
        pgSelfIndexStatus: 'indexed',
        pgSelfIndexSignedEvent: signedEvent,
        pgSelfIndexLastBroadcastAt: '2026-06-01T00:00:00.000Z',
      }],
    });

    const summary = await store.ensureKnownPgWorkspacesSelfIndexed();

    expect(summary).toEqual({ queued: 1 });
    await Promise.resolve();
    await store.pgWorkspaceSelfIndexPublishPromise;
    expect(broadcastWorkspaceSelfIndexEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: signedEvent,
    }));
    expect(publishWorkspaceSelfIndexMock).not.toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexLastBroadcastAt: '2026-06-09T00:00:00.000Z',
      pgSelfIndexEventId: 'event-existing',
    });
  });

  it('marks a PG workspace deleted after publishing a tombstone self-index', async () => {
    publishWorkspaceSelfIndexTombstoneMock.mockResolvedValue({
      event: { id: 'event-tombstone' },
      acceptedRelays: ['wss://relay.test'],
      publishedAt: '2026-06-08T00:00:00.000Z',
    });
    const store = await bindStore();

    const result = await store.publishPgWorkspaceSelfIndexTombstone(workspace, {
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
      sourceEventId: 'event-33357',
    });

    expect(result.event.id).toBe('event-tombstone');
    expect(publishWorkspaceSelfIndexTombstoneMock).toHaveBeenCalledWith(expect.objectContaining({
      workspace,
      userNpub: 'npub1user',
      userPubkeyHex: 'a'.repeat(64),
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
      sourceEventId: 'event-33357',
    }));
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'deleted',
      pgSelfIndexEventId: 'event-tombstone',
      pgSelfIndexSignedEvent: { id: 'event-tombstone' },
      pgSelfIndexRelays: ['wss://relay.test'],
    });
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
  });

  it('verifies discovered locators through Tower and merges them into knownWorkspaces', async () => {
    const store = await bindStore({ knownWorkspaces: [] });
    const candidate = {
      event: { id: 'event-1' },
      locator: {
        ...descriptor,
        tower_base_url: 'https://tower.example',
      },
    };

    const summary = await store.discoverPgWorkspaceSelfIndex({ candidates: [candidate] });

    expect(store.verifyPgDescriptor).toHaveBeenCalledWith(candidate.locator, {
      baseUrl: 'https://tower.example',
    });
    expect(store.rememberVerifiedPgWorkspace).toHaveBeenCalledWith(descriptor, {
      actor: { npub: 'npub1user' },
      membership: { role: 'member' },
    }, {
      select: false,
      publishSelfIndex: false,
    });
    expect(summary.verified).toBe(1);
    expect(store.selectedWorkspaceKey).not.toBe(workspace.workspaceKey);
    expect(store.selectWorkspace).not.toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'verified',
      pgSelfIndexEventId: 'event-1',
    });
  });

  it('marks existing locators stale when Tower rejects current access', async () => {
    const store = await bindStore({
      verifyPgDescriptor: vi.fn().mockRejectedValue(new Error('Tower PG API 403')),
    });
    const candidate = {
      event: { id: 'event-2' },
      locator: {
        tower_base_url: 'https://tower.example',
        workspace_id: 'workspace-1',
        workspace_service_npub: 'npub1workspace',
      },
    };

    const summary = await store.discoverPgWorkspaceSelfIndex({ candidates: [candidate] });

    expect(summary.stale).toBe(1);
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    expect(store.knownWorkspaces[0]).toMatchObject({
      pgSelfIndexStatus: 'stale',
      pgSelfIndexError: 'Tower PG API 403',
    });
    expect(store.pgWorkspaceSelfIndexError).toContain('Tower PG API 403');
  });

  it('routes an exact descriptor 404 through stale-workspace pruning and tombstone dedupe', async () => {
    const missing = Object.assign(new Error('Tower PG API 404'), { status: 404 });
    const forgetMissingPgWorkspace = vi.fn().mockResolvedValue({ removed: true });
    const store = await bindStore({
      verifyPgDescriptor: vi.fn().mockRejectedValue(missing),
      forgetMissingPgWorkspace,
    });
    const candidate = {
      event: { id: 'event-missing' },
      locator: {
        tower_base_url: 'https://tower.example',
        workspace_id: 'workspace-1',
        workspace_service_npub: 'npub1workspace',
      },
    };

    await store.discoverPgWorkspaceSelfIndex({ candidates: [candidate] });

    expect(forgetMissingPgWorkspace).toHaveBeenCalledWith(workspace, {
      error: missing,
      towerResult: 'workspace_not_found',
      reason: 'descriptor_not_found',
      sourceEventId: 'event-missing',
      selectFallback: true,
    });
    expect(store.knownWorkspaces[0]).not.toHaveProperty('pgSelfIndexStatus', 'stale');
  });

  it('surfaces relay self-index events that were fetched but rejected before import', async () => {
    queryWorkspaceSelfIndexCandidatesMock.mockResolvedValue({
      events: [{ id: 'event-self-index' }],
      candidates: [],
      rejected: [{
        eventId: 'event-self-index',
        error: 'NIP-44 decrypt failed',
      }],
    });
    const store = await bindStore({ knownWorkspaces: [] });

    const summary = await store.discoverPgWorkspaceSelfIndex();

    expect(summary.eventsSeen).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(summary.rejected[0]).toMatchObject({
      eventId: 'event-self-index',
      error: 'NIP-44 decrypt failed',
    });
    expect(store.pgWorkspaceSelfIndexError).toContain('Found 1 workspace index event');
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
  });
  it('keeps foreign tombstones scoped to their originating app address', async () => {
    const forgotten = vi.fn();
    const store = await bindStore({ knownWorkspaces: [], rememberPgWorkspaceForgottenThisLoad: forgotten });
    const summary = await store.discoverPgWorkspaceSelfIndex({ candidates: [], tombstones: [{
      locator: descriptor, payload: { app: { app_pubkey: 'foreign-app' }, state: { deleted: true } }, event: { created_at: 2 },
    }] });
    expect(forgotten).not.toHaveBeenCalled();
    expect(summary.forgotten).toBe(0);
  });

});
