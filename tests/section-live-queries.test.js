import { describe, expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';

import {
  clearRuntimeData,
  deleteWorkspaceDb,
  openWorkspaceDb,
  getWorkspaceDb,
  getWorkspaceMembers,
  replaceWorkspaceMembers,
  runWorkspaceSyncTransaction,
  upsertMessage,
} from '../src/db.js';
import { rankMainFeedMessages } from '../src/chat-order.js';
import { getSectionLiveQueryPlan, sectionLiveQueryMixin } from '../src/section-live-queries.js';

describe('section live query plan', () => {
  it('delivers warm and late Dexie members without a remote refresh and fences old workspace delivery', async () => {
    const key = 'mention-members-live-hydration';
    openWorkspaceDb(key);
    await clearRuntimeData();
    const members = [{ actor_id: 'agent', workspace_id: 'workspace', npub: 'npub1agent', kind: 'agent' }];
    await replaceWorkspaceMembers('workspace', members);
    const callbacks = [];
    const store = {
      currentWorkspaceKey: key, workspaceOwnerNpub: 'owner', _workspaceSelectionGeneration: 1,
      currentWorkspace: { workspaceId: 'workspace' }, navSection: 'none',
      startSharedLiveQueries() {}, applyScopes() {}, applyChannels() {},
      refreshActiveMentionResults: vi.fn(),
      createLiveSubscription(query, onNext) {
        callbacks.push(onNext);
        return liveQuery(query).subscribe({ next: onNext, error: error => { throw error; } });
      },
      stopLiveSubscription(subscription) { subscription.unsubscribe(); },
    };
    try {
      sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
      await vi.waitFor(() => expect(store.pgWorkspaceMembers).toEqual(members));
      await replaceWorkspaceMembers('workspace', [{ ...members[0], display_name: 'Late Profile' }]);
      await vi.waitFor(() => expect(store.pgWorkspaceMembers[0].display_name).toBe('Late Profile'));
      await replaceWorkspaceMembers('workspace', []);
      await vi.waitFor(() => expect(store.pgWorkspaceMembers).toEqual([]));
      expect(store.refreshActiveMentionResults).toHaveBeenCalledTimes(3);
      store.currentWorkspaceKey = 'different-workspace';
      store._workspaceSelectionGeneration++;
      const count = store.refreshActiveMentionResults.mock.calls.length;
      // Replaying an old subscription after the switch cannot publish members.
      for (const callback of callbacks) await callback(members);
      expect(store.pgWorkspaceMembers).toEqual([]);
      expect(store.refreshActiveMentionResults).toHaveBeenCalledTimes(count);
    } finally {
      sectionLiveQueryMixin.stopWorkspaceLiveQueries.call(store);
      await deleteWorkspaceDb(key);
    }
  });

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
      'chat:messages:scope-home:channel-a,channel-b:undefined:undefined:::0:',
      'chat:reactions:scope-home:channel-a,channel-b:0::',
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
    ]);
    expect(plan.detail).toEqual([]);
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
      'ws:archived-targets', 'ws:scope-order',
      'ws:personal-wapps',
      'ws:pg-navigation',
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
    expect(store.requestTowerSyncFamily).toHaveBeenCalledWith('personal-wapps', '', { force: true });
    expect(store.refreshTasks).toHaveBeenCalledTimes(1);
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

    expect(store.refreshTasks).toHaveBeenCalledTimes(1);
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

  it('refreshes Tower PG documents when the Docs route becomes active', async () => {
    const store = {
      currentWorkspace: { pgBackendMode: true, workspaceKey: 'docs-refresh', workspaceId: 'workspace-1' },
      currentWorkspaceKey: 'docs-refresh', workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' }, backendUrl: 'https://tower.example', navSection: 'docs',
      startSharedLiveQueries: vi.fn(), createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(), initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []), refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []), refreshDocuments: vi.fn(async () => []),
    };
    openWorkspaceDb(store.currentWorkspaceKey);
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.refreshDocuments).toHaveBeenCalledTimes(1);
  });

  it('keeps cached Tasks visible and exposes an actionable signing failure during refresh', async () => {
    const store = {
      currentWorkspace: { pgBackendMode: true, workspaceKey: 'tasks-auth-error', workspaceId: 'workspace-1' },
      currentWorkspaceKey: 'tasks-auth-error', workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1user' }, backendUrl: 'https://tower.example', navSection: 'tasks',
      selectedBoardId: '__all__', pgNavigationRecoveryPending: true,
      startSharedLiveQueries: vi.fn(), createLiveSubscription: vi.fn(() => ({ unsubscribe() {} })),
      stopLiveSubscription: vi.fn(), initUnreadTracking: vi.fn(),
      loadLocalWorkspaceCoreData: vi.fn(async () => ({ scopes: [], channels: [] })),
      refreshGroups: vi.fn(async () => []), refreshScopes: vi.fn(async () => []),
      refreshChannels: vi.fn(async () => []),
      refreshTasks: vi.fn(async () => { throw Object.assign(new Error('NIP-98 signing timed out'), { status: 401, code: 'auth_timeout' }); }),
    };
    openWorkspaceDb(store.currentWorkspaceKey);
    await getWorkspaceDb().tasks.put({ record_id: 'cached-task', owner_npub: 'npub1owner', title: 'Cached task', state: 'ready', record_state: 'active' });
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    const pages = await Promise.all(store.createLiveSubscription.mock.calls.map(async ([query]) => {
      try { return await query(); } catch { return null; }
    }));
    const page = pages.find((value) => Array.isArray(value?.rows)
      && value.rows.some((row) => row.record_id === 'cached-task'));
    expect(page).toBeTruthy();
    expect(page.rows.map((row) => row.record_id)).toContain('cached-task');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.sectionRefreshError).toContain('browser signing was interrupted');
  });
});

