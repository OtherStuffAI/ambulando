import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// Alpine's store reactivity; stored objects come back as proxies.
import { reactive } from '@vue/reactivity';

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => true),
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual('../src/api.js');
  return {
    ...actual,
    addTowerPgWorkspaceGroupMember: vi.fn(),
    createTowerPgChannelGrant: vi.fn(),
    createTowerPgScopeChannel: vi.fn(),
    createTowerPgWorkspaceGroup: vi.fn(),
    createTowerPgWorkspaceMember: vi.fn(),
    deleteTowerPgChannelGrant: vi.fn(),
    getTowerPgChannelGrants: vi.fn(),
    getTowerPgWorkspaceMembers: vi.fn(),
    reorderTowerPgChannel: vi.fn(),
    updateTowerPgChannel: vi.fn(),
    updateTowerPgChannelGrant: vi.fn(),
    updateTowerPgWorkspaceMemberProfile: vi.fn(),
  };
});

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual('../src/db.js');
  return { ...actual, upsertChannel: vi.fn(async () => true) };
});

vi.mock('../src/pg-read-hydrator.js', async () => {
  const actual = await vi.importActual('../src/pg-read-hydrator.js');
  return {
    ...actual,
    hydrateTowerPgAudioNotes: vi.fn(),
    hydrateTowerPgChannelMessages: vi.fn(),
    hydrateTowerPgChannels: vi.fn(),
    hydrateTowerPgDocumentsAndFiles: vi.fn(),
    hydrateTowerPgScopes: vi.fn(),
    hydrateTowerPgTasks: vi.fn(),
  };
});

import {
  addTowerPgWorkspaceGroupMember,
  createTowerPgChannelGrant,
  createTowerPgScopeChannel,
  createTowerPgWorkspaceGroup,
  createTowerPgWorkspaceMember,
  deleteTowerPgChannelGrant,
  getTowerPgChannelGrants,
  getTowerPgWorkspaceMembers,
  reorderTowerPgChannel,
  updateTowerPgChannel,
  updateTowerPgChannelGrant,
  updateTowerPgWorkspaceMemberProfile,
} from '../src/api.js';
import { upsertChannel } from '../src/db.js';
import { isTowerPgBackendMode } from '../src/backend-mode.js';
import {
  hydrateTowerPgAudioNotes,
  hydrateTowerPgChannelMessages,
  hydrateTowerPgChannels,
  hydrateTowerPgDocumentsAndFiles,
  hydrateTowerPgScopes,
  hydrateTowerPgTasks,
} from '../src/pg-read-hydrator.js';
import {
  mapGroupEntry,
  mapCreatedGroup,
  mapRotatedGroup,
  deduplicateMembers,
  computeGroupMemberDiff,
  parseGroupMemberQueryNpubs,
  filterChannelsForViewer,
  filterChannelsByScope,
  aggregatePgChannelGrants,
  buildChannelAccessGrantPayloads,
  canManagePgChannelGrantsFromRows,
  canManagePgChannelFromRows,
  channelsManagerMixin,
  capacityForPgChannelPermissions,
  describePgPermissionDenied,
  findExistingNamedChannel,
  permissionsForPgChannelCapacity,
  planPgChannelBulkGrantChange,
  scopeChannelAccessRows,
} from '../src/channels-manager.js';
import { DM_SCOPE_ID, buildDmChannelDescription } from '../src/dm-scope.js';
import { buildPgChannelTaskBoardId } from '../src/pg-record-context.js';

const channelsManagerSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'channels-manager.js'),
  'utf-8',
);

beforeEach(() => {
  vi.clearAllMocks();
  isTowerPgBackendMode.mockReturnValue(true);
  createTowerPgChannelGrant.mockResolvedValue({ grant: { id: 'created-grant' } });
  createTowerPgScopeChannel.mockResolvedValue({ channel: { id: 'channel-new', name: 'New', scope_id: 'scope-a', kind: 'channel' } });
  createTowerPgWorkspaceGroup.mockResolvedValue({ group: { id: 'group-new', group_id: 'group-new', name: 'New group' } });
  createTowerPgWorkspaceMember.mockResolvedValue({ actor: { actor_id: 'actor-new', npub: 'npub1recipient' } });
  deleteTowerPgChannelGrant.mockResolvedValue({ revoked: 5, grants: [] });
  addTowerPgWorkspaceGroupMember.mockResolvedValue({ membership: { id: 'membership-new' } });
  getTowerPgChannelGrants.mockResolvedValue({ grants: [] });
  getTowerPgWorkspaceMembers.mockResolvedValue({ members: [] });
  reorderTowerPgChannel.mockResolvedValue({
    channel: { id: 'channel-1', workspace_id: 'workspace-1', scope_id: 'scope-a', name: 'One', kind: 'channel', position: 2 },
    previous_position: 1,
    position: 2,
    changed: true,
  });
  updateTowerPgChannel.mockResolvedValue({
    channel: {
      id: 'channel-1',
      name: 'Ops',
      scope_id: 'scope-a',
      kind: 'channel',
      metadata: { basePrompt: 'Saved prompt' },
    },
  });
  updateTowerPgChannelGrant.mockResolvedValue({ grants: [] });
  updateTowerPgWorkspaceMemberProfile.mockResolvedValue({
    actor: { actor_id: 'actor-target', npub: 'npub1target', kind: 'human', display_name: 'Renamed User' },
    membership: { workspace_id: 'workspace-1', actor_id: 'actor-target', role: 'member', joined_at: null },
  });
  hydrateTowerPgAudioNotes.mockResolvedValue(undefined);
  hydrateTowerPgChannelMessages.mockResolvedValue(undefined);
  hydrateTowerPgChannels.mockResolvedValue(undefined);
  hydrateTowerPgDocumentsAndFiles.mockResolvedValue(undefined);
  hydrateTowerPgScopes.mockResolvedValue(undefined);
  hydrateTowerPgTasks.mockResolvedValue(undefined);
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function applyChannelMixin(store) {
  store.requestTowerSyncFamily ??= vi.fn((family, id = '') => {
    if (family === 'channel-messages') return hydrateTowerPgChannelMessages(store, id);
    if (family === 'scopes') return hydrateTowerPgScopes(store);
    if (family === 'channels') return hydrateTowerPgChannels(store);
    if (family === 'tasks') return hydrateTowerPgTasks(store);
    if (family === 'documents') return hydrateTowerPgDocumentsAndFiles(store);
    return Promise.resolve([]);
  });
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(channelsManagerMixin))) {
    if (Object.prototype.hasOwnProperty.call(store, key)) continue;
    Object.defineProperty(store, key, descriptor);
  }
  return store;
}

function createPgGrantStore(overrides = {}) {
  const currentWorkspace = overrides.currentWorkspace || {
    workspaceId: 'workspace-1',
    workspaceOwnerNpub: 'npub1workspace',
    directHttpsUrl: 'https://tower.example',
    appNpub: 'flightdeck-app',
    pgBackendMode: true,
    pgMe: {
      actor: { actor_id: 'actor-manager', npub: 'npub1manager' },
      permissions: ['workspace.read', 'channel.grants.read', 'channel.grants.manage'],
    },
  };
  return applyChannelMixin({
    currentWorkspace,
    workspaceOwnerNpub: currentWorkspace.workspaceOwnerNpub,
    backendUrl: currentWorkspace.directHttpsUrl,
    session: { npub: currentWorkspace.pgMe?.actor?.npub || 'npub1manager' },
    selectedChannelId: 'channel-1',
    channelGrants: [
      {
        principal_type: 'actor',
        principal_id: 'actor-manager',
        permissions: ['channel.read', 'channel.grants.read', 'channel.grants.manage'],
      },
    ],
    channelGrantsLoading: false,
    channelGrantsSaving: false,
    channelGrantsError: null,
    channelGrantsNotice: '',
    channelGrantPrincipalType: 'actor',
    channelGrantActorId: 'actor-target',
    channelGrantGroupId: '',
    channelGrantCapacity: 'viewer',
    groups: [],
    currentWorkspaceGroups: [],
    canAdminWorkspace: false,
    refreshGroups: vi.fn(),
    rememberPeople: vi.fn(),
    getSenderName: vi.fn(() => ''),
    pgWorkspaceMembers: [{ actor_id: 'actor-target', npub: 'npub1target' }],
    pgGroupMemberDrafts: {},
    publishPgOnboardingAnnouncementForGrant: vi.fn().mockResolvedValue({ status: 'published' }),
    ...overrides,
  });
}

