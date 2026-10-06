import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindWikiState, channelWikiPages, resolveWikiPage, wikiSource, incomingWikiPages } from '../src/docs/wiki-links.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';
import { prosemirrorToFlightDeckContentModel } from '../src/docs/editor/prosemirror-to-flightdeck.js';
import { validateDocumentContentModelRoundTrip } from '../src/docs/editor/document-content-integrity.js';
import { wikiManagerMixin } from '../src/docs/wiki-manager.js';
import { updateTowerPgChannel } from '../src/tower-command-intents.js';
import { upsertChannel, getDocumentById } from '../src/db.js';
vi.mock('../src/tower-command-intents.js', () => ({ updateTowerPgChannel: vi.fn() }));
vi.mock('../src/db.js', () => ({ upsertChannel: vi.fn(), getDocumentById: vi.fn(), getTaskById: vi.fn(), getScopeById: vi.fn(), getChannelById: vi.fn(), getDirectoryById: vi.fn(), getReportById: vi.fn() }));
vi.mock('../src/pg-read-hydrator.js', () => ({
  resolveTowerPgWorkspaceContext: () => ({ workspaceId: 'workspace', baseUrl: 'http://localhost:3100', appNpub: 'app', workspaceOwnerNpub: 'owner' }),
  mapPgChannelToLocal: (row) => ({ ...row, record_id: row.id }),
}));
const pages = [
  { record_id: 'page-a', title: 'Plant list', pg_channel_id: 'channel', scope_id: 'scope' },
  { record_id: 'other', title: 'Private page', pg_channel_id: 'other-channel' },
  { record_id: 'deleted', title: 'Deleted', pg_channel_id: 'channel', record_state: 'deleted' },
];
function store() {
  const channel = { record_id: 'channel', metadata: { docs_home_document_id: 'page-a', agent_chat: { context_prompt: 'Keep' } } };
  const value = {
    documents: structuredClone(pages), selectedChannel: channel, selectedChannelId: 'channel', channels: [channel], isTowerPgMode: true,
    selectedDocument: { record_id: 'origin', pg_channel_id: 'channel', scope_id: 'scope' }, selectedDocId: 'origin',
    navSection: 'docs', docsHomeVisit: 0, docEditAccessState: 'editing',
    openDoc: vi.fn(), persistSelectedDocDraft: vi.fn().mockResolvedValue({ document_id: 'origin' }), refreshDocuments: vi.fn(), closeDocEditor: vi.fn(), syncRoute: vi.fn(),
    createDocument: vi.fn(async (title) => ({ record_id: 'new-page', title, pg_channel_id: 'channel' })),
    enterSelectedDocEditMode: vi.fn().mockResolvedValue(true),
    docRichEditorAdapter: { editor: { state: { doc: {} }, commands: { focus: vi.fn() } } },
    syncDocRichEditorContentModel: vi.fn(), saveSelectedDocItem: vi.fn(async () => { value.docEditDraftDirty = false; return value.selectedDocument; }),
  };
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(wikiManagerMixin));
  return value;
}
describe('channel wiki pages', () => {
  beforeEach(() => vi.clearAllMocks());
  it('excludes deleted and other-channel pages and never retargets missing IDs', () => {
    expect(channelWikiPages(pages, 'channel')).toHaveLength(1);
    expect(resolveWikiPage(pages, 'channel', { documentId: 'deleted', title: 'Plant list' }).state).toBe('unavailable');
    expect(resolveWikiPage(pages, 'channel', { title: 'Private page' }).state).toBe('unresolved');
    expect(resolveWikiPage([...pages, { ...pages[0], record_id: 'duplicate' }], 'channel', { title: 'plant list' }).state).toBe('ambiguous');
    expect(resolveWikiPage([{ ...pages[0], title: 'Renamed' }], 'channel', { documentId: 'page-a' }).title).toBe('Renamed');
  });
  it('roundtrips stable IDs, unresolved titles, formatting, mentions and code', () => {
    const source = '**Notes** [[Plant list]] and [[Unknown]] plus [Old name](wiki:page-a).\n\n@[Operator](mention:person:npub1person) `[[literal]]`';
    const state = bindWikiState(markdownToProseMirrorDoc(source), pages, 'channel');
    let model = prosemirrorToFlightDeckContentModel(state);
    expect(model.content).toContain('[Plant list](wiki:page-a)');
    expect(model.content).toContain('[[Unknown]]');
    expect(model.content).toContain('`[[literal]]`');
    for (let i = 0; i < 3; i++) {
      expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
      model = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(model.content));
    }
    expect(model.content).toContain('[Old name](wiki:page-a)');
    expect(model.content).toContain('@[Operator](mention:person:npub1person)');
  });
  it('escapes canonical source labels', () => {
    const attrs = { documentId: 'page-a', title: 'A [plant] \\ note *literal* _word_ # title' };
    const model = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(wikiSource(attrs)));
    expect(model.editor_state.content[0].content[0].attrs).toEqual(attrs);
    expect(validateDocumentContentModelRoundTrip(model).ok).toBe(true);
  });
  it('preserves drafts before navigation and stays put when preservation fails', async () => {
    const s = store(); s.docEditDraftDirty = true;
    await s.followDocWikiLink('page-a');
    expect(s.persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true });
    expect(s.openDoc).toHaveBeenCalledWith('page-a', { draftPreserved: true });
    s.openDoc.mockClear(); s.persistSelectedDocDraft.mockRejectedValue(new Error('disk failed'));
    expect(await s.followDocWikiLink('page-a')).toBe(false);
    expect(s.openDoc).not.toHaveBeenCalled();
    expect(s.error).toContain('disk failed');
  });
  it('follows cached wiki links from a document opened in a chat modal', async () => {
    const s = store(); s.navSection = 'chat'; s.chatDocModalOpen = true;
    expect(await s.followDocWikiLink('page-a')).toBe(true);
    expect(s.openDoc).toHaveBeenCalledWith('page-a', { draftPreserved: true });
    expect(s.navSection).toBe('chat');
  });
  it('opens an ID cached only in Dexie without a collection refresh', async () => {
    const s = store(); s.documents = [];
    getDocumentById.mockResolvedValueOnce(pages[0]);
    expect(await s.followDocWikiLink('page-a')).toBe(true);
    expect(s.openDoc).toHaveBeenCalledWith('page-a', { draftPreserved: true });
    expect(s.refreshDocuments).not.toHaveBeenCalled();
  });
  it('loads only a missing wiki target then opens it', async () => {
    const s = store(); s.documents = [];
    getDocumentById.mockResolvedValueOnce(null).mockResolvedValueOnce(pages[0]);
    s.requestTowerSyncFamily = vi.fn().mockResolvedValue(null);
    expect(await s.followDocWikiLink('page-a')).toBe(true);
    expect(s.requestTowerSyncFamily).toHaveBeenCalledWith('document', 'page-a', { force: true });
    expect(s.openDoc).toHaveBeenCalled();
  });
  it('ignores wiki lookup after a newer ordinary reference visit', async () => {
    const s = store(); s.documents = [];
    let finish; getDocumentById.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const following = s.followDocWikiLink('page-a');
    s.internalLinkOpenRequestId++;
    finish(pages[0]);
    expect(await following).toBe(false);
    expect(s.openDoc).not.toHaveBeenCalled();
  });
  it('creates in the same channel, inserts, saves origin, then opens; repeated clicks are gated', async () => {
    const s = store(), events = [];
    let finish;
    s.createDocument.mockImplementation(async () => { events.push('create'); await new Promise((resolve) => { finish = resolve; }); return { record_id: 'new-page', title: 'New' }; });
    s.saveSelectedDocItem.mockImplementation(async () => { events.push('save'); s.docEditDraftDirty = false; return s.selectedDocument; });
    s.openDoc.mockImplementation((id) => { s.selectedDocId = id; events.push('open'); });
    const editor = { isDestroyed: false, chain: () => ({ focus() { return this; }, insertContentAt(range, node) { events.push('insert'); expect(node.attrs.documentId).toBe('new-page'); return this; }, run() {} }) };
    const work = s.createDocWikiPage('New', { from: 1, to: 5 }, editor);
    expect(await s.createDocWikiPage('New', { from: 1, to: 5 }, editor)).toBe(false);
    expect(await s.followDocWikiLink('page-a')).toBe(false);
    expect(s.openDoc).not.toHaveBeenCalled();
    finish(); expect(await work).toBe(true);
    expect(s.createDocument).toHaveBeenCalledWith('New', { scopeId: 'scope', channelId: 'channel', open: false, initialContent: '', throwOnError: true });
    expect(events).toEqual(['create', 'insert', 'save', 'open']);
    expect(s.enterSelectedDocEditMode).not.toHaveBeenCalled();
    expect(s.wikiCreateBusy).toBe(false);
    expect(s.wikiCreateTimings.map(t => t.stage)).toEqual(['origin access', 'page persisted', 'origin saved', 'editor focused', 'finished']);
    expect(s.docRichEditorAdapter.editor.commands.focus).toHaveBeenCalledWith('start');
  });
  it('retains link and draft when origin save fails, and reports create/ambiguous failures', async () => {
    const s = store();
    const editor = { isDestroyed: false, chain: () => ({ focus() { return this; }, insertContentAt() { return this; }, run() {} }) };
    s.saveSelectedDocItem.mockResolvedValue(null);
    expect(await s.createDocWikiPage('New', { from: 1, to: 5 }, editor)).toBe(false);
    expect(s.docEditDraftDirty).toBe(true); expect(s.openDoc).not.toHaveBeenCalled(); expect(s.error).toContain('originating page');
    s.createDocument.mockRejectedValue(new Error('No write access'));
    expect(await s.createDocWikiPage('Denied', { from: 1, to: 5 }, editor)).toBe(false); expect(s.error).toBe('No write access');
    s.documents.push({ ...pages[0], record_id: 'duplicate' });
    expect(await s.createDocWikiPage('Plant list', {}, editor)).toBe(false); expect(s.error).toContain('Several pages');
  });
  it('reuses a readable same-title page and focuses only after its editor mounts', async () => {
    const s = store(); let finish;
    const focus = vi.fn();
    const editor = { isDestroyed: false, chain: () => ({ focus() { return this; }, insertContentAt() { return this; }, run() {} }) };
    s.openDoc.mockImplementation((id) => { s.selectedDocId = id; s.docRichEditorAdapter = null; });
    s.mountDocRichEditor = vi.fn(() => new Promise((resolve) => { finish = () => { s.docRichEditorAdapter = { editor: { commands: { focus } } }; resolve(); }; }));
    const work = s.createDocWikiPage('Plant list', { from: 1, to: 5 }, editor);
    await vi.waitFor(() => expect(s.mountDocRichEditor).toHaveBeenCalled());
    expect(s.createDocument).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    finish(); expect(await work).toBe(true); expect(focus).toHaveBeenCalledWith('start');
  });
  it('reports denied origin editing without creating or bypassing access controls', async () => {
    const s = store();
    const editor = { isDestroyed: false, chain: () => ({ focus() { return this; }, insertContentAt() { return this; }, run() {} }) };
    s.openDoc.mockImplementation((id) => { s.selectedDocId = id; });
    s.docEditAccessState = 'ready'; s.enterSelectedDocEditMode.mockResolvedValue(false); s.docEditAccessMessage = 'No write access';
    expect(await s.createDocWikiPage('New', { from: 1, to: 5 }, editor)).toBe(false);
    expect(s.createDocument).not.toHaveBeenCalled(); expect(s.wikiCreateBusy).toBe(false);
    expect(s.error).toBe('No write access'); expect(s.docRichEditorAdapter.editor.commands.focus).not.toHaveBeenCalled();
  });
  it('writes narrow authoritative home metadata, replaces, clears and surfaces denial', async () => {
    const s = store();
    updateTowerPgChannel.mockImplementation(async (_store, _workspace, id, patch) => ({ channel: { id, metadata: { ...s.selectedChannel.metadata, ...patch.metadata } } }));
    expect(await s.setChannelDocsHome('page-a')).toBe(true);
    expect(updateTowerPgChannel.mock.calls[0][3]).toEqual({ metadata: { docs_home_document_id: 'page-a' } });
    expect(upsertChannel.mock.calls[0][0].metadata.agent_chat.context_prompt).toBe('Keep');
    s.documents.push({ record_id: 'replacement', title: 'Replacement', pg_channel_id: 'channel' });
    expect(await s.setChannelDocsHome('replacement')).toBe(true);
    expect(await s.setChannelDocsHome(null)).toBe(true);
    expect(updateTowerPgChannel.mock.calls[2][3]).toEqual({ metadata: { docs_home_document_id: null } });
    updateTowerPgChannel.mockRejectedValue(new Error('Forbidden'));
    expect(await s.setChannelDocsHome('page-a')).toBe(false); expect(s.error).toBe('Forbidden');
  });
  it('defaults to available home, falls back for deleted home and cancels late home after All docs', async () => {
    const s = store(); await s.openChannelDocsHome(); expect(s.openDoc).toHaveBeenCalledWith('page-a', { draftPreserved: true });
    s.openDoc.mockClear(); s.documents[0].record_state = 'deleted'; await s.openChannelDocsHome(); expect(s.closeDocEditor).toHaveBeenCalled(); expect(s.openDoc).not.toHaveBeenCalled();
    s.documents = [];
    let finish; s.refreshDocuments.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const opening = s.openChannelDocsHome(); await s.openChannelAllDocs(); finish(); await opening;
    expect(s.openDoc).not.toHaveBeenCalled(); expect(s.docsShowAll).toBe(true);
  });
  it('opens cached Home while refresh, save and lease promises never settle', async () => {
    const s = store();
    s.refreshDocuments.mockImplementation(() => new Promise(() => {}));
    s.saveSelectedDocItem.mockImplementation(() => new Promise(() => {}));
    s.enterSelectedDocEditMode.mockImplementation(() => new Promise(() => {}));
    expect(await s.openChannelDocsHome()).toBe(true);
    expect(s.refreshDocuments).not.toHaveBeenCalled();
    expect(s.saveSelectedDocItem).not.toHaveBeenCalled();
    expect(s.enterSelectedDocEditMode).not.toHaveBeenCalled();
    expect(s.openDoc).toHaveBeenCalledWith('page-a', { draftPreserved: true });
  });
  it('All docs and unavailable Home preserve drafts before closing, and refuse navigation on persistence failure', async () => {
    const s = store(); s.docEditDraftDirty = true;
    let finish;
    s.persistSelectedDocDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const opening = s.openChannelAllDocs();
    expect(s.closeDocEditor).not.toHaveBeenCalled();
    finish({ document_id: 'origin' }); expect(await opening).toBe(true);
    expect(s.closeDocEditor).toHaveBeenCalled();
    s.closeDocEditor.mockClear(); s.persistSelectedDocDraft.mockRejectedValue(new Error('Storage failed'));
    expect(await s.openChannelAllDocs()).toBe(false);
    expect(s.closeDocEditor).not.toHaveBeenCalled();
    s.documents = []; await s.openChannelDocsHome();
    expect(s.closeDocEditor).not.toHaveBeenCalled(); expect(s.error).toContain('Storage failed');
    s.documents = structuredClone(pages);
    s.persistSelectedDocDraft.mockResolvedValue(null);
    expect(await s.followDocWikiLink('page-a')).toBe(false);
  });
  it('keeps an already open home draft and uses the list for a channel with no home', async () => {
    const s = store(); s.selectedDocId = 'page-a'; s.docEditDraftDirty = true;
    expect(await s.openChannelDocsHome()).toBe(true);
    expect(s.persistSelectedDocDraft).toHaveBeenCalled();
    expect(s.openDoc).not.toHaveBeenCalled();
    s.selectedChannel.metadata.docs_home_document_id = null;
    await s.openChannelDocsHome();
    expect(s.closeDocEditor).toHaveBeenCalled();
    expect(s.docsShowAll).toBe(true);
  });

  it.each(['channel', 'workspace', 'home', 'document'])('cancels delayed home when %s context changes', async (change) => {
    const s = store(); s.currentWorkspace = { workspaceId: 'workspace' }; s.documents = [];
    let finish; s.refreshDocuments.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const opening = s.openChannelDocsHome();
    if (change === 'channel') s.selectedChannelId = 'other-channel';
    if (change === 'workspace') s.currentWorkspace = { workspaceId: 'other-workspace' };
    if (change === 'home') s.selectedChannel.metadata.docs_home_document_id = 'replacement';
    if (change === 'document') s.selectedDocId = 'explicit-page';
    finish(); expect(await opening).toBe(false);
    expect(s.openDoc).not.toHaveBeenCalled();
    expect(s.closeDocEditor).not.toHaveBeenCalled();
  });

  it('cancels a pending link checkpoint after another Home or All docs visit', async () => {
    const s = store(); s.docEditDraftDirty = true;
    let finish; s.persistSelectedDocDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const following = s.followDocWikiLink('page-a');
    s.docsHomeVisit++;
    finish({ document_id: 'origin' });
    expect(await following).toBe(false);
    expect(s.openDoc).not.toHaveBeenCalled();
  });

  it('cancels All docs after an explicit document replaces the origin during its checkpoint', async () => {
    const s = store(); s.docEditDraftDirty = true;
    let finish; s.persistSelectedDocDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const navigating = s.openChannelAllDocs(); s.selectedDocId = 'explicit-page';
    finish({ document_id: 'origin' });
    expect(await navigating).toBe(false); expect(s.closeDocEditor).not.toHaveBeenCalled();
  });

  it('never inserts a stale picker range after edits made while creation is pending', async () => {
    const s = store(); let finish;
    s.createDocument.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const insert = vi.fn();
    const editor = { isDestroyed: false, state: { doc: {} }, setEditable: vi.fn(), chain: () => ({ focus() { return this; }, insertContentAt: insert, run() {} }) };
    const creating = s.createDocWikiPage('New', { from: 1, to: 5 }, editor);
    expect(editor.setEditable).toHaveBeenCalledWith(false);
    // Programmatic/mapped updates can still arrive while native entry is paused.
    editor.state.doc = { changed: true };
    finish({ record_id: 'created', title: 'New' });
    expect(await creating).toBe(false);
    expect(insert).not.toHaveBeenCalled(); expect(s.openDoc).not.toHaveBeenCalled();
    expect(s.error).toContain('originating page changed');
    expect(editor.setEditable).toHaveBeenLastCalledWith(true);
  });

  it('does not close or jump over edits made while a navigation checkpoint is pending', async () => {
    const s = store(); s.docEditDraftDirty = true; s.docEditorContent = 'Before';
    let finish;
    s.persistSelectedDocDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const navigating = s.openChannelAllDocs();
    s.docEditorContent = 'New typing during checkpoint';
    finish({ document_id: 'origin' });
    expect(await navigating).toBe(false);
    expect(s.closeDocEditor).not.toHaveBeenCalled();
    expect(s.error).toContain('draft changed');
    expect(s.docEditorContent).toBe('New typing during checkpoint');
  });

});

 describe('incoming wiki links', () => {
  it('reads rich and canonical source, excludes history/self/other channel/code, deduplicates and follows renames', () => {
    const target = { record_id: 'target', title: 'Renamed', pg_channel_id: 'channel' };
    const rows = [target,
      { record_id: 'source', title: 'Source', pg_channel_id: 'channel', content: '[Old](wiki:target) [Again](wiki:target)' },
      { record_id: 'rich', title: 'Rich', pg_channel_id: 'channel', editor_state: markdownToProseMirrorDoc('[Old](wiki:target)') },
      { record_id: 'title', title: 'Title', pg_channel_id: 'channel', content: '[[Renamed]]' },
      { record_id: 'code', title: 'Code', pg_channel_id: 'channel', content: '`[[Renamed]]`' },
      { record_id: 'outside', pg_channel_id: 'other', content: '[Old](wiki:target)' },
      { record_id: 'deleted', pg_channel_id: 'channel', record_state: 'deleted', content: '[Old](wiki:target)' }];
    expect(incomingWikiPages(rows, target).map(p => p.record_id)).toEqual(['rich', 'source', 'title']);
    expect(incomingWikiPages(rows, { ...target, record_id: 'another' })).toEqual([]);
    const duplicate = { ...target, record_id: 'duplicate' };
    expect(incomingWikiPages([...rows, duplicate], target).map(p => p.record_id)).toEqual(['rich', 'source']);
    rows[1].content = 'Removed';
    expect(incomingWikiPages(rows, target).map(p => p.record_id)).toEqual(['rich', 'title']);
  });
 });
