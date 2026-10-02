import { disposeContextTreeView, resumeContextTreeView } from './context-tree-view.js';
import {
  getAddressBookPeople,
  getChannelsByOwner,
  getCommentsByOwner,
  getMessagesByChannel,
  getThreadMessagePresentationWindow,
  getMessagePresentationWindowByChannel,
  getMessagePresentationWindowByChannels,
  getMessagesByOwner,
  getAudioNotesByOwner,
  getDailyNotesByOwner,
  getGroupsByOwner,
  getDirectoriesByOwner,
  getDocumentsByOwner,
  getDocumentById,
  getFileFoldersByWorkspace,
  getWindowedDocumentsByOwner,
  getReportById,
  getWindowedReportsByOwner,
  getTaskById,
  getTasksByOwner,
  getTaskBoardWindow,
  taskWithoutIndexFields,
  getOwnerActivityWindow,
  getRecentChannelActivity,
  getActivityThreadAttention,
  getWorkspaceDb,
  getSchedulesByOwner,
  getScopesByOwner,
  getCommentsByTarget,
  getReactionsByTargets,
  getResponseActivitiesForChannel,
  getResponseActivitiesForTarget,
  getAgentActivitiesForChannel,
  getAgentSessionHealthForChannel,
  getWappPublishingGrants,
  getWappActivityProjection,
  getWappsByOwner,
  getWorkspaceMembers,
  getWorkroomsByWorkspace,
  getWorkroomParticipants,
  getWorkroomEvents,
  getWorkroomLinks,
  getPendingWorkroomApprovals,
  isWorkspaceDbOpenForKey,
  getAutopilotConnectionsByWorkspace,
  getWorkspaceAgentsByWorkspace,
} from './db.js';
import { recordFamilyHash } from './translators/chat.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { isFlightDeckSurfaceDisabled } from './disabled-surfaces.js';
import { flightDeckLog } from './logging.js';
import { parsePgTaskBoardId, resolvePgThreadId } from './pg-record-context.js';
import { sameLogicalValue } from './utils/state-helpers.js';
import { normalizeInboxSearchText, scopeMatches, buildAutopilotOverviewThreads, buildAutopilotOverviewTasks, buildAutopilotOverviewDocuments,
  buildAutopilotOverviewFiles, buildAutopilotOverviewInbox, filterAutopilotOverviewInbox, normalizeDeckInboxTypes } from './autopilot-overview-manager.js';
import { buildFileBrowserRows } from './files-manager.js';

const SECTION_STATE = new WeakMap();

// Apply card classification, scope and search while selecting source candidates,
// before the bounded display prefix. Unrelated types cannot keep paging alive.
export async function queryInboxSource(store, ownerNpub, tableName) {
  const types = normalizeDeckInboxTypes(store.deckInboxType);
  if (!types.length) return { rows: [], hasMore: false };
  const context = store.autopilotOverviewContext || {};
  const channels = await getChannelsByOwner(ownerNpub);
  const scopes = await getScopesByOwner(ownerNpub);
  const options = { selectedScopeId: context.scopeId, selectedChannelId: context.channelId,
    scopesMap: new Map(scopes.map(row => [row.record_id, row])) };
  const type = types.length === 1 ? types[0] : 'all';
  const scoped = context.scopeId && !['all', '__all__'].includes(context.scopeId);
  const scopeIds = scoped ? (context.scopeId === '__unscoped__' ? [''] : scopes
    .filter(row => scopeMatches(row.record_id, context.scopeId, options.scopesMap)).map(row => row.record_id)) : undefined;
  const sourceOptions = { scopeIds, search: type === 'file' ? 'storage://' : normalizeInboxSearchText(store.deckInboxSearchQuery), filesOnly: type === 'file', channelId: context.channelId && context.channelId !== 'all' ? context.channelId : undefined };

  const sourceTypes = { chat_messages: ['chat', 'file'], tasks: ['task', 'file'], documents: ['document', 'file'], comments: ['task', 'document', 'file'] };
  if (!sourceTypes[tableName]?.some(type => types.includes(type))) return { rows: [], hasMore: false };
  const matches = (row, comments = []) => {
    const sources = { channels, documents: [], tasks: [], fileMessages: [], fileComments: comments };
    sources[{ chat_messages: 'fileMessages', comments: 'fileComments', tasks: 'tasks', documents: 'documents' }[tableName]] = [row];
    const cards = buildAutopilotOverviewInbox({
      threads: buildAutopilotOverviewThreads({ ...options, channels, messages: sources.fileMessages }),
      tasks: buildAutopilotOverviewTasks({ ...options, tasks: sources.tasks, comments }),
      documents: buildAutopilotOverviewDocuments({ ...options, documents: sources.documents, comments }),
      files: buildAutopilotOverviewFiles(buildFileBrowserRows(sources), options),
    });
    return filterAutopilotOverviewInbox(cards, store.deckInboxSearchQuery, types).length > 0;
  };
  // Comments enrich the selected parent cards; they are not independent Inbox
  // cards and must never advertise another page by themselves.
  if (tableName === 'comments') {
    const parents = await Promise.all(['tasks', 'documents'].map(name => queryInboxSource(store, ownerNpub, name)));
    const pages = await Promise.all(parents.flatMap(page => page.rows).map(row => getCommentsByTarget(row.record_id, { limit: 100 })));
    if (types.includes('file')) {
      const attachments = await getOwnerActivityWindow('comments', ownerNpub, {
        limit: store.inboxActivityVisibleCount || 100, matches, ...sourceOptions, filesOnly: true,
      });
      return { rows: [...new Map([...pages.flat(), ...attachments.rows].map(row => [row.record_id, row])).values()], hasMore: attachments.hasMore };
    }
    return { rows: pages.flat(), hasMore: false };
  }
  const page = await getOwnerActivityWindow(tableName, ownerNpub, {
    limit: store.inboxActivityVisibleCount || 100, matches, ...sourceOptions,
    channels: channels.filter(row => scopeMatches(row.scope_id, context.scopeId, options.scopesMap)
      && (!context.channelId || context.channelId === 'all' || row.record_id === context.channelId)),
    groupThreads: tableName === 'chat_messages' && type !== 'file',
    kind: tableName === 'documents' && ['file', 'document'].includes(type) ? type : undefined,
  });
  if (['tasks', 'documents'].includes(tableName) && type !== 'file') {
    const family = recordFamilyHash(tableName === 'tasks' ? 'task' : 'document');
    const needle = normalizeInboxSearchText(store.deckInboxSearchQuery);
    const seen = new Set();
    const activity = await getOwnerActivityWindow('comments', ownerNpub, {
      limit: store.inboxActivityVisibleCount || 100, ...sourceOptions, kind: family,
      matches: row => {
        if (row.target_record_family_hash !== family || seen.has(row.target_record_id)) return false;
        if (!scopeMatches(row.pg_scope_id, context.scopeId, options.scopesMap)) return false;
        if (context.channelId && context.channelId !== 'all' && row.pg_channel_id !== context.channelId) return false;
        if (needle && !normalizeInboxSearchText(row.body).includes(needle)) return false;
        seen.add(row.target_record_id); return true;
      },
    });
    const parents = (await getWorkspaceDb().table(tableName).bulkGet(activity.rows.map(row => row.target_record_id)))
      .filter(row => row && row.record_state !== 'deleted' && matches(row, activity.rows));
    page.rows = [...new Map([...page.rows, ...parents].map(row => [row.record_id, row])).values()];
    page.hasMore ||= activity.hasMore;
  }
  if (tableName === 'chat_messages') page.unreadThreads = await getActivityThreadAttention(page.rows);
  return page;
}

