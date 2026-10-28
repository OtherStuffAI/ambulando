import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertDocument: vi.fn(),
  upsertMessage: vi.fn(),
  upsertTask: vi.fn(),
  createMessage: vi.fn(),
  moveDoc: vi.fn(),
  moveTask: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  upsertDocument: mocks.upsertDocument,
  captureDocumentUpsert: () => mocks.upsertDocument,
  upsertMessage: mocks.upsertMessage,
  upsertTask: mocks.upsertTask,
}));
vi.mock('../src/pg-write-adapter.js', () => ({
  createTowerPgMessageFromLocal: mocks.createMessage,
  moveTowerPgDocFromLocal: mocks.moveDoc,
  moveTowerPgTaskFromLocal: mocks.moveTask,
}));

import { createRecordTransferState, recordTransferManagerMixin } from '../src/record-transfer-manager.js';

function store(overrides = {}) {
  const target = {
    ...createRecordTransferState(),
    channels: [
      { record_id: 'channel-source', scope_id: 'scope-a', title: 'Intake' },
      { record_id: 'channel-same-scope', scope_id: 'scope-a', title: 'Build' },
      { record_id: 'channel-cross-scope', scope_id: 'scope-b', title: 'Delivery' },
    ],
    scopes: [
      { record_id: 'scope-a', title: 'Features' },
      { record_id: 'scope-b', title: 'Operations' },
    ],
    tasks: [],
    documents: [],
    messageInput: '',
    threadInput: '',
    getChannelLabel: (channel) => channel.title,
    getScopeBreadcrumb: (scopeId) => scopeId,
    applyTasks: vi.fn(function applyTasks(rows) { this.tasks = rows; }),
    applyDocuments: vi.fn(function applyDocuments(rows) { this.documents = rows; }),
    patchMessageLocal: vi.fn(function patchMessageLocal(row) {
      this.messages = [...(this.messages || []).filter((item) => item.record_id !== row.record_id), row];
    }),
    patchDocumentLocal: vi.fn(function patchDocumentLocal(row) {
      this.documents = [...this.documents.filter((item) => item.record_id !== row.record_id), row];
    }),
    navigateTo: vi.fn(),
    selectChannel: vi.fn(),
    openThread: vi.fn(),
    scheduleComposerAutosize: vi.fn(),
    syncRoute: vi.fn(),
    ...overrides,
  };
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(recordTransferManagerMixin));
  return target;
}

beforeEach(() => vi.clearAllMocks());

