import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateTowerPgChannels,
  hydrateTowerPgChannelMessages,
  hydrateTowerPgThreadMessages,
  selectPgFallbackThreads,
  hydrateTowerPgChannelResponseActivities,
  hydrateTowerPgChannelAgentActivities,
  hydrateTowerPgAgentSessionHealth,
  hydrateTowerPgEventUpdates,
  hydrateTowerPgSyncBundle,
  hydrateTowerPgAudioNotes,
  hydrateTowerPgDoc,
  hydrateTowerPgDocComments,
  hydrateTowerPgDocumentsAndFiles,
  hydrateTowerPgResponseActivitiesForTarget,
  hydrateTowerPgScopes,
  hydrateTowerPgReactionTarget,
  hydrateTowerPgTask,
  hydrateTowerPgTasks,
  hydrateTowerPgTaskComments,
  hydrateTowerPgWorkroom,
  hydrateTowerPgWorkrooms,
  hydrateTowerPgWappActivity,
  hydrateTowerPgWappPublishingGrants,
  mapPgChannelToLocal,
  mapPgAudioNoteToLocal,
  mapPgDocToLocal,
  mapPgDocCommentToLocal,
  mapPgFileToLocalDocument,
  mapPgMessageToLocal,
  mapPgScopeToLocal,
  mapPgTaskToLocal,
  mapPgTaskCommentToLocal,
  mapPgWorkroomApprovalToLocal,
  mapPgWorkroomEventToLocal,
  mapPgWorkroomLinkToLocal,
  mapPgWorkroomParticipantToLocal,
  mapPgWorkroomToLocal,
  mapPgWappActivityItemToLocal,
  mapPgWappPublishingGrantToLocal,
  mergePgHydratedTasksWithLocal,
  mapPgThreadToLocal,
  resolveTowerPgWorkspaceContext,
  syncTowerPgWorkspace,
} from '../src/pg-read-hydrator.js';
import {
  deleteWorkspaceDb,
  getMessagesByChannel,
  getSyncState,
  getWappActivityProjection,
  openWorkspaceDb,
} from '../src/db.js';
import { recordFamilyHash } from '../src/translators/chat.js';
import { buildSyntheticLongDocumentFixture } from './fixtures/synthetic-long-document.js';

function store(seed = {}) {
  return {
    backendUrl: 'https://tower.example',
    workspaceOwnerNpub: 'npub1owner',
    session: { npub: 'npub1operator-a' },
    currentWorkspace: {
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      pgBackendMode: true,
      pgDescriptor: {
        links: {
          scopes: '/api/v4/flightdeck-pg/workspaces/workspace-1/scopes',
        },
      },
    },
    scopes: [],
    channels: [],
    applyScopes: vi.fn(async (scopes) => {
      seed.scopes = scopes;
    }),
    applyChannels: vi.fn(async (channels) => {
      seed.channels = channels;
    }),
    applyTasks: vi.fn(async (tasks) => {
      seed.tasks = tasks;
    }),
    applyDocuments: vi.fn((documents) => {
      seed.documents = documents;
    }),
    applyFileFolders: vi.fn((folders) => {
      seed.fileFolders = folders;
    }),
    applyAudioNotes: vi.fn(async (audioNotes) => {
      seed.audioNotes = audioNotes;
    }),
    refreshMessages: vi.fn(),
    ...seed,
  };
}

describe('PG fallback thread selection', () => {
  it('indexes a large message backlog once instead of rescanning it per thread', () => {
    let threadIdReads = 0;
    let parentIdReads = 0;
    const threadCount = 400;
    const messageRows = Array.from({ length: 4_000 }, (_, index) => ({
      get pg_thread_id() {
        threadIdReads += 1;
        return `thread-${index % threadCount}`;
      },
      get parent_message_id() {
        parentIdReads += 1;
        return `root-${index % threadCount}`;
      },
    }));
    const threads = Array.from({ length: threadCount }, (_, index) => ({
      id: `thread-${index}`,
      source_message_id: `root-${index}`,
      record_state: 'active',
    }));

    expect(selectPgFallbackThreads(threads, messageRows)).toHaveLength(threadCount);
    expect(threadIdReads).toBe(messageRows.length);
    expect(parentIdReads).toBe(messageRows.length);
  });
});

describe('Tower PG WApp publishing hydration', () => {
  it('keeps publisher identities distinct and flattens grouped destinations', () => {
    const grant = mapPgWappPublishingGrantToLocal({
      grant: {
        grant_id: 'grant-1',
        app_id: 'app-1',
        wapp_installation_id: 'installation-1',
        publisher_npub: 'npub1publisher',
        flightdeck_app_npub: 'npub1flightdeck',
        owner_npub: 'npub1owner',
        destinations: [{ scope_id: 'scope-1', channel_ids: ['channel-1', 'channel-2'] }],
        registered_open_origins: ['https://kindling.example'],
      },
    });

    expect(grant).toMatchObject({
      grant_id: 'grant-1',
      app_id: 'app-1',
      wapp_installation_id: 'installation-1',
      publisher_npub: 'npub1publisher',
      flightdeck_app_npub: 'npub1flightdeck',
      owner_npub: 'npub1owner',
    });
    expect(grant.destinations).toEqual([
      expect.objectContaining({ scope_id: 'scope-1', channel_id: 'channel-1' }),
      expect.objectContaining({ scope_id: 'scope-1', channel_id: 'channel-2' }),
    ]);
  });

  it('materializes every activity page authoritatively, counts, and per-user mutes', async () => {
    const replaceWappActivityItems = vi.fn(async () => {});
    const replaceWappActivityMutes = vi.fn(async () => {});
    const currentStore = store({
      applyWappActivityItems: vi.fn(),
      applyWappActivityCounts: vi.fn(),
      applyWappActivityMutes: vi.fn(),
    });
    const getTowerPgWappActivityItems = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 'item-1', title: '<script>unsafe</script>', unread: true, occurred_at: '2026-08-03T00:00:00.000Z' }], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [{ id: 'item-2', state: 'withdrawn', read_at: '2026-08-03T00:05:00.000Z' }] });
    const getTowerPgWappActivityCounts = vi.fn();

    const result = await hydrateTowerPgWappActivity(currentStore, {
      getTowerPgWappActivityItems,
      getTowerPgWappActivityCounts,
      getTowerPgWappActivityMutes: vi.fn(async () => ({ mutes: [{ target_type: 'category', target_value: 'lead' }] })),
      replaceWappActivityItems,
      replaceWappActivityMutes,
    });

    expect(getTowerPgWappActivityItems).toHaveBeenCalledTimes(2);
    expect(getTowerPgWappActivityItems.mock.calls[1][1]).toEqual(expect.objectContaining({ cursor: 'page-2' }));
    expect(getTowerPgWappActivityCounts).not.toHaveBeenCalled();
    expect(replaceWappActivityItems).toHaveBeenCalledWith([
      expect.objectContaining({ record_id: 'item-1', title: '<script>unsafe</script>', unread: true }),
      expect.objectContaining({ record_id: 'item-2', state: 'withdrawn', unread: false }),
    ], { authoritative: true });
    expect(replaceWappActivityMutes).toHaveBeenCalledWith([
      expect.objectContaining({ record_id: 'category:lead', target_type: 'category', target_value: 'lead' }),
    ]);
    expect(result.counts).toEqual({ unread: 1 });
  });

  it('keeps a server-dismissed item absent after destroying and recreating Feed state', async () => {
    const ownerNpub = 'npub_feed_refresh_persistence';
    await deleteWorkspaceDb(ownerNpub);
    await openWorkspaceDb(ownerNpub).open();
    const serverRows = [
      { id: 'item-1', title: 'First', unread: true, occurred_at: '2026-08-06T01:00:00.000Z' },
      { id: 'item-2', title: 'Second', unread: true, occurred_at: '2026-08-06T01:01:00.000Z' },
    ];
    const dismissedIds = new Set();
    const statefulApi = {
      list: vi.fn(async () => ({
        items: serverRows.filter((item) => !dismissedIds.has(item.id)),
        next_cursor: null,
      })),
      dismiss: vi.fn(async (itemId) => {
        dismissedIds.add(itemId);
        return { state: { dismissed_at: '2026-08-06T02:00:00.000Z', unread: true } };
      }),
    };
    const createFeedStore = () => store({
      workspaceOwnerNpub: ownerNpub,
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: ownerNpub,
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      },
    });
    const hydrate = (feedStore) => hydrateTowerPgWappActivity(feedStore, {
      getTowerPgWappActivityItems: statefulApi.list,
      getTowerPgWappActivityMutes: vi.fn(async () => ({ mutes: [] })),
    });

    await hydrate(createFeedStore());
    expect((await getWappActivityProjection()).counts.unread).toBe(2);

    const response = await statefulApi.dismiss('item-1');
    expect(response.state.dismissed_at).toBeTruthy();

    const recreatedStore = createFeedStore();
    await hydrate(recreatedStore);
    const afterReload = await getWappActivityProjection();
    expect(afterReload.items.map((item) => item.record_id)).toEqual(['item-2']);
    expect(afterReload.counts.unread).toBe(1);
    expect(statefulApi.list).toHaveBeenCalledTimes(2);

    await deleteWorkspaceDb(ownerNpub);
  });

  it('replaces the complete admin grant list so removed choices cannot remain stale', async () => {
    const replaceWappPublishingGrants = vi.fn(async () => {});
    const currentStore = store({ applyWappPublishingGrants: vi.fn() });
    const rows = await hydrateTowerPgWappPublishingGrants(currentStore, {
      getTowerPgWappPublishingGrants: vi.fn(async () => ({
        grants: [{ wapp_installation_id: 'installation-1', publisher_npub: 'npub1publisher', status: 'active' }],
      })),
      replaceWappPublishingGrants,
    });

    expect(rows).toEqual([expect.objectContaining({ wapp_installation_id: 'installation-1', status: 'active' })]);
    expect(replaceWappPublishingGrants).toHaveBeenCalledWith(rows);
    expect(currentStore.applyWappPublishingGrants).not.toHaveBeenCalled();
  });

  it('preserves plain activity text for x-text rendering rather than interpreting HTML', () => {
    const item = mapPgWappActivityItemToLocal({ id: 'item-1', title: '<b>Title</b>', summary: '<img src=x onerror=alert(1)>' });
    expect(item.title).toBe('<b>Title</b>');
    expect(item.summary).toBe('<img src=x onerror=alert(1)>');
    expect(item.grant_status).toBe('');
  });
});

