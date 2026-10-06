import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import { renderMarkdownToHtml } from '../src/markdown.js';
import { openWorkspaceDb, deleteWorkspaceDb, upsertMessage } from '../src/db.js';

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

  it('refreshes a missing source-message target through workspace sync before opening', async () => {
    const deps = local(); deps.getMessageById.mockResolvedValueOnce(null).mockResolvedValueOnce(target);
    const s = store({ requestTowerSyncFamily: vi.fn().mockResolvedValue(null) });
    expect(await s.openLinkedThread('target-message', deps)).toBe(true);
    expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('workspace-bootstrap', '', { force: true });
    expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', 'target-message', expect.objectContaining({ towerThreadId: 'target-thread' }));
  });

  it('resolves uncached canonical thread IDs using their routing metadata', async () => {
    const deps = { ...local(), getTowerPgThread: vi.fn().mockResolvedValue({ thread: { id: 'target-thread', channel_id: 'other-channel', workspace_id: 'workspace' } }) };
    const s = store();
    expect(await s.openLinkedThread('target-thread', deps)).toBe(true);
    expect(s.openDeckThread).toHaveBeenCalledWith('other-channel', 'target-thread', expect.objectContaining({ towerThreadId: 'target-thread' }));
  });

  it('preserves explicit channel references and ordinary Chat navigation', async () => {
    const s = store({ navSection: 'chat' });
    expect(await s.openLinkedThread('other-channel#target-message', local())).toBe(true);
    expect(s.selectChannel).toHaveBeenCalledWith('other-channel', { syncRoute: false });
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
