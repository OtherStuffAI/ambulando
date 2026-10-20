import { describe, expect, it, vi } from 'vitest';
import { applyPgNavigationProjection } from '../src/section-live-queries.js';
import { computeBoardScopedTasks } from '../src/task-board-state.js';

function client() {
  const drafts = new Map();
  const s = {
    currentWorkspaceKey: 'workspace', _workspaceSelectionGeneration: 1, navSection: 'chat',
    pgNavigationWorkspaceKey: 'workspace', pgNavigationGeneration: 1,
    selectedBoardId: 'scope', selectedChannelId: 'channel', activeThreadId: 'root',
    messages: [{ record_id: 'root', content: 'private body' }], messageInput: 'unsent message', threadInput: 'unsent reply',
    chatPresentationCache: new Map([['channel', { messages: ['private body'] }]]),
    saveChatComposerDraft(kind) { drafts.set(kind, kind === 'message' ? this.messageInput : this.threadInput); },
    restoreChatComposerDraft(kind) { this.messageInput = drafts.get(kind); },
    closeThread: vi.fn(), stopSelectedChannelLiveQuery: vi.fn(),
    async applyScopes(rows) { this.scopes = rows; },
    async applyChannels(rows, options) { this.channels = rows; if (!options?.preserveNavigation && !rows.some(r => r.record_id === this.selectedChannelId)) this.selectedChannelId = rows[0]?.record_id || null; },
    validateSelectedBoardId() { if (!this.scopes.some(r => r.record_id === this.selectedBoardId)) this.selectedBoardId = 'all'; },
    async selectChannel(id, options) { if (options.isCurrent()) { this.selectedChannelId = id; this.messages = [{ record_id: 'root' }]; } },
    openThread: vi.fn(), drafts,
  };
  return s;
}
const page = (pending, scopes = [scope], channels = [channel], generation = 2) => ({ pending, generation, scopes, channels });
const scope = { record_id: 'scope' };
const channel = { record_id: 'channel' };

describe('authority recovery navigation', () => {
  it('keeps selection and drafts through same-identity checkpoint repair', async () => {
    const s = client();
    await applyPgNavigationProjection(s, page(true));
    expect(s.selectedChannelId).toBe('channel'); expect(s.activeThreadId).toBe('root');
    expect(s.messageInput).toBe('unsent message'); expect(s.threadInput).toBe('unsent reply');
    expect(s.chatPresentationCache.size).toBe(1);
    for (let i = 0; i < 5; i++) await applyPgNavigationProjection(s, page(true, [scope], [channel]));
    await applyPgNavigationProjection(s, page(false, [scope], [channel]));
    expect(s.selectedChannelId).toBe('channel'); expect(s.messageInput).toBe('unsent message');
    expect(s.openThread).not.toHaveBeenCalled(); expect(s.closeThread).not.toHaveBeenCalled();
  });
  it('retains saved intent when another reset interrupts an incomplete replacement', async () => {
    const s = client();
    await applyPgNavigationProjection(s, page(true));
    await applyPgNavigationProjection(s, page(true, [scope], [channel], 3));
    await applyPgNavigationProjection(s, page(false, [scope], [channel], 3));
    expect(s.selectedChannelId).toBe('channel');
    expect(s.messageInput).toBe('unsent message');
    expect(s.threadInput).toBe('unsent reply');
  });
  it('does not restore revoked destinations or render drafts and accepts newly granted channels', async () => {
    const s = client(); await applyPgNavigationProjection(s, page(true));
    await applyPgNavigationProjection(s, page(false, [], [{ record_id: 'new-grant' }]));
    expect(s.selectedBoardId).toBe('all'); expect(s.selectedChannelId).toBe('new-grant');
    expect(s.messages).toEqual([]); expect(s.messageInput).toBe(''); expect(s.openThread).not.toHaveBeenCalled();
    expect(s.drafts.get('thread')).toBe('unsent reply');
  });
  it('recovers an already interrupted client without authorizing partial navigation', async () => {
    const s = client(); s.pgNavigationGeneration = null;
    await applyPgNavigationProjection(s, page(true, [scope]));
    await applyPgNavigationProjection(s, page(false, [scope], [channel]));
    expect(s.selectedChannelId).toBe('channel');
  });
  it('fences async projection delivery across same-workspace reactivation', async () => {
    const s = client(); let release;
    s.applyScopes = () => new Promise(resolve => { release = resolve; }); s.applyChannels = vi.fn();
    const delivery = applyPgNavigationProjection(s, page(false, [scope], [channel], 1));
    s._workspaceSelectionGeneration++; release(); await delivery;
    expect(s.applyChannels).not.toHaveBeenCalled();
  });
  it('ordinary catchup leaves the settled selection and unsent composer intact', async () => {
    const s = client();
    await applyPgNavigationProjection(s, page(false, [scope], [channel], 1));
    expect(s.selectedChannelId).toBe('channel');
    expect(s.messageInput).toBe('unsent message');
    expect(s.chatPresentationCache.size).toBe(1);
  });
  it('definitive channel omission clears content before asynchronous navigation work', async () => {
    const s = client(); s.navSection = 'chat'; s.scopes = [scope]; let release;
    s.applyScopes = () => new Promise(resolve => { release = resolve; });
    const delivery = applyPgNavigationProjection(s, page(false, [scope], [], 1));
    expect(s.messages).toEqual([]); expect(s.messageInput).toBe(''); expect(s.activeThreadId).toBeNull();
    expect(s.drafts.get('message')).toBe('unsent message');
    release(); await delivery;
    expect(s.openThread).not.toHaveBeenCalled();
  });
  it('missing selected scope cannot broaden task visibility to other scopes', () => {
    expect(computeBoardScopedTasks([{ record_id: 'other' }], 'scope', null, new Map(), false)).toEqual([]);
  });
});

