import { describe, expect, it, vi } from 'vitest';

vi.mock('alpinejs', () => ({
  default: { nextTick: (fn) => fn?.() },
}));

vi.mock('../src/db.js', () => ({
  getMessagesByChannel: vi.fn(async () => []),
  getMessageById: vi.fn(async () => null),
  upsertMessage: vi.fn(async () => {}),
  upsertChannel: vi.fn(async () => {}),
  addPendingWrite: vi.fn(async () => {}),
  deleteChannelRuntimeState: vi.fn(async () => ({ deletedChannels: 1, deletedMessages: 0, deletedPendingWrites: 0 })),
}));

vi.mock('../src/api.js', () => ({
  fetchRecordHistory: vi.fn(async () => ({ versions: [] })),
  deleteTowerPgChannel: vi.fn(async () => ({})),
}));

vi.mock('../src/crypto/group-keys.js', () => ({
  hasGroupKey: vi.fn(() => true),
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: vi.fn(() => false),
}));

vi.mock('../src/translators/chat.js', () => ({
  outboundChatMessage: vi.fn(async (payload) => ({ ...payload, record_family_hash: 'mock:chat_message' })),
  outboundChannel: vi.fn(async (payload) => ({ ...payload, record_family_hash: 'mock:channel' })),
  recordFamilyHash: (family) => `mock:${family}`,
}));

import { fetchRecordHistory } from '../src/api.js';
import { deleteTowerPgChannel } from '../src/api.js';
import { addPendingWrite, deleteChannelRuntimeState, upsertChannel } from '../src/db.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { outboundChannel } from '../src/translators/chat.js';
import { isTowerPgBackendMode } from '../src/backend-mode.js';

