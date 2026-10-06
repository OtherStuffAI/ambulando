import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShellState, SHELL_STATE_KEYS, SHELL_METHOD_NAMES } from '../src/shell-state.js';
import { taskBoardStateMixin } from '../src/task-board-state.js';

const SHELL_STATE_SOURCE = readFileSync(resolve(process.cwd(), 'src/shell-state.js'), 'utf8');

// ---------------------------------------------------------------------------
// Shell state boundary tests
//
// These tests verify that the shell state extraction from app.js is correct:
// - The shell module exports the expected state keys and lifecycle methods
// - Shell state does not include domain-specific keys
// - Lifecycle methods are callable
// - The state object is suitable for spreading into the assembled store
// ---------------------------------------------------------------------------

describe('shell state exports', () => {
  it('exports createShellState as a function', () => {
    expect(typeof createShellState).toBe('function');
  });

  it('exports SHELL_STATE_KEYS as a frozen array of strings', () => {
    expect(Array.isArray(SHELL_STATE_KEYS)).toBe(true);
    expect(SHELL_STATE_KEYS.length).toBeGreaterThan(0);
    for (const key of SHELL_STATE_KEYS) {
      expect(typeof key).toBe('string');
    }
  });

  it('exports SHELL_METHOD_NAMES as a frozen array of strings', () => {
    expect(Array.isArray(SHELL_METHOD_NAMES)).toBe(true);
    expect(SHELL_METHOD_NAMES.length).toBeGreaterThan(0);
    for (const name of SHELL_METHOD_NAMES) {
      expect(typeof name).toBe('string');
    }
  });
});

describe('shell state object shape', () => {
  it('returns an object with all declared shell state keys', () => {
    const shell = createShellState();
    for (const key of SHELL_STATE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(shell, key);
      expect(descriptor, `missing shell key: ${key}`).toBeDefined();
    }
  });

  it('returns an object with all declared shell methods', () => {
    const shell = createShellState();
    for (const name of SHELL_METHOD_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(shell, name);
      expect(descriptor, `missing shell method: ${name}`).toBeDefined();
      // Methods should be functions (not getters)
      expect(typeof descriptor.value, `${name} should be a function`).toBe('function');
    }
  });

  it('preserves getter descriptors for computed shell properties', () => {
    const shell = createShellState();
    const signingDesc = Object.getOwnPropertyDescriptor(shell, 'signingNpub');
    expect(signingDesc?.get, 'signingNpub should be a getter').toBeDefined();

    const isLoggedInDesc = Object.getOwnPropertyDescriptor(shell, 'isLoggedIn');
    expect(isLoggedInDesc?.get, 'isLoggedIn should be a getter').toBeDefined();
  });
});

