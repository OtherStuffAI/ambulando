import { describe, expect, it, vi } from 'vitest';

import {
  clearRuntimeData,
  deleteWorkspaceDb,
  openWorkspaceDb,
  getWorkspaceDb,
  getWorkspaceMembers,
  replaceWorkspaceMembers,
  runWorkspaceSyncTransaction,
  upsertMessage,
  upsertWappActivityItem,
  upsertWappActivityMute,
} from '../src/db.js';
import { rankMainFeedMessages } from '../src/chat-order.js';
import { getSectionLiveQueryPlan, sectionLiveQueryMixin } from '../src/section-live-queries.js';

describe('section live query plan', () => {
  it('commits workspace-member reconciliation inside the workspace sync transaction', async () => {
    const workspaceDbKey = 'section-live-query-members-parent-transaction';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    try {
      const members = [{ actor_id: 'actor-1', workspace_id: 'workspace-1', npub: 'npub1alice', role: 'member' }];
      await runWorkspaceSyncTransaction(() => replaceWorkspaceMembers('workspace-1', members));
      expect(await getWorkspaceMembers('workspace-1')).toEqual(members);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('skips physical workspace-member writes when Tower returns the same authority snapshot', async () => {
    const workspaceDbKey = 'section-live-query-members-zero-write';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    const table = getWorkspaceDb().workspace_members;
    let writes = 0;
    const onCreating = () => { writes += 1; };
    const onUpdating = () => { writes += 1; };
    table.hook('creating', onCreating);
    table.hook('updating', onUpdating);
    try {
      const members = [{ actor_id: 'actor-1', workspace_id: 'workspace-1', npub: 'npub1alice', role: 'member' }];
      await replaceWorkspaceMembers('workspace-1', members);
      expect(writes).toBe(1);
      writes = 0;
      await replaceWorkspaceMembers('workspace-1', members);
      expect(writes).toBe(0);
      expect(await getWorkspaceMembers('workspace-1')).toEqual(members);
    } finally {
      table.hook('creating').unsubscribe(onCreating);
      table.hook('updating').unsubscribe(onUpdating);
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps only chat list and active detail subscriptions hot on the chat route', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'chat',
      selectedChannelId: 'channel-1',
      applyAddressBookPeople() {},
    });

    expect(plan.shared).toEqual(['app-placements', 'address-book']);
    expect(plan.workspace).toEqual(['ws:personal-wapps', 'ws:scopes', 'ws:channels', 'ws:groups', 'ws:daily-notes', 'ws:record-attention', 'chat:audio-notes']);
    expect(plan.detail).toEqual([
      'chat:messages:channel-1:undefined:undefined:',
      'chat:reactions:channel-1',
      'chat:channel-response-activities:channel-1',
      'chat:agent-activities:channel-1',
      'chat:agent-session-health:channel-1',
    ]);
  });

  it('suppresses unchanged navigation projections across a realistic paged snapshot cadence', async () => {
    const workspaceDbKey = 'section-live-query-paged-navigation';
    const subscriptions = [];
    const store = {
      currentWorkspaceKey: workspaceDbKey,
      workspaceOwnerNpub: 'npub1owner',
      navSection: 'chat',
      selectedChannelId: 'channel-1',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn((query, onNext, options = {}) => {
        let delivered = false;
        let previous;
        const subscription = {
          query,
          deliver(value) {
            if (delivered && options.equals?.(previous, value)) return;
            delivered = true;
            previous = value;
            onNext(value);
          },
          unsubscribe() {},
        };
        subscriptions.push(subscription);
        return subscription;
      }),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      applyScopes: vi.fn(),
      applyChannels: vi.fn(),
      applyAudioNotes: vi.fn(),
      applyMessages: vi.fn(),
      applyReactions: vi.fn(),
      applyChannelResponseActivities: vi.fn(),
      applyAgentActivities: vi.fn(),
    };

    openWorkspaceDb(workspaceDbKey);
    try {
      sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
      const scopeSubscription = subscriptions.find(({ query }) => query.toString().includes('getScopesByOwner'));
      const channelSubscription = subscriptions.find(({ query }) => query.toString().includes('getChannelsByOwner'));
      expect(scopeSubscription).toBeTruthy();
      expect(channelSubscription).toBeTruthy();

      for (let page = 0; page < 33; page += 1) {
        scopeSubscription.deliver([{ record_id: 'scope-1', owner_npub: 'npub1owner', title: 'Flight Deck' }]);
        channelSubscription.deliver([{ record_id: 'channel-1', owner_npub: 'npub1owner', title: 'Performance' }]);
      }

      expect(store.applyScopes).toHaveBeenCalledTimes(1);
      expect(store.applyChannels).toHaveBeenCalledTimes(1);

      channelSubscription.deliver([{ record_id: 'channel-1', owner_npub: 'npub1owner', title: 'Performance updated' }]);
      expect(store.applyChannels).toHaveBeenCalledTimes(2);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps every materialised root when replies exceed the main feed page size', async () => {
    const workspaceDbKey = 'section-live-query-complete-chat-history';
    const channelId = 'testagent-dm';
    const subscriptions = [];
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();

    try {
      const roots = [
        {
          record_id: 'older-root', channel_id: channelId, parent_message_id: null,
          updated_at: '2026-07-01T00:00:00.000Z', record_state: 'active',
        },
        {
          record_id: 'recent-root', channel_id: channelId, parent_message_id: null,
          updated_at: '2026-07-02T00:00:00.000Z', record_state: 'active',
        },
      ];
      const replies = Array.from({ length: 80 }, (_, index) => ({
        record_id: `recent-reply-${index + 1}`,
        channel_id: channelId,
        parent_message_id: 'recent-root',
        updated_at: new Date(Date.UTC(2026, 6, 3, 0, index)).toISOString(),
        record_state: 'active',
      }));
      for (const message of [...roots, ...replies]) await upsertMessage(message);

      const store = {
        currentWorkspaceKey: workspaceDbKey,
        workspaceOwnerNpub: 'npub1owner',
        navSection: 'chat',
        selectedChannelId: channelId,
        mainFeedVisibleCount: 80,
        MAIN_FEED_PAGE_SIZE: 80,
        startSharedLiveQueries: vi.fn(),
        createLiveSubscription: vi.fn((query, onNext, options) => {
          subscriptions.push({ query, onNext, options });
          return { unsubscribe() {} };
        }),
        stopLiveSubscription: vi.fn(),
        initUnreadTracking: vi.fn(),
        applyScopes: vi.fn(),
        applyChannels: vi.fn(),
        applyAudioNotes: vi.fn(),
        applyMessages: vi.fn(),
        applyReactions: vi.fn(),
        applyChannelResponseActivities: vi.fn(),
        applyAgentActivities: vi.fn(),
      };

      sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
      const messageSubscription = subscriptions.find((entry) => (
        entry.query.toString().includes('getMessagePresentationWindowByChannel')
      ));
      const materialisedMessages = await messageSubscription.query();

      expect(materialisedMessages).toHaveLength(82);
      expect(rankMainFeedMessages(materialisedMessages).map((message) => message.record_id)).toEqual([
        'older-root',
        'recent-root',
      ]);
      expect(materialisedMessages.filter((message) => message.parent_message_id === 'recent-root')).toHaveLength(80);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('subscribes to active thread response activities by PG thread id when available', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'chat',
      selectedChannelId: 'channel-1',
      activeThreadId: 'root-message-1',
      messages: [{ record_id: 'root-message-1', pg_thread_id: 'pg-thread-1' }],
      applyAddressBookPeople() {},
    });

    expect(plan.detail).toContain('chat:response-activities:pg-thread-1');
  });

  it('keeps agent activity live for a thread opened over Deck', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'status',
      deckThreadChannelId: 'channel-1',
      activeThreadId: 'root-message-1',
      applyAddressBookPeople() {},
    });

    expect(plan.detail).toEqual([
      'deck:messages:channel-1:root-message-1:6:0',
      'deck:reactions:channel-1:root-message-1:6:0',
      'deck:response-activities:root-message-1:0',
      'deck:agent-activities:channel-1:root-message-1:0',
      'deck:agent-session-health:channel-1:root-message-1:0',
    ]);
  });

  it('subscribes to all current scope channels on chat scope home', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'chat',
      selectedChannelId: null,
      pgContextChannels: [
        { record_id: 'channel-a' },
        { record_id: 'channel-b' },
      ],
      applyAddressBookPeople() {},
    });

    expect(plan.detail).toEqual([
      'chat:messages:scope-home:channel-a,channel-b:undefined:undefined',
      'chat:reactions:scope-home:channel-a,channel-b',
    ]);
  });

  it('switches task route to its own workspace slices and keeps disabled reports cold', () => {
    const taskPlan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'tasks',
      activeTaskId: 'task-1',
      applyAddressBookPeople() {},
    });
    expect(taskPlan.workspace).toEqual(['ws:personal-wapps', 'ws:scopes', 'ws:channels', 'ws:groups', 'ws:daily-notes', 'ws:record-attention', 'tasks:tasks::50:manual:::::false', 'tasks:documents']);
    expect(taskPlan.detail).toEqual([
      'tasks:selected-task:task-1',
      'tasks:comments:task-1:undefined',
      'tasks:comment-reactions:task-1:undefined',
    ]);

    const reportPlan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'reports',
      selectedReportId: 'report-1',
      applyAddressBookPeople() {},
    });
    expect(reportPlan.workspace).toEqual(['ws:personal-wapps', 'ws:scopes', 'ws:channels', 'ws:groups', 'ws:daily-notes', 'ws:record-attention']);
    expect(reportPlan.detail).toEqual([]);
  });

  it('keeps the flight deck route subscribed to the records it renders', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'status',
      applyAddressBookPeople() {},
    });

    expect(plan.shared).toEqual(['app-placements', 'address-book']);
    expect(plan.workspace).toEqual([
      'ws:personal-wapps',
      'ws:scopes',
      'ws:channels',
      'ws:groups',
      'ws:daily-notes', 'ws:record-attention',
      'status:recent-channels',
      'status:messages:100:all:::0',
      'status:comments:100:all:::0',
      'status:directories',
      'status:documents:100:all:::0',
      'status:tasks:100:all:::0',
      'status:wapp-activity',
    ]);
    expect(plan.detail).toEqual([]);
  });

  it('applies one workspace-guarded WApp projection from Dexie', async () => {
    const subscriptions = [];
    const store = {
      currentWorkspaceKey: 'wapp-workspace-a',
      workspaceOwnerNpub: 'npub-owner-a',
      navSection: 'status',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn((query, onNext) => {
        subscriptions.push({ query, onNext });
        return { unsubscribe() {} };
      }),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      applyScopes: vi.fn(), applyChannels: vi.fn(), applyFileMessages: vi.fn(), applyFileComments: vi.fn(),
      applyDirectories: vi.fn(), applyDocuments: vi.fn(), applyTasks: vi.fn(), applyReports: vi.fn(), applySchedules: vi.fn(),
      applyWappActivityProjection: vi.fn(),
      resetWappActivityProjection: vi.fn(),
    };
    openWorkspaceDb(store.currentWorkspaceKey);
    await clearRuntimeData();
    await upsertWappActivityItem({ record_id: 'item-a', wapp_installation_id: 'install-a', category: 'lead', unread: true, occurred_at: '2026-08-04T00:00:00.000Z' });
    await upsertWappActivityMute({ record_id: 'category:lead', target_type: 'category', target_value: 'lead' });

    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    const subscription = subscriptions.find((entry) => entry.query.toString().includes('getWappActivityProjection'));
    const projection = await subscription.query();
    subscription.onNext(projection);

    expect(store.applyWappActivityProjection).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ record_id: 'item-a', muted: true })],
      counts: { unread: 0 },
      mutes: [expect.objectContaining({ record_id: 'category:lead' })],
    }));

    store.currentWorkspaceKey = 'wapp-workspace-b';
    store.workspaceOwnerNpub = 'npub-owner-b';
    openWorkspaceDb(store.currentWorkspaceKey);
    await clearRuntimeData();
    subscription.onNext(projection);
    expect(store.applyWappActivityProjection).toHaveBeenCalledTimes(1);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    expect(store.resetWappActivityProjection).toHaveBeenCalledTimes(2);
  });

  it('keeps doc comments cold until a document is open', () => {
    const browserPlan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'docs',
      selectedDocType: null,
      selectedDocId: null,
      applyAddressBookPeople() {},
    });
    expect(browserPlan.workspace).toEqual(['ws:personal-wapps', 'ws:scopes', 'ws:channels', 'ws:groups', 'ws:daily-notes', 'ws:record-attention', 'docs:directories', 'docs:documents']);
    expect(browserPlan.detail).toEqual([]);

    const detailPlan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'docs',
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      applyAddressBookPeople() {},
    });
    expect(detailPlan.detail).toEqual([
      'docs:selected-doc:doc-1',
      'docs:comments:doc-1:undefined',
      'docs:comment-reactions:doc-1:undefined',
    ]);
  });

  it('keeps disabled settings surfaces cold in the settings section', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'settings',
      applyAddressBookPeople() {},
    });

    expect(plan.workspace).toEqual([
      'ws:personal-wapps',
      'ws:scopes',
      'ws:channels',
      'ws:groups',
      'ws:daily-notes', 'ws:record-attention',
      'settings:wapp-publishing-grants',
    ]);
    expect(plan.detail).toEqual([]);
  });

  it('keeps PG file folders hot on the files route', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      currentWorkspace: { workspaceId: 'workspace-1' },
      navSection: 'files',
      applyAddressBookPeople() {},
    });

    expect(plan.workspace).toEqual([
      'ws:personal-wapps',
      'ws:scopes',
      'ws:channels',
      'ws:groups',
      'ws:daily-notes',
      'ws:members',
      'ws:autopilot-connections',
      'ws:workspace-agents',
      'ws:record-attention',
      'files:messages:100',
      'files:comments:100',
      'files:audio-notes',
      'files:directories',
      'files:documents:100',
      'files:file-folders',
      'files:tasks:100',
    ]);
  });

  it('keeps disabled CRM records cold on the opportunities route', () => {
    const plan = getSectionLiveQueryPlan({
      workspaceOwnerNpub: 'npub-owner',
      navSection: 'opportunities',
      activeOpportunityId: 'opp-1',
      applyAddressBookPeople() {},
    });

    expect(plan.workspace).toEqual(['ws:personal-wapps', 'ws:scopes', 'ws:channels', 'ws:groups', 'ws:daily-notes', 'ws:record-attention']);
    expect(plan.detail).toEqual([]);
  });

  it('stops workspace subscriptions when the workspace key changes', () => {
    const subscriptions = [];
    const store = {
      currentWorkspaceKey: 'workspace-a',
      workspaceOwnerNpub: 'npub1owner',
      navSection: 'chat',
      selectedChannelId: 'channel-a',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn(() => {
        const subscription = { unsubscribe: vi.fn() };
        subscriptions.push(subscription);
        return subscription;
      }),
      stopLiveSubscription: vi.fn((subscription) => subscription.unsubscribe()),
      initUnreadTracking: vi.fn(),
      applyScopes: vi.fn(),
      applyChannels: vi.fn(),
      applyAudioNotes: vi.fn(),
      applyMessages: vi.fn(),
      applyReactions: vi.fn(),
      applyChannelResponseActivities: vi.fn(),
    };

    openWorkspaceDb('workspace-a');
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    expect(subscriptions.length).toBeGreaterThan(0);
    const messageSubscriptionCall = store.createLiveSubscription.mock.calls.find((call) => (
      typeof call[2]?.equals === 'function'
    ));
    expect(messageSubscriptionCall).toBeTruthy();
    expect(messageSubscriptionCall[2].equals(
      [{ record_id: 'message-1', body: 'same' }],
      [{ body: 'same', record_id: 'message-1' }],
    )).toBe(true);
    expect(messageSubscriptionCall[2].equals(
      [{ record_id: 'message-1', body: 'before' }],
      [{ record_id: 'message-1', body: 'after' }],
    )).toBe(false);

    store.currentWorkspaceKey = 'workspace-b';
    openWorkspaceDb('workspace-b');
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);

    expect(subscriptions[0].unsubscribe).toHaveBeenCalled();
    expect(store.stopLiveSubscription).toHaveBeenCalled();
  });

  it('kicks Tower PG hydration when a workspace is restored from cache', async () => {
    const store = {
      currentWorkspace: {
        pgBackendMode: true,
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
        workspaceId: 'workspace-1',
      },
      currentWorkspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' },
      backendUrl: 'https://tower.example',
      navSection: 'tasks',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []),
      refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []),
      requestTowerSyncFamily: vi.fn(async () => []),
      refreshTasks: vi.fn(async () => []),
      refreshDocuments: vi.fn(async () => []),
      refreshAudioNotes: vi.fn(async () => []),
    };

    openWorkspaceDb(store.currentWorkspaceKey);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.refreshGroups).toHaveBeenCalledWith({ force: true, minIntervalMs: 0 });
    expect(store.refreshScopes).toHaveBeenCalledTimes(1);
    expect(store.refreshChannels).toHaveBeenCalledTimes(1);
    expect(store.requestTowerSyncFamily).toHaveBeenCalledWith('wapp-activity', '', { force: true });
    expect(store.requestTowerSyncFamily).toHaveBeenCalledWith('personal-wapps', '', { force: true });
    expect(store.refreshTasks).not.toHaveBeenCalled();
    expect(store.refreshDocuments).not.toHaveBeenCalled();
    expect(store.refreshAudioNotes).not.toHaveBeenCalled();
  });

  it('uses the canonical Tower PG control-plane loader on restored workspaces', async () => {
    const store = {
      currentWorkspace: {
        pgBackendMode: true,
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
        workspaceId: 'workspace-1',
      },
      currentWorkspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' },
      backendUrl: 'https://tower.example',
      navSection: 'status',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []),
      refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []),
      requestTowerSyncFamily: vi.fn(async () => []),
      ensureTowerPgControlPlaneHydrated: vi.fn(async () => ({ scopes: [], channels: [] })),
    };

    openWorkspaceDb(store.currentWorkspaceKey);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.ensureTowerPgControlPlaneHydrated).toHaveBeenCalledWith({ force: true, syncRoute: false });
    expect(store.refreshScopes).not.toHaveBeenCalled();
    expect(store.refreshChannels).not.toHaveBeenCalled();
  });

  it('keeps Tower PG task board activation local-first after workspace hydration', async () => {
    const store = {
      currentWorkspace: {
        pgBackendMode: true,
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
        workspaceId: 'workspace-1',
      },
      currentWorkspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      selectedBoardId: 'scope-1',
      session: { npub: 'npub1user' },
      backendUrl: 'https://tower.example',
      navSection: 'chat',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []),
      refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []),
      refreshTasks: vi.fn(async () => []),
      refreshDocuments: vi.fn(async () => []),
      refreshAudioNotes: vi.fn(async () => []),
    };

    openWorkspaceDb(store.currentWorkspaceKey);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.refreshTasks).not.toHaveBeenCalled();

    store.navSection = 'tasks';
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.refreshTasks).not.toHaveBeenCalled();
  });

  it('refreshes Tower PG files when the files route becomes active', async () => {
    const store = {
      currentWorkspace: {
        pgBackendMode: true,
        workspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
        workspaceId: 'workspace-1',
      },
      currentWorkspaceKey: 'pg:npub1user::tower:npub1tower::workspace:npub1workspace::app:flightdeck_pg',
      workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' },
      backendUrl: 'https://tower.example',
      navSection: 'files',
      pgContextSelectedChannelId: 'channel-1',
      startSharedLiveQueries: vi.fn(),
      createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(),
      initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []),
      refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []),
      refreshTasks: vi.fn(async () => []),
      refreshDocuments: vi.fn(async () => []),
      refreshAudioNotes: vi.fn(async () => []),
    };

    openWorkspaceDb(store.currentWorkspaceKey);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.refreshDocuments).toHaveBeenCalled();
  });
});
