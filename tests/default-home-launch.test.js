import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShellState } from '../src/shell-state.js';
import { ALL_TASK_BOARD_ID, taskBoardStateMixin } from '../src/task-board-state.js';

afterEach(() => vi.unstubAllGlobals());

function client(path, storedBoard = null) {
  const storage = new Map(storedBoard ? [['coworker:alpha:last-task-board-id', storedBoard]] : []);
  const browser = {
    location: new URL(path, 'http://localhost'),
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    history: { state: null, replaceState: vi.fn((_state, _title, url) => {
      browser.location = new URL(url, browser.location);
    }), pushState: vi.fn() },
  };
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', { title: '' });
  const shell = createShellState();
  Object.defineProperties(shell, Object.getOwnPropertyDescriptors(taskBoardStateMixin));
  Object.assign(shell, {
    currentWorkspaceSlug: 'alpha', selectedWorkspaceKey: 'alpha-key',
    knownWorkspaces: [], currentWorkspace: { pgBackendMode: true },
    scopes: [], scopesLoaded: false, tasks: [], channels: [],
    selectedBoardId: storedBoard, selectedChannelId: 'old-channel', activeThreadId: null,
    startWorkspaceLiveQueries: vi.fn(), refreshSyncStatus: vi.fn(),
    refreshStatusRecentChanges: vi.fn(), readStoredCollapsedSections: () => ({}),
    loadLocalWorkspaceCoreData: vi.fn(), ensureWorkspaceSessionKey: vi.fn(),
    ensureTowerPgControlPlaneHydrated: vi.fn(), resumePgTaskWriteQueue: vi.fn(),
    closeThread: vi.fn(() => { shell.activeThreadId = null; }),
    openDeckThread: vi.fn(), openDoc: vi.fn(), selectChannel: vi.fn(), openThread: vi.fn(),
  });
  return shell;
}

describe('default Home launch', () => {
  for (const path of ['/', '/alpha', '/alpha/flight-deck', '/status', '/notifications', '/alpha/flight-deck?workspacekey=alpha-key']) {
    for (const stored of [null, 'previous-project']) {
      it(`opens ${path} across all projects with stored scope ${stored}`, async () => {
        const shell = client(path, stored);
        await shell.bootstrapSelectedWorkspace();
        expect(shell.navSection).toBe('status');
        expect(shell.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
        expect(shell.selectedChannelId).toBeNull();
        expect(shell.pgContextHomeSelected).toBe(true);
        expect(shell.pgContextAllScopesSelected).toBe(true);
        expect(window.location.search).toContain('scopeid=__all__');
        expect(window.history.pushState).not.toHaveBeenCalled();
        // A subsequent bootstrap / reload cannot restore an older project.
        window.localStorage.setItem('coworker:alpha:last-task-board-id', 'previous-project');
        await shell.bootstrapSelectedWorkspace();
        expect(shell.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
      });
    }
  }

  it.each(['scopeid', 'groupid'])('preserves an explicit Home project via %s', async (parameter) => {
    const shell = client(`/alpha/flight-deck?${parameter}=linked-project`, 'previous-project');
    await shell.applyRouteFromLocation();
    expect(shell.selectedBoardId).toBe('linked-project');
  });

  it('preserves an explicit Home conversation', async () => {
    const shell = client('/alpha/flight-deck?channelid=linked-channel&threadid=linked-thread', 'previous-project');
    await shell.applyRouteFromLocation();
    expect(shell.openDeckThread).toHaveBeenCalledWith('linked-channel', 'linked-thread', expect.objectContaining({ syncRoute: false }));
    expect(shell.selectedBoardId).toBe('previous-project');
  });

  it('preserves a useful saved Home project on launch', async () => {
    const shell = client('/alpha', 'project-a');
    shell.scopes = [{ record_id: 'project-a', title: 'Project A', record_state: 'active' }];
    shell.scopesLoaded = true;
    shell.tasks = [{ record_id: 'task-a', scope_id: 'project-a', record_state: 'active' }];
    await shell.bootstrapSelectedWorkspace();
    expect(shell.navSection).toBe('status');
    expect(shell.selectedBoardId).toBe('project-a');
  });

  it('returns to plain Home after closing a conversation restores its earlier project', async () => {
    const shell = client('/alpha/flight-deck', 'previous-project');
    shell.activeThreadId = 'old-thread';
    shell.deckThreadChannelId = 'old-channel';
    shell.closeDeckThread = vi.fn(() => {
      shell.activeThreadId = null;
      shell.selectedBoardId = 'old-project';
      shell.selectedChannelId = 'old-channel';
    });
    await shell.applyRouteFromLocation();
    expect(shell.closeDeckThread).toHaveBeenCalledWith({ syncRoute: false, fromRoute: true });
    expect(shell.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
    expect(shell.selectedChannelId).toBeNull();
  });

  it('preserves document deep links and intentional section entry', async () => {
    const shell = client('/alpha/docs?docid=linked-document', 'previous-project');
    await shell.applyRouteFromLocation();
    expect(shell.navSection).toBe('docs');
    expect(shell.openDoc).toHaveBeenCalledWith('linked-document', expect.any(Object));
    expect(shell.selectedBoardId).toBe('previous-project');
  });

  it('resolves an explicit channel outside the persisted project through its existing handler', async () => {
    const shell = client('/alpha/chat?channelid=linked-channel&threadid=linked-thread', 'previous-project');
    shell.channels = [{ record_id: 'linked-channel', scope_id: 'other-project' }];
    await shell.applyRouteFromLocation();
    expect(shell.navSection).toBe('chat');
    expect(shell.selectChannel).toHaveBeenCalledWith('linked-channel', { syncRoute: false });
    expect(shell.openThread).toHaveBeenCalledWith('linked-thread', { syncRoute: false });
  });

  it('restores All and explicit projects when traversing history without pushing entries', async () => {
    const shell = client('/alpha/flight-deck', 'previous-project');
    await shell.applyRouteFromLocation();
    window.location = new URL('http://localhost/alpha/flight-deck?scopeid=project-b');
    await shell.applyRouteFromLocation();
    expect(shell.selectedBoardId).toBe('project-b');
    window.location = new URL('http://localhost/alpha/flight-deck?scopeid=__all__');
    await shell.applyRouteFromLocation();
    expect(shell.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
    window.location = new URL('http://localhost/alpha/flight-deck?scopeid=project-b');
    await shell.applyRouteFromLocation();
    expect(shell.selectedBoardId).toBe('project-b');
    expect(window.history.pushState).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('coworker:beta:last-task-board-id')).toBeNull();
  });
});