describe('shell navigation data retention', () => {
  function buildNavigableShell() {
    const shell = createShellState();
    shell.syncRoute = vi.fn();
    shell.startWorkspaceLiveQueries = vi.fn();
    shell.ensureBackgroundSync = vi.fn();
    shell.refreshStatusRecentChanges = vi.fn();
    shell.markSectionRead = vi.fn();
    shell.validateSelectedBoardId = vi.fn();
    shell.normalizeTaskFilterTags = vi.fn();
    shell.cancelEditSchedule = vi.fn();
    shell.scheduleChatFeedScrollToBottom = vi.fn();
    shell.ensureSelectedChatChannelInScope = vi.fn();
    shell.resetDeckMobileEntry = vi.fn();
    return shell;
  }

  it('resets repeated workspace avatar All entries to the mobile Deck Inbox', async () => {
    const shell = buildNavigableShell();
    shell.selectWorkContextBoard = taskBoardStateMixin.selectWorkContextBoard;
    shell.navSection = 'chat';
    shell.selectBoard = vi.fn(function selectBoard(boardId) {
      this.selectedBoardId = boardId;
    });

    await taskBoardStateMixin.openAllScopesOverview.call(shell);
    await taskBoardStateMixin.openAllScopesOverview.call(shell);

    expect(shell.selectedBoardId).toBe('__all__');
    expect(shell.navSection).toBe('status');
    expect(shell.resetDeckMobileEntry).toHaveBeenCalledTimes(2);
  });

  it('resets repeated scope Home entries to the mobile Deck Inbox', () => {
    const shell = buildNavigableShell();
    shell.navSection = 'chat';
    shell.currentWorkspace = { pgBackendMode: true };
    shell.pgBackendMode = true;
    shell.pgContextScopeId = 'scope-a';
    shell.openPgScopeHome = taskBoardStateMixin.openPgScopeHome;
    shell.selectBoard = vi.fn(function selectBoard(boardId) {
      this.selectedBoardId = boardId;
    });

    taskBoardStateMixin.openDeckScopeHome.call(shell);
    taskBoardStateMixin.openDeckScopeHome.call(shell);

    expect(shell.selectedBoardId).toBe('scope-a');
    expect(shell.navSection).toBe('status');
    expect(shell.resetDeckMobileEntry).toHaveBeenCalledTimes(2);
  });

  it('preserves current status data when navigating to status again', () => {
    const shell = buildNavigableShell();
    const tasks = [{ record_id: 'task-1' }];
    const documents = [{ record_id: 'doc-1' }];
    const fileMessages = [{ record_id: 'message-1' }];
    shell.navSection = 'status';
    shell.tasks = tasks;
    shell.documents = documents;
    shell.fileMessages = fileMessages;
    shell.statusRecentChanges = [{ id: 'change-1' }];

    shell.navigateTo('status');

    expect(shell.tasks).toBe(tasks);
    expect(shell.documents).toBe(documents);
    expect(shell.fileMessages).toBe(fileMessages);
    expect(shell.statusRecentChanges).toEqual([{ id: 'change-1' }]);
    expect(shell.refreshStatusRecentChanges).not.toHaveBeenCalled();
    expect(shell.startWorkspaceLiveQueries).toHaveBeenCalled();
  });

  it('does not refresh status projections or WApp activity during repeated scope changes on the Deck', () => {
    const shell = buildNavigableShell();
    shell.navSection = 'status';
    shell.refreshWappActivity = vi.fn();
    shell.selectBoard = vi.fn(function selectBoard(boardId) {
      this.selectedBoardId = boardId;
    });

    for (let index = 0; index < 25; index += 1) {
      taskBoardStateMixin.selectDeckScope.call(shell, `scope-${index % 5}`);
    }

    expect(shell.selectBoard).toHaveBeenCalledTimes(25);
    expect(shell.refreshStatusRecentChanges).not.toHaveBeenCalled();
    expect(shell.refreshWappActivity).not.toHaveBeenCalled();
    expect(shell.startWorkspaceLiveQueries).toHaveBeenCalledTimes(25);
    expect(shell.ensureBackgroundSync).toHaveBeenCalledTimes(25);
  });

  it('still clears inactive data when changing sections', () => {
    const shell = buildNavigableShell();
    shell.navSection = 'tasks';
    shell.tasks = [{ record_id: 'task-1' }];
    shell.documents = [{ record_id: 'doc-1' }];
    shell.fileMessages = [{ record_id: 'message-1' }];
    shell.statusRecentChanges = [{ id: 'change-1' }];

    shell.navigateTo('status');

    expect(shell.tasks).toEqual([]);
    expect(shell.documents).toEqual([]);
    expect(shell.fileMessages).toEqual([]);
    expect(shell.statusRecentChanges).toEqual([{ id: 'change-1' }]);
    expect(shell.refreshStatusRecentChanges).toHaveBeenCalledWith({ force: true });
  });

  it('closes the selected document before clearing Docs data', () => {
    const shell = buildNavigableShell();
    const order = [];
    shell.navSection = 'docs';
    shell.selectedDocId = 'doc-1';
    shell.closeDocEditor = vi.fn(() => {
      order.push('close');
      shell.selectedDocId = null;
    });
    shell.clearInactiveSectionData = vi.fn(() => order.push('clear'));

    shell.navigateTo('tasks');

    expect(shell.closeDocEditor).toHaveBeenCalledWith({ syncRoute: false });
    expect(order).toEqual(['close', 'clear']);
  });

  it('uses a page route for active workroom detail state', () => {
    const shell = buildNavigableShell();
    Object.defineProperty(shell, 'currentWorkspaceSlug', { value: 'be-free' });
    shell.navSection = 'workroom';
    shell.workroomDetailOpen = true;
    shell.activeWorkroomId = 'room-123';

    expect(shell.getRoutePath()).toBe('/be-free/workroom/room-123');
  });

  it('clears an active workroom page when navigating to the status overview', () => {
    const shell = buildNavigableShell();
    shell.navSection = 'workroom';
    shell.workroomDetailOpen = true;
    shell.activeWorkroomId = 'room-123';
    shell.closeWorkroomDetail = vi.fn();

    shell.navigateTo('status');

    expect(shell.closeWorkroomDetail).toHaveBeenCalledWith({ syncRoute: false, switchView: false });
  });

  it.each(['chat', 'tasks', 'docs'])('keeps the explicit %s primitive directly navigable', (section) => {
    const shell = buildNavigableShell();
    shell.navSection = 'status';
    shell.scopeFilteredChannels = [];

    shell.navigateTo(section);

    expect(shell.navSection).toBe(section);
    expect(shell.syncRoute).toHaveBeenCalled();
  });
});

