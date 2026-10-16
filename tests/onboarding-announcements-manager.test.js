import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  publishOnboardingAnnouncementMock,
  queryOnboardingAnnouncementCandidatesMock,
} = vi.hoisted(() => ({
  publishOnboardingAnnouncementMock: vi.fn(),
  queryOnboardingAnnouncementCandidatesMock: vi.fn(),
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => true),
}));

vi.mock('../src/nostr-onboarding-announcements.js', async () => {
  const actual = await vi.importActual('../src/nostr-onboarding-announcements.js');
  return {
    ...actual,
    flightDeckOnboardingAppPubkeyHex: vi.fn(() => 'b'.repeat(64)),
    onboardingAnnouncementRelayUrls: vi.fn((...lists) => lists.flat().filter(Boolean)),
    publishOnboardingAnnouncement: publishOnboardingAnnouncementMock,
    queryOnboardingAnnouncementCandidates: queryOnboardingAnnouncementCandidatesMock,
  };
});

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
  workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
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
    currentWorkspace: workspace,
    knownWorkspaces: [workspace],
    backendUrl: 'https://tower.example',
    superbasedTokenInput: 'connection-token',
    pgOnboardingAnnouncementStatuses: [],
    selectedWorkspaceKey: '',
    currentWorkspaceOwnerNpub: '',
    persistWorkspaceSettings: vi.fn().mockResolvedValue(undefined),
    stopBackgroundSync: vi.fn(),
    stopWorkspaceLiveQueries: vi.fn(),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    publishPgWorkspaceSelfIndexTombstone: vi.fn().mockResolvedValue({
      event: { id: 'event-33356-tombstone' },
      publishedAt: '2026-06-08T00:00:00.000Z',
    }),
    verifyPgDescriptor: vi.fn().mockResolvedValue({
      descriptor,
      me: { actor: { npub: 'npub1user' }, membership: { role: 'member' } },
    }),
    rememberVerifiedPgWorkspace: vi.fn(async () => workspace),
    ...overrides,
  };
}

