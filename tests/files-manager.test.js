import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', () => ({
  completeStorageObject: vi.fn(),
  downloadStorageObject: vi.fn(),
  downloadStorageObjectBlob: vi.fn(),
  prepareStorageObject: vi.fn(),
  uploadStorageObject: vi.fn(),
  updateTowerPgDoc: vi.fn(),
  updateTowerPgFile: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  upsertDocument: vi.fn(async () => undefined),
  upsertFileFolder: vi.fn(async () => undefined),
}));

vi.mock('../src/pg-write-adapter.js', () => ({
  createTowerPgFileFolderFromLocal: vi.fn(),
  createTowerPgFileFromLocal: vi.fn(),
  updateTowerPgFileFromLocal: vi.fn(async (_store, file) => ({ ...file, sync_status: 'synced', version: 2 })),
}));

import {
  buildFileUploadQueueItem,
  buildFileBrowserRows,
  filterFileBrowserRows,
  filesManagerMixin,
  isConvertibleTextFile,
  resolveFileUploadContentType,
} from '../src/files-manager.js';
import { downloadStorageObjectBlob, downloadStorageObject, updateTowerPgDoc } from '../src/api.js';
import { upsertDocument, upsertFileFolder } from '../src/db.js';
import { createTowerPgFileFolderFromLocal, updateTowerPgFileFromLocal } from '../src/pg-write-adapter.js';
import { recordFamilyHash } from '../src/translators/chat.js';

