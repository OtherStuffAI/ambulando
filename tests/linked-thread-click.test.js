import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { renderMarkdownToHtml } from '../src/markdown.js';
import { openWorkspaceDb, deleteWorkspaceDb, upsertMessage, getMessageById } from '../src/db.js';

vi.mock('../src/backend-mode.js', () => ({ isTowerPgBackendMode: () => true }));

function store(extra = {}) {
  return Object.assign(Object.create(chatMessageManagerMixin), {
    currentWorkspace: { workspaceId: 'workspace', directHttpsUrl: 'http://localhost:3100' },
    navSection: 'status', activeThreadId: 'source', selectedChannelId: 'original-channel',
    messages: [], fileMessages: [], mobileNavOpen: true,
    openDeckThread: vi.fn().mockResolvedValue(true),
    startWorkspaceLiveQueries: vi.fn(), syncRoute: vi.fn(), openThread: vi.fn(),
    selectChannel: vi.fn(async function (id) { this.selectedChannelId = id; this.activeThreadId = null; }),
    ...extra,
  });
}
const local = (row = null) => ({ getMessageById: vi.fn().mockResolvedValue(row) });
const target = { record_id: 'target-message', channel_id: 'other-channel', pg_thread_id: 'target-thread', scope_id: 'other-scope' };