describe('Deck thread route history', () => {
  it('serializes a Deck modal thread without changing the Deck route', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: 'https://flightdeck.example/be-free/flight-deck?scopeid=scope-a' },
    };
    try {
      const shell = createShellState({ initialSection: 'status' });
      Object.defineProperty(shell, 'currentWorkspaceSlug', { value: 'be-free' });
      shell.selectedBoardId = 'scope-a';
      shell.activeThreadId = 'thread-a';
      shell.deckThreadChannelId = 'channel-a';

      expect(shell.buildRouteUrl()).toBe('/be-free/flight-deck?scopeid=scope-a&channelid=channel-a&threadid=thread-a');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('marks a user-opened Deck thread as a modal browser-history entry', () => {
    const originalWindow = globalThis.window;
    const pushState = vi.fn();
    globalThis.window = {
      location: {
        href: 'https://flightdeck.example/be-free/flight-deck?scopeid=scope-a',
        pathname: '/be-free/flight-deck',
        search: '?scopeid=scope-a',
      },
      history: { pushState, replaceState: vi.fn() },
    };
    try {
      const shell = createShellState({ initialSection: 'status' });
      Object.defineProperty(shell, 'currentWorkspaceSlug', { value: 'be-free' });
      shell.selectedBoardId = 'scope-a';
      shell.activeThreadId = 'thread-a';
      shell.deckThreadChannelId = 'channel-a';
      shell.updatePageTitle = vi.fn();

      shell.syncRoute();

      expect(pushState).toHaveBeenCalledWith(
        { section: 'status', deckThreadModal: true },
        '',
        '/be-free/flight-deck?scopeid=scope-a&channelid=channel-a&threadid=thread-a',
      );
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('opens and closes a Deck modal from direct-link and back/forward routes', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: 'https://flightdeck.example/be-free/flight-deck?scopeid=scope-a&channelid=channel-a&threadid=thread-a' },
      history: { state: null },
    };
    try {
      const shell = createShellState({ initialSection: 'status' });
      Object.assign(shell, {
        selectedBoardId: 'scope-a',
        activeThreadId: null,
        knownWorkspaces: [],
        readStoredTaskBoardId: vi.fn(() => 'scope-a'),
        validateSelectedBoardId: vi.fn(),
        persistSelectedBoardId: vi.fn(),
        openDeckThread: vi.fn(async function openDeckThread(channelId, threadId) {
          this.activeThreadId = threadId;
          this.deckThreadChannelId = channelId;
          this.deckThreadReturnContext = { selectedBoardId: 'scope-a' };
        }),
        closeDeckThread: vi.fn(function closeDeckThread() {
          this.activeThreadId = null;
          this.deckThreadReturnContext = null;
        }),
        startWorkspaceLiveQueries: vi.fn(),
        syncRoute: vi.fn(),
      });

      await shell.applyRouteFromLocation();
      expect(shell.navSection).toBe('status');
      expect(shell.openDeckThread).toHaveBeenCalledWith('channel-a', 'thread-a', {
        syncRoute: false,
        captureReturnContext: true,
      });

      globalThis.window.location.href = 'https://flightdeck.example/be-free/flight-deck?scopeid=scope-a';
      await shell.applyRouteFromLocation();
      expect(shell.closeDeckThread).toHaveBeenCalledWith({ syncRoute: false, fromRoute: true });
      expect(shell.activeThreadId).toBeNull();
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('clears a stale Chat thread when browser history restores a desktop Deck route', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: 'https://flightdeck.example/be-free/flight-deck?scopeid=scope-a&channelid=channel-a' },
      history: { state: { section: 'status' } },
    };
    try {
      const shell = createShellState({ initialSection: 'chat' });
      Object.assign(shell, {
        selectedBoardId: 'scope-a',
        selectedChannelId: 'channel-a',
        activeThreadId: 'stale-chat-thread',
        deckThreadChannelId: '',
        knownWorkspaces: [],
        readStoredTaskBoardId: vi.fn(() => 'scope-a'),
        validateSelectedBoardId: vi.fn(),
        persistSelectedBoardId: vi.fn(),
        closeThread: vi.fn(function closeThread() { this.activeThreadId = null; }),
        startWorkspaceLiveQueries: vi.fn(),
        syncRoute: vi.fn(),
      });

      await shell.applyRouteFromLocation();

      expect(shell.navSection).toBe('status');
      expect(shell.closeThread).toHaveBeenCalledWith({ syncRoute: false });
      expect(shell.activeThreadId).toBeNull();
      expect(shell.selectedBoardId).toBe('scope-a');
      expect(shell.selectedChannelId).toBe('channel-a');
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe('notification route restoration', () => {
  it('uses the notified channel even when the previous scope hides it', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: 'https://flightdeck.example/operator-a/chat?channelid=channel-target&threadid=thread-target' } };
    try {
      const shell = createShellState();
      Object.assign(shell, {
        currentWorkspace: { pgBackendMode: true },
        pgBackendMode: true,
        selectedBoardId: 'scope-quick-apps',
        selectedChannelId: 'word5',
        channels: [
          { record_id: 'word5', scope_id: 'scope-quick-apps' },
          { record_id: 'channel-target', scope_id: 'scope-correct' },
        ],
        selectChannel: vi.fn(async function selectChannel(channelId) {
          this.selectedChannelId = channelId;
        }),
        openThread: vi.fn(),
        closeThread: vi.fn(),
        persistSelectedBoardId: vi.fn(),
        startWorkspaceLiveQueries: vi.fn(),
        syncRoute: vi.fn(),
      });
      Object.defineProperty(shell, 'scopeFilteredChannels', {
        configurable: true,
        get() {
          if (this.selectedBoardId === '__pg_channel__:channel-target') {
            return [this.channels[1]];
          }
          return [this.channels[0]];
        },
      });

      await shell.applyRouteFromLocation();

      expect(shell.selectedBoardId).toBe('__pg_channel__:channel-target');
      expect(shell.selectChannel).toHaveBeenCalledWith('channel-target', { syncRoute: false });
      expect(shell.openThread).toHaveBeenCalledWith('thread-target', { syncRoute: false });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('keeps the notification section while switching to its workspace', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: 'https://flightdeck.example/chat?workspaceid=workspace-target&channelid=channel-target' } };
    try {
      const shell = createShellState({ initialSection: 'status' });
      shell.currentWorkspaceKey = 'workspace:current';
      shell.knownWorkspaces = [{
        workspaceId: 'workspace-target',
        workspaceKey: 'workspace:target',
        workspaceOwnerNpub: 'npub1target',
      }];
      shell.handleWorkspaceSwitcherSelect = vi.fn(async () => {});

      await shell.applyRouteFromLocation();

      expect(shell.navSection).toBe('chat');
      expect(shell.handleWorkspaceSwitcherSelect).toHaveBeenCalledWith('workspace:target');
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe('task view route defaults', () => {
  async function applyTaskRoute(href, { mobileViewport = false, taskViewMode = 'kanban' } = {}) {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href },
      history: { state: null },
    };
    try {
      const shell = createShellState({ initialSection: 'status' });
      Object.assign(shell, {
        mobileViewport,
        taskViewMode,
        selectedBoardId: null,
        knownWorkspaces: [],
        readStoredTaskBoardId: vi.fn(() => 'scope-a'),
        preferredTaskBoardId: 'scope-a',
        validateSelectedBoardId: vi.fn(),
        persistSelectedBoardId: vi.fn(),
        normalizeTaskFilterTags: vi.fn(),
        closeTaskDetail: vi.fn(),
        startWorkspaceLiveQueries: vi.fn(),
        syncRoute: vi.fn(),
      });

      await shell.applyRouteFromLocation();
      return shell;
    } finally {
      globalThis.window = originalWindow;
    }
  }

  it('defaults task routes without a view override to list on mobile viewports', async () => {
    const shell = await applyTaskRoute('https://flightdeck.example/be-free/tasks');

    expect(shell.taskViewMode).toBe('kanban');

    const mobileShell = await applyTaskRoute('https://flightdeck.example/be-free/tasks', {
      mobileViewport: true,
    });

    expect(mobileShell.taskViewMode).toBe('list');
  });

  it('preserves an explicit kanban task route on mobile viewports', async () => {
    const shell = await applyTaskRoute('https://flightdeck.example/be-free/tasks?view=kanban', {
      mobileViewport: true,
      taskViewMode: 'list',
    });

    expect(shell.taskViewMode).toBe('kanban');
  });
});

describe('shell state key inventory', () => {
  // App/session state
  it('includes identity and session keys', () => {
    expect(SHELL_STATE_KEYS).toContain('backendUrl');
    expect(SHELL_STATE_KEYS).toContain('ownerNpub');
    expect(SHELL_STATE_KEYS).toContain('botNpub');
    expect(SHELL_STATE_KEYS).toContain('session');
    expect(SHELL_STATE_KEYS).toContain('settingsTab');
    expect(SHELL_STATE_KEYS).toContain('appBuildId');
  });

  // Navigation state
  it('includes navigation keys', () => {
    expect(SHELL_STATE_KEYS).toContain('navSection');
    expect(SHELL_STATE_KEYS).toContain('navCollapsed');
    expect(SHELL_STATE_KEYS).toContain('mobileNavOpen');
    expect(SHELL_STATE_KEYS).toContain('routeSyncPaused');
    expect(SHELL_STATE_KEYS).toContain('popstateHandler');
  });

  // Sync status indicators
  it('includes sync status keys', () => {
    expect(SHELL_STATE_KEYS).toContain('syncStatus');
    expect(SHELL_STATE_KEYS).toContain('syncSession');
    expect(SHELL_STATE_KEYS).toContain('sseStatus');
    expect(SHELL_STATE_KEYS).toContain('catchUpSyncActive');
  });

  // Shell UI state
  it('includes shell UI keys', () => {
    expect(SHELL_STATE_KEYS).toContain('showAvatarMenu');
    expect(SHELL_STATE_KEYS).toContain('showConnectModal');
    expect(SHELL_STATE_KEYS).toContain('showAgentConnectModal');
    expect(SHELL_STATE_KEYS).toContain('knownHosts');
  });

  // Connect modal fields
  it('includes connect modal fields', () => {
    expect(SHELL_STATE_KEYS).toContain('connectStep');
    expect(SHELL_STATE_KEYS).toContain('connectHostUrl');
    expect(SHELL_STATE_KEYS).toContain('connectHostLabel');
    expect(SHELL_STATE_KEYS).toContain('connectHostServiceNpub');
    expect(SHELL_STATE_KEYS).toContain('connectHostTowerName');
    expect(SHELL_STATE_KEYS).toContain('connectHostTowerDescription');
    expect(SHELL_STATE_KEYS).toContain('connectHostError');
    expect(SHELL_STATE_KEYS).toContain('connectHostBusy');
    expect(SHELL_STATE_KEYS).toContain('connectManualUrl');
    expect(SHELL_STATE_KEYS).toContain('connectWorkspaces');
    expect(SHELL_STATE_KEYS).toContain('connectWorkspacesBusy');
    expect(SHELL_STATE_KEYS).toContain('connectWorkspacesError');
    expect(SHELL_STATE_KEYS).toContain('connectNewWorkspaceName');
    expect(SHELL_STATE_KEYS).toContain('connectNewWorkspaceDescription');
    expect(SHELL_STATE_KEYS).toContain('connectCreatingWorkspace');
    expect(SHELL_STATE_KEYS).toContain('connectTokenInput');
    expect(SHELL_STATE_KEYS).toContain('connectShowTokenFallback');
  });

  // Constants
  it('includes timing constants', () => {
    expect(SHELL_STATE_KEYS).toContain('FAST_SYNC_MS');
    expect(SHELL_STATE_KEYS).toContain('IDLE_SYNC_MS');
    expect(SHELL_STATE_KEYS).toContain('SSE_HEARTBEAT_CADENCE_MS');
    expect(SHELL_STATE_KEYS).toContain('BACKGROUND_GROUP_REFRESH_MS');
    expect(SHELL_STATE_KEYS).toContain('GROUP_KEY_REFRESH_MAX_AGE_MS');
  });
});

describe('shell state does NOT include domain keys', () => {
  const DOMAIN_KEYS = [
    // Section data arrays
    'channels', 'messages', 'documents', 'directories', 'reports',
    'tasks', 'schedules', 'audioNotes', 'groups', 'scopes',
    'flows', 'approvals', 'persons', 'organisations',
    'addressBookPeople', 'taskComments', 'docComments',
    // Section selection state
    'selectedChannelId', 'selectedDocId', 'selectedDocType',
    'selectedReportId', 'activeThreadId', 'activeTaskId',
    'editingFlowId', 'editingPersonId', 'editingOrgId',
    // Section UI state
    'messageInput', 'threadInput', 'docEditorContent',
    'docEditorBlocks', 'docBlockBuffer', 'newTaskTitle',
    'showTaskDetail', 'showFlowEditor', 'showDocShareModal',
    'taskViewMode', 'taskSortMode', 'showBoardPicker', 'selectedBoardId',
  ];

  it('does not contain any domain data array keys', () => {
    const shell = createShellState();
    const shellKeys = Object.keys(shell);
    for (const key of DOMAIN_KEYS) {
      expect(shellKeys, `shell should not contain domain key: ${key}`).not.toContain(key);
    }
  });

  it('SHELL_STATE_KEYS does not list any domain keys', () => {
    for (const key of DOMAIN_KEYS) {
      expect(SHELL_STATE_KEYS, `SHELL_STATE_KEYS should not contain: ${key}`).not.toContain(key);
    }
  });
});

describe('shell state default values', () => {
  it('initializes navSection to status by default', () => {
    const shell = createShellState();
    expect(shell.navSection).toBe('status');
  });

  it('accepts an initial section override', () => {
    const shell = createShellState({ initialSection: 'tasks' });
    expect(shell.navSection).toBe('tasks');
  });

  it('starts with the primary nav collapsed after a fresh load', () => {
    const shell = createShellState();
    expect(shell.navCollapsed).toBe(true);
  });

  it('initializes session to null', () => {
    const shell = createShellState();
    expect(shell.session).toBeNull();
  });

  it('initializes sync status to synced', () => {
    const shell = createShellState();
    expect(shell.syncStatus).toBe('synced');
  });

  it('initializes syncSession with expected structure', () => {
    const shell = createShellState();
    expect(shell.syncSession).toEqual({
      state: 'synced',
      phase: 'idle',
      startedAt: null,
      finishedAt: null,
      lastSuccessAt: null,
      manual: false,
      currentFamily: null,
      currentFamilyHash: null,
      completedFamilies: 0,
      totalFamilies: 0,
      pushed: 0,
      pushTotal: 0,
      pulled: 0,
      heartbeat: false,
      error: null,
    });
  });

  it('initializes connect modal fields to default values', () => {
    const shell = createShellState();
    expect(shell.showConnectModal).toBe(false);
    expect(shell.connectStep).toBe(1);
    expect(shell.connectHostUrl).toBe('');
    expect(shell.connectHostTowerName).toBe('');
    expect(shell.connectHostTowerDescription).toBe('');
    expect(shell.connectWorkspaces).toEqual([]);
  });

  it('sets constants to expected values', () => {
    const shell = createShellState();
    expect(shell.FAST_SYNC_MS).toBe(15000);
    expect(shell.IDLE_SYNC_MS).toBe(30000);
    expect(shell.SSE_HEARTBEAT_CADENCE_MS).toBe(60000);
    expect(shell.BACKGROUND_GROUP_REFRESH_MS).toBe(300000);
    expect(shell.GROUP_KEY_REFRESH_MAX_AGE_MS).toBe(86400000);
  });

  it('isLoggedIn returns false when session is null', () => {
    const shell = createShellState();
    expect(shell.isLoggedIn).toBe(false);
  });

  it('isLoggedIn returns true when session has an npub', () => {
    const shell = createShellState();
    shell.session = { npub: 'npub1abc', pubkey: 'abc', method: 'extension' };
    expect(shell.isLoggedIn).toBe(true);
  });

  it('loads an already selected channel when entering chat from another scope quick app', () => {
    const shell = createShellState({ initialSection: 'status' });
    Object.assign(shell, {
      selectedChannelId: 'channel-book-of-sand',
      selectedBoardId: 'pg:channel:channel-book-of-sand',
      scopeFilteredChannels: [{ record_id: 'channel-book-of-sand' }],
      currentWorkspace: { pgBackendMode: true },
      clearInactiveSectionData: vi.fn(),
      markSectionRead: vi.fn(),
      cancelEditSchedule: vi.fn(),
      selectChannel: vi.fn(),
      syncRoute: vi.fn(),
      startWorkspaceLiveQueries: vi.fn(),
      ensureBackgroundSync: vi.fn(),
    });

    shell.navigateTo('chat');

    expect(shell.selectChannel).toHaveBeenCalledWith('channel-book-of-sand', { syncRoute: false });
  });

  it('can enter chat without starting a duplicate channel selection for a deep link', () => {
    const shell = createShellState({ initialSection: 'status' });
    Object.assign(shell, {
      selectedChannelId: 'channel-old',
      selectedBoardId: 'pg:channel:channel-old',
      scopeFilteredChannels: [{ record_id: 'channel-old' }],
      currentWorkspace: { pgBackendMode: true },
      clearInactiveSectionData: vi.fn(),
      markSectionRead: vi.fn(),
      cancelEditSchedule: vi.fn(),
      selectChannel: vi.fn(),
      syncRoute: vi.fn(),
      startWorkspaceLiveQueries: vi.fn(),
      ensureBackgroundSync: vi.fn(),
    });

    shell.navigateTo('chat', { syncRoute: false, skipChatChannelSelection: true });

    expect(shell.navSection).toBe('chat');
    expect(shell.mobileNavOpen).toBe(false);
    expect(shell.selectChannel).not.toHaveBeenCalled();
    expect(shell.syncRoute).not.toHaveBeenCalled();
  });
});

describe('shell lifecycle methods', () => {
  it('includes initRouteSync method', () => {
    expect(SHELL_METHOD_NAMES).toContain('initRouteSync');
  });

  it('includes navigateTo method', () => {
    expect(SHELL_METHOD_NAMES).toContain('navigateTo');
  });

  it('includes buildRouteUrl method', () => {
    expect(SHELL_METHOD_NAMES).toContain('buildRouteUrl');
  });

  it('includes syncRoute method', () => {
    expect(SHELL_METHOD_NAMES).toContain('syncRoute');
  });

  it('includes getRoutePath method', () => {
    expect(SHELL_METHOD_NAMES).toContain('getRoutePath');
  });

  it('includes init method', () => {
    expect(SHELL_METHOD_NAMES).toContain('init');
  });

  it('includes login and logout methods', () => {
    expect(SHELL_METHOD_NAMES).toContain('login');
    expect(SHELL_METHOD_NAMES).toContain('logout');
  });

  it('includes togglePrimaryNav method', () => {
    expect(SHELL_METHOD_NAMES).toContain('togglePrimaryNav');
  });

  it('includes startExtensionSignerWatch and stopExtensionSignerWatch', () => {
    expect(SHELL_METHOD_NAMES).toContain('startExtensionSignerWatch');
    expect(SHELL_METHOD_NAMES).toContain('stopExtensionSignerWatch');
  });

  it('includes clearInactiveSectionData method', () => {
    expect(SHELL_METHOD_NAMES).toContain('clearInactiveSectionData');
  });

  it('includes bootstrapSelectedWorkspace method', () => {
    expect(SHELL_METHOD_NAMES).toContain('bootstrapSelectedWorkspace');
  });

  it('includes ensureWorkspaceSessionKey method', () => {
    expect(SHELL_METHOD_NAMES).toContain('ensureWorkspaceSessionKey');
  });

  it('includes applyRouteFromLocation method', () => {
    expect(SHELL_METHOD_NAMES).toContain('applyRouteFromLocation');
  });

  it('includes updatePageTitle method', () => {
    expect(SHELL_METHOD_NAMES).toContain('updatePageTitle');
  });

  it('does not block auto-login on PG Nostr discovery, but keeps manual login strict', () => {
    const autoLoginStart = SHELL_STATE_SOURCE.indexOf('async maybeAutoLogin()');
    const loginStart = SHELL_STATE_SOURCE.indexOf('async login(method, supplemental = null)');
    const autoLoginBlock = SHELL_STATE_SOURCE.slice(autoLoginStart, loginStart);
    const loginBlock = SHELL_STATE_SOURCE.slice(loginStart, SHELL_STATE_SOURCE.indexOf('async logout()', loginStart));

    expect(autoLoginBlock).toContain('this.discoverPgOnboardingAnnouncements?.().catch?.(() => {});');
    expect(autoLoginBlock).toContain('this.discoverPgWorkspaceSelfIndex?.().catch?.(() => {});');
    expect(autoLoginBlock).not.toContain('await this.discoverPgOnboardingAnnouncements?.();');
    expect(autoLoginBlock).not.toContain('await this.discoverPgWorkspaceSelfIndex?.();');
    expect(autoLoginBlock).not.toContain('await this.loadRemoteWorkspaces();');

    expect(loginBlock).toContain('await this.discoverPgOnboardingAnnouncements?.();');
    expect(loginBlock).toContain('await this.discoverPgWorkspaceSelfIndex?.();');
    expect(loginBlock).toContain('await this.loadRemoteWorkspaces();');
  });
});

describe('shell state is spreadable into a store', () => {
  it('can be applied with Object.defineProperties (mixin pattern)', () => {
    const target = { domainKey: 'test' };
    const shell = createShellState();
    const descriptors = Object.getOwnPropertyDescriptors(shell);
    Object.defineProperties(target, descriptors);

    // Shell keys should be present
    expect(target.navSection).toBe('status');
    expect(target.session).toBeNull();
    expect(target.FAST_SYNC_MS).toBe(15000);

    // Domain key should still be there
    expect(target.domainKey).toBe('test');
  });

  it('getters survive defineProperties application', () => {
    const target = {};
    const shell = createShellState();
    const descriptors = Object.getOwnPropertyDescriptors(shell);
    Object.defineProperties(target, descriptors);

    // signingNpub should still be a getter
    const desc = Object.getOwnPropertyDescriptor(target, 'signingNpub');
    expect(desc?.get).toBeDefined();

    // isLoggedIn should still be a getter
    const loggedInDesc = Object.getOwnPropertyDescriptor(target, 'isLoggedIn');
    expect(loggedInDesc?.get).toBeDefined();
  });
});

describe('shell PG bootstrap guard', () => {
  it('does not bootstrap a PG workspace key without a verified workspace service identity', async () => {
    const shell = createShellState();
    shell.backendUrl = 'https://tower.example';
    shell.currentWorkspaceOwnerNpub = 'npub1workspace';
    shell.session = { npub: 'npub1user' };

    await expect(shell.ensureWorkspaceSessionKey()).resolves.toBeNull();
  });

  it('loads cached PG workspace navigation before scheduling PG hydration', async () => {
    const shell = createShellState();
    shell.selectedWorkspaceKey = 'pg:workspace';
    shell.currentWorkspaceOwnerNpub = 'npub1workspace';
    shell.loadLocalWorkspaceCoreData = vi.fn(async () => ({ scopes: [], channels: [] }));
    shell.startWorkspaceLiveQueries = vi.fn();
    shell.refreshScopes = vi.fn(async () => {});
    shell.refreshChannels = vi.fn(async () => {});
    shell.refreshTasks = vi.fn(async () => {});
    shell.refreshDocuments = vi.fn(async () => {});
    shell.refreshAudioNotes = vi.fn(async () => {});
    shell.refreshGroups = vi.fn(async () => {});
    shell.refreshWorkspaceKeyMappings = vi.fn(async () => {});
    shell.readStoredTaskBoardId = vi.fn(() => null);
    shell.readStoredCollapsedSections = vi.fn(() => ({}));
    shell.validateSelectedBoardId = vi.fn();
    shell.applyRouteFromLocation = vi.fn(async () => {});
    shell.refreshSyncStatus = vi.fn(async () => {});
    shell.refreshStatusRecentChanges = vi.fn(async () => {});

    await shell.bootstrapSelectedWorkspace({ runAccessPrune: true });

    expect(shell.loadLocalWorkspaceCoreData).toHaveBeenCalledWith({ syncRoute: false });
    expect(shell.localWorkspaceCoreLoadedForKey).toBe('pg:workspace');
    expect(shell.startWorkspaceLiveQueries).toHaveBeenCalled();
    expect(shell.refreshScopes).not.toHaveBeenCalled();
    expect(shell.refreshChannels).not.toHaveBeenCalled();
    expect(shell.refreshTasks).not.toHaveBeenCalled();
    expect(shell.refreshDocuments).not.toHaveBeenCalled();
    expect(shell.refreshAudioNotes).not.toHaveBeenCalled();
    expect(shell.refreshGroups).not.toHaveBeenCalled();
    expect(shell.refreshWorkspaceKeyMappings).not.toHaveBeenCalled();
  });

  it('does not reload cached PG workspace navigation after the selector already loaded it', async () => {
    const shell = createShellState();
    shell.selectedWorkspaceKey = 'pg:workspace';
    shell.currentWorkspaceOwnerNpub = 'npub1workspace';
    shell.localWorkspaceCoreLoadedForKey = 'pg:workspace';
    shell.loadLocalWorkspaceCoreData = vi.fn(async () => ({ scopes: [], channels: [] }));
    shell.startWorkspaceLiveQueries = vi.fn();
    shell.readStoredTaskBoardId = vi.fn(() => null);
    shell.readStoredCollapsedSections = vi.fn(() => ({}));
    shell.validateSelectedBoardId = vi.fn();
    shell.applyRouteFromLocation = vi.fn(async () => {});
    shell.refreshSyncStatus = vi.fn(async () => {});
    shell.refreshStatusRecentChanges = vi.fn(async () => {});

    await shell.bootstrapSelectedWorkspace({ runAccessPrune: true });

    expect(shell.loadLocalWorkspaceCoreData).not.toHaveBeenCalled();
    expect(shell.startWorkspaceLiveQueries).toHaveBeenCalled();
  });
});

describe('shell state boundary is documented', () => {
  it('SHELL_STATE_KEYS matches the keys actually returned by createShellState', () => {
    const shell = createShellState();
    const descriptors = Object.getOwnPropertyDescriptors(shell);

    // Collect all non-function keys (state + getters)
    const actualStateKeys = [];
    for (const [key, desc] of Object.entries(descriptors)) {
      if (typeof desc.value === 'function') continue; // skip methods
      if (desc.get) { actualStateKeys.push(key); continue; } // getter = state
      actualStateKeys.push(key);
    }

    const sortedExpected = [...SHELL_STATE_KEYS].sort();
    const sortedActual = [...actualStateKeys].sort();
    expect(sortedActual).toEqual(sortedExpected);
  });

  it('SHELL_METHOD_NAMES matches the methods actually returned by createShellState', () => {
    const shell = createShellState();
    const descriptors = Object.getOwnPropertyDescriptors(shell);

    const actualMethods = [];
    for (const [key, desc] of Object.entries(descriptors)) {
      if (typeof desc.value === 'function') actualMethods.push(key);
    }

    const sortedExpected = [...SHELL_METHOD_NAMES].sort();
    const sortedActual = [...actualMethods].sort();
    expect(sortedActual).toEqual(sortedExpected);
  });
});

describe('Drive reference route normalization', () => {
  it('keeps the share/path reference while routing old Drive links into Files', async () => {
    const { parseRouteLocation } = await import('../src/route-helpers.js');
    const original = globalThis.window;
    const href = 'https://deck.example/old/flight-deck?workspacekey=old#drive?workspace=target&share=share&path=folder%2Ffile&kind=file';
    globalThis.window = { location: { href } };
    try {
      const shell = createShellState();
      const context = { navSection: 'files', currentWorkspaceSlug: 'target',
        currentWorkspaceKey: 'new', getRoutePath: shell.getRoutePath };
      expect(shell.getRoutePath.call(context)).toBe('/target/files');
      const normalized = shell.buildRouteUrl.call(context);
      expect(normalized).toContain('/target/files?workspacekey=new#drive?workspace=target&share=share&path=folder%2Ffile');
      const route = parseRouteLocation(href);
      expect(route.section).toBe('files');
      expect(route.params.workspaceid).toBe('target');
      expect(route.params.workspacekey).toBeNull();
    } finally { globalThis.window = original; }
  });
});


describe('Backlog on task view entry', () => {
  it('collapses on entry and re-entry while keeping explicit expansion during the visit', () => {
    const shell = createShellState();
    shell.navSection = 'chat';
    shell.collapsedSections = { new: false, done: true, ready: false };
    shell.navSection = 'tasks';
    expect(shell.collapsedSections).toEqual({ new: true, done: true, ready: false });
    shell.collapsedSections.new = false;
    shell.navSection = 'tasks';
    expect(shell.collapsedSections.new).toBe(false);
    shell.navSection = 'chat';
    shell.navSection = 'tasks';
    expect(shell.collapsedSections).toEqual({ new: true, done: true, ready: false });
  });
});


describe('channel Docs shell entry', () => {
  function buildNavigableShell() {
    const shell = createShellState();
    Object.assign(shell, { syncRoute: vi.fn(), startWorkspaceLiveQueries: vi.fn(), ensureBackgroundSync: vi.fn(),
      refreshStatusRecentChanges: vi.fn(), validateSelectedBoardId: vi.fn(), normalizeTaskFilterTags: vi.fn(), cancelEditSchedule: vi.fn() });
    return shell;
  }

  it('opens Home on repeated Docs entry after All docs or an explicit page', () => {
    const shell = buildNavigableShell();
    shell.navSection = 'docs'; shell.docsShowAll = true;
    shell.openChannelDocsHome = vi.fn();
    shell.navigateTo('docs');
    expect(shell.openChannelDocsHome).toHaveBeenCalledOnce();
    shell.selectedDocId = 'another-page'; shell.navigateTo('docs');
    expect(shell.openChannelDocsHome).toHaveBeenCalledTimes(2);
    shell.navigateTo('docs', { docsHome: false });
    expect(shell.openChannelDocsHome).toHaveBeenCalledTimes(2);
  });

  it('keeps the current editor and section when leaving fails to preserve a draft', async () => {
    const shell = buildNavigableShell();
    shell.navSection = 'docs'; shell.selectedDocId = 'dirty-page'; shell.docEditDraftDirty = true;
    shell.closeDocEditor = vi.fn(); shell.clearInactiveSectionData = vi.fn();
    shell.preserveWikiNavigationDraft = vi.fn().mockResolvedValue(false);
    expect(await shell.navigateTo('tasks')).toBe(false);
    expect(shell.navSection).toBe('docs'); expect(shell.selectedDocId).toBe('dirty-page');
    expect(shell.closeDocEditor).not.toHaveBeenCalled(); expect(shell.clearInactiveSectionData).not.toHaveBeenCalled();
  });

  it('cancels pending section navigation when another Docs entry wins', async () => {
    const shell = buildNavigableShell(); let finish;
    shell.navSection = 'docs'; shell.selectedDocId = 'dirty-page'; shell.docEditDraftDirty = true;
    shell.closeDocEditor = vi.fn(); shell.openChannelDocsHome = vi.fn();
    shell.preserveWikiNavigationDraft = () => new Promise(resolve => { finish = resolve; });
    const leaving = shell.navigateTo('tasks'); shell.navigateTo('docs'); finish(true);
    expect(await leaving).toBe(false); expect(shell.navSection).toBe('docs'); expect(shell.closeDocEditor).not.toHaveBeenCalled();
  });

  it('restores Home by default but retains explicit All docs and direct document routes', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { href: 'https://flightdeck.example/be-free/docs' }, history: { state: {} } };
    try {
      const shell = buildNavigableShell();
      Object.assign(shell, { knownWorkspaces: [], loadDocEditorFromSelection: vi.fn(), closeDocEditor: vi.fn(),
        openChannelDocsHome: vi.fn(), openDoc: vi.fn(), currentFolderId: null, selectedDocId: null });
      await shell.applyRouteFromLocation();
      expect(shell.openChannelDocsHome).toHaveBeenCalledWith({ syncRoute: false });
      shell.openChannelDocsHome.mockClear();
      window.location.href = 'https://flightdeck.example/be-free/docs?docsview=all';
      await shell.applyRouteFromLocation();
      expect(shell.docsShowAll).toBe(true); expect(shell.openChannelDocsHome).not.toHaveBeenCalled();
      expect(shell.buildRouteUrl()).toContain('docsview=all');
      shell.channels = [{ record_id: 'requested-channel' }];
      shell.selectedChannelId = 'wrong-channel';
      window.location.href = 'https://flightdeck.example/be-free/docs?channelid=requested-channel&docsview=all';
      await shell.applyRouteFromLocation();
      expect(shell.selectedChannelId).toBe('requested-channel');
      expect(shell.buildRouteUrl()).toContain('channelid=requested-channel');
      window.location.href = 'https://flightdeck.example/be-free/docs?docid=explicit-page';
      await shell.applyRouteFromLocation();
      expect(shell.openDoc).toHaveBeenCalledWith('explicit-page', expect.objectContaining({ syncRoute: false }));
      expect(shell.openChannelDocsHome).not.toHaveBeenCalled();
    } finally { globalThis.window = originalWindow; }
  });
});