function getSectionState(store) {
  let state = SECTION_STATE.get(store);
  if (!state) {
    state = {
      shared: new Map(),
      workspace: new Map(),
      detail: new Map(),
      workspaceKey: '',
      workspaceOwnerNpub: '',
      pgHydratingWorkspaceKeys: new Set(),
      pgHydratedWorkspaceKeys: new Set(),
      pgRefreshingTaskBoardKeys: new Set(),
      pgTaskBoardRefreshAt: new Map(),
      pgRefreshingFilesKeys: new Set(),
      pgFilesRefreshAt: new Map(),
    };
    SECTION_STATE.set(store, state);
  }
  return state;
}

function stopSubscription(store, subscription) {
  if (!subscription || typeof store?.stopLiveSubscription !== 'function') return;
  store.stopLiveSubscription(subscription);
}

function syncBucket(store, bucket, specs) {
  const desiredKeys = new Set();

  for (const spec of specs) {
    if (!spec?.key) continue;
    desiredKeys.add(spec.key);
    if (bucket.has(spec.key)) continue;
    const workspaceKey = store.currentWorkspaceKey;
    const generation = store._workspaceSelectionGeneration;
    const subscription = store.createLiveSubscription(spec.query, (...args) => {
      if (spec.key !== 'address-book') {
        if (store.currentWorkspaceKey !== workspaceKey || store._workspaceSelectionGeneration !== generation) return;
      }
      return spec.onNext(...args);
    }, {
      equals: spec.equals,
    });
    bucket.set(spec.key, subscription);
  }

  for (const [key, subscription] of bucket.entries()) {
    if (desiredKeys.has(key)) continue;
    stopSubscription(store, subscription);
    bucket.delete(key);
  }
}

function stopBucket(store, bucket) {
  for (const subscription of bucket.values()) {
    stopSubscription(store, subscription);
  }
  bucket.clear();
}

function currentWorkspaceKey(store) {
  return String(store?.currentWorkspaceKey || '').trim();
}

function currentPgWorkspaceId(store) {
  return String(store?.currentWorkspace?.workspaceId || store?.workspaceId || '').trim();
}

function isSameWorkspace(store, workspaceKey, ownerNpub) {
  return currentWorkspaceKey(store) === workspaceKey
    && String(store?.workspaceOwnerNpub || '').trim() === ownerNpub;
}

function scheduleTowerPgWorkspaceHydration(store, state) {
  if (!isTowerPgBackendMode()) return;
  if (!store?.currentWorkspace?.pgBackendMode) return;
  if (!store?.session?.npub) return;
  if (!store?.backendUrl) return;
  const workspaceKey = String(store.currentWorkspaceKey || store.currentWorkspace?.workspaceKey || '').trim();
  if (!workspaceKey) return;
  if (!isWorkspaceDbOpenForKey(workspaceKey)) return;
  if (state.pgHydratingWorkspaceKeys.has(workspaceKey) || state.pgHydratedWorkspaceKeys.has(workspaceKey)) return;

  state.pgHydratingWorkspaceKeys.add(workspaceKey);
  Promise.resolve()
    .then(async () => {
      if (String(store.currentWorkspaceKey || '') !== workspaceKey) return;
      await store.loadLocalWorkspaceCoreData?.({ syncRoute: false });
      if (String(store.currentWorkspaceKey || '') !== workspaceKey) return;
      await store.refreshGroups?.({ force: true, minIntervalMs: 0 });
      await (store.ensureTowerPgControlPlaneHydrated?.({ force: true, syncRoute: false }) ?? Promise.all([
        store.refreshScopes?.(),
        store.refreshChannels?.(),
      ]));
      store.getTowerSyncService?.();
      state.pgHydratedWorkspaceKeys.add(workspaceKey);
      const optionalRefreshes = [
        ['wapp-activity', () => store.requestTowerSyncFamily?.('wapp-activity', '', { force: true })],
        ['personal-wapps', () => store.requestTowerSyncFamily?.('personal-wapps', '', { force: true })],
        ...(store.canAdminWorkspace ? [['wapp-publishing', () => store.requestTowerSyncFamily?.('wapp-publishing-grants', '', { force: true })]] : []),
      ];
      await Promise.all(optionalRefreshes.map(async ([label, refresh]) => {
        try {
          await refresh();
        } catch (error) {
          flightDeckLog('debug', 'pg', 'optional Tower PG hydration refresh failed', {
            workspaceKey,
            surface: label,
            error: error?.message || String(error),
          });
        }
      }));
    })
    .catch((error) => {
      state.pgHydratedWorkspaceKeys.delete(workspaceKey);
      flightDeckLog('warn', 'pg', 'Tower PG workspace hydration failed after live-query startup', {
        workspaceKey,
        error: error?.message || String(error),
      });
    })
    .finally(() => {
      state.pgHydratingWorkspaceKeys.delete(workspaceKey);
    });
}

const PG_TASK_BOARD_REFRESH_MIN_MS = 5000;
const PG_FILES_REFRESH_MIN_MS = 5000;