describe('channels-manager pure utilities', () => {
  it('does not call retired trigger diagnostics during ordinary group refresh', () => {
    expect(channelsManagerSource).not.toContain('refreshAgentChat' + 'TriggerDiagnostics');
  });

  describe('filterChannelsByScope', () => {
    const scopesMap = new Map([
      ['scope-a', { record_id: 'scope-a', level: 'l1', title: 'Scope A' }],
      ['scope-a-child', { record_id: 'scope-a-child', level: 'l2', title: 'Child', l1_id: 'scope-a' }],
      ['scope-b', { record_id: 'scope-b', level: 'l1', title: 'Scope B' }],
    ]);
    const channels = [
      { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
      { record_id: 'ch-a-child', title: 'A Child', scope_id: 'scope-a-child', scope_l1_id: 'scope-a', scope_l2_id: 'scope-a-child' },
      { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      { record_id: 'ch-dm', title: 'DM: Alice', channel_type: 'dm', scope_id: DM_SCOPE_ID, scope_l1_id: DM_SCOPE_ID, participant_npubs: ['npub1me', 'npub1alice'] },
      { record_id: 'ch-unscoped', title: 'Unscoped' },
      { record_id: 'ch-deleted', title: 'Deleted', scope_id: 'scope-a', record_state: 'deleted' },
    ];

    it('returns live channels for all and recent boards', () => {
      expect(filterChannelsByScope(channels, '__all__', null, scopesMap).map((channel) => channel.record_id)).toEqual([
        'ch-a',
        'ch-a-child',
        'ch-b',
        'ch-dm',
        'ch-unscoped',
      ]);
      expect(filterChannelsByScope(channels, '__recent__', null, scopesMap).map((channel) => channel.record_id)).toEqual([
        'ch-a',
        'ch-a-child',
        'ch-b',
        'ch-dm',
        'ch-unscoped',
      ]);
    });

    it('includes descendant channels for the selected scope', () => {
      expect(filterChannelsByScope(channels, 'scope-a', scopesMap.get('scope-a'), scopesMap).map((channel) => channel.record_id)).toEqual([
        'ch-a',
        'ch-a-child',
      ]);
    });

    it('returns only unscoped channels for the unscoped board', () => {
      expect(filterChannelsByScope(channels, '__unscoped__', null, scopesMap).map((channel) => channel.record_id)).toEqual([
        'ch-unscoped',
      ]);
    });

    it('returns only DM channels for the DM scope', () => {
      expect(filterChannelsByScope(channels, DM_SCOPE_ID, null, scopesMap).map((channel) => channel.record_id)).toEqual([
        'ch-dm',
      ]);
    });
  });

  it('reconciles the selected chat channel to the filtered scope channel set', () => {
    const scopesMap = new Map([
      ['scope-a', { record_id: 'scope-a', level: 'l1', title: 'Scope A' }],
      ['scope-b', { record_id: 'scope-b', level: 'l1', title: 'Scope B' }],
    ]);
    const store = applyChannelMixin({
      channels: [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      ],
      selectedBoardId: 'scope-a',
      selectedBoardScope: scopesMap.get('scope-a'),
      scopesMap,
      selectedChannelId: 'ch-b',
      selectChannel: vi.fn(function selectChannel(recordId) {
        this.selectedChannelId = recordId;
      }),
      closeThread: vi.fn(),
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
      syncRoute: vi.fn(),
    });

    expect(store.scopeFilteredChannels.map((channel) => channel.record_id)).toEqual(['ch-a']);

    store.ensureSelectedChatChannelInScope({ syncRoute: false });

    expect(store.selectChannel).toHaveBeenCalledWith('ch-a', { syncRoute: false });
    expect(store.selectedChannelId).toBe('ch-a');
  });

  it('filters visible channels by PG context scope when the active task board is channel-backed', () => {
    const scopesMap = new Map([
      ['scope-a', { record_id: 'scope-a', level: 'l1', title: 'Scope A' }],
      ['scope-b', { record_id: 'scope-b', level: 'l1', title: 'Scope B' }],
    ]);
    const store = applyChannelMixin({
      channels: [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      ],
      selectedBoardId: buildPgChannelTaskBoardId('ch-a'),
      selectedBoardScope: null,
      pgContextScope: scopesMap.get('scope-a'),
      scopesMap,
    });

    expect(store.scopeFilteredChannels.map((channel) => channel.record_id)).toEqual(['ch-a']);
  });

  it('updates PG board context when selecting a chat channel in a PG workspace', async () => {
    const persistSelectedBoardId = vi.fn();
    const store = applyChannelMixin({
      currentWorkspace: { pgBackendMode: true },
      channels: [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      ],
      selectedBoardId: buildPgChannelTaskBoardId('ch-a'),
      selectedChannelId: 'ch-a',
      MAIN_FEED_PAGE_SIZE: 50,
      closeThread: vi.fn(),
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
      applyMessages: vi.fn(),
      startSelectedChannelLiveQuery: vi.fn(),
      refreshMessages: vi.fn(),
      refreshDailyNotes: vi.fn(),
      syncRoute: vi.fn(),
      ensureBackgroundSync: vi.fn(),
      captureSelectedChannelUnreadSnapshot: vi.fn(),
      markChannelRead: vi.fn(),
      persistSelectedBoardId,
      normalizeTaskFilterTags: vi.fn(),
    });

    await store.selectChannel('ch-b', { syncRoute: false });

    expect(store.selectedChannelId).toBe('ch-b');
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('ch-b'));
    expect(persistSelectedBoardId).toHaveBeenCalledWith(buildPgChannelTaskBoardId('ch-b'));
    expect(hydrateTowerPgChannelMessages).toHaveBeenCalledWith(store, 'ch-b');
    expect(store.loadChannelMessagesForSelection).toHaveBeenCalledWith('ch-b');
    expect(store.loadChannelMessagesForSelection.mock.invocationCallOrder[0])
      .toBeLessThan(hydrateTowerPgChannelMessages.mock.invocationCallOrder[0]);
  });

  it('returns after cached PG messages while a Deck-triggered remote refresh is still pending', async () => {
    let resolveRemoteHydration;
    hydrateTowerPgChannelMessages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRemoteHydration = resolve;
    }));
    const store = applyChannelMixin({
      currentWorkspace: { pgBackendMode: true },
      channels: [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      ],
      selectedBoardId: buildPgChannelTaskBoardId('ch-a'),
      selectedChannelId: 'ch-a',
      MAIN_FEED_PAGE_SIZE: 50,
      closeThread: vi.fn(),
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
      applyMessages: vi.fn(),
      startSelectedChannelLiveQuery: vi.fn(),
      refreshMessages: vi.fn(),
      refreshDailyNotes: vi.fn(),
      syncRoute: vi.fn(),
      ensureBackgroundSync: vi.fn(),
      persistSelectedBoardId: vi.fn(),
      normalizeTaskFilterTags: vi.fn(),
    });

    await store.selectChannel('ch-b', {
      syncRoute: false,
      scrollToLatest: false,
      backgroundRemoteRefresh: true,
    });

    expect(store.selectedChannelId).toBe('ch-b');
    expect(store.loadChannelMessagesForSelection).toHaveBeenCalledWith('ch-b');
    expect(hydrateTowerPgChannelMessages).toHaveBeenCalledWith(store, 'ch-b');
    expect(store.refreshDailyNotes).not.toHaveBeenCalled();

    resolveRemoteHydration();
    await vi.waitFor(() => expect(store.refreshDailyNotes).toHaveBeenCalledTimes(1));
  });

  it('saves and closes an open docs editor before selecting another docs channel', async () => {
    const openDoc = { record_id: 'doc-1', pg_channel_id: 'ch-a' };
    const resetOpenDocumentForContextChange = vi.fn(async function resetOpenDocumentForContextChange() {
      expect(this.selectedChannelId).toBe('ch-a');
    });
    const store = applyChannelMixin({
      currentWorkspace: { pgBackendMode: true },
      navSection: 'docs',
      docsEditorOpen: true,
      selectedDocument: openDoc,
      channels: [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
      ],
      selectedBoardId: buildPgChannelTaskBoardId('ch-a'),
      selectedChannelId: 'ch-a',
      MAIN_FEED_PAGE_SIZE: 50,
      closeThread: vi.fn(),
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
      applyMessages: vi.fn(),
      startSelectedChannelLiveQuery: vi.fn(),
      refreshMessages: vi.fn(),
      refreshDailyNotes: vi.fn(),
      syncRoute: vi.fn(),
      ensureBackgroundSync: vi.fn(),
      captureSelectedChannelUnreadSnapshot: vi.fn(),
      markChannelRead: vi.fn(),
      persistSelectedBoardId: vi.fn(),
      normalizeTaskFilterTags: vi.fn(),
      resetOpenDocumentForContextChange,
    });

    await store.selectChannel('ch-b', { syncRoute: false });

    expect(resetOpenDocumentForContextChange).toHaveBeenCalledWith(openDoc, { syncRoute: false });
    expect(store.selectedChannelId).toBe('ch-b');
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('ch-b'));
    expect(hydrateTowerPgChannelMessages).toHaveBeenCalledWith(store, 'ch-b');
  });

  it('reconciles the selected chat channel when channels hydrate for the active scope', async () => {
    const scopesMap = new Map([
      ['scope-a', { record_id: 'scope-a', level: 'l1', title: 'Scope A' }],
      ['scope-b', { record_id: 'scope-b', level: 'l1', title: 'Scope B' }],
    ]);
    const store = applyChannelMixin({
      channels: [],
      channelOrder: [],
      navSection: 'chat',
      selectedBoardId: 'scope-a',
      selectedBoardScope: scopesMap.get('scope-a'),
      scopesMap,
      selectedChannelId: 'ch-b',
      session: { npub: 'npub1owner' },
      workspaceOwnerNpub: 'npub1owner',
      groups: [],
      MAIN_FEED_PAGE_SIZE: 20,
      getChannelParticipants: () => [],
      rememberPeople: vi.fn(),
      closeThread: vi.fn(),
      startSelectedChannelLiveQuery: vi.fn(),
      syncRoute: vi.fn(),
      applyMessages: vi.fn(),
      updatePageTitle: vi.fn(),
      selectChannel: vi.fn(function selectChannel(recordId) {
        this.selectedChannelId = recordId;
      }),
    });

    await store.applyChannels([
      { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', scope_l1_id: 'scope-a' },
      { record_id: 'ch-b', title: 'B', scope_id: 'scope-b', scope_l1_id: 'scope-b' },
    ], { syncRoute: false });

    expect(store.selectChannel).toHaveBeenCalledWith('ch-a', { syncRoute: false });
    expect(store.selectedChannelId).toBe('ch-a');
  });

  it('finds an existing named channel by title and scope', () => {
    const channel = findExistingNamedChannel([
      { record_id: 'ch-1', title: 'Ops', scope_id: 'scope-a' },
      { record_id: 'ch-2', title: 'Ops', scope_id: 'scope-b' },
      { record_id: 'ch-3', title: 'Deleted', scope_id: 'scope-a', record_state: 'deleted' },
    ], ' ops ', 'scope-a');

    expect(channel?.record_id).toBe('ch-1');
  });

  it('selects an existing PG channel instead of creating a duplicate by name', async () => {
    const store = applyChannelMixin({
      channels: [{ record_id: 'ch-ops', title: 'Ops', scope_id: 'scope-a', record_state: 'active' }],
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', title: 'Scope A', level: 'l1' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Scope A', level: 'l1' }]]),
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      currentWorkspace: { workspaceId: 'workspace-1', appNpub: 'flightdeck-app' },
      backendUrl: 'https://tower.example',
      workspaceOwnerNpub: 'npub1workspace',
      newChannelName: 'Ops',
      newChannelGroupId: 'group-1',
      groups: [{ group_id: 'group-1', group_npub: 'group-1', name: 'Ops' }],
      resolveGroupId: (groupId) => groupId,
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
    });

    await store.createNamedChannel();

    expect(createTowerPgScopeChannel).not.toHaveBeenCalled();
    expect(store.selectChannel).toHaveBeenCalledWith('ch-ops', { syncRoute: false });
    expect(store.closeNewChannelModal).toHaveBeenCalled();
  });

  it('refreshes and selects an existing PG channel when Tower reports a duplicate', async () => {
    createTowerPgScopeChannel.mockRejectedValueOnce(new Error(
      'Tower PG API 409 POST https://tower.example/channels: {"error":"Channel name already exists in this scope","code":"duplicate_channel","status":409}',
    ));
    const store = applyChannelMixin({
      channels: [],
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', title: 'Scope A', level: 'l1' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Scope A', level: 'l1' }]]),
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      currentWorkspace: { workspaceId: 'workspace-1', appNpub: 'flightdeck-app' },
      backendUrl: 'https://tower.example',
      workspaceOwnerNpub: 'npub1workspace',
      newChannelName: 'Ops',
      newChannelGroupId: 'group-1',
      groups: [{ group_id: 'group-1', group_npub: 'group-1', name: 'Ops' }],
      resolveGroupId: (groupId) => groupId,
      error: null,
      refreshChannels: vi.fn(async function refreshChannels() {
        this.channels = [{ record_id: 'ch-ops', title: 'Ops', scope_id: 'scope-a', record_state: 'active' }];
        return this.channels;
      }),
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
    });

    await store.createNamedChannel();

    expect(hydrateTowerPgChannels).toHaveBeenCalledWith(store);
    expect(store.refreshChannels).toHaveBeenCalled();
    expect(store.selectChannel).toHaveBeenCalledWith('ch-ops', { syncRoute: false });
    expect(store.closeNewChannelModal).toHaveBeenCalled();
    expect(store.error).toBeNull();
  });

  it('builds initial channel grant payloads from access rows', () => {
    expect(buildChannelAccessGrantPayloads([
      { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
      { principal_type: 'actor', principal_id: 'actor-owner', capacity: 'manager' },
      { principal_type: 'actor', principal_id: 'actor-owner', capacity: 'contributor' },
      { principal_type: 'group', principal_id: 'group-agents', capacity: 'agent' },
      { principal_type: 'scope', principal_id: 'scope-1', capacity: 'manager' },
    ])).toEqual([
      {
        principal_type: 'group',
        principal_id: 'group-workspace',
        access_level: 'view',
      },
      {
        principal_type: 'actor',
        principal_id: 'actor-owner',
        access_level: 'contribute',
      },
      {
        principal_type: 'group',
        principal_id: 'group-agents',
        permissions: expect.arrayContaining(['channel.read', 'task.create', 'doc.write']),
      },
    ]);
  });

  it('describes PG channel permission presets for create-channel rows', () => {
    const store = applyChannelMixin({});

    expect(store.getPgChannelGrantCapacityDescription('viewer')).toBe('can view only');
    expect(store.getPgChannelGrantCapacityDescription('contributor')).toBe('can view and post');
    expect(store.getPgChannelGrantCapacityDescription('manager')).toBe('can view, post, and manage access');
    expect(store.getPgChannelGrantCapacityDescription('agent')).toBe('can view and create channel work as an agent');
  });

  it('blocks duplicate channel access grants in the settings form', async () => {
    const store = applyChannelMixin({
      selectedChannelId: 'channel-1',
      channelGrantPrincipalType: 'actor',
      channelGrantActorId: 'actor-owner',
      channelGrantCapacity: 'viewer',
      channelGrants: [{
        principal_type: 'actor',
        principal_id: 'actor-owner',
        permissions: ['channel.read', 'channel.write', 'channel.grants.manage'],
      }],
      currentWorkspace: { workspaceId: 'workspace-1', appNpub: 'flightdeck-app', pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } } },
      backendUrl: 'https://tower.example',
      canAdminWorkspace: true,
      channelGrantsError: null,
    });

    expect(store.selectedChannelGrantAlreadyExists).toBe(true);
    expect(store.canCreateSelectedChannelGrant).toBe(false);
    expect(store.selectedChannelGrantDraftMessage).toBe('This user or group already has access. Change the permission in the list below.');

    await store.createChannelGrant();

    expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
    expect(store.channelGrantsError).toBe('This user or group already has access. Change the permission in the list below.');
    expect(store.channelGrantsSaving).toBeFalsy();
  });

  it('sends explicit permissions when granting Agent access from channel settings', async () => {
    const store = createPgGrantStore({
      channelGrantPrincipalType: 'group',
      channelGrantGroupId: 'group-agents',
      channelGrantCapacity: 'agent',
      currentWorkspaceGroups: [{ group_id: 'group-agents', name: 'Agents' }],
    });

    await store.createChannelGrant();

    expect(createTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      principal_type: 'group',
      principal_id: 'group-agents',
      permissions: expect.arrayContaining(['channel.read', 'task.create', 'doc.write']),
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
  });

  it('starts bulk channel grants empty with nothing preselected', () => {
    const store = createPgGrantStore({
      selectedChannelId: 'channel-2',
      channels: [
        { record_id: 'channel-1', title: 'General', scope_id: 'scope-a', record_state: 'active' },
        { record_id: 'channel-2', title: 'Implementation', scope_id: 'scope-a', record_state: 'active' },
        { record_id: 'dm-1', title: 'DM', channel_type: 'dm', record_state: 'active' },
      ],
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Flight Deck' }]]),
      currentWorkspaceGroups: [
        { group_id: 'group-workspace', name: 'Workspace' },
        { group_id: 'group-agents', name: 'Agents' },
      ],
      getChannelLabel: (channel) => channel.title,
      channelBulkGrantSelectedChannelIds: ['channel-1'],
      channelBulkGrantPreview: { status: 'ready', rows: [] },
    });

    store.resetChannelBulkGrantDraft({ selectAll: true });

    expect(store.channelBulkGrantPrincipalType).toBe('group');
    expect(store.channelBulkGrantGroupId).toBe('');
    expect(store.channelBulkGrantActorId).toBe('');
    expect(store.channelBulkGrantCapacity).toBe('viewer');
    expect(store.channelBulkGrantSelectedChannelIds).toEqual([]);
    expect(store.channelBulkGrantPreview).toBeNull();
    expect(store.canPreviewChannelBulkGrant).toBe(false);
    expect(store.pgChannelBulkGrantChannelOptions.map((channel) => channel.id)).toEqual(['channel-1', 'channel-2']);
  });

  it('flags bulk updates that lower an existing standard permission', () => {
    const grant = (capacity) => [{ principal_type: 'group', principal_id: 'group-agents', permissions: permissionsForPgChannelCapacity(capacity) }];
    expect(planPgChannelBulkGrantChange(grant('contributor'), 'group:group-agents', 'viewer'))
      .toEqual({ action: 'update', currentCapacity: 'contributor', reduces: true });
    expect(planPgChannelBulkGrantChange(grant('viewer'), 'group:group-agents', 'contributor'))
      .toEqual({ action: 'update', currentCapacity: 'viewer', reduces: false });
    expect(planPgChannelBulkGrantChange(grant('contributor'), 'group:group-agents', 'agent'))
      .toEqual({ action: 'update', currentCapacity: 'contributor', reduces: true });
    expect(planPgChannelBulkGrantChange([], 'group:group-agents', 'viewer')).toEqual({ action: 'create', currentCapacity: '' });
  });

  describe('bulk channel grant preview', () => {
    function createBulkStore(overrides = {}) {
      return createPgGrantStore({
        channels: [
          { record_id: 'channel-a', title: 'A', scope_id: 'scope-a', record_state: 'active' },
          { record_id: 'channel-b', title: 'B', scope_id: 'scope-a', record_state: 'active' },
          { record_id: 'channel-c', title: 'C', scope_id: 'scope-a', record_state: 'active' },
        ],
        scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Flight Deck' }]]),
        currentWorkspaceGroups: [{ group_id: 'group-agents', name: 'Agents' }],
        getChannelLabel: (channel) => channel.title,
        channelBulkGrantPrincipalType: 'group',
        channelBulkGrantGroupId: 'group-agents',
        channelBulkGrantCapacity: 'viewer',
        channelBulkGrantSelectedChannelIds: ['channel-a', 'channel-b'],
        channelBulkGrantPreview: null,
        channelBulkGrantPreviewRequest: 0,
        channelBulkGrantResults: null,
        schedulePgChannelAccessMaterializationRefresh: vi.fn(),
        ...overrides,
      });
    }

    it('reaches ready on an Alpine reactive store and reports lowered access', async () => {
      const store = reactive(createBulkStore());
      getTowerPgChannelGrants
        .mockResolvedValueOnce({ grants: [] })
        .mockResolvedValueOnce({ grants: [{ principal_type: 'group', principal_id: 'group-agents', permissions: permissionsForPgChannelCapacity('contributor') }] });

      await store.previewChannelBulkGrant();

      expect(store.channelBulkGrantPreview.status).toBe('ready');
      expect(store.channelBulkGrantPreview.rows.map((row) => [row.id, row.action, row.reduces])).toEqual([
        ['channel-a', 'create', undefined],
        ['channel-b', 'update', true],
      ]);
      expect(store.channelBulkGrantPreviewCounts).toMatchObject({ create: 1, update: 1, reduces: 1, writes: 2 });
      expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
      expect(updateTowerPgChannelGrant).not.toHaveBeenCalled();
    });

    it('ignores a pending preview read after the dialog is closed and reopened', async () => {
      const store = reactive(createBulkStore({ channelBulkGrantSelectedChannelIds: ['channel-a'] }));
      let resolveFirst;
      getTowerPgChannelGrants
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce({ grants: [] });

      const first = store.previewChannelBulkGrant();
      expect(store.channelBulkGrantPreview.status).toBe('loading');
      store.closeChannelBulkGrantPreview();
      expect(store.channelBulkGrantPreview).toBeNull();
      store.channelBulkGrantCapacity = 'contributor';
      await store.previewChannelBulkGrant();
      expect(store.channelBulkGrantPreview).toMatchObject({ status: 'ready', capacity: 'contributor' });

      resolveFirst({ grants: [{ principal_type: 'group', principal_id: 'group-agents', permissions: permissionsForPgChannelCapacity('viewer') }] });
      await first;
      expect(store.channelBulkGrantPreview).toMatchObject({ status: 'ready', capacity: 'contributor' });
      expect(store.channelBulkGrantPreview.rows[0].action).toBe('create');

      store.closeChannelBulkGrantPreview();
      let resolveClosed;
      getTowerPgChannelGrants.mockImplementationOnce(() => new Promise((resolve) => { resolveClosed = resolve; }));
      const closed = store.previewChannelBulkGrant();
      store.closeChannelBulkGrantPreview();
      resolveClosed({ grants: [] });
      await closed;
      expect(store.channelBulkGrantPreview).toBeNull();
    });

    it('refuses to apply when the channel selection changed after the preview', async () => {
      const store = createBulkStore();
      getTowerPgChannelGrants.mockResolvedValue({ grants: [] });
      await store.previewChannelBulkGrant();
      expect(store.channelBulkGrantPreview.status).toBe('ready');
      getTowerPgChannelGrants.mockClear();

      store.channelBulkGrantSelectedChannelIds = ['channel-a', 'channel-b', 'channel-c'];
      await store.confirmChannelBulkGrant();

      expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
      expect(updateTowerPgChannelGrant).not.toHaveBeenCalled();
      expect(getTowerPgChannelGrants).not.toHaveBeenCalled();
      expect(store.channelBulkGrantPreview).toBeNull();
      expect(store.channelGrantsError).toMatch(/changed after the preview/);

      await store.previewChannelBulkGrant();
      store.channelBulkGrantSelectedChannelIds = ['channel-a', 'channel-c'];
      await store.confirmChannelBulkGrant();
      expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
    });

    it('refuses to apply when the principal or permission changed after the preview', async () => {
      const store = createBulkStore({ currentWorkspaceGroups: [{ group_id: 'group-agents', name: 'Agents' }, { group_id: 'group-team', name: 'Team' }] });
      getTowerPgChannelGrants.mockResolvedValue({ grants: [] });
      await store.previewChannelBulkGrant();
      store.channelBulkGrantGroupId = 'group-team';
      await store.confirmChannelBulkGrant();
      await store.previewChannelBulkGrant();
      store.channelBulkGrantCapacity = 'manager';
      await store.confirmChannelBulkGrant();
      expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
      expect(updateTowerPgChannelGrant).not.toHaveBeenCalled();
    });

    it('applies exactly the previewed channels with the previewed rule', async () => {
      const store = createBulkStore();
      getTowerPgChannelGrants.mockResolvedValue({ grants: [] });
      await store.previewChannelBulkGrant();
      await store.confirmChannelBulkGrant();
      expect(createTowerPgChannelGrant.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ['channel-a', { principal_type: 'group', principal_id: 'group-agents', access_level: 'view' }],
        ['channel-b', { principal_type: 'group', principal_id: 'group-agents', access_level: 'view' }],
      ]);
      expect(store.channelBulkGrantPreview).toBeNull();
      expect(store.channelBulkGrantResultCounts).toMatchObject({ created: 2, failed: 0 });
    });
  });

  it('applies a bulk grant across selected channels without rewriting custom grants', async () => {
    getTowerPgChannelGrants
      .mockResolvedValueOnce({ grants: [] })
      .mockResolvedValueOnce({
        grants: [{
          principal_type: 'group',
          principal_id: 'group-agents',
          permissions: permissionsForPgChannelCapacity('viewer'),
        }],
      })
      .mockResolvedValueOnce({
        grants: [{
          principal_type: 'group',
          principal_id: 'group-agents',
          permissions: ['channel.read', 'bespoke.permission'],
        }],
      })
      .mockResolvedValueOnce({
        grants: [{
          principal_type: 'actor',
          principal_id: 'actor-manager',
          permissions: ['channel.read', 'channel.grants.read', 'channel.grants.manage'],
        }],
      });
    const store = createPgGrantStore({
      channels: [
        { record_id: 'channel-a', title: 'A', scope_id: 'scope-a', record_state: 'active' },
        { record_id: 'channel-b', title: 'B', scope_id: 'scope-a', record_state: 'active' },
        { record_id: 'channel-c', title: 'C', scope_id: 'scope-a', record_state: 'active' },
      ],
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Flight Deck' }]]),
      currentWorkspaceGroups: [{ group_id: 'group-agents', name: 'Agents' }],
      getChannelLabel: (channel) => channel.title,
      channelBulkGrantPrincipalType: 'group',
      channelBulkGrantGroupId: 'group-agents',
      channelBulkGrantCapacity: 'contributor',
      channelBulkGrantSelectedChannelIds: ['channel-a', 'channel-b', 'channel-c'],
      schedulePgChannelAccessMaterializationRefresh: vi.fn(),
    });

    await store.applyChannelBulkGrant();

    expect(createTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-a', {
      principal_type: 'group',
      principal_id: 'group-agents',
      access_level: 'contribute',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
    expect(updateTowerPgChannelGrant).toHaveBeenCalledWith(
      'workspace-1',
      'channel-b',
      'group',
      'group-agents',
      { access_level: 'contribute' },
      { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' },
    );
    expect(updateTowerPgChannelGrant).not.toHaveBeenCalledWith(
      'workspace-1',
      'channel-c',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(store.channelGrantsNotice).toBe('Bulk access complete: 1 added, 1 updated, 1 custom skipped.');
    expect(store.channelGrantsError).toBeNull();
  });

  it('creates PG channels with group/person access rows', async () => {
    const store = applyChannelMixin({
      channels: [],
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', title: 'Scope A', level: 'l1' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Scope A', level: 'l1' }]]),
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      currentWorkspace: { workspaceId: 'workspace-1', appNpub: 'flightdeck-app', pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } } },
      backendUrl: 'https://tower.example',
      workspaceOwnerNpub: 'npub1workspace',
      newChannelName: 'Ops',
      newChannelDescription: 'Operations work',
      newChannelBasePrompt: 'Use this for operations context.',
      newChannelAccessRows: [
        { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
        { principal_type: 'actor', principal_id: 'actor-owner', capacity: 'manager' },
      ],
      groups: [{ group_id: 'group-workspace', group_npub: 'group-workspace', name: 'Workspace' }],
      resolveGroupId: (groupId) => groupId,
      refreshChannels: vi.fn(async function refreshChannels() {
        return this.channels;
      }),
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
    });

    await store.createNamedChannel();

    expect(createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-a', expect.objectContaining({
      name: 'Ops',
      description: 'Operations work',
      metadata: {
        agent_chat: {
          enabled: true,
          context_prompt: 'Use this for operations context.',
          activation: 'mention_then_continue',
        },
      },
      kind: 'channel',
      grants: [
        {
          principal_type: 'group',
          principal_id: 'group-workspace',
          access_level: 'view',
        },
        {
          principal_type: 'actor',
          principal_id: 'actor-owner',
          access_level: 'manage',
        },
      ],
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
    expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
    expect(store.selectChannel).toHaveBeenCalledWith('channel-new', { syncRoute: false });
  });

  it('initializes PG channel access defaults after refreshing groups', async () => {
    const store = applyChannelMixin({
      channels: [],
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', title: 'Scope A', level: 'l1' },
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      currentWorkspace: {
        workspaceId: 'workspace-1',
        appNpub: 'flightdeck-app',
        pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } },
      },
      workspaceOwnerNpub: 'npub1workspace',
      groups: [],
      currentWorkspaceGroups: [],
      pgWorkspaceMembers: [],
      newChannelAccessRows: [],
      getSenderName: vi.fn((npub) => npub === 'npub1owner' ? 'Owner' : npub),
      refreshGroups: vi.fn(async function refreshGroups() {
        this.currentWorkspaceGroups = [{
          group_id: 'group-workspace',
          group_npub: 'group-workspace',
          name: 'Workspace',
          member_npubs: [],
          effective_member_npubs: [],
        }];
        return this.currentWorkspaceGroups;
      }),
    });

    await store.openNewChannelModal();

    expect(store.refreshGroups).toHaveBeenCalledWith({ force: true, minIntervalMs: 0 });
    expect(store.newChannelMode).toBe('channel');
    expect(store.showNewChannelModal).toBe(true);
    expect(store.newChannelAccessRows).toEqual([
      expect.objectContaining({
        principal_type: 'group',
        principal_id: 'group-workspace',
        capacity: 'viewer',
      }),
      expect.objectContaining({
        principal_type: 'actor',
        principal_id: 'actor-owner',
        capacity: 'manager',
      }),
    ]);
    expect(store.newChannelAccessPrincipalOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: 'actor:actor-owner',
        label: 'Owner',
      }),
    ]));
  });

  it('defaults a new channel from the selected scope channel access rows', async () => {
    const scope = {
      record_id: 'scope-a',
      title: 'Scope A',
      level: 'l1',
      record_state: 'active',
      default_channel_access_rows: [
        { principal_type: 'actor', principal_id: 'actor-person-manager', capacity: 'manager' },
        { principal_type: 'group', principal_id: 'group-contributors', capacity: 'contributor' },
      ],
    };
    const store = applyChannelMixin({
      channels: [],
      selectedBoardId: 'scope-a',
      selectedBoardScope: scope,
      scopes: [scope],
      scopesMap: new Map([['scope-a', scope]]),
      currentWorkspace: {
        workspaceId: 'workspace-1',
        appNpub: 'flightdeck-app',
        pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } },
      },
      workspaceOwnerNpub: 'npub1workspace',
      currentWorkspaceGroups: [
        { group_id: 'group-contributors', group_npub: 'group-contributors', name: 'Contributors' },
        { group_id: 'group-workspace', group_npub: 'group-workspace', name: 'Workspace' },
      ],
      pgWorkspaceMembers: [
        { actor_id: 'actor-person-manager', npub: 'npub1personmanager', display_name: 'Person Manager' },
        { actor_id: 'actor-owner', npub: 'npub1owner', display_name: 'Owner' },
      ],
      refreshGroups: vi.fn(async function refreshGroups() {
        return this.currentWorkspaceGroups;
      }),
      refreshTowerPgWorkspaceMembers: vi.fn(async function refreshTowerPgWorkspaceMembers() {
        return this.pgWorkspaceMembers;
      }),
    });

    await store.openNewChannelModal({ scopeId: 'scope-a' });

    expect(store.newChannelAccessRows).toEqual([
      expect.objectContaining({ principal_type: 'actor', principal_id: 'actor-person-manager', capacity: 'manager' }),
      expect.objectContaining({ principal_type: 'group', principal_id: 'group-contributors', capacity: 'contributor' }),
    ]);
    expect(buildChannelAccessGrantPayloads(store.newChannelAccessRows)).toEqual([
      { principal_type: 'actor', principal_id: 'actor-person-manager', access_level: 'manage' },
      { principal_type: 'group', principal_id: 'group-contributors', access_level: 'contribute' },
    ]);
  });

  it('renders inherited scope access with direct channel grants overriding duplicates', () => {
    const scope = {
      record_id: 'scope-a',
      default_channel_access_rows: [
        { principal_type: 'actor', principal_id: 'actor-person-manager', capacity: 'manager' },
        { principal_type: 'group', principal_id: 'group-contributors', capacity: 'contributor' },
      ],
    };
    const store = createPgGrantStore({
      selectedChannelId: 'channel-1',
      channelGrantsChannelId: 'channel-1',
      channelGrants: [
        { principal_type: 'group', principal_id: 'group-contributors', access_level: 'view' },
      ],
      channels: [{ record_id: 'channel-1', scope_id: 'scope-a', channel_grants: [] }],
      scopes: [scope],
      scopesMap: new Map([['scope-a', scope]]),
    });

    expect(scopeChannelAccessRows(scope)).toEqual([
      expect.objectContaining({
        principal_type: 'actor',
        principal_id: 'actor-person-manager',
        permissions: expect.arrayContaining(['channel.manage', 'channel.grants.manage']),
      }),
      expect.objectContaining({
        principal_type: 'group',
        principal_id: 'group-contributors',
        permissions: expect.arrayContaining(['channel.write', 'task.create']),
      }),
    ]);
    expect(store.channelGrantRows).toEqual([
      expect.objectContaining({
        key: 'group:group-contributors',
        principal_type: 'group',
        principal_id: 'group-contributors',
        capacity: 'viewer',
        inherited: false,
      }),
      expect.objectContaining({
        key: 'scope:scope-a:actor:actor-person-manager',
        principal_type: 'actor',
        principal_id: 'actor-person-manager',
        capacity: 'manager',
        inherited: true,
      }),
    ]);
    expect(store.channelGrantRows.filter((grant) => grant.principal_id === 'group-contributors')).toHaveLength(1);
  });

  it('preserves concrete scope channel permission rows when deriving inherited access', () => {
    const rows = scopeChannelAccessRows({
      record_id: 'scope-a',
      scope_channel_grants: [{
        principal_type: 'actor',
        principal_id: 'actor-person-manager',
        permissions: permissionsForPgChannelCapacity('manager'),
      }],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        principal_type: 'actor',
        principal_id: 'actor-person-manager',
        permissions: expect.arrayContaining(['channel.manage', 'channel.grants.manage']),
      }),
    ]);
    expect(capacityForPgChannelPermissions(rows[0].permissions)).toBe('manager');
  });

  it('adds a selected PG user as a setup permission row and persists it on channel create', async () => {
    const store = applyChannelMixin({
      channels: [],
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', title: 'Scope A', level: 'l1' },
      scopesMap: new Map([['scope-a', { record_id: 'scope-a', title: 'Scope A', level: 'l1' }]]),
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      currentWorkspace: {
        workspaceId: 'workspace-1',
        appNpub: 'flightdeck-app',
        pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } },
      },
      backendUrl: 'https://tower.example',
      workspaceOwnerNpub: 'npub1workspace',
      newChannelName: 'Ops',
      newChannelDescription: '',
      newChannelAccessPrincipalDraft: '',
      newChannelAccessLoading: false,
      newChannelAccessError: '',
      newChannelAccessRows: [
        { principal_type: 'group', principal_id: 'group-workspace', capacity: 'viewer' },
        { principal_type: 'actor', principal_id: 'actor-owner', capacity: 'manager' },
      ],
      groups: [{ group_id: 'group-workspace', group_npub: 'group-workspace', name: 'Workspace' }],
      currentWorkspaceGroups: [{ group_id: 'group-workspace', group_npub: 'group-workspace', name: 'Workspace' }],
      pgWorkspaceMembers: [
        { actor_id: 'actor-owner', npub: 'npub1owner', display_name: 'Owner' },
        { actor_id: 'actor-agent-b', npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266', display_name: 'Agent B' },
      ],
      getSenderName: vi.fn((npub) => ({
        npub1owner: 'Owner',
        npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266: 'Agent B',
      }[npub] || npub)),
      resolveGroupId: (groupId) => groupId,
      refreshChannels: vi.fn(async function refreshChannels() {
        return this.channels;
      }),
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
    });

    expect(store.newChannelAccessAddOptions).toEqual([
      expect.objectContaining({
        value: 'actor:actor-agent-b',
        label: 'Agent B',
      }),
    ]);
    expect(store.newChannelCanAddAccessRow).toBe(true);
    expect(store.newChannelAccessDisabledReason).toBe('');

    store.addNewChannelAccessRow('actor:actor-agent-b');

    expect(store.newChannelAccessPrincipalDraft).toBe('');
    expect(store.newChannelAccessRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        principal_type: 'actor',
        principal_id: 'actor-agent-b',
        capacity: 'viewer',
      }),
    ]));
    expect(store.newChannelAccessAddOptions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'actor:actor-agent-b' }),
    ]));

    await store.createNamedChannel();

    expect(createTowerPgScopeChannel).toHaveBeenCalledWith('workspace-1', 'scope-a', expect.objectContaining({
      name: 'Ops',
      description: undefined,
      metadata: {
        agent_chat: { enabled: true, context_prompt: '', activation: 'mention_then_continue' },
      },
      kind: 'channel',
      grants: [
        {
          principal_type: 'group',
          principal_id: 'group-workspace',
          access_level: 'view',
        },
        {
          principal_type: 'actor',
          principal_id: 'actor-owner',
          access_level: 'manage',
        },
        {
          principal_type: 'actor',
          principal_id: 'actor-agent-b',
          access_level: 'view',
        },
      ],
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
  });

  it('keeps the new channel permission picker disabled only with a visible reason', () => {
    const store = applyChannelMixin({
      newChannelAccessRows: [],
      currentWorkspaceGroups: [],
      groups: [],
      pgWorkspaceMembers: [],
      currentWorkspace: {
        workspaceId: 'workspace-1',
        pgMe: {},
      },
      session: {},
      newChannelAccessLoading: true,
      newChannelAccessError: '',
      getSenderName: vi.fn((npub) => npub),
    });

    expect(store.newChannelCanAddAccessRow).toBe(false);
    expect(store.newChannelAccessDisabledReason).toBe('Loading users and groups...');

    store.newChannelAccessLoading = false;
    store.newChannelAccessError = 'Failed to load workspace members.';
    expect(store.newChannelAccessDisabledReason).toBe('Failed to load workspace members.');

    store.newChannelAccessError = '';
    expect(store.newChannelAccessDisabledReason).toBe('All available users and groups already have a permission row.');

    store.pgWorkspaceMembers = [
      { actor_id: 'actor-target', npub: 'npub1target', display_name: 'Target' },
    ];
    expect(store.newChannelCanAddAccessRow).toBe(true);
    expect(store.newChannelAccessDisabledReason).toBe('');
  });

  it('opens DM creation from the DM-area New control on Home', async () => {
    const store = applyChannelMixin({
      selectedBoardId: DM_SCOPE_ID,
      selectedBoardScope: null,
      selectedChannelId: null,
      selectedChannel: null,
      scopes: [],
      workspaceOwnerNpub: 'npub1owner',
    });

    await store.openNewChannelModal();

    expect(store.newChannelMode).toBe('dm');
    expect(store.showNewChannelScopePicker).toBe(false);
    expect(store.showNewChannelModal).toBe(true);
  });

  it('opens DM creation from the DM-area New control while an existing DM is selected', async () => {
    const dmScope = { record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm', record_state: 'active' };
    const selectedDm = { record_id: 'dm-testagent', title: 'DM: Test Agent', scope_id: 'scope-dms', channel_type: 'dm' };
    const store = applyChannelMixin({
      selectedBoardId: buildPgChannelTaskBoardId(selectedDm.record_id),
      selectedBoardScope: null,
      pgContextScope: dmScope,
      selectedChannelId: selectedDm.record_id,
      selectedChannel: selectedDm,
      scopes: [dmScope],
      workspaceOwnerNpub: 'npub1owner',
    });

    await store.openNewChannelModal();

    expect(store.newChannelMode).toBe('dm');
    expect(store.showNewChannelScopePicker).toBe(false);
    expect(store.showNewChannelModal).toBe(true);
  });

  it('opens normal channel creation outside the DM area', async () => {
    const channelStore = applyChannelMixin({
      selectedBoardId: 'scope-a',
      selectedBoardScope: { record_id: 'scope-a', level: 'l1' },
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      workspaceOwnerNpub: 'npub1owner',
    });

    await channelStore.openNewChannelModal();

    expect(channelStore.newChannelMode).toBe('channel');
  });

  it('only exposes scoped channel creation when the actor can create there', () => {
    const managedScope = { record_id: 'scope-managed', pg_can_manage: true, record_state: 'active' };
    const readOnlyScope = { record_id: 'scope-read-only', pg_can_manage: false, record_state: 'active' };
    const store = applyChannelMixin({
      scopes: [managedScope, readOnlyScope],
      scopesMap: new Map([
        [managedScope.record_id, managedScope],
        [readOnlyScope.record_id, readOnlyScope],
      ]),
      currentWorkspace: { pgMe: { permissions: ['workspace.read'] } },
      canAdminWorkspace: false,
    });

    expect(store.canCreateChannelInScope(managedScope)).toBe(true);
    expect(store.canCreateChannelInScope(readOnlyScope)).toBe(false);

    store.currentWorkspace.pgMe.permissions.push('channel.create');
    expect(store.canCreateChannelInScope(readOnlyScope)).toBe(false);
    expect(store.canCreateChannelInScope({ record_id: 'scope-legacy', record_state: 'active' })).toBe(true);
  });

  it('opens DM creation when a DM scope is explicitly supplied', async () => {
    const dmScope = { record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm', record_state: 'active' };
    const store = applyChannelMixin({
      selectedBoardId: '__all__',
      selectedBoardScope: null,
      scopes: [dmScope],
      scopesMap: new Map([[dmScope.record_id, dmScope]]),
      workspaceOwnerNpub: 'npub1owner',
    });

    await store.openNewChannelModal({ scopeId: dmScope.record_id });

    expect(store.newChannelMode).toBe('dm');
    expect(store.newChannelScopeId).toBe(dmScope.record_id);
    expect(store.showNewChannelModal).toBe(true);
  });

  it('asks for a scope before creating a channel from All/Home', async () => {
    const store = applyChannelMixin({
      selectedBoardId: '__all__',
      selectedBoardScope: null,
      selectedChannelId: 'stale-channel',
      selectedChannel: { record_id: 'stale-channel', scope_id: 'scope-a' },
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      workspaceOwnerNpub: 'npub1owner',
      showNewChannelModal: false,
      showNewChannelScopePicker: false,
      newChannelScopeId: '',
    });

    await store.openNewChannelModal();

    expect(store.showNewChannelScopePicker).toBe(true);
    expect(store.showNewChannelModal).toBe(false);
    expect(store.newChannelScopeOptions).toEqual([
      expect.objectContaining({ id: 'scope-a', label: 'Scope A' }),
    ]);
  });

  it('opens the channel form after choosing a scope from the All/Home picker', async () => {
    const store = applyChannelMixin({
      selectedBoardId: '__all__',
      selectedBoardScope: null,
      selectedChannelId: null,
      selectedChannel: null,
      scopes: [{ record_id: 'scope-a', title: 'Scope A', level: 'l1', record_state: 'active' }],
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        appNpub: 'flightdeck-app',
        pgMe: { actor: { actor_id: 'actor-owner', npub: 'npub1owner' } },
      },
      pgWorkspaceMembers: [],
      currentWorkspaceGroups: [],
      groups: [],
      refreshTowerPgWorkspaceMembers: vi.fn(async () => []),
      refreshGroups: vi.fn(async () => []),
      getSenderName: vi.fn((npub) => npub),
      showNewChannelScopePicker: true,
      showNewChannelModal: false,
      newChannelScopeId: 'scope-a',
    });

    await store.continueNewChannelWithScope();

    expect(store.showNewChannelScopePicker).toBe(false);
    expect(store.showNewChannelModal).toBe(true);
    expect(store.newChannelMode).toBe('channel');
    expect(store.newChannelScopeId).toBe('scope-a');
  });

  it('selects an existing direct message for the same participant pair instead of creating a duplicate', async () => {
    isTowerPgBackendMode.mockReturnValue(false);
    const store = applyChannelMixin({
      channels: [{
        record_id: 'dm-existing',
        title: 'DM: Alice',
        channel_type: 'dm',
        participant_npubs: [],
        description: buildDmChannelDescription(['npub1bob', 'npub1alice']),
        scope_id: DM_SCOPE_ID,
      }],
      selectedBoardId: DM_SCOPE_ID,
      selectedBoardScope: null,
      scopes: [],
      workspaceOwnerNpub: 'npub1workspace',
      session: { npub: 'npub1alice' },
      newChannelDmNpub: 'npub1bob',
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
      createEncryptedGroup: vi.fn(),
    });

    await store.createDmChannel();

    expect(store.selectChannel).toHaveBeenCalledWith('dm-existing', { syncRoute: false });
    expect(store.closeNewChannelModal).toHaveBeenCalled();
    expect(store.createEncryptedGroup).not.toHaveBeenCalled();
  });

  it('repairs a Tower PG direct message grant before opening an existing DM', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createPgGrantStore({
      channels: [{
        record_id: 'dm-existing',
        title: 'DM: Bot',
        channel_type: 'dm',
        participant_npubs: ['npub1manager', 'npub1bot'],
        description: buildDmChannelDescription(['npub1manager', 'npub1bot']),
        scope_id: 'scope-dms',
      }],
      scopes: [{ record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm', record_state: 'active' }],
      selectedBoardId: 'scope-dms',
      selectedBoardScope: { record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm' },
      newChannelDmNpub: 'npub1bot',
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
      refreshTowerPgWorkspaceMembers: vi.fn().mockResolvedValue([]),
      getPgWorkspaceMemberActorId: vi.fn(() => 'actor-bot'),
    });

    await store.createDmChannel();

    expect(createTowerPgWorkspaceMember).not.toHaveBeenCalled();
    expect(createTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'dm-existing', {
      principal_type: 'actor',
      principal_id: 'actor-bot',
      access_level: 'manage',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
    expect(store.selectChannel).toHaveBeenCalledWith('dm-existing', { syncRoute: false });
  });

  it('describes Tower PG permission denials in access-level language', () => {
    expect(describePgPermissionDenied({ requiredPermission: 'channel.grants.manage' }))
      .toBe('You need Manage access on this channel to do that.');
    expect(describePgPermissionDenied({ requiredPermission: 'channel.write' }))
      .toBe('You need Contribute access on this channel to do that.');
    expect(describePgPermissionDenied({ requiredPermission: 'task.create' }))
      .toBe('You need Contribute access on this channel to do that.');
    expect(describePgPermissionDenied({ requiredPermission: 'channel.read' }))
      .toBe('You need View access on this channel to do that.');
    expect(describePgPermissionDenied({ requiredPermission: 'workspace.manage' }))
      .toBe('Only workspace admins can do that.');
    expect(describePgPermissionDenied({}, 'remove channel access'))
      .toBe('You do not have permission to remove channel access.');
  });

  it('surfaces dm_participant_not_member as a friendly DM error', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const notMemberError = new Error('API 403: dm_participant_not_member');
    notMemberError.code = 'dm_participant_not_member';
    createTowerPgScopeChannel.mockRejectedValueOnce(notMemberError);
    const store = createPgGrantStore({
      channels: [],
      scopes: [{ record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm', record_state: 'active' }],
      selectedBoardId: 'scope-dms',
      selectedBoardScope: { record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm' },
      newChannelDmNpub: 'npub1stranger',
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
    });

    await store.createDmChannel();

    expect(store.error).toBe('They are not in this workspace yet — ask an admin to add them before starting a DM.');
  });

  it('does not attempt PG grant maintenance when actor cannot manage channel grants', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const store = createPgGrantStore({
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1workspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
        pgBackendMode: true,
        pgMe: {
          actor: { actor_id: 'actor-member', npub: 'npub1member' },
          permissions: ['workspace.read', 'channel.write', 'channel.read'],
        },
      },
      channels: [{
        record_id: 'dm-existing',
        title: 'DM: Bot',
        channel_type: 'dm',
        participant_npubs: ['npub1member', 'npub1bot'],
        description: buildDmChannelDescription(['npub1member', 'npub1bot']),
        scope_id: 'scope-dms',
      }],
      scopes: [{ record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm', record_state: 'active' }],
      selectedBoardId: 'scope-dms',
      selectedBoardScope: { record_id: 'scope-dms', title: 'DMs', pg_kind: 'dm' },
      newChannelDmNpub: 'npub1bot',
      selectChannel: vi.fn(),
      closeNewChannelModal: vi.fn(),
      refreshTowerPgWorkspaceMembers: vi.fn().mockResolvedValue([]),
      getPgWorkspaceMemberActorId: vi.fn(() => 'actor-bot'),
      canAdminWorkspace: false,
      session: { npub: 'npub1member' },
      workspaceOwnerNpub: 'npub1workspace',
      backendUrl: 'https://tower.example',
    });

    await store.createDmChannel();

    expect(createTowerPgWorkspaceMember).not.toHaveBeenCalled();
    expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
    expect(store.selectChannel).toHaveBeenCalledWith('dm-existing', { syncRoute: false });
  });

  it('opens channel settings for an explicit PG context channel id', () => {
    const store = createPgGrantStore({
      channels: [
        { record_id: 'channel-1', title: 'Old channel' },
        { record_id: 'channel-2', title: 'Target channel', metadata: { basePrompt: 'Existing prompt', agent_chat: { enabled: false } } },
      ],
      selectedChannelId: 'channel-1',
      closeScopePicker: vi.fn(),
      closeChannelScopePicker: vi.fn(),
      preparePgChannelAccessPanel: vi.fn(),
    });

    channelsManagerMixin.openChannelSettings.call(store, 'channel-2');

    expect(store.selectedChannelId).toBe('channel-2');
    expect(store.channelSettingsBasePrompt).toBe('Existing prompt');
    expect(store.channelSettingsAgentChatEnabled).toBe(true);
    expect(store.showChannelSettingsModal).toBe(true);
    expect(store.preparePgChannelAccessPanel).toHaveBeenCalledOnce();
  });

  it('migrates and saves canonical PG Agent Direct Chat metadata', async () => {
    updateTowerPgChannel.mockResolvedValueOnce({
      channel: {
        id: 'channel-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-a',
        name: 'Ops',
        description: 'Operations',
        kind: 'channel',
        metadata: {
          agent_chat: { enabled: true, context_prompt: 'New prompt', activation: 'mention_then_continue' },
          retained: true,
        },
      },
    });
    const store = createPgGrantStore({
      channels: [{
        record_id: 'channel-1',
        title: 'Ops',
        description: 'Operations',
        scope_id: 'scope-a',
        metadata: { basePrompt: 'Old prompt', retained: true },
      }],
      channelSettingsBasePrompt: 'New prompt',
      channelSettingsAgentChatEnabled: true,
      scheduleChannelsRefresh: vi.fn(),
    });

    await store.saveChannelBasePrompt();

    expect(updateTowerPgChannel).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      metadata: {
        retained: true,
        agent_chat: { enabled: true, context_prompt: 'New prompt', activation: 'mention_then_continue' },
      },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' });
    expect(store.channels[0].metadata).toEqual({
      agent_chat: { enabled: true, context_prompt: 'New prompt', activation: 'mention_then_continue' },
      retained: true,
    });
    expect(store.channelSettingsNotice).toBe('Channel context settings saved.');
    expect(store.scheduleChannelsRefresh).not.toHaveBeenCalled();
  });

  it('persists a People directory rename and refreshes mention identity state', async () => {
    const refreshTowerPgWorkspaceMembers = vi.fn().mockResolvedValue([]);
    const store = createPgGrantStore({
      canAdminWorkspace: true,
      pgWorkspaceMembers: [{ actor_id: 'actor-target', id: 'actor-target', npub: 'npub1target', display_name: null, role: 'member' }],
      pgWorkspaceMemberProfileEditingActorId: 'actor-target',
      pgWorkspaceMemberProfileDraft: 'Renamed User',
      pgWorkspaceMemberProfileSaving: false,
      pgWorkspaceMemberProfileError: '',
      chatProfiles: {},
      addressBookPeople: [],
      refreshTowerPgWorkspaceMembers,
    });

    await store.savePgWorkspaceMemberProfile(store.pgWorkspaceMembers[0]);

    expect(updateTowerPgWorkspaceMemberProfile).toHaveBeenCalledWith(
      'workspace-1',
      'actor-target',
      { display_name: 'Renamed User' },
      { baseUrl: 'https://tower.example', appNpub: 'flightdeck-app' },
    );
    expect(store.pgWorkspaceMembers[0].display_name).toBe('Renamed User');
    expect(store.chatProfiles.npub1target.name).toBe('Renamed User');
    expect(store.addressBookPeople).toEqual(expect.arrayContaining([
      expect.objectContaining({ npub: 'npub1target', label: 'Renamed User' }),
    ]));
    expect(refreshTowerPgWorkspaceMembers).toHaveBeenCalledWith({ force: true, limit: 200 });
    expect(store.pgWorkspaceMemberProfileSaving).toBe(false);
    expect(store.pgWorkspaceMemberProfileEditingActorId).toBe('');
  });

  it('clears saving and exposes the Tower error when Agent Direct settings fail', async () => {
    updateTowerPgChannel.mockRejectedValueOnce(new Error('NIP-98 signing timed out'));
    const store = createPgGrantStore({
      channels: [{ record_id: 'channel-1', title: 'Ops', metadata: {} }],
      channelSettingsAgentChatEnabled: true,
    });

    await store.saveChannelBasePrompt();

    expect(store.channelSettingsSaving).toBe(false);
    expect(store.channelSettingsNotice).toBe('');
    expect(store.channelSettingsError).toBe('NIP-98 signing timed out');
    expect(store.channels[0].metadata).toEqual({});
  });

  // --- mapGroupEntry ---
  describe('mapGroupEntry', () => {
    it('maps a group with id field', () => {
      const result = mapGroupEntry({
        id: 'g1',
        group_npub: 'npub1grp',
        current_epoch: 2,
        owner_npub: 'npub1owner',
        name: 'Team',
        group_kind: 'shared',
        private_member_npub: null,
        members: ['npub1a', 'npub1b'],
      });
      expect(result).toEqual({
        group_id: 'g1',
        group_npub: 'npub1grp',
        current_epoch: 2,
        owner_npub: 'npub1owner',
        name: 'Team',
        group_kind: 'shared',
        private_member_npub: null,
        member_npubs: ['npub1a', 'npub1b'],
      });
    });

    it('maps a group with group_id field', () => {
      const result = mapGroupEntry({
        group_id: 'g2',
        group_npub: 'npub1grp2',
        owner_npub: 'npub1owner',
        name: 'Dev',
        member_npubs: ['npub1c'],
      });
      expect(result.group_id).toBe('g2');
      expect(result.group_npub).toBe('npub1grp2');
      expect(result.member_npubs).toEqual(['npub1c']);
    });

    it('defaults current_epoch to 1', () => {
      const result = mapGroupEntry({ id: 'g3', owner_npub: 'npub1o', name: 'X' });
      expect(result.current_epoch).toBe(1);
    });

    it('defaults group_kind to shared', () => {
      const result = mapGroupEntry({ id: 'g4', owner_npub: 'npub1o', name: 'Y' });
      expect(result.group_kind).toBe('shared');
    });

    it('falls back group_npub to group_id then id', () => {
      expect(mapGroupEntry({ id: 'g5', owner_npub: 'o', name: 'Z' }).group_npub).toBe('g5');
      expect(mapGroupEntry({ group_id: 'g6', owner_npub: 'o', name: 'Z' }).group_npub).toBe('g6');
    });

    it('handles empty members gracefully', () => {
      const result = mapGroupEntry({ id: 'g7', owner_npub: 'o', name: 'Z' });
      expect(result.member_npubs).toEqual([]);
    });

    it('converts member entries to strings', () => {
      const result = mapGroupEntry({ id: 'g8', owner_npub: 'o', name: 'Z', members: [123, 'npub1x'] });
      expect(result.member_npubs).toEqual(['123', 'npub1x']);
    });

    it('extracts member_npub when members are objects', () => {
      const result = mapGroupEntry({
        id: 'g9',
        owner_npub: 'o',
        name: 'Z',
        members: [{ member_npub: 'npub1a' }, { member_npub: 'npub1b' }],
      });
      expect(result.member_npubs).toEqual(['npub1a', 'npub1b']);
    });
  });

  // --- mapCreatedGroup ---
  describe('mapCreatedGroup', () => {
    it('maps a create-group response', () => {
      const response = {
        group_id: 'g1',
        group_npub: 'npub1new',
        current_epoch: 1,
        name: 'Created',
        group_kind: 'shared',
        private_member_npub: null,
        members: [{ member_npub: 'npub1a' }, { member_npub: 'npub1b' }],
      };
      const result = mapCreatedGroup(response, 'Fallback Name', 'npub1owner');
      expect(result).toEqual({
        group_id: 'g1',
        group_npub: 'npub1new',
        current_epoch: 1,
        owner_npub: 'npub1owner',
        name: 'Created',
        group_kind: 'shared',
        private_member_npub: null,
        member_npubs: ['npub1a', 'npub1b'],
      });
    });

    it('falls back name to provided name', () => {
      const result = mapCreatedGroup({}, 'My Group', 'npub1owner');
      expect(result.name).toBe('My Group');
    });

    it('falls back group_npub to group_id then id', () => {
      expect(mapCreatedGroup({ id: 'x' }, 'n', 'o').group_npub).toBe('x');
      expect(mapCreatedGroup({ group_id: 'y' }, 'n', 'o').group_npub).toBe('y');
    });

    it('defaults current_epoch to 1', () => {
      const result = mapCreatedGroup({}, 'n', 'o');
      expect(result.current_epoch).toBe(1);
    });

    it('filters out falsy members', () => {
      const result = mapCreatedGroup({ members: [{ member_npub: 'npub1a' }, { member_npub: '' }] }, 'n', 'o');
      expect(result.member_npubs).toEqual(['npub1a']);
    });

    it('handles missing members array', () => {
      const result = mapCreatedGroup({}, 'n', 'o');
      expect(result.member_npubs).toEqual([]);
    });

    it('normalizes mixed member entry shapes in create responses', () => {
      const result = mapCreatedGroup({
        members: [{ member_npub: 'npub1a' }, { npub: 'npub1b' }, 'npub1c'],
      }, 'n', 'o');
      expect(result.member_npubs).toEqual(['npub1a', 'npub1b', 'npub1c']);
    });
  });

  // --- mapRotatedGroup ---
  describe('mapRotatedGroup', () => {
    const baseGroup = {
      group_id: 'g1',
      group_npub: 'npub1old',
      current_epoch: 2,
      owner_npub: 'npub1owner',
      name: 'Original',
      group_kind: 'shared',
      private_member_npub: null,
    };

    it('maps a rotate-group response', () => {
      const response = {
        group_id: 'g1',
        group_npub: 'npub1rotated',
        current_epoch: 3,
        owner_npub: 'npub1owner',
        name: 'Renamed',
        group_kind: 'shared',
        private_member_npub: null,
        members: [{ member_npub: 'npub1a' }],
      };
      const result = mapRotatedGroup(response, { npub: 'npub1identity' }, baseGroup, ['npub1a'], {});
      expect(result.group_npub).toBe('npub1rotated');
      expect(result.current_epoch).toBe(3);
      expect(result.name).toBe('Renamed');
      expect(result.member_npubs).toEqual(['npub1a']);
    });

    it('falls back to identity npub', () => {
      const result = mapRotatedGroup({}, { npub: 'npub1identity' }, baseGroup, ['npub1a'], {});
      expect(result.group_npub).toBe('npub1identity');
    });

    it('increments epoch when response lacks it', () => {
      const result = mapRotatedGroup({}, { npub: 'npub1id' }, baseGroup, [], {});
      expect(result.current_epoch).toBe(3);
    });

    it('falls back name to options.name then group.name', () => {
      expect(mapRotatedGroup({}, { npub: 'n' }, baseGroup, [], { name: 'Opt' }).name).toBe('Opt');
      expect(mapRotatedGroup({}, { npub: 'n' }, baseGroup, [], {}).name).toBe('Original');
    });

    it('falls back member_npubs to nextMembers', () => {
      const result = mapRotatedGroup({}, { npub: 'n' }, baseGroup, ['npub1x', 'npub1y'], {});
      expect(result.member_npubs).toEqual(['npub1x', 'npub1y']);
    });

    it('maps member objects from response', () => {
      const result = mapRotatedGroup(
        { members: [{ member_npub: 'npub1a' }, { member_npub: 'npub1b' }] },
        { npub: 'n' }, baseGroup, [], {},
      );
      expect(result.member_npubs).toEqual(['npub1a', 'npub1b']);
    });

    it('normalizes fallback members when rotate response omits members', () => {
      const result = mapRotatedGroup(
        {},
        { npub: 'n' },
        baseGroup,
        [{ member_npub: 'npub1a' }, { npub: 'npub1b' }, 'npub1c'],
        {},
      );
      expect(result.member_npubs).toEqual(['npub1a', 'npub1b', 'npub1c']);
    });
  });

  // --- deduplicateMembers ---
  describe('deduplicateMembers', () => {
    it('includes the owner first', () => {
      const result = deduplicateMembers('npub1owner', ['npub1a', 'npub1b']);
      expect(result[0]).toBe('npub1owner');
    });

    it('deduplicates members', () => {
      const result = deduplicateMembers('npub1owner', ['npub1a', 'npub1a', 'npub1owner']);
      expect(result).toEqual(['npub1owner', 'npub1a']);
    });

    it('trims and filters blank entries', () => {
      const result = deduplicateMembers('npub1owner', ['  npub1a  ', '', null, undefined]);
      expect(result).toEqual(['npub1owner', 'npub1a']);
    });

    it('handles null memberNpubs', () => {
      const result = deduplicateMembers('npub1owner', null);
      expect(result).toEqual(['npub1owner']);
    });

    it('converts non-string members to strings', () => {
      const result = deduplicateMembers('npub1owner', [123]);
      expect(result).toEqual(['npub1owner', '123']);
    });

    it('normalizes object-shaped member entries', () => {
      const result = deduplicateMembers('npub1owner', [{ member_npub: 'npub1a' }, { npub: 'npub1b' }]);
      expect(result).toEqual(['npub1owner', 'npub1a', 'npub1b']);
    });
  });

  // --- computeGroupMemberDiff ---
  describe('computeGroupMemberDiff', () => {
    it('computes members to add and remove', () => {
      const result = computeGroupMemberDiff(
        ['npub1a', 'npub1b', 'npub1c'],
        ['npub1a', 'npub1d'],
      );
      expect(result.membersToAdd).toEqual(['npub1b', 'npub1c']);
      expect(result.membersToRemove).toEqual(['npub1d']);
    });

    it('returns empty arrays when lists are identical', () => {
      const result = computeGroupMemberDiff(['npub1a'], ['npub1a']);
      expect(result.membersToAdd).toEqual([]);
      expect(result.membersToRemove).toEqual([]);
    });

    it('handles empty desired list', () => {
      const result = computeGroupMemberDiff([], ['npub1a', 'npub1b']);
      expect(result.membersToAdd).toEqual([]);
      expect(result.membersToRemove).toEqual(['npub1a', 'npub1b']);
    });

    it('handles empty existing list', () => {
      const result = computeGroupMemberDiff(['npub1a', 'npub1b'], []);
      expect(result.membersToAdd).toEqual(['npub1a', 'npub1b']);
      expect(result.membersToRemove).toEqual([]);
    });
  });

  // --- parseGroupMemberQueryNpubs ---
  describe('parseGroupMemberQueryNpubs', () => {
    const fakeNpub = 'npub1' + 'a'.repeat(58);

    it('extracts valid npubs from comma-separated query', () => {
      const result = parseGroupMemberQueryNpubs(`${fakeNpub},npub1${'b'.repeat(58)}`);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(fakeNpub);
    });

    it('returns empty array for empty string', () => {
      expect(parseGroupMemberQueryNpubs('')).toEqual([]);
    });

    it('returns empty array for null', () => {
      expect(parseGroupMemberQueryNpubs(null)).toEqual([]);
    });

    it('ignores entries that are too short', () => {
      const result = parseGroupMemberQueryNpubs('npub1short,not-npub');
      expect(result).toEqual([]);
    });

    it('ignores entries not starting with npub1', () => {
      const result = parseGroupMemberQueryNpubs('nsec1' + 'a'.repeat(58));
      expect(result).toEqual([]);
    });

    it('trims whitespace around entries', () => {
      const result = parseGroupMemberQueryNpubs(`  ${fakeNpub}  `);
      expect(result).toEqual([fakeNpub]);
    });

    it('deduplicates entries', () => {
      const result = parseGroupMemberQueryNpubs(`${fakeNpub},${fakeNpub}`);
      expect(result).toEqual([fakeNpub]);
    });
  });

  // --- filterChannelsForViewer ---
  describe('filterChannelsForViewer', () => {
    const OWNER = 'npub1owner';
    const VIEWER = 'npub1viewer';
    const OTHER = 'npub1other';

    const channels = [
      { record_id: 'ch1', title: 'Team Channel', participant_npubs: [OWNER, VIEWER, OTHER] },
      { record_id: 'ch2', title: 'DM: Operator A', participant_npubs: [OWNER, OTHER] },
      { record_id: 'ch3', title: 'Agent B', participant_npubs: [OWNER, OTHER] },
      { record_id: 'ch4', title: 'Open', participant_npubs: [] },
      { record_id: 'ch5', title: 'Legacy', participant_npubs: undefined },
    ];

    it('workspace owner sees all channels', () => {
      const result = filterChannelsForViewer(channels, OWNER, OWNER);
      expect(result).toHaveLength(5);
    });

    it('guest viewer only sees channels where they are a participant', () => {
      const result = filterChannelsForViewer(channels, VIEWER, OWNER);
      expect(result.map(c => c.record_id)).toEqual(['ch1', 'ch4', 'ch5']);
    });

    it('guest viewer sees existing group channels after being added to the delivery group', () => {
      const result = filterChannelsForViewer([
        ...channels,
        {
          record_id: 'ch6',
          title: 'General',
          group_ids: ['shared-group'],
          participant_npubs: [OWNER, OTHER],
        },
      ], VIEWER, OWNER, [
        {
          group_id: 'shared-group',
          group_npub: 'npub1sharedgroup',
          member_npubs: [OWNER, VIEWER, OTHER],
        },
      ]);
      expect(result.map(c => c.record_id)).toContain('ch6');
    });

    it('guest viewer sees channels that reference the current group npub', () => {
      const result = filterChannelsForViewer([
        {
          record_id: 'ch6',
          title: 'General',
          group_ids: ['npub1sharedgroup'],
          participant_npubs: [OWNER, OTHER],
        },
      ], VIEWER, OWNER, [
        {
          group_id: 'shared-group',
          group_npub: 'npub1sharedgroup',
          member_npubs: [OWNER, VIEWER, OTHER],
        },
      ]);
      expect(result.map(c => c.record_id)).toEqual(['ch6']);
    });

    it('filters out channels where viewer is not in participant_npubs', () => {
      const result = filterChannelsForViewer(channels, VIEWER, OWNER);
      expect(result.map(c => c.record_id)).not.toContain('ch2');
      expect(result.map(c => c.record_id)).not.toContain('ch3');
    });

    it('channels without participant_npubs are always visible', () => {
      const result = filterChannelsForViewer(channels, VIEWER, OWNER);
      expect(result.map(c => c.record_id)).toContain('ch4');
      expect(result.map(c => c.record_id)).toContain('ch5');
    });

    it('returns all channels when viewerNpub is null', () => {
      const result = filterChannelsForViewer(channels, null, OWNER);
      expect(result).toHaveLength(5);
    });

    it('returns all channels when viewerNpub is undefined', () => {
      const result = filterChannelsForViewer(channels, undefined, OWNER);
      expect(result).toHaveLength(5);
    });
  });

  describe('new channel group suggestions', () => {
    function createPickerStore(overrides = {}) {
      const store = {
        currentWorkspaceContentGroups: [],
        groups: [
          { group_id: 'g-alpha', name: 'Alpha Team', member_npubs: ['npub1a'] },
          { group_id: 'g-beta', name: 'Beta Team', member_npubs: ['npub1b', 'npub1c'] },
        ],
        newChannelGroupId: '',
        resolveGroupId: (value) => value || null,
        ...overrides,
      };
      Object.defineProperty(
        store,
        'newChannelGroupOptions',
        Object.getOwnPropertyDescriptor(channelsManagerMixin, 'newChannelGroupOptions'),
      );
      return store;
    }

    it('returns browsable groups for an empty group query', () => {
      const store = createPickerStore();

      const suggestions = channelsManagerMixin.findNewChannelGroupSuggestions.call(store, '');

      expect(suggestions.map((group) => group.groupId)).toEqual(['g-alpha', 'g-beta']);
    });

    it('filters browsable groups by name when queried', () => {
      const store = createPickerStore();

      const suggestions = channelsManagerMixin.findNewChannelGroupSuggestions.call(store, 'beta');

      expect(suggestions.map((group) => group.groupId)).toEqual(['g-beta']);
    });

    it('omits the selected group from browsable suggestions', () => {
      const store = createPickerStore({ newChannelGroupId: 'g-alpha' });

      const suggestions = channelsManagerMixin.findNewChannelGroupSuggestions.call(store, '');

      expect(suggestions.map((group) => group.groupId)).toEqual(['g-beta']);
    });
  });

  describe('channel tab ordering', () => {
    const orderedChannels = [
      { record_id: 'ch1', title: 'Team Channel', participant_npubs: [] },
      { record_id: 'ch2', title: 'DM: Operator A', participant_npubs: [] },
      { record_id: 'ch3', title: 'Agent B', participant_npubs: [] },
    ];

    function createStore(overrides = {}) {
      return {
        channels: [],
        channelOrder: [],
        channelDragSourceId: '',
        channelDragTargetId: '',
        selectedChannelId: '',
        session: { npub: 'npub1owner' },
        workspaceOwnerNpub: 'npub1owner',
        MAIN_FEED_PAGE_SIZE: 20,
        mainFeedVisibleCount: 20,
        chatFeedNearTop: false,
        expandedChatMessageIds: [],
        truncatedChatMessageIds: [],
        pendingChatScrollToLatest: false,
        getChannelParticipants: (channel) => channel.participant_npubs || [],
        rememberPeople: vi.fn(),
        closeThread: vi.fn(),
        startSelectedChannelLiveQuery: vi.fn(),
        syncRoute: vi.fn(),
        applyMessages: vi.fn(),
        updatePageTitle: vi.fn(),
        saveWorkspaceChannelOrder: vi.fn(),
        ...overrides,
      };
    }

    it.each(['can_read', 'readable'])('hides revoked PG channels when only %s changes', async field => {
      isTowerPgBackendMode.mockReturnValue(true);
      const channel = { record_id: 'channel-1', scope_id: 'scope-1', version: 1, [field]: true };
      const store = createStore({ channels: [channel], selectedChannelId: 'channel-1', currentWorkspace: { pgBackendMode: true } });
      await channelsManagerMixin.applyChannels.call(store, [{ ...channel, [field]: false }], { syncRoute: false });
      expect(store.channels).toEqual([]);
      expect(store.selectedChannelId).toBeNull();
    });

    it('applies saved channel order when channels load', async () => {
      isTowerPgBackendMode.mockReturnValue(false);
      const store = createStore({ channelOrder: ['ch3', 'ch1'] });

      await channelsManagerMixin.applyChannels.call(store, orderedChannels, { syncRoute: false });

      expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch3', 'ch1', 'ch2']);
      expect(store.channelOrder).toEqual(['ch3', 'ch1', 'ch2']);
      expect(store.selectedChannelId).toBe('ch3');
    });

    it('applies group membership visibility when channels load', async () => {
      isTowerPgBackendMode.mockReturnValue(false);
      const store = createStore({
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        groups: [{ group_id: 'shared-group', member_npubs: ['npub1viewer'] }],
      });

      await channelsManagerMixin.applyChannels.call(store, [
        {
          record_id: 'ch-general',
          title: 'General',
          group_ids: ['shared-group'],
          participant_npubs: ['npub1owner'],
        },
      ], { syncRoute: false });

      expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch-general']);
      expect(store.selectedChannelId).toBe('ch-general');
    });

    it('does not auto-select the first channel while a PG scope home is selected', async () => {
      const store = createStore({
        currentWorkspace: { pgBackendMode: true },
        selectedBoardId: 'scope-a',
        selectedChannelId: null,
        navSection: 'chat',
        ensureSelectedChatChannelInScope: vi.fn(),
      });

      await channelsManagerMixin.applyChannels.call(store, [
        { record_id: 'ch-a', title: 'A', scope_id: 'scope-a', participant_npubs: [] },
        { record_id: 'ch-b', title: 'B', scope_id: 'scope-a', participant_npubs: [] },
      ], { syncRoute: false });

      expect(store.selectedChannelId).toBeNull();
      expect(store.ensureSelectedChatChannelInScope).not.toHaveBeenCalled();
      expect(store.applyMessages).toHaveBeenCalledWith([], { scrollToLatest: false });
    });

    it('does not hide cached Tower PG channels while PG groups are still hydrating', async () => {
      const store = createStore({
        currentWorkspace: { pgBackendMode: true },
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1workspace',
        groups: [],
      });

      await channelsManagerMixin.applyChannels.call(store, [
        {
          record_id: 'pg-channel',
          title: 'PG Channel',
          group_ids: ['pg-group-not-yet-loaded'],
          participant_npubs: [],
        },
      ], { syncRoute: false });

      expect(store.channels.map((channel) => channel.record_id)).toEqual(['pg-channel']);
      expect(store.selectedChannelId).toBe('pg-channel');
    });

    it('preserves saved channel order through an empty channel batch', async () => {
      isTowerPgBackendMode.mockReturnValue(false);
      const store = createStore({ channelOrder: ['ch3', 'ch1'] });

      await channelsManagerMixin.applyChannels.call(store, [], { syncRoute: false });

      expect(store.channelOrder).toEqual(['ch3', 'ch1']);
      expect(store.channels).toEqual([]);
    });

    it('checkpoints drafts against the old destination before a live channel transition', async () => {
      const saveChatComposerDraft = vi.fn();
      const restoreChatComposerDraft = vi.fn();
      const store = createStore({
        currentWorkspace: { pgBackendMode: true },
        navSection: 'chat',
        selectedBoardId: '__pg_channel__:ch-old',
        selectedChannelId: 'ch-old',
        activeThreadId: 'thread-old',
        channels: [{ record_id: 'ch-old', scope_id: 'scope-old', participant_npubs: [] }],
        saveChatComposerDraft,
        restoreChatComposerDraft,
        ensureSelectedChatChannelInScope: vi.fn(),
      });

      await channelsManagerMixin.applyChannels.call(store, [
        { record_id: 'ch-new', scope_id: 'scope-new', participant_npubs: [] },
      ], { syncRoute: false });

      const oldDestination = {
        channelId: 'ch-old',
        scopeId: 'scope-old',
        threadId: 'thread-old',
      };
      expect(saveChatComposerDraft).toHaveBeenCalledWith('message', oldDestination);
      expect(saveChatComposerDraft).toHaveBeenCalledWith('thread', oldDestination);
      expect(store.closeThread).toHaveBeenCalledWith({ syncRoute: false, saveDraft: false });
      expect(restoreChatComposerDraft).toHaveBeenCalledWith('message');
      expect(store.selectedChannelId).toBe('ch-new');
    });

    it('persists the new order after a tab drop', async () => {
      isTowerPgBackendMode.mockReturnValue(false);
      const store = createStore({
        channels: orderedChannels,
        channelOrder: ['ch1', 'ch2', 'ch3'],
        channelDragSourceId: 'ch3',
      });
      const event = { preventDefault: vi.fn() };

      await channelsManagerMixin.dropChannelTab.call(store, 'ch1', event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(store.channelDragSourceId).toBe('');
      expect(store.channelDragTargetId).toBe('');
      expect(store.channelOrder).toEqual(['ch3', 'ch1', 'ch2']);
      expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch3', 'ch1', 'ch2']);
      expect(store.saveWorkspaceChannelOrder).toHaveBeenCalledWith(['ch3', 'ch1', 'ch2']);
    });

    it('marks and clears the prospective channel drop target', () => {
      const store = createStore({ channelDragSourceId: 'ch3' });
      const event = { preventDefault: vi.fn(), dataTransfer: {} };

      channelsManagerMixin.handleChannelTabDragOver.call(store, 'ch1', event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(store.channelDragTargetId).toBe('ch1');
      expect(event.dataTransfer.dropEffect).toBe('move');

      channelsManagerMixin.endChannelTabDrag.call(store);
      expect(store.channelDragSourceId).toBe('');
      expect(store.channelDragTargetId).toBe('');
    });

    it('keeps the local order and surfaces sync errors when saving fails', async () => {
      isTowerPgBackendMode.mockReturnValue(false);
      const store = createStore({
        channels: orderedChannels,
        channelOrder: ['ch1', 'ch2', 'ch3'],
        channelDragSourceId: 'ch3',
        saveWorkspaceChannelOrder: vi.fn().mockRejectedValue(new Error('missing group keys')),
      });

      await channelsManagerMixin.dropChannelTab.call(store, 'ch1', { preventDefault: vi.fn() });

      expect(store.channelOrder).toEqual(['ch3', 'ch1', 'ch2']);
      expect(store.error).toBe('missing group keys');
    });

    it('optimistically reorders one PG scope, persists Dexie, then reconciles from Tower', async () => {
      const refreshChannels = vi.fn(async () => []);
      const store = createStore({
        channels: [
          { record_id: 'channel-1', title: 'One', scope_id: 'scope-a', position: 1 },
          { record_id: 'channel-2', title: 'Two', scope_id: 'scope-a', position: 2 },
          { record_id: 'channel-other', title: 'Other', scope_id: 'scope-b', position: 1 },
        ],
        selectedChannelId: 'channel-1',
        canAdminWorkspace: true,
        currentWorkspace: {
          pgBackendMode: true,
          workspaceId: 'workspace-1',
          workspaceOwnerNpub: 'npub1owner',
          directHttpsUrl: 'https://tower.example',
          appNpub: 'flightdeck_pg',
        },
        refreshChannels,
      });
      applyChannelMixin(store);

      const result = await store.moveChannelToPosition('channel-1', 2);

      expect(result).toMatchObject({ position: 2, changed: true });
      expect(store.channels.filter((channel) => channel.scope_id === 'scope-a').map((channel) => [channel.record_id, channel.position])).toEqual([
        ['channel-2', 1], ['channel-1', 2],
      ]);
      expect(store.channels.find((channel) => channel.record_id === 'channel-other')).toMatchObject({ position: 1 });
      expect(reorderTowerPgChannel).toHaveBeenCalledWith('workspace-1', 'channel-1', 2, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      });
      expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'channel-2', position: 1 }));
      expect(refreshChannels).not.toHaveBeenCalled();
    });

    it('rolls back the PG scope order and surfaces a visible write failure', async () => {
      reorderTowerPgChannel.mockRejectedValueOnce(new Error('Tower unavailable'));
      const store = createStore({
        channels: [
          { record_id: 'channel-1', title: 'One', scope_id: 'scope-a', position: 1 },
          { record_id: 'channel-2', title: 'Two', scope_id: 'scope-a', position: 2 },
        ],
        selectedChannelId: 'channel-1',
        channelSettingsChannelId: 'channel-1',
        channelSettingsPosition: '2',
        channelSettingsError: '',
        channelSettingsNotice: '',
        channelPositionSaving: false,
        canAdminWorkspace: true,
        currentWorkspace: {
          pgBackendMode: true,
          workspaceId: 'workspace-1',
          workspaceOwnerNpub: 'npub1owner',
          directHttpsUrl: 'https://tower.example',
          appNpub: 'flightdeck_pg',
        },
      });
      applyChannelMixin(store);

      await store.moveSelectedChannelToPosition();

      expect(store.channels.map((channel) => [channel.record_id, channel.position])).toEqual([
        ['channel-1', 1], ['channel-2', 2],
      ]);
      expect(store.channelSettingsError).toBe('Tower unavailable');
      expect(store.channelSettingsPosition).toBe('1');
      expect(store.channelPositionSaving).toBe(false);
    });

    it('validates the 1-based PG position before writing', async () => {
      const store = createStore({
        channels: [{ record_id: 'channel-1', scope_id: 'scope-a', position: 1 }],
        selectedChannelId: 'channel-1',
        canAdminWorkspace: true,
      });
      applyChannelMixin(store);

      await expect(store.moveChannelToPosition('channel-1', 0)).rejects.toThrow('between 1 and 1');
      expect(reorderTowerPgChannel).not.toHaveBeenCalled();
    });
  });

  describe('PG channel grant capacity presets', () => {
    it('maps viewer to read-only channel-anchored permissions', () => {
      expect(permissionsForPgChannelCapacity('viewer')).toEqual([
        'channel.read',
        'task.read',
        'doc.read',
        'file.read',
        'audio_note.read',
      ]);
    });

    it('maps manager to channel grant management without workspace management', () => {
      const permissions = permissionsForPgChannelCapacity('manager');
      expect(permissions).toEqual(expect.arrayContaining([
        'channel.read',
        'channel.write',
        'channel.manage',
        'channel.grants.read',
        'channel.grants.manage',
        'task.create',
        'task.update',
        'doc.write',
        'file.write',
        'audio_note.write',
      ]));
      expect(permissions).not.toContain('workspace.manage');
      expect(permissions).not.toContain('scope.manage');
      expect(permissions).not.toContain('channel.grant');
    });

    it('maps agent to content creation without workspace or channel management', () => {
      const permissions = permissionsForPgChannelCapacity('agent');
      expect(permissions).toEqual(expect.arrayContaining([
        'channel.read',
        'channel.write',
        'task.read',
        'task.create',
        'doc.write',
        'file.write',
        'audio_note.write',
      ]));
      expect(permissions).not.toContain('task.update');
      expect(permissions).not.toContain('channel.manage');
      expect(permissions).not.toContain('channel.grants.manage');
      expect(permissions).not.toContain('workspace.manage');
    });

    it('round-trips exact preset permissions to capacity names', () => {
      expect(capacityForPgChannelPermissions(permissionsForPgChannelCapacity('viewer'))).toBe('viewer');
      expect(capacityForPgChannelPermissions(permissionsForPgChannelCapacity('contributor'))).toBe('contributor');
      expect(capacityForPgChannelPermissions(permissionsForPgChannelCapacity('manager'))).toBe('manager');
      expect(capacityForPgChannelPermissions(permissionsForPgChannelCapacity('agent'))).toBe('agent');
    });

    it('keeps Tower standard manage grant bundles editable as Manage after refresh', () => {
      const grants = aggregatePgChannelGrants([
        {
          id: 'grant-1',
          principal_type: 'group',
          principal_id: 'group-managers',
          permissions: [
            'channel.read',
            'channel.write',
            'channel.manage',
            'channel.grants.read',
            'channel.grants.manage',
            'task.read',
            'task.create',
            'task.update',
            'task.comment',
            'comment.create',
            'doc.read',
            'doc.write',
            'file.read',
            'file.write',
            'audio_note.read',
            'audio_note.write',
          ],
        },
      ]);

      expect(grants[0].capacity).toBe('manager');
    });

    it('aggregates grant rows with nested group principals', () => {
      const grants = aggregatePgChannelGrants([
        {
          id: 'grant-nested-group',
          principal_type: 'group',
          principal: { group_id: 'group-agents', name: 'Agents' },
          permissions: ['channel.read'],
        },
      ]);

      expect(grants).toEqual([
        expect.objectContaining({
          key: 'group:group-agents',
          principal_type: 'group',
          principal_id: 'group-agents',
          permissions: ['channel.read'],
        }),
      ]);
    });

    it('aggregates Tower grant rows by principal and detects the matching capacity', () => {
      const rows = aggregatePgChannelGrants([
        {
          id: 'grant-1',
          principal_type: 'actor',
          principal_id: 'actor-1',
          principal_npub: 'npub1actor',
          permissions: ['channel.read'],
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 'grant-2',
          principal_type: 'actor',
          principal_id: 'actor-1',
          permissions: ['task.read', 'doc.read', 'file.read', 'audio_note.read'],
          created_at: '2026-06-01T00:00:01.000Z',
        },
        {
          id: 'grant-3',
          principal_type: 'group',
          principal_id: 'group-1',
          permission: 'channel.read',
        },
      ]);

      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.key === 'actor:actor-1')).toEqual(expect.objectContaining({
        principal_type: 'actor',
        principal_id: 'actor-1',
        principal_npub: 'npub1actor',
        capacity: 'viewer',
        permissions: ['audio_note.read', 'channel.read', 'doc.read', 'file.read', 'task.read'],
      }));
      expect(rows.find((row) => row.key === 'group:group-1')).toEqual(expect.objectContaining({
        capacity: 'custom',
        permissions: ['channel.read'],
      }));
    });

    it('detects selected-channel grant management for direct actor and effective group grants', () => {
      expect(canManagePgChannelGrantsFromRows({
        grants: [{
          principal_type: 'actor',
          principal_id: 'actor-manager',
          permissions: ['channel.grants.manage'],
        }],
        actorId: 'actor-manager',
        viewerNpub: 'npub1manager',
        groups: [],
      })).toBe(true);

      expect(canManagePgChannelGrantsFromRows({
        grants: [{
          principal_type: 'group',
          principal_id: 'group-managers',
          permissions: ['channel.grants.manage'],
        }],
        actorId: 'actor-member',
        viewerNpub: 'npub1nested',
        groups: [{
          group_id: 'group-managers',
          member_npubs: [],
          effective_member_npubs: ['npub1nested'],
        }],
      })).toBe(true);
    });

    it('uses channel.manage for reorder permission without exposing it to view-only actors', () => {
      expect(canManagePgChannelFromRows({
        grants: [{ principal_type: 'actor', principal_id: 'actor-manager', permissions: ['channel.manage'] }],
        actorId: 'actor-manager',
      })).toBe(true);
      expect(canManagePgChannelFromRows({
        grants: [{ principal_type: 'actor', principal_id: 'actor-viewer', permissions: ['channel.read'] }],
        actorId: 'actor-viewer',
      })).toBe(false);
    });

    it('uses selected channel grant cache instead of stale grants from another channel', () => {
      const store = createPgGrantStore({
        selectedChannelId: 'channel-2',
        channelGrantsChannelId: 'channel-1',
        channelGrants: [{
          principal_type: 'actor',
          principal_id: 'actor-stale',
          permissions: ['channel.read'],
        }],
        channels: [{
          record_id: 'channel-2',
          channel_grants: [{
            principal_type: 'group',
            principal_id: 'group-agents',
            permissions: ['channel.read'],
          }],
        }],
      });

      expect(store.channelGrantRows).toEqual([
        expect.objectContaining({
          key: 'group:group-agents',
          principal_type: 'group',
          principal_id: 'group-agents',
        }),
      ]);
    });

    it('caches successful selected-channel grant reads on the channel row', async () => {
      getTowerPgChannelGrants.mockResolvedValueOnce({
        grants: [{
          principal_type: 'group',
          principal_id: 'group-agents',
          permissions: ['channel.read'],
        }],
      });
      const store = createPgGrantStore({
        selectedChannelId: 'channel-2',
        channelGrants: [],
        channels: [{ record_id: 'channel-2', title: 'Feature' }],
      });

      await store.refreshChannelGrants();

      expect(store.channelGrantsChannelId).toBe('channel-2');
      expect(store.channels.find((channel) => channel.record_id === 'channel-2')?.channel_grants).toEqual([{
        principal_type: 'group',
        principal_id: 'group-agents',
        permissions: ['channel.read'],
      }]);
    });

    it('labels actor grants through resolved npubs and profile names', () => {
      const getSenderName = vi.fn((npub) => ({ npub1direct: 'Direct Person', npub1member: 'Member Person' }[npub] || npub));
      const store = createPgGrantStore({
        getSenderName,
        pgWorkspaceMembers: [{ actor_id: 'actor-member', id: 'actor-member', npub: 'npub1member' }],
      });

      expect(store.getPgChannelGrantPrincipalLabel({
        principal_type: 'actor',
        principal_id: 'actor-direct',
        principal_npub: 'npub1direct',
      })).toBe('Direct Person');
      expect(store.getPgChannelGrantPrincipalLabel({
        principal_type: 'actor',
        principal_id: 'npub1direct',
      })).toBe('Direct Person');
      expect(store.getPgChannelGrantPrincipalLabel({
        principal_type: 'actor',
        principal_id: 'actor-member',
      })).toBe('Member Person');
      expect(getSenderName).toHaveBeenCalledWith('npub1direct');
      expect(getSenderName).toHaveBeenCalledWith('npub1member');
    });

    it('does not treat viewer, contributor, or agent capacity as grant management', () => {
      for (const capacity of ['viewer', 'contributor', 'agent']) {
        expect(canManagePgChannelGrantsFromRows({
          grants: [{
            principal_type: 'actor',
            principal_id: 'actor-user',
            permissions: permissionsForPgChannelCapacity(capacity),
          }],
          actorId: 'actor-user',
          viewerNpub: 'npub1user',
          groups: [],
        })).toBe(false);
      }
    });

    it('allows workspace admins to submit a typed actor grant payload', async () => {
      const publishPgOnboardingAnnouncementForGrant = vi.fn().mockResolvedValue({ status: 'published' });
      const store = createPgGrantStore({
        canAdminWorkspace: true,
        channelGrants: [],
        channelGrantCapacity: 'contributor',
        publishPgOnboardingAnnouncementForGrant,
      });

      await store.createChannelGrant();

      expect(createTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-1', {
        principal_type: 'actor',
        principal_id: 'actor-target',
        access_level: 'contribute',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(publishPgOnboardingAnnouncementForGrant).toHaveBeenCalledWith({
        recipientNpub: 'npub1target',
        grantId: 'workspace-1:channel-1:actor-target',
        reason: 'added_to_workspace_or_group',
      });
    });

    it('publishes onboarding after a Tower PG workspace member grant succeeds', async () => {
      const publishPgOnboardingAnnouncementForGrant = vi.fn().mockResolvedValue({ status: 'published' });
      const recipientNpub = `npub1${'q'.repeat(58)}`;
      const store = createPgGrantStore({
        canAdminWorkspace: true,
        pgWorkspaceMemberNpub: recipientNpub,
        groupEditPending: false,
        publishPgOnboardingAnnouncementForGrant,
      });

      await store.addPgWorkspaceMember();

      expect(createTowerPgWorkspaceMember).toHaveBeenCalledWith('workspace-1', {
        member_npub: recipientNpub,
        role: 'member',
        kind: 'human',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(publishPgOnboardingAnnouncementForGrant).toHaveBeenCalledWith({
        recipientNpub,
        grantId: `workspace-1:workspace:${recipientNpub}`,
        reason: 'added_to_workspace_or_group',
      });
      expect(store.pgWorkspaceMemberNpub).toBe('');
      expect(store.refreshGroups).toHaveBeenCalledWith({ force: true, minIntervalMs: 0 });
    });

    it('offers workspace members that are not already in the PG group', () => {
      const store = createPgGrantStore({
        groups: [{
          group_id: 'group-1',
          owner_npub: 'npub1workspace',
          member_npubs: ['npub1existing'],
        }],
        currentWorkspaceGroups: [{
          group_id: 'group-1',
          owner_npub: 'npub1workspace',
          member_npubs: ['npub1existing'],
        }],
        pgWorkspaceMembers: [
          { actor_id: 'actor-existing', npub: 'npub1existing' },
          { actor_id: 'actor-new', npub: 'npub1newmember' },
        ],
        getSenderName: vi.fn((npub) => npub === 'npub1newmember' ? 'New Member' : npub),
      });

      expect(store.getPgGroupMemberCandidates('group-1')).toEqual([{
        npub: 'npub1newmember',
        label: 'New Member',
        role: 'member',
      }]);
    });

    it('adds an existing workspace member to a Tower PG group', async () => {
      const publishPgOnboardingAnnouncementForGrant = vi.fn().mockResolvedValue({ status: 'published' });
      const store = createPgGrantStore({
        canAdminWorkspace: true,
        pgGroupMemberDrafts: { 'group-1': 'npub1recipient' },
        groupEditPending: false,
        publishPgOnboardingAnnouncementForGrant,
      });

      await store.addPgGroupMember('group-1');

      expect(addTowerPgWorkspaceGroupMember).toHaveBeenCalledWith('workspace-1', 'group-1', {
        member_npub: 'npub1recipient',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(publishPgOnboardingAnnouncementForGrant).toHaveBeenCalledWith({
        recipientNpub: 'npub1recipient',
        grantId: 'workspace-1:group-1:npub1recipient',
        reason: 'added_to_workspace_or_group',
      });
      expect(store.pgGroupMemberDrafts['group-1']).toBe('');
      expect(store.refreshGroups).toHaveBeenCalledWith({ force: true, minIntervalMs: 0 });
    });

    it('keeps the current PG actor visible when workspace members have not loaded', async () => {
      getTowerPgWorkspaceMembers.mockRejectedValueOnce(new Error('forbidden'));
      const store = createPgGrantStore({
        currentWorkspace: {
          workspaceId: 'workspace-1',
          workspaceOwnerNpub: 'npub1workspace',
          directHttpsUrl: 'https://tower.example',
          appNpub: 'flightdeck-app',
          pgBackendMode: true,
          pgMe: {
            actor: { actor_id: 'actor-self', npub: 'npub1self', kind: 'human' },
            membership: { role: 'owner', joined_at: '2026-06-07T00:00:00.000Z' },
            permissions: ['workspace.read'],
          },
        },
        pgWorkspaceMembers: [],
      });

      const members = await store.refreshTowerPgWorkspaceMembers();

      expect(members).toEqual([expect.objectContaining({
        actor_id: 'actor-self',
        npub: 'npub1self',
        role: 'owner',
      })]);
      expect(store.pgWorkspaceMembers).toHaveLength(0);
    });

    it('shows a clear message when creating a duplicate Tower PG group', async () => {
      const duplicate = new Error('Tower PG API 409 POST https://tower.example/groups: {"code":"duplicate_group"}');
      duplicate.status = 409;
      duplicate.responseText = '{"code":"duplicate_group"}';
      createTowerPgWorkspaceGroup.mockRejectedValueOnce(duplicate);
      const store = createPgGrantStore({
        canAdminWorkspace: true,
        newGroupName: 'Managers',
        newGroupMemberQuery: '',
        newGroupMembers: [],
        groupCreatePending: false,
        showNewGroupModal: true,
        consumeGroupMemberQuery: vi.fn(() => ({ members: [] })),
        resetNewGroupDraft: vi.fn(),
      });

      await store.createSharingGroup();

      expect(createTowerPgWorkspaceGroup).toHaveBeenCalledWith('workspace-1', {
        name: 'Managers',
        kind: 'custom',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(store.error).toBe('A group with this name already exists.');
      expect(store.showNewGroupModal).toBe(true);
    });

    it('submits an authoritative agent kind and schedules only targeted access hydration', async () => {
      const agentNpub = `npub1${'a'.repeat(58)}`;
      const schedulePgChannelAccessMaterializationRefresh = vi.fn();
      const store = createPgGrantStore({
        canAdminWorkspace: true,
        newGroupName: 'Agents',
        newGroupMemberQuery: '',
        newGroupMembers: [{ npub: agentNpub, kind: 'agent', actorId: 'actor-agent' }],
        pgWorkspaceMembers: [{ actor_id: 'actor-agent', npub: agentNpub, kind: 'agent', display_name: 'Agent One' }],
        groupCreatePending: false,
        consumeGroupMemberQuery: vi.fn((_query, members) => ({ members })),
        resetNewGroupDraft: vi.fn(),
        schedulePgChannelAccessMaterializationRefresh,
        requestTowerSyncFamily: vi.fn(),
      });

      await store.createSharingGroup();

      expect(createTowerPgWorkspaceMember).toHaveBeenCalledWith('workspace-1', {
        member_npub: agentNpub,
        role: 'member',
        kind: 'agent',
      }, expect.any(Object));
      expect(schedulePgChannelAccessMaterializationRefresh).toHaveBeenCalledOnce();
      expect(store.requestTowerSyncFamily).not.toHaveBeenCalledWith('workspace-bootstrap', expect.anything(), expect.anything());
    });

    it('allows selected-channel managers to submit group grants', async () => {
      const store = createPgGrantStore({
        channelGrantPrincipalType: 'group',
        channelGrantActorId: '',
        channelGrantGroupId: 'group-target',
        channelGrantCapacity: 'manager',
        channelGrants: [{
          principal_type: 'actor',
          principal_id: 'actor-manager',
          permissions: ['channel.read', 'channel.grants.read', 'channel.grants.manage'],
        }],
      });

      await store.createChannelGrant();

      expect(createTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-1', {
        principal_type: 'group',
        principal_id: 'group-target',
        access_level: 'manage',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(store.channelGrantsNotice).toBe('Channel access updated.');
    });

    it('updates standard channel grants by access level', async () => {
      const store = createPgGrantStore({
        channelGrants: [{
          principal_type: 'actor',
          principal_id: 'actor-manager',
          permissions: ['channel.read', 'channel.grants.read', 'channel.grants.manage'],
        }],
      });
      const grant = {
        principal_type: 'group',
        principal_id: 'group-target',
        capacity: 'viewer',
      };

      await store.updateChannelGrantCapacity(grant, 'manager');

      expect(updateTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-1', 'group', 'group-target', {
        access_level: 'manage',
      }, {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(store.channelGrantsNotice).toBe('Channel access updated.');
    });

    it('keeps custom grants read-only in the primary editor', async () => {
      const store = createPgGrantStore({
        canAdminWorkspace: true,
      });
      const customGrant = {
        principal_type: 'group',
        principal_id: 'group-target',
        capacity: 'custom',
      };

      expect(store.canEditPgChannelGrantRow(customGrant)).toBe(false);
      await store.updateChannelGrantCapacity(customGrant, 'manager');

      expect(updateTowerPgChannelGrant).not.toHaveBeenCalled();
    });

    it('removes channel grants for managers', async () => {
      const store = createPgGrantStore({
        channelGrants: [{
          principal_type: 'actor',
          principal_id: 'actor-manager',
          permissions: ['channel.read', 'channel.grants.read', 'channel.grants.manage'],
        }],
      });

      await store.removeChannelGrant({
        principal_type: 'actor',
        principal_id: 'actor-target',
      });

      expect(deleteTowerPgChannelGrant).toHaveBeenCalledWith('workspace-1', 'channel-1', 'actor', 'actor-target', {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(store.channelGrantsNotice).toBe('Channel access removed.');
    });

    it('blocks viewers from submitting channel grants', async () => {
      const store = createPgGrantStore({
        currentWorkspace: {
          workspaceId: 'workspace-1',
          workspaceOwnerNpub: 'npub1workspace',
          directHttpsUrl: 'https://tower.example',
          appNpub: 'flightdeck-app',
          pgBackendMode: true,
          pgMe: {
            actor: { actor_id: 'actor-viewer', npub: 'npub1viewer' },
            permissions: ['workspace.read', 'channel.read'],
          },
        },
        session: { npub: 'npub1viewer' },
        channelGrants: [{
          principal_type: 'actor',
          principal_id: 'actor-viewer',
          permissions: permissionsForPgChannelCapacity('viewer'),
        }],
      });

      await store.createChannelGrant();

      expect(createTowerPgChannelGrant).not.toHaveBeenCalled();
      expect(store.channelGrantsError).toBe('You do not have permission to manage grants for this channel.');
    });

    it('refreshes grants immediately and runs PG materialization in the background after a successful grant', async () => {
      getTowerPgChannelGrants.mockResolvedValueOnce({
        grants: [{
          principal_type: 'actor',
          principal_id: 'actor-target',
          permissions: permissionsForPgChannelCapacity('viewer'),
        }],
      });
      let finishMaterialization;
      hydrateTowerPgScopes.mockImplementationOnce(() => new Promise((resolve) => {
        finishMaterialization = resolve;
      }));
      const store = createPgGrantStore({ canAdminWorkspace: true, channelGrants: [] });

      await store.createChannelGrant();

      expect(getTowerPgChannelGrants).toHaveBeenCalledWith('workspace-1', 'channel-1', {
        baseUrl: 'https://tower.example',
        appNpub: 'flightdeck-app',
      });
      expect(store.channelGrants).toEqual([{
        principal_type: 'actor',
        principal_id: 'actor-target',
        permissions: permissionsForPgChannelCapacity('viewer'),
      }]);
      expect(store.channelGrantsSaving).toBe(false);
      expect(store.channelGrantsNotice).toBe('Channel access updated.');

      await flushMicrotasks();
      expect(hydrateTowerPgScopes).toHaveBeenCalledWith(store);
      expect(hydrateTowerPgChannels).not.toHaveBeenCalled();
      finishMaterialization();
      await flushMicrotasks();
      expect(hydrateTowerPgChannels).toHaveBeenCalledWith(store);
      expect(hydrateTowerPgTasks).toHaveBeenCalledWith(store);
      expect(hydrateTowerPgDocumentsAndFiles).toHaveBeenCalledWith(store);
      expect(hydrateTowerPgAudioNotes).toHaveBeenCalledWith(store);
    });
  });
});

it('discards a roster response after switching workspace databases', async () => {
  const { openWorkspaceDb, getWorkspaceDb, getWorkspaceMembers } = await import('../src/db.js');
  let finish;
  getTowerPgWorkspaceMembers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const store = createPgGrantStore({ rememberPeople: vi.fn(async () => {}) });
  openWorkspaceDb('mention-roster-a');
  await getWorkspaceDb().open();
  const request = store.refreshTowerPgWorkspaceMembers();
  store.currentWorkspace = { ...store.currentWorkspace, workspaceId: 'workspace-b' };
  openWorkspaceDb('mention-roster-b');
  await getWorkspaceDb().open();
  finish({ members: [{ actor: { actor_id: 'agent-a', npub: 'npub1agent-a', kind: 'agent', display_name: 'Agent A' } }] });
  await request;
  expect(await getWorkspaceMembers('workspace-1')).toEqual([]);
  expect(store.rememberPeople).not.toHaveBeenCalled();
});

it('materializes the roster when same-workspace metadata refreshes during the request', async () => {
  const { openWorkspaceDb, getWorkspaceDb, getWorkspaceMembers } = await import('../src/db.js');
  let finish;
  getTowerPgWorkspaceMembers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const store = createPgGrantStore({ rememberPeople: vi.fn(async () => {}), _workspaceSelectionGeneration: 1 });
  openWorkspaceDb('mention-roster-metadata-refresh');
  await getWorkspaceDb().open();
  const request = store.refreshTowerPgWorkspaceMembers();
  store.currentWorkspace = { ...store.currentWorkspace, label: 'Refreshed workspace metadata' };
  finish({ members: [{ actor: { actor_id: 'roster-agent', npub: 'npub1roster-agent', kind: 'agent', display_name: 'Roster Agent' } }] });
  await request;
  expect(await getWorkspaceMembers('workspace-1')).toEqual(expect.arrayContaining([
    expect.objectContaining({ actor_id: 'roster-agent', display_name: 'Roster Agent' }),
  ]));
});

it('preserves cached agent metadata when a Tower roster response is sparse', async () => {
  const { openWorkspaceDb, getWorkspaceDb, getWorkspaceMembers, replaceWorkspaceMembers } = await import('../src/db.js');
  openWorkspaceDb('mention-roster-sparse-agent');
  await getWorkspaceDb().open();
  await replaceWorkspaceMembers('workspace-1', [{
    actor_id: 'agent-sparse',
    id: 'agent-sparse',
    workspace_id: 'workspace-1',
    npub: 'npub1agent-sparse',
    kind: 'agent',
    display_name: 'Cached Agent',
    picture: 'https://cached.example/agent.png',
  }]);
  getTowerPgWorkspaceMembers.mockResolvedValueOnce({
    members: [{ actor: { actor_id: 'agent-sparse', npub: 'npub1agent-sparse' } }],
  });
  const store = createPgGrantStore({ rememberPeople: vi.fn(async () => {}), chatProfiles: {}, addressBookPeople: [] });

  const members = await store.refreshTowerPgWorkspaceMembers();

  expect(members).toEqual(expect.arrayContaining([expect.objectContaining({
    actor_id: 'agent-sparse',
    kind: 'agent',
    display_name: 'Cached Agent',
    picture: 'https://cached.example/agent.png',
  })]));
  expect(await getWorkspaceMembers('workspace-1')).toEqual(expect.arrayContaining([expect.objectContaining({
    actor_id: 'agent-sparse',
    kind: 'agent',
    display_name: 'Cached Agent',
    picture: 'https://cached.example/agent.png',
  })]));
});


describe('PG channel lifecycle controls', () => {
  const channel = { record_id: 'channel-1', title: 'Original', scope_id: 'scope-a', pg_workspace_id: 'workspace-1', channel_type: 'channel', channel_grants: [] };
  function store(overrides = {}) {
    return createPgGrantStore({ canAdminWorkspace: true, channels: [{ ...channel }], channelSettingsChannelId: channel.record_id,
      channelSettingsWorkspaceId: 'workspace-1', channelSettingsName: '  Renamed  ', ...overrides });
  }

  it('renames with a trimmed signed PG command and persists the returned row', async () => {
    updateTowerPgChannel.mockResolvedValueOnce({ channel: { id: channel.record_id, name: 'Renamed', scope_id: 'scope-a', kind: 'channel' } });
    const state = store();
    await state.renameSettingsChannel();
    expect(updateTowerPgChannel).toHaveBeenCalledWith('workspace-1', 'channel-1', { name: 'Renamed' }, expect.any(Object));
    expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'channel-1', title: 'Renamed' }));
    expect(state.channels[0].title).toBe('Renamed');
    expect(state.channelSettingsNotice).toBe('Channel renamed.');
  });

  it('rejects empty names and server failures without claiming success', async () => {
    const state = store({ channelSettingsName: '   ' });
    await state.renameSettingsChannel();
    expect(updateTowerPgChannel).not.toHaveBeenCalled();
    expect(state.channelSettingsError).toContain('required');
    state.channelSettingsName = 'Renamed';
    updateTowerPgChannel.mockRejectedValueOnce(new Error('Duplicate name'));
    await state.renameSettingsChannel();
    expect(state.channelSettingsError).toBe('Duplicate name');
    expect(state.channelSettingsNotice).toBe('');
    expect(state.channels[0].title).toBe('Original');
    expect(upsertChannel).not.toHaveBeenCalled();
  });

  it('gates management separately from grant management and protects system/DM channels', () => {
    const state = store({ canAdminWorkspace: false });
    expect(state.canManageChannel(channel)).toBe(false);
    expect(state.canManageChannel({ ...channel, channel_grants: [{ principal_type: 'actor', principal_id: 'actor-manager', permissions: ['channel.manage'] }] })).toBe(true);
    state.canAdminWorkspace = true;
    expect(state.canManageChannel(channel)).toBe(true);
    expect(state.canManageChannel({ ...channel, channel_type: 'dm' })).toBe(false);
    expect(state.canManageChannel({ ...channel, channel_type: 'system' })).toBe(false);
  });

  it('uses hydrated group membership when the workspace group projection is still empty', () => {
    const state = store({ canAdminWorkspace: false, currentWorkspaceGroups: [],
      groups: [{ group_id: 'managers', member_npubs: ['npub1manager'] }] });
    const managed = { ...channel, channel_grants: [{ principal_type: 'group', principal_id: 'managers', permissions: ['channel.manage'] }] };
    expect(state.canManageChannel(managed)).toBe(true);
    state.groups = [{ group_id: 'managers', member_npubs: ['npub1someoneelse'] }];
    expect(state.canManageChannel(managed)).toBe(false);
  });

  it('blocks unauthorized writes and stale workspace settings', async () => {
    const state = store({ canAdminWorkspace: false });
    await state.renameSettingsChannel();
    expect(state.channelSettingsError).toContain('Manage access');
    state.canAdminWorkspace = true;
    state.channelSettingsWorkspaceId = 'different-workspace';
    await state.renameSettingsChannel();
    expect(state.channelSettingsError).toContain('workspace changed');
    expect(updateTowerPgChannel).not.toHaveBeenCalled();
  });

  it('closing settings discards drafts without writing and cancels deletion', () => {
    const state = store({ closeChannelScopePicker: vi.fn(), channelDeleteConfirmArmed: true });
    state.closeChannelSettings();
    expect(state.showChannelSettingsModal).toBe(false);
    expect(state.channelDeleteConfirmArmed).toBe(false);
    expect(updateTowerPgChannel).not.toHaveBeenCalled();
  });
});