// Exercise the real canonical cache and its persisted phase, rather than
// presenting an empty array without knowing whether replacement has finished.
describe('canonical navigation projection', () => {
  it('reads empty, partial, interrupted and completed replacement with pending intent intact', async () => {
    const { openWorkspaceDb, deleteWorkspaceDb } = await import('../src/db.js');
    const { applyPgRecordChanges, resetPgRecordAuthority } = await import('../src/pg-record-delta.js');
    const { readPgNavigationProjection } = await import('../src/section-live-queries.js');
    const { default: fixture } = await import('./fixtures/flightdeck-record-delta-v1.json');
    const key = 'canonical-navigation-recovery';
    const db = openWorkspaceDb(key); await db.open();
    const s = { workspaceId: fixture.canonical_upserts.changes[0].workspace_id, workspaceOwnerNpub: 'npub1owner', session: { npub: 'npub1viewer' } };
    s.currentWorkspace = { workspaceId: s.workspaceId, workspaceOwnerNpub: s.workspaceOwnerNpub, pgBackendMode: true };
    try {
      await applyPgRecordChanges(s, fixture.canonical_upserts, { expectedCursor: null });
      expect((await readPgNavigationProjection(s)).scopes).toHaveLength(1);
      await db.pending_writes.add({ record_id: 'local-intent', envelope: { body: 'draft mutation' } });
      await resetPgRecordAuthority(s);
      expect(await readPgNavigationProjection(s)).toMatchObject({ pending: true, scopes: [], channels: [] });
      let cursor = null;
      for (let i = 0; i < fixture.canonical_upserts.changes.length; i++) {
        const next = `page-${i}`;
        await applyPgRecordChanges(s, { ...fixture.canonical_upserts, changes: [fixture.canonical_upserts.changes[i]], next_cursor: next, snapshot_complete: false, has_more: true }, { expectedCursor: cursor });
        cursor = next;
        const projection = await readPgNavigationProjection(s);
        expect(projection.pending).toBe(true);
        if (i === 3) expect(await readPgNavigationProjection({ ...s })).toEqual(projection); // resumed reader sees persisted phase
      }
      await applyPgRecordChanges(s, { ...fixture.canonical_upserts, changes: [], next_cursor: 'boundary', snapshot_complete: true, has_more: true }, { expectedCursor: cursor });
      await applyPgRecordChanges(s, { ...fixture.one_message_delta, changes: [], next_cursor: 'complete', has_more: false }, { expectedCursor: 'boundary' });
      expect(await readPgNavigationProjection(s)).toMatchObject({ pending: false });
      expect((await readPgNavigationProjection(s)).channels).toHaveLength(1);
      expect(await db.pending_writes.count()).toBe(1);
    } finally { await deleteWorkspaceDb(key); }
  });
});