function buildTowerPgTaskBoardRefreshKey(store) {
  const workspaceKey = String(store?.currentWorkspaceKey || store?.currentWorkspace?.workspaceKey || '').trim();
  if (!workspaceKey) return '';
  const boardId = String(store?.selectedBoardId || store?.preferredTaskBoardId || '').trim();
  return boardId ? `${workspaceKey}:tasks:${boardId}` : `${workspaceKey}:tasks`;
}

function scheduleTowerPgTaskBoardRefresh(store, state) {
  if (!isTowerPgBackendMode()) return;
  if (store?.navSection !== 'tasks') return;
  if (!store?.currentWorkspace?.pgBackendMode) return;
  if (!store?.session?.npub) return;
  if (!store?.backendUrl) return;
  if (typeof store?.refreshTasks !== 'function') return;
  const workspaceKey = String(store.currentWorkspaceKey || store.currentWorkspace?.workspaceKey || '').trim();
  if (!workspaceKey || !isWorkspaceDbOpenForKey(workspaceKey)) return;
  if (state.pgHydratingWorkspaceKeys.has(workspaceKey)) return;

  const refreshKey = buildTowerPgTaskBoardRefreshKey(store);
  if (!refreshKey || state.pgRefreshingTaskBoardKeys.has(refreshKey)) return;
  const lastRefreshAt = Number(state.pgTaskBoardRefreshAt.get(refreshKey) || 0);
  if (Date.now() - lastRefreshAt < PG_TASK_BOARD_REFRESH_MIN_MS) return;

  state.pgRefreshingTaskBoardKeys.add(refreshKey);
  state.pgTaskBoardRefreshAt.set(refreshKey, Date.now());
  Promise.resolve()
    .then(async () => {
      if (String(store.currentWorkspaceKey || '') !== workspaceKey) return;
      await store.refreshTasks();
    })
    .catch((error) => {
      flightDeckLog('debug', 'pg', 'Tower PG task board refresh failed after route activation', {
        workspaceKey,
        boardId: String(store?.selectedBoardId || ''),
        error: error?.message || String(error),
      });
    })
    .finally(() => {
      state.pgRefreshingTaskBoardKeys.delete(refreshKey);
    });
}

function buildTowerPgFilesRefreshKey(store) {
  const workspaceKey = String(store?.currentWorkspaceKey || store?.currentWorkspace?.workspaceKey || '').trim();
  if (!workspaceKey) return '';
  const channelId = String(store?.pgContextSelectedChannelId || '').trim();
  return channelId ? `${workspaceKey}:files:${channelId}` : `${workspaceKey}:files`;
}

function scheduleTowerPgFilesRefresh(store, state) {
  if (!isTowerPgBackendMode()) return;
  if (store?.navSection !== 'files') return;
  if (!store?.currentWorkspace?.pgBackendMode) return;
  if (!store?.session?.npub) return;
  if (!store?.backendUrl) return;
  if (typeof store?.refreshDocuments !== 'function') return;
  const workspaceKey = String(store.currentWorkspaceKey || store.currentWorkspace?.workspaceKey || '').trim();
  if (!workspaceKey || !isWorkspaceDbOpenForKey(workspaceKey)) return;

  const refreshKey = buildTowerPgFilesRefreshKey(store);
  if (!refreshKey || state.pgRefreshingFilesKeys.has(refreshKey)) return;
  const lastRefreshAt = Number(state.pgFilesRefreshAt.get(refreshKey) || 0);
  if (Date.now() - lastRefreshAt < PG_FILES_REFRESH_MIN_MS) return;

  state.pgRefreshingFilesKeys.add(refreshKey);
  state.pgFilesRefreshAt.set(refreshKey, Date.now());
  Promise.resolve()
    .then(async () => {
      if (String(store.currentWorkspaceKey || '') !== workspaceKey) return;
      await store.refreshDocuments();
    })
    .catch((error) => {
      flightDeckLog('debug', 'pg', 'Tower PG files refresh failed after route activation', {
        workspaceKey,
        channelId: String(store?.pgContextSelectedChannelId || ''),
        error: error?.message || String(error),
      });
    })
    .finally(() => {
      state.pgRefreshingFilesKeys.delete(refreshKey);
    });
}

function buildSharedSpecs() {
  return [
    {
      key: 'address-book',
      query: () => getAddressBookPeople(),
      onNext: (people) => this.applyAddressBookPeople(people),
    },
  ];
}

