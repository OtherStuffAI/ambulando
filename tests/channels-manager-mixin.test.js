import { describe, expect, it, vi } from 'vitest';
import './setup.js';

import { channelsManagerMixin } from '../src/channels-manager.js';
import { createChatPresentationCache } from '../src/chat-presentation-cache.js';
import fs from 'node:fs';
import path from 'node:path';

function createStore(overrides = {}) {
  const store = {
    channels: [],
    selectedChannelId: null,
    chatPresentationCache: createChatPresentationCache(),
    mainFeedVisibleCount: 80,
    MAIN_FEED_PAGE_SIZE: 80,
    expandedChatMessageIds: [],
    truncatedChatMessageIds: [],
    pendingChatScrollToLatest: false,
    selectedChannelUnreadCutoff: null,
    selectedChannelUnreadChannelId: null,
    syncRoute: vi.fn(),
    startSelectedChannelLiveQuery: vi.fn(),
    ensureBackgroundSync: vi.fn(),
    closeThread: vi.fn(),
    markChannelRead: vi.fn().mockResolvedValue(undefined),
    captureSelectedChannelUnreadSnapshot: vi.fn().mockReturnValue('2026-04-10T05:00:00.000Z'),
    updatePageTitle: vi.fn(),
    loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
    rememberPeople: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  const descriptors = Object.getOwnPropertyDescriptors(channelsManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'loadChannelMessagesForSelection')) {
    store.loadChannelMessagesForSelection = vi.fn().mockResolvedValue([]);
  }

  return store;
}

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'app.js'),
  'utf-8',
);