describe('detail authority review', () => {
  it('retains task/document/report models and editors during same-identity reset', async () => {
    const s = client();
    Object.assign(s, { activeTaskId: 'task', editingTask: { record_id: 'task', title: 'private' }, taskEditOriginal: { title: 'private' },
      tasks: ['private'], documents: ['private'], reports: ['private'], selectedDocId: 'doc', selectedReportId: 'report',
      docEditorContent: 'private document', docEditorTitle: 'private title', docEditDraftDirty: true,
      reportModalReport: { title: 'private report' }, showTaskDetail: true, chatDocModalOpen: true,
      persistTaskLocalDraft: vi.fn(), persistSelectedDocDraft: vi.fn(), destroyTaskRichDescriptionEditor: vi.fn(), destroyDocRichEditor: vi.fn() });
    await applyPgNavigationProjection(s, page(true));
    expect(s.editingTask).toMatchObject({ record_id: 'task', title: 'private' });
    expect(s.docEditorContent).toBe('private document'); expect(s.docEditorTitle).toBe('private title');
    expect(s.showTaskDetail).toBe(true); expect(s.tasks).toEqual(['private']);
    expect(s.persistTaskLocalDraft).not.toHaveBeenCalled(); expect(s.destroyDocRichEditor).not.toHaveBeenCalled();
    await applyPgNavigationProjection(s, page(true, [scope], [channel], 3));
    expect(s.selectedChannelId).toBe('channel'); expect(s.docEditorContent).toBe('private document');
  });
  it('retains detail models if live-query coalescing skips the repair phase', async () => {
    const s = client(); s.editingTask = { record_id: 'task', title: 'old authority' }; s.docEditorContent = 'old body';
    s.reportModalReport = { title: 'old report' };
    await applyPgNavigationProjection(s, page(false, [scope], [channel], 3));
    expect(s.editingTask).toMatchObject({ record_id: 'task' }); expect(s.docEditorContent).toBe('old body'); expect(s.reportModalReport).toMatchObject({ title: 'old report' });
  });
  it('keeps a downloaded denied channel selected with retained access status', async () => {
    const s = client();
    await applyPgNavigationProjection(s, page(false, [scope], [{ ...channel, can_read: false, pg_access_status: 'access-lost' }]));
    expect(s.selectedChannelId).toBe('channel'); expect(s.activeThreadId).toBe('root');
    expect(s.messageInput).toBe('unsent message'); expect(s.closeThread).not.toHaveBeenCalled();
  });
  it('channel presence alone cannot prove its missing or denied scope', async () => {
    for (const scopes of [[], [{ ...scope, can_read: false }]]) {
      const s = client(); s.selectedBoardId = 'all'; s.validateSelectedBoardId = () => {};
      s.selectChannel = vi.fn();
      await applyPgNavigationProjection(s, page(true));
      await applyPgNavigationProjection(s, page(false, scopes, [{ ...channel, scope_id: 'scope' }]));
      expect(s.selectChannel).not.toHaveBeenCalled(); expect(s.messageInput).toBe('');
    }
  });
  it('navigation while pending records new intent without reopening content', async () => {
    const { rememberPgRecoveryDestination } = await import('../src/pg-authority-presentation.js');
    const s = client(); await applyPgNavigationProjection(s, page(true));
    expect(rememberPgRecoveryDestination(s, 'doc', 'different-doc')).toBe(true);
    await applyPgNavigationProjection(s, page(true, [scope], [channel], 3));
    expect(s.pgNavigationRecoverySelection).toMatchObject({ section: 'docs', docId: 'different-doc', channelId: null });
    expect(s.selectedDocId).toBeUndefined(); expect(s.docEditorContent).toBeUndefined();
  });
  it.each([
    ['task', 'cached-task', 'tasks'],
    ['doc', 'cached-doc', 'documents'],
  ])('opens a downloaded %s while replacement recovery continues', async (kind, id, collection) => {
    const { rememberPgRecoveryDestination } = await import('../src/pg-authority-presentation.js');
    const s = client();
    s.pgNavigationRecoveryPending = true;
    s[collection] = [{ record_id: id, record_state: 'active', pg_access_status: 'stale' }];
    expect(rememberPgRecoveryDestination(s, kind, id)).toBe(false);
    expect(s.pgNavigationRecoverySelection).toBeUndefined();
  });
});