function buildWorkspaceSpecs(store) {
  const ownerNpub = String(store?.workspaceOwnerNpub || '').trim();
  const workspaceKey = currentWorkspaceKey(store);
  if (!ownerNpub) return [];

  const alwaysOn = [
    {
      key: 'ws:personal-wapps',
      query: () => getWappsByOwner(ownerNpub),
      onNext: (wapps) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.applyWapps?.(wapps);
      },
    },
    {
      key: 'ws:scopes',
      equals: sameLogicalValue,
      query: () => getScopesByOwner(ownerNpub),
      onNext: (scopes) => store.applyScopes(scopes),
    },
    {
      key: 'ws:channels',
      equals: sameLogicalValue,
      query: () => getChannelsByOwner(ownerNpub),
      onNext: (channels) => store.applyChannels(channels),
    },
    {
      key: 'ws:groups',
      query: () => getGroupsByOwner(ownerNpub),
      onNext: (groups) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.groups = groups;
      },
    },
    {
      key: 'ws:daily-notes',
      query: () => getDailyNotesByOwner(ownerNpub),
      onNext: (dailyNotes) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.applyDailyNotes?.(dailyNotes);
      },
    },
    ...(currentPgWorkspaceId(store) ? [{
      key: 'ws:members',
      query: () => getWorkspaceMembers(currentPgWorkspaceId(store)),
      onNext: (members) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.pgWorkspaceMembers = members;
        store.refreshActiveMentionResults?.();
        store.scheduleTowerPgUnreadProjectionRefresh?.();
      },
    }, {
      key: 'ws:autopilot-connections',
      query: () => getAutopilotConnectionsByWorkspace(currentPgWorkspaceId(store)),
      onNext: (connections) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.agentConnections = connections;
        void store.startThreadLiveActivity?.();
        if (store.navSection === 'agents' && (store.controlledRestartAvailability === 'idle'
          || (!store.controlledRestartConnectionId && connections.length > 0))) {
          void store.initializeControlledRestartLifecycle?.();
        }
        if (store.navSection === 'agents' && store.selectedWorkspaceAgentId && !store.agentSpaceLoading && !store.agentSpaceData) {
          void store.loadSelectedAgentSpaceView?.();
        }
      },
    }, {
      key: 'ws:workspace-agents',
      query: () => getWorkspaceAgentsByWorkspace(currentPgWorkspaceId(store), { visibleOnly: true }),
      onNext: (agents) => {
        if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
        store.workspaceAgents = agents;
        void store.startThreadLiveActivity?.();
        if (store.navSection === 'agents' && !store.selectedWorkspaceAgentId && agents[0]) store.selectedWorkspaceAgentId = agents[0].id;
        if (store.navSection === 'agents' && store.selectedWorkspaceAgentId && !store.agentSpaceLoading && !store.agentSpaceData) {
          void store.loadSelectedAgentSpaceView?.();
        }
      },
    }] : []),
  ];

  const inboxKey = `${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || 'all'}:${store.deckInboxSearchQuery || ''}:${store.deckInboxCurrentContextKey || ''}:${store.inboxActivityQueryRevision || 0}`;
  const inboxGuard = () => isSameWorkspace(store, workspaceKey, ownerNpub)
    && inboxKey === `${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || 'all'}:${store.deckInboxSearchQuery || ''}:${store.deckInboxCurrentContextKey || ''}:${store.inboxActivityQueryRevision || 0}`;
  let sectionSpecs;
  switch (store?.navSection) {
    case 'status':
      sectionSpecs = [
        {
          key: 'status:recent-channels',
          query: async () => {
            const rows = await getRecentChannelActivity(ownerNpub);
            return { rows, unreadThreads: await getActivityThreadAttention(rows) };
          },
          onNext: page => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
            store.recentChannelMessages = page.rows;
            store.recentChannelUnreadThreads = page.unreadThreads;
          },
        },
        {
          key: `status:messages:${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || "all"}:${store.deckInboxSearchQuery || ""}:${store.deckInboxCurrentContextKey || ""}:${store.inboxActivityQueryRevision || 0}`,
          // Dexie needs an async querier to track attention reads after awaits.
          query: async () => await queryInboxSource(store, ownerNpub, 'chat_messages'),
          onNext: (page) => {
            if (!inboxGuard()) return;
            store.inboxActivityPageHasMore = { ...store.inboxActivityPageHasMore, messages: page.hasMore };
            store.inboxActivityLoading = Object.keys(store.inboxActivityPageHasMore).length < 4;
            store.inboxUnreadThreads = page.unreadThreads || {};
            return store.applyFileMessages(page.rows);
          },
        },
        {
          key: `status:comments:${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || "all"}:${store.deckInboxSearchQuery || ""}:${store.deckInboxCurrentContextKey || ""}:${store.inboxActivityQueryRevision || 0}`,
          query: () => queryInboxSource(store, ownerNpub, 'comments'),
          onNext: (page) => {
            if (!inboxGuard()) return;
            store.inboxActivityPageHasMore = { ...store.inboxActivityPageHasMore, comments: page.hasMore };
            store.inboxActivityLoading = Object.keys(store.inboxActivityPageHasMore).length < 4;
            return store.applyFileComments(page.rows);
          },
        },
        {
          key: 'status:directories',
          query: () => getDirectoriesByOwner(ownerNpub),
          onNext: (directories) => store.applyDirectories(directories),
        },
        {
          key: `status:documents:${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || "all"}:${store.deckInboxSearchQuery || ""}:${store.deckInboxCurrentContextKey || ""}:${store.inboxActivityQueryRevision || 0}`,
          query: () => queryInboxSource(store, ownerNpub, 'documents'),
          onNext: (page) => {
            if (!inboxGuard()) return;
            store.inboxActivityPageHasMore = { ...store.inboxActivityPageHasMore, documents: page.hasMore };
            store.inboxActivityLoading = Object.keys(store.inboxActivityPageHasMore).length < 4;
            return store.applyDocuments(page.rows);
          },
        },
        {
          key: `status:tasks:${store.inboxActivityVisibleCount || 100}:${store.deckInboxType || "all"}:${store.deckInboxSearchQuery || ""}:${store.deckInboxCurrentContextKey || ""}:${store.inboxActivityQueryRevision || 0}`,
          query: () => queryInboxSource(store, ownerNpub, 'tasks'),
          onNext: (page) => {
            if (!inboxGuard()) return;
            store.inboxActivityPageHasMore = { ...store.inboxActivityPageHasMore, tasks: page.hasMore };
            store.inboxActivityLoading = Object.keys(store.inboxActivityPageHasMore).length < 4;
            return store.applyTasks(page.rows);
          },
        },
        {
          key: 'status:wapp-activity',
          query: () => getWappActivityProjection(),
          onNext: (projection) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub)) return;
            store.applyWappActivityProjection?.(projection);
          },
        },
      ];
      break;
    case 'chat':
      sectionSpecs = [
        {
          key: 'chat:audio-notes',
          query: () => getAudioNotesByOwner(ownerNpub),
          onNext: (audioNotes) => store.applyAudioNotes(audioNotes),
        },
      ];
      break;
    case 'files':
      sectionSpecs = [
        {
          key: `files:messages:${store.filesActivityVisibleCount || 100}`,
          query: () => getOwnerActivityWindow('chat_messages', ownerNpub, { limit: store.filesActivityVisibleCount || 100 }),
          onNext: (page) => {
            store.filesActivityPageHasMore = { ...store.filesActivityPageHasMore, messages: page.hasMore };
            return store.applyFileMessages(page.rows);
          },
        },
        {
          key: `files:comments:${store.filesActivityVisibleCount || 100}`,
          query: () => getOwnerActivityWindow('comments', ownerNpub, { limit: store.filesActivityVisibleCount || 100 }),
          onNext: (page) => {
            store.filesActivityPageHasMore = { ...store.filesActivityPageHasMore, comments: page.hasMore };
            return store.applyFileComments(page.rows);
          },
        },
        {
          key: 'files:audio-notes',
          query: () => getAudioNotesByOwner(ownerNpub),
          onNext: (audioNotes) => store.applyAudioNotes(audioNotes),
        },
        {
          key: 'files:directories',
          query: () => getDirectoriesByOwner(ownerNpub),
          onNext: (directories) => store.applyDirectories(directories),
        },
        {
          key: `files:documents:${store.filesActivityVisibleCount || 100}`,
          query: () => getOwnerActivityWindow('documents', ownerNpub, { limit: store.filesActivityVisibleCount || 100 }),
          onNext: (page) => {
            store.filesActivityPageHasMore = { ...store.filesActivityPageHasMore, documents: page.hasMore };
            return store.applyDocuments(page.rows);
          },
        },
        {
          key: 'files:file-folders',
          query: () => getFileFoldersByWorkspace(currentPgWorkspaceId(store)),
          onNext: (folders) => store.applyFileFolders(folders),
        },
        {
          key: `files:tasks:${store.filesActivityVisibleCount || 100}`,
          query: () => getOwnerActivityWindow('tasks', ownerNpub, { limit: store.filesActivityVisibleCount || 100 }),
          onNext: (page) => {
            store.filesActivityPageHasMore = { ...store.filesActivityPageHasMore, tasks: page.hasMore };
            return store.applyTasks(page.rows);
          },
        },
      ];
      break;
    case 'docs':
      sectionSpecs = [
        {
          key: 'docs:directories',
          query: () => getDirectoriesByOwner(ownerNpub),
          onNext: (directories) => store.applyDirectories(directories),
        },
        {
          key: 'docs:documents',
          query: () => getDocumentsByOwner(ownerNpub),
          onNext: (documents) => store.applyDocuments(documents),
        },
      ];
      break;
    case 'tasks':
      sectionSpecs = [
        {
          key: `tasks:tasks:${store.selectedBoardId || ''}:${store.taskVisibleCount || 50}:${store.taskSortMode || 'manual'}:${store.taskFilter || ''}:${store.taskFilterState || ''}:${store.taskFilterTags || ''}:${store.taskFilterAssignee || ''}:${store.showBoardDescendantTasks || false}`,
          query: () => queryTaskBoard(store, ownerNpub),
          onNext: (page) => {
            store.taskPageHasMore = page.hasMore;
            store.taskPageCounts = page.counts;
            return store.applyTasks(page.rows);
          },
        },
        {
          key: 'tasks:documents',
          query: () => getWindowedDocumentsByOwner(ownerNpub),
          onNext: (documents) => store.applyDocuments(documents),
        },
      ];
      break;
    case 'settings':
      sectionSpecs = [
        {
          key: 'settings:wapp-publishing-grants',
          query: () => getWappPublishingGrants(),
          onNext: (grants) => store.applyWappPublishingGrants?.(grants),
        },
      ];
      break;
    default:
      sectionSpecs = [];
  }

  if (store?.navSection === 'status' && !isFlightDeckSurfaceDisabled('reports')) {
    sectionSpecs.push({
      key: 'status:reports',
      query: () => getWindowedReportsByOwner(ownerNpub),
      onNext: (reports) => store.applyReports(reports),
    });
  }
  if (store?.navSection === 'status' && !isFlightDeckSurfaceDisabled('schedules')) {
    sectionSpecs.push({
      key: 'status:schedules',
      query: () => getSchedulesByOwner(ownerNpub),
      onNext: (schedules) => store.applySchedules(schedules),
    });
  }
  alwaysOn.push({
    key: 'ws:record-attention',
    query: async () => {
      const { getPgAttentionProjection } = await import('./pg-record-delta.js');
      return getPgAttentionProjection(store);
    },
    onNext: (projection) => store.applyPgAttentionProjection?.(projection),
  });
  return [...alwaysOn, ...sectionSpecs];
}