describe('files manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects canonical Tower images and PDFs once with metadata instead of internal document bodies', () => {
    const rows = buildFileBrowserRows({ documents: [
      { record_id: 'image', pg_record_type: 'file', pg_storage_object_id: 'image-object', title: 'bird.png', content: '[bird.png](storage://image-object)', content_storage_content_type: 'image/png', pg_workspace_id: 'workspace-a', content_size_bytes: 20 },
      { record_id: 'pdf', pg_record_type: 'file', pg_storage_object_id: 'pdf-object', title: 'report.pdf', content_storage_content_type: 'application/pdf' },
    ] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ object_id: 'image-object', kind: 'image', pg_record_type: 'file', content_type: 'image/png', workspace_id: 'workspace-a', size_bytes: 20 });
    expect(rows[1]).toMatchObject({ object_id: 'pdf-object', pg_record_type: 'file', name: 'report.pdf' });
  });

  it('projects metadata-only chat images/files with their real message source and owning workspace', () => {
    const rows=buildFileBrowserRows({ fileMessages:[{record_id:'message',pg_workspace_id:'workspace',channel_id:'channel',body:'![Image](storage://image)',attachments:[{storage_object_id:'image',kind:'image',filename:'photo.png',content_type:'image/png'},{storage_object_id:'file',kind:'file',filename:'notes.pdf',size_bytes:42}]}] });
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.object_id === 'image')).toMatchObject({object_id:'image',source_type:'chat',source_record_id:'message',workspace_id:'workspace',name:'photo.png'});
    expect(rows.find(r => r.object_id === 'file')).toMatchObject({object_id:'file',source_record_id:'message',name:'notes.pdf',size_bytes:42});
  });

  it('uses the file workspace backend and refuses unknown or ambiguous workspaces', () => {
    const store = Object.assign(Object.create(filesManagerMixin), {
      currentWorkspace: { workspaceId: 'current', directHttpsUrl: 'https://current.example' },
      knownWorkspaces: [{ workspaceId: 'remote', directHttpsUrl: 'https://remote.example' }],
      backendUrl: 'https://current.example',
    });
    expect(store.getFilePreviewBackendUrl({ workspace_id: 'remote' })).toBe('https://remote.example');
    expect(store.getFilePreviewBackendUrl({})).toBe('https://current.example');
    expect(() => store.getFilePreviewBackendUrl({ workspace_id: 'missing' })).toThrow('workspace is unavailable');
    store.knownWorkspaces.push({ workspaceId: 'remote', directHttpsUrl: 'https://different.example' });
    expect(() => store.getFilePreviewBackendUrl({ workspace_id: 'remote' })).toThrow('ambiguous');
    expect(store.getFilePreviewBackendUrl({ workspace_id: 'remote', backend_url: 'https://pinned.example' })).toBe('https://pinned.example');
  });

  it('loads an authenticated image preview without navigating to its source and saves its original bytes/name', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    downloadStorageObjectBlob.mockResolvedValue(blob);
    const store = Object.assign(Object.create(filesManagerMixin), {
      backendUrl: 'https://storage.example', chatImagePreviewModal: { open: false },
      closeChatImagePreview: vi.fn(), openDoc: vi.fn(), navigateTo: vi.fn(),
      downloadStorageObjectAsFile: vi.fn(async () => true),
    });
    await store.openFilePreview({ object_id: 'image-object', name: 'bird.png', source_type: 'document', source_record_id: 'parent-doc' });
    expect(downloadStorageObjectBlob).toHaveBeenCalledWith('image-object', { backendUrl: 'https://storage.example' });
    expect(store.chatImagePreviewModal).toMatchObject({ open: true, kind: 'image', filename: 'bird.png', loading: false, ownedUrl: true });
    expect(store.openDoc).not.toHaveBeenCalled();
    expect(store.navigateTo).not.toHaveBeenCalled();
    await store.saveFilePreviewLocally();
    expect(store.downloadStorageObjectAsFile).toHaveBeenCalledWith('image-object', 'bird.png', 'image', { backendUrl: 'https://storage.example', blob, throwOnError: true });
    URL.revokeObjectURL(store.chatImagePreviewModal.src);
  });

  it('opens file view, reports download failure, and ignores a late load after close', async () => {
    const store = Object.assign(Object.create(filesManagerMixin), {
      backendUrl: 'https://storage.example', chatImagePreviewModal: { open: false }, closeChatImagePreview: vi.fn(),
      downloadStorageObjectAsFile: vi.fn(async () => { throw new Error('Save denied'); }),
    });
    downloadStorageObjectBlob.mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
    await store.openFilePreview({ object_id: 'pdf', name: 'report.pdf' });
    expect(store.chatImagePreviewModal).toMatchObject({ src: '', loading: false, filename: 'report.pdf' });
    await store.saveFilePreviewLocally();
    expect(store.chatImagePreviewModal).toMatchObject({ error: 'Save denied', downloading: false });
    downloadStorageObjectBlob.mockRejectedValueOnce(new Error('Storage denied'));
    await store.openFilePreview({ object_id: 'unavailable' });
    expect(store.chatImagePreviewModal).toMatchObject({ loading: false, error: 'Storage denied' });
    let finish;
    downloadStorageObjectBlob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.openFilePreview({ object_id: 'slow', kind: 'image' });
    expect(store.chatImagePreviewModal.loading).toBe(true);
    store.filePreviewRequestId += 1;
    store.chatImagePreviewModal = { open: false };
    finish(new Blob(['image'], { type: 'image/png' }));
    await pending;
    expect(store.chatImagePreviewModal).toEqual({ open: false });
  });

  it('opens canonical file sources as previews while retaining genuine document source navigation', async () => {
    const store = Object.assign(Object.create(filesManagerMixin), {
      documents: [{ record_id: 'file', pg_record_type: 'file', pg_storage_object_id: 'image-object' }],
      openFilePreview: vi.fn(), openDoc: vi.fn(), navigateTo: vi.fn(),
    });
    await store.openFileBrowserSource({ source_type: 'document', source_record_id: 'file', object_id: 'image-object' });
    expect(store.openFilePreview).toHaveBeenCalledOnce();
    expect(store.openDoc).not.toHaveBeenCalled();
    await store.openFileBrowserSource({ source_type: 'document', source_record_id: 'doc' });
    expect(store.openDoc).toHaveBeenCalledWith('doc');
  });

  it('reuses the file projection across unrelated reactive changes', () => {
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      documents: [{ record_id: 'doc-1', title: 'Doc', content: '[](storage://object-1)' }],
      tasks: [],
      channels: [],
      fileMessages: [],
      fileComments: [],
      audioNotes: [],
    });

    const first = fileStore.fileBrowserRows;
    fileStore.unrelatedComposerDraft = 'typing';
    expect(fileStore.fileBrowserRows).toBe(first);

    fileStore.fileMessages = [{ record_id: 'message-1', channel_id: 'channel-1' }];
    expect(fileStore.fileBrowserRows).not.toBe(first);
  });

  it('feeds Deck thread reconciliation when the status message snapshot changes', () => {
    const reconcileDeckThreadMessages = vi.fn();
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      reconcileDeckThreadMessages,
    });
    const messages = [{ record_id: 'message-1', channel_id: 'channel-1' }];

    fileStore.applyFileMessages(messages);

    expect(fileStore.fileMessages).toBe(messages);
    expect(reconcileDeckThreadMessages).toHaveBeenCalledWith(messages);
  });

  it('opens a chat-backed file in its specific thread after selecting the channel', async () => {
    const calls = [];
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      navigateTo(section) {
        calls.push(['navigateTo', section]);
      },
      async selectChannel(recordId, options) {
        calls.push(['selectChannel', recordId, options]);
      },
      openThread(recordId, options) {
        calls.push(['openThread', recordId, options]);
      },
      syncRoute() {
        calls.push(['syncRoute']);
      },
    });

    await fileStore.openFileBrowserSource({
      source_type: 'chat',
      source_record_id: 'reply-message',
      channel_id: 'chan-1',
      thread_id: 'thread-1',
    });

    expect(calls).toEqual([
      ['navigateTo', 'chat'],
      ['selectChannel', 'chan-1', { syncRoute: false, scrollToLatest: false }],
      ['openThread', 'thread-1', { scrollToLatest: false, syncRoute: false }],
      ['syncRoute'],
    ]);
  });

  it('falls back to the source message when a chat-backed file belongs to a root thread', async () => {
    const openThread = vi.fn();
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      navigateTo: vi.fn(),
      selectChannel: vi.fn(async () => undefined),
      openThread,
      syncRoute: vi.fn(),
    });

    await fileStore.openFileBrowserSource({
      source_type: 'chat',
      source_record_id: 'root-message',
      channel_id: 'chan-1',
    });

    expect(openThread).toHaveBeenCalledWith('root-message', { scrollToLatest: false, syncRoute: false });
  });

  it('opens task attachments at the task named by the source contract', async () => {
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      navigateTo: vi.fn(),
      openTaskDetail: vi.fn(),
    });

    await fileStore.openFileBrowserSource({
      source_type: 'task',
      source_record_id: 'task-1',
      object_id: 'file-1',
    });

    expect(fileStore.navigateTo).toHaveBeenCalledWith('tasks');
    expect(fileStore.openTaskDetail).toHaveBeenCalledWith('task-1');
  });

  it('routes comment attachments through their resolved chat target', async () => {
    const fileStore = Object.assign(Object.create(filesManagerMixin), {
      navigateTo: vi.fn(),
      selectChannel: vi.fn(async () => undefined),
      openThread: vi.fn(),
      syncRoute: vi.fn(),
    });

    await fileStore.openFileBrowserSource({
      source_type: 'comment',
      source_record_id: 'comment-1',
      source_target_type: 'chat',
      source_target_record_id: 'message-1',
      channel_id: 'chan-1',
      thread_id: 'thread-1',
    });

    expect(fileStore.navigateTo).toHaveBeenCalledWith('chat');
    expect(fileStore.openThread).toHaveBeenCalledWith('thread-1', { scrollToLatest: false, syncRoute: false });
  });

  it('marks archived canonical docs and files for the virtual Archived folder', () => {
    const rows = buildFileBrowserRows({
      ...store,
      tasks: [], fileMessages: [], fileComments: [], audioNotes: [],
      documents: [
        { ...store.documents[0], record_state: 'archived' },
        { record_id: 'file-1', title: 'Archive.pdf', content: '[Archive.pdf](storage://file-1)', record_state: 'archived', pg_record_type: 'file' },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.archived)).toBe(true);
  });

  it('archives selected canonical documents and closes an archived open document', async () => {
    const archiveStore = Object.assign(Object.create(filesManagerMixin), {
      documents: [
        { record_id: 'doc-1', pg_backend: true, pg_record_type: 'doc' },
        { record_id: 'doc-2', pg_backend: true, pg_record_type: 'doc' },
      ],
      selectedDocument: { record_id: 'doc-1', pg_backend: true, pg_record_type: 'doc' },
      chatDocModalOpen: false,
      docArchiveBusy: false,
      setDocumentArchived: vi.fn(async () => ({})),
      closeDocEditor: vi.fn(),
      closeChatDocModal: vi.fn(),
    });

    await archiveStore.archiveDocumentsByIds(['doc-1', 'doc-2'], true);
    expect(archiveStore.setDocumentArchived).toHaveBeenNthCalledWith(1, archiveStore.documents[0], true);
    expect(archiveStore.setDocumentArchived).toHaveBeenNthCalledWith(2, archiveStore.documents[1], true);

    await archiveStore.archiveOpenDocument();
    expect(archiveStore.closeDocEditor).toHaveBeenCalledTimes(1);
    expect(archiveStore.closeChatDocModal).not.toHaveBeenCalled();
    expect(archiveStore.docArchiveBusy).toBe(false);
  });

  it('shows archive failures and resolves them without an unhandled rejection', async () => {
    updateTowerPgDoc.mockRejectedValueOnce(new Error('lease_token is required for PG edit saves'));
    const archiveStore = Object.assign(Object.create(filesManagerMixin), {
      documents: [{
        record_id: 'doc-1',
        pg_backend: true,
        pg_record_type: 'doc',
        pg_workspace_id: 'workspace-1',
        version: 3,
      }],
      activeWorkspace: { backendUrl: 'http://tower.test' },
      applyDocuments: vi.fn(),
      error: null,
    });

    await expect(archiveStore.archiveDocumentsByIds(['doc-1'], true)).resolves.toBe(false);
    expect(archiveStore.error).toBe('lease_token is required for PG edit saves');
    expect(archiveStore.applyDocuments).not.toHaveBeenCalled();
  });

  const store = {
    documents: [
      {
        record_id: 'doc-1',
        title: 'Launch notes',
        content: '![Diagram](storage://img-doc-1)',
        content_storage_object_id: 'doc-content-1',
        content_storage_content_type: 'application/json',
        content_size_bytes: 1200,
        scope_id: 'scope-1',
        updated_at: '2026-05-01T10:00:00.000Z',
      },
    ],
    tasks: [
      {
        record_id: 'task-1',
        title: 'Prep deck',
        description: 'See ![Mockup](storage://img-task-1)',
        scope_id: 'scope-2',
        updated_at: '2026-05-02T10:00:00.000Z',
      },
    ],
    channels: [
      { record_id: 'chan-1', title: 'Design' },
    ],
    fileMessages: [
      {
        record_id: 'msg-1',
        channel_id: 'chan-1',
        pg_thread_id: 'thread-1',
        body: 'Shared ![Chat image](storage://img-chat-1) and [OS Partner Ecosystem Model Notes.pages](storage://file-chat-1)',
        updated_at: '2026-05-03T10:00:00.000Z',
      },
    ],
    fileComments: [
      {
        record_id: 'comment-1',
        target_record_id: 'doc-1',
        target_record_family_hash: recordFamilyHash('document'),
        body: 'Comment image ![Comment image](storage://img-comment-1)',
        updated_at: '2026-05-04T10:00:00.000Z',
      },
    ],
    audioNotes: [
      {
        record_id: 'audio-1',
        title: 'Voice note',
        storage_object_id: 'audio-obj-1',
        target_record_id: 'msg-1',
        target_record_family_hash: recordFamilyHash('chat_message'),
        mime_type: 'audio/webm',
        size_bytes: 24000,
        updated_at: '2026-05-05T10:00:00.000Z',
      },
    ],
  };

  it('builds file rows from documents, markdown storage refs, chat, comments, and audio notes', () => {
    const rows = buildFileBrowserRows(store);
    const objectIds = rows.map((row) => row.object_id);

    expect(objectIds).toContain('doc-content-1');
    expect(objectIds).toContain('img-doc-1');
    expect(objectIds).toContain('img-task-1');
    expect(objectIds).toContain('img-chat-1');
    expect(objectIds).toContain('file-chat-1');
    expect(objectIds).toContain('img-comment-1');
    expect(objectIds).toContain('audio-obj-1');
    expect(rows.find((row) => row.object_id === 'img-chat-1')).toMatchObject({
      kind: 'image',
      name: 'Chat image',
      source_type: 'chat',
      channel_id: 'chan-1',
    });
    expect(rows.find((row) => row.object_id === 'file-chat-1')).toMatchObject({
      kind: 'file',
      name: 'OS Partner Ecosystem Model Notes.pages',
      source_type: 'chat',
      channel_id: 'chan-1',
    });
    expect(rows.find((row) => row.object_id === 'audio-obj-1')).toMatchObject({
      kind: 'audio',
      channel_id: 'chan-1',
      source_target_type: 'chat',
      source_target_record_id: 'msg-1',
    });
    expect(rows.find((row) => row.object_id === 'img-comment-1')).toMatchObject({
      source_type: 'comment',
      source_target_type: 'document',
      source_target_record_id: 'doc-1',
    });
  });

  it('filters rows by source, type, scope, channel, and search query', () => {
    const rows = buildFileBrowserRows(store);

    expect(filterFileBrowserRows(rows, { type: 'audio' })).toHaveLength(1);
    expect(filterFileBrowserRows(rows, { source: 'task' }).map((row) => row.object_id)).toEqual(['img-task-1']);
    expect(filterFileBrowserRows(rows, { scopeId: 'scope-1' }).map((row) => row.object_id).sort()).toEqual([
      'doc-content-1',
      'img-comment-1',
      'img-doc-1',
    ]);
    expect(filterFileBrowserRows(rows, { channelId: 'chan-1' }).map((row) => row.object_id).sort()).toEqual([
      'audio-obj-1',
      'file-chat-1',
      'img-chat-1',
    ]);
    expect(filterFileBrowserRows(rows, { type: 'file' }).map((row) => row.object_id)).toEqual(['file-chat-1']);
    expect(filterFileBrowserRows(rows, { query: 'mockup' }).map((row) => row.object_id)).toEqual(['img-task-1']);
  });

  it('carries PG thread context into file rows', () => {
    const rows = buildFileBrowserRows(store);

    expect(filterFileBrowserRows(rows, { contextChannelId: 'chan-1', contextThreadId: 'thread-1' }).map((row) => row.object_id).sort()).toEqual([
      'audio-obj-1',
      'file-chat-1',
      'img-chat-1',
    ]);
  });

  it('carries PG file folder placement into rows and filters by folder', () => {
    const rows = buildFileBrowserRows({
      documents: [{
        record_id: 'file-1',
        title: 'Asset.pdf',
        content: '[Asset.pdf](storage://object-file-1)',
        scope_id: 'scope-1',
        pg_channel_id: 'chan-1',
        pg_folder_id: 'folder-1',
        pg_record_type: 'file',
        updated_at: '2026-05-06T10:00:00.000Z',
      }],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        object_id: 'object-file-1',
        folder_id: 'folder-1',
        channel_id: 'chan-1',
      }),
    ]);
    expect(filterFileBrowserRows(rows, { folderId: 'folder-1' })).toHaveLength(1);
    expect(filterFileBrowserRows(rows, { folderId: '' })).toHaveLength(0);
  });

  it('builds upload queue items from browser files', () => {
    const item = buildFileUploadQueueItem({
      name: 'Plan.pdf',
      type: 'application/pdf',
      size: 4096,
    }, { scopeId: 'scope-1', channelId: 'chan-1', folderId: 'folder-1' });

    expect(item).toMatchObject({
      original_name: 'Plan.pdf',
      name: 'Plan.pdf',
      scope_id: 'scope-1',
      channel_id: 'chan-1',
      folder_id: 'folder-1',
      status: 'queued',
      progress: 0,
      size_bytes: 4096,
      content_type: 'application/pdf',
    });
    expect(item.id).toBeTruthy();
  });

  it('preserves the canonical DOCX content type when the browser omits or generalizes MIME', () => {
    const expected = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(resolveFileUploadContentType({ name: 'PIMPv2_review_for_operator-a.docx', type: '' })).toBe(expected);
    expect(resolveFileUploadContentType({ name: 'PIMPv2_review_for_operator-a.DOCX', type: 'application/octet-stream' })).toBe(expected);
  });

  it('creates a DOCX file with a local record id so optimistic Dexie writes have a valid key', async () => {
    const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const file = {
      name: 'PIMPv2_review_for_operator-a.docx',
      type: contentType,
      size: 4,
      arrayBuffer: vi.fn(async () => new Uint8Array([80, 75, 3, 4]).buffer),
    };
    const uploadStore = Object.assign(Object.create(filesManagerMixin), {
      workspaceOwnerNpub: 'npub1owner',
      fileUploadItems: [buildFileUploadQueueItem(file, { scopeId: 'scope-1', channelId: 'chan-1' })],
      channels: [{ record_id: 'chan-1', scope_id: 'scope-1', record_state: 'active' }],
      fileFolders: [],
      prepareStorageObjectForCurrentWorkspace: vi.fn(async () => ({ object_id: 'storage-docx-1', upload_url: '' })),
      patchDocumentLocal: vi.fn(),
      commandTowerWorkspace: vi.fn(async (_name, input) => ({
        ...input.file,
        record_id: 'server-file-1',
        pg_record_type: 'file',
      })),
    });

    await expect(uploadStore.startFileUploadItem(uploadStore.fileUploadItems[0].id)).resolves.toMatchObject({
      record_id: 'server-file-1',
    });
    expect(uploadStore.commandTowerWorkspace).toHaveBeenCalledWith('file.create', {
      file: expect.objectContaining({
        record_id: expect.any(String),
        display_name: 'PIMPv2_review_for_operator-a.docx',
        storage_object_id: 'storage-docx-1',
      }),
    }, { clientMutationId: expect.any(String) });
    expect(uploadStore.commandTowerWorkspace.mock.calls[0][1].file.record_id).toBe(uploadStore.fileUploadItems[0].id);
  });

  it('closes the uploader before opening destination routing for unscoped files', async () => {
    const openWriteContextModal = vi.fn();
    const uploadStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      session: { npub: 'npub1user' },
      workspaceOwnerNpub: 'npub1owner',
      fileUploadOpen: true,
      resolvePgWriteContext: vi.fn(() => null),
      openWriteContextModal,
    });
    const file = { name: 'Brief.docx', type: '', size: 4 };

    await uploadStore.enqueueFileUploads([file]);

    expect(uploadStore.fileUploadOpen).toBe(false);
    expect(openWriteContextModal).toHaveBeenCalledWith('files', expect.objectContaining({ files: [file] }));
  });

  it('summarizes active upload progress for the toolbar indicator', () => {
    const uploadStore = Object.assign(Object.create(filesManagerMixin), {
      fileUploadItems: [
        { id: 'upload-1', status: 'uploading', progress: 40 },
        { id: 'upload-2', status: 'saving', progress: 80 },
        { id: 'upload-3', status: 'done', progress: 100 },
      ],
    });

    expect(uploadStore.hasActiveFileUploads).toBe(true);
    expect(uploadStore.activeFileUploadCount).toBe(2);
    expect(uploadStore.fileUploadOverallProgress).toBe(60);
    expect(uploadStore.fileUploadToolbarLabel).toBe('2 uploads 60%');
  });

  it('opens editable metadata for PG-backed file rows', () => {
    const fileRow = {
      source_type: 'document',
      source_record_id: 'file-1',
      name: 'Original.pdf',
      scope_id: 'scope-1',
      channel_id: 'chan-1',
      object_id: 'storage-1',
    };
    const editStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      documents: [{
        record_id: 'file-1',
        title: 'Original.pdf',
        pg_backend: true,
        pg_record_type: 'file',
        pg_storage_object_id: 'storage-1',
        scope_id: 'scope-1',
        pg_channel_id: 'chan-1',
        pg_folder_id: 'folder-1',
      }],
      fileFolders: [
        { record_id: 'folder-1', title: 'Assets', scope_id: 'scope-1', channel_id: 'chan-1' },
      ],
      channels: [
        { record_id: 'chan-1', title: 'General', scope_id: 'scope-1', record_state: 'active' },
        { record_id: 'chan-2', title: 'Finance', scope_id: 'scope-2', record_state: 'active' },
      ],
      taskBoards: [
        { id: 'scope-1', label: 'Home', zoom: 'scope' },
        { id: 'scope-2', label: 'Finance', zoom: 'scope' },
      ],
      getChannelLabel(channel) {
        return channel.title;
      },
    });

    editStore.openFileEditModal(fileRow);

    expect(editStore.showFileEditModal).toBe(true);
    expect(editStore.fileEditName).toBe('Original.pdf');
    expect(editStore.fileEditScopeId).toBe('scope-1');
    expect(editStore.fileEditChannelId).toBe('chan-1');
    expect(editStore.fileEditFolderId).toBe('folder-1');
    expect(editStore.fileEditContextChanged).toBe(false);

    editStore.selectFileEditScope('scope-2');

    expect(editStore.fileEditChannelId).toBe('chan-2');
    expect(editStore.fileEditFolderId).toBe('');
    expect(editStore.fileEditContextChanged).toBe(true);
  });

  it('optimistically saves file moves while Tower confirmation runs in the background', async () => {
    let confirmMove;
    updateTowerPgFileFromLocal.mockReturnValueOnce(new Promise((resolve) => {
      confirmMove = () => resolve({
        record_id: 'file-1',
        title: 'Original.pdf',
        pg_backend: true,
        pg_record_type: 'file',
        pg_storage_object_id: 'storage-1',
        scope_id: 'scope-1',
        pg_channel_id: 'chan-1',
        pg_folder_id: 'folder-1',
        version: 2,
      });
    }));
    const editStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      documents: [{
        record_id: 'file-1',
        title: 'Original.pdf',
        content: '[Original.pdf](storage://storage-1)',
        pg_backend: true,
        pg_record_type: 'file',
        pg_storage_object_id: 'storage-1',
        scope_id: 'scope-1',
        pg_channel_id: 'chan-1',
        pg_folder_id: null,
        version: 1,
      }],
      fileFolders: [
        { record_id: 'folder-1', title: 'Assets', scope_id: 'scope-1', channel_id: 'chan-1' },
      ],
      channels: [
        { record_id: 'chan-1', title: 'General', scope_id: 'scope-1', record_state: 'active' },
      ],
      buildScopeAssignment(scopeId) {
        return { scope_id: scopeId };
      },
      resolveFileUploadChannel(scopeId, channelId) {
        return this.channels.find((channel) => channel.scope_id === scopeId && channel.record_id === channelId);
      },
      patchDocumentLocal: vi.fn(function patchDocumentLocal(document) {
        this.documents = this.documents.map((entry) => entry.record_id === document.record_id ? document : entry);
      }),
      scheduleDocumentsRefresh: vi.fn(),
    });
    const row = buildFileBrowserRows(editStore).find((entry) => entry.source_record_id === 'file-1');

    const moved = await editStore.moveFileBrowserRowToContext(row, {
      scopeId: 'scope-1',
      channelId: 'chan-1',
      folderId: 'folder-1',
      background: true,
    });

    expect(moved).toMatchObject({ pg_folder_id: 'folder-1', sync_status: 'pending' });
    expect(upsertDocument).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'file-1', pg_folder_id: 'folder-1' }));
    expect(updateTowerPgFileFromLocal).toHaveBeenCalledTimes(1);
    expect(editStore.scheduleDocumentsRefresh).not.toHaveBeenCalled();

    confirmMove();
    await Promise.resolve();
    await Promise.resolve();

    expect(editStore.scheduleDocumentsRefresh).not.toHaveBeenCalled();
  });

  it('selects multiple visible files and moves them to a dropped folder', async () => {
    const moveStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      pgContextSelectedChannelId: 'chan-1',
      pgContextSelectedThreadId: '',
      fileSearch: '',
      fileTypeFilter: 'all',
      fileSourceFilter: 'all',
      fileScopeFilter: 'all',
      fileChannelFilter: 'all',
      fileThreadFilter: 'all',
      fileCurrentFolderId: '',
      fileSelectedRowIds: [],
      fileSelectionMode: true,
      documents: [
        {
          record_id: 'file-1',
          title: 'One.pdf',
          content: '[One.pdf](storage://storage-1)',
          pg_backend: true,
          pg_record_type: 'file',
          pg_storage_object_id: 'storage-1',
          scope_id: 'scope-1',
          pg_channel_id: 'chan-1',
          pg_folder_id: null,
          version: 1,
        },
        {
          record_id: 'file-2',
          title: 'Two.pdf',
          content: '[Two.pdf](storage://storage-2)',
          pg_backend: true,
          pg_record_type: 'file',
          pg_storage_object_id: 'storage-2',
          scope_id: 'scope-1',
          pg_channel_id: 'chan-1',
          pg_folder_id: null,
          version: 1,
        },
      ],
      fileFolders: [
        { record_id: 'folder-1', title: 'Assets', scope_id: 'scope-1', channel_id: 'chan-1', record_state: 'active' },
      ],
      channels: [
        { record_id: 'chan-1', title: 'General', scope_id: 'scope-1', record_state: 'active' },
      ],
      buildScopeAssignment(scopeId) {
        return { scope_id: scopeId };
      },
      resolveFileUploadChannel(scopeId, channelId) {
        return this.channels.find((channel) => channel.scope_id === scopeId && channel.record_id === channelId);
      },
      patchDocumentLocal: vi.fn(function patchDocumentLocal(document) {
        this.documents = this.documents.map((entry) => entry.record_id === document.record_id ? document : entry);
      }),
      scheduleDocumentsRefresh: vi.fn(),
    });
    const rows = moveStore.filteredFileBrowserRows;
    moveStore.toggleFileRowSelection(rows[0], true);
    moveStore.toggleFileRowSelection(rows[1], true);
    moveStore.fileDraggingRowIds = rows.map((row) => row.id);
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => ''),
      },
    };

    await moveStore.handleFileFolderDrop(moveStore.fileFolders[0], event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(moveStore.fileSelectedRowIds).toEqual([]);
    expect(upsertDocument).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'file-1', pg_folder_id: 'folder-1' }));
    expect(upsertDocument).toHaveBeenCalledWith(expect.objectContaining({ record_id: 'file-2', pg_folder_id: 'folder-1' }));
    expect(updateTowerPgFileFromLocal).toHaveBeenCalledTimes(2);
  });

  it('shows scoped PG folders when no single channel is selected', () => {
    const scopeStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      pgContextScopeId: 'scope-1',
      pgContextSelectedChannelId: '',
      pgContextSelectedThreadId: '',
      pgContextChannels: [
        { record_id: 'chan-1', scope_id: 'scope-1', record_state: 'active' },
      ],
      scopesMap: new Map(),
      fileSearch: '',
      fileTypeFilter: 'all',
      fileSourceFilter: 'all',
      fileScopeFilter: 'all',
      fileChannelFilter: 'all',
      fileThreadFilter: 'all',
      fileCurrentFolderId: '',
      documents: [
        {
          record_id: 'file-1',
          title: 'Visible.pdf',
          content: '[Visible.pdf](storage://storage-1)',
          pg_backend: true,
          pg_record_type: 'file',
          pg_storage_object_id: 'storage-1',
          scope_id: 'scope-1',
          pg_channel_id: 'chan-1',
          pg_folder_id: null,
        },
        {
          record_id: 'file-2',
          title: 'Hidden.pdf',
          content: '[Hidden.pdf](storage://storage-2)',
          pg_backend: true,
          pg_record_type: 'file',
          pg_storage_object_id: 'storage-2',
          scope_id: 'scope-2',
          pg_channel_id: 'chan-2',
          pg_folder_id: null,
        },
      ],
      tasks: [],
      fileMessages: [],
      fileComments: [],
      audioNotes: [],
      fileFolders: [
        { record_id: 'folder-1', title: 'Assets', scope_id: 'scope-1', channel_id: 'chan-1', parent_folder_id: '', record_state: 'active' },
        { record_id: 'folder-2', title: 'Other', scope_id: 'scope-2', channel_id: 'chan-2', parent_folder_id: '', record_state: 'active' },
      ],
      channels: [
        { record_id: 'chan-1', title: 'General', scope_id: 'scope-1', record_state: 'active' },
        { record_id: 'chan-2', title: 'Other', scope_id: 'scope-2', record_state: 'active' },
      ],
    });

    expect(scopeStore.currentFileChildFolders.map((folder) => folder.record_id)).toEqual(['folder-1']);
    expect(scopeStore.filteredFileBrowserRows.map((row) => row.source_record_id)).toEqual(['file-1']);

    scopeStore.selectFileFolder('folder-1');

    expect(scopeStore.currentFileFolderId).toBe('folder-1');
    expect(scopeStore.currentFileChannelId).toBe('chan-1');
    expect(scopeStore.currentFileFolderBreadcrumbs.map((folder) => folder.record_id)).toEqual(['folder-1']);
  });

  it('preserves PG file folders when leaving the files section', () => {
    const shell = {
      fileFolders: [{ record_id: 'folder-1', title: 'Assets' }],
      fileCurrentFolderId: 'folder-1',
      fileSelectionMode: true,
      fileSelectedRowIds: ['row-1'],
      fileDraggingRowIds: ['row-1'],
      fileFolderDragOverId: 'folder-1',
      fileMessages: [{ record_id: 'msg-1' }],
      fileComments: [{ record_id: 'comment-1' }],
    };

    function clearInactiveFilesData(activeSection) {
      if (activeSection !== 'files') {
        shell.fileSelectionMode = false;
        shell.fileSelectedRowIds = [];
        shell.fileDraggingRowIds = [];
        shell.fileFolderDragOverId = '';
        shell.fileMessages = [];
        shell.fileComments = [];
      }
    }

    clearInactiveFilesData('chat');

    expect(shell.fileFolders).toEqual([{ record_id: 'folder-1', title: 'Assets' }]);
    expect(shell.fileCurrentFolderId).toBe('folder-1');
    expect(shell.fileSelectionMode).toBe(false);
    expect(shell.fileSelectedRowIds).toEqual([]);
    expect(shell.fileMessages).toEqual([]);
    expect(shell.fileComments).toEqual([]);
  });

  it('persists newly created PG file folders locally', async () => {
    const folder = {
      record_id: 'folder-1',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      title: 'Assets',
      record_state: 'active',
    };
    createTowerPgFileFolderFromLocal.mockResolvedValueOnce(folder);
    const originalWindow = globalThis.window;
    globalThis.window = { prompt: vi.fn(() => 'Assets') };
    const createStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      pgContextSelectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1' }],
      fileFolders: [],
      fileCurrentFolderId: '',
      fileSelectedRowIds: [],
      applyFileFolders(folders) {
        this.fileFolders = folders;
      },
      selectFileFolder(folderId) {
        this.fileCurrentFolderId = folderId;
      },
    });

    try {
      await createStore.createFileFolderFromPrompt();
    } finally {
      globalThis.window = originalWindow;
    }

    expect(upsertFileFolder).toHaveBeenCalledWith(folder);
    expect(createStore.fileFolders).toEqual([folder]);
    expect(createStore.fileCurrentFolderId).toBe('folder-1');
  });

  it('does not report file edit context changes when no file is being edited', () => {
    const editStore = Object.assign(Object.create(filesManagerMixin), {
      fileEditRow: null,
      documents: [null],
      fileEditScopeId: 'scope-1',
      fileEditChannelId: 'chan-1',
    });

    expect(editStore.fileEditContextChanged).toBe(false);
  });

  it('recognizes imported text and markdown files as convertible documents', () => {
    expect(isConvertibleTextFile({ name: 'Notes.md' })).toBe(true);
    expect(isConvertibleTextFile({ name: 'brief.txt' })).toBe(true);
    expect(isConvertibleTextFile({ name: 'capture.bin', content_type: 'text/markdown' })).toBe(true);
    expect(isConvertibleTextFile({ name: 'deck.pdf', content_type: 'application/pdf' })).toBe(false);
  });

  it('converts an editable text file row into a Wingman document', async () => {
    downloadStorageObject.mockResolvedValue(new TextEncoder().encode('# Imported\n\nBody text'));
    const createdDoc = { record_id: 'doc-converted' };
    const editStore = Object.assign(Object.create(filesManagerMixin), {
      isTowerPgMode: true,
      fileEditSubmitting: false,
      fileEditRow: {
        source_type: 'document',
        source_record_id: 'file-1',
        name: 'Imported.md',
        scope_id: 'scope-1',
        channel_id: 'chan-1',
        thread_id: 'thread-1',
        object_id: 'storage-1',
      },
      fileEditName: 'Imported.md',
      fileEditScopeId: 'scope-1',
      fileEditChannelId: 'chan-1',
      fileEditError: '',
      showFileEditModal: true,
      documents: [{
        record_id: 'file-1',
        title: 'Imported.md',
        pg_backend: true,
        pg_record_type: 'file',
        pg_storage_object_id: 'storage-1',
        scope_id: 'scope-1',
        pg_channel_id: 'chan-1',
        pg_thread_id: 'thread-1',
      }],
      createDocument: vi.fn(async function createDocument() {
        expect(this.fileEditAction).toBe('convert');
        expect(this.fileEditProgressText).toBe('Creating Wingman Doc...');
        return createdDoc;
      }),
      navigateTo: vi.fn(),
      openDoc: vi.fn(),
      enterSelectedDocEditMode: vi.fn(async function enterSelectedDocEditMode() {
        expect(this.fileEditProgressText).toBe('Opening document editor...');
        return true;
      }),
    });

    const result = await editStore.convertFileEditRowToDocument();

    expect(result).toBe(createdDoc);
    expect(downloadStorageObject).toHaveBeenCalledWith('storage-1');
    expect(editStore.createDocument).toHaveBeenCalledWith('Imported', {
      scopeId: 'scope-1',
      channelId: 'chan-1',
      threadId: 'thread-1',
      initialContent: '# Imported\n\nBody text',
    });
    expect(editStore.navigateTo).toHaveBeenCalledWith('docs');
    expect(editStore.openDoc).toHaveBeenCalledWith('doc-converted');
    expect(editStore.enterSelectedDocEditMode).toHaveBeenCalledWith('rich');
    expect(editStore.showFileEditModal).toBe(false);
    expect(editStore.fileEditAction).toBe('');
    expect(editStore.fileEditProgressText).toBe('');
  });
});
