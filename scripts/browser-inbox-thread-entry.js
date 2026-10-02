// Production store and handlers; only startup/auth and transport are isolated.
import Alpine from 'alpinejs';
import { installStableHtml } from '../src/stable-html.js';
import { initApp } from '../src/app.js';
import { openWorkspaceDb } from '../src/db.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { readTowerPgThreadHistoryPage } from '../src/pg-read-hydrator.js';
import { TowerPgMaterializationWorkerClient } from '../src/tower-pg-materialization-worker-client.js';
import './browser-inbox-activity-entry.js';

window.startThreadProbe = async ({ worker, workspaceId }) => {
  const db = openWorkspaceDb('inbox-browser');
  await db.open();
  window.probeDb = db;
  const register = Alpine.store.bind(Alpine);
  Alpine.store = function(name, value) {
    if (value && name === 'chat') {
      value.init = () => {}; // Do not connect to a real workspace or load auth.
      value.knownWorkspaces = [{ workspaceKey: 'inbox-browser', workspaceId, workspaceOwnerNpub: 'npub1owner', directHttpsUrl: 'http://localhost:1', pgBackendMode: true }];
      value.selectedWorkspaceKey = 'inbox-browser';
      value.backendUrl = 'http://localhost:1';
      value.routeSyncPaused = true;
      value.navSection = 'status';
      value.selectedBoardId = 'all';
      value.selectedChannelId = 'unrelated-channel';
      value.session = { npub: 'npub1viewer' };
    }
    return arguments.length > 1 ? register(name, value) : register(name);
  };
  installStableHtml(Alpine);
  initApp();
  Alpine.store = register;
  const store = Alpine.store('chat');
  window.probeStore = store;
  const client = new TowerPgMaterializationWorkerClient({ workspaceKey: 'inbox-browser', workerFactory: () => new Worker(`/assets/${worker}`, { type: 'module' }) });
  window.materializeThreadProbe = bundle => client.materialize({ workspaceDbKey: 'inbox-browser', store: { workspaceOwnerNpub: 'npub1owner', session: { npub: 'npub1viewer' }, currentWorkspace: { workspaceId } }, bundle });
  window.threadReads = [];
  window.threadRemote = {};
  store._towerSyncService = new TowerSyncService({ workspaceKey: [store.backendUrl, store.workspaceDbKey, workspaceId].join('|'), families: {
    'thread-history-page': {
      load: (_, options) => readTowerPgThreadHistoryPage(store, options.channelId, options.threadId, {
        ...options,
        getTowerPgThread: async () => window.threadRemote[options.threadId]?.thread || window.threadFixtures?.[options.threadId]?.thread || { id: options.threadId, channel_id: options.channelId, workspace_id: workspaceId },
        getTowerPgChannelMessages: async (_, __, request) => {
          window.threadReads.push({ threadId: options.threadId, ...request });
          const remote = window.threadRemote[options.threadId];
          if (remote?.delay) await new Promise(resolve => setTimeout(resolve, remote.delay));
          if (!remote) throw Error('Offline verification: cached conversation');
          const offset = Number(request.cursor || 0);
          return { messages: remote.messages.slice(offset, offset + request.limit), next_cursor: offset + request.limit < remote.messages.length ? String(offset + request.limit) : null };
        },
      }),
      materialize: window.materializeThreadProbe,
    },
  } });
  store.startWorkspaceLiveQueries();
};