async function queryTaskBoard(store, ownerNpub) {
  const board = parsePgTaskBoardId(store.selectedBoardId);
  const options = { ownerNpub, channelId: board.channelId, threadId: board.threadId,
    scopeIds: board.type === 'scope' && board.scopeId && !['__all__','__recent__'].includes(board.scopeId)
      ? [board.scopeId === '__unscoped__' ? '' : board.scopeId] : undefined,
    state: store.taskFilterState || undefined, limit: store.taskVisibleCount || 50,
    sortMode: store.taskSortMode || 'manual' };
  if (store.showBoardDescendantTasks && options.scopeIds) {
    const scopes = store.scopes || [];
    const selected = new Set(options.scopeIds);
    for (let depth = 0; depth < 5; depth++) for (const scope of scopes) {
      if (selected.has(scope.parent_id) || ['l1_id','l2_id','l3_id','l4_id','l5_id'].some(key => selected.has(scope[key]))) selected.add(scope.record_id);
    }
    options.scopeIds = [...selected];
  }
  if (!store.taskFilter && !store.taskFilterTags?.length && !store.taskFilterAssignee && store.selectedBoardId !== '__recent__') return getTaskBoardWindow(options);
  // Exact arbitrary substring searches use n-gram candidates. Common/short
  // queries may still match many candidates; no rows are silently excluded.
  const table = getWorkspaceDb().tasks;
  const text = String(store.taskFilter || '').trim().toLowerCase();
  let query;
  if (text) query = table.where('cache_search_tokens').equals(text.slice(0,3));
  else if (store.taskFilterAssignee) query = table.where('cache_assignees').equals(store.taskFilterAssignee);
  else if (store.taskFilterTags?.length) query = table.where('cache_tags').anyOf(store.taskFilterTags.map(t=>t.toLowerCase())).distinct();
  else query = table.where('updated_at').aboveOrEqual(new Date(Date.now()-86400000).toISOString());
  const candidateIds = await query.primaryKeys();
  const { computeBoardScopedTasks, computeFilteredTasks, sortTasksForBoard } = await import('./task-board-state.js');
  const scopesMap = new Map((store.scopes || []).map(s=>[s.record_id,s]));
  const groups = new Map(), counts = {};
  for (let offset = 0; offset < candidateIds.length; offset += 200) {
    const candidates = (await table.bulkGet(candidateIds.slice(offset, offset + 200))).filter(Boolean);
    const scoped = computeBoardScopedTasks(candidates, store.selectedBoardId, scopesMap.get(store.selectedBoardId), scopesMap, store.showBoardDescendantTasks);
    const filtered = computeFilteredTasks(scoped,text,store.taskFilterTags || [],store.taskFilterAssignee,store.taskFilterState);
    for (const row of filtered) {
      const state=row.cache_state || row.state || 'new';
      counts[state]=(counts[state]||0)+1;
      if(!groups.has(state))groups.set(state,[]);
      groups.get(state).push(row);
    }
    for (const [state, rows] of groups) groups.set(state, sortTasksForBoard(rows,options.sortMode).slice(0,options.limit));
    if (offset + 200 < candidateIds.length) await new Promise(resolve=>setTimeout(resolve,0));
  }
  return {rows:[...groups.values()].flat().map(taskWithoutIndexFields),counts,hasMore:Object.values(counts).some(count=>count>options.limit)};
}