describe('onboarding announcements manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function bindStore(overrides = {}) {
    const { onboardingAnnouncementsManagerMixin } = await import('../src/onboarding-announcements-manager.js');
    const store = createStore(overrides);
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(onboardingAnnouncementsManagerMixin));
    return store;
  }

  it('keeps a single pending publication and retries only the announcement after failure', async () => {
    let reject;
    publishOnboardingAnnouncementMock.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const store = await bindStore();
    const pending = store.publishPgOnboardingAnnouncementForGrant({ recipientNpub: 'npub1recipient', grantId: 'grant-1' });
    const entry = store.pgOnboardingAnnouncementStatuses[0];
    await store.retryPgOnboardingAnnouncement(entry.key);
    expect(publishOnboardingAnnouncementMock).toHaveBeenCalledTimes(1);
    reject(new Error('Onboarding encryption timed out'));
    await pending;
    expect(store.pgOnboardingAnnouncementStatuses[0].status).toBe('failed');
    publishOnboardingAnnouncementMock.mockResolvedValueOnce({ event: { id: 'retried' }, acceptedRelays: [] });
    await store.retryPgOnboardingAnnouncement(entry.key);
    expect(publishOnboardingAnnouncementMock).toHaveBeenCalledTimes(2);
    expect(store.pgOnboardingAnnouncementStatuses[0].status).toBe('published');
  });

  it('records published announcement status after a Tower grant', async () => {
    publishOnboardingAnnouncementMock.mockResolvedValue({
      event: { id: 'event-1' },
      acceptedRelays: ['wss://relay.test'],
    });
    const store = await bindStore();

    const status = await store.publishPgOnboardingAnnouncementForGrant({
      recipientNpub: 'npub1recipient',
      grantId: 'grant-1',
    });

    expect(publishOnboardingAnnouncementMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: 'npub1recipient',
      issuerNpub: 'npub1user',
      issuerPubkeyHex: 'a'.repeat(64),
      workspace,
      grantId: 'grant-1',
      reason: 'added_to_workspace_or_group',
    }));
    expect(status).toMatchObject({
      status: 'published',
      eventId: 'event-1',
      relays: ['wss://relay.test'],
    });
  });

  it('keeps the grant recoverable when relay publishing fails', async () => {
    publishOnboardingAnnouncementMock.mockRejectedValue(new Error('relay unavailable'));
    const store = await bindStore();

    const status = await store.publishPgOnboardingAnnouncementForGrant({
      recipientNpub: 'npub1recipient',
      grantId: 'grant-1',
    });

    expect(status).toMatchObject({
      status: 'failed',
      error: 'relay unavailable',
    });
    expect(store.pgOnboardingAnnouncementStatuses[0].retryInput).toMatchObject({
      recipientNpub: 'npub1recipient',
      grantId: 'grant-1',
    });

    publishOnboardingAnnouncementMock.mockResolvedValue({
      event: { id: 'event-retry' },
      acceptedRelays: ['wss://relay.test'],
    });
    const retry = await store.retryPgOnboardingAnnouncement(status.key);
    expect(retry).toMatchObject({
      status: 'published',
      eventId: 'event-retry',
    });
  });

  it('verifies discovered onboarding events through Tower before importing', async () => {
    const store = await bindStore({ knownWorkspaces: [] });
    const candidate = {
      event: { id: 'event-1' },
      locator: {
        ...descriptor,
        tower_base_url: 'https://tower.example',
      },
    };

    const summary = await store.discoverPgOnboardingAnnouncements({ candidates: [candidate] });

    expect(store.verifyPgDescriptor).toHaveBeenCalledWith(candidate.locator, {
      baseUrl: 'https://tower.example',
    });
    expect(store.rememberVerifiedPgWorkspace).toHaveBeenCalledWith(descriptor, {
      actor: { npub: 'npub1user' },
      membership: { role: 'member' },
    }, {
      select: true,
    });
    expect(summary.verified).toBe(1);
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(store.currentWorkspaceOwnerNpub).toBe(workspace.workspaceOwnerNpub);
    expect(store.selectWorkspace).toHaveBeenCalledWith(workspace.workspaceKey, {
      pgVerified: true,
      refresh: false,
    });
  });

  it('keeps stale onboarding events diagnostic-only when Tower rejects access', async () => {
    const store = await bindStore({
      knownWorkspaces: [],
      rememberVerifiedPgWorkspace: vi.fn(),
      verifyPgDescriptor: vi.fn().mockRejectedValue(new Error('Tower PG API 403')),
    });
    const summary = await store.discoverPgOnboardingAnnouncements({
      candidates: [{
        event: { id: 'event-stale' },
        locator: {
          ...descriptor,
          tower_base_url: 'https://tower.example',
        },
      }],
    });

    expect(summary.stale).toBe(1);
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
    expect(store.pgOnboardingAnnouncementSummary.rejected[0]).toMatchObject({
      eventId: 'event-stale',
      error: 'Tower PG API 403',
    });
    expect(store.pgOnboardingAnnouncementError).toContain('Tower PG API 403');
  });

  it('routes an exact descriptor 404 for a remembered onboarding workspace through pruning', async () => {
    const missing = Object.assign(new Error('Tower PG API 404'), { status: 404 });
    const forgetMissingPgWorkspace = vi.fn().mockResolvedValue({ removed: true });
    const store = await bindStore({
      verifyPgDescriptor: vi.fn().mockRejectedValue(missing),
      forgetMissingPgWorkspace,
    });
    const candidate = {
      event: { id: 'event-missing' },
      locator: { ...descriptor, tower_base_url: 'https://tower.example' },
    };

    await store.discoverPgOnboardingAnnouncements({ candidates: [candidate] });

    expect(forgetMissingPgWorkspace).toHaveBeenCalledWith(workspace, {
      error: missing,
      towerResult: 'workspace_not_found',
      reason: 'descriptor_not_found',
      sourceEventId: 'event-missing',
      selectFallback: true,
    });
  });

  it('confirms revoked onboarding through Tower before hiding a local workspace and publishing a tombstone', async () => {
    const store = await bindStore({
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
      verifyPgDescriptor: vi.fn().mockRejectedValue(new Error('Tower PG API 410 GET https://tower.example: {"code":"workspace_deleted"}')),
    });
    const candidate = {
      event: { id: 'event-revoked' },
      action: 'revoked',
      revoked: true,
      payload: {
        action: 'revoked',
        revocation: { reason: 'workspace_deleted' },
      },
      locator: {
        ...descriptor,
        tower_base_url: 'https://tower.example',
      },
    };

    const summary = await store.discoverPgOnboardingAnnouncements({ candidates: [candidate] });

    expect(store.verifyPgDescriptor).toHaveBeenCalledWith(candidate.locator, {
      baseUrl: 'https://tower.example',
    });
    expect(store.publishPgWorkspaceSelfIndexTombstone).toHaveBeenCalledWith(workspace, {
      towerResult: 'workspace_deleted',
      reason: 'workspace_deleted',
      sourceEventId: 'event-revoked',
    });
    expect(store.knownWorkspaces).toHaveLength(0);
    expect(store.selectedWorkspaceKey).toBe('');
    expect(store.currentWorkspaceOwnerNpub).toBe('');
    expect(store.stopBackgroundSync).toHaveBeenCalled();
    expect(store.stopWorkspaceLiveQueries).toHaveBeenCalled();
    expect(store.persistWorkspaceSettings).toHaveBeenCalled();
    expect(summary).toMatchObject({
      revokedConfirmed: 1,
      tombstonesPublished: 1,
    });
    expect(summary.rejected[0]).toMatchObject({
      eventId: 'event-revoked',
      status: 'revocation_confirmed',
      towerResult: 'workspace_deleted',
    });
  });

  it('keeps revoked onboarding diagnostic-only when Tower still confirms membership', async () => {
    const store = await bindStore({
      selectedWorkspaceKey: workspace.workspaceKey,
      currentWorkspaceOwnerNpub: workspace.workspaceOwnerNpub,
    });
    const candidate = {
      event: { id: 'event-unconfirmed' },
      action: 'deleted',
      revoked: true,
      payload: {
        action: 'deleted',
        revocation: { reason: 'workspace_deleted' },
      },
      locator: {
        ...descriptor,
        tower_base_url: 'https://tower.example',
      },
    };

    const summary = await store.discoverPgOnboardingAnnouncements({ candidates: [candidate] });

    expect(store.verifyPgDescriptor).toHaveBeenCalled();
    expect(store.publishPgWorkspaceSelfIndexTombstone).not.toHaveBeenCalled();
    expect(store.knownWorkspaces).toEqual([workspace]);
    expect(store.selectedWorkspaceKey).toBe(workspace.workspaceKey);
    expect(summary).toMatchObject({
      revokedUnconfirmed: 1,
      tombstonesPublished: 0,
    });
    expect(summary.rejected[0]).toMatchObject({
      eventId: 'event-unconfirmed',
      status: 'revocation_unconfirmed',
      towerResult: 'access_still_valid',
    });
  });

  it('continues to import active onboarding grants when action is missing', async () => {
    const store = await bindStore({ knownWorkspaces: [] });
    const candidate = {
      event: { id: 'event-active-legacy' },
      locator: {
        ...descriptor,
        tower_base_url: 'https://tower.example',
      },
    };

    const summary = await store.discoverPgOnboardingAnnouncements({ candidates: [candidate] });

    expect(store.verifyPgDescriptor).toHaveBeenCalledWith(candidate.locator, {
      baseUrl: 'https://tower.example',
    });
    expect(store.rememberVerifiedPgWorkspace).toHaveBeenCalled();
    expect(store.publishPgWorkspaceSelfIndexTombstone).not.toHaveBeenCalled();
    expect(summary.verified).toBe(1);
    expect(summary.revokedConfirmed).toBe(0);
  });

  it('surfaces relay events that were fetched but rejected before import', async () => {
    queryOnboardingAnnouncementCandidatesMock.mockResolvedValue({
      events: [{ id: 'event-encrypted' }],
      candidates: [],
      rejected: [{
        eventId: 'event-encrypted',
        error: 'NIP-44 decrypt failed',
      }],
    });
    const store = await bindStore({ knownWorkspaces: [] });

    const summary = await store.discoverPgOnboardingAnnouncements();

    expect(summary.eventsSeen).toBe(1);
    expect(summary.discovered).toBe(0);
    expect(summary.rejected[0]).toMatchObject({
      eventId: 'event-encrypted',
      error: 'NIP-44 decrypt failed',
    });
    expect(store.pgOnboardingAnnouncementError).toContain('Found 1 onboarding event');
    expect(store.rememberVerifiedPgWorkspace).not.toHaveBeenCalled();
  });
});
