import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatThreadMentionCandidates } from '../src/chat-thread-mentions.js';
import { renderMarkdownToHtml } from '../src/markdown.js';

const { alpineStoreMock } = vi.hoisted(() => ({ alpineStoreMock: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: alpineStoreMock, start: vi.fn() } }));
beforeEach(() => alpineStoreMock.mockClear());

async function createStore() {
  vi.resetModules();
  const { initApp } = await import('../src/app.js');
  initApp();
  return alpineStoreMock.mock.calls.find(([name]) => name === 'chat')[1];
}

describe('chat thread mention candidates', () => {
  it('uses one canonical channel-qualified entry per thread with a clean label', () => {
    const rows = [
      { record_id: 'thread-1', channel_id: 'chan-a', pg_record_type: 'thread', pg_source_message_id: 'msg-1', title: 'Launch [plan] (v2)\nnotes', updated_at: '2026-10-27T03:00:00Z' },
      { record_id: 'msg-1', channel_id: 'chan-a', pg_record_type: 'message', pg_thread_id: 'thread-1', body: 'Root body', updated_at: '2026-10-27T02:00:00Z' },
      { record_id: 'reply-1', channel_id: 'chan-a', parent_message_id: 'msg-1', body: 'A reply' },
      { record_id: 'thread-2', channel_id: 'chan-b', pg_record_type: 'thread', title: 'Orphan thread record' },
      { record_id: 'msg-3', channel_id: 'chan-b', body: 'See ![shot](storage://abc) and @[Helper](mention:agent:npub1helper) **now**' },
      { record_id: 'msg-4', channel_id: 'chan-b', body: 'Archived', record_state: 'archived' },
      { record_id: 'msg-5', channel_id: 'chan-b', body: 'Deleted', record_state: 'deleted' },
    ];
    const candidates = chatThreadMentionCandidates(rows, { channelLabel: (id) => (id === 'chan-a' ? '#Ambulando' : '') });
    expect(candidates).toEqual([
      expect.objectContaining({ type: 'chat', id: 'chan-a#msg-1', label: 'Launch plan v2 notes', sublabel: 'Chat thread · Ambulando' }),
      expect.objectContaining({ type: 'chat', id: 'chan-b#thread-2', label: 'Orphan thread record', sublabel: 'Chat thread' }),
      expect.objectContaining({ type: 'chat', id: 'chan-b#msg-3', label: 'See and Helper now' }),
    ]);
  });

  it('truncates long labels so inserted markup stays readable', () => {
    const [candidate] = chatThreadMentionCandidates([{ record_id: 'm', channel_id: 'c', body: 'word '.repeat(60) }]);
    expect(candidate.label.length).toBeLessThanOrEqual(80);
    expect(candidate.label.endsWith('…')).toBe(true);
  });

  it('renders the inserted markup as a navigable chat pill', () => {
    const html = renderMarkdownToHtml('See @[Launch plan](mention:chat:chan-a#msg-1)');
    expect(html).toContain('data-mention-type="chat"');
    expect(html).toContain('data-mention-id="chan-a#msg-1"');
  });
});

describe('@ lookahead chat threads', () => {
  it('filters cached threads by name, honours the thread: prefix and keeps chat: for channels', async () => {
    const store = await createStore();
    store.channels = [{ record_id: 'chan-a', title: 'Ambulando', record_state: 'active' }];
    store.getChannelLabel = (channel) => channel.title;
    store.mentionThreadIndex = [
      { record_id: 'msg-1', channel_id: 'chan-a', title: 'Overnight feedback' },
      { record_id: 'msg-2', channel_id: 'chan-a', title: 'Release notes' },
    ];

    expect(store.searchMentions('overnight')).toEqual([
      expect.objectContaining({ type: 'chat', id: 'chan-a#msg-1', label: 'Overnight feedback', sublabel: 'Chat thread · Ambulando' }),
    ]);
    expect(store.searchMentions('thread:').map((result) => result.id)).toEqual(['chan-a#msg-1', 'chan-a#msg-2']);
    expect(store.searchMentions('chat:amb')).toEqual([expect.objectContaining({ type: 'channel', id: 'chan-a' })]);
  });

  it('loads cached roots from Dexie for the current workspace only', async () => {
    const store = await createStore();
    const { clearRuntimeData, deleteWorkspaceDb, openWorkspaceDb, upsertMessage } = await import('../src/db.js');
    const workspaceKey = 'mention-thread-index';
    openWorkspaceDb(workspaceKey);
    await clearRuntimeData();
    try {
      await upsertMessage({ record_id: 'root-1', channel_id: 'chan-a', body: 'Canvas windows', record_state: 'active', updated_at: '2026-10-27T01:00:00Z' });
      await upsertMessage({ record_id: 'reply-1', channel_id: 'chan-a', parent_message_id: 'root-1', body: 'Canvas reply', record_state: 'active', updated_at: '2026-10-27T02:00:00Z' });
      store.selectedWorkspaceKey = workspaceKey;
      const rows = await store.refreshMentionThreadIndex();
      expect(rows.map((row) => row.record_id)).toEqual(['root-1']);
      expect(store.searchMentions('canvas').map((result) => result.id)).toEqual(['chan-a#root-1']);

      store.selectedWorkspaceKey = 'other-workspace';
      store.refreshMentionThreadIndex();
      expect(store.mentionThreadIndex).toEqual([]);
    } finally {
      await deleteWorkspaceDb(workspaceKey);
    }
  });
});