function buildDetailSpecs(store) {
  const ownerNpub = String(store?.workspaceOwnerNpub || '').trim();
  const workspaceKey = currentWorkspaceKey(store);
  if (!ownerNpub) return [];

  const deckThreadChannelId = String(store?.deckThreadChannelId || '').trim();
  const deckThreadId = String(store?.activeThreadId || '').trim();
  if (store?.navSection === 'status' && deckThreadChannelId && deckThreadId) {
    const replyLimit = store.threadVisibleReplyCount || store.THREAD_REPLY_PAGE_SIZE || 6;
    const threadId = String(store.deckThreadTowerId || '');
    const openGeneration = store.autopilotOverviewThreadOpenRequestId;
    const isCurrent = () => isSameWorkspace(store, workspaceKey, ownerNpub)
      && store.navSection === 'status'
      && store.deckThreadChannelId === deckThreadChannelId
      && store.activeThreadId === deckThreadId
      && store.autopilotOverviewThreadOpenRequestId === openGeneration;
    const query = () => getThreadMessagePresentationWindow(deckThreadChannelId, deckThreadId, { threadId, replyLimit });
    return [{
      key: `deck:messages:${deckThreadChannelId}:${deckThreadId}:${replyLimit}:${openGeneration || 0}`,
      equals: sameLogicalValue,
      query,
      onNext: messages => {
        if (!isCurrent() || (store.threadVisibleReplyCount || store.THREAD_REPLY_PAGE_SIZE || 6) !== replyLimit) return;
        const result = store.applyMessages(messages, { isCurrent, threadDetail: true });
        void store.startThreadLiveActivity?.();
        return result;
      },
    }, {
      key: `deck:reactions:${deckThreadChannelId}:${deckThreadId}:${replyLimit}:${openGeneration || 0}`,
      query: async () => getReactionsByTargets((await query()).map(row => row.record_id), recordFamilyHash('chat_message')),
      onNext: rows => { if (isCurrent()) return store.applyReactions?.(rows); },
    }, {
      key: `deck:response-activities:${threadId || deckThreadId}:${openGeneration || 0}`,
      query: () => getResponseActivitiesForTarget('chat_thread', threadId || deckThreadId),
      onNext: rows => { if (isCurrent()) return store.applyThreadResponseActivities?.(rows); },
    }, {
      key: `deck:agent-activities:${deckThreadChannelId}:${deckThreadId}:${openGeneration || 0}`,
      query: () => getAgentActivitiesForChannel(deckThreadChannelId),
      onNext: (activities) => {
        if (
          !isSameWorkspace(store, workspaceKey, ownerNpub)
          || store.navSection !== 'status'
          || String(store.deckThreadChannelId || '').trim() !== deckThreadChannelId
          || String(store.activeThreadId || '').trim() !== deckThreadId
        ) return;
        return store.applyAgentActivities?.(activities);
      },
    }, {
      key: `deck:agent-session-health:${deckThreadChannelId}:${deckThreadId}:${openGeneration || 0}`,
      query: () => getAgentSessionHealthForChannel(deckThreadChannelId),
      onNext: (sessions) => { if (isCurrent()) return store.applyAgentSessionHealth?.(sessions); },
    }];
  }

  switch (store?.navSection) {
    case 'chat': {
      const channelId = String(store?.selectedChannelId || '').trim();
      const selectionGeneration = Number(store?.channelSelectionGeneration || 0);
      if (!channelId) {
        const channelIds = (Array.isArray(store?.pgContextChannels) ? store.pgContextChannels : [])
          .map((channel) => String(channel?.record_id || '').trim())
          .filter(Boolean);
        if (channelIds.length === 0) return [];
        const signature = channelIds.join(',');
        return [
          {
            key: `chat:messages:scope-home:${signature}:${store.mainFeedVisibleCount}:${store.threadVisibleReplyCount}`,
            equals: sameLogicalValue,
            query: () => getMessagePresentationWindowByChannels(channelIds, {
              rootLimit: store?.mainFeedVisibleCount || store?.MAIN_FEED_PAGE_SIZE,
              activeThreadId: store?.activeThreadId,
              focusMessageId: store?.focusMessageId,
            }),
            onNext: (messages) => {
              if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId) return;
              return store.applyMessages(messages);
            },
          },
          {
            key: `chat:reactions:scope-home:${signature}`,
            query: async () => {
              const messages = await getMessagePresentationWindowByChannels(channelIds, {
                rootLimit: store?.mainFeedVisibleCount || store?.MAIN_FEED_PAGE_SIZE,
                activeThreadId: store?.activeThreadId,
                focusMessageId: store?.focusMessageId,
              });
              return getReactionsByTargets(
                messages.map((message) => message.record_id).filter(Boolean),
                recordFamilyHash('chat_message'),
              );
            },
            onNext: (reactions) => {
              if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId) return;
              return store.applyReactions(reactions);
            },
          },
        ];
      }
      const activeThreadId = String(store?.activeThreadId || '').trim();
      const specs = [
        {
          key: `chat:messages:${channelId}:${store.mainFeedVisibleCount}:${store.threadVisibleReplyCount}:${activeThreadId}`,
          equals: sameLogicalValue,
          query: async () => {
            const startedAt = globalThis.performance?.now?.() ?? Date.now();
            const messages = await getMessagePresentationWindowByChannel(channelId, {
              rootLimit: store?.mainFeedVisibleCount || store?.MAIN_FEED_PAGE_SIZE,
              replyLimit: store?.threadVisibleReplyCount || store?.THREAD_REPLY_PAGE_SIZE,
              activeThreadId,
              focusMessageId: store?.focusMessageId,
            });
            store.traceFlightDeckTiming?.('channel selection', {
              message: 'live Dexie query end',
              channelId,
              queryDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
              messageCount: messages.length,
            });
            return messages;
          },
          onNext: async (messages) => {
            if (
              !isSameWorkspace(store, workspaceKey, ownerNpub)
              || store.selectedChannelId !== channelId
              || Number(store.channelSelectionGeneration || 0) !== selectionGeneration
            ) return;
            const deriveStartedAt = globalThis.performance?.now?.() ?? Date.now();
            await store.applyMessages(messages, { selectionGeneration, deferEnrichment: true });
            if (Number(store.channelSelectionGeneration || 0) !== selectionGeneration) return;
            store.saveCurrentChatPresentation?.(store.getChatPresentationKey?.(channelId));
            store.traceFlightDeckTiming?.('channel selection', {
              message: 'derived state processing end',
              channelId,
              derivedStateDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - deriveStartedAt,
              renderedRootCount: store.visibleMainFeedMessages?.length || 0,
            });
          },
        },
        {
          key: `chat:reactions:${channelId}`,
          query: async () => {
            return getReactionsByTargets(
              (store.messages || [])
                .filter((message) => message?.channel_id === channelId)
                .map((message) => message.record_id)
                .filter(Boolean),
              recordFamilyHash('chat_message'),
            );
          },
          onNext: (reactions) => {
            if (
              !isSameWorkspace(store, workspaceKey, ownerNpub)
              || store.selectedChannelId !== channelId
              || Number(store.channelSelectionGeneration || 0) !== selectionGeneration
            ) return;
            return store.applyReactions(reactions);
          },
        },
        {
          key: `chat:channel-response-activities:${channelId}`,
          query: () => getResponseActivitiesForChannel(channelId),
          onNext: (activities) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId !== channelId) return;
            return store.applyChannelResponseActivities?.(activities);
          },
        },
        {
          key: `chat:agent-activities:${channelId}`,
          query: () => getAgentActivitiesForChannel(channelId),
          onNext: (activities) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId !== channelId) return;
            return store.applyAgentActivities?.(activities);
          },
        },
        {
          key: `chat:agent-session-health:${channelId}`,
          query: () => getAgentSessionHealthForChannel(channelId),
          onNext: (sessions) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId !== channelId) return;
            return store.applyAgentSessionHealth?.(sessions);
          },
        },
      ];
      if (activeThreadId) {
        const activeActivityThreadId = resolvePgThreadId(store, activeThreadId) || activeThreadId;
        specs.push({
          key: `chat:response-activities:${activeActivityThreadId}`,
          query: () => getResponseActivitiesForTarget('chat_thread', activeActivityThreadId),
          onNext: (activities) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedChannelId !== channelId || store.activeThreadId !== activeThreadId) return;
            return store.applyThreadResponseActivities(activities);
          },
        });
      } else if (typeof store.applyThreadResponseActivities === 'function') {
        store.applyThreadResponseActivities([]);
      }
      return specs;
    }
    case 'tasks': {
      const taskId = String(store?.activeTaskId || '').trim();
      if (!taskId) return [];
      return [
        {
          key: `tasks:selected-task:${taskId}`,
          query: () => getTaskById(taskId),
          onNext: (task) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.activeTaskId !== taskId) return;
            return store.applySelectedTask(task);
          },
        },
        {
          key: `tasks:comments:${taskId}:${store.commentVisibleCount}`,
          query: () => getCommentsByTarget(taskId, { limit: (store.commentVisibleCount || 80) + 1 }),
          onNext: (comments) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.activeTaskId !== taskId) return;
            return store.applyTaskComments(comments);
          },
        },
        {
          key: `tasks:comment-reactions:${taskId}:${store.commentVisibleCount}`,
          query: async () => {
            const comments = await getCommentsByTarget(taskId, { limit: (store.commentVisibleCount || 80) + 1 });
            return getReactionsByTargets(
              comments.map((comment) => comment.record_id).filter(Boolean),
              recordFamilyHash('comment'),
            );
          },
          onNext: (reactions) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.activeTaskId !== taskId) return;
            return store.applyReactions(reactions);
          },
        },
      ];
    }
    case 'docs': {
      if (store?.selectedDocType !== 'document') return [];
      const docId = String(store?.selectedDocId || '').trim();
      if (!docId) return [];
      const documentFamilyHash = recordFamilyHash('document');
      return [
        {
          key: `docs:selected-doc:${docId}`,
          query: () => getDocumentById(docId),
          onNext: (document) => {
            if (
              !isSameWorkspace(store, workspaceKey, ownerNpub)
              || store.selectedDocType !== 'document'
              || store.selectedDocId !== docId
            ) return;
            return store.applySelectedDocument(document);
          },
        },
        {
          key: `docs:comments:${docId}:${store.commentVisibleCount}`,
          query: () => getCommentsByTarget(docId, { limit: (store.commentVisibleCount || 80) + 1, focusId: store.selectedDocCommentId }),
          onNext: (comments) => {
            if (
              !isSameWorkspace(store, workspaceKey, ownerNpub)
              || store.selectedDocType !== 'document'
              || store.selectedDocId !== docId
            ) return;
            return store.applyDocComments(
              comments.filter((comment) => comment.target_record_family_hash === documentFamilyHash),
              { docId, allowBackfill: true },
            );
          },
        },
        {
          key: `docs:comment-reactions:${docId}:${store.commentVisibleCount}`,
          query: async () => {
            const comments = await getCommentsByTarget(docId, { limit: (store.commentVisibleCount || 80) + 1, focusId: store.selectedDocCommentId });
            return getReactionsByTargets(
              comments
                .filter((comment) => comment.target_record_family_hash === documentFamilyHash)
                .map((comment) => comment.record_id)
                .filter(Boolean),
              recordFamilyHash('comment'),
            );
          },
          onNext: (reactions) => {
            if (
              !isSameWorkspace(store, workspaceKey, ownerNpub)
              || store.selectedDocType !== 'document'
              || store.selectedDocId !== docId
            ) return;
            return store.applyReactions(reactions);
          },
        },
      ];
    }
    case 'reports': {
      if (isFlightDeckSurfaceDisabled('reports')) return [];
      const reportId = String(store?.selectedReportId || '').trim();
      if (!reportId) return [];
      return [
        {
          key: `reports:selected-report:${reportId}`,
          query: () => getReportById(reportId),
          onNext: (report) => {
            if (!isSameWorkspace(store, workspaceKey, ownerNpub) || store.selectedReportId !== reportId) return;
            return store.applySelectedReport(report);
          },
        },
      ];
    }
    case 'workroom': {
      const workspaceId = currentPgWorkspaceId(store);
      const workroomId = String(store?.activeWorkroomId || '').trim();
      if (!workspaceId || !workroomId) return [];
      const guard = () => isSameWorkspace(store, workspaceKey, ownerNpub)
        && store.activeWorkroomId === workroomId;
      return [
        {
          key: `workroom:collection:${workspaceId}`,
          query: () => getWorkroomsByWorkspace(workspaceId),
          onNext: (workrooms) => { if (guard()) store.workrooms = workrooms; },
        },
        {
          key: `workroom:participants:${workroomId}`,
          query: () => getWorkroomParticipants(workroomId),
          onNext: (participants) => { if (guard()) store.workroomParticipants = participants; },
        },
        {
          key: `workroom:events:${workroomId}`,
          query: () => getWorkroomEvents(workroomId),
          onNext: (events) => { if (guard()) store.workroomEvents = events; },
        },
        {
          key: `workroom:links:${workroomId}`,
          query: () => getWorkroomLinks(workroomId),
          onNext: (links) => { if (guard()) store.workroomLinks = links; },
        },
        {
          key: `workroom:approvals:${workroomId}`,
          query: () => getPendingWorkroomApprovals({ workroomId }),
          onNext: (approvals) => { if (guard()) store.workroomApprovals = approvals; },
        },
      ];
    }
    default:
      return [];
  }
}

