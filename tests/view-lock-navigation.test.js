import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createShellState } from '../src/shell-state.js';
import { taskBoardStateMixin, computeBoardScopedTasks } from '../src/task-board-state.js';
import { buildPgChannelTaskBoardId } from '../src/pg-record-context.js';

import { filterDocItemsByScope } from '../src/docs-scope-filter.js';
import { filesManagerMixin } from '../src/files-manager.js';

function createStore(section = 'tasks', mobile = false) {
  const store = createShellState({ initialSection: section });
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(taskBoardStateMixin));
  Object.assign(store, {
    navCollapsed: mobile,
    mobileViewport: mobile,
    selectedBoardId: 'scope-old',
    selectedChannelId: null,
    currentWorkspace: { pgBackendMode: true },
    channels: [{ record_id: 'channel-new', scope_id: 'scope-new' }],
    scopes: [{ record_id: 'scope-new', level: 'l1' }],
    tasks: [], messages: [],
    persistSelectedBoardId: vi.fn(), clearSelectedTasks: vi.fn(),
    normalizeTaskFilterTags: vi.fn(), closeBoardPicker: vi.fn(),
    syncRoute: vi.fn(), startWorkspaceLiveQueries: vi.fn(),
    ensureBackgroundSync: vi.fn(), refreshStatusRecentChanges: vi.fn(),
    clearInactiveSectionData: vi.fn(), cancelEditSchedule: vi.fn(),
    saveCurrentChatPresentation: vi.fn(), selectChannel: vi.fn(),
    applyChatPresentation: vi.fn(), refreshMessages: vi.fn(),
    closeThread: vi.fn(), validateSelectedBoardId: vi.fn(),
  });
  return store;
}