describe('record transfer manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockImplementation(async (_subject, message) => ({
      ...message,
      record_id: 'message-created',
      pg_thread_id: 'thread-created',
      sync_status: 'synced',
    }));
  });

  it('offers channels in the current and other visible scopes', () => {
    const subject = store();
    subject.openRecordMove('task', { record_id: 'task-1', title: 'Move me', pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source' });
    expect(subject.recordTransferScopeOptions.map((scope) => scope.id)).toEqual(['scope-a', 'scope-b']);
    expect(subject.recordTransferChannelOptions.map((channel) => channel.id)).toEqual(['channel-same-scope', 'channel-source']);
    subject.recordTransfer.destinationScopeId = 'scope-b';
    expect(subject.recordTransferChannelOptions.map((channel) => channel.id)).toEqual(['channel-cross-scope']);
  });

  it('materializes the returned canonical task without changing local placement before success', async () => {
    const original = { record_id: 'task-1', title: 'Move me', pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source', version: 2 };
    const moved = { ...original, scope_id: 'scope-b', channel_id: 'channel-cross-scope', version: 3 };
    const subject = store({ tasks: [original] });
    mocks.moveTask.mockResolvedValue(moved);
    subject.openRecordMove('task', original);
    subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
    const pending = subject.submitRecordTransfer();
    expect(subject.tasks[0]).toEqual(original);
    await expect(pending).resolves.toBe(true);
    expect(mocks.upsertTask).toHaveBeenCalledWith(moved);
    expect(subject.tasks).toEqual([moved]);
  });

  it('keeps local state unchanged and shows the server error when a move fails', async () => {
    const original = { record_id: 'doc-1', title: 'Move doc', pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source', version: 4 };
    const subject = store({ documents: [original] });
    mocks.moveDoc.mockRejectedValue(new Error('Destination permission denied'));
    subject.openRecordMove('document', original);
    subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
    await expect(subject.submitRecordTransfer()).resolves.toBe(false);
    expect(subject.documents).toEqual([original]);
    expect(mocks.upsertDocument).not.toHaveBeenCalled();
    expect(subject.recordTransfer.error).toBe('Destination permission denied');
  });

  it('rejects a same-destination move before calling Tower', async () => {
    const original = { record_id: 'task-1', title: 'Stay', pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source' };
    const subject = store({ tasks: [original] });
    subject.openRecordMove('task', original);
    subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-a', destinationChannelId: 'channel-source' };
    await expect(subject.submitRecordTransfer()).resolves.toBe(false);
    expect(mocks.moveTask).not.toHaveBeenCalled();
    expect(subject.recordTransfer.error).toContain('already');
  });

  it.each([
    ['task', 'task-1', 'Ship it', 'scope-a', 'channel-same-scope', '@[Ship it](mention:task:task-1)'],
    ['document', 'doc-1', 'Design', 'scope-b', 'channel-cross-scope', '@[Design](mention:doc:doc-1)'],
  ])('creates and opens a new thread with the normal structured %s mention', async (recordType, recordId, title, scopeId, channelId, mention) => {
    const subject = store();
    subject.openRecordTagInChat(recordType, { record_id: recordId, title, pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source' });
    subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: scopeId, destinationChannelId: channelId };
    await expect(subject.submitRecordTransfer()).resolves.toBe(true);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    const [, message, options] = mocks.createMessage.mock.calls[0];
    expect(message).toMatchObject({ channel_id: channelId, body: mention, parent_message_id: null, pg_thread_id: null });
    expect(options).toBeUndefined();
    expect(mocks.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'message-created', pg_thread_id: 'thread-created' }));
    expect(subject.navigateTo).toHaveBeenCalledWith('chat', { syncRoute: false });
    expect(subject.selectChannel).toHaveBeenCalledWith(channelId, { syncRoute: false, scrollToLatest: false });
    expect(subject.openThread).toHaveBeenCalledWith('message-created', { syncRoute: false, scrollToLatest: false });
    expect(subject.messageInput).toBe('');
    expect(subject.threadInput).toBe('');
  });

  it('keeps the picker intact and creates no local thread when Tower rejects creation', async () => {
    mocks.createMessage.mockRejectedValue(new Error('Destination permission denied'));
    const subject = store();
    subject.openRecordTagInChat('task', { record_id: 'task-1', title: 'Ship it', pg_backend: 'tower', scope_id: 'scope-a', channel_id: 'channel-source' });
    subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
    await expect(subject.submitRecordTransfer()).resolves.toBe(false);
    expect(subject.recordTransfer).toMatchObject({
      open: true,
      destinationScopeId: 'scope-b',
      destinationChannelId: 'channel-cross-scope',
      submitting: false,
      error: 'Destination permission denied',
    });
    expect(mocks.upsertMessage).not.toHaveBeenCalled();
    expect(subject.patchMessageLocal).not.toHaveBeenCalled();
    expect(subject.navigateTo).not.toHaveBeenCalled();
    expect(subject.selectChannel).not.toHaveBeenCalled();
    expect(subject.openThread).not.toHaveBeenCalled();
  });
});

 it('checkpoints a dirty document and requires Save before the typed move, then follows accepted context', async () => {
  const original = { record_id: 'doc-draft', title: 'Draft', pg_backend: true, scope_id: 'scope-a', pg_channel_id: 'channel-source', version: 4 };
  const subject = store({ documents: [original], selectedDocument: original, selectedDocId: original.record_id, docEditDraftDirty: true,
    preserveWikiNavigationDraft: vi.fn(async () => true), selectPgChannelContext: vi.fn() });
  subject.openRecordMove('document', original);
  subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
  expect(await subject.submitRecordTransfer()).toBe(false);
  expect(subject.preserveWikiNavigationDraft).toHaveBeenCalled(); expect(mocks.moveDoc).not.toHaveBeenCalled();
  expect(subject.recordTransfer.error).toContain('Save or recover');
  subject.docEditDraftDirty = false;
  mocks.moveDoc.mockResolvedValue({ ...original, version: 5, scope_id: 'scope-b', pg_channel_id: 'channel-cross-scope' });
  expect(await subject.submitRecordTransfer()).toBe(true);
  expect(mocks.moveDoc).toHaveBeenCalledWith(subject, original, 'channel-cross-scope', 'scope-b');
  expect(subject.selectPgChannelContext).toHaveBeenCalledWith('channel-cross-scope', { preserveDetail: true });
 });

 it('writes a late document move to its captured partition and leaves a newer workspace view untouched', async () => {
  const original = { record_id: 'late-doc', pg_backend: true, scope_id: 'scope-a', pg_channel_id: 'channel-source' };
  const subject = store({ currentWorkspace: { workspaceId: 'origin' }, session: { npub: 'actor' }, documents: [original], selectedDocId: original.record_id, selectedDocument: original,
    preserveWikiNavigationDraft: vi.fn(async () => true), selectPgChannelContext: vi.fn() });
  let finish; mocks.moveDoc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  subject.openRecordMove('document', original); subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
  const moving = subject.submitRecordTransfer();
  await vi.waitFor(() => expect(mocks.moveDoc).toHaveBeenCalled());
  subject.currentWorkspace = { workspaceId: 'new' }; subject.session = { npub: 'other' };
  subject.documents = [{ record_id: 'new-doc' }]; subject.recordTransfer = { open: true, record: { record_id: 'new-doc' } };
  finish({ ...original, pg_channel_id: 'channel-cross-scope', scope_id: 'scope-b' });
  expect(await moving).toBe(true);
  expect(mocks.upsertDocument).toHaveBeenCalled(); expect(subject.documents).toEqual([{ record_id: 'new-doc' }]);
  expect(subject.patchDocumentLocal).not.toHaveBeenCalled(); expect(subject.selectPgChannelContext).not.toHaveBeenCalled();
  expect(subject.recordTransfer.record.record_id).toBe('new-doc');
 });
 it('preserves edits entered while a selected document move is awaiting Tower', async () => {
  const original = { record_id: 'typing-doc', pg_backend: true, scope_id: 'scope-a', pg_channel_id: 'channel-source' };
  const subject = store({ selectedDocId: original.record_id, selectedDocument: original, docEditDraftDirty: false,
    docEditorContent: 'Before', preserveWikiNavigationDraft: vi.fn(async () => true), cancelDocAutosave: vi.fn() });
  let finish; mocks.moveDoc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  subject.openRecordMove('document', original); subject.recordTransfer = { ...subject.recordTransfer, destinationScopeId: 'scope-b', destinationChannelId: 'channel-cross-scope' };
  const moving = subject.submitRecordTransfer(); await vi.waitFor(() => expect(mocks.moveDoc).toHaveBeenCalled());
  subject.docEditDraftDirty = true; subject.docEditorContent = 'Typed while moving';
  finish({ ...original, pg_channel_id: 'channel-cross-scope', scope_id: 'scope-b' }); await moving;
  expect(subject.preserveWikiNavigationDraft).toHaveBeenCalledTimes(2);
  expect(subject.docEditorContent).toBe('Typed while moving'); expect(subject.docEditDraftDirty).toBe(true);
 });
