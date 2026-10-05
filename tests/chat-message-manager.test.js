import { beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

// Mock Alpine.js — it requires a browser `window` at import time
vi.mock('alpinejs', () => ({
  default: { nextTick: (fn) => fn?.() },
}));

vi.mock('../src/translators/chat.js', () => ({
  outboundChatMessage: vi.fn(async (payload) => ({ ...payload, record_family_hash: 'mock:chat_message' })),
  outboundChannel: vi.fn(async (payload) => ({ ...payload, record_family_hash: 'mock:channel' })),
  recordFamilyHash: (family) => `mock:${family}`,
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => false),
}));

vi.mock('../src/pg-write-adapter.js', () => ({
  createTowerPgMessageFromLocal: vi.fn(),
  updateTowerPgMessageFromLocal: vi.fn(),
  archiveTowerPgThreadFromLocal: vi.fn(),
  deleteTowerPgMessageFromLocal: vi.fn(),
  deleteTowerPgThreadFromLocal: vi.fn(),
  updateTowerPgThreadTitleFromLocal: vi.fn(),
  branchTowerPgThreadFromMessage: vi.fn(),
}));

vi.mock('../src/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  completeStorageObject: vi.fn(),
  downloadStorageObjectBlob: vi.fn(),
  uploadStorageObject: vi.fn(),
}));

import { isTowerPgBackendMode } from '../src/backend-mode.js';
import { completeStorageObject, downloadStorageObjectBlob, uploadStorageObject } from '../src/api.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { createChatThreadFlowDispatchState } from '../src/chat-thread-flow-dispatch.js';
import { createChatGetItDoneState } from '../src/chat-get-it-done.js';
import { branchTowerPgThreadFromMessage, createTowerPgMessageFromLocal, updateTowerPgMessageFromLocal, updateTowerPgThreadTitleFromLocal } from '../src/pg-write-adapter.js';
import {
  archiveTowerPgThreadFromLocal,
  deleteTowerPgMessageFromLocal,
  deleteTowerPgThreadFromLocal,
} from '../src/pg-write-adapter.js';
import {
  clearRuntimeData,
  deleteWorkspaceDb,
  getMessageById,
  getMessagePresentationWindowByChannel,
  getThreadMessagePresentationWindow,
  getMessagesByChannel,
  openWorkspaceDb,
  replacePgMessagesForChannel,
  upsertMessage,
} from '../src/db.js';
import * as messageDb from '../src/db.js';
import { hydrateTowerPgThreadMessages } from '../src/pg-read-hydrator.js';

beforeEach(() => {
  isTowerPgBackendMode.mockReturnValue(false);
  createTowerPgMessageFromLocal.mockReset();
  updateTowerPgMessageFromLocal.mockReset();
  archiveTowerPgThreadFromLocal.mockReset();
  deleteTowerPgMessageFromLocal.mockReset();
  deleteTowerPgThreadFromLocal.mockReset();
  updateTowerPgThreadTitleFromLocal.mockReset();
  branchTowerPgThreadFromMessage.mockReset();
  completeStorageObject.mockReset();
  downloadStorageObjectBlob.mockReset();
  uploadStorageObject.mockReset();
});