function createStore(overrides = {}) {
  const store = {
    canManageChannel: vi.fn(() => true),
    channels: [],
    messages: [],
    selectedChannelId: null,
    activeThreadId: null,
    threadInput: '',
    expandedChatMessageIds: [],
    truncatedChatMessageIds: [],
    focusMessageId: null,
    threadSize: 'default',
    threadVisibleReplyCount: 6,
    mainFeedVisibleCount: 80,
    pendingChatScrollToLatest: false,
    pendingThreadScrollToLatest: false,
    messageImageUploadCount: 0,
    threadImageUploadCount: 0,
    chatFeedScrollFrame: null,
    threadRepliesScrollFrame: null,
    chatPreviewMeasureFrame: null,
    showChannelSettingsModal: true,
    channelDeleteConfirmArmed: false,
    channelDeleteSubmitting: false,
    channelSettingsChannelId: '',
    channelSettingsWorkspaceId: '',
    channelSettingsError: '',
    error: null,
    session: { npub: 'npub1viewer' },
    signingNpub: 'npub1viewer',
    backendUrl: 'https://tower.example.test',
    workspaceOwnerNpub: 'npub1owner',
    THREAD_REPLY_PAGE_SIZE: 6,
    MAIN_FEED_PAGE_SIZE: 80,
    captureScrollAnchor: vi.fn().mockReturnValue(null),
    restoreScrollAnchor: vi.fn(),
    scheduleChatFeedScrollToBottom: vi.fn(),
    scheduleThreadRepliesScrollToBottom: vi.fn(),
    scheduleChatPreviewMeasurement: vi.fn(),
    scheduleStorageImageHydration: vi.fn(),
    syncRoute: vi.fn(),
    refreshMessages: vi.fn().mockResolvedValue(undefined),
    refreshChannels: vi.fn().mockImplementation(async function refreshChannels() {
      return this.channels;
    }),
    flushAndBackgroundSync: vi.fn().mockResolvedValue({ pushed: 1 }),
    getPreferredChannelWriteGroup: vi.fn().mockReturnValue('group-1'),
    getChannelLabel: vi.fn((channel) => channel?.title || 'Untitled channel'),
    ...overrides,
  };

  const descriptors = Object.getOwnPropertyDescriptors(chatMessageManagerMixin);
  for (const [key, desc] of Object.entries(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    Object.defineProperty(store, key, desc);
  }

  return store;
}

function bindDeleteSelectedChannel(overrides = {}) {
  const store = createStore(overrides);
  return {
    store,
    fn: store.deleteSelectedChannel.bind(store),
  };
}

describe('deleteSelectedChannel', () => {
  it('blocks unauthorized PG deletion before arming or writing', async () => {
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgChannel.mockClear();
    const store = createStore({ channels: [{ record_id: 'ch-1' }], selectedChannelId: 'ch-1', canManageChannel: () => false });
    await store.deleteSelectedChannel();
    expect(store.channelDeleteConfirmArmed).toBe(false);
    expect(store.channelSettingsError).toContain('Manage access');
    expect(deleteTowerPgChannel).not.toHaveBeenCalled();
    isTowerPgBackendMode.mockReturnValue(false);
  });

  it('arms delete confirmation on the first click', async () => {
    vi.clearAllMocks();
    const { fn, store } = bindDeleteSelectedChannel({
      channels: [
        { record_id: 'ch-1', owner_npub: 'npub1owner', title: 'Example Workspace', version: 1, group_ids: ['group-1'] },
      ],
      selectedChannelId: 'ch-1',
    });

    await fn();

    expect(store.channelDeleteConfirmArmed).toBe(true);
    expect(fetchRecordHistory).not.toHaveBeenCalled();
    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
    expect(upsertChannel).not.toHaveBeenCalled();
  });

  it('hard-deletes local-only channels without queueing a Tower tombstone', async () => {
    vi.clearAllMocks();
    fetchRecordHistory.mockResolvedValueOnce({ versions: [] });
    const { fn, store } = bindDeleteSelectedChannel({
      channels: [
        { record_id: 'ch-1', owner_npub: 'npub1owner', title: 'Example Workspace', version: 1, group_ids: ['group-1'] },
        { record_id: 'ch-2', owner_npub: 'npub1owner', title: 'General', version: 1, group_ids: ['group-1'] },
      ],
      channelDeleteConfirmArmed: true,
      selectedChannelId: 'ch-1',
      refreshChannels: vi.fn().mockImplementation(async function refreshChannels() {
        this.channels = this.channels.filter((channel) => channel.record_id !== 'ch-1');
        return this.channels;
      }),
    });

    await fn();

    expect(fetchRecordHistory).toHaveBeenCalledWith({
      record_id: 'ch-1',
      owner_npub: 'npub1owner',
      viewer_npub: 'npub1viewer',
    });
    expect(deleteChannelRuntimeState).toHaveBeenCalledWith('ch-1');
    expect(upsertChannel).not.toHaveBeenCalled();
    expect(outboundChannel).not.toHaveBeenCalled();
    expect(addPendingWrite).not.toHaveBeenCalled();
    expect(store.flushAndBackgroundSync).not.toHaveBeenCalled();
    expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch-2']);
    expect(store.selectedChannelId).toBe('ch-2');
    expect(store.showChannelSettingsModal).toBe(false);
    expect(store.channelDeleteConfirmArmed).toBe(false);
    expect(store.error).toBeNull();
  });

  it('queues a delete tombstone when the channel already exists on Tower', async () => {
    vi.clearAllMocks();
    fetchRecordHistory.mockResolvedValueOnce({
      versions: [
        { version: 1, updated_at: '2026-04-01T10:00:00.000Z' },
        { version: 2, updated_at: '2026-04-02T10:00:00.000Z' },
      ],
    });
    const { fn, store } = bindDeleteSelectedChannel({
      channels: [
        { record_id: 'ch-1', owner_npub: 'npub1owner', title: 'Example Workspace', version: 1, group_ids: ['group-1'], participant_npubs: ['npub1viewer'] },
      ],
      channelDeleteConfirmArmed: true,
      selectedChannelId: 'ch-1',
      refreshChannels: vi.fn().mockImplementation(async function refreshChannels() {
        this.channels = [];
        return this.channels;
      }),
    });

    await fn();

    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
    expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'ch-1',
      record_state: 'deleted',
      version: 3,
    }));
    expect(outboundChannel).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'ch-1',
      owner_npub: 'npub1owner',
      version: 3,
      previous_version: 2,
      record_state: 'deleted',
    }));
    expect(addPendingWrite).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'ch-1',
      record_family_hash: 'mock:channel',
      envelope: expect.objectContaining({
        record_id: 'ch-1',
        version: 3,
        previous_version: 2,
      }),
    }));
    expect(store.flushAndBackgroundSync).toHaveBeenCalledTimes(1);
    expect(store.channels).toEqual([]);
    expect(store.selectedChannelId).toBeNull();
    expect(store.showChannelSettingsModal).toBe(false);
    expect(store.channelDeleteConfirmArmed).toBe(false);
    expect(store.error).toBeNull();
  });

  it('deletes the channel captured by settings in the captured current workspace', async () => {
    vi.clearAllMocks();
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindDeleteSelectedChannel({
      currentWorkspace: { workspaceId: 'ws-current', directHttpsUrl: 'https://tower.example.test', appNpub: 'npub1app' },
      channels: [
        { record_id: 'ch-settings', pg_workspace_id: 'ws-current', title: 'Settings channel' },
        { record_id: 'ch-selected-later', pg_workspace_id: 'ws-current', title: 'Other channel' },
      ],
      selectedChannelId: 'ch-selected-later',
      channelSettingsChannelId: 'ch-settings',
      channelSettingsWorkspaceId: 'ws-current',
      channelDeleteConfirmArmed: true,
    });

    await fn();

    expect(deleteTowerPgChannel).toHaveBeenCalledWith('ws-current', 'ch-settings', {
      baseUrl: 'https://tower.example.test',
      appNpub: 'npub1app',
    });
    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
    // Dexie liveQuery updates collections; the command never purges content or pending writes.
    expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch-settings', 'ch-selected-later']);
    expect(store.showChannelSettingsModal).toBe(false);
    expect(store.channelDeleteConfirmArmed).toBe(false);
    expect(store.channelSettingsChannelId).toBe('');
    expect(store.channelDeleteSubmitting).toBe(false);
  });

  it('keeps confirmation retryable and visible when Tower rejects the delete', async () => {
    vi.clearAllMocks();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgChannel.mockRejectedValueOnce(new Error('Channel was not found in this workspace.'));
    const { fn, store } = bindDeleteSelectedChannel({
      currentWorkspace: { workspaceId: 'ws-current', directHttpsUrl: 'https://tower.example.test', appNpub: 'npub1app' },
      channels: [{ record_id: 'ch-1', pg_workspace_id: 'ws-current', title: 'Channel' }],
      selectedChannelId: 'ch-1',
      channelSettingsChannelId: 'ch-1',
      channelSettingsWorkspaceId: 'ws-current',
      channelDeleteConfirmArmed: true,
    });

    await fn();

    expect(store.showChannelSettingsModal).toBe(true);
    expect(store.channelDeleteConfirmArmed).toBe(true);
    expect(store.channelDeleteSubmitting).toBe(false);
    expect(store.channelSettingsError).toBe('Channel was not found in this workspace.');
    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
  });

  it('keeps a NIP-98 401 visible and retryable without local cleanup', async () => {
    vi.clearAllMocks();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgChannel.mockRejectedValueOnce(new Error(
      'Tower PG API 401 DELETE https://tower.example.com/api/v4/flightdeck-pg/workspaces/ws-current/channels/ch-1: {"error":"nip98 auth required"}',
    ));
    const { fn, store } = bindDeleteSelectedChannel({
      currentWorkspace: { workspaceId: 'ws-current', directHttpsUrl: 'https://tower.example.com', appNpub: 'npub1app' },
      channels: [{ record_id: 'ch-1', pg_workspace_id: 'ws-current', title: 'Channel' }],
      selectedChannelId: 'ch-1',
      channelSettingsChannelId: 'ch-1',
      channelSettingsWorkspaceId: 'ws-current',
      channelDeleteConfirmArmed: true,
    });

    await fn();

    expect(store.showChannelSettingsModal).toBe(true);
    expect(store.channelDeleteConfirmArmed).toBe(true);
    expect(store.channelDeleteSubmitting).toBe(false);
    expect(store.channelSettingsError).toContain('nip98 auth required');
    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
  });

  it('clears an already-archived stale local channel after Tower returns resource-not-found', async () => {
    vi.clearAllMocks();
    isTowerPgBackendMode.mockReturnValue(true);
    deleteTowerPgChannel.mockRejectedValueOnce(new Error(
      'Tower PG API 400 DELETE: {"error":"Flight Deck PG authorization request is invalid","code":"resource-not-found","required_permission":"channel.manage"}',
    ));
    const { fn, store } = bindDeleteSelectedChannel({
      currentWorkspace: { workspaceId: 'ws-current', directHttpsUrl: 'https://tower.example.test', appNpub: 'npub1app' },
      channels: [
        { record_id: 'ch-archived', pg_workspace_id: 'ws-current', title: 'Archived channel' },
        { record_id: 'ch-next', pg_workspace_id: 'ws-current', title: 'Next channel' },
      ],
      selectedChannelId: 'ch-archived',
      channelSettingsChannelId: 'ch-archived',
      channelSettingsWorkspaceId: 'ws-current',
      channelDeleteConfirmArmed: true,
      refreshChannels: vi.fn().mockImplementation(async function refreshChannels() {
        this.channels = this.channels.filter((channel) => channel.record_id !== 'ch-archived');
        return this.channels;
      }),
    });

    await fn();

    expect(store.refreshChannels).toHaveBeenCalledTimes(1);
    expect(deleteChannelRuntimeState).not.toHaveBeenCalled();
    expect(store.channels.map((channel) => channel.record_id)).toEqual(['ch-next']);
    expect(store.showChannelSettingsModal).toBe(false);
    expect(store.channelDeleteConfirmArmed).toBe(false);
    expect(store.channelSettingsError).toBe('');
  });

  it('refuses to delete a stale channel record from another workspace', async () => {
    vi.clearAllMocks();
    isTowerPgBackendMode.mockReturnValue(true);
    const { fn, store } = bindDeleteSelectedChannel({
      currentWorkspace: { workspaceId: 'ws-current', directHttpsUrl: 'https://tower.example.test', appNpub: 'npub1app' },
      channels: [{ record_id: 'ch-stale', pg_workspace_id: 'ws-other', title: 'Stale channel' }],
      selectedChannelId: 'ch-stale',
      channelSettingsChannelId: 'ch-stale',
      channelSettingsWorkspaceId: 'ws-current',
      channelDeleteConfirmArmed: true,
    });

    await fn();

    expect(deleteTowerPgChannel).not.toHaveBeenCalled();
    expect(store.channelSettingsError).toContain('different workspace');
    expect(store.showChannelSettingsModal).toBe(true);
    expect(store.channelDeleteConfirmArmed).toBe(true);
  });
});