describe('linked-thread click', () => {
  it('renders the reported bare message link as a clickable chat pill', () => {
    const html = renderMarkdownToHtml('@[Design: Unix-first Nostr signer — Amber for bots](mention:message:target-message)');
    expect(html).toContain('data-mention-type="chat"');
    expect(html).toContain('data-mention-id="target-message"');
  });

  it('opens a Dexie target outside the rendered channel/scope without changing Inbox context', async () => {
    const key = 'linked-thread-local'; openWorkspaceDb(key);
    try {
      await upsertMessage(target);
      const s = store();
      expect(await s.openLinkedThread('target-message')).toBe(true);
      expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', 'target-message', {
        towerThreadId: 'target-thread', captureReturnContext: false, scrollToLatest: false,
      });
      expect(s.navSection).toBe('status');
      expect(s.selectedChannelId).toBe('original-channel');
      expect(s.selectChannel).not.toHaveBeenCalled();
    } finally { await deleteWorkspaceDb(key); }
  });

  it('fails visibly for a cold bare message without a broad workspace bootstrap', async () => {
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(new Error('Thread not found')) };
    const s = store({ requestTowerSyncFamily: vi.fn() });
    expect(await s.openLinkedThread('cold-message', deps)).toBe(false);
    expect(s.requestTowerSyncFamily).not.toHaveBeenCalled();
    expect(s.linkedThreadOpenError).toContain('Thread not found');
    expect(s.activeThreadId).toBe('source');
    expect(s.openDeckThread).not.toHaveBeenCalled();
  });

  it('ignores a pending thread lookup when a newer non-thread reference is clicked', async () => {
    let finish, current = true;
    const deps = { getMessageById: () => new Promise(resolve => { finish = resolve; }), isCurrent: () => current };
    const s = store();
    const pending = s.openLinkedThread('target-message', deps);
    current = false;
    finish(target);
    expect(await pending).toBe(false);
    expect(s.openDeckThread).not.toHaveBeenCalled();
    expect(s.error).toBeUndefined();
  });

  it('checkpoints the source only after resolution and ignores navigation changed during departure', async () => {
    const s = store();
    const beforeOpen = vi.fn(async () => { s.navSection = 'docs'; });
    expect(await s.openLinkedThread('target-message', { ...local(target), beforeOpen })).toBe(false);
    expect(beforeOpen).toHaveBeenCalledOnce();
    expect(s.openDeckThread).not.toHaveBeenCalled();
    const rejected = store();
    const unavailable = { ...local({ ...target, record_state: 'deleted' }), beforeOpen: vi.fn() };
    expect(await rejected.openLinkedThread('target-message', unavailable)).toBe(false);
    expect(unavailable.beforeOpen).not.toHaveBeenCalled();
  });

  it('does not navigate when source draft preservation fails', async () => {
    const s = store();
    expect(await s.openLinkedThread('target-message', { ...local(target), beforeOpen: async () => false })).toBe(false);
    expect(s.openDeckThread).not.toHaveBeenCalled();
    expect(s.activeThreadId).toBe('source');
  });

  it('resolves uncached canonical thread IDs using their routing metadata', async () => {
    const deps = { ...local(), getTowerPgThread: vi.fn().mockResolvedValue({ thread: { id: 'target-thread', channel_id: 'other-channel', workspace_id: 'workspace' } }) };
    const s = store();
    expect(await s.openLinkedThread('target-thread', deps)).toBe(true);
    expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', 'target-thread', expect.objectContaining({ towerThreadId: 'target-thread' }));
  });

  it.each(['source', 'reply', 'threadless'])('loads a cold %s message narrowly and opens its semantic destination', async kind => {
    const thread = kind === 'threadless' ? null : { id: 'thread', workspace_id: 'workspace', channel_id: 'other-channel', source_message_id: 'source', title: 'Thread' };
    const id = kind === 'reply' ? 'reply' : 'source';
    const message = { id, workspace_id: 'workspace', channel_id: 'other-channel', thread_id: thread?.id || null,
      body: 'Target', created_by_actor_npub: 'npub-sender', thread_source_message_id: 'source' };
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 })),
      getTowerPgMessage: vi.fn().mockResolvedValue({ message, thread, channel_id: 'other-channel', thread_id: thread?.id || null }), upsertMessage: vi.fn() };
    const s = store({ requestTowerSyncFamily: vi.fn() });
    expect(await s.openLinkedThread(id, deps)).toBe(true);
    expect(deps.getTowerPgMessage).toHaveBeenCalledWith('workspace', id, expect.objectContaining({ baseUrl: 'http://localhost:3100' }));
    expect(deps.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ record_id: id, sender_npub: 'npub-sender' }));
    expect(s.focusMessageId).toBe(id);
    expect(s.requestTowerSyncFamily).not.toHaveBeenCalled();
    if (kind === 'threadless') { expect(s.openDeckThread).not.toHaveBeenCalled(); expect(s.selectChannel).toHaveBeenCalled(); expect(s.activeThreadId).toBeNull(); }
    else expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', kind === 'reply' ? 'thread' : 'source', expect.objectContaining({ towerThreadId: 'thread' }));
  });

  it('materializes a cold message and owning thread in the captured Dexie workspace', async () => {
    const key = 'linked-cold-native'; openWorkspaceDb(key);
    try {
      const thread = { id: 'native-thread', workspace_id: 'workspace', channel_id: 'native-channel', source_message_id: 'native-source', title: 'Native' };
      const message = { id: 'native-reply', workspace_id: 'workspace', channel_id: 'native-channel', thread_id: 'native-thread', body: 'Reply', created_by_actor_npub: 'npub-native' };
      const deps = { getTowerPgThread: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 })),
        getTowerPgMessage: vi.fn().mockResolvedValue({ message, thread, channel_id: 'native-channel', thread_id: 'native-thread' }) };
      const s = store(); expect(await s.openLinkedThread('native-reply', deps)).toBe(true);
      expect(await getMessageById('native-reply')).toEqual(expect.objectContaining({ body: 'Reply', pg_thread_id: 'native-thread', parent_message_id: 'native-source', sender_npub: 'npub-native' }));
      expect(await getMessageById('native-thread')).toEqual(expect.objectContaining({ pg_record_type: 'thread', pg_source_message_id: 'native-source' }));
      expect(s.openDeckThread).toHaveBeenCalledWith('native-channel', 'native-thread', expect.objectContaining({ towerThreadId: 'native-thread' }));
    } finally { await deleteWorkspaceDb(key); }
  });

  it('opens a cached reply in its owning thread and keeps reply focus', async () => {
    const s = store();
    expect(await s.openLinkedThread('reply', local({ ...target, record_id: 'reply', parent_message_id: 'source' }))).toBe(true);
    expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', 'target-thread', expect.objectContaining({ towerThreadId: 'target-thread' }));
    expect(s.focusMessageId).toBe('reply');
  });

  it('rejects an explicit channel link that disagrees with the cached message', async () => {
    const s = store();
    expect(await s.openLinkedThread('wrong-channel#target-message', local(target))).toBe(false);
    expect(s.error).toContain('referenced channel'); expect(s.openDeckThread).not.toHaveBeenCalled();
  });

  it('never falls back from rejected thread authorization to message lookup', async () => {
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 })), getTowerPgMessage: vi.fn() };
    const s = store(); expect(await s.openLinkedThread('target', deps)).toBe(false);
    expect(deps.getTowerPgMessage).not.toHaveBeenCalled(); expect(s.error).toContain('Forbidden');
  });

  it.each(['workspace', 'deleted', 'channel', 'thread'])('rejects invalid remote %s routing without materializing or opening', async invalid => {
    const message = { id: 'target', workspace_id: 'workspace', channel_id: 'channel', thread_id: 'thread' };
    const thread = { id: 'thread', workspace_id: 'workspace', channel_id: 'channel', source_message_id: 'target' };
    if (invalid === 'workspace') message.workspace_id = 'elsewhere';
    if (invalid === 'deleted') message.deleted_at = 'today';
    if (invalid === 'channel') thread.channel_id = 'different';
    if (invalid === 'thread') message.thread_id = 'different';
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 })),
      getTowerPgMessage: vi.fn().mockResolvedValue({ message, thread, channel_id: 'channel', thread_id: 'thread' }), upsertMessage: vi.fn() };
    const s = store(); expect(await s.openLinkedThread('target', deps)).toBe(false);
    expect(deps.upsertMessage).not.toHaveBeenCalled(); expect(s.openDeckThread).not.toHaveBeenCalled(); expect(s.error).toContain('unavailable');
  });

  it('ignores a message response after a newer reference visit without materializing it', async () => {
    let finish, current = true;
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 })),
      getTowerPgMessage: vi.fn(() => new Promise(resolve => { finish = resolve; })), upsertMessage: vi.fn(), isCurrent: () => current };
    const s = store(); const pending = s.openLinkedThread('target', deps);
    while (!finish) await Promise.resolve();
    current = false; finish({ message: { id: 'target' } });
    expect(await pending).toBe(false); expect(deps.upsertMessage).not.toHaveBeenCalled(); expect(s.openDeckThread).not.toHaveBeenCalled();
  });

  it('preserves explicit channel references and ordinary Chat navigation', async () => {
    const s = store({ navSection: 'chat' });
    expect(await s.openLinkedThread('other-channel#target-message', local())).toBe(true);
    expect(s.selectChannel).toHaveBeenCalledWith('other-channel', expect.objectContaining({ syncRoute: false, isCurrent: expect.any(Function) }));
    expect(s.openThread).toHaveBeenCalledWith('target-message', { scrollToLatest: false, syncRoute: false });
    expect(s.syncRoute).toHaveBeenCalledOnce();
  });

  it('reports unavailable targets without closing the source modal', async () => {
    const deps = { ...local(), getTowerPgThread: vi.fn().mockRejectedValue(new Error('Thread not found')) };
    const s = store();
    expect(await s.openLinkedThread('missing', deps)).toBe(false);
    expect(s.error).toContain('Could not open linked thread: Thread not found');
    expect(s.activeThreadId).toBe('source'); expect(s.openDeckThread).not.toHaveBeenCalled();
  });

  it('shows a channel-loading failure from a link opened outside Chat', async () => {
    const s = store({ navSection: 'docs', selectChannel: vi.fn().mockRejectedValue(new Error('Channel unavailable')) });
    expect(await s.openLinkedThread('other-channel#target-message', local())).toBe(false);
    expect(s.error).toContain('Channel unavailable');
    expect(s.openThread).not.toHaveBeenCalled();
  });

  it.each([
    { deleted_at: 'today' }, { pg_workspace_id: 'foreign-workspace' }, { can_read: false },
  ])('rejects an unavailable cached target before departure: %j', async patch => {
    const s = store(), beforeOpen = vi.fn();
    expect(await s.openLinkedThread('target-message', { ...local({ ...target, ...patch }), beforeOpen })).toBe(false);
    expect(beforeOpen).not.toHaveBeenCalled(); expect(s.openDeckThread).not.toHaveBeenCalled(); expect(s.error).toContain('unavailable');
  });

  it.each(['docOpenGeneration', 'taskDetailOpenGeneration'])('passes channel selection a guard for delayed %s changes', async field => {
    let finish, callerGuard;
    const s = store({ navSection: 'chat', [field]: 1, selectChannel: vi.fn(async function(id, options) {
      callerGuard = options.isCurrent; this.selectedChannelId = id;
      await new Promise(resolve => { finish = resolve; });
    }) });
    const pending = s.openLinkedThread('other-channel#target-message', local());
    while (!finish) await Promise.resolve();
    s[field] = 2;
    expect(callerGuard()).toBe(false);
    finish(); expect(await pending).toBe(false); expect(s.openThread).not.toHaveBeenCalled();
  });

  it('closes the source Deck thread context before opening a threadless channel target', async () => {
    const s = store({ deckThreadChannelId: 'source-channel', closeDeckThread: vi.fn(function() { this.deckThreadChannelId = null; this.activeThreadId = null; }) });
    const row = { ...target, pg_backend: true, pg_thread_id: null };
    expect(await s.openLinkedThread('target-message', local(row))).toBe(true);
    expect(s.closeDeckThread).toHaveBeenCalledWith({ syncRoute: false, fromRoute: true });
    expect(s.navSection).toBe('chat'); expect(s.activeThreadId).toBeNull(); expect(s.focusMessageId).toBe('target-message');
  });

  it('does not open a deleted local target', async () => {
    const s = store();
    expect(await s.openLinkedThread('target-message', local({ ...target, record_state: 'deleted' }))).toBe(false);
    expect(s.error).toContain('unavailable'); expect(s.openDeckThread).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'modal', 'channel', 'section', 'modal-return'])('ignores a delayed lookup after changing %s', async change => {
    let finish;
    const deps = { getMessageById: vi.fn(() => new Promise(resolve => { finish = resolve; })) };
    const s = store(); const opening = s.openLinkedThread('target-message', deps);
    if (change === 'workspace') s._workspaceSelectionGeneration = 1;
    if (change === 'modal') s.activeThreadId = null;
    if (change === 'modal-return') s.threadHistoryGeneration = 2;
    if (change === 'channel') s.selectedChannelId = 'new-channel';
    if (change === 'section') s.navSection = 'tasks';
    finish(target); expect(await opening).toBe(false);
    expect(s.openDeckThread).not.toHaveBeenCalled(); expect(s.error).toBeUndefined();
  });

  it('lets only the latest overlapping link lookup open a thread', async () => {
    let finish;
    const s = store();
    const first = s.openLinkedThread('first', { getMessageById: () => new Promise(resolve => { finish = resolve; }) });
    expect(await s.openLinkedThread('target-message', local(target))).toBe(true);
    finish({ ...target, record_id: 'first' }); expect(await first).toBe(false);
    expect(s.openDeckThread).toHaveBeenCalledOnce();
  });
});