// ---------------------------------------------------------------------------
// Helper: create a fake store with all mixin methods applied
// ---------------------------------------------------------------------------
function createStore(overrides = {}) {
  const store = {
    messages: [],
    channels: [],
    flows: [],
    scopes: [],
    selectedChannelId: null,
    activeThreadId: null,
    threadInput: '',
    messageInput: '',
    chatComposerDrafts: {},
    messageAudioDrafts: [],
    threadAudioDrafts: [],
    audioNotes: [],
    expandedChatMessageIds: [],
    truncatedChatMessageIds: [],
    focusMessageId: null,
    threadVisibleReplyCount: 6,
    mainFeedVisibleCount: 80,
    threadSize: 'default',
    threadMenuOpen: false,
    threadTitleEditing: false,
    threadTitleDraft: '',
    threadTitleSaving: false,
    threadTitleError: '',
    pendingChatScrollToLatest: false,
    pendingThreadScrollToLatest: false,
    pendingThreadActivityAutoScroll: null,
    messageImageUploadCount: 0,
    threadImageUploadCount: 0,
    chatFeedScrollFrame: null,
    threadRepliesScrollFrame: null,
    chatPreviewMeasureFrame: null,
    showChannelSettingsModal: false,
    showFlowStartConfirm: false,
    flowStartTarget: null,
    flowStartContext: '',
    messageActionsMenuId: null,
    messageResendPendingIds: [],
    messageEdit: {
      recordId: '', context: '', channelId: '', threadRootId: '', originalBody: '',
      draftBeforeEdit: '', mentionsBeforeEdit: [], submitting: false, error: '',
    },
    selectedAgentMentionsByComposer: { message: [], thread: [] },
    showArchivedChatThreads: false,
    chatThreadArchiveSubmittingId: '',
    chatThreadArchiveSubmittingAction: '',
    chatDeleteConfirm: {
      open: false,
      mode: '',
      recordId: '',
      title: '',
      message: '',
      submitting: false,
      error: '',
    },
    error: null,
    session: null,
    botNpub: '',
    backendUrl: '',
    THREAD_REPLY_PAGE_SIZE: 6,
    MAIN_FEED_PAGE_SIZE: 80,
    COMPOSER_MAX_LINES: 5,
    MESSAGE_PREVIEW_MAX_LINES: 15,
    // Stubs for methods from other mixins / the store
    syncRoute: vi.fn(),
    rememberPeople: vi.fn().mockResolvedValue(undefined),
    captureScrollAnchor: vi.fn().mockReturnValue(null),
    restoreScrollAnchor: vi.fn(),
    scheduleStorageImageHydration: vi.fn(),
    performSync: vi.fn().mockResolvedValue(undefined),
    ensureBackgroundSync: vi.fn(),
    selectChannel: vi.fn().mockResolvedValue(undefined),
    refreshChannels: vi.fn().mockResolvedValue(undefined),
    createEncryptedGroup: vi.fn().mockResolvedValue({ group_id: 'g1' }),
    getPreferredChannelWriteGroup: vi.fn().mockReturnValue('g1'),
    getChannelLabel: vi.fn().mockReturnValue('test-channel'),
    getTaskBoardOptionLabel: vi.fn((scopeId) => scopeId ? `Scope ${scopeId}` : ''),
    buildTaskBoardAssignment: vi.fn((scopeId) => {
      if (scopeId === '__unscoped__') {
        return {
          scope_id: null,
          scope_l1_id: null,
          scope_l2_id: null,
          scope_l3_id: null,
          scope_l4_id: null,
          scope_l5_id: null,
          scope_policy_group_ids: null,
          board_group_id: 'workspace-default',
          group_ids: ['workspace-default'],
          shares: [{ type: 'group', group_npub: 'workspace-default', access: 'write' }],
        };
      }
      return {
        scope_id: scopeId,
        scope_l1_id: scopeId,
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: [`policy:${scopeId}`],
        board_group_id: `group:${scopeId}`,
        group_ids: [`group:${scopeId}`],
        shares: [{ type: 'group', group_npub: `group:${scopeId}`, access: 'write' }],
      };
    }),
    materializeAudioDrafts: vi.fn().mockResolvedValue({ attachments: [] }),
    containsInlineImageUploadToken: vi.fn().mockReturnValue(false),
    getSenderName: vi.fn((npub) => npub ? `Name ${npub}` : ''),
    getSenderAvatar: vi.fn(() => null),
    getInitials: vi.fn((name) => String(name || 'NA').slice(0, 2).toUpperCase()),
    findPeopleSuggestions: vi.fn(() => []),
    scopesMap: new Map(),
    scopePickerFlatFor: vi.fn(() => []),
    getScopeBreadcrumb: vi.fn((scopeId) => scopeId ? `Breadcrumb ${scopeId}` : ''),
    scopeLevelLabel: vi.fn((level) => level || ''),
    openRecordStatusModal: vi.fn(),
    workspaceOwnerNpub: 'npub1owner',
    ...createChatGetItDoneState(),
    ...overrides,
  };

  // Apply all mixin methods and getters
  const descriptors = Object.getOwnPropertyDescriptors(chatMessageManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  return store;
}

describe('destination-specific chat composer drafts', () => {
  it('restores channel drafts only for their workspace, scope, and channel', () => {
    const store = createStore({
      channels: [
        { record_id: 'channel-x', scope_id: 'scope-a' },
        { record_id: 'channel-y', scope_id: 'scope-b' },
      ],
      selectedChannelId: 'channel-x',
      messageInput: 'draft for x',
      currentWorkspaceKey: 'workspace-a',
    });

    store.saveChatComposerDraft('message');
    store.selectedChannelId = 'channel-y';
    store.restoreChatComposerDraft('message');
    expect(store.messageInput).toBe('');

    store.messageInput = 'draft for y';
    store.saveChatComposerDraft('message');
    store.selectedChannelId = 'channel-x';
    store.restoreChatComposerDraft('message');
    expect(store.messageInput).toBe('draft for x');

    store.selectedChannelId = 'channel-y';
    store.restoreChatComposerDraft('message');
    expect(store.messageInput).toBe('draft for y');
  });

  it('keeps channel and thread drafts in separate destinations', () => {
    const store = createStore({
      channels: [{ record_id: 'channel-x', scope_id: 'scope-a' }],
      selectedChannelId: 'channel-x',
      messageInput: 'channel draft',
      activeThreadId: 'thread-1',
      threadInput: 'thread one draft',
      currentWorkspaceKey: 'workspace-a',
    });

    store.saveChatComposerDraft('message');
    store.saveChatComposerDraft('thread');
    store.activeThreadId = 'thread-2';
    store.restoreChatComposerDraft('thread');
    expect(store.threadInput).toBe('');

    store.threadInput = 'thread two draft';
    store.saveChatComposerDraft('thread');
    store.activeThreadId = 'thread-1';
    store.restoreChatComposerDraft('thread');
    expect(store.threadInput).toBe('thread one draft');
    store.restoreChatComposerDraft('message');
    expect(store.messageInput).toBe('channel draft');
  });

  it('marks PG scope Home read-only and a concrete selected channel writable', () => {
    const store = createStore({
      currentWorkspace: { pgBackendMode: true },
      channels: [{ record_id: 'channel-x', scope_id: 'scope-a' }],
      selectedChannelId: null,
      pgContextSelectedChannelId: null,
    });
    expect(store.canComposeInChatDestination).toBe(false);
    expect(store.chatComposerDisabledReason).toContain('read-only rollup');

    store.selectedChannelId = 'channel-x';
    store.pgContextSelectedChannelId = 'channel-x';
    expect(store.canComposeInChatDestination).toBe(true);
  });
});

function bindMethod(methodName, overrides = {}) {
  const store = createStore(overrides);
  const method = store[methodName];
  if (typeof method === 'function') {
    return { fn: method.bind(store), store };
  }
  return { store };
}

// ---------------------------------------------------------------------------
// Computed getters
// ---------------------------------------------------------------------------
describe('chat message computed getters', () => {
  it('selectedChannel returns matching channel', () => {
    const ch = { record_id: 'ch1', title: 'General' };
    const store = createStore({ channels: [ch], selectedChannelId: 'ch1' });
    expect(store.selectedChannel).toEqual(ch);
  });

  it('selectedChannel returns null when no match', () => {
    const store = createStore({ channels: [], selectedChannelId: 'ch1' });
    expect(store.selectedChannel).toBeNull();
  });

  it('mainFeedMessages returns ranked messages', () => {
    const store = createStore({
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: 'm1', updated_at: '2024-01-01T01:00:00Z' },
        { record_id: 'm3', parent_message_id: null, updated_at: '2024-01-01T02:00:00Z' },
      ],
    });
    const feed = store.mainFeedMessages;
    // mainFeedMessages should only contain top-level messages (parent_message_id == null)
    expect(feed.every((m) => m.parent_message_id === null)).toBe(true);
  });

  it('visibleMainFeedMessages returns the newest feed window', () => {
    const store = createStore({
      mainFeedVisibleCount: 2,
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: null, updated_at: '2024-01-01T01:00:00Z' },
        { record_id: 'm3', parent_message_id: null, updated_at: '2024-01-01T02:00:00Z' },
      ],
    });
    expect(store.visibleMainFeedMessages.map((message) => message.record_id)).toEqual(['m2', 'm3']);
    expect(store.hiddenMainFeedCount).toBe(1);
    expect(store.hasMoreMainFeedMessages).toBe(true);
  });

  it('visibleMainFeedMessages defaults to the newest 80 messages when the page size is 80', () => {
    const messages = Array.from({ length: 85 }, (_, index) => ({
      record_id: `m${index + 1}`,
      parent_message_id: null,
      updated_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    }));
    const store = createStore({
      MAIN_FEED_PAGE_SIZE: 80,
      mainFeedVisibleCount: 80,
      messages,
    });
    expect(store.visibleMainFeedMessages).toHaveLength(80);
    expect(store.hiddenMainFeedCount).toBe(5);
    expect(store.visibleMainFeedMessages[0]?.record_id).toBe('m6');
    expect(store.visibleMainFeedMessages.at(-1)?.record_id).toBe('m85');
  });

  it('indexes backlog replies once for all visible thread summary getters', () => {
    let parentIdReads = 0;
    const roots = Array.from({ length: 80 }, (_, index) => ({
      record_id: `root-${index}`,
      parent_message_id: null,
      sender_npub: `npub-root-${index}`,
      updated_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    }));
    const replies = Array.from({ length: 8_000 }, (_, index) => ({
      record_id: `reply-${index}`,
      get parent_message_id() {
        parentIdReads += 1;
        return `root-${index % roots.length}`;
      },
      sender_npub: `npub-replier-${Math.floor(index / roots.length) % 20}`,
      body: `Reply ${index}`,
      updated_at: new Date(Date.UTC(2024, 0, 2, 0, 0, index)).toISOString(),
    }));
    const store = createStore({ messages: [...roots, ...replies] });
    const visible = store.visibleMainFeedMessages;
    const readsAfterIndexing = parentIdReads;

    for (const message of visible) {
      expect(store.getThreadReplyCount(message.record_id)).toBe(100);
      expect(store.getThreadReplierAvatars(message.record_id)).toHaveLength(20);
      expect(store.getLatestThreadReplyPreview(message.record_id)).toMatch(/^Reply /);
    }

    expect(parentIdReads).toBe(readsAfterIndexing);
  });

  it('hides archived top-level threads until archived threads are shown', () => {
    const store = createStore({
      messages: [
        { record_id: 'm1', parent_message_id: null, record_state: 'active', updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: null, record_state: 'archived', updated_at: '2024-01-01T01:00:00Z' },
        { record_id: 'm3', parent_message_id: 'm2', record_state: 'active', updated_at: '2024-01-01T02:00:00Z' },
      ],
    });

    expect(store.mainFeedMessages.map((message) => message.record_id)).toEqual(['m1']);
    expect(store.archivedMainFeedCount).toBe(1);
    expect(store.hasArchivedChatThreads).toBe(true);

    store.toggleShowArchivedChatThreads();

    expect(store.mainFeedMessages.map((message) => message.record_id)).toEqual(['m1', 'm2']);
  });

  it('threadMessages returns empty when no active thread', () => {
    const store = createStore({ activeThreadId: null, messages: [{ record_id: 'm1' }] });
    expect(store.threadMessages).toEqual([]);
  });

  it('threadMessages returns replies for active thread', () => {
    const store = createStore({
      activeThreadId: 'm1',
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: 'm1', updated_at: '2024-01-01T01:00:00Z' },
        { record_id: 'm3', parent_message_id: 'm1', updated_at: '2024-01-01T02:00:00Z' },
        { record_id: 'm4', parent_message_id: null, updated_at: '2024-01-01T03:00:00Z' },
      ],
    });
    const thread = store.threadMessages;
    expect(thread.length).toBe(2);
    expect(thread.every((m) => m.parent_message_id === 'm1')).toBe(true);
  });

  it('adds target-linked audio notes to visible chat message attachments', () => {
    const store = createStore({
      messages: [
        {
          record_id: 'm1',
          parent_message_id: null,
          attachments: [],
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      audioNotes: [
        {
          record_id: 'audio-1',
          target_record_id: 'm1',
          target_record_family_hash: 'mock:chat_message',
          title: 'Reply TTS',
          duration_seconds: 12,
          record_state: 'active',
          updated_at: '2024-01-01T00:01:00Z',
        },
      ],
    });

    expect(store.visibleMainFeedMessages[0]?.attachments).toEqual([
      {
        kind: 'audio',
        audio_note_record_id: 'audio-1',
        title: 'Reply TTS',
        duration_seconds: 12,
      },
    ]);
  });

  it('rebuilds visible chat messages when target-linked audio notes arrive after the message', () => {
    const store = createStore({
      messages: [
        {
          record_id: 'm1',
          parent_message_id: null,
          attachments: [],
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      audioNotes: [],
    });

    expect(store.visibleMainFeedMessages[0]?.attachments).toEqual([]);

    store.audioNotes = [
      {
        record_id: 'audio-1',
        target_record_id: 'm1',
        target_record_family_hash: 'mock:chat_message',
        title: 'Reply TTS',
        record_state: 'active',
        updated_at: '2024-01-01T00:01:00Z',
      },
    ];

    expect(store.visibleMainFeedMessages[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: 'audio',
        audio_note_record_id: 'audio-1',
        title: 'Reply TTS',
      }),
    ]);
  });

  it('does not duplicate audio attachments already present on the message', () => {
    const store = createStore({
      messages: [
        {
          record_id: 'm1',
          parent_message_id: null,
          attachments: [{ kind: 'audio', audio_note_record_id: 'audio-1', title: 'Existing audio' }],
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      audioNotes: [
        {
          record_id: 'audio-1',
          target_record_id: 'm1',
          target_record_family_hash: 'mock:chat_message',
          title: 'Reply TTS',
          record_state: 'active',
          updated_at: '2024-01-01T00:01:00Z',
        },
      ],
    });

    expect(store.visibleMainFeedMessages[0]?.attachments).toEqual([
      { kind: 'audio', audio_note_record_id: 'audio-1', title: 'Existing audio' },
    ]);
  });

  it('hasMoreThreadMessages returns false when no hidden messages', () => {
    const store = createStore({
      activeThreadId: 'm1',
      threadVisibleReplyCount: 10,
      messages: [
        { record_id: 'm2', parent_message_id: 'm1', updated_at: '2024-01-01T01:00:00Z' },
      ],
    });
    expect(store.hasMoreThreadMessages).toBe(false);
  });

  it('hiddenThreadReplyCount is zero when all visible', () => {
    const store = createStore({
      activeThreadId: 'm1',
      threadVisibleReplyCount: 100,
      messages: [
        { record_id: 'm2', parent_message_id: 'm1', updated_at: '2024-01-01T01:00:00Z' },
      ],
    });
    expect(store.hiddenThreadReplyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Thread lifecycle
// ---------------------------------------------------------------------------
describe('thread lifecycle', () => {
  it('creates and opens an inert child branch with inherited history and a blank composer', async () => {
    const workspaceDbKey = 'chat-message-manager-branch';
    await openWorkspaceDb(workspaceDbKey);
    isTowerPgBackendMode.mockReturnValue(true);
    branchTowerPgThreadFromMessage.mockResolvedValue({
      record_id: 'child-thread', channel_id: 'channel-1', pg_thread_id: 'child-thread', pg_backend: true,
      pg_record_type: 'thread', pg_metadata: { inherited_agent_recipient_npub: 'npub1agent' },
    });
    const requestTowerSyncFamily = vi.fn().mockResolvedValue([]);
    const store = createStore({
      isTowerPgMode: true,
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1' }],
      session: { npub: 'npub1human' },
      activeThreadId: 'root',
      requestTowerSyncFamily,
      getSenderName: (npub) => npub === 'npub1agent' ? 'Example Agent' : npub,
      messages: [
        { record_id: 'root', channel_id: 'channel-1', pg_backend: true, pg_thread_id: 'parent-thread', parent_message_id: null, pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Example Agent' }] } },
        { record_id: 'reply', channel_id: 'channel-1', pg_backend: true, pg_thread_id: 'parent-thread', parent_message_id: 'root' },
      ],
    });

    const child = await store.branchFromMessage('reply');

    expect(branchTowerPgThreadFromMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ record_id: 'reply' }), expect.objectContaining({
      parentThreadId: 'parent-thread', recipientNpub: 'npub1agent', clientRequestId: expect.stringMatching(/^branch:/),
    }));
    expect(child).toMatchObject({ record_id: 'child-thread', pg_effective_message_ids: ['root', 'reply'] });
    expect(store.activeThreadId).toBe('child-thread');
    expect(store.threadInput).toBe('');
    expect(store.selectedAgentMentionsByComposer.thread).toEqual([]);
    expect(requestTowerSyncFamily).toHaveBeenCalledWith('thread-history', 'channel-1:child-thread', expect.objectContaining({ force: true }));
    await deleteWorkspaceDb(workspaceDbKey);
  });

  it('restores a legitimate existing child draft without adding the inherited recipient', async () => {
    const workspaceDbKey = 'chat-message-manager-branch-draft';
    await openWorkspaceDb(workspaceDbKey);
    isTowerPgBackendMode.mockReturnValue(true);
    branchTowerPgThreadFromMessage.mockResolvedValue({
      record_id: 'child-thread', channel_id: 'channel-1', pg_thread_id: 'child-thread', pg_backend: true,
      pg_record_type: 'thread', pg_metadata: { inherited_agent_recipient_npub: 'npub1agent' },
    });
    const store = createStore({
      isTowerPgMode: true,
      currentWorkspace: { workspaceId: 'workspace-1' },
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1' }],
      activeThreadId: 'root',
      chatComposerDrafts: {
        'workspace-1::channel-1:child-thread': { value: 'Existing child draft', mentions: [] },
      },
      messages: [{
        record_id: 'root', channel_id: 'channel-1', pg_backend: true, pg_thread_id: 'parent-thread',
        pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Example Agent' }] },
      }],
    });

    await store.branchFromMessage('root');

    expect(store.threadInput).toBe('Existing child draft');
    expect(store.selectedAgentMentionsByComposer.thread).toEqual([]);
    await deleteWorkspaceDb(workspaceDbKey);
  });

  it('retains the same branch idempotency key after a failed attempt', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    branchTowerPgThreadFromMessage.mockRejectedValue(new Error('network lost'));
    const store = createStore({
      isTowerPgMode: true,
      messages: [{ record_id: 'root', channel_id: 'channel-1', pg_backend: true, pg_thread_id: 'parent-thread' }],
    });
    await store.branchFromMessage('root');
    const firstId = branchTowerPgThreadFromMessage.mock.calls[0][2].clientRequestId;
    await store.branchFromMessage('root');
    expect(branchTowerPgThreadFromMessage.mock.calls[1][2].clientRequestId).toBe(firstId);
    expect(store.branchThreadError).toBe('network lost');
  });

  it('openThread sets active thread and resets state', () => {
    const { fn, store } = bindMethod('openThread', {
      activeThreadId: null,
      threadInput: 'leftover',
    });
    fn('m1');
    expect(store.activeThreadId).toBe('m1');
    expect(store.threadInput).toBe('');
    expect(store.threadVisibleReplyCount).toBe(6);
    expect(store.pendingThreadScrollToLatest).toBe(true);
    expect(store.syncRoute).toHaveBeenCalled();
  });

  it('openThread can preserve the composer while switching context', () => {
    const { fn, store } = bindMethod('openThread', {
      activeThreadId: null,
      threadInput: 'workroom reply',
    });
    fn('m1', { preserveComposer: true });
    expect(store.activeThreadId).toBe('m1');
    expect(store.threadInput).toBe('workroom reply');
  });

  it('openThread selects the owning PG channel when opened from an aggregate feed', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const selectPgChannelContext = vi.fn();
    const { fn, store } = bindMethod('openThread', {
      selectedChannelId: null,
      selectPgChannelContext,
      messages: [
        { record_id: 'm1', channel_id: 'channel-1', parent_message_id: null },
      ],
    });

    fn('m1');

    expect(selectPgChannelContext).toHaveBeenCalledWith('channel-1');
    expect(store.activeThreadId).toBe('m1');
  });

  it('openThread can preserve Deck scope and channel context', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const selectPgChannelContext = vi.fn();
    const { fn, store } = bindMethod('openThread', {
      navSection: 'status',
      selectedChannelId: 'deck-channel',
      selectedBoardId: 'deck-scope',
      deckThreadChannelId: 'thread-channel',
      selectPgChannelContext,
      messages: [
        { record_id: 'm1', channel_id: 'thread-channel', parent_message_id: null },
      ],
    });

    fn('m1', { preserveChannelContext: true });

    expect(selectPgChannelContext).not.toHaveBeenCalled();
    expect(store.selectedChannelId).toBe('deck-channel');
    expect(store.selectedBoardId).toBe('deck-scope');
    expect(store.activeThreadId).toBe('m1');
    expect(store.activeThreadChannelId).toBe('thread-channel');
  });

  it('openThread respects syncRoute: false', () => {
    const { fn, store } = bindMethod('openThread');
    fn('m1', { syncRoute: false });
    expect(store.syncRoute).not.toHaveBeenCalled();
    expect(store.pendingThreadScrollToLatest).toBe(true);
  });

  it('opens rename mode with the persisted title and validates save input', async () => {
    const store = createStore({
      activeThreadId: 'message-1',
      messages: [{ record_id: 'message-1', pg_backend: true, pg_thread_id: 'thread-1', title: 'Persisted title', body: 'Message body' }],
    });
    store.startThreadTitleEdit();
    expect(store.threadTitleDraft).toBe('Persisted title');
    store.threadTitleDraft = ' '.repeat(2);
    await store.saveThreadTitle();
    expect(store.threadTitleError).toBe('Enter a thread title.');
    expect(updateTowerPgThreadTitleFromLocal).not.toHaveBeenCalled();
    store.cancelThreadTitleEdit();
    expect(store.threadTitleEditing).toBe(false);
  });

  it('only exposes root Tower threads for title rename', () => {
    const store = createStore({ isTowerPgMode: true });
    expect(store.canRenameThreadTitle({ pg_backend: true, pg_thread_id: 'thread-1', parent_message_id: null })).toBe(true);
    expect(store.canRenameThreadTitle({ pg_backend: true, pg_thread_id: 'thread-1', parent_message_id: 'root-1' })).toBe(false);
    expect(store.canRenameThreadTitle({ pg_backend: true, parent_message_id: null })).toBe(false);
  });

  it('opens an eligible channel root and starts title editing at the header', () => {
    const store = createStore({
      isTowerPgMode: true,
      activeThreadId: null,
      messageActionsMenuId: 'message-1',
      messages: [{ record_id: 'message-1', pg_backend: true, pg_thread_id: 'thread-1', title: 'Root title', parent_message_id: null }],
    });
    store.startThreadTitleEdit('message-1');
    expect(store.activeThreadId).toBe('message-1');
    expect(store.threadTitleEditing).toBe(true);
    expect(store.threadTitleDraft).toBe('Root title');
    expect(store.messageActionsMenuId).toBeNull();
  });

  it('closeThread resets thread state', () => {
    const { fn, store } = bindMethod('closeThread', {
      activeThreadId: 'm1',
      threadInput: 'something',
      threadSize: 'full',
      pendingThreadScrollToLatest: true,
    });
    fn();
    expect(store.activeThreadId).toBeNull();
    expect(store.threadInput).toBe('');
    expect(store.threadSize).toBe('default');
    expect(store.pendingThreadScrollToLatest).toBe(false);
    expect(store.syncRoute).toHaveBeenCalled();
  });

  it('closeThread respects syncRoute: false', () => {
    const { fn, store } = bindMethod('closeThread');
    fn({ syncRoute: false });
    expect(store.syncRoute).not.toHaveBeenCalled();
  });

  it('cycleThreadSize toggles modal fullscreen', () => {
    const { fn, store } = bindMethod('cycleThreadSize', { threadSize: 'default' });
    fn();
    expect(store.threadSize).toBe('full');
    fn();
    expect(store.threadSize).toBe('default');
  });

  it('showMoreThreadMessages reveals the complete local window and restores its anchor', async () => {
    const anchor = { id: 'visible-reply', atBottom: true };
    const store = createStore({ captureScrollAnchor: vi.fn(() => anchor), restoreScrollAnchor: vi.fn(), refreshMessages: vi.fn() });
    await store.showMoreThreadMessages();
    expect(store.threadVisibleReplyCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.restoreScrollAnchor).toHaveBeenCalledWith({ ...anchor, atBottom: false });
    expect(store.threadHistoryLoadAll).toBe(false);
  });

  it('keeps intermediate detail projections from displacing the reader during load all', async () => {
    const initial = [{ record_id: 'root', body: 'Original', channel_id: 'channel', sync_status: 'synced', version: 1 }];
    const store = createStore({ messages: initial, activeThreadId: 'root', selectedChannelId: 'channel', threadHistoryLoadAll: true });
    await store.applyMessages([{ ...initial[0], body: 'Intermediate' }], { threadDetail: true });
    expect(store.messages[0].body).toBe('Original');
    await store.applyMessages([{ ...initial[0], body: 'Complete', version: 2 }], { threadDetail: true, historyComplete: true });
    expect(store.messages[0].body).toBe('Complete');
  });

  it('loads every page, rejects duplicate clicks and retries at the failed cursor', async () => {
    let release;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ nextCursor: 'last' }).mockResolvedValueOnce({ nextCursor: null });
    const store = createStore({ activeThreadId: 'root', selectedChannelId: 'channel',
      messages: [{ record_id: 'root', pg_thread_id: 'thread' }], requestTowerSyncFamily: request, refreshMessages: vi.fn() });
    const loading = store.showMoreThreadMessages();
    expect(store.threadHistoryLoading).toBe(true);
    expect(store.threadVisibleReplyCount).toBe(6);
    await store.showMoreThreadMessages();
    expect(request).toHaveBeenCalledTimes(1);
    release({ nextCursor: 'second' });
    await loading;
    expect(store.threadHistoryError).toBe('offline');
    expect(store.threadVisibleReplyCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.threadHistoryCursor).toBe('second');
    expect(store.threadHistoryLoading).toBe(false);
    await store.showMoreThreadMessages();
    expect(request.mock.calls.map(call => call[2].cursor)).toEqual([null, 'second', 'second', 'last']);
    expect(store.threadHistoryCursor).toBeNull();
    expect(store.threadHistoryError).toBe('');
  });

  it.each([null, { nextCursor: 'repeat' }])('keeps incomplete or cycling history retryable: %j', async result => {
    const store = createStore({ activeThreadId: 'root', selectedChannelId: 'channel', threadHistoryCursor: 'repeat',
      messages: [{ record_id: 'root', pg_thread_id: 'thread' }],
      requestTowerSyncFamily: vi.fn().mockResolvedValue(result), refreshMessages: vi.fn() });
    await store.showMoreThreadMessages();
    expect(store.threadHistoryError).toBeTruthy();
    expect(store.threadHistoryCursor).toBe('repeat');
    expect(store.threadHistoryLoading).toBe(false);
  });

  it('ignores page completion after navigating away and back to the same thread', async () => {
    let release;
    const store = createStore({ activeThreadId: 'root', selectedChannelId: 'channel', threadHistoryGeneration: 1,
      messages: [{ record_id: 'root', pg_thread_id: 'thread' }],
      requestTowerSyncFamily: vi.fn(() => new Promise(resolve => { release = resolve; })), refreshMessages: vi.fn() });
    const loading = store.showMoreThreadMessages();
    store.threadHistoryGeneration = 2;
    store.threadHistoryCursor = 'new-view';
    release({ nextCursor: 'stale' });
    await loading;
    expect(store.threadHistoryCursor).toBe('new-view');
    expect(store.refreshMessages).not.toHaveBeenCalled();
  });

  it('showMoreMainFeedMessages increases visible count', () => {
    const { fn, store } = bindMethod('showMoreMainFeedMessages', {
      mainFeedVisibleCount: 80,
      MAIN_FEED_PAGE_SIZE: 80,
    });
    fn();
    expect(store.mainFeedVisibleCount).toBe(160);
    fn();
    expect(store.mainFeedVisibleCount).toBe(240);
  });

  it('showMoreMainFeedMessages expands by 80 and restores the captured anchor', () => {
    const anchor = { id: 'm80' };
    const { fn, store } = bindMethod('showMoreMainFeedMessages', {
      mainFeedVisibleCount: 80,
      MAIN_FEED_PAGE_SIZE: 80,
      captureScrollAnchor: vi.fn().mockReturnValue(anchor),
      restoreScrollAnchor: vi.fn(),
    });
    fn();
    expect(store.mainFeedVisibleCount).toBe(160);
    expect(store.captureScrollAnchor).toHaveBeenCalled();
    expect(store.restoreScrollAnchor).toHaveBeenCalledWith(anchor);
  });

  it('getThreadParentMessage returns parent', () => {
    const parent = { record_id: 'm1', parent_message_id: null };
    const { fn } = bindMethod('getThreadParentMessage', {
      activeThreadId: 'm1',
      messages: [parent, { record_id: 'm2', parent_message_id: 'm1' }],
    });
    expect(fn()).toEqual(parent);
  });

  it('getThreadParentMessage returns null when no thread', () => {
    const { fn } = bindMethod('getThreadParentMessage', { activeThreadId: null });
    expect(fn()).toBeNull();
  });

  it('getThreadReplyCount counts replies', () => {
    const { fn } = bindMethod('getThreadReplyCount', {
      messages: [
        { record_id: 'm1', parent_message_id: null },
        { record_id: 'm2', parent_message_id: 'm1' },
        { record_id: 'm3', parent_message_id: 'm1' },
        { record_id: 'm4', parent_message_id: 'm5' },
      ],
    });
    expect(fn('m1')).toBe(2);
    expect(fn('m5')).toBe(1);
    expect(fn('m99')).toBe(0);
  });

  it('derives the latest thread reply preview from the newest reply', () => {
    const words = Array.from({ length: 55 }, (_, index) => `word${index + 1}`).join(' ');
    const store = createStore({
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: 'm1', body: 'older reply', updated_at: '2024-01-01T00:01:00Z' },
        { record_id: 'm3', parent_message_id: 'm1', body: words, updated_at: '2024-01-01T00:02:00Z' },
      ],
    });

    const preview = store.getLatestThreadReplyPreview('m1');
    expect(preview.split(/\s+/)).toHaveLength(50);
    expect(preview).toContain('word50...');
  });

  it('returns no latest reply preview when a thread has no replies', () => {
    const { fn } = bindMethod('getLatestThreadReplyPreview', {
      messages: [{ record_id: 'm1', parent_message_id: null, body: 'root' }],
    });
    expect(fn('m1')).toBe('');
  });

  it('returns one replier avatar per distinct reply author in reply order', () => {
    const store = createStore({
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: 'm1', sender_npub: 'alice', updated_at: '2024-01-01T00:01:00Z' },
        { record_id: 'm3', parent_message_id: 'm1', sender_npub: 'bob', updated_at: '2024-01-01T00:02:00Z' },
        { record_id: 'm4', parent_message_id: 'm1', sender_npub: 'alice', updated_at: '2024-01-01T00:03:00Z' },
      ],
      getSenderName: vi.fn((npub) => ({ alice: 'Alice Example', bob: 'Bob Example' })[npub] || npub),
      getSenderAvatar: vi.fn((npub) => npub === 'bob' ? 'https://example.test/bob.png' : null),
    });

    expect(store.getThreadReplierAvatars('m1')).toEqual([
      {
        npub: 'alice',
        name: 'Alice Example',
        avatarUrl: null,
        initials: 'AL',
      },
      {
        npub: 'bob',
        name: 'Bob Example',
        avatarUrl: 'https://example.test/bob.png',
        initials: 'BO',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Chat preview truncation
// ---------------------------------------------------------------------------
describe('chat preview truncation', () => {
  it('isChatMessageExpanded checks list', () => {
    const { fn } = bindMethod('isChatMessageExpanded', {
      expandedChatMessageIds: ['m1', 'm3'],
    });
    expect(fn('m1')).toBe(true);
    expect(fn('m2')).toBe(false);
  });

  it('isChatMessageTruncated checks list', () => {
    const { fn } = bindMethod('isChatMessageTruncated', {
      truncatedChatMessageIds: ['m2'],
    });
    expect(fn('m2')).toBe(true);
    expect(fn('m1')).toBe(false);
  });

  it('toggleChatMessageExpanded adds and removes', () => {
    const { fn, store } = bindMethod('toggleChatMessageExpanded', {
      expandedChatMessageIds: [],
    });
    fn('m1');
    expect(store.expandedChatMessageIds).toContain('m1');
    fn('m1');
    expect(store.expandedChatMessageIds).not.toContain('m1');
  });

  it('toggleChatMessageExpanded ignores empty recordId', () => {
    const { fn, store } = bindMethod('toggleChatMessageExpanded', {
      expandedChatMessageIds: [],
    });
    fn('');
    expect(store.expandedChatMessageIds).toEqual([]);
    fn(null);
    expect(store.expandedChatMessageIds).toEqual([]);
  });

  it('syncChatPreviewState prunes invalid IDs', () => {
    const { fn, store } = bindMethod('syncChatPreviewState', {
      mainFeedVisibleCount: 1,
      messages: [
        { record_id: 'm1', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'm2', parent_message_id: null, updated_at: '2024-01-01T01:00:00Z' },
      ],
      expandedChatMessageIds: ['m1', 'm999'],
      truncatedChatMessageIds: ['m999', 'm1'],
    });
    fn();
    expect(store.expandedChatMessageIds).toEqual([]);
    expect(store.truncatedChatMessageIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scroll anchoring (no-op in test env — just verify no throw)
// ---------------------------------------------------------------------------
describe('scroll and composer methods', () => {
  it('scheduleChatFeedScrollToBottom does not throw in test env', () => {
    const { fn } = bindMethod('scheduleChatFeedScrollToBottom');
    expect(() => fn()).not.toThrow();
  });

  it('scheduleChatFeedScrollToBottom follows layout growth while the feed settles', () => {
    const feed = {
      scrollHeight: 120,
      clientHeight: 80,
      scrollTop: 0,
      querySelector: vi.fn(() => ({})),
    };
    const frames = [];
    const updateChatFeedLoadMoreVisibility = vi.fn();
    const previousAlpine = globalThis.Alpine;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;

    globalThis.Alpine = {
      nextTick: (callback) => callback?.(),
    };
    globalThis.document = {
      querySelector: vi.fn(() => feed),
    };
    globalThis.window = {
      requestAnimationFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: vi.fn(),
    };

    try {
      const { fn } = bindMethod('scheduleChatFeedScrollToBottom', {
        updateChatFeedLoadMoreVisibility,
      });
      fn(2);

      expect(frames).toHaveLength(1);
      frames.shift()();
      expect(feed.scrollTop).toBe(120);

      feed.scrollHeight = 220;
      expect(frames).toHaveLength(1);
      frames.shift()();
      expect(feed.scrollTop).toBe(220);

      feed.scrollHeight = 260;
      expect(frames).toHaveLength(1);
      frames.shift()();
      expect(feed.scrollTop).toBe(260);
      expect(updateChatFeedLoadMoreVisibility).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.Alpine = previousAlpine;
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    }
  });

  it('stops delayed bottom-scroll retries after the user scrolls away', () => {
    const feed = {
      scrollHeight: 120,
      clientHeight: 80,
      scrollTop: 0,
      querySelector: vi.fn(() => ({})),
    };
    const frames = [];
    const previousAlpine = globalThis.Alpine;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;

    globalThis.Alpine = { nextTick: (callback) => callback?.() };
    globalThis.document = { querySelector: vi.fn(() => feed) };
    globalThis.window = {
      requestAnimationFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: vi.fn(),
    };

    try {
      const { fn } = bindMethod('scheduleChatFeedScrollToBottom');
      fn(2);
      frames.shift()();
      expect(feed.scrollTop).toBe(120);

      feed.scrollHeight = 300;
      feed.scrollTop = 20;
      frames.shift()();

      expect(feed.scrollTop).toBe(20);
      expect(frames).toHaveLength(0);
    } finally {
      globalThis.Alpine = previousAlpine;
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    }
  });

  it('scheduleThreadRepliesScrollToBottom does not throw in test env', () => {
    const { fn } = bindMethod('scheduleThreadRepliesScrollToBottom');
    expect(() => fn()).not.toThrow();
  });

  it('keeps initial latest intent armed until delayed thread content is rendered', () => {
    const replies = {
      scrollHeight: 120,
      clientHeight: 80,
      scrollTop: 0,
      querySelector: vi.fn(() => null),
    };
    const frames = [];
    const previousAlpine = globalThis.Alpine;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.Alpine = { nextTick: (callback) => callback?.() };
    globalThis.document = { querySelector: vi.fn(() => replies) };
    globalThis.window = {
      requestAnimationFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelAnimationFrame: vi.fn(),
    };

    try {
      const { fn, store } = bindMethod('scheduleThreadRepliesScrollToBottom', {
        pendingThreadScrollToLatest: true,
      });
      fn(2);
      frames.shift()();
      expect(store.pendingThreadScrollToLatest).toBe(true);

      replies.querySelector.mockReturnValue({});
      frames.shift()();
      expect(replies.scrollTop).toBe(120);
      expect(store.pendingThreadScrollToLatest).toBe(false);

      replies.scrollHeight = 260;
      frames.shift()();
      expect(replies.scrollTop).toBe(260);
    } finally {
      globalThis.Alpine = previousAlpine;
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    }
  });

  it('reveals the first matching agent activity once when the thread remains near the bottom', () => {
    const scheduleThreadRepliesScrollToBottom = vi.fn();
    const { fn, store } = bindMethod('applyAgentActivities', {
      activeThreadId: 'root-1',
      messages: [{ record_id: 'root-1', pg_thread_id: 'thread-1' }],
      pendingThreadActivityAutoScroll: { triggerMessageId: 'reply-1', threadId: 'thread-1' },
      isThreadRepliesNearBottom: vi.fn().mockReturnValue(true),
      scheduleThreadRepliesScrollToBottom,
    });
    const activity = {
      record_id: 'activity-1',
      trigger_message_id: 'reply-1',
      thread_id: 'thread-1',
      visibility: 'user_visible',
      state: 'thinking',
      sequence: 1,
      expires_at: '2999-01-01T00:00:00.000Z',
    };

    fn([activity]);
    fn([activity, { ...activity, record_id: 'activity-2', sequence: 2 }]);

    expect(scheduleThreadRepliesScrollToBottom).toHaveBeenCalledTimes(1);
    expect(store.pendingThreadActivityAutoScroll).toBeNull();
  });

  it('does not reveal agent activity after the user deliberately scrolls away', () => {
    const scheduleThreadRepliesScrollToBottom = vi.fn();
    const { fn, store } = bindMethod('applyAgentActivities', {
      activeThreadId: 'root-1',
      messages: [{ record_id: 'root-1', pg_thread_id: 'thread-1' }],
      pendingThreadActivityAutoScroll: { triggerMessageId: 'reply-1', threadId: 'thread-1' },
      isThreadRepliesNearBottom: vi.fn().mockReturnValue(false),
      scheduleThreadRepliesScrollToBottom,
    });

    fn([{
      record_id: 'activity-1',
      trigger_message_id: 'reply-1',
      thread_id: 'thread-1',
      visibility: 'user_visible',
      state: 'thinking',
      sequence: 1,
      expires_at: '2999-01-01T00:00:00.000Z',
    }]);

    expect(scheduleThreadRepliesScrollToBottom).not.toHaveBeenCalled();
    expect(store.pendingThreadActivityAutoScroll).toBeNull();
  });

  it('autosizeComposer does not throw with null', () => {
    const { fn } = bindMethod('autosizeComposer');
    expect(() => fn(null)).not.toThrow();
  });

  it('lets task descriptions grow and shrink with content instead of capping lines', () => {
    const { fn } = bindMethod('autosizeComposer');
    const composer = {
      dataset: { chatComposer: 'task-description' },
      scrollHeight: 2400,
      style: { height: '118px', overflowY: 'auto' },
    };
    vi.stubGlobal('window', {});
    try {
      fn(composer);
      expect(composer.style).toEqual({ height: 'auto', overflowY: 'visible' });
      composer.scrollHeight = 80;
      fn(composer, { resetManualSize: true });
      expect(composer.style).toEqual({ height: 'auto', overflowY: 'visible' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('autosizeComposer keeps empty composers at the one-line minimum', () => {
    const { fn } = bindMethod('autosizeComposer');
    const textarea = {
      scrollHeight: 42,
      style: {},
    };

    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        lineHeight: '20px',
        paddingTop: '8px',
        paddingBottom: '8px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
        minHeight: '38px',
      }),
    });

    try {
      fn(textarea);
      expect(textarea.style.height).toBe('42px');
      expect(textarea.style.overflowY).toBe('hidden');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('autosizeComposer caps composers at five visible lines and scrolls overflow', () => {
    const { fn } = bindMethod('autosizeComposer');
    const textarea = {
      scrollHeight: 220,
      style: {},
    };

    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        lineHeight: '20px',
        paddingTop: '8px',
        paddingBottom: '8px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
        minHeight: '38px',
      }),
    });

    try {
      fn(textarea);
      expect(textarea.style.height).toBe('118px');
      expect(textarea.style.overflowY).toBe('auto');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['message', 'thread', 'task-comment', 'doc-comment', 'doc-reply'])(
    'autosizeComposer preserves a manually enlarged %s composer after input',
    (composer) => {
      const { fn } = bindMethod('autosizeComposer');
      const element = {
        dataset: { chatComposer: composer },
        scrollHeight: 140,
        scrollTop: 52,
        style: { height: '240px' },
        getBoundingClientRect: () => ({ height: 240 }),
      };

      vi.stubGlobal('window', {
        getComputedStyle: () => ({
          height: '240px',
          lineHeight: '20px',
          paddingTop: '8px',
          paddingBottom: '8px',
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
          minHeight: '38px',
        }),
      });

      try {
        fn(element);
        expect(element.style.height).toBe('240px');
        expect(element.style.overflowY).toBe('hidden');
        expect(element.scrollTop).toBe(52);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(['message', 'thread'])(
    'autosizeComposer resets a manually enlarged %s composer after send',
    (composer) => {
      const { fn } = bindMethod('autosizeComposer');
      const element = {
        dataset: { chatComposer: composer },
        scrollHeight: 42,
        style: { height: '240px', overflowY: 'auto' },
      };

      vi.stubGlobal('window', {
        getComputedStyle: () => ({
          height: '42px',
          lineHeight: '20px',
          paddingTop: '8px',
          paddingBottom: '8px',
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
          minHeight: '38px',
        }),
      });

      try {
        fn(element, { resetManualSize: true });
        expect(element.style.height).toBe('42px');
        expect(element.style.overflowY).toBe('hidden');
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('autosizeComposer keeps a long comment reply scrolled to its caret line after another character', () => {
    const { fn } = bindMethod('autosizeComposer');
    let scrollTop = 76;
    const element = {
      dataset: { chatComposer: 'doc-reply' },
      scrollHeight: 260,
      style: { height: '118px' },
      getBoundingClientRect: () => ({ height: 118 }),
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value) {
        scrollTop = value;
      },
    };

    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        height: '118px',
        lineHeight: '20px',
        paddingTop: '8px',
        paddingBottom: '8px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
        minHeight: '38px',
      }),
    });

    try {
      fn(element);
      expect(element.style.height).toBe('118px');
      expect(element.style.overflowY).toBe('auto');
      expect(element.scrollTop).toBe(76);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scheduleComposerAutosize does not throw in test env', () => {
    const { fn } = bindMethod('scheduleComposerAutosize');
    expect(() => fn('message')).not.toThrow();
  });

  it('coalesces repeated element autosizes into the latest animation frame', () => {
    const { fn, store } = bindMethod('scheduleComposerElementAutosize');
    const callbacks = new Map();
    let nextFrame = 0;
    const requestSpy = vi.fn((callback) => {
      nextFrame += 1;
      callbacks.set(nextFrame, callback);
      return nextFrame;
    });
    const cancelSpy = vi.fn((id) => callbacks.delete(id));
    vi.stubGlobal('window', {
      requestAnimationFrame: requestSpy,
      cancelAnimationFrame: cancelSpy,
    });
    store.autosizeComposer = vi.fn();
    const element = {};

    try {
      fn(element);
      fn(element);

      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(cancelSpy).toHaveBeenCalledWith(1);
      expect(callbacks.has(1)).toBe(false);
      callbacks.get(2)();
      expect(store.autosizeComposer).toHaveBeenCalledTimes(1);
      expect(store.autosizeComposer).toHaveBeenCalledWith(element, { canShrink: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reuses composer style metrics and reads scroll height once on growing input', () => {
    const { fn } = bindMethod('autosizeComposer');
    let scrollHeightReads = 0;
    const element = {
      dataset: { chatComposer: 'thread' },
      style: { height: '42px', overflowY: 'hidden' },
      get scrollHeight() {
        scrollHeightReads += 1;
        return 42;
      },
    };
    const getComputedStyle = vi.fn(() => ({
      height: '42px',
      lineHeight: '20px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      minHeight: '38px',
    }));
    vi.stubGlobal('window', { innerWidth: 390, getComputedStyle });

    try {
      fn(element, { canShrink: false });
      fn(element, { canShrink: false });
      expect(getComputedStyle).toHaveBeenCalledTimes(1);
      expect(scrollHeightReads).toBe(2);
      expect(element.style.height).toBe('42px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scheduleChatPreviewMeasurement does not throw in test env', () => {
    const { fn } = bindMethod('scheduleChatPreviewMeasurement');
    expect(() => fn()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Message application
// ---------------------------------------------------------------------------
describe('applyMessages', () => {
  it('sets messages on store', async () => {
    const { fn, store } = bindMethod('applyMessages');
    const msgs = [
      { record_id: 'm1', sender_npub: 'npub1a', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
    ];
    await fn(msgs);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].record_id).toBe('m1');
    expect(store.pendingChatScrollToLatest).toBe(false);
  });

  it('does not run visible-message side effects for an unchanged logical result', async () => {
    const message = {
      record_id: 'm1', sender_npub: 'npub1a', parent_message_id: null,
      body: 'Draft remains stable', updated_at: '2024-01-01T00:00:00Z', version: 1,
    };
    const scheduleChatPreviewMeasurement = vi.fn();
    const scheduleStorageImageHydration = vi.fn();
    const refreshReactionsForVisibleTargets = vi.fn(async () => {});
    const { fn, store } = bindMethod('applyMessages', {
      messages: [message],
      messageInput: 'typing through refresh',
      scheduleChatPreviewMeasurement,
      scheduleStorageImageHydration,
      refreshReactionsForVisibleTargets,
    });

    await fn([{ ...message }]);

    expect(store.messages[0]).toBe(message);
    expect(store.messageInput).toBe('typing through refresh');
    expect(scheduleChatPreviewMeasurement).not.toHaveBeenCalled();
    expect(scheduleStorageImageHydration).not.toHaveBeenCalled();
    expect(refreshReactionsForVisibleTargets).not.toHaveBeenCalled();
  });

  it('patches a small stable-order live update without replacing the message collection', async () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      record_id: `message-${index}`,
      sender_npub: 'npub1a',
      parent_message_id: index === 0 ? null : 'message-0',
      body: `Message ${index}`,
      updated_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
      version: 1,
    }));
    const originalCollection = messages;
    const originalUnchangedMessage = messages[20];
    const { fn, store } = bindMethod('applyMessages', {
      messages,
      activeThreadId: 'message-0',
      messageCollectionRevision: 4,
    });
    const next = messages.map((message, index) => index === 10
      ? { ...message, body: 'Live update', updated_at: '2024-01-01T01:00:00Z', version: 2 }
      : message);

    await fn(next);

    expect(store.messages).toBe(originalCollection);
    expect(store.messages.find((message) => message.record_id === 'message-20')).toBe(originalUnchangedMessage);
    expect(store.messages.find((message) => message.record_id === 'message-10')?.body).toBe('Live update');
    expect(store.messageCollectionRevision).toBe(5);
  });

  it('replaces the message collection when live updates change its structure', async () => {
    const messages = [{ record_id: 'm1', updated_at: '2024-01-01T00:00:00Z', version: 1 }];
    const { fn, store } = bindMethod('applyMessages', { messages, messageCollectionRevision: 2 });

    await fn([
      messages[0],
      { record_id: 'm2', updated_at: '2024-01-01T00:01:00Z', version: 1 },
    ]);

    expect(store.messages).not.toBe(messages);
    expect(store.messages).toHaveLength(2);
    expect(store.messageCollectionRevision).toBe(3);
  });

  it('closes thread if thread messages disappear', async () => {
    const { fn, store } = bindMethod('applyMessages', {
      activeThreadId: 'm99',
    });
    await fn([{ record_id: 'm1', sender_npub: 'npub1a', parent_message_id: null, updated_at: '2024-01-01' }]);
    expect(store.activeThreadId).toBeNull();
  });

  it('keeps an active Deck thread when a delayed bounded window has no deletion evidence', async () => {
    const { fn, store } = bindMethod('applyMessages', {
      navSection: 'status',
      deckThreadChannelId: 'channel-1',
      activeThreadId: 'older-thread',
      selectedChannelId: 'unrelated-deck-selection',
      messages: [{
        record_id: 'older-thread',
        channel_id: 'channel-1',
        sender_npub: 'npub1a',
        record_state: 'active',
        updated_at: '2024-01-01',
      }],
    });

    await fn([{
      record_id: 'new-window-root',
      channel_id: 'unrelated-deck-selection',
      sender_npub: 'npub1b',
      updated_at: '2024-01-02',
    }]);

    expect(store.activeThreadId).toBe('older-thread');
  });

  it('keeps thread if thread messages exist', async () => {
    const { fn, store } = bindMethod('applyMessages', {
      activeThreadId: 'm1',
    });
    await fn([
      { record_id: 'm1', sender_npub: 'npub1a', parent_message_id: null, updated_at: '2024-01-01' },
      { record_id: 'm2', sender_npub: 'npub1b', parent_message_id: 'm1', updated_at: '2024-01-02' },
    ]);
    expect(store.activeThreadId).toBe('m1');
  });

  it('retains an active persisted thread when it falls outside the bounded message window', async () => {
    const workspaceDbKey = 'chat-message-manager-active-thread-window';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    const root = {
      record_id: 'thread-window-root', channel_id: 'channel-1', sender_npub: 'npub1a',
      parent_message_id: null, record_state: 'active', body: 'Older thread',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const reply = {
      record_id: 'thread-window-reply', channel_id: 'channel-1', sender_npub: 'npub1b',
      parent_message_id: root.record_id, record_state: 'active', body: 'Older reply',
      updated_at: '2024-01-01T00:01:00Z',
    };

    try {
      await upsertMessage(root);
      const { fn, store } = bindMethod('applyMessages', {
        selectedChannelId: 'channel-1',
        activeThreadId: root.record_id,
        messages: [root, reply],
      });

      await fn([{
        record_id: 'new-window-root', channel_id: 'channel-1', sender_npub: 'npub1c',
        parent_message_id: null, record_state: 'active', body: 'Newest message',
        updated_at: '2024-01-02T00:00:00Z',
      }]);

      expect(store.activeThreadId).toBe(root.record_id);
      expect(store.messages.map((message) => message.record_id)).toEqual(expect.arrayContaining([
        root.record_id,
        reply.record_id,
        'new-window-root',
      ]));
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('schedules a bottom scroll when pendingChatScrollToLatest is set', async () => {
    const scheduleChatFeedScrollToBottom = vi.fn();
    const { fn, store } = bindMethod('applyMessages', {
      pendingChatScrollToLatest: true,
      scheduleChatFeedScrollToBottom,
    });
    await fn([
      { record_id: 'm1', sender_npub: 'npub1a', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
    ]);
    expect(scheduleChatFeedScrollToBottom).toHaveBeenCalledTimes(1);
    expect(store.pendingChatScrollToLatest).toBe(true);
  });

  it('preserves deliberate non-bottom feed and thread positions during later updates', async () => {
    const chatAnchor = { containerSelector: '[data-chat-feed]', itemId: 'root-1', atBottom: false };
    const threadAnchor = { containerSelector: '[data-thread-replies]', itemId: 'reply-1', atBottom: false };
    const restoreScrollAnchor = vi.fn();
    const scheduleChatFeedScrollToBottom = vi.fn();
    const scheduleThreadRepliesScrollToBottom = vi.fn();
    const { fn } = bindMethod('applyMessages', {
      selectedChannelId: 'channel-1',
      activeThreadId: 'root-1',
      messages: [
        { record_id: 'root-1', channel_id: 'channel-1', sender_npub: 'npub1a', parent_message_id: null, body: 'Root', updated_at: '2024-01-01T00:00:00Z' },
        { record_id: 'reply-1', channel_id: 'channel-1', sender_npub: 'npub1b', parent_message_id: 'root-1', body: 'Older reply', updated_at: '2024-01-01T00:01:00Z' },
      ],
      captureScrollAnchor: vi.fn()
        .mockReturnValueOnce(chatAnchor)
        .mockReturnValueOnce(threadAnchor),
      restoreScrollAnchor,
      scheduleChatFeedScrollToBottom,
      scheduleThreadRepliesScrollToBottom,
    });

    await fn([
      { record_id: 'root-1', channel_id: 'channel-1', sender_npub: 'npub1a', parent_message_id: null, body: 'Root', updated_at: '2024-01-01T00:00:00Z' },
      { record_id: 'reply-1', channel_id: 'channel-1', sender_npub: 'npub1b', parent_message_id: 'root-1', body: 'Older reply', updated_at: '2024-01-01T00:01:00Z' },
      { record_id: 'reply-2', channel_id: 'channel-1', sender_npub: 'npub1c', parent_message_id: 'root-1', body: 'New live reply', updated_at: '2024-01-01T00:02:00Z' },
    ]);

    expect(scheduleChatFeedScrollToBottom).not.toHaveBeenCalled();
    expect(scheduleThreadRepliesScrollToBottom).not.toHaveBeenCalled();
    expect(restoreScrollAnchor).toHaveBeenCalledWith(chatAnchor);
    expect(restoreScrollAnchor).toHaveBeenCalledWith(threadAnchor);
  });

  it('exposes a load-more visibility hook whenever older messages are hidden', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      record_id: `m${index + 1}`,
      parent_message_id: null,
      updated_at: `2024-01-01T00:${String(index).padStart(2, '0')}:00Z`,
    }));
    const store = createStore({
      MAIN_FEED_PAGE_SIZE: 21,
      mainFeedVisibleCount: 21,
      messages,
      chatFeedNearTop: false,
    });
    expect(store.showMainFeedLoadMoreControl).toBe(true);
  });
});

describe('PG channel message refresh reconciliation', () => {
  it('keeps an active materialised message when a bounded interim page omits it', async () => {
    const workspaceDbKey = 'chat-message-manager-pg-bounded-refresh';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    const first = {
      record_id: 'message-1', channel_id: 'ch1', body: 'First message',
      record_state: 'active', sync_status: 'synced', pg_backend: true,
      updated_at: '2026-07-26T01:13:00.000Z',
    };
    const second = {
      record_id: 'message-2', channel_id: 'ch1', body: 'Second message',
      record_state: 'active', sync_status: 'synced', pg_backend: true,
      updated_at: '2026-07-26T01:14:00.000Z',
    };

    try {
      expect(await replacePgMessagesForChannel('ch1', [first, second])).toBe(2);
      expect(await replacePgMessagesForChannel('ch1', [first, second])).toBe(0);
      expect(await replacePgMessagesForChannel('ch1', [second])).toBe(0);
      expect((await getMessagesByChannel('ch1')).map((message) => message.record_id)).toEqual([
        'message-1',
        'message-2',
      ]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('writes and propagates an actual PG row edit after unchanged ticks', async () => {
    const workspaceDbKey = 'chat-message-manager-pg-changed-refresh';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    const message = {
      record_id: 'message-1', channel_id: 'ch1', body: 'Before', version: 1,
      record_state: 'active', sync_status: 'synced', pg_backend: true,
      updated_at: '2026-07-26T01:13:00.000Z',
    };

    try {
      expect(await replacePgMessagesForChannel('ch1', [message])).toBe(1);
      expect(await replacePgMessagesForChannel('ch1', [{ ...message }])).toBe(0);
      expect(await replacePgMessagesForChannel('ch1', [{
        ...message,
        body: 'After',
        version: 2,
        updated_at: '2026-07-26T01:15:00.000Z',
      }])).toBe(1);
      expect((await getMessagesByChannel('ch1'))[0]).toMatchObject({ body: 'After', version: 2 });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('still applies tombstones and supports an explicitly authoritative replacement', async () => {
    const workspaceDbKey = 'chat-message-manager-pg-authoritative-refresh';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    const first = {
      record_id: 'message-1', channel_id: 'ch1', body: 'First message',
      record_state: 'active', sync_status: 'synced', pg_backend: true,
      updated_at: '2026-07-26T01:13:00.000Z',
    };
    const second = {
      record_id: 'message-2', channel_id: 'ch1', body: 'Second message',
      record_state: 'active', sync_status: 'synced', pg_backend: true,
      updated_at: '2026-07-26T01:14:00.000Z',
    };

    try {
      await replacePgMessagesForChannel('ch1', [first, second]);
      await replacePgMessagesForChannel('ch1', [{
        ...first,
        record_state: 'deleted',
        deleted_at: '2026-07-26T01:15:00.000Z',
      }]);
      expect((await getMessagesByChannel('ch1')).map((message) => message.record_id)).toEqual(['message-2']);

      await replacePgMessagesForChannel('ch1', [], { authoritative: true });
      expect(await getMessagesByChannel('ch1')).toEqual([]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });
});

// ---------------------------------------------------------------------------
// patchMessageLocal
// ---------------------------------------------------------------------------
describe('patchMessageLocal', () => {
  it('updates existing message in place', () => {
    const { fn, store } = bindMethod('patchMessageLocal', {
      messages: [
        { record_id: 'm1', body: 'old', updated_at: '2024-01-01' },
      ],
    });
    fn({ record_id: 'm1', body: 'new' });
    expect(store.messages[0].body).toBe('new');
    expect(store.messages[0].updated_at).toBe('2024-01-01');
  });

  it('adds new message when not found', () => {
    const { fn, store } = bindMethod('patchMessageLocal', {
      messages: [
        { record_id: 'm1', body: 'old', updated_at: '2024-01-01' },
      ],
    });
    fn({ record_id: 'm2', body: 'new', updated_at: '2024-01-02' });
    expect(store.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// refreshMessages
// ---------------------------------------------------------------------------
describe('refreshMessages', () => {
  it('clears messages when no channel selected', async () => {
    const { fn, store } = bindMethod('refreshMessages', {
      selectedChannelId: null,
      messages: [{ record_id: 'm1' }],
    });
    await fn();
    expect(store.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createBotDm validation
// ---------------------------------------------------------------------------
describe('createBotDm', () => {
  it('sets error when not signed in', async () => {
    const { fn, store } = bindMethod('createBotDm', {
      session: null,
      botNpub: 'npub1bot',
    });
    await fn();
    expect(store.error).toBe('Sign in and set bot npub first');
  });

  it('sets error when no backend', async () => {
    const { fn, store } = bindMethod('createBotDm', {
      session: { npub: 'npub1me' },
      botNpub: 'npub1bot',
      backendUrl: '',
    });
    await fn();
    expect(store.error).toBe('Set backend URL first');
  });

  it('opens bot DMs through the Tower PG channel helper in PG mode', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const ensureTowerPgDmChannel = vi.fn().mockResolvedValue({ record_id: 'pg-dm-1' });
    const scheduleChannelsRefresh = vi.fn();
    const { fn, store } = bindMethod('createBotDm', {
      session: { npub: 'npub1me' },
      ownerNpub: 'npub1owner',
      currentWorkspaceOwnerNpub: 'npub1owner',
      botNpub: 'npub1bot',
      backendUrl: 'https://tower.example',
      channels: [{ record_id: 'old-channel' }],
      ensureTowerPgDmChannel,
      scheduleChannelsRefresh,
    });

    await fn();

    expect(store.error).toBeNull();
    expect(ensureTowerPgDmChannel).toHaveBeenCalledWith('npub1bot');
    expect(store.refreshChannels).not.toHaveBeenCalled();
    expect(store.channels.map((channel) => channel.record_id)).toEqual(['old-channel', 'pg-dm-1']);
    expect(scheduleChannelsRefresh).toHaveBeenCalledWith('PG bot DM open');
    expect(store.selectChannel).toHaveBeenCalledWith('pg-dm-1', { syncRoute: false });
    expect(store.createEncryptedGroup).not.toHaveBeenCalled();
  });
});

describe('response activity rendering', () => {
  it('matches channel response activities by the rendered message PG thread id', () => {
    const store = createStore({
      messages: [{ record_id: 'root-message-1', pg_thread_id: 'pg-thread-1' }],
      channelResponseActivities: [{
        record_id: 'activity-1',
        target_type: 'chat_thread',
        target_id: 'pg-thread-1',
        status: 'thinking',
        expires_at: '2999-01-01T00:00:00.000Z',
      }],
    });

    expect(store.getResponseActivitiesForThread(store.messages[0])).toEqual([
      expect.objectContaining({ record_id: 'activity-1' }),
    ]);
  });

  it('hides cleared and expired response activities', () => {
    const store = createStore({
      messages: [{ record_id: 'root-message-1', pg_thread_id: 'pg-thread-1' }],
      channelResponseActivities: [
        {
          record_id: 'activity-active',
          target_type: 'chat_thread',
          target_id: 'pg-thread-1',
          status: 'implementing',
          expires_at: '2999-01-01T00:00:00.000Z',
        },
        {
          record_id: 'activity-cleared',
          target_type: 'chat_thread',
          target_id: 'pg-thread-1',
          status: 'thinking',
          record_state: 'cleared',
          expires_at: '2999-01-01T00:00:00.000Z',
        },
        {
          record_id: 'activity-expired',
          target_type: 'chat_thread',
          target_id: 'pg-thread-1',
          status: 'writing',
          expires_at: '2000-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(store.getResponseActivitiesForThread(store.messages[0]).map((activity) => activity.record_id)).toEqual(['activity-active']);
  });

  it('animates response activity titles from status words and local suffixes', () => {
    const store = createStore({
      responseActivityTick: 1,
      getSenderName: vi.fn(() => 'Autopilot'),
    });

    expect(store.formatResponseActivityTitle({
      record_id: 'activity-1',
      status: 'thinking',
      actor_npub: 'npub1agent',
    })).toBe('Autopilot is Thinking.+');
  });
});

describe('agent activity rendering', () => {
  it('correlates activity to its trigger message while normal replies remain visible', () => {
    const store = createStore({
      messages: [
        { record_id: 'message-human', parent_message_id: null },
        { record_id: 'message-final', parent_message_id: 'message-human', body: 'Final response' },
      ],
      agentActivities: [{
        record_id: 'row-1', activity_id: 'activity-1', trigger_message_id: 'message-human',
        visibility: 'user_visible', state: 'working', sequence: 2,
        expires_at: '2999-01-01T00:00:00.000Z',
      }],
    });

    expect(store.getAgentActivitiesForMessage(store.messages[0])).toHaveLength(1);
    expect(store.getAgentActivitiesForMessage(store.messages[1])).toHaveLength(0);
    expect(store.messages.find((message) => message.record_id === 'message-final')?.body).toBe('Final response');
  });

  it('expands safe activity details without changing the snapshot', () => {
    const store = createStore({ expandedAgentActivityIds: {} });
    store.toggleAgentActivity('activity-1');
    expect(store.isAgentActivityExpanded('activity-1')).toBe(true);
  });

  it('orders and turn-isolates durable commentary history behind a second expansion', () => {
    const activity = {
      activity_id: 'activity-1', turn_id: 'turn-1',
      commentary_history: [
        { history_key: 'third', activity_id: 'activity-1', turn_id: 'turn-1', sequence: 3, body: 'Third' },
        { history_key: 'wrong-turn', activity_id: 'activity-1', turn_id: 'turn-old', sequence: 1, body: 'Old' },
        { history_key: 'first', activity_id: 'activity-1', turn_id: 'turn-1', sequence: 1, body: 'First' },
      ],
    };
    const store = createStore({ expandedAgentActivityHistoryIds: {} });
    expect(store.getAgentActivityCommentaryHistory(activity).map((item) => item.body)).toEqual(['First', 'Third']);
    expect(store.hasAgentActivityCommentaryHistory(activity)).toBe(true);
    store.toggleAgentActivityHistory(activity);
    expect(store.isAgentActivityHistoryExpanded(activity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendMessage validation
// ---------------------------------------------------------------------------
describe('sendMessage', () => {
  it('keeps an optimistic PG channel message through stale snapshots and reconciles it without a duplicate', async () => {
    const workspaceDbKey = 'chat-message-manager-send-message-pg-reconciliation';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveCreate;
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      resolveCreate = () => resolve({
        ...localRow,
        record_id: 'pg-message-1',
        sync_status: 'synced',
        pg_record_type: 'message',
        pg_thread_id: 'pg-thread-1',
      });
    }));

    try {
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
        selectedChannelId: 'ch1',
        pgContextSelectedChannelId: 'ch1',
        channels: [
          { record_id: 'ch1', scope_id: 'scope-1', owner_npub: 'npub1owner', group_ids: [] },
          { record_id: 'ch2', scope_id: 'scope-1', owner_npub: 'npub1owner', group_ids: [] },
          { record_id: 'ch3', scope_id: 'scope-2', owner_npub: 'npub1owner', group_ids: [] },
        ],
        messageInput: 'visible throughout',
      });

      const send = fn();
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      const clientRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect((await getMessagesByChannel('ch1')).map((message) => message.record_id)).toEqual([clientRecordId]);
      expect(await getMessageById(clientRecordId)).toMatchObject({
        channel_id: 'ch1',
        pg_workspace_id: 'workspace-1',
        pg_scope_id: 'scope-1',
        pg_thread_id: null,
      });

      store.selectedChannelId = 'ch2';
      await store.refreshMessages();
      expect(store.messages).toEqual([]);

      store.selectedChannelId = 'ch3';
      await store.refreshMessages();
      expect(store.messages).toEqual([]);

      store.selectedChannelId = null;
      store.pgContextScopeId = 'scope-1';
      store.pgContextChannels = store.channels.filter((channel) => channel.scope_id === 'scope-1');
      await store.refreshMessages();
      expect(store.messages.map((message) => message.record_id)).toEqual([clientRecordId]);

      store.pgContextScopeId = 'scope-2';
      store.pgContextChannels = store.channels.filter((channel) => channel.scope_id === 'scope-2');
      await store.refreshMessages();
      expect(store.messages).toEqual([]);

      store.selectedChannelId = 'ch1';
      await store.refreshMessages();
      expect(store.messages.map((message) => message.record_id)).toEqual([clientRecordId]);

      await replacePgMessagesForChannel('ch1', []);
      await store.refreshMessages();
      expect(store.messages.map((message) => message.record_id)).toEqual([clientRecordId]);

      resolveCreate();
      await send;
      await replacePgMessagesForChannel('ch1', []);
      await store.refreshMessages();
      expect(store.messages.map((message) => message.record_id)).toEqual(['pg-message-1']);

      const { pg_reconciliation_pending, ...authoritativeMessage } = store.messages[0];
      await replacePgMessagesForChannel('ch1', [{
        ...authoritativeMessage,
        pg_client_record_id: clientRecordId,
      }]);
      await store.refreshMessages();
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]).toMatchObject({
        record_id: 'pg-message-1',
        pg_client_record_id: clientRecordId,
      });
      expect((await getMessageById('pg-message-1')).pg_reconciliation_pending).toBeUndefined();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('marks a rejected optimistic PG channel message as failed', async () => {
    const workspaceDbKey = 'chat-message-manager-send-message-pg-rejected';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockRejectedValue(new Error('Tower rejected message'));
    const markTowerReachabilityOperationFailed = vi.fn();

    try {
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        selectedChannelId: 'ch1',
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messageInput: 'will fail',
        markTowerReachabilityOperationFailed,
      });

      expect(await fn()).toBe(false);
      expect(store.error).toBe('Tower rejected message');
      expect(markTowerReachabilityOperationFailed).toHaveBeenCalledWith('chat-message-send-failed');
      expect(await getMessagesByChannel('ch1')).toEqual([
        expect.objectContaining({ body: 'will fail', sync_status: 'failed' }),
      ]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('blocks a retired selected mention when the current PG actor roster is loaded', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const retired = 'npub1retired';
    const current = 'npub1current';
    const token = `@[Example Agent](mention:agent:${retired})`;
    const { fn, store } = bindMethod('sendMessage', {
      session: { npub: 'npub1viewer' },
      workspaceOwnerNpub: 'npub1owner',
      currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
      pgWorkspaceMembers: [
        { actor_id: 'actor-viewer', npub: 'npub1viewer' },
        { actor_id: 'actor-example-agent', npub: current },
      ],
      selectedChannelId: 'ch1',
      pgContextSelectedChannelId: 'ch1',
      channels: [{ record_id: 'ch1', scope_id: 'scope-1', owner_npub: 'npub1owner', group_ids: [] }],
      messageInput: token,
      selectedAgentMentionsByComposer: {
        message: [{ type: 'agent', npub: retired, label: 'Example Agent' }],
        thread: [],
      },
    });

    expect(await fn()).toBe(false);
    expect(store.error).toContain('no longer a current workspace member');
    expect(createTowerPgMessageFromLocal).not.toHaveBeenCalled();
  });

  it('does nothing with empty input and no drafts', async () => {
    const { fn, store } = bindMethod('sendMessage', {
      messageInput: '',
      messageAudioDrafts: [],
      selectedChannelId: 'ch1',
      channels: [{ record_id: 'ch1' }],
    });
    await fn();
    expect(store.error).toBeNull();
    expect(store.performSync).not.toHaveBeenCalled();
  });

  it('sets error when no channel selected', async () => {
    const { fn, store } = bindMethod('sendMessage', {
      messageInput: 'hello',
      messageAudioDrafts: [],
      selectedChannelId: null,
    });
    await fn();
    expect(store.error).toBe('Select a channel first');
  });

  it('blocks sending from PG scope Home instead of resolving a stale write context', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const openWriteContextModal = vi.fn().mockReturnValue(null);
    const { fn, store } = bindMethod('sendMessage', {
      messageInput: 'hello',
      messageAudioDrafts: [],
      selectedChannelId: null,
      openWriteContextModal,
    });

    await fn();

    expect(store.error).toContain('read-only rollup');
    expect(openWriteContextModal).not.toHaveBeenCalled();
    expect(store.messageInput).toBe('hello');
  });

  it('sets error when image upload in progress', async () => {
    const { fn, store } = bindMethod('sendMessage', {
      messageInput: 'hello',
      messageImageUploadCount: 1,
    });
    await fn();
    expect(store.error).toBe('Wait for image upload to finish.');
  });

  it('schedules a chat-feed scroll after inserting the local pending row', async () => {
    const workspaceDbKey = 'chat-message-manager-send-message';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();

    try {
      const scheduleChatFeedScrollToBottom = vi.fn();
      const patchMessageLocal = vi.fn();
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messageInput: 'hello world',
        scheduleChatFeedScrollToBottom,
        patchMessageLocal,
        flushAndBackgroundSync: vi.fn().mockResolvedValue(undefined),
        getPreferredChannelWriteGroup: vi.fn().mockReturnValue(null),
      });

      await fn();

      expect(scheduleChatFeedScrollToBottom).toHaveBeenCalledTimes(1);
      expect(patchMessageLocal).toHaveBeenCalledTimes(1);
      expect(patchMessageLocal.mock.calls[0][0]).toEqual(expect.objectContaining({
        channel_id: 'ch1',
        body: 'hello world',
        sender_npub: 'npub1viewer',
        sync_status: 'pending',
      }));
      expect(store.messageInput).toBe('');
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('replaces the optimistic local row with the accepted PG message', async () => {
    const workspaceDbKey = 'chat-message-manager-send-message-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      record_id: 'pg-message-1',
      channel_id: localRow.channel_id,
      parent_message_id: null,
      body: localRow.body,
      attachments: [],
      sender_npub: localRow.sender_npub,
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      updated_at: '2026-06-06T01:00:00.000Z',
      pg_backend: true,
      pg_record_type: 'message',
      pg_thread_id: 'pg-thread-1',
    }));

    try {
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messageInput: 'hello pg @[Test Agent](mention:agent:npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266)',
        selectedAgentMentionsByComposer: {
          message: [{ type: 'agent', npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266', label: 'Test Agent' }],
          thread: [],
        },
        getPreferredChannelWriteGroup: vi.fn().mockReturnValue(null),
      });

      await fn();

      const localRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect(createTowerPgMessageFromLocal.mock.calls[0][1].pg_metadata).toEqual({
        mentions: [{
          type: 'agent',
          npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266',
          label: 'Test Agent',
        }],
      });
      expect(await getMessageById(localRecordId)).toBeUndefined();
      expect(await getMessageById('pg-message-1')).toMatchObject({
        record_id: 'pg-message-1',
        body: 'hello pg @[Test Agent](mention:agent:npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266)',
        sync_status: 'synced',
        pg_backend: true,
      });
      expect(store.messages.map((message) => message.record_id)).toEqual(['pg-message-1']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('sends a selected or pasted PG channel image as a canonical Tower attachment', async () => {
    const workspaceDbKey = 'chat-message-manager-send-pg-image-attachment';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-image-message',
      sync_status: 'synced',
      version: 1,
      pg_backend: true,
      pg_thread_id: 'pg-image-thread',
    }));

    try {
      const attachment = {
        kind: 'image',
        storage_object_id: 'storage-image-1',
        filename: 'screenshot.png',
        content_type: 'image/png',
        size_bytes: 2048,
      };
      const { fn } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messageInput: '',
        messageFileDrafts: [{
          draft_id: 'draft-image-1',
          status: 'ready',
          preview_url: 'blob:preview',
          file: { name: 'screenshot.png' },
          error: '',
          ...attachment,
        }],
        clearChatFileDrafts: vi.fn(),
      });

      expect(await fn()).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          channel_id: 'channel-1',
          pg_scope_id: 'scope-1',
          attachments: [attachment],
        }),
      );
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('creates a titled thread and first message once from the shared thread attachment composer', async () => {
    const workspaceDbKey = 'chat-message-manager-create-thread-shared-composer';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-root-message',
      sync_status: 'synced',
      version: 1,
      pg_backend: true,
      pg_thread_id: 'pg-thread-1',
      title: localRow.pg_thread_title,
    }));

    try {
      const attachment = {
        kind: 'file',
        storage_object_id: 'storage-file-1',
        filename: 'brief.pdf',
        content_type: 'application/pdf',
        size_bytes: 4096,
      };
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'channel-1',
        pgContextSelectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messageInput: 'unrelated channel draft',
        threadInput: 'First message from the shared composer',
        threadFileDrafts: [{
          draft_id: 'draft-file-1',
          status: 'ready',
          file: { name: 'brief.pdf' },
          error: '',
          ...attachment,
        }],
        clearChatFileDrafts: vi.fn(function clearChatFileDrafts(context) {
          if (context === 'thread') this.threadFileDrafts = [];
        }),
      });

      const created = await fn({
        composerContext: 'thread-create',
        threadTitle: 'First message from the shared composer',
        returnMessage: true,
      });

      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(store, expect.objectContaining({
        body: 'First message from the shared composer',
        attachments: [attachment],
        pg_thread_title: 'First message from the shared composer',
        pg_client_request_id: expect.any(String),
      }));
      expect(created).toMatchObject({ record_id: 'pg-root-message', pg_thread_id: 'pg-thread-1' });
      expect(store.messageInput).toBe('unrelated channel draft');
      expect(store.threadInput).toBe('');
      expect((await getMessagesByChannel('channel-1')).map((message) => message.record_id)).toEqual(['pg-root-message']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('retains the create-mode draft and removes its optimistic root when Tower rejects creation', async () => {
    const workspaceDbKey = 'chat-message-manager-create-thread-rejected';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockRejectedValue(new Error('Tower rejected thread'));

    try {
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
        selectedChannelId: 'channel-1',
        pgContextSelectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        threadInput: 'Please keep this draft',
        threadFileDrafts: [],
      });

      await expect(fn({ composerContext: 'thread-create', threadTitle: 'Please keep this draft', returnMessage: true })).resolves.toBe(false);

      expect(store.threadInput).toBe('Please keep this draft');
      expect(store.error).toBe('Tower rejected thread');
      expect(await getMessagesByChannel('channel-1')).toEqual([]);
      expect(store.messages).toEqual([]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('submits a newly uploaded storage file link with non-empty PG attachment metadata', async () => {
    const workspaceDbKey = 'chat-message-manager-send-pg-storage-link-attachment';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-storage-link-message',
      sync_status: 'synced',
      version: 1,
      pg_backend: true,
      pg_thread_id: 'pg-storage-link-thread',
    }));

    try {
      const body = '[Good_Stuff_65-final.txt](storage://6502a11c-575d-4dc7-9581-29a5011661c3)';
      const { fn } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messageInput: body,
      });

      expect(await fn()).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body,
          attachments: [{
            kind: 'file',
            storage_object_id: '6502a11c-575d-4dc7-9581-29a5011661c3',
            filename: 'Good_Stuff_65-final.txt',
          }],
        }),
      );
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('attaches PG audio drafts after the accepted message id is known', async () => {
    const workspaceDbKey = 'chat-message-manager-send-message-pg-audio';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      record_id: 'pg-message-1',
      channel_id: localRow.channel_id,
      parent_message_id: null,
      body: localRow.body,
      attachments: [],
      sender_npub: localRow.sender_npub,
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      updated_at: '2026-06-06T01:00:00.000Z',
      pg_backend: true,
      pg_record_type: 'message',
      pg_scope_id: 'scope-1',
      pg_thread_id: 'pg-thread-1',
    }));

    try {
      const materializeAudioDrafts = vi.fn().mockResolvedValue({
        attachments: [{
          kind: 'audio',
          audio_note_record_id: 'audio-pg-1',
          title: 'Voice note',
          duration_seconds: 12,
        }],
      });
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messageInput: 'hello pg audio',
        messageAudioDrafts: [{ draft_id: 'draft-1', title: 'Voice note', storage_object_id: 'storage-1' }],
        materializeAudioDrafts,
      });

      await fn();

      const localRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect(materializeAudioDrafts).toHaveBeenCalledWith(expect.objectContaining({
        drafts: [{ draft_id: 'draft-1', title: 'Voice note', storage_object_id: 'storage-1' }],
        target_record_id: 'pg-message-1',
        target_record_family_hash: 'mock:chat_message',
        scopeId: 'scope-1',
        channelId: 'ch1',
        threadId: 'pg-thread-1',
      }));
      expect(materializeAudioDrafts.mock.calls[0][0].target_record_id).not.toBe(localRecordId);
      expect(await getMessageById('pg-message-1')).toMatchObject({
        record_id: 'pg-message-1',
        attachments: [{
          kind: 'audio',
          audio_note_record_id: 'audio-pg-1',
          title: 'Voice note',
          duration_seconds: 12,
        }],
      });
      expect(store.messages[0]).toMatchObject({
        record_id: 'pg-message-1',
        attachments: [expect.objectContaining({ audio_note_record_id: 'audio-pg-1' })],
      });
      expect(store.error).toBeNull();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('treats Enter plus a click while the message composer is pending as one send', async () => {
    const workspaceDbKey = 'chat-message-manager-message-enter-click-guard';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveCreate;
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      resolveCreate = () => resolve({
        ...localRow,
        record_id: 'pg-message-once',
        sync_status: 'synced',
        pg_backend: true,
        pg_thread_id: 'pg-thread-once',
      });
    }));

    try {
      const { fn, store } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messageInput: 'send this once',
      });

      const enterSend = fn();
      expect(store.composerSendPending.message).toBe(true);
      await expect(fn()).resolves.toBe(false);
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      resolveCreate();
      await expect(enterSend).resolves.toBe(true);

      expect((await getMessagesByChannel('channel-1')).map((message) => message.record_id)).toEqual(['pg-message-once']);
      expect(store.composerSendPending.message).toBe(false);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('sends an agent DM with valid access without repairing the grant', async () => {
    const workspaceDbKey = 'chat-message-manager-send-agent-dm-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const ensureTowerPgDmChannel = vi.fn().mockResolvedValue({ record_id: 'dm-agent' });
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-agent-dm-message',
      sync_status: 'synced',
      pg_backend: true,
    }));

    try {
      const { fn } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'dm-agent',
        channels: [{
          record_id: 'dm-agent',
          owner_npub: 'npub1owner',
          channel_type: 'dm',
          participant_npubs: ['npub1viewer', 'npub1bot'],
        }],
        messageInput: 'hello bot',
        ensureTowerPgDmChannel,
      });

      await fn();

      expect(ensureTowerPgDmChannel).not.toHaveBeenCalled();
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('repairs stale agent DM access and retries once with the same client request id', async () => {
    const workspaceDbKey = 'chat-message-manager-send-agent-dm-title-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const ensureTowerPgDmChannel = vi.fn().mockResolvedValue({ record_id: 'dm-agent' });
    const permissionError = Object.assign(new Error('DM grant is stale'), {
      status: 403,
      code: 'permission_denied',
      requiredPermission: 'channel.write',
    });
    createTowerPgMessageFromLocal
      .mockRejectedValueOnce(permissionError)
      .mockImplementationOnce(async (_store, localRow) => ({
        ...localRow,
        record_id: 'pg-agent-dm-title-message',
        sync_status: 'synced',
        pg_backend: true,
      }));

    try {
      const { fn } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'dm-agent',
        channels: [{
          record_id: 'dm-agent',
          owner_npub: 'npub1owner',
          title: 'DM: npub1bot',
          channel_type: 'dm',
        }],
        messageInput: 'hello bot',
        ensureTowerPgDmChannel,
      });

      await fn();

      expect(ensureTowerPgDmChannel).toHaveBeenCalledWith('npub1bot');
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(2);
      const firstAttempt = createTowerPgMessageFromLocal.mock.calls[0][1];
      const retry = createTowerPgMessageFromLocal.mock.calls[1][1];
      expect(firstAttempt.pg_client_request_id).toBe(firstAttempt.record_id);
      expect(retry.pg_client_request_id).toBe(firstAttempt.pg_client_request_id);
      expect(retry.record_id).toBe(firstAttempt.record_id);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('does not repair a title-derived agent DM on the successful path', async () => {
    const workspaceDbKey = 'chat-message-manager-send-agent-dm-title-derived-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const ensureTowerPgDmChannel = vi.fn().mockResolvedValue({ record_id: 'dm-agent' });
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-agent-dm-title-derived-message',
      sync_status: 'synced',
      pg_backend: true,
    }));

    try {
      const { fn } = bindMethod('sendMessage', {
        session: { npub: 'npub1viewer' },
        botNpub: '',
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'dm-agent',
        channels: [{
          record_id: 'dm-agent',
          owner_npub: 'npub1owner',
          title: 'DM: npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266',
          channel_type: 'channel',
        }],
        messageInput: 'hello bot',
        ensureTowerPgDmChannel,
      });

      await fn();

      expect(ensureTowerPgDmChannel).not.toHaveBeenCalled();
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });
});

// ---------------------------------------------------------------------------
// sendThreadReply validation
// ---------------------------------------------------------------------------
describe('sendThreadReply', () => {
  it.each([false, true])('keeps an open Inbox reply through canonical acknowledgement (echo first: %s)', async (echoFirst) => {
    const key = `open-inbox-send-${echoFirst}`;
    openWorkspaceDb(key);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const root = { record_id: 'thread', pg_record_type: 'thread', pg_thread_id: 'thread',
      pg_source_message_id: 'source', channel_id: 'inbox-channel', body: 'Thread',
      record_state: 'active', sync_status: 'synced', version: 1, updated_at: '2026-01-01T00:00:00Z' };
    const source = { ...root, record_id: 'source', pg_record_type: 'message' };
    await upsertMessage(root);
    await upsertMessage(source);
    const store = createStore({ navSection: 'status', selectedChannelId: 'other-channel',
      deckThreadChannelId: 'inbox-channel', deckThreadTowerId: 'thread', activeThreadId: 'thread',
      currentWorkspace: { workspaceId: 'workspace' }, session: { npub: 'viewer' },
      channels: [{ record_id: 'inbox-channel' }], messages: [root, { ...source, parent_message_id: 'thread' }],
      threadInput: 'New reply',
    });
    let accept;
    createTowerPgMessageFromLocal.mockImplementation((_store, local) => new Promise(resolve => {
      accept = async () => {
        const canonical = { ...local, record_id: 'accepted', parent_message_id: 'source',
          pg_record_type: 'message', sync_status: 'synced', pg_client_record_id: local.record_id };
        if (echoFirst) {
          await replacePgMessagesForChannel('inbox-channel', [canonical]);
          await store.applyMessages(await getThreadMessagePresentationWindow('inbox-channel', 'thread'), { threadDetail: true });
        }
        resolve(canonical);
      };
    }));
    try {
      const send = store.sendThreadReply();
      await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
      expect(store.visibleThreadMessages.filter(row => row.body === 'New reply')).toHaveLength(1);
      // A query begun before the local insert finishes after the pending patch.
      await store.applyMessages([root, { ...source, parent_message_id: 'thread' }], { threadDetail: true });
      expect(store.visibleThreadMessages.filter(row => row.body === 'New reply')).toHaveLength(1);
      await accept();
      expect(await send).toBe(true);
      expect(store.visibleThreadMessages.filter(row => row.body === 'New reply')).toHaveLength(1);
      await store.applyMessages(await getThreadMessagePresentationWindow('inbox-channel', 'thread'), { threadDetail: true });
      expect(store.visibleThreadMessages.filter(row => row.record_id === 'accepted')).toHaveLength(1);
      const canonical = await getMessageById('accepted');
      const { pg_reconciliation_pending, ...echo } = canonical;
      await replacePgMessagesForChannel('inbox-channel', [echo]);
      await store.applyMessages(await getThreadMessagePresentationWindow('inbox-channel', 'thread'), { threadDetail: true });
      expect(store.visibleThreadMessages.filter(row => row.body === 'New reply')).toHaveLength(1);
    } finally { await deleteWorkspaceDb(key); }
  });

  it('does not patch a different Inbox thread or clear its draft when a send completes', async () => {
    const key = 'inbox-send-navigation';
    openWorkspaceDb(key); await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const root = { record_id: 'root', channel_id: 'ch1', pg_thread_id: 'thread', body: 'Root' };
    await upsertMessage(root);
    const store = createStore({ navSection: 'status', deckThreadChannelId: 'ch1', deckThreadTowerId: 'thread',
      activeThreadId: 'root', messages: [root], channels: [{ record_id: 'ch1' }], threadInput: 'Reply',
      currentWorkspace: { workspaceId: 'workspace' }, session: { npub: 'viewer' },
      scheduleThreadRepliesScrollToBottom: vi.fn(),
    });
    let accept;
    createTowerPgMessageFromLocal.mockImplementation((_store, local) => new Promise(resolve => {
      accept = () => resolve({ ...local, record_id: 'accepted', sync_status: 'synced' });
    }));
    try {
      const send = store.sendThreadReply();
      await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
      store.activeThreadId = 'other-root'; store.deckThreadTowerId = 'other-thread';
      store.messages = [{ ...root, record_id: 'other-root', pg_thread_id: 'other-thread' }];
      store.threadInput = 'Other draft';
      store.scheduleThreadRepliesScrollToBottom.mockClear();
      accept(); await send;
      expect(store.messages.map(row => row.record_id)).toEqual(['other-root']);
      expect(store.visibleThreadMessages).toEqual([]);
      expect(store.threadInput).toBe('Other draft');
      expect(store.scheduleThreadRepliesScrollToBottom).not.toHaveBeenCalled();
      expect(await getMessageById('accepted')).toMatchObject({ parent_message_id: 'root', body: 'Reply' });
    } finally { await deleteWorkspaceDb(key); }
  });

  it.each(['accept', 'reject'])('keeps a late %s in the originating Dexie workspace after switching', async (outcome) => {
    const originalKey = `reply-original-${outcome}`, nextKey = `reply-next-${outcome}`;
    openWorkspaceDb(originalKey); await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const root = { record_id: 'root', channel_id: 'ch1', pg_thread_id: 'thread', body: 'Root' };
    await upsertMessage(root);
    const store = createStore({ currentWorkspaceKey: originalKey, currentWorkspace: { workspaceId: 'workspace-a' },
      activeThreadId: 'root', selectedChannelId: 'ch1', messages: [root], channels: [{ record_id: 'ch1' }],
      threadInput: 'Original reply', session: { npub: 'viewer' },
    });
    let settle, localId;
    createTowerPgMessageFromLocal.mockImplementation((_store, local) => new Promise((resolve, reject) => {
      localId = local.record_id;
      settle = () => outcome === 'accept'
        ? resolve({ ...local, record_id: 'accepted', sync_status: 'synced', pg_record_type: 'message' })
        : reject(new Error('Original send failed'));
    }));
    try {
      const send = store.sendThreadReply();
      await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
      openWorkspaceDb(nextKey); await clearRuntimeData();
      store.currentWorkspaceKey = nextKey; store.currentWorkspace = { workspaceId: 'workspace-b' };
      store.messages = []; store.threadInput = 'New workspace draft';
      // Same record IDs must not let a failed old send mutate another workspace.
      await upsertMessage({ record_id: localId, body: 'Unrelated local row', sync_status: 'pending' });
      settle(); expect(await send).toBe(outcome === 'accept');
      expect(await getMessageById('accepted')).toBeUndefined();
      expect(await getMessageById(localId)).toMatchObject({ body: 'Unrelated local row', sync_status: 'pending' });
      expect(store.messages).toEqual([]); expect(store.threadInput).toBe('New workspace draft');
      openWorkspaceDb(originalKey);
      if (outcome === 'accept') {
        expect(await getMessageById(localId)).toBeUndefined();
        expect(await getMessageById('accepted')).toMatchObject({ pg_workspace_id: 'workspace-a', body: 'Original reply', sync_status: 'synced' });
      } else expect(await getMessageById(localId)).toMatchObject({ body: 'Original reply', sync_status: 'failed' });
    } finally { await deleteWorkspaceDb(originalKey); await deleteWorkspaceDb(nextKey); }
  });

  it('rejects a delayed local refresh after a newer accepted projection', async () => {
    const root = { record_id: 'root', channel_id: 'ch1', body: 'Root' };
    const store = createStore({ selectedChannelId: 'ch1', activeThreadId: 'root', messages: [root] });
    let finish;
    const read = vi.spyOn(messageDb, 'getMessagesByChannel').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const refresh = store.refreshMessages();
      store.patchMessageLocal({ record_id: 'accepted', channel_id: 'ch1', parent_message_id: 'root', body: 'Accepted', sync_status: 'synced' });
      finish([root]); await refresh;
      expect(store.visibleThreadMessages.map(row => row.record_id)).toEqual(['accepted']);
    } finally { read.mockRestore(); }
  });

  it('applies parent-only presentation corrections even when canonical version and time are unchanged', async () => {
    const root = { record_id: 'thread', channel_id: 'ch1', pg_thread_id: 'thread' };
    const reply = { record_id: 'accepted', channel_id: 'ch1', parent_message_id: 'source', pg_thread_id: 'thread', sync_status: 'synced' };
    const store = createStore({ selectedChannelId: 'ch1', activeThreadId: 'thread', messages: [root, reply] });
    expect(store.visibleThreadMessages).toEqual([]);
    await store.applyMessages([root, { ...reply, parent_message_id: 'thread' }], { threadDetail: true });
    expect(store.visibleThreadMessages.map(row => row.record_id)).toEqual(['accepted']);
  });

  it('keeps two accepted child-branch messages visible through activity and rematerialisation', async () => {
    const workspaceDbKey = 'chat-message-manager-child-branch-reconciliation';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const inherited = {
      record_id: 'inherited-1', channel_id: 'channel-1', parent_message_id: 'parent-root',
      body: 'Inherited history', sync_status: 'synced', record_state: 'active',
      updated_at: '2026-09-04T00:39:00.000Z', pg_backend: true,
      pg_thread_id: 'parent-thread', pg_owning_thread_id: 'parent-thread',
      pg_effective_thread_id: 'child-thread', pg_inherited: true, read_only: true,
    };
    const childThread = {
      record_id: 'child-thread', channel_id: 'channel-1', parent_message_id: null,
      body: 'Branch', sync_status: 'synced', record_state: 'active',
      updated_at: '2026-09-04T00:39:30.000Z', pg_backend: true,
      pg_record_type: 'thread', pg_thread_id: 'child-thread',
      pg_effective_message_ids: ['inherited-1'],
      pg_metadata: { inherited_agent_recipient_npub: 'npub1agent' },
    };
    await Promise.all([upsertMessage(inherited), upsertMessage(childThread)]);
    const acceptedIds = ['child-message-1', 'child-message-2'];
    const resolvers = [];
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      const acceptedId = acceptedIds[resolvers.length];
      resolvers.push(() => resolve({
        ...localRow,
        record_id: acceptedId,
        sync_status: 'synced',
        pg_record_type: 'message',
        pg_thread_id: 'child-thread',
      }));
    }));

    try {
      const store = createStore({
        session: { npub: 'npub1human' },
        workspaceOwnerNpub: 'npub1owner',
        currentWorkspace: {
          workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1owner',
          directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg', pgBackendMode: true,
        },
        selectedChannelId: 'channel-1',
        activeThreadId: 'child-thread',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: [inherited, childThread],
        agentActivities: [],
        sseStatus: 'connected',
      });

      store.threadInput = 'First child question';
      const firstSend = store.sendThreadReply();
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      expect(store.visibleThreadMessages.map((message) => message.body)).toEqual([
        'Inherited history', 'First child question',
      ]);
      resolvers[0]();
      await expect(firstSend).resolves.toBe(true);
      expect(store.visibleThreadMessages.map((message) => message.body)).toEqual([
        'Inherited history', 'First child question',
      ]);

      store.agentActivities = [{
        record_id: 'activity-1', activity_id: 'activity-1', thread_id: 'child-thread', channel_id: 'channel-1',
        trigger_message_id: 'child-message-1', visibility: 'user_visible', state: 'working',
        sequence: 1, expires_at: '2999-01-01T00:00:00.000Z',
      }];
      expect(store.activeThreadAgentActivities).toHaveLength(1);
      expect(store.visibleThreadMessages.map((message) => message.body)).toContain('First child question');

      store.threadInput = 'Second child question';
      const secondSend = store.sendThreadReply();
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(2));
      expect(store.visibleThreadMessages.map((message) => message.body)).toEqual([
        'Inherited history', 'First child question', 'Second child question',
      ]);
      resolvers[1]();
      await expect(secondSend).resolves.toBe(true);
      expect(store.visibleThreadMessages.map((message) => message.body)).toEqual([
        'Inherited history', 'First child question', 'Second child question',
      ]);

      await upsertMessage({
        record_id: 'sibling-message', channel_id: 'channel-1', parent_message_id: 'sibling-thread',
        body: 'Sibling only', sync_status: 'synced', record_state: 'active',
        updated_at: '2026-09-04T00:42:00.000Z', pg_backend: true, pg_thread_id: 'sibling-thread',
      });
      await upsertMessage({
        record_id: 'parent-only', channel_id: 'channel-1', parent_message_id: 'parent-root',
        body: 'Parent only', sync_status: 'synced', record_state: 'active',
        updated_at: '2026-09-04T00:42:30.000Z', pg_backend: true, pg_thread_id: 'parent-thread',
      });
      await hydrateTowerPgThreadMessages(store, 'channel-1', 'child-thread', {
        getTowerPgThread: async () => ({ thread: {
          id: 'child-thread', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
          parent_thread_id: 'parent-thread', branch_point_message_id: 'branch-point',
          metadata: { inherited_agent_recipient_npub: 'npub1agent' }, row_version: 2,
        } }),
        getTowerPgChannelMessages: async () => ({ messages: [
          {
            id: 'inherited-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
            thread_id: 'parent-thread', owning_thread_id: 'parent-thread', effective_thread_id: 'child-thread',
            inherited: true, read_only: true, body: 'Inherited history',
            created_at: '2026-09-04T00:39:00.000Z', updated_at: '2026-09-04T00:39:00.000Z', row_version: 1,
          },
          ...acceptedIds.map((id, index) => ({
            id, workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
            thread_id: 'child-thread', owning_thread_id: 'child-thread', effective_thread_id: 'child-thread',
            body: `${index === 0 ? 'First' : 'Second'} child question`,
            created_at: `2026-09-04T00:4${index}:00.000Z`, updated_at: `2026-09-04T00:4${index}:00.000Z`, row_version: 1,
          })),
        ], next_cursor: null }),
      });

      const reopened = createStore({
        activeThreadId: 'child-thread',
        messages: await getMessagePresentationWindowByChannel('channel-1', { activeThreadId: 'child-thread' }),
      });
      expect(reopened.visibleThreadMessages.map((message) => message.body)).toEqual([
        'Inherited history', 'First child question', 'Second child question',
      ]);
      expect(reopened.visibleThreadMessages.map((message) => message.body)).not.toContain('Sibling only');
      expect(reopened.visibleThreadMessages.map((message) => message.body)).not.toContain('Parent only');
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('routes an unmentioned branch reply through internal metadata without adding a visible mention', async () => {
    const workspaceDbKey = 'chat-message-manager-branch-internal-recipient';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-child-reply',
      sync_status: 'synced',
      pg_backend: true,
    }));
    const childThread = {
      record_id: 'child-thread', channel_id: 'channel-1', parent_message_id: null,
      body: 'Branch', pg_backend: true, pg_record_type: 'thread', pg_thread_id: 'child-thread',
      pg_metadata: { inherited_agent_recipient_npub: 'npub1agent' },
    };

    try {
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1human' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        selectedChannelId: 'channel-1',
        activeThreadId: 'child-thread',
        threadInput: 'A different approach, please',
        selectedAgentMentionsByComposer: { message: [], thread: [] },
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: [childThread],
      });

      expect(await fn()).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: 'A different approach, please',
          pg_metadata: { agent_direct_recipient_npub: 'npub1agent' },
        }),
        expect.objectContaining({ parentMessage: childThread }),
      );
      expect(createTowerPgMessageFromLocal.mock.calls[0][1].pg_metadata).not.toHaveProperty('mentions');
      expect(store.threadInput).toBe('');
      expect(store.selectedAgentMentionsByComposer.thread).toEqual([]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('turns rapid repeated Reply clicks into one request and one message', async () => {
    const workspaceDbKey = 'chat-message-manager-thread-reply-click-guard';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveCreate;
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      resolveCreate = () => resolve({
        ...localRow,
        record_id: 'pg-reply-once',
        sync_status: 'synced',
        pg_backend: true,
      });
    }));
    const rootMessage = {
      record_id: 'root-guard', channel_id: 'channel-1', parent_message_id: null, body: 'Root',
      sender_npub: 'npub1viewer', sync_status: 'synced', record_state: 'active',
      updated_at: '2026-08-02T09:00:00.000Z', pg_backend: true, pg_thread_id: 'pg-thread-guard',
    };

    try {
      await upsertMessage(rootMessage);
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        selectedChannelId: 'channel-1',
        activeThreadId: 'root-guard',
        threadInput: 'one reply',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messages: [rootMessage],
      });

      const firstClick = fn();
      await expect(fn()).resolves.toBe(false);
      await expect(fn()).resolves.toBe(false);
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      const attempt = createTowerPgMessageFromLocal.mock.calls[0][1];
      expect(attempt.pg_client_request_id).toBe(attempt.record_id);
      resolveCreate();
      await expect(firstClick).resolves.toBe(true);

      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
      expect((await getMessagesByChannel('channel-1')).map((message) => message.record_id)).toEqual(['root-guard', 'pg-reply-once']);
      expect(store.composerSendPending.thread).toBe(false);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('clears the thread composer guard after failure and permits an intentional retry', async () => {
    const workspaceDbKey = 'chat-message-manager-thread-reply-failure-retry';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal
      .mockRejectedValueOnce(new Error('Tower rejected reply'))
      .mockImplementationOnce(async (_store, localRow) => ({
        ...localRow,
        record_id: 'pg-reply-retry',
        sync_status: 'synced',
        pg_backend: true,
      }));
    const rootMessage = {
      record_id: 'root-retry', channel_id: 'channel-1', parent_message_id: null, body: 'Root',
      sender_npub: 'npub1viewer', sync_status: 'synced', record_state: 'active',
      updated_at: '2026-08-02T09:00:00.000Z', pg_backend: true, pg_thread_id: 'pg-thread-retry',
    };

    try {
      await upsertMessage(rootMessage);
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        selectedChannelId: 'channel-1',
        activeThreadId: 'root-retry',
        threadInput: 'first attempt',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messages: [rootMessage],
      });

      await expect(fn()).resolves.toBe(false);
      expect(store.composerSendPending.thread).toBe(false);
      store.threadInput = 'intentional retry';
      await expect(fn()).resolves.toBe(true);

      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(2);
      expect(createTowerPgMessageFromLocal.mock.calls[1][1].body).toBe('intentional retry');
      expect(store.composerSendPending.thread).toBe(false);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps an optimistic PG thread reply through a stale snapshot and reconciles it in place', async () => {
    const workspaceDbKey = 'chat-message-manager-send-thread-pg-reconciliation';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveCreate;
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      resolveCreate = () => resolve({
        ...localRow,
        record_id: 'pg-reply-1',
        sync_status: 'synced',
        pg_record_type: 'message',
      });
    }));
    const rootMessage = {
      record_id: 'root-1', channel_id: 'ch1', parent_message_id: null, body: 'Root',
      sender_npub: 'npub1viewer', sync_status: 'synced', record_state: 'active',
      updated_at: '2026-06-06T01:00:00.000Z', pg_backend: true, pg_thread_id: 'pg-thread-1',
    };
    const siblingRoot = {
      ...rootMessage,
      record_id: 'root-2',
      body: 'Sibling root',
      updated_at: '2026-06-06T01:01:00.000Z',
      pg_thread_id: 'pg-thread-2',
    };

    try {
      await upsertMessage(rootMessage);
      await upsertMessage(siblingRoot);
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        selectedChannelId: 'ch1',
        activeThreadId: 'root-1',
        threadInput: 'reply throughout',
        channels: [{ record_id: 'ch1', scope_id: 'scope-1', owner_npub: 'npub1owner', group_ids: [] }],
        messages: [rootMessage, siblingRoot],
      });

      const send = fn();
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      const clientRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect((await getMessagesByChannel('ch1')).map((message) => message.record_id)).toEqual(['root-1', 'root-2', clientRecordId]);
      expect(await getMessageById(clientRecordId)).toMatchObject({
        channel_id: 'ch1',
        parent_message_id: 'root-1',
        pg_workspace_id: 'workspace-1',
        pg_scope_id: 'scope-1',
        pg_thread_id: 'pg-thread-1',
      });

      store.activeThreadId = 'root-2';
      await store.refreshMessages();
      expect(store.threadMessages).toEqual([]);

      store.activeThreadId = 'root-1';
      await store.refreshMessages();
      expect(store.threadMessages.map((message) => message.record_id)).toEqual([clientRecordId]);

      await replacePgMessagesForChannel('ch1', [rootMessage, siblingRoot]);
      await store.refreshMessages();
      expect(store.threadMessages.map((message) => message.record_id)).toEqual([clientRecordId]);

      resolveCreate();
      await send;
      await replacePgMessagesForChannel('ch1', [rootMessage, siblingRoot]);
      await store.refreshMessages();
      expect(store.threadMessages.map((message) => message.record_id)).toEqual(['pg-reply-1']);

      const { pg_reconciliation_pending, ...authoritativeReply } = store.threadMessages[0];
      await replacePgMessagesForChannel('ch1', [rootMessage, siblingRoot, {
        ...authoritativeReply,
        pg_client_record_id: clientRecordId,
      }]);
      await store.refreshMessages();
      expect(store.threadMessages).toHaveLength(1);
      expect((await getMessageById('pg-reply-1')).pg_reconciliation_pending).toBeUndefined();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('does nothing with empty input and no drafts', async () => {
    const { fn, store } = bindMethod('sendThreadReply', {
      threadInput: '',
      threadAudioDrafts: [],
      activeThreadId: 'm1',
      selectedChannelId: 'ch1',
    });
    await fn();
    expect(store.performSync).not.toHaveBeenCalled();
  });

  it('sets error when no thread open', async () => {
    const { fn, store } = bindMethod('sendThreadReply', {
      threadInput: 'reply',
      threadAudioDrafts: [],
      activeThreadId: null,
      selectedChannelId: 'ch1',
    });
    await fn();
    expect(store.error).toBe('Open a thread first');
  });

  it('sets error when image upload in progress', async () => {
    const { fn, store } = bindMethod('sendThreadReply', {
      threadInput: 'reply',
      threadImageUploadCount: 1,
      activeThreadId: 'm1',
      selectedChannelId: 'ch1',
    });
    await fn();
    expect(store.error).toBe('Wait for image upload to finish.');
  });

  it('does not create a new PG thread when a reply root lacks thread metadata', async () => {
    const workspaceDbKey = 'chat-message-manager-send-thread-reply-missing-pg-thread';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);

    try {
      const staleRoot = {
        record_id: 'stale-root',
        channel_id: 'ch1',
        parent_message_id: null,
        body: 'Unthreaded root',
        sender_npub: 'npub1viewer',
        sync_status: 'synced',
        record_state: 'active',
        updated_at: '2026-06-06T01:00:00.000Z',
        pg_backend: true,
        pg_thread_id: null,
      };
      await upsertMessage(staleRoot);
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        activeThreadId: 'stale-root',
        threadInput: 'reply pg @[Test Agent](mention:agent:npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266)',
        selectedAgentMentionsByComposer: {
          message: [],
          thread: [{ type: 'agent', npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266', label: 'Test Agent' }],
        },
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messages: [staleRoot],
        getPreferredChannelWriteGroup: vi.fn().mockReturnValue(null),
      });

      await fn();

      expect(store.error).toBe('Thread is still loading. Try again in a moment.');
      expect(createTowerPgMessageFromLocal).not.toHaveBeenCalled();
      expect((await getMessagesByChannel('ch1')).map((message) => message.record_id)).toEqual(['stale-root']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('replaces optimistic PG thread replies without promoting them to the main channel', async () => {
    const workspaceDbKey = 'chat-message-manager-send-thread-reply-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      record_id: 'pg-reply-1',
      channel_id: localRow.channel_id,
      parent_message_id: localRow.parent_message_id,
      body: localRow.body,
      attachments: [],
      sender_npub: localRow.sender_npub,
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      updated_at: '2026-06-06T01:01:00.000Z',
      pg_backend: true,
      pg_record_type: 'message',
      pg_thread_id: 'pg-thread-1',
    }));

    try {
      const rootMessage = {
        record_id: 'root-1',
        channel_id: 'ch1',
        parent_message_id: null,
        body: 'Root',
        sender_npub: 'npub1viewer',
        sync_status: 'synced',
        record_state: 'active',
        updated_at: '2026-06-06T01:00:00.000Z',
        pg_backend: true,
        pg_thread_id: 'pg-thread-1',
      };
      await upsertMessage(rootMessage);
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        activeThreadId: 'root-1',
        threadInput: 'reply pg @[Test Agent](mention:agent:npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266)',
        selectedAgentMentionsByComposer: {
          message: [],
          thread: [{ type: 'agent', npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266', label: 'Test Agent' }],
        },
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messages: [rootMessage],
        getPreferredChannelWriteGroup: vi.fn().mockReturnValue(null),
      });

      await fn();

      const localRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect(createTowerPgMessageFromLocal.mock.calls[0][1].pg_metadata).toEqual({
        mentions: [{
          type: 'agent',
          npub: 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266',
          label: 'Test Agent',
        }],
      });
      expect(createTowerPgMessageFromLocal.mock.calls[0][2]).toMatchObject({
        parentMessage: rootMessage,
      });
      expect(await getMessageById(localRecordId)).toBeUndefined();
      expect(await getMessageById('pg-reply-1')).toMatchObject({
        record_id: 'pg-reply-1',
        parent_message_id: 'root-1',
        sync_status: 'synced',
        pg_backend: true,
      });
      expect(store.mainFeedMessages.map((message) => message.record_id)).toEqual(['root-1']);
      expect(store.threadMessages.map((message) => message.record_id)).toEqual(['pg-reply-1']);
      expect(store.pendingThreadActivityAutoScroll).toEqual({
        triggerMessageId: 'pg-reply-1',
        threadId: 'pg-thread-1',
      });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('submits a thread storage file link with canonical PG attachment metadata', async () => {
    const workspaceDbKey = 'chat-message-manager-send-thread-storage-link-attachment';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'pg-storage-link-reply',
      sync_status: 'synced',
      version: 1,
      pg_backend: true,
      pg_thread_id: 'pg-thread-1',
    }));

    try {
      const rootMessage = {
        record_id: 'root-1',
        channel_id: 'channel-1',
        parent_message_id: null,
        body: 'Root',
        sender_npub: 'npub1viewer',
        sync_status: 'synced',
        record_state: 'active',
        updated_at: '2026-06-06T01:00:00.000Z',
        pg_backend: true,
        pg_thread_id: 'pg-thread-1',
      };
      await upsertMessage(rootMessage);
      const body = '[Notes.txt](storage://storage-reply-1)';
      const { fn } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        currentWorkspace: { workspaceId: 'workspace-1' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'channel-1',
        activeThreadId: 'root-1',
        threadInput: body,
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1', owner_npub: 'npub1owner' }],
        messages: [rootMessage],
      });

      expect(await fn()).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body,
          parent_message_id: 'root-1',
          attachments: [{
            kind: 'file',
            storage_object_id: 'storage-reply-1',
            filename: 'Notes.txt',
          }],
        }),
        { parentMessage: rootMessage },
      );
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('attaches PG audio drafts to accepted thread replies', async () => {
    const workspaceDbKey = 'chat-message-manager-send-thread-reply-pg-audio';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      record_id: 'pg-reply-1',
      channel_id: localRow.channel_id,
      parent_message_id: localRow.parent_message_id,
      body: localRow.body,
      attachments: [],
      sender_npub: localRow.sender_npub,
      sync_status: 'synced',
      record_state: 'active',
      version: 1,
      updated_at: '2026-06-06T01:01:00.000Z',
      pg_backend: true,
      pg_record_type: 'message',
      pg_scope_id: 'scope-1',
      pg_thread_id: 'pg-thread-1',
    }));

    try {
      const rootMessage = {
        record_id: 'root-1',
        channel_id: 'ch1',
        parent_message_id: null,
        body: 'Root',
        sender_npub: 'npub1viewer',
        sync_status: 'synced',
        record_state: 'active',
        updated_at: '2026-06-06T01:00:00.000Z',
        pg_backend: true,
        pg_scope_id: 'scope-1',
        pg_thread_id: 'pg-thread-1',
      };
      await upsertMessage(rootMessage);
      const materializeAudioDrafts = vi.fn().mockResolvedValue({
        attachments: [{
          kind: 'audio',
          audio_note_record_id: 'audio-reply-pg-1',
          title: 'Reply voice note',
          duration_seconds: 8,
        }],
      });
      const { fn, store } = bindMethod('sendThreadReply', {
        session: { npub: 'npub1viewer' },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'ch1',
        activeThreadId: 'root-1',
        threadInput: 'reply pg audio',
        threadAudioDrafts: [{ draft_id: 'draft-reply-1', title: 'Reply voice note', storage_object_id: 'storage-2' }],
        channels: [{ record_id: 'ch1', owner_npub: 'npub1owner', group_ids: [] }],
        messages: [rootMessage],
        materializeAudioDrafts,
      });

      await fn();

      const localRecordId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      expect(materializeAudioDrafts).toHaveBeenCalledWith(expect.objectContaining({
        drafts: [{ draft_id: 'draft-reply-1', title: 'Reply voice note', storage_object_id: 'storage-2' }],
        target_record_id: 'pg-reply-1',
        target_record_family_hash: 'mock:chat_message',
        scopeId: 'scope-1',
        channelId: 'ch1',
        threadId: 'pg-thread-1',
      }));
      expect(materializeAudioDrafts.mock.calls[0][0].target_record_id).not.toBe(localRecordId);
      expect(await getMessageById('pg-reply-1')).toMatchObject({
        record_id: 'pg-reply-1',
        attachments: [{
          kind: 'audio',
          audio_note_record_id: 'audio-reply-pg-1',
          title: 'Reply voice note',
          duration_seconds: 8,
        }],
      });
      expect(store.threadMessages[0]).toMatchObject({
        record_id: 'pg-reply-1',
        attachments: [expect.objectContaining({ audio_note_record_id: 'audio-reply-pg-1' })],
      });
      expect(store.error).toBeNull();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });
});

describe('thread Hang calls', () => {
  it('posts into the exact open PG thread without consuming composer drafts', async () => {
    const workspaceDbKey = 'chat-message-manager-hang-call-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'hang-reply',
      sync_status: 'synced',
      pg_backend: true,
      pg_thread_id: 'thread-exact',
    }));
    try {
      const rootMessage = {
        record_id: 'root-exact', channel_id: 'channel-exact', parent_message_id: null,
        body: 'Root', sender_npub: 'npub1viewer', sync_status: 'synced', record_state: 'active',
        updated_at: '2026-07-25T00:00:00.000Z', pg_backend: true, pg_thread_id: 'thread-exact',
      };
      await upsertMessage(rootMessage);
      const { fn, store } = bindMethod('startThreadHangCall', {
        session: { npub: 'npub1viewer' }, selectedChannelId: 'channel-exact', activeThreadId: 'root-exact',
        channels: [{ record_id: 'channel-exact', owner_npub: 'npub1owner' }], messages: [rootMessage],
        threadInput: 'unfinished ordinary reply',
        threadAudioDrafts: [{ draft_id: 'audio-draft' }],
        threadFileDrafts: [{ draft_id: 'file-draft', status: 'ready', kind: 'file' }],
        threadHangCallSending: false, threadHangCallError: '', threadHangCallRetryUrl: '',
      });
      const roomUrl = `https://hang.live/@${'B'.repeat(63)}`;
      expect(await fn(roomUrl)).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          channel_id: 'channel-exact', parent_message_id: 'root-exact', pg_thread_id: 'thread-exact',
          body: expect.stringContaining(roomUrl), attachments: [],
        }),
        { parentMessage: rootMessage },
      );
      expect(store.threadInput).toBe('unfinished ordinary reply');
      expect(store.threadAudioDrafts).toEqual([{ draft_id: 'audio-draft' }]);
      expect(store.threadFileDrafts).toEqual([{ draft_id: 'file-draft', status: 'ready', kind: 'file' }]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('prevents duplicate starts while sending and keeps a retry URL after failure', async () => {
    let resolveSend;
    const sendThreadReply = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    const { fn, store } = bindMethod('startThreadHangCall', {
      selectedChannelId: 'channel-1', activeThreadId: 'root-1', sendThreadReply,
      threadHangCallSending: false, threadHangCallError: '', threadHangCallRetryUrl: '',
    });
    const first = fn();
    expect(store.threadHangCallSending).toBe(true);
    expect(await fn()).toBe(false);
    expect(sendThreadReply).toHaveBeenCalledTimes(1);
    resolveSend(false);
    expect(await first).toBe(false);
    expect(store.threadHangCallSending).toBe(false);
    expect(store.threadHangCallRetryUrl).toMatch(/^https:\/\/hang\.live\/@[A-Za-z0-9]{63}$/);
    expect(store.threadHangCallError).toContain('could not be posted');
  });
});

describe('channel Hang calls', () => {
  it('creates a PG thread root in the selected channel without consuming composer drafts', async () => {
    const workspaceDbKey = 'chat-message-manager-channel-hang-call-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'hang-root',
      sync_status: 'synced',
      pg_backend: true,
      pg_thread_id: 'hang-thread',
    }));
    try {
      const { fn, store } = bindMethod('startChannelHangCall', {
        session: { npub: 'npub1viewer' }, selectedChannelId: 'channel-exact',
        channels: [{ record_id: 'channel-exact', owner_npub: 'npub1owner' }],
        messageInput: 'unfinished channel draft',
        messageAudioDrafts: [{ draft_id: 'audio-draft' }],
        messageFileDrafts: [{ draft_id: 'file-draft', status: 'ready', kind: 'file' }],
        channelHangCallSending: false, channelHangCallError: '', channelHangCallRetryUrl: '',
      });
      const roomUrl = `https://hang.live/@${'C'.repeat(63)}`;
      expect(await fn(roomUrl)).toBe(true);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          channel_id: 'channel-exact', parent_message_id: null,
          body: expect.stringContaining(roomUrl), attachments: [],
        }),
      );
      expect(store.messageInput).toBe('unfinished channel draft');
      expect(store.messageAudioDrafts).toEqual([{ draft_id: 'audio-draft' }]);
      expect(store.messageFileDrafts).toEqual([{ draft_id: 'file-draft', status: 'ready', kind: 'file' }]);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('blocks duplicate starts and retries the same room after failure', async () => {
    let resolveSend;
    const sendMessage = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    const { fn, store } = bindMethod('startChannelHangCall', {
      selectedChannelId: 'channel-1', sendMessage,
      channelHangCallSending: false, channelHangCallError: '', channelHangCallRetryUrl: '',
    });
    const first = fn();
    expect(store.channelHangCallSending).toBe(true);
    expect(await fn()).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    resolveSend(false);
    expect(await first).toBe(false);
    const retryUrl = store.channelHangCallRetryUrl;
    expect(retryUrl).toMatch(/^https:\/\/hang\.live\/@[A-Za-z0-9]{63}$/);
    expect(store.channelHangCallError).toContain('could not be posted');

    sendMessage.mockResolvedValueOnce(true);
    expect(await store.retryChannelHangCall()).toBe(true);
    expect(sendMessage).toHaveBeenLastCalledWith({ body: expect.stringContaining(retryUrl) });
    expect(store.channelHangCallRetryUrl).toBe('');
  });
});

// ---------------------------------------------------------------------------
// deleteActiveThread validation
// ---------------------------------------------------------------------------
describe('deleteActiveThread', () => {
  it('sets error when no thread open', async () => {
    const { fn, store } = bindMethod('deleteActiveThread', {
      activeThreadId: null,
      selectedChannelId: 'ch1',
      messages: [],
    });
    await fn();
    expect(store.error).toBe('Open a thread first');
  });

  it('opens the delete thread confirmation when a thread is active', async () => {
    const { fn, store } = bindMethod('deleteActiveThread', {
      activeThreadId: 'root-1',
      selectedChannelId: 'ch1',
      messages: [{ record_id: 'root-1', channel_id: 'ch1', body: 'Root', parent_message_id: null }],
    });
    await fn();
    expect(store.chatDeleteConfirm).toMatchObject({
      open: true,
      mode: 'thread',
      recordId: 'root-1',
      title: 'Delete Thread',
    });
  });
});

// ---------------------------------------------------------------------------
// deleteSelectedChannel validation
// ---------------------------------------------------------------------------
describe('deleteSelectedChannel', () => {
  it('sets error when no channel selected', async () => {
    const { fn, store } = bindMethod('deleteSelectedChannel', {
      selectedChannelId: null,
      channels: [],
    });
    await fn();
    expect(store.error).toBe('Select a channel first');
  });
});

// ---------------------------------------------------------------------------
// Chat message actions menu
// ---------------------------------------------------------------------------
describe('chat message actions menu', () => {
  const autopilotSessionId = '1f3ff8b3-2b0a-4876-889b-14c8a8a5ec63';

  it('allows only the synced PG message author to edit', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn } = bindMethod('canEditMessage', { session: { npub: 'npub1operator-a' } });
    const authored = {
      pg_backend: true, sender_npub: 'npub1operator-a', sync_status: 'synced', record_state: 'active',
    };
    expect(fn(authored)).toBe(true);
    expect(fn({ ...authored, sender_npub: 'npub1other' })).toBe(false);
    expect(fn({ ...authored, sync_status: 'pending' })).toBe(false);
    expect(fn({ ...authored, record_state: 'deleted' })).toBe(false);
  });

  it('offers resend only for the current author\'s locally failed PG message', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn } = bindMethod('canResendMessage', { session: { npub: 'npub1operator-a' } });
    const failed = {
      record_id: 'local-1', pg_client_request_id: 'local-1', pg_backend: true,
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active',
    };
    expect(fn(failed)).toBe(true);
    expect(fn({ ...failed, sender_npub: 'npub1other' })).toBe(false);
    expect(fn({ ...failed, sync_status: 'synced' })).toBe(false);
    expect(fn({ ...failed, pg_record_type: 'message' })).toBe(false);
    expect(fn({ ...failed, pg_client_request_id: 'different' })).toBe(false);
  });

  it('retries body, mentions, and original attachment IDs with the same command identity', async () => {
    const workspaceDbKey = 'chat-message-manager-resend-success';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const attachment = {
      kind: 'file', storage_object_id: 'storage-1', filename: 'brief.pdf',
      content_type: 'application/pdf', size_bytes: 3,
    };
    const mention = { type: 'agent', npub: 'npub1testagent', label: 'Test Agent' };
    const failed = {
      record_id: 'failed-local', pg_client_request_id: 'failed-local', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: null,
      body: 'Retry @[Test Agent](mention:agent:npub1testagent) [brief.pdf](storage://storage-1)',
      attachments: [attachment], pg_metadata: { mentions: [mention] }, sender_npub: 'npub1operator-a',
      sync_status: 'failed', record_state: 'active', version: 1,
    };
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow, record_id: 'delivered-1', pg_record_type: 'message', sync_status: 'synced',
    }));

    try {
      await upsertMessage(failed);
      downloadStorageObjectBlob.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }));
      const { fn, store } = bindMethod('resendFailedMessage', {
        session: { npub: 'npub1operator-a' }, messages: [failed], selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        currentWorkspace: { directHttpsUrl: 'https://tower.example' },
        prepareStorageObjectForCurrentWorkspace: vi.fn().mockResolvedValue({ object_id: 'storage-copy-1' }),
        sha256HexForBytes: vi.fn().mockResolvedValue('abc123'),
      });

      expect(await fn('failed-local')).toBe(true);
      const retried = createTowerPgMessageFromLocal.mock.calls[0][1];
      expect(retried).toMatchObject({
        body: failed.body,
        attachments: [attachment],
        pg_metadata: { mentions: [mention] },
        pg_client_request_id: 'failed-local',
        record_id: 'failed-local',
      });
      expect(downloadStorageObjectBlob).not.toHaveBeenCalled();
      expect(uploadStorageObject).not.toHaveBeenCalled();
      expect(completeStorageObject).not.toHaveBeenCalled();
      expect(await getMessageById('failed-local')).toBeUndefined();
      expect((await getMessagesByChannel('channel-1')).map((message) => message.record_id)).toEqual(['delivered-1']);
      expect(store.messages.map((message) => message.record_id)).toEqual(['delivered-1']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps the command and attachment IDs retryable when delivery fails again', async () => {
    const workspaceDbKey = 'chat-message-manager-resend-copy-failure';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const failed = {
      record_id: 'failed-local', pg_client_request_id: 'failed-local', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: null, body: '[brief.pdf](storage://storage-1)',
      attachments: [{ kind: 'file', storage_object_id: 'storage-1', filename: 'brief.pdf' }],
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active', version: 1,
    };

    try {
      await upsertMessage(failed);
      createTowerPgMessageFromLocal.mockRejectedValue(new Error('Connection unavailable'));
      const { fn, store } = bindMethod('resendFailedMessage', {
        session: { npub: 'npub1operator-a' }, messages: [failed], selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
      });

      expect(await fn('failed-local')).toBe(false);
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
      expect(await getMessageById('failed-local')).toMatchObject({ record_id: failed.record_id, attachments: failed.attachments, sync_status: 'failed' });
      expect(store.messages).toHaveLength(1);
      expect(store.messageResendPendingIds).toEqual([]);
      expect(store.canResendMessage(failed)).toBe(true);
      expect(store.error).toContain('Connection unavailable');
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('deduplicates a pending resend and retains the same failed command after rejection', async () => {
    const workspaceDbKey = 'chat-message-manager-resend-failure';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let rejectSend;
    createTowerPgMessageFromLocal.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const failed = {
      record_id: 'failed-local', pg_client_request_id: 'failed-local', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: null, body: 'Retry me', attachments: [],
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active', version: 1,
    };

    try {
      await upsertMessage(failed);
      const { fn, store } = bindMethod('resendFailedMessage', {
        session: { npub: 'npub1operator-a' }, messages: [failed], selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
      });
      const first = fn('failed-local');
      expect(await fn('failed-local')).toBe(false);
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      rejectSend(new Error('Tower restarted'));
      expect(await first).toBe(false);

      const freshId = createTowerPgMessageFromLocal.mock.calls[0][1].record_id;
      const freshFailed = await getMessageById(freshId);
      expect(freshFailed).toMatchObject({ body: 'Retry me', sync_status: 'failed' });
      expect(store.canResendMessage(freshFailed)).toBe(true);
      expect(freshId).toBe('failed-local');
      expect(await getMessageById('failed-local')).toEqual(freshFailed);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('automatically retries a failed offline PG channel send and reconciles without a duplicate', async () => {
    const workspaceDbKey = 'chat-message-manager-auto-resync-channel';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const attachment = {
      kind: 'file', storage_object_id: 'storage-1', filename: 'brief.pdf',
      content_type: 'application/pdf', size_bytes: 12,
    };
    const mention = { type: 'agent', npub: 'npub1agent', label: 'Agent' };
    createTowerPgMessageFromLocal
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementationOnce(async (_store, localRow) => ({
        ...localRow,
        record_id: 'delivered-auto-1',
        pg_record_type: 'message',
        pg_thread_id: 'thread-delivered-1',
        sync_status: 'synced',
      }));

    try {
      const store = createStore({
        session: { npub: 'npub1operator-a' },
        currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
        workspaceOwnerNpub: 'npub1owner',
        selectedChannelId: 'channel-1',
        pgContextSelectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messageInput: 'Offline body @[Agent](mention:agent:npub1agent)',
        messageFileDrafts: [{
          draft_id: 'draft-file-1', status: 'ready', file: { name: 'brief.pdf' },
          error: '', preview_url: 'blob:brief', ...attachment,
        }],
        selectedAgentMentionsByComposer: { message: [mention], thread: [] },
        clearChatFileDrafts: vi.fn(function clearChatFileDrafts(context) {
          if (context === 'message') this.messageFileDrafts = [];
        }),
      });

      expect(await store.sendMessage()).toBe(false);
      const failed = (await getMessagesByChannel('channel-1')).find(row => row.sync_status === 'failed');
      expect(failed).toMatchObject({
        body: 'Offline body @[Agent](mention:agent:npub1agent)',
        attachments: [attachment],
        pg_metadata: { mentions: [mention] },
        pg_workspace_id: 'workspace-1',
        pg_scope_id: 'scope-1',
        pg_client_request_id: failed.record_id,
      });

      await expect(store.retryUnsyncedOutgoingMessages()).resolves.toEqual({ attempted: 1, sent: 1, failed: 0 });

      const retry = createTowerPgMessageFromLocal.mock.calls[1][1];
      expect(retry).toMatchObject({
        record_id: failed.record_id,
        pg_client_request_id: failed.record_id,
        body: failed.body,
        attachments: [attachment],
        pg_metadata: { mentions: [mention] },
        channel_id: 'channel-1',
        pg_workspace_id: 'workspace-1',
        pg_scope_id: 'scope-1',
      });
      const rows = await getMessagesByChannel('channel-1');
      expect(rows.map(row => row.record_id)).toEqual(['delivered-auto-1']);
      expect(rows[0]).toMatchObject({ pg_client_record_id: failed.record_id, sync_status: 'synced' });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('automatically retries a failed PG reply with its original parent thread context', async () => {
    const workspaceDbKey = 'chat-message-manager-auto-resync-reply';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const root = {
      record_id: 'root-1', channel_id: 'channel-1', parent_message_id: null,
      body: 'Root', pg_backend: true, pg_thread_id: 'thread-1', sync_status: 'synced',
      sender_npub: 'npub1operator-a', record_state: 'active',
    };
    const failed = {
      record_id: 'failed-reply', pg_client_request_id: 'failed-reply', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: 'root-1', pg_thread_id: 'thread-1',
      body: 'Reply with file [brief.pdf](storage://storage-1)',
      attachments: [{ kind: 'file', storage_object_id: 'storage-1', filename: 'brief.pdf' }],
      pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Agent' }] },
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active', version: 1,
      pg_workspace_id: 'workspace-1', pg_scope_id: 'scope-1',
    };
    createTowerPgMessageFromLocal.mockImplementation(async (_store, localRow) => ({
      ...localRow,
      record_id: 'delivered-reply',
      pg_record_type: 'message',
      sync_status: 'synced',
    }));

    try {
      await upsertMessage(root);
      await upsertMessage(failed);
      const store = createStore({
        session: { npub: 'npub1operator-a' },
        currentWorkspace: { workspaceId: 'workspace-1', pgBackendMode: true },
        selectedChannelId: 'channel-1',
        activeThreadId: 'different-open-thread',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: [root],
      });

      expect(await store.retryUnsyncedOutgoingMessages()).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          record_id: 'failed-reply',
          pg_client_request_id: 'failed-reply',
          parent_message_id: 'root-1',
          pg_thread_id: 'thread-1',
          body: failed.body,
          attachments: failed.attachments,
          pg_metadata: failed.pg_metadata,
        }),
        expect.objectContaining({
          parentMessage: { record_id: 'root-1', pg_thread_id: 'thread-1' },
        }),
      );
      expect((await getMessagesByChannel('channel-1')).map(row => row.record_id)).toEqual(['root-1', 'delivered-reply']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('does not duplicate an automatic retry while the same failed message is in flight', async () => {
    const workspaceDbKey = 'chat-message-manager-auto-resync-in-flight';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    let resolveSend;
    createTowerPgMessageFromLocal.mockImplementation((_store, localRow) => new Promise((resolve) => {
      resolveSend = () => resolve({ ...localRow, record_id: 'delivered-in-flight', sync_status: 'synced', pg_record_type: 'message' });
    }));
    const failed = {
      record_id: 'failed-local', pg_client_request_id: 'failed-local', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: null, body: 'Retry once', attachments: [],
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active', version: 1,
    };

    try {
      await upsertMessage(failed);
      const store = createStore({
        session: { npub: 'npub1operator-a' },
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: [failed],
      });
      const first = store.retryUnsyncedOutgoingMessages();
      await vi.waitFor(() => expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1));
      await expect(store.retryUnsyncedOutgoingMessages()).resolves.toEqual({ attempted: 0, sent: 0, failed: 0 });
      await expect(store.resendFailedMessage('failed-local')).resolves.toBe(false);
      resolveSend();
      await expect(first).resolves.toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      expect(createTowerPgMessageFromLocal).toHaveBeenCalledTimes(1);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps failed automatic retries recoverable for a later online transition', async () => {
    const workspaceDbKey = 'chat-message-manager-auto-resync-repeat-failure';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const failed = {
      record_id: 'failed-local', pg_client_request_id: 'failed-local', pg_backend: true,
      channel_id: 'channel-1', parent_message_id: null, body: 'Retry later', attachments: [],
      sender_npub: 'npub1operator-a', sync_status: 'failed', record_state: 'active', version: 1,
    };
    createTowerPgMessageFromLocal
      .mockRejectedValueOnce(new Error('Still offline'))
      .mockImplementationOnce(async (_store, localRow) => ({
        ...localRow, record_id: 'delivered-later', sync_status: 'synced', pg_record_type: 'message',
      }));

    try {
      await upsertMessage(failed);
      const store = createStore({
        session: { npub: 'npub1operator-a' },
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: [failed],
      });

      await expect(store.retryUnsyncedOutgoingMessages()).resolves.toEqual({ attempted: 1, sent: 0, failed: 1 });
      const retained = await getMessageById('failed-local');
      expect(retained).toMatchObject({ body: 'Retry later', sync_status: 'failed' });
      expect(store.canResendMessage(retained)).toBe(true);

      await expect(store.retryUnsyncedOutgoingMessages()).resolves.toEqual({ attempted: 1, sent: 1, failed: 0 });
      expect((await getMessagesByChannel('channel-1')).map(row => row.record_id)).toEqual(['delivered-later']);
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('ignores delivered, deleted, other-author, canonical, and non-idempotent failed messages', async () => {
    const workspaceDbKey = 'chat-message-manager-auto-resync-eligibility';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const base = {
      pg_backend: true, channel_id: 'channel-1', parent_message_id: null,
      body: 'Do not retry', attachments: [], sender_npub: 'npub1operator-a',
      sync_status: 'failed', record_state: 'active', version: 1,
    };
    const rows = [
      { ...base, record_id: 'delivered', pg_client_request_id: 'delivered', sync_status: 'synced' },
      { ...base, record_id: 'deleted', pg_client_request_id: 'deleted', record_state: 'deleted' },
      { ...base, record_id: 'other-author', pg_client_request_id: 'other-author', sender_npub: 'npub1other' },
      { ...base, record_id: 'canonical', pg_client_request_id: 'canonical', pg_record_type: 'message' },
      { ...base, record_id: 'mismatched-client', pg_client_request_id: 'client-original' },
    ];

    try {
      await Promise.all(rows.map(row => upsertMessage(row)));
      const store = createStore({
        session: { npub: 'npub1operator-a' },
        selectedChannelId: 'channel-1',
        channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
        messages: rows,
      });

      await expect(store.retryUnsyncedOutgoingMessages()).resolves.toEqual({ attempted: 0, sent: 0, failed: 0 });
      expect(createTowerPgMessageFromLocal).not.toHaveBeenCalled();
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('opens a root message edit in the thread modal composer', () => {
    isTowerPgBackendMode.mockReturnValue(true);
    const message = {
      record_id: 'msg-1', channel_id: 'channel-1', parent_message_id: null,
      body: 'Hello @[Test Agent](mention:agent:npub1testagent)', sender_npub: 'npub1operator-a',
      pg_backend: true, sync_status: 'synced', record_state: 'active',
      pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }] },
    };
    const { fn, store } = bindMethod('startMessageEdit', {
      session: { npub: 'npub1operator-a' }, messages: [message], selectedChannelId: 'channel-1',
      threadInput: 'preserved draft',
      selectedAgentMentionsByComposer: { message: [{ type: 'agent', npub: 'npub1sam', label: 'Sam' }], thread: [] },
    });

    fn('msg-1');

    expect(store.activeThreadId).toBe('msg-1');
    expect(store.threadInput).toBe(message.body);
    expect(store.messageEdit).toMatchObject({ recordId: 'msg-1', context: 'thread', threadRootId: 'msg-1', draftBeforeEdit: 'preserved draft' });
    expect(store.selectedAgentMentionsByComposer.thread).toEqual([{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }]);
  });

  it('restores the prior composer draft and mention selection when editing is cancelled', () => {
    const { fn, store } = bindMethod('cancelMessageEdit', {
      messageInput: 'edited body',
      selectedAgentMentionsByComposer: { message: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }], thread: [] },
      messageEdit: {
        recordId: 'msg-1', context: 'message', channelId: 'channel-1', threadRootId: '', originalBody: 'old',
        draftBeforeEdit: 'preserved draft', mentionsBeforeEdit: [{ type: 'agent', npub: 'npub1sam', label: 'Sam' }],
        submitting: false, error: '',
      },
    });

    expect(fn()).toBe(true);
    expect(store.messageInput).toBe('preserved draft');
    expect(store.selectedAgentMentionsByComposer.message).toEqual([{ type: 'agent', npub: 'npub1sam', label: 'Sam' }]);
    expect(store.messageEdit.recordId).toBe('');
  });

  it('saves a revised message with only structured mentions still present in the body', async () => {
    const workspaceDbKey = 'chat-message-manager-edit-message-pg';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    const original = {
      record_id: 'msg-1', channel_id: 'channel-1', parent_message_id: null, body: 'Original',
      sender_npub: 'npub1operator-a', pg_backend: true, sync_status: 'synced', record_state: 'active',
      version: 2, created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    };
    const accepted = {
      ...original, body: 'Revised @[Test Agent](mention:agent:npub1testagent)', version: 3,
      updated_at: '2026-07-24T00:05:00.000Z',
      pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }] },
    };
    updateTowerPgMessageFromLocal.mockResolvedValue(accepted);

    try {
      const { fn, store } = bindMethod('saveMessageEdit', {
        session: { npub: 'npub1operator-a' }, messages: [original], selectedChannelId: 'channel-1',
        messageInput: accepted.body,
        selectedAgentMentionsByComposer: {
          message: [
            { type: 'agent', npub: 'npub1testagent', label: 'Test Agent' },
            { type: 'agent', npub: 'npub1sam', label: 'Sam' },
          ],
          thread: [],
        },
        messageEdit: {
          recordId: 'msg-1', context: 'message', channelId: 'channel-1', threadRootId: '', originalBody: 'Original',
          draftBeforeEdit: 'draft', mentionsBeforeEdit: [], submitting: false, error: '',
        },
      });

      await fn();

      expect(updateTowerPgMessageFromLocal).toHaveBeenCalledWith(store, expect.objectContaining({ record_id: 'msg-1', version: 2 }), {
        body: accepted.body,
        mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
      });
      expect(store.messages[0]).toMatchObject({ body: accepted.body, version: 3, sync_status: 'synced' });
      expect(store.messageInput).toBe('draft');
      expect(store.messageEdit.recordId).toBe('');
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('keeps the edited draft open and reports an optimistic conflict', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    updateTowerPgMessageFromLocal.mockRejectedValue(Object.assign(new Error('stale'), {
      status: 409,
      code: 'stale_row_version',
    }));
    const message = {
      record_id: 'msg-1', channel_id: 'channel-1', parent_message_id: null, body: 'Original',
      sender_npub: 'npub1operator-a', pg_backend: true, sync_status: 'synced', record_state: 'active', version: 2,
    };
    const setMessageSyncStatus = vi.fn().mockImplementation((_id, status) => {
      message.sync_status = status;
    });
    const refreshMessages = vi.fn().mockResolvedValue(undefined);
    const { fn, store } = bindMethod('saveMessageEdit', {
      session: { npub: 'npub1operator-a' }, messages: [message], selectedChannelId: 'channel-1',
      messageInput: 'Conflicting revision', setMessageSyncStatus, refreshMessages,
      messageEdit: {
        recordId: 'msg-1', context: 'message', channelId: 'channel-1', threadRootId: '', originalBody: 'Original',
        draftBeforeEdit: '', mentionsBeforeEdit: [], submitting: false, error: '',
      },
    });

    await fn();
    await Promise.resolve();

    expect(store.messageEdit.recordId).toBe('msg-1');
    expect(store.messageEdit.submitting).toBe(false);
    expect(store.messageEdit.error).toContain('changed elsewhere');
    expect(setMessageSyncStatus).toHaveBeenLastCalledWith('msg-1', 'synced');
    expect(refreshMessages).toHaveBeenCalled();
  });

  it('shows edited metadata only when updated_at materially follows created_at', () => {
    const { fn } = bindMethod('isMessageEdited');
    expect(fn({ created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:02.000Z' })).toBe(true);
    expect(fn({ created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.500Z' })).toBe(false);
  });

  it('openMessageActionsMenu sets the active menu record id', () => {
    const { fn, store } = bindMethod('openMessageActionsMenu');
    fn('msg-1');
    expect(store.messageActionsMenuId).toBe('msg-1');
  });

  it('openMessageActionsMenu replaces previous menu id', () => {
    const { fn, store } = bindMethod('openMessageActionsMenu', {
      messageActionsMenuId: 'msg-old',
    });
    fn('msg-2');
    expect(store.messageActionsMenuId).toBe('msg-2');
  });

  it('closeMessageActionsMenu clears the active menu', () => {
    const { fn, store } = bindMethod('closeMessageActionsMenu', {
      messageActionsMenuId: 'msg-1',
    });
    fn();
    expect(store.messageActionsMenuId).toBeNull();
  });

  it('isMessageActionsMenuOpen returns true for matching id', () => {
    const { fn } = bindMethod('isMessageActionsMenuOpen', {
      messageActionsMenuId: 'msg-1',
    });
    expect(fn('msg-1')).toBe(true);
    expect(fn('msg-2')).toBe(false);
  });

  it('isMessageActionsMenuOpen returns false when no menu open', () => {
    const { fn } = bindMethod('isMessageActionsMenuOpen', {
      messageActionsMenuId: null,
    });
    expect(fn('msg-1')).toBe(false);
  });

  it('toggleMessageActionsMenu opens when closed', () => {
    const { fn, store } = bindMethod('toggleMessageActionsMenu', {
      messageActionsMenuId: null,
    });
    fn('msg-1');
    expect(store.messageActionsMenuId).toBe('msg-1');
  });

  it('toggleMessageActionsMenu closes when same id is open', () => {
    const { fn, store } = bindMethod('toggleMessageActionsMenu', {
      messageActionsMenuId: 'msg-1',
    });
    fn('msg-1');
    expect(store.messageActionsMenuId).toBeNull();
  });

  it('toggleMessageActionsMenu switches to new id when different id is open', () => {
    const { fn, store } = bindMethod('toggleMessageActionsMenu', {
      messageActionsMenuId: 'msg-1',
    });
    fn('msg-2');
    expect(store.messageActionsMenuId).toBe('msg-2');
  });

  it('shows an Autopilot session link only for trusted session metadata and a configured base URL', () => {
    const { fn } = bindMethod('hasAutopilotSessionLink', {
      workspaceHarnessUrl: 'https://wingman.example.test',
    });

    expect(fn({ pg_metadata: { source: 'autopilot_session', session_id: autopilotSessionId } })).toBe(true);
    expect(fn({ pg_metadata: { source: 'user', session_id: autopilotSessionId } })).toBe(false);
    expect(fn({ pg_metadata: { source: 'autopilot_session', session_id: 'not-a-session' } })).toBe(false);
    expect(fn({ metadata: { source: 'autopilot_session', session_id: '  ' } })).toBe(false);
  });

  it('hides the Autopilot session link when no Autopilot base URL is configured', () => {
    const { fn } = bindMethod('hasAutopilotSessionLink', { workspaceHarnessUrl: '' });
    expect(fn({ metadata: { source: 'autopilot_session', session_id: autopilotSessionId } })).toBe(false);
  });

  it('hides the Autopilot session link when the configured base URL is invalid', () => {
    const { fn } = bindMethod('hasAutopilotSessionLink', { workspaceHarnessUrl: 'not a URL' });
    expect(fn({ metadata: { source: 'autopilot_session', session_id: autopilotSessionId } })).toBe(false);
  });

  it('opens the canonical Autopilot live-session target and closes the menu', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const { fn, store } = bindMethod('openMessageAutopilotSession', {
      workspaceHarnessUrl: 'https://wingman.example.test/settings?tab=apps',
      messageActionsMenuId: 'msg-1',
    });

    fn({ pg_metadata: { source: 'autopilot_session', session_id: autopilotSessionId } });

    expect(open).toHaveBeenCalledWith(
      `https://wingman.example.test/live/${autopilotSessionId}`,
      '_blank',
      'noopener,noreferrer',
    );
    expect(store.messageActionsMenuId).toBeNull();
    vi.unstubAllGlobals();
  });

  it('resolves a trusted thread session for an own message without session metadata', () => {
    const ownMessage = {
      record_id: 'thread-1',
      parent_message_id: null,
      updated_at: '2026-07-30T01:00:00.000Z',
      pg_metadata: { source: 'user' },
    };
    const { fn } = bindMethod('hasThreadAutopilotSessionLink', {
      workspaceHarnessUrl: 'https://wingman.example.test',
      activeThreadId: 'thread-1',
      messages: [
        ownMessage,
        {
          record_id: 'reply-1',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:01:00.000Z',
          pg_metadata: { source: 'autopilot_session', session_id: autopilotSessionId },
        },
      ],
    });

    expect(fn(ownMessage)).toBe(true);
  });

  it('chooses the latest trusted session in deterministic thread message order', () => {
    const newerSessionId = '123e4567-e89b-42d3-a456-426614174001';
    const { fn } = bindMethod('getThreadAutopilotSessionId', {
      activeThreadId: 'thread-1',
      messages: [
        { record_id: 'thread-1', parent_message_id: null, updated_at: '2026-07-30T01:00:00.000Z' },
        {
          record_id: 'reply-z',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:05:00.000Z',
          metadata: { source: 'autopilot_session', session_id: newerSessionId },
        },
        {
          record_id: 'reply-a',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:01:00.000Z',
          pg_metadata: { source: 'autopilot_session', session_id: autopilotSessionId },
        },
        {
          record_id: 'reply-user',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:06:00.000Z',
          metadata: { source: 'user', session_id: '123e4567-e89b-42d3-a456-426614174002' },
        },
      ],
    });

    expect(fn()).toBe(newerSessionId);
  });

  it('updates the resolved session when a later trusted reply materializes', () => {
    const newerSessionId = '123e4567-e89b-42d3-a456-426614174001';
    const { fn, store } = bindMethod('getThreadAutopilotSessionId', {
      activeThreadId: 'thread-1',
      messages: [
        { record_id: 'thread-1', parent_message_id: null, updated_at: '2026-07-30T01:00:00.000Z' },
        {
          record_id: 'reply-1',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:01:00.000Z',
          pg_metadata: { source: 'autopilot_session', session_id: autopilotSessionId },
        },
      ],
    });

    expect(fn()).toBe(autopilotSessionId);
    store.messages = [...store.messages, {
      record_id: 'reply-2',
      parent_message_id: 'thread-1',
      updated_at: '2026-07-30T01:02:00.000Z',
      pg_metadata: { source: 'autopilot_session', session_id: newerSessionId },
    }];
    expect(fn()).toBe(newerSessionId);
  });

  it('does not expose a thread session for untrusted metadata or an invalid base URL', () => {
    const untrustedMessages = [{
      record_id: 'thread-1',
      parent_message_id: null,
      updated_at: '2026-07-30T01:00:00.000Z',
      metadata: { source: 'user', session_id: autopilotSessionId },
    }];
    const trustedMessages = [{
      ...untrustedMessages[0],
      metadata: { source: 'autopilot_session', session_id: autopilotSessionId },
    }];

    expect(bindMethod('hasThreadAutopilotSessionLink', {
      activeThreadId: 'thread-1',
      workspaceHarnessUrl: 'https://wingman.example.test',
      messages: untrustedMessages,
    }).fn()).toBe(false);
    expect(bindMethod('hasThreadAutopilotSessionLink', {
      activeThreadId: 'thread-1',
      workspaceHarnessUrl: 'invalid',
      messages: trustedMessages,
    }).fn()).toBe(false);
  });

  it('opens the latest canonical thread session and closes message and thread menus', () => {
    const newerSessionId = '123e4567-e89b-42d3-a456-426614174001';
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const { fn, store } = bindMethod('openThreadAutopilotSession', {
      activeThreadId: 'thread-1',
      workspaceHarnessUrl: 'https://wingman.example.test/settings?tab=apps',
      messageActionsMenuId: 'thread-1',
      threadMenuOpen: true,
      messages: [
        { record_id: 'thread-1', parent_message_id: null, updated_at: '2026-07-30T01:00:00.000Z' },
        {
          record_id: 'reply-1',
          parent_message_id: 'thread-1',
          updated_at: '2026-07-30T01:01:00.000Z',
          pg_metadata: { source: 'autopilot_session', session_id: newerSessionId },
        },
      ],
    });

    fn();

    expect(open).toHaveBeenCalledWith(
      `https://wingman.example.test/live/${newerSessionId}`,
      '_blank',
      'noopener,noreferrer',
    );
    expect(store.messageActionsMenuId).toBeNull();
    expect(store.threadMenuOpen).toBe(false);
    vi.unstubAllGlobals();
  });

  it('inspectMessageSyncStatus calls openRecordStatusModal with chat_message family', () => {
    const openRecordStatusModal = vi.fn();
    const { fn, store } = bindMethod('inspectMessageSyncStatus', {
      openRecordStatusModal,
      messages: [
        { record_id: 'msg-1', body: 'Hello world', parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
      ],
      messageActionsMenuId: 'msg-1',
    });
    fn('msg-1');
    expect(openRecordStatusModal).toHaveBeenCalledWith({
      familyId: 'chat_message',
      recordId: 'msg-1',
      label: 'Hello world',
    });
    expect(store.messageActionsMenuId).toBeNull();
  });

  it('inspectMessageSyncStatus truncates long message body for label', () => {
    const openRecordStatusModal = vi.fn();
    const longBody = 'A'.repeat(60);
    const { fn } = bindMethod('inspectMessageSyncStatus', {
      openRecordStatusModal,
      messages: [
        { record_id: 'msg-1', body: longBody, parent_message_id: null, updated_at: '2024-01-01T00:00:00Z' },
      ],
      messageActionsMenuId: 'msg-1',
    });
    fn('msg-1');
    const label = openRecordStatusModal.mock.calls[0][0].label;
    expect(label.length).toBeLessThanOrEqual(53);
    expect(label.endsWith('...')).toBe(true);
  });

  it('inspectMessageSyncStatus uses fallback label when message not found', () => {
    const openRecordStatusModal = vi.fn();
    const { fn } = bindMethod('inspectMessageSyncStatus', {
      openRecordStatusModal,
      messages: [],
      messageActionsMenuId: null,
    });
    fn('msg-unknown');
    expect(openRecordStatusModal).toHaveBeenCalledWith({
      familyId: 'chat_message',
      recordId: 'msg-unknown',
      label: 'Chat message',
    });
  });

  it('copyMessageRawText writes the stored markdown body to clipboard', async () => {
    const copyTextToClipboard = vi.fn();
    const { fn, store } = bindMethod('copyMessageRawText', {
      copyTextToClipboard,
      messageActionsMenuId: 'msg-1',
      threadMenuOpen: true,
      messages: [{
        record_id: 'msg-1',
        body: 'Hello ![image](storage://image-1)',
      }],
    });

    await fn('msg-1');

    expect(copyTextToClipboard).toHaveBeenCalledWith('Hello ![image](storage://image-1)');
    expect(store.messageActionsMenuId).toBeNull();
    expect(store.threadMenuOpen).toBe(false);
  });

  it('copyThreadRawText writes a raw parent and replies transcript', async () => {
    const copyTextToClipboard = vi.fn();
    const { fn } = bindMethod('copyThreadRawText', {
      copyTextToClipboard,
      getSenderName: vi.fn((npub) => (npub === 'npub1a' ? 'Alice' : 'Bob')),
      messages: [
        { record_id: 'root-1', body: 'Root **markdown**', sender_npub: 'npub1a', parent_message_id: null, updated_at: '2026-06-01T00:00:00.000Z' },
        { record_id: 'reply-1', body: 'Reply ![x](storage://img)', sender_npub: 'npub1b', parent_message_id: 'root-1', updated_at: '2026-06-01T00:01:00.000Z' },
      ],
    });

    await fn('root-1');

    expect(copyTextToClipboard.mock.calls[0][0]).toContain('Root **markdown**');
    expect(copyTextToClipboard.mock.calls[0][0]).toContain('Reply ![x](storage://img)');
  });

  it('copyFlightDeckReference writes a mention token for records', async () => {
    const copyTextToClipboard = vi.fn();
    const { fn, store } = bindMethod('copyFlightDeckReference', {
      documents: [{ record_id: 'doc-1', title: 'New Doc Editor' }],
      copyTextToClipboard,
      threadMenuOpen: true,
    });

    await fn('document', 'doc-1');

    expect(copyTextToClipboard).toHaveBeenCalledWith('@[New Doc Editor](mention:doc:doc-1)');
    expect(store.copiedFlightDeckRefKey).toBe('doc:doc-1');
    expect(store.threadMenuOpen).toBe(false);
  });

  it('builds channel-aware chat message Flight Deck reference ids', () => {
    const { fn } = bindMethod('buildChatMessageFlightDeckReferenceId', {
      selectedChannelId: 'channel-fallback',
      messages: [{ record_id: 'msg-1', channel_id: 'channel-1', body: 'Hello' }],
    });

    expect(fn('msg-1')).toBe('channel-1#msg-1');
    expect(fn('msg-2')).toBe('channel-fallback#msg-2');
  });

  it('openChatDeleteConfirm prepares a delete modal for messages', () => {
    const { fn, store } = bindMethod('openChatDeleteConfirm', {
      messageActionsMenuId: 'msg-1',
      threadMenuOpen: true,
      messages: [{ record_id: 'msg-1', body: 'Hello' }],
    });

    fn('message', 'msg-1');

    expect(store.chatDeleteConfirm).toMatchObject({
      open: true,
      mode: 'message',
      recordId: 'msg-1',
      title: 'Delete Message',
    });
    expect(store.messageActionsMenuId).toBeNull();
    expect(store.threadMenuOpen).toBe(false);
  });

  it('deleteChatMessageById deletes PG messages through Tower and hides them locally', async () => {
    const workspaceDbKey = 'chat-message-manager-delete-pg-message';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgMessageFromLocal.mockResolvedValue({
      record_id: 'pg-message-1',
      channel_id: 'ch1',
      body: 'Delete me',
      record_state: 'deleted',
      sync_status: 'synced',
      pg_backend: true,
    });

    try {
      const message = {
        record_id: 'pg-message-1',
        channel_id: 'ch1',
        body: 'Delete me',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        pg_backend: true,
      };
      await upsertMessage(message);
      const { fn, store } = bindMethod('deleteChatMessageById', {
        messages: [message],
      });

      await fn('pg-message-1');

      expect(deleteTowerPgMessageFromLocal).toHaveBeenCalledWith(store, message);
      expect(store.mainFeedMessages).toEqual([]);
      expect(await getMessageById('pg-message-1')).toMatchObject({ record_state: 'deleted' });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('deleteChatMessageById hides stale PG messages when Tower reports them missing', async () => {
    const workspaceDbKey = 'chat-message-manager-delete-missing-pg-message';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgMessageFromLocal.mockImplementation(async (_store, message) => ({
      ...message,
      record_state: 'deleted',
      sync_status: 'synced',
      version: (message.version || 1) + 1,
      pg_backend: true,
    }));

    try {
      const message = {
        record_id: 'pg-message-missing',
        channel_id: 'ch1',
        body: 'Duplicate sent in error',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        version: 2,
        pg_backend: true,
      };
      await upsertMessage(message);
      const { fn, store } = bindMethod('deleteChatMessageById', {
        messages: [message],
      });

      await fn('pg-message-missing');

      expect(deleteTowerPgMessageFromLocal).toHaveBeenCalledWith(store, message);
      expect(store.mainFeedMessages).toEqual([]);
      expect(await getMessageById('pg-message-missing')).toMatchObject({
        record_state: 'deleted',
        sync_status: 'synced',
      });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('deleteChatMessageById removes the accepted PG row when stale client id delete resolves to it', async () => {
    const workspaceDbKey = 'chat-message-manager-delete-stale-client-pg-message';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgMessageFromLocal.mockResolvedValue({
      record_id: 'server-message-1',
      channel_id: 'ch1',
      body: 'Duplicate sent in error',
      parent_message_id: null,
      record_state: 'deleted',
      sync_status: 'synced',
      version: 3,
      pg_backend: true,
      pg_client_record_id: 'local-message-1',
    });

    try {
      const staleMessage = {
        record_id: 'local-message-1',
        channel_id: 'ch1',
        body: 'Duplicate sent in error',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        version: 1,
        pg_backend: true,
      };
      const acceptedMessage = {
        record_id: 'server-message-1',
        channel_id: 'ch1',
        body: 'Duplicate sent in error',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        version: 2,
        pg_backend: true,
        pg_client_record_id: 'local-message-1',
      };
      await upsertMessage(staleMessage);
      await upsertMessage(acceptedMessage);
      const { fn, store } = bindMethod('deleteChatMessageById', {
        messages: [staleMessage, acceptedMessage],
      });

      await fn('local-message-1');

      expect(deleteTowerPgMessageFromLocal).toHaveBeenCalledWith(store, staleMessage);
      expect(store.mainFeedMessages).toEqual([]);
      expect(await getMessageById('server-message-1')).toMatchObject({
        record_state: 'deleted',
        sync_status: 'synced',
      });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('deleteChatThreadByParentId deletes PG threads through Tower and hides parent plus replies locally', async () => {
    const workspaceDbKey = 'chat-message-manager-delete-pg-thread';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgThreadFromLocal.mockResolvedValue({ id: 'thread-1' });

    try {
      const parent = {
        record_id: 'root-1',
        channel_id: 'ch1',
        body: 'Root',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        pg_backend: true,
        pg_thread_id: 'thread-1',
      };
      const reply = {
        record_id: 'reply-1',
        channel_id: 'ch1',
        body: 'Reply',
        parent_message_id: 'root-1',
        record_state: 'active',
        sync_status: 'synced',
        pg_backend: true,
        pg_thread_id: 'thread-1',
      };
      await upsertMessage(parent);
      await upsertMessage(reply);
      const { fn, store } = bindMethod('deleteChatThreadByParentId', {
        activeThreadId: 'root-1',
        messages: [parent, reply],
        closeThread: vi.fn(function closeThread() {
          this.activeThreadId = null;
        }),
      });

      await fn('root-1');

      expect(deleteTowerPgThreadFromLocal).toHaveBeenCalledWith(store, parent);
      expect(store.mainFeedMessages).toEqual([]);
      expect(store.threadMessages).toEqual([]);
      expect(await getMessageById('root-1')).toMatchObject({ record_state: 'deleted' });
      expect(await getMessageById('reply-1')).toMatchObject({ record_state: 'deleted' });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('archiveChatThreadByParentId archives and unarchives PG thread roots through Tower', async () => {
    const workspaceDbKey = 'chat-message-manager-archive-pg-thread';
    openWorkspaceDb(workspaceDbKey);
    await clearRuntimeData();
    isTowerPgBackendMode.mockReturnValue(true);
    archiveTowerPgThreadFromLocal
      .mockResolvedValueOnce({
        id: 'thread-1',
        record_state: 'archived',
        row_version: 2,
        updated_at: '2024-01-01T01:00:00Z',
        archived_at: '2024-01-01T01:00:00Z',
      })
      .mockResolvedValueOnce({
        id: 'thread-1',
        record_state: 'active',
        row_version: 3,
        updated_at: '2024-01-01T02:00:00Z',
        archived_at: null,
      });

    try {
      const parent = {
        record_id: 'root-1',
        channel_id: 'ch1',
        body: 'Root',
        parent_message_id: null,
        record_state: 'active',
        sync_status: 'synced',
        pg_backend: true,
        pg_thread_id: 'thread-1',
        version: 1,
      };
      await upsertMessage(parent);
      const { fn, store } = bindMethod('archiveChatThreadByParentId', {
        messages: [parent],
        scheduleChatPreviewMeasurement: vi.fn(),
        threadMenuOpen: true,
      });

      await fn('root-1', true);

      expect(archiveTowerPgThreadFromLocal).toHaveBeenCalledWith(store, parent, true);
      expect(store.chatThreadArchiveSubmittingId).toBe('');
      expect(store.chatThreadArchiveSubmittingAction).toBe('');
      expect(store.threadMenuOpen).toBe(false);
      expect(store.mainFeedMessages).toEqual([]);
      expect(await getMessageById('root-1')).toMatchObject({ record_state: 'archived', version: 2 });

      store.showArchivedChatThreads = true;
      await fn('root-1', false);

      expect(archiveTowerPgThreadFromLocal).toHaveBeenLastCalledWith(store, expect.objectContaining({ record_state: 'archived' }), false);
      expect(store.mainFeedMessages.map((message) => message.record_id)).toEqual(['root-1']);
      expect(await getMessageById('root-1')).toMatchObject({ record_state: 'active', version: 3 });
    } finally {
      await deleteWorkspaceDb(workspaceDbKey);
    }
  });

  it('archiveChatThreadByParentId catches PG archive failures and leaves the menu usable', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    archiveTowerPgThreadFromLocal.mockRejectedValue(new Error('Thread row_version is stale'));
    const parent = {
      record_id: 'root-1',
      channel_id: 'ch1',
      body: 'Root',
      parent_message_id: null,
      record_state: 'active',
      sync_status: 'synced',
      pg_backend: true,
      pg_thread_id: 'thread-1',
      version: 1,
    };
    const { fn, store } = bindMethod('archiveChatThreadByParentId', {
      messages: [parent],
      scheduleChatPreviewMeasurement: vi.fn(),
    });

    const result = await fn('root-1', true);

    expect(result).toBeNull();
    expect(store.error).toBe('Thread row_version is stale');
    expect(store.chatThreadArchiveSubmittingId).toBe('');
    expect(store.chatThreadArchiveSubmittingAction).toBe('');
    expect(store.mainFeedMessages.map((message) => message.record_id)).toEqual(['root-1']);
  });
});

function createDispatchReadyStore(overrides = {}) {
  return createStore({
    ...createChatThreadFlowDispatchState(),
    channels: [
      { record_id: 'channel-1', scope_id: 'scope-channel', title: 'General' },
    ],
    flows: [
      {
        record_id: 'flow-1',
        title: 'Flow One',
        scope_id: 'scope-flow',
        scope_l1_id: 'scope-flow',
        scope_policy_group_ids: ['policy:scope-flow'],
        group_ids: ['group:scope-flow'],
        record_state: 'active',
      },
      {
        record_id: 'flow-2',
        title: 'Flow Two',
        record_state: 'active',
      },
    ],
    chatThreadFlowDispatchSource: {
      channelId: 'channel-1',
      clickedMessageId: 'reply-1',
      threadRootMessageId: 'root-1',
      sourceSurface: 'thread_reply',
      dispatchedAt: '2026-04-21T13:28:21.377Z',
    },
    chatThreadFlowDispatchMessages: [
      {
        record_id: 'root-1',
        channel_id: 'channel-1',
        parent_message_id: null,
        body: 'Root message',
        sender_npub: 'npub1root',
        updated_at: '2026-04-21T13:28:21.377Z',
      },
      {
        record_id: 'reply-1',
        channel_id: 'channel-1',
        parent_message_id: 'root-1',
        body: 'Reply message',
        sender_npub: 'npub1reply',
        updated_at: '2026-04-21T13:30:21.377Z',
      },
    ],
    ...overrides,
  });
}

describe('chat thread flow dispatch modal state', () => {
  it('opens from the canonical message set and leaves the plain flow-start path untouched', async () => {
    const threadRoot = {
      record_id: 'root-1',
      channel_id: 'channel-1',
      parent_message_id: null,
      body: 'Root message',
      updated_at: '2026-04-21T10:00:00.000Z',
      record_state: 'active',
    };
    const earlierReply = {
      record_id: 'reply-1',
      channel_id: 'channel-1',
      parent_message_id: 'root-1',
      body: 'First reply',
      updated_at: '2026-04-21T10:01:00.000Z',
      record_state: 'active',
    };
    const clickedReply = {
      record_id: 'reply-2',
      channel_id: 'channel-1',
      parent_message_id: 'root-1',
      body: 'Clicked reply',
      updated_at: '2026-04-21T10:02:00.000Z',
      record_state: 'active',
    };

    const { fn, store } = bindMethod('openChatThreadFlowDispatch', {
      channels: [{ record_id: 'channel-1', scope_id: 'scope-channel', title: 'General' }],
      flows: [{ record_id: 'flow-1', title: 'Flow One', record_state: 'active' }],
      selectedChannelId: 'channel-1',
      mainFeedVisibleCount: 1,
      messageActionsMenuId: 'reply-2',
      showFlowStartConfirm: true,
      flowStartTarget: { record_id: 'existing-flow' },
      flowStartContext: 'keep-existing-start-context',
      messages: [
        threadRoot,
        earlierReply,
        clickedReply,
        {
          record_id: 'other-root',
          channel_id: 'channel-1',
          parent_message_id: null,
          body: 'Newest top-level message',
          updated_at: '2026-04-21T10:05:00.000Z',
          record_state: 'active',
        },
      ],
    });

    await fn('reply-2', 'thread_reply');

    expect(store.messageActionsMenuId).toBeNull();
    expect(store.showChatThreadFlowDispatchModal).toBe(true);
    expect(store.chatThreadFlowDispatchLoading).toBe(false);
    expect(store.chatThreadFlowDispatchSource).toEqual(expect.objectContaining({
      channelId: 'channel-1',
      clickedMessageId: 'reply-2',
      threadRootMessageId: 'root-1',
      sourceSurface: 'thread_reply',
    }));
    expect(store.chatThreadFlowDispatchMessages.map((message) => message.record_id)).toEqual([
      'root-1',
      'reply-1',
      'reply-2',
    ]);
    expect(store.chatThreadFlowDispatchSelectedFlowId).toBeNull();
    expect(store.chatThreadFlowDispatchManualScopeId).toBeNull();
    expect(store.chatThreadFlowDispatchResolvedScopeId).toBe('scope-channel');
    expect(store.chatThreadFlowDispatchScopeSource).toBe('channel');
    expect(store.chatThreadFlowDispatchResolvedScopeAssignment).toMatchObject({
      scope_id: 'scope-channel',
      write_group_ref: 'group:scope-channel',
    });
    expect(store.showFlowStartConfirm).toBe(true);
    expect(store.flowStartTarget).toEqual({ record_id: 'existing-flow' });
    expect(store.flowStartContext).toBe('keep-existing-start-context');
  });

  it('closeChatThreadFlowDispatch resets the full dispatch state block', () => {
    const store = createStore({
      showChatThreadFlowDispatchModal: true,
      chatThreadFlowDispatchOpenedAt: Date.now(),
      chatThreadFlowDispatchSource: { channelId: 'channel-1' },
      chatThreadFlowDispatchMessages: [{ record_id: 'root-1' }],
      chatThreadFlowDispatchSelectedFlowId: 'flow-1',
      chatThreadFlowDispatchManualScopeId: 'scope-override',
      chatThreadFlowDispatchResolvedScopeId: 'scope-override',
      chatThreadFlowDispatchResolvedScopeAssignment: { scope_id: 'scope-override' },
      chatThreadFlowDispatchScopeSource: 'override',
      chatThreadFlowDispatchLaunchNotes: 'Launch note',
      chatThreadFlowDispatchPreview: 'Preview text',
      chatThreadFlowDispatchDirty: true,
      chatThreadFlowDispatchPreviewStale: true,
      chatThreadFlowDispatchLoading: true,
      chatThreadFlowDispatchSubmitting: true,
      chatThreadFlowDispatchError: 'Failed',
    });

    store.closeChatThreadFlowDispatch();

    const expected = createChatThreadFlowDispatchState();
    for (const [key, value] of Object.entries(expected)) {
      expect(store[key]).toEqual(value);
    }
  });

  it('ignores backdrop close clicks for the opening gesture window', () => {
    const store = createStore({
      showChatThreadFlowDispatchModal: true,
      chatThreadFlowDispatchOpenedAt: Date.now(),
      chatThreadFlowDispatchSource: { channelId: 'channel-1' },
    });

    store.handleChatThreadFlowDispatchOverlayClick();

    expect(store.showChatThreadFlowDispatchModal).toBe(true);
    expect(store.chatThreadFlowDispatchSource).toEqual({ channelId: 'channel-1' });
  });

  it('allows backdrop close clicks after the opening gesture window passes', () => {
    const store = createStore({
      showChatThreadFlowDispatchModal: true,
      chatThreadFlowDispatchOpenedAt: Date.now() - 500,
      chatThreadFlowDispatchSource: { channelId: 'channel-1' },
    });

    store.handleChatThreadFlowDispatchOverlayClick();

    expect(store.showChatThreadFlowDispatchModal).toBe(false);
    expect(store.chatThreadFlowDispatchSource).toBeNull();
  });

  it('keeps thread resolution consistent across main-feed, thread-parent, and thread-reply entry points', async () => {
    const baseOverrides = {
      channels: [{ record_id: 'channel-1', scope_id: 'scope-channel', title: 'General' }],
      flows: [{ record_id: 'flow-1', title: 'Flow One', record_state: 'active' }],
      messages: [
        {
          record_id: 'root-1',
          channel_id: 'channel-1',
          parent_message_id: null,
          body: 'Root message',
          updated_at: '2026-04-21T10:00:00.000Z',
          record_state: 'active',
        },
        {
          record_id: 'reply-1',
          channel_id: 'channel-1',
          parent_message_id: 'root-1',
          body: 'Reply message',
          updated_at: '2026-04-21T10:02:00.000Z',
          record_state: 'active',
        },
      ],
    };

    const mainFeedStore = createStore(baseOverrides);
    const threadParentStore = createStore(baseOverrides);
    const threadReplyStore = createStore(baseOverrides);

    await mainFeedStore.openChatThreadFlowDispatch('root-1', 'main_feed');
    await threadParentStore.openChatThreadFlowDispatch('root-1', 'thread_parent');
    await threadReplyStore.openChatThreadFlowDispatch('reply-1', 'thread_reply');

    const expectedTranscript = ['root-1', 'reply-1'];

    expect(mainFeedStore.chatThreadFlowDispatchSource?.threadRootMessageId).toBe('root-1');
    expect(threadParentStore.chatThreadFlowDispatchSource?.threadRootMessageId).toBe('root-1');
    expect(threadReplyStore.chatThreadFlowDispatchSource?.threadRootMessageId).toBe('root-1');
    expect(mainFeedStore.chatThreadFlowDispatchMessages.map((message) => message.record_id)).toEqual(expectedTranscript);
    expect(threadParentStore.chatThreadFlowDispatchMessages.map((message) => message.record_id)).toEqual(expectedTranscript);
    expect(threadReplyStore.chatThreadFlowDispatchMessages.map((message) => message.record_id)).toEqual(expectedTranscript);
  });
});

describe('chat get it done modal state', () => {
  it('opens from a chat message with default scope and assignee', async () => {
    const { fn, store } = bindMethod('openChatGetItDone', {
      session: { npub: 'npub1me' },
      defaultAgentNpub: 'npub1agent',
      selectedChannelId: 'channel-1',
      channels: [{
        record_id: 'channel-1',
        scope_id: 'scope-channel',
        title: 'General',
        participant_npubs: ['npub1me', 'npub1agent'],
      }],
      messages: [{
        record_id: 'root-1',
        channel_id: 'channel-1',
        parent_message_id: null,
        body: 'Can you turn this into work?',
        sender_npub: 'npub1me',
        updated_at: '2026-05-05T10:00:00.000Z',
        record_state: 'active',
      }],
      threadMenuOpen: true,
    });

    await fn('root-1', 'main_feed');

    expect(store.showChatGetItDoneModal).toBe(true);
    expect(store.chatGetItDoneSource).toMatchObject({
      channelId: 'channel-1',
      clickedMessageId: 'root-1',
      threadRootMessageId: 'root-1',
      sourceSurface: 'main_feed',
    });
    expect(store.chatGetItDoneScopeId).toBe('scope-channel');
    expect(store.chatGetItDoneAssigneeNpub).toBe('npub1agent');
    expect(store.threadMenuOpen).toBe(false);
  });

  it('uses typeahead helpers for Get it done assignee and scope', async () => {
    const rememberPeople = vi.fn().mockResolvedValue(undefined);
    const scope = {
      record_id: 'scope-selected',
      title: 'Selected scope',
      level: 'project',
      breadcrumb: 'Product / Selected scope',
    };
    const store = createStore({
      chatGetItDoneAssigneeNpub: 'npub1agent',
      chatGetItDoneAssigneeQuery: 'pet',
      chatGetItDoneScopeId: 'scope-selected',
      chatGetItDoneScopeQuery: 'ops',
      rememberPeople,
      findPeopleSuggestions: vi.fn(() => [{
        npub: 'npub1operator-a',
        label: 'Operator A',
        subtitle: 'npub1operator-a',
        avatarUrl: null,
      }]),
      scopesMap: new Map([['scope-selected', scope]]),
      scopePickerFlatFor: vi.fn(() => [{
        record_id: 'scope-ops',
        title: 'Ops',
        level: 'project',
        breadcrumb: 'Product / Ops',
      }]),
    });

    expect(store.chatGetItDoneAssigneeSuggestions.map((person) => person.npub)).toContain('npub1operator-a');
    expect(store.chatGetItDoneScopeLabel).toBe('Scope scope-selected');
    expect(store.chatGetItDoneScopeSuggestions.map((item) => item.record_id)).toEqual(['scope-ops']);

    await store.selectChatGetItDoneAssignee('npub1operator-a');
    store.selectChatGetItDoneScope('scope-ops');

    expect(store.chatGetItDoneAssigneeNpub).toBe('npub1operator-a');
    expect(store.chatGetItDoneAssigneeQuery).toBe('');
    expect(store.showChatGetItDoneAssigneePicker).toBe(false);
    expect(rememberPeople).toHaveBeenCalledWith(['npub1operator-a'], 'task-assignee');
    expect(store.chatGetItDoneScopeId).toBe('scope-ops');
    expect(store.chatGetItDoneScopeQuery).toBe('');
    expect(store.showChatGetItDoneScopePicker).toBe(false);
  });

  it('creates a ready task with chat source and thread excerpt', async () => {
    const addTask = vi.fn(async () => ({ record_id: 'task-new' }));
    const navigateTo = vi.fn();
    const openTaskDetail = vi.fn();
    const syncRoute = vi.fn();
    const store = createStore({
      session: { npub: 'npub1me' },
      selectedBoardId: 'scope-channel',
      currentWorkspaceSlug: 'be-free',
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-channel', title: 'General' }],
      messages: [
        {
          record_id: 'root-1',
          channel_id: 'channel-1',
          parent_message_id: null,
          body: 'Please fix the broken button.',
          sender_npub: 'npub1me',
          updated_at: '2026-05-05T10:00:00.000Z',
          record_state: 'active',
        },
        {
          record_id: 'reply-1',
          channel_id: 'channel-1',
          parent_message_id: 'root-1',
          body: 'The Get it done menu item does not create a task.',
          sender_npub: 'npub1agent',
          updated_at: '2026-05-05T10:05:00.000Z',
          record_state: 'active',
        },
      ],
      addTask,
      navigateTo,
      openTaskDetail,
      syncRoute,
    });

    await store.openChatGetItDone('reply-1', 'thread_reply');
    store.chatGetItDoneTitle = 'Fix Get it done from chat';
    store.chatGetItDoneAssigneeNpub = 'npub1agent';

    const result = await store.submitChatGetItDone();

    expect(result).toEqual({ record_id: 'task-new' });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      state: 'ready',
      scopeId: 'scope-channel',
      assignedToNpub: 'npub1agent',
      sourceLinks: [{ type: 'chat', id: 'channel-1#root-1' }],
    }));
    const description = addTask.mock.calls[0][0].description;
    expect(description).toContain('Fix Get it done from chat');
    expect(description).toContain('/be-free/chat?scopeid=scope-channel&channelid=channel-1&threadid=root-1');
    expect(description).toContain('Name npub1agent: The Get it done menu item does not create a task.');
    expect(navigateTo).toHaveBeenCalledWith('tasks', { syncRoute: false });
    expect(openTaskDetail).toHaveBeenCalledWith('task-new');
    expect(syncRoute).toHaveBeenCalled();
  });

  it('creates an unscoped ready task when Get it done has no selected scope', async () => {
    const addTask = vi.fn(async () => ({ record_id: 'task-unscoped' }));
    const createDocument = vi.fn();
    const store = createStore({
      session: { npub: 'npub1me' },
      selectedBoardId: null,
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1', title: 'General' }],
      messages: [{
        record_id: 'root-1',
        channel_id: 'channel-1',
        parent_message_id: null,
        body: 'Please write this up.',
        sender_npub: 'npub1me',
        updated_at: '2026-05-05T10:00:00.000Z',
        record_state: 'active',
      }],
      addTask,
      createDocument,
      navigateTo: vi.fn(),
      openTaskDetail: vi.fn(),
    });

    await store.openChatGetItDone('root-1', 'main_feed');
    store.chatGetItDoneTitle = 'Write this up';
    store.chatGetItDoneOutputType = 'doc';

    const result = await store.submitChatGetItDone();

    expect(result).toEqual({ record_id: 'task-unscoped' });
    expect(createDocument).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      state: 'ready',
      scopeId: '__unscoped__',
      deliverableLinks: [],
    }));
  });
});

describe('chat thread flow dispatch preview lifecycle', () => {
  it('regenerates the preview when flow selection changes while the preview is not dirty', () => {
    const store = createDispatchReadyStore();

    store.chatThreadFlowDispatchSelectedFlowId = 'flow-1';
    store.handleChatThreadFlowDispatchInputsChanged();

    expect(store.chatThreadFlowDispatchPreview).toContain('selected_flow_id: flow-1');
    expect(store.chatThreadFlowDispatchPreview).toContain('selected_flow_title: Flow One');
    expect(store.chatThreadFlowDispatchDirty).toBe(false);
    expect(store.chatThreadFlowDispatchPreviewStale).toBe(false);
  });

  it('regenerates the preview when the manual scope override changes while the preview is not dirty', () => {
    const store = createDispatchReadyStore({
      chatThreadFlowDispatchSelectedFlowId: 'flow-1',
    });

    store.regenerateChatThreadFlowDispatchPreview();
    store.chatThreadFlowDispatchManualScopeId = 'scope-override';
    store.handleChatThreadFlowDispatchInputsChanged();

    expect(store.chatThreadFlowDispatchResolvedScopeId).toBe('scope-override');
    expect(store.chatThreadFlowDispatchScopeSource).toBe('override');
    expect(store.chatThreadFlowDispatchPreview).toContain('resolved_scope_id: scope-override');
  });

  it('regenerates the preview when launch notes change while the preview is not dirty', () => {
    const store = createDispatchReadyStore({
      chatThreadFlowDispatchSelectedFlowId: 'flow-1',
    });

    store.chatThreadFlowDispatchLaunchNotes = 'Use the current repo and preserve acceptance criteria.';
    store.handleChatThreadFlowDispatchInputsChanged();

    expect(store.chatThreadFlowDispatchPreview).toContain('Use the current repo and preserve acceptance criteria.');
  });

  it('marks the preview as dirty after a manual edit', () => {
    const store = createDispatchReadyStore({
      chatThreadFlowDispatchPreview: 'Manually edited preview',
    });

    store.markChatThreadFlowDispatchPreviewEdited();

    expect(store.chatThreadFlowDispatchDirty).toBe(true);
  });

  it('marks the preview stale instead of overwriting manual edits when dependencies change later', () => {
    const store = createDispatchReadyStore({
      chatThreadFlowDispatchSelectedFlowId: 'flow-1',
    });

    store.regenerateChatThreadFlowDispatchPreview();
    store.chatThreadFlowDispatchPreview = 'Manual operator preview';
    store.markChatThreadFlowDispatchPreviewEdited();
    store.chatThreadFlowDispatchLaunchNotes = 'Updated launch note';
    store.handleChatThreadFlowDispatchInputsChanged();

    expect(store.chatThreadFlowDispatchPreview).toBe('Manual operator preview');
    expect(store.chatThreadFlowDispatchPreviewStale).toBe(true);
  });

  it('explicit regenerate clears the stale marker and rebuilds the preview', () => {
    const store = createDispatchReadyStore({
      chatThreadFlowDispatchSelectedFlowId: 'flow-1',
    });

    store.regenerateChatThreadFlowDispatchPreview();
    store.chatThreadFlowDispatchPreview = 'Manual operator preview';
    store.markChatThreadFlowDispatchPreviewEdited();
    store.chatThreadFlowDispatchLaunchNotes = 'Updated launch note';
    store.handleChatThreadFlowDispatchInputsChanged();

    const regenerated = store.regenerateChatThreadFlowDispatchPreview();

    expect(regenerated).toContain('Updated launch note');
    expect(store.chatThreadFlowDispatchPreview).toContain('Updated launch note');
    expect(store.chatThreadFlowDispatchDirty).toBe(false);
    expect(store.chatThreadFlowDispatchPreviewStale).toBe(false);
  });
});

it('keeps the open optimistic thread and draft when canonical hydration replaces its root', async () => {
  const store = createStore({
    selectedChannelId: 'ch1', activeThreadId: 'local-root', threadInput: 'unsent reply',
    messages: [{ record_id: 'local-root', channel_id: 'ch1', parent_message_id: null, body: 'root', pg_backend: true, sync_status: 'pending' }],
  });
  await store.applyMessages([{ record_id: 'canonical-root', channel_id: 'ch1', parent_message_id: null, pg_client_record_id: 'local-root', pg_thread_id: 'canonical-thread', body: 'root', sync_status: 'synced' }], { scrollToLatest: false });
  expect(store.activeThreadId).toBe('canonical-root');
  expect(store.threadInput).toBe('unsent reply');
  expect(store.messages.map(row => row.record_id)).toEqual(['canonical-root']);
});

it.each([false, true])('replays the same command after a lost response and reload (reply=%s)', async (reply) => {
  const workspaceKey = `chat-lost-response-${reply}`;
  openWorkspaceDb(workspaceKey);
  await clearRuntimeData();
  isTowerPgBackendMode.mockReturnValue(true);
  const server = new Map();
  let loseResponse = true;
  createTowerPgMessageFromLocal.mockImplementation(async (_store, row, options) => {
    const request = { body: row.body, channel: row.channel_id, thread: options?.parentMessage?.pg_thread_id || null, attachments: row.attachments };
    const existing = server.get(row.pg_client_request_id);
    if (existing) expect(request).toEqual(existing.request);
    else server.set(row.pg_client_request_id, { request, id: `canonical-${server.size}` });
    if (loseResponse) { loseResponse = false; throw new Error('Response lost after server commit'); }
    return { ...row, record_id: server.get(row.pg_client_request_id).id, pg_record_type: 'message', pg_thread_id: request.thread || 'created-thread', sync_status: 'synced' };
  });
  const root = { record_id: 'root', channel_id: 'channel-1', pg_thread_id: 'original-thread', parent_message_id: null, body: 'Root', sync_status: 'synced' };
  const initial = createStore({ session: { npub: 'npub1viewer' }, channels: [{ record_id: 'channel-1' }], selectedChannelId: 'channel-1', messages: reply ? [root] : [], activeThreadId: reply ? 'root' : null, messageInput: 'Retry body', threadInput: 'Retry body' });
  try {
    await (reply ? initial.sendThreadReply() : initial.sendMessage());
    const failed = (await getMessagesByChannel('channel-1')).find(row => row.sync_status === 'failed');
    expect(failed).toBeTruthy();
    // Reloaded client; the open thread is deliberately different from the failed command.
    const reloaded = createStore({ session: { npub: 'npub1viewer' }, channels: [{ record_id: 'channel-1' }], selectedChannelId: 'channel-1', messages: [failed, { ...root, record_id: 'other-root', pg_thread_id: 'other-thread' }], activeThreadId: 'other-root' });
    expect(await reloaded.resendFailedMessage(failed.record_id)).toBe(true);
    expect(server.size).toBe(1);
    expect(await getMessageById(failed.record_id)).toBeUndefined();
    const accepted = (await getMessagesByChannel('channel-1')).filter(row => row.pg_record_type === 'message');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].pg_thread_id).toBe(reply ? 'original-thread' : 'created-thread');
  } finally { await deleteWorkspaceDb(workspaceKey); }
});

it('does not resurrect an optimistic row when a lost POST response fails after SSE acknowledged it', async () => {
  const { replaceMessageRecord } = await import('../src/db.js');
  const key = 'chat-late-failure';
  openWorkspaceDb(key); await clearRuntimeData();
  try {
    const optimistic = { record_id: 'optimistic', channel_id: 'channel', pg_backend: true, sync_status: 'pending', body: 'Sent' };
    await upsertMessage(optimistic);
    const s = createStore({ messages: [optimistic] });
    await replaceMessageRecord('optimistic', { ...optimistic, record_id: 'accepted', pg_record_type: 'message', pg_client_record_id: 'optimistic', sync_status: 'synced' });
    await s.setMessageSyncStatus('optimistic', 'failed');
    expect(await getMessageById('optimistic')).toBeUndefined();
    expect((await getMessageById('accepted')).sync_status).toBe('synced');
  } finally { await deleteWorkspaceDb(key); }
});