describe.each([false, true])('Lock into a content view (mobile: %s)', (mobile) => {
  const makeStore = (section) => createStore(section, mobile);
  for (const section of ['tasks', 'docs', 'chat', 'files']) {
    it(`retains ${section} through scope and channel selection with new filter context`, async () => {
      const store = makeStore(section);
      store.toggleCurrentViewLock();
      await store.selectWorkContextScope('scope-new');
      expect(store.navSection).toBe(section);
      expect(store.selectedBoardId).toBe('scope-new');
      expect(store.selectedChannelId).toBeNull();
      expect(store.lockedView).toBe(section);
      await store.selectWorkContextChannel('channel-new');
      expect(store.navSection).toBe(section);
      expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('channel-new'));
      expect(store.selectedChannelId).toBe('channel-new');
      expect(store.clearInactiveSectionData).not.toHaveBeenCalled();
      expect(store.refreshStatusRecentChanges).not.toHaveBeenCalled();
      expect(store.syncRoute).toHaveBeenCalled();
      expect(store.startWorkspaceLiveQueries).toHaveBeenCalled();
    });
    it(`opens Deck from unlocked ${section}`, async () => {
      const store = makeStore(section);
      await store.selectWorkContextChannel('channel-new');
      expect(store.navSection).toBe('status');
      expect(store.lockedView).toBeNull();
      expect(store.refreshStatusRecentChanges).toHaveBeenCalled();
    });
  }
  for (const section of ['tasks', 'docs', 'chat', 'files']) {
    it(`workspace Home retains locked ${section} and clears lower context and stale route detail`, async () => {
      const store = makeStore(section);
      store.selectedBoardId = buildPgChannelTaskBoardId('channel-new');
      store.selectedChannelId = 'channel-new';
      store.activeThreadId = 'thread-old';
      store.currentFolderId = 'folder-old';
      store.fileCurrentFolderId = 'file-folder-old';
      store.fileChannelFilter = 'channel-new';
      store.fileThreadFilter = 'thread-old';
      store.closeThread = vi.fn(() => { store.activeThreadId = null; });
      store.toggleCurrentViewLock();
      await store.openAllScopesOverview();
      expect(store.navSection).toBe(section);
      expect(store.lockedView).toBe(section);
      expect(store.selectedBoardId).toBe('__all__');
      expect(store.selectedChannelId).toBeNull();
      expect(store.pgContextScopeId).toBeNull();
      expect(store.currentFolderId).toBeNull();
      expect(store.fileCurrentFolderId).toBe('');
      expect(store.fileChannelFilter).toBe('all');
      expect(store.fileThreadFilter).toBe('all');
      expect(store.activeThreadId).toBeNull();
      expect(store.syncRoute.mock.invocationCallOrder.at(-1)).toBeGreaterThan(store.closeThread.mock.invocationCallOrder[0]);
      expect(store.startWorkspaceLiveQueries).toHaveBeenCalled();
      expect(store.refreshStatusRecentChanges).not.toHaveBeenCalled();
    });
    it(`unlocked workspace Home opens Deck from ${section}`, async () => {
      const store = makeStore(section);
      await store.openAllScopesOverview();
      expect(store.navSection).toBe('status');
      expect(store.selectedBoardId).toBe('__all__');
      expect(store.lockedView).toBeNull();
    });
  }
  it('broadens actual task, document, file and chat channel filters across scopes', async () => {
    const rows = ['new', 'other'].map(id => ({
      record_id: id, scope_id: `scope-${id}`, pg_channel_id: `channel-${id}`,
      channel_id: `channel-${id}`, record_state: 'active',
    }));
    for (const section of ['tasks', 'docs', 'files', 'chat']) {
      const store = makeStore(section);
      store.channels = rows.map(row => ({ ...row, record_id: row.channel_id }));
      store.scopes = rows.map(row => ({ record_id: row.scope_id, level: 'l1' }));
      store.selectedBoardId = 'scope-new';
      const filtered = () => {
        if (section === 'tasks') return computeBoardScopedTasks(rows, store.selectedBoardId, store.selectedBoardScope, store.scopesMap);
        if (section === 'docs') return filterDocItemsByScope(rows, [], store.selectedBoardId, store.selectedBoardScope, store.scopesMap).documents;
        if (section === 'chat') return store.pgContextChannels;
        const fixture = {
          isTowerPgMode: true, fileBrowserRows: rows, currentFileFolderId: '',
          selectedBoardId: store.selectedBoardId, taskBoards: store.taskBoards,
          pgContextScopeId: store.pgContextScopeId,
          pgContextSelectedChannelId: store.pgContextSelectedChannelId,
          pgContextSelectedThreadId: store.pgContextSelectedThreadId,
          scopesMap: store.scopesMap,
        };
        return Object.getOwnPropertyDescriptor(filesManagerMixin, 'filteredFileBrowserRows').get.call(fixture);
      };
      expect(filtered()).toHaveLength(1);
      store.toggleCurrentViewLock();
      await store.openAllScopesOverview();
      expect(filtered()).toHaveLength(2);
    }
  });
  it('closes an open task once before completing Home navigation', async () => {
    const store = makeStore('tasks');
    store.showTaskDetail = true;
    store.closeTaskDetail = vi.fn(async () => {
      await Promise.resolve();
      store.showTaskDetail = false;
      store.activeTaskId = null;
    });
    store.toggleCurrentViewLock();
    await store.openAllScopesOverview();
    expect(store.closeTaskDetail).toHaveBeenCalledTimes(1);
    expect(store.showTaskDetail).toBe(false);
  });
  it('awaits document cleanup before publishing the workspace route', async () => {
    const store = makeStore('docs');
    store.docsEditorOpen = true;
    store.selectedDocument = { record_id: 'doc-old' };
    store.selectedDocId = 'doc-old';
    store.selectedDocType = 'document';
    store.resetOpenDocumentForContextChange = vi.fn(async () => {
      await Promise.resolve();
      store.selectedDocId = null;
      store.selectedDocType = null;
    });
    store.toggleCurrentViewLock();
    await store.openAllScopesOverview();
    expect(store.resetOpenDocumentForContextChange).toHaveBeenCalled();
    expect(store.selectedDocId).toBeNull();
  });
  it('unlocks on a second click and starts a fresh view unlocked', () => {
    const store = makeStore();
    store.toggleCurrentViewLock();
    store.toggleCurrentViewLock();
    expect(store.lockedView).toBeNull();
    store.toggleCurrentViewLock();
    store.navigateTo('files');
    expect(store.lockedView).toBeNull();
    store.toggleCurrentViewLock();
    expect(store.lockedView).toBe('files');
    store.navigateTo('files');
    expect(store.lockedView).toBe('files');
  });
  it('clears a lock for direct/deep-link section changes without reviving it on return', () => {
    const store = makeStore();
    store.toggleCurrentViewLock();
    store.navSection = 'docs';
    store.navSection = 'tasks';
    expect(store.lockedView).toBeNull();
  });
  it('never locks Deck or Setup and never persists into a new shell', () => {
    for (const section of ['status', 'settings']) {
      const store = makeStore(section);
      store.toggleCurrentViewLock();
      expect(store.canLockCurrentView).toBe(false);
      expect(store.lockedView).toBeNull();
    }
    const store = makeStore();
    store.toggleCurrentViewLock();
    expect(makeStore().lockedView).toBeNull();
    store.navigateTo('status');
    expect(store.lockedView).toBeNull();
  });
  it('gates locking on the scope/channel sidebar and clears it when changing mode', async () => {
    const store = createStore();
    store.toggleCurrentViewLock();
    store.togglePrimaryNav();
    expect(store.lockedView).toBeNull();
    expect(store.canLockCurrentView).toBe(false);
    store.toggleCurrentViewLock();
    expect(store.lockedView).toBeNull();
    await store.selectWorkContextScope('scope-new');
    expect(store.navSection).toBe('status');
    store.navSection = 'tasks';
    store.mobileNavOpen = true;
    expect(store.canLockCurrentView).toBe(true);
  });
  it('keeps explicit Deck navigation authoritative while locked', () => {
    const store = makeStore();
    store.toggleCurrentViewLock();
    store.selectDeckScope('scope-new');
    expect(store.navSection).toBe('status');
    expect(store.lockedView).toBeNull();
  });
  it('renders independent native toggle buttons with state, tooltip, and focus treatment', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const buttons = html.match(/<button type="button" class="view-lock-button(?: mobile-view-lock-button)?"[\s\S]*?<\/button>/g);
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button).toContain(':aria-pressed="$store.chat.isCurrentViewLocked"');
      expect(button).toContain('aria-label="Lock ');
      expect(button).toContain(':title=');
      expect(button).toContain('@click.stop="$store.chat.toggleCurrentViewLock()"');
    }
  });
});


describe('Docs context entry and draft safety', () => {
  it('opens the destination home when keeping Docs through a channel switch', async () => {
    const s = createStore('docs'); s.toggleCurrentViewLock(); s.openChannelDocsHome = vi.fn();
    await s.selectWorkContextChannel('channel-new');
    expect(s.selectedChannelId).toBe('channel-new');
    expect(s.openChannelDocsHome).toHaveBeenCalledWith({ syncRoute: false });
  });
  it.each([false, true])('does not switch context on a failed document checkpoint (locked: %s)', async (locked) => {
    const s = createStore('docs'); if (locked) s.toggleCurrentViewLock();
    s.docEditDraftDirty = true; s.selectedDocId = 'dirty-doc'; s.preserveWikiNavigationDraft = vi.fn().mockResolvedValue(false);
    expect(await s.selectWorkContextChannel('channel-new')).toBe(false);
    expect(s.navSection).toBe('docs'); expect(s.selectedBoardId).toBe('scope-old'); expect(s.selectedChannelId).toBeNull();
  });
});