// Checkpoint repair must not suspend local downloaded subscriptions.
describe('retained chat during checkpoint recovery', () => {
  it.each(['chat', 'status'])('keeps downloaded %s messages subscribed while recovery is pending', (navSection) => {
    const store = { workspaceOwnerNpub: 'owner', currentWorkspaceKey: 'workspace', navSection,
      selectedChannelId: 'channel', activeThreadId: 'root', deckThreadChannelId: 'channel',
      pgNavigationRecoveryPending: true };
    const plan = getSectionLiveQueryPlan(store);
    expect(plan.detail.some(key => key.startsWith(navSection === 'chat' ? 'chat:messages:' : 'deck:messages:'))).toBe(true);
  });

  it.each(['tasks', 'docs'])('keeps downloaded %s detail subscribed while recovery is pending', (navSection) => {
    const store = { workspaceOwnerNpub: 'owner', currentWorkspaceKey: 'workspace', navSection,
      selectedBoardId: '__all__', activeTaskId: navSection === 'tasks' ? 'task-1' : null,
      selectedDocId: navSection === 'docs' ? 'doc-1' : null, commentVisibleCount: 80,
      selectedDocType: navSection === 'docs' ? 'document' : null,
      pgNavigationRecoveryPending: true };
    const plan = getSectionLiveQueryPlan(store);
    expect(plan.detail.some(key => key.startsWith(navSection === 'tasks' ? 'tasks:selected-task:' : 'docs:selected-doc:'))).toBe(true);
  });
});

it('starts identity-scoped public notifications while workspace-owner metadata is pending', async () => {
  const workspaceKey = 'notifications-before-owner-metadata';
  openWorkspaceDb(workspaceKey);
  try {
    const store = {
      currentWorkspaceKey: workspaceKey,
      workspaceOwnerNpub: '',
      startNostrNotifications: vi.fn(),
      createLiveSubscription: vi.fn(),
      stopLiveSubscription: vi.fn(),
    };
    sectionLiveQueryMixin.startWorkspaceLiveQueries.call(store);
    expect(store.startNostrNotifications).toHaveBeenCalledOnce();
    expect(store.createLiveSubscription).not.toHaveBeenCalled();
  } finally {
    await deleteWorkspaceDb(workspaceKey);
  }
});