describe('PG read hydrator', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it('resolves Tower PG workspace request context from the selected workspace', () => {
    expect(resolveTowerPgWorkspaceContext(store())).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      links: {
        scopes: '/api/v4/flightdeck-pg/workspaces/workspace-1/scopes',
      },
    });
  });

  it('prefers the selected PG workspace owner over the signed-in actor owner', () => {
    expect(resolveTowerPgWorkspaceContext(store({
      workspaceOwnerNpub: 'npub1signedinactor',
      currentWorkspace: {
        ...store().currentWorkspace,
        workspaceOwnerNpub: 'npub1pgworkspace',
      },
    }))).toMatchObject({
      workspaceOwnerNpub: 'npub1pgworkspace',
    });
  });

  it('normalizes saved http Tower URLs before PG API requests on hosted https Flight Deck', () => {
    globalThis.window = { location: { origin: 'https://app.example.invalid' } };

    expect(resolveTowerPgWorkspaceContext(store({
      backendUrl: 'https://tower.example.com',
      currentWorkspace: {
        ...store().currentWorkspace,
        directHttpsUrl: 'http://tower.example.com',
      },
    }))).toMatchObject({
      baseUrl: 'https://tower.example.com',
    });
  });

  it('maps PG scopes into existing local scope rows', () => {
    expect(mapPgScopeToLocal({
      id: 'scope-1',
      workspace_id: 'workspace-1',
      name: 'Wingman Suite',
      description: 'Suite work',
      kind: 'project',
      owner_group_id: 'group-admins',
      row_version: 7,
      created_at: '2026-06-05T01:00:00.000Z',
      updated_at: '2026-06-05T02:00:00.000Z',
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      record_id: 'scope-1',
      owner_npub: 'npub1owner',
      title: 'Wingman Suite',
      level: 'l1',
      group_ids: ['group-admins'],
      sync_status: 'synced',
      record_state: 'active',
      version: 7,
      pg_backend: true,
      pg_record_type: 'scope',
    });
  });

  it('preserves PG scope manage permission as tri-state rollout metadata', () => {
    expect(mapPgScopeToLocal({ id: 'scope-true', can_manage: true }).pg_can_manage).toBe(true);
    expect(mapPgScopeToLocal({ id: 'scope-false', can_manage: false }).pg_can_manage).toBe(false);
    expect(mapPgScopeToLocal({ id: 'scope-unknown' })).not.toHaveProperty('pg_can_manage');
  });

  it('maps PG workroom rows into local Dexie rows', () => {
    expect(mapPgWorkroomToLocal({
      id: 'room-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Release room',
      goal: 'Ship production',
      status: 'waiting_approval',
      integration_autopilot_npub: 'npub1auto',
      repo: { url: 'https://github.example/app' },
      branches: { integration: 'feature/x', production: 'main' },
      app_targets: { preview_url: 'https://preview.example' },
      approval_policy: { human_approver_npubs: ['npub1human'] },
      metadata: {
        announcement_message_id: 'message-1',
        announcement_thread_id: 'thread-1',
      },
      row_version: 4,
      created_at: '2026-07-16T01:00:00.000Z',
      updated_at: '2026-07-16T02:00:00.000Z',
    })).toMatchObject({
      record_id: 'room-1',
      workspace_id: 'workspace-1',
      channel_id: 'channel-1',
      status: 'waiting_approval',
      repo: { url: 'https://github.example/app' },
      announcement_message_id: 'message-1',
      announcement_thread_id: 'thread-1',
      announcement_channel_id: 'channel-1',
      row_version: 4,
      pg_record_type: 'workroom',
    });
    expect(mapPgWorkroomParticipantToLocal({
      id: 'participant-1',
      workroom_id: 'room-1',
      actor_npub: 'npub1human',
      role: 'human_approver',
    })).toMatchObject({ record_id: 'participant-1', workroom_id: 'room-1', role: 'human_approver' });
    expect(mapPgWorkroomEventToLocal({
      id: 'event-1',
      workroom_id: 'room-1',
      event_type: 'approval_requested',
      payload: { approval_id: 'approval-1' },
    })).toMatchObject({ record_id: 'event-1', event_type: 'approval_requested' });
    expect(mapPgWorkroomLinkToLocal({
      id: 'link-1',
      workroom_id: 'room-1',
      link_type: 'pull_request',
      external_url: 'https://github.example/pr/1',
    })).toMatchObject({ record_id: 'link-1', link_type: 'pull_request' });
    expect(mapPgWorkroomApprovalToLocal({
      id: 'approval-1',
      target_type: 'workroom',
      target_id: 'room-1',
      action: 'production_merge',
      status: 'requested',
    })).toMatchObject({ record_id: 'approval-1', target_id: 'room-1', status: 'requested' });
  });

  it('hydrates PG workroom lists into local stores and Alpine state', async () => {
    const target = store({
      workrooms: [{ record_id: 'old-room', channel_id: 'channel-1' }],
      applyWorkrooms: vi.fn(async (workrooms) => {
        target.workrooms = workrooms;
      }),
    });
    const getTowerPgWorkrooms = vi.fn(async () => ({
      workrooms: [{
        id: 'room-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Release room',
        status: 'active',
        updated_at: '2026-07-16T02:00:00.000Z',
      }],
    }));
    const replacePgWorkroomsForChannel = vi.fn(async () => 1);

    const rows = await hydrateTowerPgWorkrooms(target, {
      channelId: 'channel-1',
      getTowerPgWorkrooms,
      replacePgWorkroomsForChannel,
    });

    expect(rows).toEqual([expect.objectContaining({ record_id: 'room-1', channel_id: 'channel-1' })]);
    expect(getTowerPgWorkrooms).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      channelId: 'channel-1',
      limit: 100,
    }));
    expect(replacePgWorkroomsForChannel).toHaveBeenCalledWith('channel-1', [
      expect.objectContaining({ record_id: 'room-1' }),
    ]);
    expect(target.applyWorkrooms).not.toHaveBeenCalled();
  });

  it('hydrates a PG workroom detail with participants, events, links, and approvals', async () => {
    const target = store({
      workrooms: [],
      applyWorkrooms: vi.fn(async (workrooms) => {
        target.workrooms = workrooms;
      }),
      applyWorkroomParticipants: vi.fn(),
      applyWorkroomEvents: vi.fn(),
      applyWorkroomLinks: vi.fn(),
      applyWorkroomApprovals: vi.fn(),
    });
    const getTowerPgWorkroom = vi.fn(async () => ({
      workroom: {
        id: 'room-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Release room',
        status: 'active',
      },
      participants: [{ id: 'participant-1', workroom_id: 'room-1', actor_npub: 'npub1human' }],
      events: [{ id: 'event-1', workroom_id: 'room-1', event_type: 'started' }],
      links: [{ id: 'link-1', workroom_id: 'room-1', link_type: 'pull_request' }],
    }));
    const getTowerPgApprovals = vi.fn(async () => ({
      approvals: [{
        id: 'approval-1',
        target_type: 'workroom',
        target_id: 'room-1',
        action: 'production_merge',
        status: 'requested',
      }],
    }));
    const upsertWorkroom = vi.fn(async () => 'room-1');
    const replaceWorkroomParticipantsForRoom = vi.fn(async () => 1);
    const replaceWorkroomEventsForRoom = vi.fn(async () => 1);
    const replaceWorkroomLinksForRoom = vi.fn(async () => 1);
    const replaceWorkroomApprovalsForRoom = vi.fn(async () => 1);

    const row = await hydrateTowerPgWorkroom(target, 'room-1', {
      getTowerPgWorkroom,
      getTowerPgApprovals,
      upsertWorkroom,
      replaceWorkroomParticipantsForRoom,
      replaceWorkroomEventsForRoom,
      replaceWorkroomLinksForRoom,
      replaceWorkroomApprovalsForRoom,
    });

    expect(row).toMatchObject({ record_id: 'room-1', title: 'Release room' });
    expect(upsertWorkroom).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'room-1' }));
    expect(replaceWorkroomParticipantsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'participant-1' })]);
    expect(replaceWorkroomEventsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'event-1' })]);
    expect(replaceWorkroomLinksForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'link-1' })]);
    expect(replaceWorkroomApprovalsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'approval-1' })]);
    expect(target.applyWorkrooms).not.toHaveBeenCalled();
    expect(target.applyWorkroomApprovals).not.toHaveBeenCalled();
  });

  it('maps PG channels into existing local channel rows scoped to L1', () => {
    expect(mapPgChannelToLocal({
      id: 'channel-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      name: 'Flight Deck PG',
      kind: 'chat',
      position: 2,
      metadata: { basePrompt: 'Channel context' },
      participant_npubs: ['npub1alice', 'npub1bob', 'npub1alice'],
      group_ids: ['group-1', 'group-1'],
      row_version: 3,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      record_id: 'channel-1',
      owner_npub: 'npub1owner',
      title: 'Flight Deck PG',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      position: 2,
      metadata: { basePrompt: 'Channel context' },
      participant_npubs: ['npub1alice', 'npub1bob'],
      group_ids: ['group-1'],
      sync_status: 'synced',
      pg_backend: true,
      pg_record_type: 'channel',
    });
  });

  it('maps PG threads into fallback top-level chat rows', () => {
    expect(mapPgThreadToLocal({
      id: 'thread-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      source_message_id: 'message-1',
      title: 'Specific feature',
      latest: 'Latest reply',
      row_version: 5,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, { workspaceOwnerNpub: 'npub1owner', senderNpub: 'npub1operator-a' })).toMatchObject({
      record_id: 'thread-1',
      channel_id: 'channel-1',
      parent_message_id: null,
      body: 'Specific feature',
      sender_npub: 'npub1operator-a',
      sync_status: 'synced',
      pg_backend: true,
      pg_record_type: 'thread',
      pg_source_message_id: 'message-1',
    });
  });

  it('maps PG messages into classic chat rows with source-message thread parents', () => {
    const threadById = new Map([
      ['thread-1', { id: 'thread-1', source_message_id: 'message-1' }],
    ]);
    expect(mapPgMessageToLocal({
      id: 'message-2',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      body: 'Reply body',
      row_version: 2,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      threadById,
    })).toMatchObject({
      record_id: 'message-2',
      channel_id: 'channel-1',
      parent_message_id: 'message-1',
      body: 'Reply body',
      sender_npub: 'npub1operator-a',
      pg_backend: true,
      pg_record_type: 'message',
      pg_thread_id: 'thread-1',
    });
  });

  it('pages and materializes an effective branch transcript through the sync read path', async () => {
    const persisted = [];
    const calls = [];
    const rows = await hydrateTowerPgThreadMessages(store(), 'channel-1', 'child-thread', {
      getTowerPgChannelThreads: async () => ({ threads: [{
        id: 'child-thread', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        source_message_id: null, parent_thread_id: 'parent-thread', branch_point_message_id: 'm2',
        metadata: { inherited_agent_recipient_npub: 'npub1agent' }, row_version: 1,
      }, { id: 'parent-thread', source_message_id: 'm1', channel_id: 'channel-1' }] }),
      getTowerPgChannelMessages: async (_workspaceId, _channelId, options) => {
        calls.push(options);
        return options.cursor
          ? { messages: [{ id: 'm3', channel_id: 'channel-1', thread_id: 'child-thread', owning_thread_id: 'child-thread', effective_thread_id: 'child-thread', body: 'new', row_version: 1 }], next_cursor: null }
          : { messages: [{ id: 'm1', channel_id: 'channel-1', thread_id: 'parent-thread', owning_thread_id: 'parent-thread', effective_thread_id: 'child-thread', inherited: true, read_only: true, body: 'history', row_version: 1 }], next_cursor: 'page-2' };
      },
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      upsertMessage: async (row) => persisted.push(row),
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((options) => options.effectiveTranscript === true)).toBe(true);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: 'm1', pg_inherited: true, read_only: true }),
      expect.objectContaining({ record_id: 'm3', parent_message_id: 'child-thread' }),
    ]));
    expect(persisted.at(-1)).toMatchObject({
      record_id: 'child-thread', pg_parent_thread_id: 'parent-thread', pg_branch_point_message_id: 'm2',
      pg_effective_message_ids: ['m1', 'm3'],
    });
  });

  it('clamps branch hydration to the selected parent message while keeping child replies', async () => {
    const persisted = [];
    await hydrateTowerPgThreadMessages(store(), 'channel-1', 'child-thread', {
      getTowerPgChannelThreads: async () => ({ threads: [{
        id: 'child-thread', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        source_message_id: null, parent_thread_id: 'parent-thread', branch_point_message_id: 'm2',
        row_version: 1,
      }, { id: 'parent-thread', source_message_id: 'm1', channel_id: 'channel-1' }] }),
      getTowerPgChannelMessages: async () => ({
        messages: [
          { id: 'm1', channel_id: 'channel-1', thread_id: 'parent-thread', owning_thread_id: 'parent-thread', effective_thread_id: 'child-thread', inherited: true, read_only: true, body: 'before', row_version: 1 },
          { id: 'm2', channel_id: 'channel-1', thread_id: 'parent-thread', owning_thread_id: 'parent-thread', effective_thread_id: 'child-thread', inherited: true, read_only: true, body: 'branch point', row_version: 1 },
          { id: 'm3', channel_id: 'channel-1', thread_id: 'parent-thread', owning_thread_id: 'parent-thread', effective_thread_id: 'child-thread', inherited: true, read_only: true, body: 'too late', row_version: 1 },
          { id: 'child-1', channel_id: 'channel-1', thread_id: 'child-thread', owning_thread_id: 'child-thread', effective_thread_id: 'child-thread', body: 'child reply', row_version: 1 },
        ],
        next_cursor: null,
      }),
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      upsertMessage: async (row) => persisted.push(row),
    });

    expect(persisted.at(-1)).toMatchObject({
      record_id: 'child-thread',
      pg_effective_message_ids: ['m1', 'm2', 'child-1'],
    });
  });

  it('preserves deleted PG message state during local mapping', () => {
    expect(mapPgMessageToLocal({
      id: 'message-deleted',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      body: 'Deleted message',
      record_state: 'deleted',
      deleted_at: '2026-06-22T01:00:00.000Z',
      row_version: 3,
      updated_at: '2026-06-22T01:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      threadById: new Map(),
    })).toMatchObject({
      record_id: 'message-deleted',
      record_state: 'deleted',
      sync_status: 'synced',
      version: 3,
      pg_backend: true,
    });
  });

  it('maps archived PG thread state onto the source message only', () => {
    const threadById = new Map([
      ['thread-1', {
        id: 'thread-1',
        source_message_id: 'message-1',
        record_state: 'archived',
        archived_at: '2026-06-20T05:00:00.000Z',
      }],
    ]);

    expect(mapPgMessageToLocal({
      id: 'message-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      body: 'Thread one',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      threadById,
    })).toMatchObject({
      record_id: 'message-1',
      parent_message_id: null,
      record_state: 'archived',
      pg_archived_at: '2026-06-20T05:00:00.000Z',
    });

    expect(mapPgMessageToLocal({
      id: 'message-2',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      body: 'Reply one',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      threadById,
    })).toMatchObject({
      record_id: 'message-2',
      parent_message_id: 'message-1',
      record_state: 'active',
      pg_archived_at: null,
    });
  });

  it('maps PG messages using metadata sender override', () => {
    expect(mapPgMessageToLocal({
      id: 'message-3',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      body: 'Reply body',
      updated_at: '2026-06-05T02:00:00.000Z',
      metadata: {
        sender_npub: 'npub1dave',
        client_record_id: 'local-message-3',
      },
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      threadById: new Map(),
    })).toMatchObject({
      record_id: 'message-3',
      sender_npub: 'npub1dave',
      pg_client_record_id: 'local-message-3',
      pg_metadata: {
        sender_npub: 'npub1dave',
        client_record_id: 'local-message-3',
      },
      pg_record_type: 'message',
    });
  });

  it('preserves Tower agent author identity, canonical mentions, provenance, and attachments', () => {
    expect(mapPgMessageToLocal({
      id: 'message-agent',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      body: 'Agent reply',
      created_by_actor_id: 'actor-testagent',
      created_by_actor_npub: 'npub1testagent',
      created_by_actor_label: 'Test Agent',
      mentions: [{ type: 'agent', actor_id: 'actor-testagent', npub: 'npub1testagent', label: 'Test Agent' }],
      attachments: [{ id: 'attachment-1', kind: 'file' }],
      metadata: { source: 'autopilot_session', session_id: 'session-1', turn_id: 'turn-1' },
    }, { threadById: new Map() })).toMatchObject({
      sender_npub: 'npub1testagent',
      attachments: [{ id: 'attachment-1', kind: 'file' }],
      pg_created_by_actor_id: 'actor-testagent',
      pg_created_by_actor_npub: 'npub1testagent',
      pg_created_by_actor_label: 'Test Agent',
      pg_metadata: {
        source: 'autopilot_session',
        session_id: 'session-1',
        turn_id: 'turn-1',
        mentions: [{ type: 'agent', actor_id: 'actor-testagent', npub: 'npub1testagent', label: 'Test Agent' }],
      },
    });
  });

  it('hydrates durable chat attachments from PG metadata after reload', () => {
    const attachment = {
      kind: 'image',
      storage_object_id: 'storage-photo-1',
      filename: 'camera-roll.jpg',
      content_type: 'image/jpeg',
      size_bytes: 2048,
    };
    const row = mapPgMessageToLocal({
      id: 'message-with-file',
      channel_id: 'channel-1',
      body: '',
      attachments: [],
      metadata: { attachments: [attachment] },
    });

    expect(row.attachments).toEqual([attachment]);
    expect(row.pg_metadata.attachments).toEqual([attachment]);
  });

  it('maps PG tasks into classic task rows with scope and PG channel/thread refs', () => {
    expect(mapPgTaskToLocal({
      id: 'task-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      title: 'Wire task API',
      description: 'Implement task writes',
      state: 'in_progress',
      priority: 'stone',
      metadata: {
        tags: 'pg,migration',
        board_order: 4,
        parent_task_id: 'task-parent',
        scheduled_for: '2026-06-22',
        assigned_to_npub: 'npub1stale',
        predecessor_task_ids: ['task-prev'],
        flow_id: 'flow-1',
        source_links: [{ type: 'message', id: 'msg-1' }],
      },
      assignments: [{ actor_id: 'actor-agent', actor_npub: 'npub1agent' }],
      created_by_actor_id: 'actor-creator',
      updated_by_actor_id: 'actor-updater',
      row_version: 6,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      actorNpubByActorId: new Map([
        ['actor-creator', 'npub1creator'],
        ['actor-updater', 'npub1updater'],
      ]),
    })).toMatchObject({
      record_id: 'task-1',
      owner_npub: 'npub1owner',
      title: 'Wire task API',
      state: 'in_progress',
      priority: 'stone',
      board_order: 4,
      parent_task_id: 'task-parent',
      tags: 'pg,migration',
      scheduled_for: '2026-06-22',
      assigned_to_npubs: ['npub1stale'],
      assigned_to_npub: 'npub1stale',
      predecessor_task_ids: ['task-prev'],
      flow_id: 'flow-1',
      source_links: [{ type: 'message', id: 'msg-1' }],
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      pg_created_by_actor_id: 'actor-creator',
      pg_updated_by_actor_id: 'actor-updater',
      pg_created_by_actor_npub: 'npub1creator',
      pg_updated_by_actor_npub: 'npub1updater',
      pg_backend: true,
      pg_record_type: 'task',
      pg_metadata: expect.objectContaining({ scheduled_for: '2026-06-22' }),
    });
  });

  it('preserves an already-blocked task returned by Tower PG', () => {
    expect(mapPgTaskToLocal({
      id: 'task-blocked',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Waiting on access',
      state: 'blocked',
      row_version: 4,
      updated_at: '2026-08-31T01:00:00.000Z',
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      record_id: 'task-blocked',
      state: 'blocked',
      version: 4,
      pg_backend: true,
    });
  });

  it('prefers the persisted PG task metadata assignee npub over relation rows', () => {
    expect(mapPgTaskToLocal({
      id: 'task-assigned',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Assigned from Tower',
      metadata: {
        assigned_to_npub: 'npub1stored',
      },
      assignments: [{
        actor_id: 'actor-agent',
        actor_npub: 'npub1agent',
      }],
      row_version: 2,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
    })).toMatchObject({
      record_id: 'task-assigned',
      assigned_to_npubs: ['npub1stored'],
      assigned_to_npub: 'npub1stored',
    });
  });

  it('maps PG task assignments from nested actor and direct assignee npub shapes', () => {
    expect(mapPgTaskToLocal({
      id: 'task-assigned-shapes',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Assigned from Tower shapes',
      assignments: [
        { actor: { id: 'actor-agent', npub: 'npub1agent' } },
        { assignee_npub: 'npub1other' },
        { member: { actor_id: 'actor-agent', npub: 'npub1agent' } },
      ],
      row_version: 2,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
    })).toMatchObject({
      record_id: 'task-assigned-shapes',
      assigned_to_npubs: ['npub1agent', 'npub1other'],
      assigned_to_npub: 'npub1agent',
    });
  });

  it('maps PG task assignments from actor ids when workspace member npubs are available', () => {
    expect(mapPgTaskToLocal({
      id: 'task-assigned-by-actor-id',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Assigned by actor id',
      assignments: [
        { actor_id: 'actor-agent' },
        { assignee: { id: 'actor-other' } },
      ],
      row_version: 2,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      actorNpubByActorId: new Map([
        ['actor-agent', 'npub1agent'],
        ['actor-other', 'npub1other'],
      ]),
    })).toMatchObject({
      record_id: 'task-assigned-by-actor-id',
      assigned_to_npubs: ['npub1agent', 'npub1other'],
      assigned_to_npub: 'npub1agent',
    });
  });

  it('maps PG task metadata assignment even when relation rows omit actor npubs', () => {
    expect(mapPgTaskToLocal({
      id: 'task-missing-assignee-npub',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Missing assignment identity',
      metadata: {
        assigned_to_npub: 'npub1stored',
      },
      assignments: [{
        actor_id: 'actor-agent',
      }],
      row_version: 2,
      updated_at: '2026-06-05T02:00:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
    })).toMatchObject({
      record_id: 'task-missing-assignee-npub',
      assigned_to_npubs: ['npub1stored'],
      assigned_to_npub: 'npub1stored',
    });
  });

  it('maps PG task comments into classic comment rows', () => {
    expect(mapPgTaskCommentToLocal({
      id: 'comment-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      task_id: 'task-1',
      thread_id: 'thread-1',
      body: 'Comment body',
      created_by_actor_id: 'actor-commenter',
      updated_by_actor_id: 'actor-commenter',
      row_version: 2,
      created_at: '2026-06-06T01:00:00.000Z',
      updated_at: '2026-06-06T01:01:00.000Z',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1operator-a',
      actorNpubByActorId: new Map([['actor-commenter', 'npub1operator-a']]),
    })).toMatchObject({
      record_id: 'comment-1',
      owner_npub: 'npub1owner',
      target_record_id: 'task-1',
      target_record_family_hash: expect.stringContaining(':task'),
      parent_comment_id: null,
      body: 'Comment body',
      sender_npub: 'npub1operator-a',
      sync_status: 'synced',
      version: 2,
      pg_backend: true,
      pg_record_type: 'task_comment',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      pg_created_by_actor_id: 'actor-commenter',
      pg_updated_by_actor_id: 'actor-commenter',
      pg_created_by_actor_npub: 'npub1operator-a',
      pg_updated_by_actor_npub: 'npub1operator-a',
    });
  });

  it('maps PG task comments using actor-to-npub resolution', () => {
    expect(mapPgTaskCommentToLocal({
      id: 'comment-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      task_id: 'task-1',
      thread_id: 'thread-1',
      body: 'Comment body',
      created_by_actor_id: 'actor-1',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1viewer',
      actorNpubByActorId: new Map([['actor-1', 'npub1alice']]),
    })).toMatchObject({
      record_id: 'comment-1',
      sender_npub: 'npub1alice',
      pg_created_by_actor_npub: 'npub1alice',
      pg_record_type: 'task_comment',
    });
  });

  it('maps PG doc comments into anchored classic comment rows', () => {
    expect(mapPgDocCommentToLocal({
      id: 'doc-comment-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      doc_id: 'doc-1',
      parent_comment_id: 'root-1',
      body: 'Doc comment',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 7,
          anchor_end_line_number: 8,
          anchor_quote: 'Selected\ntext',
          anchor_start_offset: 14,
          anchor_end_offset: 29,
          comment_status: 'open',
          client_record_id: 'local-comment-1',
        },
      created_by_actor_id: 'actor-1',
      row_version: 2,
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1viewer',
      actorNpubByActorId: new Map([['actor-1', 'npub1alice']]),
    })).toMatchObject({
      record_id: 'doc-comment-1',
      owner_npub: 'npub1owner',
      target_record_id: 'doc-1',
      target_record_family_hash: expect.stringContaining(':document'),
      parent_comment_id: 'root-1',
      anchor_block_id: 'block-1',
      anchor_line_number: 7,
      anchor_end_line_number: 8,
      anchor_quote: 'Selected\ntext',
      anchor_start_offset: 14,
      anchor_end_offset: 29,
      comment_status: 'open',
      sender_npub: 'npub1alice',
      sync_status: 'synced',
      version: 2,
      pg_backend: true,
      pg_record_type: 'doc_comment',
      pg_channel_id: 'channel-1',
      pg_client_record_id: 'local-comment-1',
    });
  });

  it('keeps PG document comments general when anchor metadata is absent', () => {
    expect(mapPgDocCommentToLocal({
      id: 'doc-comment-general',
      workspace_id: 'workspace-1',
      channel_id: 'channel-1',
      doc_id: 'doc-1',
      body: 'General comment',
      metadata: { comment_status: 'open' },
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      anchor_block_id: null,
      anchor_line_number: null,
      anchor_quote: '',
    });
  });

  it('maps PG docs and files into classic document rows for docs/files views', () => {
    expect(mapPgDocToLocal({
      id: 'doc-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      metadata: { thread_id: 'thread-1' },
      storage_object_id: 'object-doc',
      title: 'Design note',
      summary: 'Doc summary',
      body: { object_id: 'object-doc', route: '/body' },
      row_version: 3,
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      record_id: 'doc-1',
      owner_npub: 'npub1owner',
      title: 'Design note',
      content: 'Doc summary',
      content_storage_object_id: 'object-doc',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      pg_record_type: 'doc',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    });

    expect(mapPgFileToLocalDocument({
      id: 'file-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      metadata: { thread_id: 'thread-1' },
      storage_object_id: 'object-file',
      display_name: 'Brief.pdf',
      row_version: 4,
    }, { workspaceOwnerNpub: 'npub1owner' })).toMatchObject({
      record_id: 'file-1',
      owner_npub: 'npub1owner',
      title: 'Brief.pdf',
      content: '[Brief.pdf](storage://object-file)',
      content_storage_object_id: null,
      scope_id: 'scope-1',
      pg_record_type: 'file',
      pg_thread_id: 'thread-1',
      pg_storage_object_id: 'object-file',
    });
  });

  it('maps PG audio notes into classic audio note rows', () => {
    expect(mapPgAudioNoteToLocal({
      id: 'audio-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      target_type: 'message',
      target_id: 'message-1',
      storage_object_id: 'object-audio',
      title: 'Voice note',
      mime_type: 'audio/webm',
      transcript_status: 'complete',
      transcript_preview: 'Hello',
      row_version: 2,
    }, { workspaceOwnerNpub: 'npub1owner', senderNpub: 'npub1operator-a' })).toMatchObject({
      record_id: 'audio-1',
      owner_npub: 'npub1owner',
      target_record_id: 'message-1',
      title: 'Voice note',
      storage_object_id: 'object-audio',
      sender_npub: 'npub1operator-a',
      transcript_status: 'complete',
      pg_record_type: 'audio_note',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    });
  });

  it('maps PG audio notes using actor-to-npub resolution', () => {
    expect(mapPgAudioNoteToLocal({
      id: 'audio-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      thread_id: 'thread-1',
      target_type: 'message',
      target_id: 'message-1',
      storage_object_id: 'object-audio',
      title: 'Voice note',
      mime_type: 'audio/webm',
      created_by_actor_id: 'actor-1',
    }, {
      workspaceOwnerNpub: 'npub1owner',
      senderNpub: 'npub1viewer',
      actorNpubByActorId: new Map([['actor-1', 'npub1alice']]),
    })).toMatchObject({
      record_id: 'audio-1',
      sender_npub: 'npub1alice',
      pg_record_type: 'audio_note',
    });
  });

  it('hydrates PG scopes through Tower API without replacing cached scope rows', async () => {
    const target = store();
    const getTowerPgWorkspaceScopes = vi.fn(async () => ({
      scopes: [{ id: 'scope-1', name: 'Wingman Suite', row_version: 1 }],
    }));
    const upsertPgListedScope = vi.fn(async () => 1);

    const rows = await hydrateTowerPgScopes(target, {
      getTowerPgWorkspaceScopes,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      upsertPgListedScope,
    });

    expect(getTowerPgWorkspaceScopes).toHaveBeenCalledWith('workspace-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      path: '/api/v4/flightdeck-pg/workspaces/workspace-1/scopes',
    });
    expect(upsertPgListedScope).toHaveBeenCalledWith(rows[0]);
    expect(target.applyScopes).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ record_id: 'scope-1', title: 'Wingman Suite' });
  });

  it('hydrates accessible PG channel metadata without fetching every channel history', async () => {
    const target = store({
      scopes: [{ record_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
    });
    const getTowerPgScopeChannels = vi.fn(async () => ({
      channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Flight Deck PG' }],
    }));
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [{
        id: 'thread-1',
        channel_id: 'channel-1',
        source_message_id: 'message-1',
        title: 'Thread one',
        record_state: 'archived',
        archived_at: '2026-06-20T05:00:00.000Z',
      }],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [
        { id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Thread one' },
        { id: 'message-2', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Reply one' },
      ],
    }));
    const upsertPgListedChannel = vi.fn(async () => 1);
    const replacePgMessagesForChannel = vi.fn(async () => 2);

    const rows = await hydrateTowerPgChannels(target, {
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async (callback) => callback(),
      getTowerPgWorkspaceScopes: async () => ({ scopes: [{ id: 'scope-1' }] }),
      getTowerPgScopeChannels,
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      upsertPgListedChannel,
      replacePgMessagesForChannel,
    });

    expect(getTowerPgScopeChannels).toHaveBeenCalledWith('workspace-1', 'scope-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(upsertPgListedChannel).toHaveBeenCalledWith(rows[0]);
    expect(target.applyChannels).not.toHaveBeenCalled();
    expect(getTowerPgChannelThreads).not.toHaveBeenCalled();
    expect(getTowerPgChannelMessages).not.toHaveBeenCalled();
    expect(replacePgMessagesForChannel).not.toHaveBeenCalled();
    expect(target.refreshMessages).not.toHaveBeenCalled();
  });

  it('hydrates a requested PG channel with actor-based message sender attribution', async () => {
    const target = store({
      scopes: [{ record_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
      pgWorkspaceMembers: [
        { actor_id: 'actor-1', npub: 'npub1alice' },
        { actor_id: 'actor-2', npub: 'npub1bob' },
      ],
    });
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [{ id: 'thread-1', channel_id: 'channel-1', source_message_id: '', title: 'Thread one', created_by_actor_id: 'actor-2' }],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [{ id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Thread one', created_by_actor_id: 'actor-1' }],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 2);
    const getTowerPgResponseActivities = vi.fn(async () => ({ response_activities: [] }));
    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 0);

    await hydrateTowerPgChannelMessages(target, 'channel-1', {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgResponseActivities,
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgResponseActivitiesForChannel,
    });

    const mapped = replacePgMessagesForChannel.mock.calls[0][1];
    expect(mapped).toEqual([
      expect.objectContaining({ record_id: 'message-1', sender_npub: 'npub1alice' }),
      expect.objectContaining({ record_id: 'thread-1', sender_npub: 'npub1bob' }),
    ]);
  });

  it('hydrates only the requested PG channel messages', async () => {
    const target = store({
      selectedChannelId: 'channel-1',
      pgWorkspaceMembers: [{ actor_id: 'actor-1', npub: 'npub1alice' }],
    });
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [{ id: 'thread-1', channel_id: 'channel-1', source_message_id: '', title: 'Thread one', created_by_actor_id: 'actor-1' }],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [{ id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Thread one', created_by_actor_id: 'actor-1' }],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 2);
    const getTowerPgResponseActivities = vi.fn(async () => ({ response_activities: [] }));
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 0);
    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);

    const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgResponseActivities,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgResponseActivitiesForChannel,
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
    });

    expect(getTowerPgChannelThreads).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      includeArchived: true,
    });
    expect(getTowerPgChannelMessages).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      limit: 21,
    });
    expect(replacePgMessagesForChannel).toHaveBeenCalledWith('channel-1', rows);
    expect(target.refreshMessages).not.toHaveBeenCalled();
  });

  it('keeps a real message when a blank-source fallback thread shares its canonical id', async () => {
    const workspaceDbKey = 'pg-read-hydrator-same-id-fallback';
    openWorkspaceDb(workspaceDbKey);
    const target = store({ selectedChannelId: 'channel-1' });

    try {
      const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
        getTowerPgChannelThreads: vi.fn(async () => ({
          threads: [{
            id: 'same-id',
            channel_id: 'channel-1',
            source_message_id: '',
            title: '',
            latest: '',
          }],
        })),
        getTowerPgChannelMessages: vi.fn(async () => ({
          messages: [{
            id: 'same-id',
            channel_id: 'channel-1',
            thread_id: 'same-id',
            body: 'The real root message body',
          }],
        })),
        getTowerPgResponseActivities: vi.fn(async () => ({ response_activities: [] })),
        getTowerPgAgentActivities: vi.fn(async () => ({ agent_activities: [] })),
      });

      const stored = await getMessagesByChannel('channel-1');
      expect(rows).toHaveLength(1);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        record_id: 'same-id',
        pg_record_type: 'message',
        body: 'The real root message body',
      });
      expect(stored).not.toContainEqual(expect.objectContaining({
        record_id: 'same-id',
        pg_record_type: 'thread',
        body: 'Untitled thread',
      }));
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('materialises a root for a populated thread whose declared source row is unavailable', async () => {
    const workspaceDbKey = 'pg-read-hydrator-missing-source-fallback';
    openWorkspaceDb(workspaceDbKey);
    const target = store({ selectedChannelId: 'channel-1' });

    try {
      const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
        getTowerPgChannelThreads: vi.fn(async () => ({
          threads: [{
            id: 'thread-1',
            channel_id: 'channel-1',
            source_message_id: 'missing-source-message',
            title: 'Legacy populated thread',
            latest: 'Only the reply row remains',
            record_state: 'active',
          }],
        })),
        getTowerPgChannelMessages: vi.fn(async () => ({
          messages: [{
            id: 'reply-1',
            channel_id: 'channel-1',
            thread_id: 'thread-1',
            body: 'Only the reply row remains',
          }],
        })),
        getTowerPgResponseActivities: vi.fn(async () => ({ response_activities: [] })),
        getTowerPgAgentActivities: vi.fn(async () => ({ agent_activities: [] })),
      });

      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          record_id: 'thread-1',
          pg_record_type: 'thread',
          pg_thread_id: 'thread-1',
          parent_message_id: null,
          title: 'Legacy populated thread',
        }),
        expect.objectContaining({
          record_id: 'reply-1',
          pg_record_type: 'message',
          pg_thread_id: 'thread-1',
          parent_message_id: 'thread-1',
        }),
      ]));
      expect(rows.filter((row) => !row.parent_message_id)).toHaveLength(1);
      expect(rows.filter((row) => row.parent_message_id === 'thread-1')).toHaveLength(1);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('hydrates only the newest PG message page when older history has another cursor', async () => {
    const target = store({ selectedChannelId: 'channel-1' });
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [{
        id: 'thread-1',
        channel_id: 'channel-1',
        source_message_id: 'message-root',
        title: 'Busy thread',
      }],
    }));
    const getTowerPgChannelMessages = vi.fn(async (_workspaceId, _channelId, options) => options.cursor
      ? {
          messages: [{
            id: 'message-reply',
            channel_id: 'channel-1',
            thread_id: 'thread-1',
            thread_source_message_id: 'message-root',
            body: 'Reply after the first 200 messages',
          }],
          next_cursor: null,
        }
      : {
          messages: [{
            id: 'message-root',
            channel_id: 'channel-1',
            thread_id: 'thread-1',
            thread_source_message_id: 'message-root',
            body: 'Busy thread',
          }],
          next_cursor: 'page-2',
        });
    const replacePgMessagesForChannel = vi.fn(async () => 2);

    const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgResponseActivities: vi.fn(async () => {
        throw new Error('NIP-98 signing timed out');
      }),
      getTowerPgAgentActivities: vi.fn(async () => ({ agent_activities: [] })),
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgResponseActivitiesForChannel: vi.fn(async () => 0),
      replacePgAgentActivitiesForChannel: vi.fn(async () => 0),
    });

    expect(getTowerPgChannelMessages).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      expect.objectContaining({ record_id: 'message-root', parent_message_id: null }),
    ]);
    expect(replacePgMessagesForChannel).toHaveBeenCalledWith('channel-1', rows);
  });

  it('hydrates deleted PG messages as tombstones so they do not reappear', async () => {
    const target = store({
      selectedChannelId: 'channel-1',
    });
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [{
        id: 'message-deleted',
        channel_id: 'channel-1',
        body: 'Deleted message',
        record_state: 'deleted',
        deleted_at: '2026-06-22T01:00:00.000Z',
        row_version: 4,
      }],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 1);
    const getTowerPgResponseActivities = vi.fn(async () => ({ response_activities: [] }));
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 0);
    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);

    const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgResponseActivities,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgResponseActivitiesForChannel,
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        record_id: 'message-deleted',
        record_state: 'deleted',
        version: 4,
      }),
    ]);
    expect(replacePgMessagesForChannel).toHaveBeenCalledWith('channel-1', rows);
  });

  it('does not recreate a missing source message from a PG thread fallback row', async () => {
    const target = store({
      selectedChannelId: 'channel-1',
    });
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [{
        id: 'thread-1',
        channel_id: 'channel-1',
        source_message_id: 'message-deleted',
        title: 'Deleted message',
        record_state: 'active',
      }],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 0);
    const getTowerPgResponseActivities = vi.fn(async () => ({ response_activities: [] }));
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 0);
    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);

    const rows = await hydrateTowerPgChannelMessages(target, 'channel-1', {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgResponseActivities,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgResponseActivitiesForChannel,
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
    });

    expect(rows).toEqual([]);
    expect(replacePgMessagesForChannel).toHaveBeenCalledWith('channel-1', []);
  });

  it('hydrates changed PG channels from event payloads in parallel', async () => {
    const target = store({ selectedChannelId: 'channel-1' });
    const getTowerPgChannelThreads = vi.fn(async (_workspaceId, channelId) => ({
      threads: [{ id: `thread-${channelId}`, channel_id: channelId, source_message_id: '', title: 'Thread' }],
    }));
    const getTowerPgChannelMessages = vi.fn(async (_workspaceId, channelId) => ({
      messages: [{ id: `message-${channelId}`, channel_id: channelId, thread_id: `thread-${channelId}`, body: 'Body' }],
    }));
    const getTowerPgChannelTasks = vi.fn(async (_workspaceId, channelId) => ({
      tasks: [{ id: `task-${channelId}`, channel_id: channelId, title: 'Task' }],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 1);
    const replacePgTasksForChannel = vi.fn(async () => 1);
    const getTowerPgResponseActivities = vi.fn(async () => ({ response_activities: [] }));
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 0);
    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'message', channel_id: 'channel-1' },
      { entity_type: 'thread', channel_id: 'channel-1' },
      { entity_type: 'message', channel_id: 'channel-2' },
      { entity_type: 'task', channel_id: 'channel-3' },
    ], {
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getTowerPgChannelTasks,
      getTowerPgResponseActivities,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replacePgTasksForChannel,
      replacePgResponseActivitiesForChannel,
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
    });

    expect(result).toEqual({ channels: 2, appliedTargets: 3, fallbackEvents: 0, events: 4 });
    expect(replacePgMessagesForChannel.mock.calls.map(([channelId]) => channelId).sort()).toEqual(['channel-1', 'channel-2']);
    expect(replacePgTasksForChannel).toHaveBeenCalledWith('channel-3', [expect.objectContaining({ record_id: 'task-channel-3' })]);
  });

  it('reconciles channel reorder SSE events through one authoritative channel refresh', async () => {
    const refreshChannels = vi.fn(async () => []);
    const target = store({ refreshChannels });

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'channel', channel_id: 'channel-1', payload: { position: 2 } },
      { entity_type: 'channel', channel_id: 'channel-2', payload: { position: 1 } },
    ]);

    expect(refreshChannels).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ channels: 0, appliedTargets: 1, fallbackEvents: 0, events: 2 });
  });

  it('hydrates changed PG task events by exact task id when present', async () => {
    const target = store({ tasks: [] });
    const getTowerPgTask = vi.fn(async () => ({
      task: {
        id: 'task-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        title: 'Exact task',
        row_version: 3,
      },
    }));
    const upsertTask = vi.fn(async () => 'task-1');
    const getTowerPgChannelTasks = vi.fn();

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'task', channel_id: 'channel-1', entity_id: 'task-1', payload: { task_id: 'task-1' } },
    ], {
      getTowerPgTask,
      getTowerPgChannelTasks,
      upsertTask,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 1, fallbackEvents: 0, events: 1 });
    expect(getTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(getTowerPgChannelTasks).not.toHaveBeenCalled();
    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'task-1',
      title: 'Exact task',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      version: 3,
    }));
    expect(target.applyTasks).not.toHaveBeenCalled();
  });

  it('hydrates PG task id events even when Tower omits channel context', async () => {
    const target = store({ tasks: [] });
    const getTowerPgTask = vi.fn(async () => ({
      task: {
        id: 'task-from-chat',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Chat-created task',
        row_version: 1,
      },
    }));
    const upsertTask = vi.fn(async () => 'task-from-chat');
    const getTowerPgChannelTasks = vi.fn();

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'task', entity_id: 'task-from-chat', payload: {} },
    ], {
      getTowerPgTask,
      getTowerPgChannelTasks,
      upsertTask,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 1, fallbackEvents: 0, events: 1 });
    expect(getTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-from-chat', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(getTowerPgChannelTasks).not.toHaveBeenCalled();
    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'task-from-chat',
      title: 'Chat-created task',
    }));
  });

  it('routes PG events to targeted surface hydrators without heartbeat', async () => {
    const target = store({
      selectedChannelId: 'channel-1',
      tasks: [],
      documents: [],
      audioNotes: [],
      dailyNotes: [],
      reactionRows: [],
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      applyReactions: vi.fn(),
      applyDocComments: vi.fn(),
    });
    const getTowerPgChannelDocs = vi.fn(async (_workspaceId, channelId) => ({
      docs: [{ id: `doc-${channelId}`, channel_id: channelId, title: 'Doc' }],
    }));
    const getTowerPgChannelFiles = vi.fn(async (_workspaceId, channelId) => ({
      files: [{ id: `file-${channelId}`, channel_id: channelId, display_name: 'File' }],
    }));
    const getTowerPgChannelFileFolders = vi.fn(async (_workspaceId, channelId) => ({
      folders: [{ id: `folder-${channelId}`, channel_id: channelId, scope_id: 'scope-1', title: 'Assets' }],
    }));
    const getTowerPgChannelAudioNotes = vi.fn(async (_workspaceId, channelId) => ({
      audio_notes: [{ id: `audio-${channelId}`, channel_id: channelId, storage_object_id: 'object-audio', title: 'Voice note' }],
    }));
    const getTowerPgTaskComments = vi.fn(async (_workspaceId, taskId) => ({
      comments: [{ id: `comment-${taskId}`, task_id: taskId, body: 'Comment' }],
    }));
    const getTowerPgTask = vi.fn(async (_workspaceId, taskId) => ({
      task: { id: taskId, channel_id: 'channel-task', title: 'Commented task', activity_version: 2 },
    }));
    const upsertTask = vi.fn(async () => 'task-1');
    const getTowerPgDocComments = vi.fn(async (_workspaceId, docId) => ({
      comments: [{ id: `doc-comment-${docId}`, doc_id: docId, body: 'Doc comment' }],
    }));
    const getTowerPgDailyNotes = vi.fn(async (_workspaceId, options) => ({
      daily_notes: [{ id: `daily-${options.ownerActorId}`, owner_actor_id: options.ownerActorId, owner_actor_npub: 'npub1owner', note_date: options.noteDate, title: 'Daily' }],
    }));
    const getTowerPgReactions = vi.fn(async () => ({
      reactions: [{ id: 'reaction-1', target_type: 'message', target_id: 'message-1', emoji: 'thumbs_up', reactor_npub: 'npub1alice' }],
    }));
    const replacePgDocumentsForChannel = vi.fn(async () => 2);
    const replacePgFileFoldersForChannel = vi.fn(async () => 1);
    const replacePgAudioNotesForChannel = vi.fn(async () => 1);
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const getCommentsByTarget = vi.fn(async (targetId) => [{ record_id: `local-comment-${targetId}`, target_record_id: targetId }]);
    const replacePgDailyNotesForOwnerAndDate = vi.fn(async () => 1);
    const replacePgReactionsForTarget = vi.fn(async () => 1);

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'doc', channel_id: 'channel-doc' },
      { entity_type: 'file', channel_id: 'channel-doc' },
      { entity_type: 'file_folder', channel_id: 'channel-doc' },
      { entity_type: 'audio_note', channel_id: 'channel-audio' },
      { entity_type: 'task_comment', payload: { task_id: 'task-1' } },
      { entity_type: 'doc_comment', payload: { doc_id: 'doc-1' } },
      { entity_type: 'daily_note', payload: { owner_actor_id: 'owner-actor-1', note_date: '2026-06-13' } },
      { entity_type: 'reaction', payload: { target_type: 'message', target_id: 'message-1' } },
      { entity_type: 'scope' },
    ], {
      getTowerPgChannelDocs,
      getTowerPgChannelFiles,
      getTowerPgChannelFileFolders,
      getTowerPgChannelAudioNotes,
      getTowerPgTaskComments,
      getTowerPgTask,
      getTowerPgDocComments,
      getTowerPgDailyNotes,
      getTowerPgReactions,
      replacePgDocumentsForChannel,
      replacePgFileFoldersForChannel,
      replacePgAudioNotesForChannel,
      replacePgCommentsForTarget,
      getCommentsByTarget,
      upsertTask,
      replacePgDailyNotesForOwnerAndDate,
      replacePgReactionsForTarget,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 7, fallbackEvents: 1, events: 9 });
    expect(replacePgDocumentsForChannel).toHaveBeenCalledWith('channel-doc', [
      expect.objectContaining({ record_id: 'doc-channel-doc' }),
      expect.objectContaining({ record_id: 'file-channel-doc' }),
    ]);
    expect(replacePgFileFoldersForChannel).toHaveBeenCalledWith('channel-doc', [
      expect.objectContaining({ record_id: 'folder-channel-doc' }),
    ]);
    expect(target.applyFileFolders).not.toHaveBeenCalled();
    expect(replacePgAudioNotesForChannel).toHaveBeenCalledWith('channel-audio', [expect.objectContaining({ record_id: 'audio-channel-audio' })]);
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('task-1', [expect.objectContaining({ record_id: 'comment-task-1' })]);
    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'task-1', activity_version: 2 }));
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('doc-1', [expect.objectContaining({ record_id: 'doc-comment-doc-1' })]);
    expect(target.applyDocComments).not.toHaveBeenCalled();
    expect(replacePgDailyNotesForOwnerAndDate).toHaveBeenCalledWith('owner-actor-1', '2026-06-13', [expect.objectContaining({ record_id: 'daily-owner-actor-1' })]);
    expect(replacePgReactionsForTarget).toHaveBeenCalledWith(expect.any(String), 'message-1', [expect.objectContaining({ record_id: 'reaction-1' })]);
  });

  it('routes access-control events to targeted control-plane hydration without a workspace fallback', async () => {
    const refreshGroups = vi.fn(async () => []);
    const refreshTowerPgWorkspaceMembers = vi.fn(async () => []);
    const refreshDailyScopeAgentAccess = vi.fn(async () => []);
    const refreshChannelGrants = vi.fn(async () => []);
    const refreshPgChannelAccessMaterialization = vi.fn(async () => undefined);
    const target = store({
      selectedChannelId: 'channel-1',
      refreshGroups,
      refreshTowerPgWorkspaceMembers,
      refreshDailyScopeAgentAccess,
      refreshChannelGrants,
      refreshPgChannelAccessMaterialization,
    });

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'workspace_member', entity_id: 'actor-1' },
      { entity_type: 'group', entity_id: 'group-1' },
      { entity_type: 'group_member', entity_id: 'actor-1' },
      { entity_type: 'channel_grant', channel_id: 'channel-1' },
      { entity_type: 'daily_scope_agent_access', entity_id: 'actor-agent' },
    ]);

    expect(result.fallbackEvents).toBe(0);
    expect(refreshTowerPgWorkspaceMembers).toHaveBeenCalledWith({ force: true, limit: 200 });
    expect(refreshGroups).toHaveBeenCalledWith({ force: true, minIntervalMs: 0 });
    expect(refreshDailyScopeAgentAccess).toHaveBeenCalledOnce();
    expect(refreshChannelGrants).toHaveBeenCalledOnce();
    expect(refreshPgChannelAccessMaterialization).toHaveBeenCalledOnce();
  });

  it('routes PG workroom visible events to targeted workroom hydrators', async () => {
    const target = store({
      workrooms: [],
      applyWorkrooms: vi.fn(),
      applyWorkroomParticipants: vi.fn(),
      applyWorkroomEvents: vi.fn(),
      applyWorkroomLinks: vi.fn(),
      applyWorkroomApprovals: vi.fn(),
    });
    const getTowerPgWorkroom = vi.fn(async () => ({
      workroom: {
        id: 'room-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Release room',
      },
    }));
    const getTowerPgWorkroomEvents = vi.fn(async () => ({
      events: [{ id: 'event-1', workroom_id: 'room-1', event_type: 'approval_requested' }],
    }));
    const getTowerPgWorkroomLinks = vi.fn(async () => ({
      links: [{ id: 'link-1', workroom_id: 'room-1', link_type: 'pull_request' }],
    }));
    const getTowerPgWorkroomParticipants = vi.fn(async () => ({
      participants: [{ id: 'participant-1', workroom_id: 'room-1', actor_npub: 'npub1human' }],
    }));
    const getTowerPgApprovals = vi.fn(async () => ({
      approvals: [{ id: 'approval-1', target_type: 'workroom', target_id: 'room-1', status: 'requested' }],
    }));
    const upsertWorkroom = vi.fn(async () => 'room-1');
    const replaceWorkroomEventsForRoom = vi.fn(async () => 1);
    const replaceWorkroomLinksForRoom = vi.fn(async () => 1);
    const replaceWorkroomParticipantsForRoom = vi.fn(async () => 1);
    const replaceWorkroomApprovalsForRoom = vi.fn(async () => 1);

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'workroom', entity_id: 'room-1', payload: {} },
      { entity_type: 'workroom_event', payload: { workroom_id: 'room-1' } },
      { entity_type: 'workroom_link', payload: { workroom_id: 'room-1' } },
      { entity_type: 'workroom_participant', payload: { workroom_id: 'room-1' } },
    ], {
      getTowerPgWorkroom,
      getTowerPgWorkroomEvents,
      getTowerPgWorkroomLinks,
      getTowerPgWorkroomParticipants,
      getTowerPgApprovals,
      upsertWorkroom,
      replaceWorkroomEventsForRoom,
      replaceWorkroomLinksForRoom,
      replaceWorkroomParticipantsForRoom,
      replaceWorkroomApprovalsForRoom,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 5, fallbackEvents: 0, events: 4 });
    expect(upsertWorkroom).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'room-1' }));
    expect(replaceWorkroomEventsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'event-1' })]);
    expect(replaceWorkroomLinksForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'link-1' })]);
    expect(replaceWorkroomParticipantsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'participant-1' })]);
    expect(replaceWorkroomApprovalsForRoom).toHaveBeenCalledWith('room-1', [expect.objectContaining({ record_id: 'approval-1' })]);
  });

  it('refreshes the canonical People directory for workspace member profile events', async () => {
    const refreshTowerPgWorkspaceMembers = vi.fn().mockResolvedValue([
      { actor_id: 'actor-testagent', npub: 'npub1testagent', display_name: 'Test Agent' },
    ]);
    const target = store({ refreshTowerPgWorkspaceMembers });

    const result = await hydrateTowerPgEventUpdates(target, [{
      event_type: 'actor.profile.updated',
      entity_type: 'actor',
      entity_id: 'actor-testagent',
      operation: 'updated',
      payload: { display_name: 'Test Agent' },
    }]);

    expect(refreshTowerPgWorkspaceMembers).toHaveBeenCalledWith({ force: true, limit: 200 });
    expect(result).toEqual({ channels: 0, appliedTargets: 1, fallbackEvents: 0, events: 1 });
  });

  it('accepts camelCase workroom ids in visible child-event payloads', async () => {
    const target = store({
      applyWorkroomEvents: vi.fn(),
    });
    const getTowerPgWorkroomEvents = vi.fn(async () => ({ events: [] }));
    const replaceWorkroomEventsForRoom = vi.fn(async () => 0);
    const getTowerPgApprovals = vi.fn(async () => ({ approvals: [] }));
    const replaceWorkroomApprovalsForRoom = vi.fn(async () => 0);

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'workroom_event', payload: { workroomId: 'room-1' } },
    ], {
      getTowerPgWorkroomEvents,
      replaceWorkroomEventsForRoom,
      getTowerPgApprovals,
      replaceWorkroomApprovalsForRoom,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 2, fallbackEvents: 0, events: 1 });
    expect(getTowerPgWorkroomEvents).toHaveBeenCalledWith('workspace-1', 'room-1', expect.objectContaining({
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    }));
    expect(replaceWorkroomEventsForRoom).toHaveBeenCalledWith('room-1', []);
  });

  it('treats missing PG reaction targets from SSE hydration as empty reactions', async () => {
    const target = store({
      reactionRows: [
        {
          record_id: 'old-reaction',
          target_record_id: 'message-missing',
          target_record_family_hash: recordFamilyHash('chat_message'),
          emoji: 'thumbs_up',
          record_state: 'active',
          pg_backend: true,
        },
      ],
      applyReactions: vi.fn(),
    });
    const missingTarget = new Error('Tower PG API 404: {"error":"reaction_target_not_found"}');
    missingTarget.status = 404;
    missingTarget.responseText = '{"error":"reaction_target_not_found"}';
    const getTowerPgReactions = vi.fn(async () => {
      throw missingTarget;
    });
    const replacePgReactionsForTarget = vi.fn(async () => 0);

    const result = await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'reaction', payload: { target_type: 'message', target_id: 'message-missing' } },
    ], {
      getTowerPgReactions,
      replacePgReactionsForTarget,
    });

    expect(result).toEqual({ channels: 0, appliedTargets: 1, fallbackEvents: 0, events: 1 });
    expect(replacePgReactionsForTarget).toHaveBeenCalledWith(expect.any(String), 'message-missing', []);
    expect(target.applyReactions).not.toHaveBeenCalled();
  });

  it('hydrates Daily Scope events by owner/date without removing another owner same date', async () => {
    const target = store({
      dailyNotes: [
        {
          record_id: 'daily-owner-old',
          pg_backend: true,
          owner_actor_id: 'owner-actor-1',
          note_date: '2026-06-17',
          title: 'Old owner note',
        },
        {
          record_id: 'daily-other-owner',
          pg_backend: true,
          owner_actor_id: 'owner-actor-2',
          note_date: '2026-06-17',
          title: 'Other owner note',
        },
      ],
      applyDailyNotes: vi.fn(async (dailyNotes) => {
        target.dailyNotes = dailyNotes;
      }),
    });
    const getTowerPgDailyNotes = vi.fn(async (_workspaceId, options) => ({
      daily_notes: [{
        id: 'daily-owner-new',
        owner_actor_id: options.ownerActorId,
        owner_actor_npub: 'npub1owner',
        note_date: options.noteDate,
        title: 'Updated owner note',
      }],
    }));
    const replacePgDailyNotesForOwnerAndDate = vi.fn(async () => 1);

    await hydrateTowerPgEventUpdates(target, [
      { entity_type: 'daily_note', payload: { owner_actor_id: 'owner-actor-1', note_date: '2026-06-17' } },
    ], {
      getTowerPgDailyNotes,
      replacePgDailyNotesForOwnerAndDate,
    });

    expect(getTowerPgDailyNotes).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      ownerActorId: 'owner-actor-1',
      noteDate: '2026-06-17',
    }));
    expect(target.dailyNotes.map((note) => note.record_id).sort()).toEqual(['daily-other-owner', 'daily-owner-old']);
    expect(target.applyDailyNotes).not.toHaveBeenCalled();
  });

  it('hydrates requested PG channel messages using workspace member sync when local actor mapping is missing', async () => {
    const getTowerPgWorkspaceMembers = vi.fn(async () => ({
      members: [{ actor: { actor_id: 'actor-1', npub: 'npub1alice' } }],
    }));
    const getTowerPgChannelThreads = vi.fn(async () => ({
      threads: [],
    }));
    const getTowerPgChannelMessages = vi.fn(async () => ({
      messages: [{ id: 'message-1', channel_id: 'channel-1', thread_id: null, body: 'Thread one', created_by_actor_id: 'actor-1' }],
    }));
    const replacePgMessagesForChannel = vi.fn(async () => 1);

    const rows = await hydrateTowerPgChannelMessages(store({
      scopes: [{ record_id: 'scope-1', record_state: 'active' }],
      selectedChannelId: 'channel-1',
    }), 'channel-1', {
      getTowerPgWorkspaceMembers,
      getTowerPgChannelThreads,
      getTowerPgChannelMessages,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      replacePgMessagesForChannel,
      replaceWorkspaceMembers: vi.fn(async () => []),
    });

    expect(getTowerPgWorkspaceMembers).toHaveBeenCalledWith('workspace-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(rows).toHaveLength(1);
    expect(replacePgMessagesForChannel.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        record_id: 'message-1',
        sender_npub: 'npub1alice',
      }),
    ]);
  });

  it('hydrates PG tasks from channel and scope task endpoints with dedupe', async () => {
    const target = store({
      scopes: [{ record_id: 'scope-1', record_state: 'active' }],
      channels: [{ record_id: 'channel-1', record_state: 'active' }],
      pgWorkspaceMembers: [{ actor_id: 'actor-agent', npub: 'npub1agent' }],
    });
    const getTowerPgChannelTasks = vi.fn(async () => ({
      tasks: [{
        id: 'task-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Channel task',
        assignments: [{ actor_id: 'actor-agent' }],
      }],
    }));
    const getTowerPgScopeTasks = vi.fn(async () => ({
      tasks: [
        {
          id: 'task-1',
          scope_id: 'scope-1',
          channel_id: 'channel-1',
          title: 'Channel task updated',
          assignments: [{ actor_id: 'actor-agent' }],
          row_version: 2,
        },
        { id: 'task-2', scope_id: 'scope-1', channel_id: 'channel-1', title: 'Scope task' },
      ],
    }));
    const replaceTasksForOwner = vi.fn(async () => 2);

    const tasks = await hydrateTowerPgTasks(target, {
      getTowerPgChannelTasks,
      getTowerPgScopeTasks,
      replaceTasksForOwner,
    });

    expect(getTowerPgChannelTasks).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(getTowerPgScopeTasks).toHaveBeenCalledWith('workspace-1', 'scope-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.record_id === 'task-1')).toMatchObject({
      title: 'Channel task updated',
      version: 2,
      assigned_to_npubs: ['npub1agent'],
      assigned_to_npub: 'npub1agent',
    });
    expect(replaceTasksForOwner).toHaveBeenCalledWith('npub1owner', tasks);
    expect(target.applyTasks).not.toHaveBeenCalled();
  });

  it('keeps newer local PG task rows when task hydration returns stale rows', async () => {
    const target = store({
      scopes: [{ record_id: 'scope-1', record_state: 'active' }],
      channels: [{ record_id: 'channel-1', record_state: 'active' }],
      tasks: [{
        record_id: 'task-1',
        owner_npub: 'npub1owner',
        title: 'Task',
        state: 'done',
        version: 3,
        sync_status: 'synced',
        record_state: 'active',
        pg_backend: true,
      }],
    });
    const getTowerPgChannelTasks = vi.fn(async () => ({
      tasks: [{
        id: 'task-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'in_progress',
        row_version: 2,
      }],
    }));
    const getTowerPgScopeTasks = vi.fn(async () => ({ tasks: [] }));
    const replaceTasksForOwner = vi.fn(async () => 1);

    const tasks = await hydrateTowerPgTasks(target, {
      getTowerPgChannelTasks,
      getTowerPgScopeTasks,
      replaceTasksForOwner,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ record_id: 'task-1', state: 'done', version: 3 });
    expect(replaceTasksForOwner).toHaveBeenCalledWith('npub1owner', tasks);
    expect(target.applyTasks).not.toHaveBeenCalled();
  });

  it('prefers hydrated PG task rows when they are as new as local rows', () => {
    const result = mergePgHydratedTasksWithLocal(
      [{ record_id: 'task-1', state: 'done', version: 3, pg_backend: true }],
      [{ record_id: 'task-1', state: 'in_progress', version: 3, pg_backend: true }],
    );

    expect(result).toEqual([{ record_id: 'task-1', state: 'done', version: 3, pg_backend: true }]);
  });

  it('keeps pending local PG task rows over same-version hydrated rows', () => {
    const result = mergePgHydratedTasksWithLocal(
      [{ record_id: 'task-1', state: 'in_progress', version: 3, pg_backend: true, sync_status: 'synced' }],
      [{ record_id: 'task-1', state: 'archive', version: 3, pg_backend: true, sync_status: 'failed' }],
    );

    expect(result).toEqual([{ record_id: 'task-1', state: 'archive', version: 3, pg_backend: true, sync_status: 'failed' }]);
  });

  it('keeps local-only pending PG task rows during hydration', () => {
    const result = mergePgHydratedTasksWithLocal(
      [{ record_id: 'task-1', state: 'done', version: 2, pg_backend: true, sync_status: 'synced' }],
      [{ record_id: 'task-local', state: 'archive', version: 1, pg_backend: true, sync_status: 'failed' }],
    );

    expect(result).toEqual([
      { record_id: 'task-1', state: 'done', version: 2, pg_backend: true, sync_status: 'synced' },
      { record_id: 'task-local', state: 'archive', version: 1, pg_backend: true, sync_status: 'failed' },
    ]);
  });

  it('hydrates one PG task by id without replacing the whole local task set', async () => {
    const target = store({
      tasks: [{ record_id: 'existing-task', title: 'Existing task', record_state: 'active' }],
    });
    const getTowerPgTask = vi.fn(async () => ({
      task: {
        id: 'task-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Fetched task',
      },
    }));
    const upsertTask = vi.fn(async () => 'task-1');

    const task = await hydrateTowerPgTask(target, 'task-1', {
      getTowerPgTask,
      upsertTask,
    });

    expect(task).toMatchObject({
      record_id: 'task-1',
      title: 'Fetched task',
      scope_id: 'scope-1',
      pg_channel_id: 'channel-1',
    });
    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'task-1' }));
    expect(target.applyTasks).not.toHaveBeenCalled();
  });

  it('hydrates PG task comments and replaces the local PG set for the task', async () => {
    const applyTaskComments = vi.fn();
    const getTowerPgTaskComments = vi.fn(async () => ({
      comments: [{
        id: 'comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        task_id: 'task-1',
        body: 'Comment body',
        row_version: 1,
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const getCommentsByTarget = vi.fn(async () => [
      { record_id: 'comment-1', target_record_id: 'task-1', pg_backend: true },
    ]);

    const comments = await hydrateTowerPgTaskComments(store({ applyTaskComments }), 'task-1', {
      getTowerPgTaskComments,
      replacePgCommentsForTarget,
      getCommentsByTarget,
    });

    expect(getTowerPgTaskComments).toHaveBeenCalledWith('workspace-1', 'task-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('task-1', expect.arrayContaining([
      expect.objectContaining({ record_id: 'comment-1', target_record_id: 'task-1', pg_backend: true }),
    ]));
    expect(getCommentsByTarget).not.toHaveBeenCalled();
    expect(applyTaskComments).not.toHaveBeenCalled();
  });

  it('does not apply hydrated PG task comments to the visible panel after the active task changes', async () => {
    const applyTaskComments = vi.fn();
    const getTowerPgTaskComments = vi.fn(async () => ({
      comments: [{
        id: 'comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        task_id: 'task-1',
        body: 'Comment body',
        row_version: 1,
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const getCommentsByTarget = vi.fn(async () => []);

    await hydrateTowerPgTaskComments(store({
      activeTaskId: 'task-2',
      applyTaskComments,
    }), 'task-1', {
      getTowerPgTaskComments,
      replacePgCommentsForTarget,
      getCommentsByTarget,
    });

    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('task-1', expect.arrayContaining([
      expect.objectContaining({ record_id: 'comment-1', target_record_id: 'task-1', pg_backend: true }),
    ]));
    expect(applyTaskComments).not.toHaveBeenCalled();
  });

  it('hydrates PG task comments using actor-to-npub resolution', async () => {
    const applyTaskComments = vi.fn();
    const getTowerPgTaskComments = vi.fn(async () => ({
      comments: [{
        id: 'comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        task_id: 'task-1',
        body: 'Comment body',
        created_by_actor_id: 'actor-1',
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const getCommentsByTarget = vi.fn(async () => [
      { record_id: 'comment-1', target_record_id: 'task-1', sender_npub: 'npub1alice' },
    ]);

    const comments = await hydrateTowerPgTaskComments(store({
      applyTaskComments,
      pgWorkspaceMembers: [{ actor_id: 'actor-1', npub: 'npub1alice' }],
    }), 'task-1', {
      getTowerPgTaskComments,
      replacePgCommentsForTarget,
      getCommentsByTarget,
    });

    expect(comments[0]).toMatchObject({
      record_id: 'comment-1',
      sender_npub: 'npub1alice',
    });
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('task-1', expect.arrayContaining([
      expect.objectContaining({
        record_id: 'comment-1',
        sender_npub: 'npub1alice',
      }),
    ]));
    expect(applyTaskComments).not.toHaveBeenCalled();
  });

  it('does not replace local PG task comments after the workspace context changes mid-hydration', async () => {
    const applyTaskComments = vi.fn();
    const getTowerPgTaskComments = vi.fn(async () => ({
      comments: [{
        id: 'comment-1',
        workspace_id: 'workspace-1',
        task_id: 'task-1',
        body: 'Comment body',
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const getCommentsByTarget = vi.fn(async () => []);
    const target = store({ applyTaskComments });
    getTowerPgTaskComments.mockImplementationOnce(async () => {
      target.currentWorkspace = {
        ...target.currentWorkspace,
        workspaceId: 'workspace-2',
        workspaceOwnerNpub: 'npub1other',
        directHttpsUrl: 'https://other.example',
      };
      return {
        comments: [{
          id: 'comment-1',
          workspace_id: 'workspace-1',
          task_id: 'task-1',
          body: 'Comment body',
        }],
      };
    });

    const comments = await hydrateTowerPgTaskComments(target, 'task-1', {
      getTowerPgTaskComments,
      replacePgCommentsForTarget,
      getCommentsByTarget,
    });

    expect(comments).toEqual([
      expect.objectContaining({ record_id: 'comment-1', target_record_id: 'task-1' }),
    ]);
    expect(replacePgCommentsForTarget).not.toHaveBeenCalled();
    expect(getCommentsByTarget).not.toHaveBeenCalled();
    expect(applyTaskComments).not.toHaveBeenCalled();
  });

  it('hydrates PG doc comments and replaces the local PG set for the doc', async () => {
    const applyDocComments = vi.fn();
    const getTowerPgDocComments = vi.fn(async () => ({
      comments: [{
        id: 'doc-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        body: 'Doc comment',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 3,
        },
        row_version: 1,
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);

    const comments = await hydrateTowerPgDocComments(store({
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      applyDocComments,
    }), 'doc-1', {
      getTowerPgDocComments,
      replacePgCommentsForTarget,
    });

    expect(getTowerPgDocComments).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('doc-1', expect.arrayContaining([
      expect.objectContaining({
        record_id: 'doc-comment-1',
        target_record_id: 'doc-1',
        anchor_block_id: 'block-1',
        anchor_line_number: 3,
        pg_backend: true,
      }),
    ]));
    expect(applyDocComments).not.toHaveBeenCalled();
  });

  it('hydrates PG doc comments without replacing the open drawer for another doc', async () => {
    const applyDocComments = vi.fn();
    const getTowerPgDocComments = vi.fn(async () => ({
      comments: [{
        id: 'doc-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        body: 'Doc comment',
        row_version: 1,
      }],
    }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);

    const comments = await hydrateTowerPgDocComments(store({
      selectedDocType: 'document',
      selectedDocId: 'doc-2',
      applyDocComments,
    }), 'doc-1', {
      getTowerPgDocComments,
      replacePgCommentsForTarget,
    });

    expect(comments).toHaveLength(1);
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('doc-1', expect.any(Array));
    expect(applyDocComments).not.toHaveBeenCalled();
  });

  it('does not let an older empty hydration replace a newer populated comment tree', async () => {
    let resolveOlder;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const getTowerPgDocComments = vi.fn()
      .mockImplementationOnce(() => older)
      .mockResolvedValueOnce({
        comments: [{
          id: 'reply-1',
          doc_id: 'doc-1',
          parent_comment_id: 'root-1',
          body: 'Newest inline reply',
          row_version: 1,
        }],
      });
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const target = store({ selectedDocType: 'document', selectedDocId: 'doc-1' });

    const olderHydration = hydrateTowerPgDocComments(target, 'doc-1', {
      getTowerPgDocComments,
      replacePgCommentsForTarget,
    });
    await Promise.resolve();
    await Promise.resolve();
    const newerHydration = hydrateTowerPgDocComments(target, 'doc-1', {
      getTowerPgDocComments,
      replacePgCommentsForTarget,
    });
    await newerHydration;
    resolveOlder({ comments: [] });
    await olderHydration;

    expect(replacePgCommentsForTarget).toHaveBeenCalledTimes(1);
    expect(replacePgCommentsForTarget).toHaveBeenCalledWith('doc-1', [
      expect.objectContaining({
        record_id: 'reply-1',
        parent_comment_id: 'root-1',
      }),
    ]);
  });

  it('drops a document comment hydration after the workspace changes', async () => {
    let resolveRead;
    const getTowerPgDocComments = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const replacePgCommentsForTarget = vi.fn(async () => 1);
    const target = store({ selectedDocType: 'document', selectedDocId: 'doc-1' });

    const hydration = hydrateTowerPgDocComments(target, 'doc-1', {
      getTowerPgDocComments,
      replacePgCommentsForTarget,
    });
    await vi.waitFor(() => expect(getTowerPgDocComments).toHaveBeenCalledTimes(1));
    target.currentWorkspace = {
      ...target.currentWorkspace,
      workspaceId: 'workspace-2',
    };
    resolveRead({ comments: [{ id: 'comment-1', doc_id: 'doc-1', body: 'Old workspace' }] });
    await hydration;

    expect(replacePgCommentsForTarget).not.toHaveBeenCalled();
  });

  it('hydrates PG docs and files from accessible channels', async () => {
    const target = store({
      channels: [{ record_id: 'channel-1', record_state: 'active' }],
    });
    const getTowerPgChannelDocs = vi.fn(async () => ({
      docs: [{
        id: 'doc-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'object-doc',
        title: 'Doc',
        summary: 'Old inline summary',
        body: {
          storage_object: {
            content_type: 'application/vnd.wingman.flightdeck.document-content+json',
            size_bytes: 128,
            sha256_hex: 'abc123',
          },
        },
      }],
    }));
    const getTowerPgChannelFiles = vi.fn(async () => ({
      files: [{ id: 'file-1', scope_id: 'scope-1', channel_id: 'channel-1', folder_id: 'folder-1', storage_object_id: 'object-file', display_name: 'File.pdf' }],
    }));
    const getTowerPgChannelFileFolders = vi.fn(async () => ({
      folders: [{ id: 'folder-1', scope_id: 'scope-1', channel_id: 'channel-1', title: 'Assets' }],
    }));
    const replaceDocumentsForOwner = vi.fn(async () => 2);
    const replaceFileFoldersForWorkspace = vi.fn(async () => 1);
    const downloadStorageObject = vi.fn(async () => new TextEncoder().encode(JSON.stringify({
      format: 'document_content_v1',
      content_model: {
        content: '# Updated stored body',
        content_format: null,
        content_blocks: [],
      },
    })));

    const documents = await hydrateTowerPgDocumentsAndFiles(target, {
      getTowerPgChannelDocs,
      getTowerPgChannelFiles,
      getTowerPgChannelFileFolders,
      replaceDocumentsForOwner,
      replaceFileFoldersForWorkspace,
      downloadStorageObject,
    });

    expect(documents).toEqual([
      expect.objectContaining({
        record_id: 'doc-1',
        pg_record_type: 'doc',
        content: 'Old inline summary',
        content_storage_status: 'remote',
      }),
      expect.objectContaining({ record_id: 'file-1', pg_record_type: 'file', pg_folder_id: 'folder-1' }),
    ]);
    expect(downloadStorageObject).not.toHaveBeenCalled();
    expect(replaceDocumentsForOwner).toHaveBeenCalledWith('npub1owner', documents);
    expect(replaceFileFoldersForWorkspace).toHaveBeenCalledWith('workspace-1', [
      expect.objectContaining({ record_id: 'folder-1', title: 'Assets' }),
    ]);
    expect(target.applyDocuments).not.toHaveBeenCalled();
    expect(target.applyFileFolders).not.toHaveBeenCalled();
  });

  it('hydrates a selected PG doc directly from the typed body route', async () => {
    const target = store({
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      patchDocumentLocal: vi.fn(),
      applySelectedDocument: vi.fn(),
    });
    const getTowerPgDocBody = vi.fn(async () => ({
      doc: {
        id: 'doc-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'object-new',
        title: 'Doc',
        summary: 'Old summary',
        row_version: 15,
        body: {
          object_id: 'object-new',
          storage_object: {
            content_type: 'text/markdown; charset=utf-8',
            size_bytes: 17,
            sha256_hex: 'abc123',
          },
        },
      },
      body: {
        object_id: 'object-new',
        content_type: 'text/markdown; charset=utf-8',
        size_bytes: 17,
        sha256_hex: 'abc123',
        encoding: 'base64',
        base64_data: btoa('# Fresh PG body'),
      },
    }));
    const upsertDocument = vi.fn();

    const row = await hydrateTowerPgDoc(target, 'doc-1', {
      getTowerPgDocBody,
      upsertDocument,
    });

    expect(row).toMatchObject({
      record_id: 'doc-1',
      content: '# Fresh PG body',
      content_storage_object_id: 'object-new',
      content_storage_status: 'loaded',
      version: 15,
    });
    expect(getTowerPgDocBody).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(upsertDocument).toHaveBeenCalledWith(row);
    expect(target.patchDocumentLocal).not.toHaveBeenCalled();
    expect(target.applySelectedDocument).not.toHaveBeenCalled();
  });

  it('hydrates the complete synthetic long body and empty editor metadata through the typed route into Dexie', async () => {
    const target = store({ selectedDocType: 'document', selectedDocId: 'doc-long' });
    const source = buildSyntheticLongDocumentFixture();
    const stored = JSON.stringify({
      format: 'document_content_v1',
      content_model: {
        content: source,
        content_format: null,
        content_blocks: [],
      },
    });
    const getTowerPgDocBody = vi.fn(async () => ({
      doc: {
        id: 'doc-long',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'object-long',
        title: 'Synthetic long document',
        row_version: 53,
      },
      body: {
        object_id: 'object-long',
        content_type: 'application/vnd.wingman.flightdeck.document-content+json',
        size_bytes: stored.length,
        sha256_hex: 'a'.repeat(64),
        encoding: 'base64',
        base64_data: btoa(stored),
      },
    }));
    const upsertDocument = vi.fn();

    const row = await hydrateTowerPgDoc(target, 'doc-long', {
      getTowerPgDocBody,
      upsertDocument,
    });

    expect(row.content).toBe(source);
    expect(row.content).toHaveLength(26_706);
    expect(row.content).toContain('## 12-month implementation timeline');
    expect(row.content).toContain('TAIL_SENTINEL: synthetic-long-document-complete');
    expect(row.content).not.toContain('\\');
    expect(row.content_blocks).toEqual([]);
    expect(row.editor_state).toBeNull();
    expect(row.version).toBe(53);
    expect(upsertDocument).toHaveBeenCalledWith(row);
  });

  it('hydrates PG audio notes from accessible channels', async () => {
    const target = store({
      channels: [{ record_id: 'channel-1', record_state: 'active' }],
    });
    const getTowerPgChannelAudioNotes = vi.fn(async () => ({
      audio_notes: [{ id: 'audio-1', channel_id: 'channel-1', storage_object_id: 'object-audio', title: 'Voice note' }],
    }));
    const replaceAudioNotesForOwner = vi.fn(async () => 1);

    const audioNotes = await hydrateTowerPgAudioNotes(target, {
      getTowerPgChannelAudioNotes,
      replaceAudioNotesForOwner,
    });

    expect(audioNotes).toEqual([
      expect.objectContaining({ record_id: 'audio-1', pg_record_type: 'audio_note' }),
    ]);
    expect(replaceAudioNotesForOwner).toHaveBeenCalledWith('npub1owner', audioNotes);
    expect(target.applyAudioNotes).not.toHaveBeenCalled();
  });

  it('hydrates PG audio notes using actor-to-npub resolution', async () => {
    const target = store({
      channels: [{ record_id: 'channel-1', record_state: 'active' }],
      pgWorkspaceMembers: [{ actor_id: 'actor-1', npub: 'npub1alice' }],
    });
    const getTowerPgChannelAudioNotes = vi.fn(async () => ({
      audio_notes: [{ id: 'audio-1', channel_id: 'channel-1', storage_object_id: 'object-audio', title: 'Voice note', created_by_actor_id: 'actor-1' }],
    }));
    const replaceAudioNotesForOwner = vi.fn(async () => 1);

    const audioNotes = await hydrateTowerPgAudioNotes(target, {
      getTowerPgChannelAudioNotes,
      replaceAudioNotesForOwner,
    });

    expect(audioNotes[0]).toMatchObject({
      record_id: 'audio-1',
      sender_npub: 'npub1alice',
    });
    expect(replaceAudioNotesForOwner).toHaveBeenCalledWith('npub1owner', expect.arrayContaining([
      expect.objectContaining({ record_id: 'audio-1', sender_npub: 'npub1alice' }),
    ]));
  });

  it('hydrates active PG response activities for a channel', async () => {
    const target = store();
    const getTowerPgResponseActivities = vi.fn(async () => ({
      response_activities: [{
        id: 'activity-1',
        workspace_id: 'workspace-1',
        channel_id: 'channel-1',
        target_type: 'chat_thread',
        target_id: 'pg-thread-1',
        status: 'thinking',
        label: 'Thinking',
        expires_at: '2999-01-01T00:00:00.000Z',
      }],
    }));
    const replacePgResponseActivitiesForChannel = vi.fn(async () => 1);

    const activities = await hydrateTowerPgChannelResponseActivities(target, 'channel-1', {
      getTowerPgResponseActivities,
      replacePgResponseActivitiesForChannel,
    });

    expect(getTowerPgResponseActivities).toHaveBeenCalledWith('workspace-1', {
      channelId: 'channel-1',
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(activities).toEqual([
      expect.objectContaining({
        record_id: 'activity-1',
        pg_backend: true,
        target_type: 'chat_thread',
        target_id: 'pg-thread-1',
        status: 'thinking',
      }),
    ]);
    expect(replacePgResponseActivitiesForChannel).toHaveBeenCalledWith('channel-1', activities);
  });

  it('hydrates current user-visible agent activity after reconnect', async () => {
    const target = store();
    const getTowerPgAgentActivities = vi.fn(async () => ({
      agent_activities: [{
        id: 'row-1', activity_id: 'activity-1', workspace_id: 'workspace-1', channel_id: 'channel-1',
        thread_id: 'thread-1', trigger_message_id: 'message-1', turn_id: 'turn-1', session_id: 'session-1',
        agent_npub: 'npub1agent', state: 'working', visibility: 'user_visible', sequence: 3,
        summary: 'Running tests', created_at: '2026-08-10T00:00:00.000Z', expires_at: '2999-01-01T00:00:00.000Z',
        commentary_history: [
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 2, state: 'working', visibility: 'user_visible', body: 'Checking code' },
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 3, state: 'working', visibility: 'user_visible', body: 'Running tests' },
          { activity_id: 'activity-1', turn_id: 'turn-old', sequence: 1, state: 'working', visibility: 'user_visible', body: 'Wrong turn' },
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 4, state: 'completed', visibility: 'user_visible', body: 'Final reply' },
        ],
      }],
    }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 1);
    const mergeAgentActivityCommentary = vi.fn(async () => 2);

    const activities = await hydrateTowerPgChannelAgentActivities(target, 'channel-1', {
      getTowerPgAgentActivities,
      replacePgAgentActivitiesForChannel,
      mergeAgentActivityCommentary,
    });

    expect(activities).toEqual([expect.objectContaining({ activity_id: 'activity-1', turn_id: 'turn-1', created_at: '2026-08-10T00:00:00.000Z', sequence: 3 })]);
    expect(replacePgAgentActivitiesForChannel).toHaveBeenCalledWith('channel-1', activities, {
      authoritative: true,
      requestSnapshot: [],
    });
    expect(mergeAgentActivityCommentary).toHaveBeenCalledWith([
      expect.objectContaining({ turn_id: 'turn-1', sequence: 2, body: 'Checking code' }),
      expect.objectContaining({ turn_id: 'turn-1', sequence: 3, body: 'Running tests' }),
    ]);
  });

  it('hydrates retained session health independently from turn activity', async () => {
    const getTowerPgAgentSessionHealth = vi.fn(async () => ({ agent_sessions: [{
      id: 'health-1', workspace_id: 'workspace-1', channel_id: 'channel-1', thread_id: 'thread-1',
      session_id: 'session-1', agent_npub: 'npub1agent', status: 'online', active_turn_id: 'turn-1',
      generation: 4, sequence: 1, row_version: 12, lease_health: 'live', lease_expires_at: '2999-01-01T00:00:00Z',
    }] }));
    const replacePgAgentSessionHealthForChannel = vi.fn(async () => 1);
    const supportedStore = store();
    supportedStore.currentWorkspace.capabilities = ['pg_agent_session_health'];
    const sessions = await hydrateTowerPgAgentSessionHealth(supportedStore, 'channel-1', {
      threadId: 'thread-1', getTowerPgAgentSessionHealth, replacePgAgentSessionHealthForChannel,
    });
    expect(sessions).toEqual([expect.objectContaining({ session_id: 'session-1', status: 'online', row_version: 12 })]);
    expect(replacePgAgentSessionHealthForChannel).toHaveBeenCalledWith('channel-1', sessions);
  });

  it.each([
    ['malformed', {}, false],
    ['partial', { agent_activities: [], partial: true }, false],
    ['paginated', { agent_activities: [], next_cursor: 'next-page' }, false],
    ['complete empty', { agent_activities: [] }, true],
  ])('guards %s agent-activity absence hydration', async (_label, response, authoritative) => {
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);
    const requestSnapshot = [{ record_id: 'row-existing', activity_id: 'activity-1', turn_id: 'turn-1', sequence: 1 }];
    await hydrateTowerPgChannelAgentActivities(store(), 'channel-1', {
      getTowerPgAgentActivities: vi.fn(async () => response),
      getAgentActivitiesForChannel: vi.fn(async () => requestSnapshot),
      replacePgAgentActivitiesForChannel,
      mergeAgentActivityCommentary: vi.fn(async () => 0),
    });
    expect(replacePgAgentActivitiesForChannel).toHaveBeenCalledWith('channel-1', [], {
      authoritative,
      requestSnapshot,
    });
  });

  it('does not reconcile authoritative absence when activity hydration fails', async () => {
    const replacePgAgentActivitiesForChannel = vi.fn();
    await expect(hydrateTowerPgChannelAgentActivities(store(), 'channel-1', {
      getTowerPgAgentActivities: vi.fn(async () => { throw new Error('Tower unavailable'); }),
      getAgentActivitiesForChannel: vi.fn(async () => [{ record_id: 'row-existing' }]),
      replacePgAgentActivitiesForChannel,
    })).rejects.toThrow('Tower unavailable');
    expect(replacePgAgentActivitiesForChannel).not.toHaveBeenCalled();
  });

  it('applies only the newest SSE activity snapshot and retains terminal activity as a tombstone', async () => {
    const upsertAgentActivity = vi.fn(async () => true);
    const clearAgentActivity = vi.fn(async () => 1);
    const snapshot = (sequence, state) => ({
      event_type: 'flightdeck_pg.agent_activity.snapshot', entity_type: 'agent_activity', entity_id: 'row-1',
      payload: { agent_activity: {
        id: 'row-1', activity_id: 'activity-1', channel_id: 'channel-1', thread_id: 'thread-1',
        trigger_message_id: 'message-1', session_id: 'session-1', agent_npub: 'npub1agent',
        state, visibility: 'user_visible', sequence, expires_at: '2999-01-01T00:00:00.000Z',
      } },
    });

    const getTowerPgAgentActivities = vi.fn(async () => ({ agent_activities: [] }));
    const replacePgAgentActivitiesForChannel = vi.fn(async () => 0);
    await hydrateTowerPgEventUpdates(store(), [snapshot(2, 'working'), snapshot(1, 'working')], { upsertAgentActivity, clearAgentActivity, getTowerPgAgentActivities, replacePgAgentActivitiesForChannel });
    expect(upsertAgentActivity).toHaveBeenCalledOnce();
    expect(upsertAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }));
    expect(getTowerPgAgentActivities).not.toHaveBeenCalled();
    expect(replacePgAgentActivitiesForChannel).not.toHaveBeenCalled();

    await hydrateTowerPgEventUpdates(store(), [snapshot(3, 'completed')], { upsertAgentActivity, clearAgentActivity, getTowerPgAgentActivities, replacePgAgentActivitiesForChannel });
    expect(upsertAgentActivity).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 3, state: 'completed' }));
    expect(clearAgentActivity).not.toHaveBeenCalled();
    expect(getTowerPgAgentActivities).not.toHaveBeenCalled();
    expect(replacePgAgentActivitiesForChannel).not.toHaveBeenCalled();
  });

  it('materializes replayed session-health SSE by monotonic row version without touching activity state', async () => {
    const upsertAgentSessionHealth = vi.fn(async () => true);
    const health = (rowVersion, status) => ({ entity_type: 'agent_session_health', entity_id: 'health-1', payload: {
      agent_session_health: { id: 'health-1', workspace_id: 'workspace-1', channel_id: 'channel-1', session_id: 'session-1',
        agent_npub: 'npub1agent', status, generation: 2, sequence: rowVersion, row_version: rowVersion,
        lease_health: 'live', lease_expires_at: '2999-01-01T00:00:00Z' },
    } });
    await hydrateTowerPgEventUpdates(store(), [health(8, 'errored'), health(8, 'errored')], { upsertAgentSessionHealth });
    expect(upsertAgentSessionHealth).toHaveBeenCalledTimes(2);
    expect(upsertAgentSessionHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'errored', row_version: 8 }));
  });

  it('hydrates PG response activities for an open thread target', async () => {
    const target = store();
    const getTowerPgResponseActivities = vi.fn(async () => ({
      response_activities: [{
        id: 'activity-1',
        workspace_id: 'workspace-1',
        channel_id: 'channel-1',
        target_type: 'chat_thread',
        target_id: 'pg-thread-1',
        status: 'writing',
        expires_at: '2999-01-01T00:00:00.000Z',
      }],
    }));
    const replacePgResponseActivitiesForTarget = vi.fn(async () => 1);

    const activities = await hydrateTowerPgResponseActivitiesForTarget(target, 'chat_thread', 'pg-thread-1', {
      getTowerPgResponseActivities,
      replacePgResponseActivitiesForTarget,
    });

    expect(getTowerPgResponseActivities).toHaveBeenCalledWith('workspace-1', {
      targetType: 'chat_thread',
      targetId: 'pg-thread-1',
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(replacePgResponseActivitiesForTarget).toHaveBeenCalledWith('chat_thread', 'pg-thread-1', activities);
  });

  it('materializes a bundled workspace delta and acknowledges its cursor after the transaction', async () => {
    const target = store({ tasks: [], documents: [], audioNotes: [] });
    const calls = [];
    const deps = {
      runWorkspaceSyncTransaction: vi.fn(async (callback) => {
        calls.push('transaction:start');
        await callback();
        calls.push('transaction:commit');
      }),
      replaceScopesForOwner: vi.fn(async () => calls.push('scopes')),
      replaceChannelsForOwner: vi.fn(async () => calls.push('channels')),
      upsertScope: vi.fn(async () => calls.push('scopes')),
      upsertChannel: vi.fn(async () => calls.push('channels')),
      replacePgMessagesForChannel: vi.fn(async () => calls.push('messages')),
      replacePgTasksForChannel: vi.fn(async () => calls.push('tasks')),
      replacePgDocumentsForChannel: vi.fn(async () => calls.push('documents')),
      replacePgFileFoldersForChannel: vi.fn(async () => calls.push('folders')),
      replacePgAudioNotesForChannel: vi.fn(async () => calls.push('audio')),
      replacePgCommentsForTarget: vi.fn(async () => calls.push('comments')),
      deleteTowerPgSyncTombstones: vi.fn(async () => calls.push('tombstones')),
      setSyncState: vi.fn(async () => calls.push('cursor')),
    };
    const result = await hydrateTowerPgSyncBundle(target, {
      mode: 'delta',
      next_cursor: 'cursor-8',
      scopes: [{ id: 'scope-1', name: 'Flight Deck' }],
      channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Implementation' }],
      channel_bundles: [{
        channel_id: 'channel-1',
        threads: [],
        messages: [{ id: 'message-1', channel_id: 'channel-1', body: 'Hello', created_at: '2026-07-28T00:00:00.000Z' }],
        tasks: [{ id: 'task-1', channel_id: 'channel-1', scope_id: 'scope-1', title: 'Ship it', state: 'new', priority: 'sand', assignments: [] }],
        task_comments: [],
        docs: [],
        doc_comments: [],
        files: [],
        file_folders: [],
        audio_notes: [],
      }],
      tombstones: [{ entity_type: 'message', entity_id: 'deleted-message' }],
    }, deps);

    expect(result).toMatchObject({ cursor: 'cursor-8', fullSnapshot: false, hasMore: false });
    expect(deps.replacePgMessagesForChannel).toHaveBeenCalledWith('channel-1', [expect.objectContaining({ record_id: 'message-1' })]);
    expect(deps.replacePgTasksForChannel).toHaveBeenCalledWith('channel-1', [expect.objectContaining({ record_id: 'task-1' })]);
    expect(deps.setSyncState).toHaveBeenCalledWith(
      'tower_pg_sync_cursor:workspace-1:npub1operator-a',
      'cursor-8',
    );
    expect(calls.indexOf('cursor')).toBeLessThan(calls.indexOf('transaction:commit'));
  });

  it('rolls back bundle rows and cursor together when the atomic transaction fails', async () => {
    const workspaceDbKey = `pg-bundle-atomic-failure-${Date.now()}`;
    openWorkspaceDb(workspaceDbKey);
    const target = store();
    const cursorKey = 'tower_pg_sync_cursor:workspace-1:npub1operator-a';
    try {
      await expect(hydrateTowerPgSyncBundle(target, {
        mode: 'delta',
        next_cursor: 'cursor-must-not-commit',
        scopes: [],
        channels: [],
        channel_bundles: [{
          channel_id: 'channel-1',
          threads: [],
          messages: [{ id: 'message-must-roll-back', channel_id: 'channel-1', body: 'Atomic' }],
          tasks: [], task_comments: [], docs: [], doc_comments: [], files: [], file_folders: [], audio_notes: [],
        }],
        tombstones: [],
      }, {
        beforeCursorCommit: async () => { throw new Error('synthetic transaction failure'); },
      })).rejects.toThrow('synthetic transaction failure');

      await expect(getMessagesByChannel('channel-1')).resolves.toEqual([]);
      await expect(getSyncState(cursorKey)).resolves.toBeNull();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('hydrates directory groups without assigning the getter-only currentWorkspaceGroups property', async () => {
    const target = store({
      groups: [{ group_id: 'old-group', owner_npub: 'npub1other' }],
    });
    Object.defineProperty(target, 'currentWorkspaceGroups', {
      configurable: true,
      get() {
        return this.groups.filter((group) => group.owner_npub === this.workspaceOwnerNpub);
      },
    });
    const reactiveTarget = new Proxy(target, {
      set: Reflect.set,
    });

    await expect(hydrateTowerPgSyncBundle(reactiveTarget, {
      mode: 'delta',
      refreshed: { directory: true },
      scopes: [],
      channels: [],
      channel_bundles: [],
      groups: [{ id: 'group-1', name: 'Operators', kind: 'custom' }],
    }, {
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      replaceScopesForOwner: vi.fn(),
      replaceChannelsForOwner: vi.fn(),
      upsertGroup: vi.fn(),
      replaceWorkspaceMembers: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(),
    })).resolves.toMatchObject({ applied: 0, cursor: null });

    expect(reactiveTarget.groups).toEqual([{ group_id: 'old-group', owner_npub: 'npub1other' }]);
    expect(reactiveTarget.currentWorkspaceGroups).toEqual([]);
  });

  it('uses the persisted workspace cursor for a single delta request', async () => {
    const getTowerPgWorkspaceSync = vi.fn(async () => ({
      mode: 'delta', next_cursor: 'cursor-10', scopes: [], channels: [], channel_bundles: [], has_more: false,
    }));
    const result = await syncTowerPgWorkspace(store(), {}, {
      getSyncState: vi.fn(async () => 'cursor-9'),
      getTowerPgWorkspaceSync,
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      replaceScopesForOwner: vi.fn(),
      replaceChannelsForOwner: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(),
      setSyncState: vi.fn(),
    });

    expect(getTowerPgWorkspaceSync).toHaveBeenCalledWith('workspace-1', expect.objectContaining({ cursor: 'cursor-9', limit: 500 }));
    expect(result).toMatchObject({ cursor: 'cursor-10', pages: 1 });
  });

  it('applies a multi-page initial snapshot incrementally and reconciles only at completion', async () => {
    const pages = [
      {
        identity: { workspace_id: 'workspace-1' }, mode: 'snapshot', full_snapshot: true, snapshot_complete: false, has_more: true,
        next_cursor: 'snapshot-page-2', scopes: [{ id: 'scope-1', name: 'Synthetic' }],
        channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Generated' }],
        channel_bundles: [{ channel_id: 'channel-1', threads: [], messages: [{ id: 'message-1', channel_id: 'channel-1', body: 'One' }], tasks: [], docs: [], files: [], file_folders: [], audio_notes: [], task_comments: [], doc_comments: [] }],
      },
      {
        identity: { workspace_id: 'workspace-1' }, mode: 'snapshot', full_snapshot: true, snapshot_complete: true, has_more: false,
        next_cursor: 'event-cursor-10', scopes: [{ id: 'scope-1', name: 'Synthetic' }],
        channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Generated' }],
        channel_bundles: [{ channel_id: 'channel-1', threads: [], messages: [{ id: 'message-2', channel_id: 'channel-1', body: 'Two' }], tasks: [], docs: [], files: [], file_folders: [], audio_notes: [], task_comments: [], doc_comments: [] }],
      },
    ];
    const state = new Map();
    const applied = new Map();
    const reconcileTowerPgSnapshot = vi.fn();
    const deps = {
      getSyncState: vi.fn(async (key) => state.get(key) ?? null),
      setSyncState: vi.fn(async (key, value) => state.set(key, value)),
      deleteSyncState: vi.fn(async (key) => state.delete(key)),
      getTowerPgWorkspaceSync: vi.fn(async () => pages.shift()),
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      upsertScope: vi.fn(), upsertChannel: vi.fn(), upsertGroup: vi.fn(),
      upsertMessage: vi.fn(async (row) => applied.set(row.record_id, row)),
      upsertTask: vi.fn(), upsertDocument: vi.fn(), upsertFileFolder: vi.fn(), upsertAudioNote: vi.fn(), upsertComment: vi.fn(),
      replaceWorkspaceMembers: vi.fn(), replaceDailyNotesForOwner: vi.fn(), replacePgPersonalWappsForOwner: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(), reconcileTowerPgSnapshot,
    };

    const result = await syncTowerPgWorkspace(store(), { limit: 1 }, deps);

    expect(result).toMatchObject({ pages: 2, cursor: 'event-cursor-10' });
    expect([...applied.keys()]).toEqual(['message-1', 'message-2']);
    expect(reconcileTowerPgSnapshot).toHaveBeenCalledTimes(1);
    expect(reconcileTowerPgSnapshot).toHaveBeenCalledWith(expect.objectContaining({ messages: ['message-1', 'message-2'] }));
  });

  it('resumes an interrupted snapshot from its transactionally persisted cursor and replays idempotently', async () => {
    const state = new Map();
    const rows = new Map();
    let failOnce = true;
    const first = { identity: { workspace_id: 'workspace-1' }, mode: 'snapshot', full_snapshot: true, snapshot_complete: false, has_more: true, next_cursor: 'resume-page-2', scopes: [], channels: [], channel_bundles: [{ channel_id: 'channel-1', threads: [], messages: [{ id: 'message-1', channel_id: 'channel-1', body: 'Generated' }], tasks: [], docs: [], files: [], file_folders: [], audio_notes: [], task_comments: [], doc_comments: [] }] };
    const last = { identity: { workspace_id: 'workspace-1' }, mode: 'snapshot', full_snapshot: true, snapshot_complete: true, has_more: false, next_cursor: 'event-cursor-20', scopes: [], channels: [], channel_bundles: [{ channel_id: 'channel-1', threads: [], messages: [{ id: 'message-1', channel_id: 'channel-1', body: 'Generated' }, { id: 'message-2', channel_id: 'channel-1', body: 'Generated' }], tasks: [], docs: [], files: [], file_folders: [], audio_notes: [], task_comments: [], doc_comments: [] }] };
    const getTowerPgWorkspaceSync = vi.fn(async (_id, options) => {
      if (!options.cursor) return first;
      if (failOnce) { failOnce = false; throw new Error('synthetic interruption'); }
      return last;
    });
    const deps = {
      getSyncState: vi.fn(async (key) => state.get(key) ?? null), setSyncState: vi.fn(async (key, value) => state.set(key, value)), deleteSyncState: vi.fn(async (key) => state.delete(key)),
      getTowerPgWorkspaceSync, runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      upsertScope: vi.fn(), upsertChannel: vi.fn(), upsertGroup: vi.fn(), upsertMessage: vi.fn(async (row) => rows.set(row.record_id, row)),
      upsertTask: vi.fn(), upsertDocument: vi.fn(), upsertFileFolder: vi.fn(), upsertAudioNote: vi.fn(), upsertComment: vi.fn(),
      replaceWorkspaceMembers: vi.fn(), replaceDailyNotesForOwner: vi.fn(), replacePgPersonalWappsForOwner: vi.fn(), deleteTowerPgSyncTombstones: vi.fn(), reconcileTowerPgSnapshot: vi.fn(),
    };

    await expect(syncTowerPgWorkspace(store(), { limit: 1 }, deps)).rejects.toThrow('synthetic interruption');
    await expect(syncTowerPgWorkspace(store(), { limit: 1 }, deps)).resolves.toMatchObject({ cursor: 'event-cursor-20', pages: 1 });
    expect(getTowerPgWorkspaceSync.mock.calls.at(-1)[1].cursor).toBe('resume-page-2');
    expect([...rows.keys()]).toEqual(['message-1', 'message-2']);
  });

  it('hydrates a generated large-workspace snapshot in bounded response pages', async () => {
    const totalMessages = 3_134;
    const pageSize = 500;
    const generated = Array.from({ length: totalMessages }, (_, index) => ({
      id: `generated-message-${String(index + 1).padStart(5, '0')}`,
      channel_id: 'channel-1',
      body: `Synthetic message ${index + 1}`,
    }));
    const pages = [];
    for (let offset = 0; offset < generated.length; offset += pageSize) {
      const messages = generated.slice(offset, offset + pageSize);
      const complete = offset + pageSize >= generated.length;
      pages.push({
        identity: { workspace_id: 'workspace-1' }, mode: 'snapshot', full_snapshot: true, snapshot_complete: complete, has_more: !complete,
        next_cursor: complete ? 'event-cursor-large' : `opaque-page-${pages.length + 2}`,
        scopes: [], channels: [],
        channel_bundles: [{ channel_id: 'channel-1', threads: [], messages, tasks: [], docs: [], files: [], file_folders: [], audio_notes: [], task_comments: [], doc_comments: [] }],
      });
    }
    const state = new Map();
    const rows = new Set();
    const responseSizes = [];
    const deps = {
      getSyncState: vi.fn(async (key) => state.get(key) ?? null), setSyncState: vi.fn(async (key, value) => state.set(key, value)), deleteSyncState: vi.fn(async (key) => state.delete(key)),
      getTowerPgWorkspaceSync: vi.fn(async () => { const page = pages.shift(); responseSizes.push(page.channel_bundles[0].messages.length); return page; }),
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()), upsertScope: vi.fn(), upsertChannel: vi.fn(), upsertGroup: vi.fn(),
      upsertMessage: vi.fn(async (row) => rows.add(row.record_id)), upsertTask: vi.fn(), upsertDocument: vi.fn(), upsertFileFolder: vi.fn(), upsertAudioNote: vi.fn(), upsertComment: vi.fn(),
      replaceWorkspaceMembers: vi.fn(), replaceDailyNotesForOwner: vi.fn(), replacePgPersonalWappsForOwner: vi.fn(), deleteTowerPgSyncTombstones: vi.fn(), reconcileTowerPgSnapshot: vi.fn(),
    };

    const result = await syncTowerPgWorkspace(store(), { limit: pageSize }, deps);

    expect(result).toMatchObject({ pages: 7, applied: totalMessages, cursor: 'event-cursor-large' });
    expect(rows.size).toBe(totalMessages);
    expect(Math.max(...responseSizes)).toBe(pageSize);
  });

  it('reports request and apply stages without exposing the cursor value', async () => {
    const onProgress = vi.fn();
    const result = await syncTowerPgWorkspace(store(), { onProgress }, {
      getSyncState: vi.fn(async () => 'sensitive-cursor'),
      getTowerPgWorkspaceSync: vi.fn(async () => ({
        mode: 'delta', next_cursor: 'next-sensitive-cursor', scopes: [], channels: [], channel_bundles: [], has_more: false,
      })),
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      replaceScopesForOwner: vi.fn(),
      replaceChannelsForOwner: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(),
      setSyncState: vi.fn(),
    });

    expect(result).toMatchObject({ pages: 1, applied: 0 });
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ stage: 'receiving', page: 1, cursorPresent: true }));
    expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'applying', page: 1, fullSnapshot: false }));
    expect(onProgress).toHaveBeenNthCalledWith(3, expect.objectContaining({ stage: 'complete', page: 1, applied: 0 }));
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain('sensitive-cursor');
  });

  it('does not replace or reapply navigation for an empty workspace delta', async () => {
    const existingScope = { record_id: 'scope-1', title: 'Flight Deck' };
    const existingChannel = { record_id: 'channel-1', scope_id: 'scope-1', title: 'Features' };
    const target = store({
      scopes: [existingScope],
      channels: [existingChannel],
      selectedChannelId: 'channel-1',
      messageInput: 'unsent draft',
    });
    const deps = {
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      replaceScopesForOwner: vi.fn(),
      replaceChannelsForOwner: vi.fn(),
      upsertScope: vi.fn(),
      upsertChannel: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(),
      setSyncState: vi.fn(),
    };

    await hydrateTowerPgSyncBundle(target, {
      mode: 'delta',
      next_cursor: 'cursor-11',
      scopes: [],
      channels: [],
      channel_bundles: [],
      tombstones: [],
    }, deps);

    expect(deps.replaceScopesForOwner).not.toHaveBeenCalled();
    expect(deps.replaceChannelsForOwner).not.toHaveBeenCalled();
    expect(deps.upsertScope).not.toHaveBeenCalled();
    expect(deps.upsertChannel).not.toHaveBeenCalled();
    expect(target.applyScopes).not.toHaveBeenCalled();
    expect(target.applyChannels).not.toHaveBeenCalled();
    expect(target.selectedChannelId).toBe('channel-1');
    expect(target.messageInput).toBe('unsent draft');
  });

  it('merges changed delta navigation rows without dropping other live destinations', async () => {
    const target = store({
      scopes: [
        { record_id: 'scope-1', title: 'Flight Deck' },
        { record_id: 'scope-2', title: 'Operations' },
      ],
      channels: [
        { record_id: 'channel-1', scope_id: 'scope-1', title: 'Features' },
        { record_id: 'channel-2', scope_id: 'scope-2', title: 'Ops' },
      ],
    });
    const deps = {
      runWorkspaceSyncTransaction: vi.fn(async (callback) => callback()),
      upsertScope: vi.fn(),
      upsertChannel: vi.fn(),
      deleteTowerPgSyncTombstones: vi.fn(),
    };

    await hydrateTowerPgSyncBundle(target, {
      mode: 'delta',
      scopes: [{ id: 'scope-1', name: 'Flight Deck updated' }],
      channels: [{ id: 'channel-1', scope_id: 'scope-1', name: 'Features updated' }],
      channel_bundles: [],
      tombstones: [],
    }, deps);

    expect(deps.upsertScope).toHaveBeenCalledOnce();
    expect(deps.upsertChannel).toHaveBeenCalledOnce();
    expect(target.applyScopes).not.toHaveBeenCalled();
    expect(target.applyChannels).not.toHaveBeenCalled();
  });
});

it('skips unadvertised session health and enables it after a descriptor refresh', async () => {
  const target = store();
  target.currentWorkspace.capabilities = ['pg_chat'];
  const read = vi.fn(async () => ({ agent_sessions: [] }));
  const replace = vi.fn(async () => 0);
  const deps = { getTowerPgAgentSessionHealth: read, replacePgAgentSessionHealthForChannel: replace };
  await hydrateTowerPgAgentSessionHealth(target, 'channel-1', deps);
  await hydrateTowerPgAgentSessionHealth(target, 'channel-2', deps);
  expect(read).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  target.currentWorkspace.capabilities.push('pg_agent_session_health');
  await hydrateTowerPgAgentSessionHealth(target, 'channel-1', deps);
  expect(read).toHaveBeenCalledOnce();
});

it('bounds stale reaction SSE reads and recovers a restored target after expiry', async () => {
  const target = store();
  const missing = Object.assign(new Error('missing channel'), { status: 400,
    responseText: JSON.stringify({ code: 'resource-not-found', required_permission: 'channel.read' }) });
  const read = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue({ reactions: [] });
  const replace = vi.fn(async () => 0);
  const deps = { getTowerPgReactions: read, replacePgReactionsForTarget: replace };
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await hydrateTowerPgReactionTarget(target, 'message', 'stale', deps);
    await hydrateTowerPgReactionTarget(target, 'message', 'stale', deps);
    expect(read).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
    now.mockReturnValue(31_001);
    await hydrateTowerPgReactionTarget(target, 'message', 'stale', deps);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { now.mockRestore(); }
});

it.each([
  [403, { code: 'permission_denied', reason: 'resource-not-found', required_permission: 'channel.read' }],
  [400, { code: 'resource-not-found', required_permission: 'task.read' }],
  [400, { code: 'invalid_request', required_permission: 'channel.read' }],
])('preserves a genuine reaction error %s %j', async (status, payload) => {
  const error = Object.assign(new Error('reaction read failed'), { status, responseText: JSON.stringify(payload) });
  const replace = vi.fn();
  await expect(hydrateTowerPgReactionTarget(store(), 'message', 'target', {
    getTowerPgReactions: async () => { throw error; }, replacePgReactionsForTarget: replace,
  })).rejects.toBe(error);
  expect(replace).not.toHaveBeenCalled();
});

it('uses the sync request owner for SSE message reads and never acknowledges deferred hydration', async () => {
  const target = store({ requestTowerSyncFamily: vi.fn(async () => ({ deferred: true })) });
  await expect(hydrateTowerPgEventUpdates(target, [{ entity_type: 'message', entity_id: 'message-1', channel_id: 'channel-1', payload: {} }]))
    .rejects.toMatchObject({ code: 'pg_read_authority_changed' });
  expect(target.requestTowerSyncFamily).toHaveBeenCalledWith('channel-messages', 'channel-1', { force: true });
});

it('settles missing optional targets alongside valid core events without inventing deletion authority', async () => {
  const target = store({ requestTowerSyncFamily: vi.fn(async () => ['committed']) });
  const missing = Object.assign(new Error('missing channel'), { status: 400, payload: {
    code: 'resource-not-found', required_permission: 'channel.read', identity: { workspace_id: 'workspace-1' },
  } });
  const replacePgResponseActivitiesForTarget = vi.fn();
  const upsertWorkroom = vi.fn();
  const result = await hydrateTowerPgEventUpdates(target, [
    { entity_type: 'message', entity_id: 'valid', channel_id: 'channel-1' },
    { entity_type: 'response_activity', payload: { response_activity: { id: 'activity-1', target_type: 'chat_thread', target_id: 'gone', channel_id: 'channel-1', status: 'working' } } },
    { entity_type: 'workroom', entity_id: 'gone-room' },
  ], { getTowerPgResponseActivities: async () => { throw missing; }, getTowerPgWorkroom: async () => { throw missing; }, replacePgResponseActivitiesForTarget, upsertWorkroom });
  expect(target.requestTowerSyncFamily).toHaveBeenCalledWith('channel-messages', 'channel-1', expect.anything());
  expect(result.absentTargets).toHaveLength(2);
  expect(result.optionalFailures).toBeUndefined();
  expect(replacePgResponseActivitiesForTarget).not.toHaveBeenCalled();
  expect(upsertWorkroom).not.toHaveBeenCalled();
});

it.each([
  [400, { code: 'bad_request', required_permission: 'channel.read', identity: { workspace_id: 'workspace-1' } }],
  [403, { code: 'permission_denied', required_permission: 'channel.read', identity: { workspace_id: 'workspace-1' } }],
  [400, { code: 'resource-not-found', required_permission: 'task.read', identity: { workspace_id: 'workspace-1' } }],
  [400, { code: 'resource-not-found', required_permission: 'channel.read', identity: { workspace_id: 'other-workspace' } }],
  [503, {}],
])('retains optional target error %s while core events commit', async (status, payload) => {
  const error = Object.assign(new Error('source failure'), { status, payload });
  const target = store({ requestTowerSyncFamily: vi.fn(async () => ['committed']) });
  const result = await hydrateTowerPgEventUpdates(target, [
    { entity_type: 'message', channel_id: 'channel-1' }, { entity_type: 'workroom', entity_id: 'room-1' },
  ], { getTowerPgWorkroom: async () => { throw error; } });
  expect(result.absentTargets).toBeUndefined();
  expect(result.optionalFailures[0].error).toBe(error);
  expect(target.requestTowerSyncFamily).toHaveBeenCalledTimes(1);
});

it('waits for unfinished core writes before returning a failed SSE batch', async () => {
  let finish;
  let committed = false;
  const target = store({ requestTowerSyncFamily: async (_family, id) => {
    if (id === 'bad') throw new Error('core failed');
    await new Promise(resolve => { finish = resolve; }); committed = true;
  } });
  const run = hydrateTowerPgEventUpdates(target, [{ entity_type: 'message', channel_id: 'bad' }, { entity_type: 'message', channel_id: 'good' }]);
  await Promise.resolve(); expect(committed).toBe(false); finish();
  await expect(run).rejects.toThrow('core failed'); expect(committed).toBe(true);
});