function syncLiveQuerySet(store, bucket, specs) {
  const desiredSpecs = Array.isArray(specs) ? specs : [];
  syncBucket(store, bucket, desiredSpecs);
}

export function getSectionLiveQueryPlan(store) {
  return {
    shared: buildSharedSpecs.call(store).map((spec) => spec.key),
    workspace: buildWorkspaceSpecs(store).map((spec) => spec.key),
    detail: buildDetailSpecs(store).map((spec) => spec.key),
  };
}

export const sectionLiveQueryMixin = {
  startSharedLiveQueries() {
    const state = getSectionState(this);
    syncLiveQuerySet(this, state.shared, buildSharedSpecs.call(this));
  },

  stopSharedLiveQueries() {
    const state = getSectionState(this);
    stopBucket(this, state.shared);
  },

  startWorkspaceLiveQueries() {
    this.startSubscribedReader?.();
    const state = getSectionState(this);
    if (typeof this.startSharedLiveQueries === 'function') {
      this.startSharedLiveQueries();
    }

    const ownerNpub = String(this.workspaceOwnerNpub || '').trim();
    const workspaceKey = String(this.currentWorkspaceKey || '').trim();
    if (state.workspaceKey !== workspaceKey || state.workspaceOwnerNpub !== ownerNpub) {
      stopBucket(this, state.workspace);
      stopBucket(this, state.detail);
      state.workspaceKey = workspaceKey;
      state.workspaceOwnerNpub = ownerNpub;
      this.inboxActivityVisibleCount = 100;
      this.inboxActivityPageHasMore = {};
      this.recentChannelMessages = [];
      this.recentChannelUnreadThreads = {};
      this.inboxUnreadThreads = {};
      this.filesActivityVisibleCount = 100;
      this.filesActivityPageHasMore = {};
      this.deckInboxVisibleCount = 50;
      this.hasBootstrappedUnreadTracking = false;
      this.resetWappActivityProjection?.();
    }

    if (!ownerNpub) {
      disposeContextTreeView(this);
      stopBucket(this, state.workspace);
      stopBucket(this, state.detail);
      return;
    }
    if (!isWorkspaceDbOpenForKey(workspaceKey)) {
      disposeContextTreeView(this);
      stopBucket(this, state.workspace);
      stopBucket(this, state.detail);
      return;
    }

    resumeContextTreeView(this);
    syncLiveQuerySet(this, state.workspace, buildWorkspaceSpecs(this));
    syncLiveQuerySet(this, state.detail, buildDetailSpecs(this));

    if (!this.hasBootstrappedUnreadTracking && typeof this.initUnreadTracking === 'function') {
      this.hasBootstrappedUnreadTracking = true;
      this.initUnreadTracking();
    }

    scheduleTowerPgWorkspaceHydration(this, state);
    scheduleTowerPgFilesRefresh(this, state);
  },

  stopWorkspaceLiveQueries() {
    disposeContextTreeView(this);
    this.disposeSubscribedReader?.();
    const state = getSectionState(this);
    stopBucket(this, state.workspace);
    stopBucket(this, state.detail);
  },

  stopAllLiveQueries() {
    disposeContextTreeView(this);
    this.disposeSubscribedReader?.();
    const state = getSectionState(this);
    stopBucket(this, state.shared);
    stopBucket(this, state.workspace);
    stopBucket(this, state.detail);
    state.workspaceKey = '';
    state.workspaceOwnerNpub = '';
  },

  startSelectedChannelLiveQuery() {
    this.startWorkspaceLiveQueries();
  },

  stopSelectedChannelLiveQuery() {
    const state = getSectionState(this);
    for (const [key, subscription] of state.detail.entries()) {
      if (!key.startsWith('chat:messages:') && !key.startsWith('chat:reactions:')) continue;
      stopSubscription(this, subscription);
      state.detail.delete(key);
    }
  },

  startTaskCommentsLiveQuery() {
    this.startWorkspaceLiveQueries();
  },

  stopTaskCommentsLiveQuery() {
    const state = getSectionState(this);
    for (const [key, subscription] of state.detail.entries()) {
      if (!key.startsWith('tasks:comments:') && !key.startsWith('tasks:comment-reactions:') && !key.startsWith('tasks:selected-task:')) continue;
      stopSubscription(this, subscription);
      state.detail.delete(key);
    }
  },

  startOpportunityCommentsLiveQuery() {
    this.startWorkspaceLiveQueries();
  },

  stopOpportunityCommentsLiveQuery() {
    const state = getSectionState(this);
    for (const [key, subscription] of state.detail.entries()) {
      if (!key.startsWith('opportunities:comments:') && !key.startsWith('opportunities:selected-opportunity:')) continue;
      stopSubscription(this, subscription);
      state.detail.delete(key);
    }
  },

  startDocCommentsLiveQuery() {
    this.startWorkspaceLiveQueries();
  },

  stopDocCommentsLiveQuery() {
    const state = getSectionState(this);
    for (const [key, subscription] of state.detail.entries()) {
      if (!key.startsWith('docs:comments:') && !key.startsWith('docs:comment-reactions:') && !key.startsWith('docs:selected-doc:')) continue;
      stopSubscription(this, subscription);
      state.detail.delete(key);
    }
  },
};