describe('scope chat presentation lifecycle', () => {
  async function setup() {
    const key = 'scope-chat-live-lifecycle';
    openWorkspaceDb(key);
    await clearRuntimeData();
    const subscriptions = [];
    const store = {
      currentWorkspaceKey: key, workspaceOwnerNpub: 'owner', navSection: 'chat',
      selectedBoardId: 'A', selectedChannelId: null, channelSelectionGeneration: 1,
      pgContextChannels: [{ record_id: 'a' }], messages: [],
      startSharedLiveQueries() {}, initUnreadTracking() {},
      createLiveSubscription(query, onNext, options) {
        const subscription = { query, onNext, options, unsubscribe() {} };
        subscriptions.push(subscription);
        return subscription;
      },
      stopLiveSubscription: vi.fn(),
      applyMessages: vi.fn(async function(rows) { this.messages = rows; }),
      applyReactions: vi.fn(), saveCurrentChatPresentation: vi.fn(),
      startWorkspaceLiveQueries() { sectionLiveQueryMixin.startWorkspaceLiveQueries.call(this); },
    };
    const start = () => {
      store.startWorkspaceLiveQueries();
      return subscriptions.filter(s => s.query.toString().includes('getMessagePresentationWindowByChannels')).at(-1);
    };
    return { key, store, subscriptions, start };
  }
  it('rejects A > B > A callbacks and late workspace/error callbacks', async () => {
    const { key, store, start } = await setup();
    try {
      const a = start();
      store.selectedBoardId = 'B'; store.channelSelectionGeneration++;
      store.pgContextChannels = [{ record_id: 'b' }];
      const b = start();
      store.selectedBoardId = 'A'; store.channelSelectionGeneration++;
      store.pgContextChannels = [{ record_id: 'a' }];
      const current = start();
      await a.onNext([{ record_id: 'stale-a' }]);
      await b.onNext([{ record_id: 'stale-b' }]);
      a.options.onError(new Error('stale error'));
      expect(store.applyMessages).not.toHaveBeenCalled();
      expect(store.chatScopeLoadError).toBeUndefined();
      await current.onNext([{ record_id: 'current-a', channel_id: 'a' }]);
      expect(store.messages.map(row => row.record_id)).toEqual(['current-a']);
      expect(store.pendingChannelSelectionId).toBe('');
      store.pgNavigationGeneration = 'revoked-generation';
      await current.onNext([{ record_id: 'revoked' }]);
      expect(store.applyMessages).toHaveBeenCalledTimes(1);
      store.currentWorkspaceKey = 'other';
      await current.onNext([{ record_id: 'wrong-workspace' }]);
      expect(store.applyMessages).toHaveBeenCalledTimes(1);
    } finally { await deleteWorkspaceDb(key); }
  });
  it('rebinds a scope query when first navigation authority arrives without changing channels', async () => {
    const { key, store, subscriptions, start } = await setup();
    try {
      const initial = start();
      store.applyScopes = async () => {};
      store.applyChannels = async () => {};
      store.pgNavigationGeneration = null;
      await sectionLiveQueryMixin.applyPgNavigationProjection.call(store, {
        scopes: [], channels: [{ record_id: 'a' }], generation: 'first-generation', pending: false,
      });
      const current = subscriptions.filter(s => s.query.toString().includes('getMessagePresentationWindowByChannels')).at(-1);
      expect(current).not.toBe(initial);
      await initial.onNext([{ record_id: 'stale', channel_id: 'a' }]);
      expect(store.applyMessages).not.toHaveBeenCalled();
      await current.onNext([{ record_id: 'current', channel_id: 'a' }]);
      expect(store.messages.map(row => row.record_id)).toEqual(['current']);
    } finally { await deleteWorkspaceDb(key); }
  });

  it('finishes empty scopes and terminates pending state on a current read error', async () => {
    const { key, store, start } = await setup();
    try {
      store.pgContextChannels = [];
      store.pendingChannelSelectionId = 'scope:A';
      const empty = start();
      await empty.onNext(await empty.query());
      expect(store.messages).toEqual([]);
      expect(store.pendingChannelSelectionId).toBe('');
      store.pendingChannelSelectionId = 'scope:A';
      empty.options.onError(new Error('IndexedDB failed'));
      expect(store.pendingChannelSelectionId).toBe('');
      expect(store.chatScopeLoadError).toContain('Select the scope again');
    } finally { await deleteWorkspaceDb(key); }
  });
  it('uses applied IDs for reactions without another presentation read and observes added targets', async () => {
    const { key, store, subscriptions, start } = await setup();
    try {
      await upsertMessage({ record_id: 'root', channel_id: 'a', updated_at: '2026-10-01T00:00:00Z' });
      const current = start();
      await current.onNext(await current.query());
      const reads = vi.spyOn(getWorkspaceDb().chat_messages, 'where');
      const reaction = subscriptions.filter(s => s.query.toString().includes('getReactionsByTargets')).at(-1);
      await reaction.query();
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      const count = subscriptions.length;
      await current.onNext([{ record_id: 'root', channel_id: 'a' }, { record_id: 'incoming', channel_id: 'a' }]);
      expect(subscriptions.length).toBe(count + 1); // replace reaction targets only
      expect(store.applyMessages).toHaveBeenCalledTimes(2);
    } finally { await deleteWorkspaceDb(key); }
  });
});

it('keeps embedded conversation/access/member queries and excludes shell work, with no hidden observers',()=>{
  const store={canvasChatEmbedded:true,canvasChatVisible:true,workspaceOwnerNpub:'owner',currentWorkspaceKey:'key',currentWorkspace:{workspaceId:'workspace'},navSection:'status',deckThreadChannelId:'channel',activeThreadId:'root'};
  const plan=getSectionLiveQueryPlan(store);
  expect(plan.shared).toEqual(['address-book']);
  expect(plan.workspace).toEqual(expect.arrayContaining(['ws:pg-navigation','ws:groups','ws:members']));
  expect(plan.workspace.some(key=>/status:|wapps|daily|scope-order|attention/.test(key))).toBe(false);
  expect(plan.detail.some(key=>key.startsWith('deck:messages:'))).toBe(true);
  store.canvasChatVisible=false;
  expect(getSectionLiveQueryPlan(store)).toEqual({shared:[],workspace:[],detail:[]});
});