describe('channelsManagerMixin', () => {
  it('shows an uncached destination heading and neutral feed before its local read resolves', async () => {
    let resolveRead;
    const events = [];
    const store = createStore({
      selectedChannelId: 'channel-a',
      messages: [{ record_id: 'a-1', channel_id: 'channel-a' }],
      loadChannelMessagesForSelection: vi.fn(() => new Promise((resolve) => { resolveRead = resolve; })),
      applyMessages: vi.fn(function applyMessages(messages) {
        events.push(['apply', this.selectedChannelId, messages.map((message) => message.record_id)]);
        this.messages = messages;
      }),
      startSelectedChannelLiveQuery: vi.fn(() => events.push(['subscribe'])),
    });

    const selection = store.selectChannel('channel-b', { syncRoute: false });
    expect(store.selectedChannelId).toBe('channel-b');
    expect(store.messages).toEqual([]);
    expect(store.pendingChannelSelectionId).toBe('channel-b');

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    resolveRead([{ record_id: 'b-1', channel_id: 'channel-b' }]);
    await selection;

    expect(events).toEqual([['apply', 'channel-b', ['b-1']], ['subscribe']]);
    expect(store.loadChannelMessagesForSelection).toHaveBeenCalledTimes(1);
    expect(store.applyMessages).not.toHaveBeenCalledWith([], expect.anything());
  });

  it('does not reselect a stale reference channel after a newer document visit while its local read waits', async () => {
    let resolveRead;
    let current = true;
    const store = createStore({
      navSection: 'chat', selectedChannelId: 'channel-a', selectedBoardId: 'source-board',
      channels: [{ record_id: 'channel-b', scope_id: 'scope-b' }],
      currentWorkspace: { pgBackendMode: true }, messages: [],
      loadChannelMessagesForSelection: vi.fn(() => new Promise(resolve => { resolveRead = resolve; })),
      applyMessages: vi.fn(),
    });
    const selection = store.selectChannel('channel-b', { isCurrent: () => current, syncRoute: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    current = false;
    store.navSection = 'docs';
    store.selectedChannelId = 'document-channel';
    store.selectedBoardId = 'document-board';
    resolveRead([{ record_id: 'b-1', channel_id: 'channel-b' }]);
    await selection;
    expect(store.selectedChannelId).toBe('document-channel');
    expect(store.selectedBoardId).toBe('document-board');
    expect(store.applyMessages).not.toHaveBeenCalled();
    expect(store.startSelectedChannelLiveQuery).not.toHaveBeenCalled();
    expect(store.syncRoute).not.toHaveBeenCalled();
  });

  it('allows only the newest selection generation to apply during rapid switching', async () => {
    const resolvers = new Map();
    const store = createStore({
      selectedChannelId: 'channel-a',
      messages: [{ record_id: 'a-1', channel_id: 'channel-a' }],
      loadChannelMessagesForSelection: vi.fn((channelId) => new Promise((resolve) => resolvers.set(channelId, resolve))),
      applyMessages: vi.fn(function applyMessages(messages) { this.messages = messages; }),
    });

    const toB = store.selectChannel('channel-b', { syncRoute: false });
    const toC = store.selectChannel('channel-c', { syncRoute: false });
    await Promise.resolve();
    await Promise.resolve();
    await toB;
    expect(store.selectedChannelId).toBe('channel-c');
    expect(store.messages).toEqual([]);
    resolvers.get('channel-c')([{ record_id: 'c-1', channel_id: 'channel-c' }]);
    await toC;

    expect(store.selectedChannelId).toBe('channel-c');
    expect(store.messages.map((message) => message.record_id)).toEqual(['c-1']);
    expect(store.applyMessages).toHaveBeenCalledTimes(1);
  });

  it('commits a cached A to B to A revisit synchronously without a Dexie read', async () => {
    const store = createStore({
      selectedChannelId: 'channel-a',
      messages: [{ record_id: 'a-1', channel_id: 'channel-a', updated_at: '1' }],
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([
        { record_id: 'b-1', channel_id: 'channel-b', updated_at: '2' },
      ]),
      applyMessages: vi.fn(function applyMessages(messages) { this.messages = messages; }),
    });

    await store.selectChannel('channel-b', { syncRoute: false });
    store.loadChannelMessagesForSelection.mockClear();
    const toA = store.selectChannel('channel-a', { syncRoute: false });

    expect(store.selectedChannelId).toBe('channel-a');
    expect(store.messages.map((message) => message.record_id)).toEqual(['a-1']);
    expect(store.pendingChannelSelectionId).toBe('');
    expect(store.loadChannelMessagesForSelection).not.toHaveBeenCalled();
    await toA;
  });

  it('publishes a genuine empty destination only after its local read resolves', async () => {
    const store = createStore({
      selectedChannelId: 'channel-a',
      messages: [{ record_id: 'a-1', channel_id: 'channel-a' }],
      loadChannelMessagesForSelection: vi.fn().mockResolvedValue([]),
      applyMessages: vi.fn(function applyMessages(messages) { this.messages = messages; }),
    });

    await store.selectChannel('channel-empty', { syncRoute: false });

    expect(store.selectedChannelId).toBe('channel-empty');
    expect(store.messages).toEqual([]);
    expect(store.startSelectedChannelLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('selectChannel resets the main-feed window and keeps bottom-anchor intent by default', async () => {
    const store = createStore({
      mainFeedVisibleCount: 99,
      pendingChatScrollToLatest: false,
    });

    await store.selectChannel('channel-1');

    expect(store.selectedChannelId).toBe('channel-1');
    expect(store.mainFeedVisibleCount).toBe(80);
    expect(store.pendingChatScrollToLatest).toBe(true);
    expect(store.startSelectedChannelLiveQuery).toHaveBeenCalledTimes(1);
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('reselecting the active channel retains its messages, thread, and live subscription', async () => {
    const applyMessages = vi.fn();
    const restoreChatComposerDraft = vi.fn();
    const closeThread = vi.fn();
    const startSelectedChannelLiveQuery = vi.fn();
    const store = createStore({
      selectedChannelId: 'channel-1',
      activeThreadId: 'thread-1',
      messages: [{ record_id: 'message-1' }],
      applyMessages,
      restoreChatComposerDraft,
      closeThread,
      startSelectedChannelLiveQuery,
      refreshMessages: vi.fn().mockResolvedValue(undefined),
    });

    await store.selectChannel('channel-1');

    expect(store.messages).toEqual([{ record_id: 'message-1' }]);
    expect(store.activeThreadId).toBe('thread-1');
    expect(applyMessages).not.toHaveBeenCalledWith([], { scrollToLatest: false });
    expect(restoreChatComposerDraft).not.toHaveBeenCalled();
    expect(closeThread).not.toHaveBeenCalled();
    expect(startSelectedChannelLiveQuery).not.toHaveBeenCalled();
    expect(store.pendingChatScrollToLatest).toBe(true);
  });

  it('selectChannel promotes All scope to the selected channel scope', async () => {
    const store = createStore({
      selectedBoardId: '__all__',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-home', record_state: 'active' },
      ],
      selectBoard: vi.fn(function selectBoard(boardId) {
        this.selectedBoardId = boardId;
      }),
    });

    await store.selectChannel('channel-home');

    expect(store.selectBoard).toHaveBeenCalledWith('scope-home');
    expect(store.selectedBoardId).toBe('scope-home');
    expect(store.selectedChannelId).toBe('channel-home');
  });

  it('captures the selected channel unread snapshot before markChannelRead clears the live unread cursor', async () => {
    const callOrder = [];
    const store = createStore({
      captureSelectedChannelUnreadSnapshot: vi.fn(() => {
        callOrder.push('capture');
        return '2026-04-10T05:00:00.000Z';
      }),
      markChannelRead: vi.fn(async () => {
        callOrder.push('mark');
      }),
    });

    await store.selectChannel('channel-1');

    expect(store.captureSelectedChannelUnreadSnapshot).toHaveBeenCalledWith('channel-1');
    expect(callOrder).toEqual(['capture', 'mark']);
    expect(store.selectedChannelUnreadChannelId).toBe('channel-1');
    expect(store.selectedChannelUnreadCutoff).toBe('2026-04-10T05:00:00.000Z');
  });

  it('route-driven chat focus no longer suppresses scrollToLatest on channel open', () => {
    expect(appSource).not.toContain("await this.selectChannel(item.channelId, { scrollToLatest: false });");
  });

  it('keeps bottom-scroll intent when navigating back to an already selected chat channel', () => {
    expect(appSource).toMatch(/else \{\s*this\.pendingChatScrollToLatest = true;\s*this\.scheduleChatFeedScrollToBottom\(\);/);
  });

  it('refreshGroups supports a max-age guard for group key refreshes', () => {
    const source = channelsManagerMixin.refreshGroups.toString();
    expect(source).toContain('options.maxAgeMs');
    expect(source).toContain('expiredByMaxAge');
    expect(source).toContain('!expiredByMaxAge');
  });
});

it('hydrates the mention roster on cold PG chat entry without opening settings', async () => {
  const refreshTowerPgWorkspaceMembers = vi.fn().mockResolvedValue([]);
  const store = createStore({
    currentWorkspace: { workspaceId: 'workspace-a', pgBackendMode: true },
    refreshTowerPgWorkspaceMembers,
    selectedChannelId: null,
  });
  await store.selectChannel('channel-a', { syncRoute: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(refreshTowerPgWorkspaceMembers).toHaveBeenCalled();
});


it('refuses a Docs channel switch when its outgoing draft cannot be preserved', async () => {
  const store = createStore({ navSection: 'docs', docsEditorOpen: true, selectedChannelId: 'channel-a',
    selectedDocument: { record_id: 'origin' }, docEditDraftDirty: true,
    resetOpenDocumentForContextChange: vi.fn(), preserveWikiNavigationDraft: vi.fn().mockResolvedValue(false) });
  await store.selectChannel('channel-b', { syncRoute: false });
  expect(store.selectedChannelId).toBe('channel-a');
  expect(store.resetOpenDocumentForContextChange).not.toHaveBeenCalled();
});
