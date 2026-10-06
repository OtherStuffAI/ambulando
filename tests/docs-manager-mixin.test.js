import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { shortRichDocumentFixture } from './fixtures/short-rich-document.js';
import { richBreakDocumentFixture } from './fixtures/rich-break-document.js';
import { validateDocumentContentModelRoundTrip } from '../src/docs/editor/document-content-integrity.js';

const {
  acquireRecordCheckoutMock,
  completeStorageObjectMock,
  createTowerPgChannelDocMock,
  deleteTowerPgDocCommentMock,
  createTowerPgDocCommentMock,
  downloadStorageObjectMock,
  getTowerPgDocVersionsMock,
  getTowerPgDocRecoveriesMock,
  getTowerPgDocRecoveryMock,
  getTowerPgDocRecoveryBodyMock,
  getTowerPgChannelDocsMock,
  promoteTowerPgDocRecoveryMock,
  discardTowerPgDocRecoveryMock,
  getTowerPgEditLeaseMock,
  isTowerPgBackendModeMock,
  prepareStorageObjectMock,
  prepareTowerPgStorageObjectMock,
  releaseRecordCheckoutMock,
  acquireTowerPgEditLeaseMock,
  releaseTowerPgEditLeaseMock,
  updateTowerPgDocMock,
  updateTowerPgDocCommentMock,
  uploadStorageObjectMock,
} = vi.hoisted(() => ({
  acquireRecordCheckoutMock: vi.fn(),
  acquireTowerPgEditLeaseMock: vi.fn(),
  completeStorageObjectMock: vi.fn(),
  createTowerPgChannelDocMock: vi.fn(),
  createTowerPgDocCommentMock: vi.fn(),
  deleteTowerPgDocCommentMock: vi.fn(),
  downloadStorageObjectMock: vi.fn(),
  getTowerPgDocVersionsMock: vi.fn(),
  getTowerPgDocRecoveriesMock: vi.fn(),
  getTowerPgDocRecoveryMock: vi.fn(),
  getTowerPgDocRecoveryBodyMock: vi.fn(),
  getTowerPgChannelDocsMock: vi.fn(),
  promoteTowerPgDocRecoveryMock: vi.fn(),
  discardTowerPgDocRecoveryMock: vi.fn(),
  getTowerPgEditLeaseMock: vi.fn(),
  isTowerPgBackendModeMock: vi.fn(() => false),
  prepareStorageObjectMock: vi.fn(),
  prepareTowerPgStorageObjectMock: vi.fn(),
  releaseRecordCheckoutMock: vi.fn(),
  releaseTowerPgEditLeaseMock: vi.fn(),
  updateTowerPgDocMock: vi.fn(),
  updateTowerPgDocCommentMock: vi.fn(),
  uploadStorageObjectMock: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  acquireRecordCheckout: acquireRecordCheckoutMock,
  acquireTowerPgEditLease: acquireTowerPgEditLeaseMock,
  completeStorageObject: completeStorageObjectMock,
  createTowerPgChannelAudioNote: vi.fn(),
  createTowerPgChannelDoc: createTowerPgChannelDocMock,
  createTowerPgDocComment: createTowerPgDocCommentMock,
  deleteTowerPgDocComment: deleteTowerPgDocCommentMock,
  createTowerPgChannelFile: vi.fn(),
  createTowerPgChannelMessage: vi.fn(),
  createTowerPgChannelTask: vi.fn(),
  downloadStorageObject: downloadStorageObjectMock,
  fetchRecordHistory: vi.fn(),
  getTowerPgChannelAudioNotes: vi.fn(),
  getTowerPgChannelDocs: getTowerPgChannelDocsMock,
  getTowerPgChannelFiles: vi.fn(),
  getTowerPgChannelMessages: vi.fn(),
  getTowerPgChannelTasks: vi.fn(),
  getTowerPgChannelThreads: vi.fn(),
  getTowerPgDocVersions: getTowerPgDocVersionsMock,
  getTowerPgDocRecoveries: getTowerPgDocRecoveriesMock,
  getTowerPgDocRecovery: getTowerPgDocRecoveryMock,
  getTowerPgDocRecoveryBody: getTowerPgDocRecoveryBodyMock,
  getTowerPgEditLease: getTowerPgEditLeaseMock,
  getTowerPgScopeChannels: vi.fn(),
  getTowerPgScopeTasks: vi.fn(),
  getTowerPgWorkspaceScopes: vi.fn(),
  prepareStorageObject: prepareStorageObjectMock,
  prepareTowerPgStorageObject: prepareTowerPgStorageObjectMock,
  promoteTowerPgDocRecovery: promoteTowerPgDocRecoveryMock,
  discardTowerPgDocRecovery: discardTowerPgDocRecoveryMock,
  releaseRecordCheckout: releaseRecordCheckoutMock,
  releaseTowerPgEditLease: releaseTowerPgEditLeaseMock,
  renewTowerPgEditLease: vi.fn(),
  updateTowerPgDoc: updateTowerPgDocMock,
  updateTowerPgDocComment: updateTowerPgDocCommentMock,
  updateTowerPgTask: vi.fn(),
  updateTowerPgTaskState: vi.fn(),
  uploadStorageObject: uploadStorageObjectMock,
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: isTowerPgBackendModeMock,
}));

import {
  DOCUMENT_LOCAL_DRAFT_DELAY_MS,
  DOCUMENT_REMOTE_AUTOSAVE_DELAY_MS,
  docsManagerMixin,
  isDocumentContentReadyForEditor,
  mergeDocumentSaveReferences,
} from '../src/docs-manager.js';
import {
  getDocumentById,
  getDocumentDraft,
  getPendingWrites,
  openWorkspaceDb,
  upsertDocumentDraft,
  upsertDocument,
} from '../src/db.js';
import { isCheckoutHeld } from '../src/lock-managed-records.js';
import {
  DOCUMENT_CONTENT_STORAGE_FORMAT,
  DOCUMENT_CONTENT_STORAGE_MIME,
} from '../src/translators/docs.js';
import { FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT } from '../src/docs/editor/prosemirror-flightdeck-schema.js';
import { createDocumentEditorState } from '../src/docs/editor/document-editor-store.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';
import { prosemirrorToFlightDeckContentModel } from '../src/docs/editor/prosemirror-to-flightdeck.js';
import { buildSyntheticLongDocumentFixture } from './fixtures/synthetic-long-document.js';
import {
  cacheGroupKey,
  clearCryptoContext,
  createGroupIdentity,
} from '../src/crypto/group-keys.js';
import { recordFamilyHash } from '../src/translators/chat.js';
import { prepareTowerWorkspaceCommand } from '../src/tower-command-port.js';
import { TowerSyncService } from '../src/tower-sync-service.js';
import { createTowerPgDocFromLocal } from '../src/pg-write-adapter.js';

function createStore(overrides = {}) {
  const store = {
    ...docsManagerMixin,
    lockManagedCheckoutSessions: {},
    documents: [],
    selectedDocType: null,
    selectedDocId: null,
    selectedDocCommentId: null,
    navSection: 'docs',
    mobileNavOpen: false,
    currentFolderId: null,
    docCommentBackfillAttemptsByDocId: {},
    session: { npub: 'npub1owner' },
    currentWorkspace: { creatorNpub: 'npub1owner' },
    docAutosaveState: 'saved',
    docEditAccessGeneration: 0,
    docEditAccessState: 'ready',
    docEditAccessMessage: '',
    docEditDraftDirty: false,
    docEditAcquirePromise: null,
    pgEditLeaseSessions: {},
    error: '',
    loadDocEditorFromSelection: vi.fn(),
    loadDocComments: vi.fn(),
    stopDocCommentsLiveQuery: vi.fn(),
    clearDocCommentConnector: vi.fn(),
    scheduleDocCommentConnectorUpdate: vi.fn(),
    scheduleStorageImageHydration: vi.fn(),
    syncRoute: vi.fn(),
    ensureBackgroundSync: vi.fn(),
    containsInlineImageUploadToken: vi.fn(() => false),
    resolvePgWriteContext: vi.fn((context = {}) => {
      const channelId = context.channelId || store.selectedChannelId || store.selectedChannel?.record_id || null;
      const channel = channelId
        ? (store.channels || []).find((item) => item.record_id === channelId) || null
        : null;
      const scopeId = context.scopeId || channel?.scope_id || channel?.scope_l1_id || null;
      if (!scopeId || !channelId) return null;
      return {
        scopeId,
        channelId,
        threadId: context.threadId || null,
        channel,
      };
    }),
    patchDocumentLocal: vi.fn(function patchDocumentLocal(nextDocument) {
      const index = this.documents.findIndex((item) => item.record_id === nextDocument.record_id);
      if (index >= 0) {
        this.documents.splice(index, 1, { ...this.documents[index], ...nextDocument });
      } else {
        this.documents = [...this.documents, nextDocument];
      }
    }),
    buildLockManagedCheckoutIdentityContext: vi.fn(() => ({
      workspaceServiceNpub: 'npub1workspace',
      userNpub: 'npub1owner',
      workspaceUserKeyNpub: 'npub1workspacekey',
      signerNpub: 'npub1workspacekey',
    })),
    ...overrides,
  };

  Object.defineProperty(store, 'selectedDocument', {
    configurable: true,
    get() {
      return store.documents.find((item) => item.record_id === store.selectedDocId) || null;
    },
  });

  Object.defineProperty(store, 'selectedDocComment', {
    configurable: true,
    get() {
      return (store.docComments || []).find((comment) => comment.record_id === store.selectedDocCommentId) || null;
    },
  });

  return store;
}

beforeEach(() => {
  isTowerPgBackendModeMock.mockReturnValue(false);
  createTowerPgChannelDocMock.mockReset();
  createTowerPgDocCommentMock.mockReset();
  updateTowerPgDocCommentMock.mockReset();
  deleteTowerPgDocCommentMock.mockReset();
  getTowerPgDocVersionsMock.mockReset();
  getTowerPgDocRecoveriesMock.mockReset();
  getTowerPgDocRecoveryMock.mockReset();
  getTowerPgDocRecoveryBodyMock.mockReset();
  getTowerPgChannelDocsMock.mockReset();
  getTowerPgChannelDocsMock.mockResolvedValue({ docs: [] });
  promoteTowerPgDocRecoveryMock.mockReset();
  discardTowerPgDocRecoveryMock.mockReset();
  getTowerPgEditLeaseMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  vi.unstubAllGlobals();
});

describe('docsManagerMixin record link save references', () => {
  it('preserves existing generic references when autosave adds parsed mentions', () => {
    const references = mergeDocumentSaveReferences({
      record_id: 'doc-1',
      source_links: [{ type: 'task', id: 'task-source' }],
      references: [
        { type: 'scope', id: 'scope-existing' },
        { type: 'task', id: 'task-source' },
      ],
      deliverable_links: [{ type: 'doc', id: 'doc-output' }],
    }, [
      { type: 'task', id: 'task-mentioned' },
      { type: 'scope', id: 'scope-existing' },
      { type: 'doc', id: 'doc-output' },
    ]);

    expect(references).toEqual([
      { type: 'scope', id: 'scope-existing' },
      { type: 'task', id: 'task-mentioned' },
    ]);
  });
});

describe('docsManagerMixin.getMissingDocGroupRefs', () => {
  beforeEach(() => {
    acquireRecordCheckoutMock.mockReset();
    releaseRecordCheckoutMock.mockReset();
    acquireTowerPgEditLeaseMock.mockReset();
    releaseTowerPgEditLeaseMock.mockReset();
  });

  afterEach(() => {
    clearCryptoContext();
    vi.restoreAllMocks();
  });

  it('returns missing group refs even when at least one group key is loaded', () => {
    const loadedIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'group-loaded',
      group_npub: 'npub1loadedgroup',
      nsec: loadedIdentity.nsec,
    });

    const store = createStore();

    const missing = docsManagerMixin.getMissingDocGroupRefs.call(store, {
      group_ids: ['group-loaded', 'group-missing'],
    });

    expect(missing).toEqual(['group-missing']);
  });

  it('allows write flow to proceed when at least one delivery group key is loaded', async () => {
    const loadedIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'group-loaded',
      group_npub: 'npub1loadedgroup',
      nsec: loadedIdentity.nsec,
    });

    const store = createStore();
    const missing = await docsManagerMixin.ensureDocGroupKeysLoaded.call(store, {
      group_ids: ['group-loaded', 'group-missing'],
    });

    expect(missing).toEqual([]);
  });

  it('fails write flow when no delivery group keys are loaded', async () => {
    const store = createStore();
    const missing = await docsManagerMixin.ensureDocGroupKeysLoaded.call(store, {
      group_ids: ['group-a', 'group-b'],
    });

    expect(missing).toEqual(['group-a', 'group-b']);
  });

  it('fails doc comment payload targets when any document group key is missing', () => {
    const loadedIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'group-loaded',
      group_npub: 'npub1loadedgroup',
      nsec: loadedIdentity.nsec,
    });

    const store = createStore();
    const groupIds = docsManagerMixin.getEncryptableDocCommentGroupIds.call(store, {
      group_ids: ['group-loaded', 'group-missing'],
    });

    expect(groupIds).toBeNull();
    expect(store.error).toContain('group-missing');
  });

  it('fails doc comment payload targets when no group keys are loaded', () => {
    const store = createStore();
    const groupIds = docsManagerMixin.getEncryptableDocCommentGroupIds.call(store, {
      group_ids: ['group-a', 'group-b'],
    });

    expect(groupIds).toBeNull();
    expect(store.error).toContain('Document comment write is missing group keys');
  });

  it('refreshes group keys before choosing doc comment payload targets', async () => {
    const loadedIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'group-loaded',
      group_npub: 'npub1loadedgroup',
      nsec: loadedIdentity.nsec,
    });

    const refreshedIdentity = createGroupIdentity();
    const refreshGroups = vi.fn(async () => {
      cacheGroupKey({
        group_id: 'group-refreshed',
        group_npub: 'npub1refreshedgroup',
        nsec: refreshedIdentity.nsec,
      });
    });
    const store = createStore({ refreshGroups });

    const groupIds = await docsManagerMixin.getEncryptableDocCommentGroupIdsForWrite.call(store, {
      group_ids: ['group-loaded', 'group-refreshed'],
    });

    expect(refreshGroups).toHaveBeenCalledWith({ force: true });
    expect(groupIds).toEqual(['group-loaded', 'group-refreshed']);
  });
});

describe('docsManagerMixin comment loading', () => {
  beforeEach(() => {
    acquireRecordCheckoutMock.mockReset();
    releaseRecordCheckoutMock.mockReset();
  });

  afterEach(() => {
    clearCryptoContext();
    vi.restoreAllMocks();
  });

  it('applies comments returned by an explicit backfill from the live-query path', async () => {
    const backfilledComment = {
      record_id: 'comment-1',
      target_record_id: 'doc-1',
      target_record_family_hash: recordFamilyHash('document'),
      parent_comment_id: null,
      body: 'Visible after backfill',
      sender_npub: 'npub1other',
      record_state: 'active',
      version: 1,
      updated_at: '2026-04-26T00:00:00.000Z',
    };
    const store = createStore({
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      docComments: [],
      rememberPeople: vi.fn(async () => {}),
      scheduleDocCommentConnectorUpdate: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      backfillDocCommentsFromBackend: vi.fn(async () => [backfilledComment]),
    });

    await store.applyDocComments([], { allowBackfill: true });

    expect(store.backfillDocCommentsFromBackend).toHaveBeenCalledWith('doc-1', recordFamilyHash('document'));
    expect(store.docComments).toEqual([backfilledComment]);
  });

  it('mounts the PG live query before forcing authoritative comment hydration', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const calls = [];
    const store = createStore({
      loadDocComments: docsManagerMixin.loadDocComments,
      startDocCommentsLiveQuery: vi.fn(() => calls.push('live-query')),
      requestTowerSyncFamily: vi.fn(async (...args) => calls.push(['hydrate', ...args])),
    });

    await store.loadDocComments('doc-1', { force: true });

    expect(calls).toEqual([
      'live-query',
      ['hydrate', 'document-comments', 'doc-1', { force: true }],
    ]);
  });

  it('keeps a populated PG comment tree when refresh fails', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const existing = [{ record_id: 'comment-1', target_record_id: 'doc-1' }];
    const store = createStore({
      loadDocComments: docsManagerMixin.loadDocComments,
      docComments: existing,
      startDocCommentsLiveQuery: vi.fn(),
      requestTowerSyncFamily: vi.fn(async () => {
        throw new Error('temporary read failure');
      }),
      applyDocComments: vi.fn(),
    });

    await store.loadDocComments('doc-1', { force: true });

    expect(store.docComments).toBe(existing);
    expect(store.applyDocComments).not.toHaveBeenCalled();
    expect(store.error).toBe('temporary read failure');
  });
});

describe('docsManagerMixin comment drawer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the doc comments drawer collapsed when opening a document normally', () => {
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: 'dir-1' }],
      docCommentsVisible: true,
    });

    store.openDoc('doc-1');

    expect(store.docCommentsVisible).toBe(false);
    expect(store.docMobilePane).toBe('document');
    expect(store.selectedDocCommentId).toBeNull();
  });

  it('loads the hydrated body on first navigation even while the selected collection row is stale', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const prefetchFlightDeckDoc = vi.fn(async () => ({
      record_id: 'doc-1',
      title: 'Fresh doc',
      content: '# Fresh',
      content_blocks: [],
      record_state: 'active',
    }));
    const store = createStore({
      documents: [{ record_id: 'doc-1', title: 'Cached doc', content: '', record_state: 'active' }],
      prefetchFlightDeckDoc,
      loadDocEditorFromSelection: docsManagerMixin.loadDocEditorFromSelection,
      getEffectiveDocShares: vi.fn(() => []),
      destroyDocRichEditor: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
    });

    store.openDoc('doc-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(prefetchFlightDeckDoc).toHaveBeenCalledWith('doc-1');
    expect(store.selectedDocument.content).toBe('');
    await vi.waitFor(() => expect(store.docEditorTitle).toBe('Fresh doc'));
    expect(store.docEditorContent).toBe('# Fresh');
    expect(store.docEditorBlocks).toMatchObject([{ raw: '# Fresh' }]);
  });

  it('rejects a late hydration from an earlier visit to the same page or another workspace', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const replies = [];
    const store = createStore({
      documents: [{ record_id: 'a' }, { record_id: 'b' }],
      currentWorkspace: { workspaceId: 'one' },
      hydrateSelectedDocWithRetry: vi.fn(() => new Promise(resolve => replies.push(resolve))),
      applySelectedDocAuthoritativeContent: vi.fn(),
    });
    store.openDoc('a'); store.openDoc('b'); store.openDoc('a');
    replies[0]({ record_id: 'a', content: 'Old visit' });
    replies[1]({ record_id: 'b', content: 'Wrong page' });
    await Promise.resolve(); await Promise.resolve();
    expect(store.applySelectedDocAuthoritativeContent).not.toHaveBeenCalled();
    store.currentWorkspace = { workspaceId: 'two' };
    replies[2]({ record_id: 'a', content: 'Wrong workspace' });
    await Promise.resolve(); await Promise.resolve();
    expect(store.applySelectedDocAuthoritativeContent).not.toHaveBeenCalled();
  });

  it('refreshes a clean local page in place without remounting and waits for local draft restoration', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    let restore;
    const draftRestore = new Promise(resolve => { restore = resolve; });
    const store = createStore({
      documents: [{ record_id: 'a', content: 'Cached' }],
      docDraftRestorePromise: draftRestore,
      hydrateSelectedDocWithRetry: vi.fn(async () => ({ record_id: 'a', content: 'Fresh' })),
      applySelectedDocAuthoritativeContent: vi.fn(),
    });
    store.openDoc('a');
    await Promise.resolve();
    expect(store.applySelectedDocAuthoritativeContent).not.toHaveBeenCalled();
    restore();
    await vi.waitFor(() => expect(store.applySelectedDocAuthoritativeContent).toHaveBeenCalledOnce());
    expect(store.loadDocEditorFromSelection).toHaveBeenCalledOnce();
  });

  it('keeps an inline storage preview read-only while the typed body is still hydrating', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    acquireTowerPgEditLeaseMock.mockClear();
    updateTowerPgDocMock.mockClear();
    const preview = 'x'.repeat(8_192);
    let resolvePrefetch;
    const prefetchFlightDeckDoc = vi.fn(() => new Promise((resolve) => {
      resolvePrefetch = resolve;
    }));
    const remote = {
      record_id: 'doc-storage-preview',
      title: 'Storage preview',
      content: preview,
      content_blocks: [],
      editor_state: null,
      content_storage_object_id: 'object-storage-preview',
      content_storage_status: 'remote',
      content_size_bytes: 12_000,
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'synced',
      scope_id: 'scope-1',
      record_state: 'active',
      version: 7,
    };
    const store = createStore({
      documents: [remote],
      prefetchFlightDeckDoc,
      loadDocEditorFromSelection: docsManagerMixin.loadDocEditorFromSelection,
      getEffectiveDocShares: vi.fn(() => []),
      destroyDocRichEditor: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
      inspectSelectedDocEditLease: vi.fn(),
      docEditorRichFeatureEnabled: true,
      workspaceOwnerNpub: 'npub1owner',
    });

    store.openDoc(remote.record_id);

    expect(store.docEditorContent).toBe(preview);
    expect(store.isSelectedDocContentReadyForEditor()).toBe(false);
    expect(store.isSelectedDocDraftReadyForPersistence()).toBe(false);
    expect(store.isSelectedDocRichEditorEditable()).toBe(false);
    await expect(store.beginSelectedDocLeaseAcquisition()).resolves.toBe(false);
    await expect(store.saveSelectedPgDocItem(remote, 'npub1owner', { autosave: false })).resolves.toBe(remote);
    expect(acquireTowerPgEditLeaseMock).not.toHaveBeenCalled();
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();

    resolvePrefetch(null);
    await Promise.resolve();
  });

  it('marks an exhausted authoritative body load as recovery-saveable after bounded retries', async () => {
    const wsDb = openWorkspaceDb('doc-hydration-retry');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    const remote = {
      record_id: 'doc-retry',
      title: 'Retry body',
      content: 'Inline preview',
      content_blocks: [],
      editor_state: null,
      content_storage_object_id: 'storage-retry',
      content_storage_status: 'remote',
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'synced',
      version: 3,
    };
    const prefetchFlightDeckDoc = vi.fn().mockResolvedValue(null);
    const store = createStore({
      documents: [remote],
      selectedDocType: 'document',
      selectedDocId: remote.record_id,
      prefetchFlightDeckDoc,
    });

    await expect(store.hydrateSelectedDocWithRetry(remote.record_id, { delays: [0, 0] })).resolves.toMatchObject({
      content_storage_status: 'error',
    });

    expect(prefetchFlightDeckDoc).toHaveBeenCalledTimes(2);
    expect(prefetchFlightDeckDoc).toHaveBeenNthCalledWith(1, remote.record_id);
    expect(prefetchFlightDeckDoc).toHaveBeenNthCalledWith(2, remote.record_id, { force: true });
    expect(store.selectedDocument.content_storage_status).toBe('error');
    expect(store.isSelectedDocDraftReadyForPersistence()).toBe(true);
  });

  it('does not replace an active pasted draft when document hydration finishes late', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    let resolvePrefetch;
    const prefetchFlightDeckDoc = vi.fn(() => new Promise((resolve) => {
      resolvePrefetch = resolve;
    }));
    const store = createStore({
      documents: [{ record_id: 'doc-1', title: 'New doc', content: '', record_state: 'active' }],
      prefetchFlightDeckDoc,
      docEditorMode: 'preview',
      docEditorContent: '',
      docEditorBlocks: [],
    });

    store.openDoc('doc-1');
    store.docEditorMode = 'rich';
    store.docEditorContent = '# Pasted update';
    store.docEditorBlocks = [{ id: 'draft-block', raw: '# Pasted update' }];

    resolvePrefetch({
      record_id: 'doc-1',
      title: 'New doc',
      content: '',
      content_blocks: [],
      record_state: 'active',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.docEditorMode).toBe('rich');
    expect(store.docEditorContent).toBe('# Pasted update');
    expect(store.docEditorBlocks).toEqual([{ id: 'draft-block', raw: '# Pasted update' }]);
  });

  it('clears previous document comments immediately when switching documents', () => {
    const store = createStore({
      documents: [
        { record_id: 'doc-1', parent_directory_id: 'dir-1' },
        { record_id: 'doc-2', parent_directory_id: 'dir-2' },
      ],
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      selectedDocCommentId: 'comment-1',
      docComments: [{
        record_id: 'comment-1',
        target_record_id: 'doc-1',
        target_record_family_hash: recordFamilyHash('document'),
        body: 'Previous doc comment',
        record_state: 'active',
      }],
      docCommentAudioDrafts: [{ draft_id: 'audio-1' }],
      docCommentReplyAudioDrafts: [{ draft_id: 'audio-2' }],
      stopDocCommentsLiveQuery: vi.fn(),
      clearDocCommentConnector: vi.fn(),
    });

    store.openDoc('doc-2');

    expect(store.docComments).toEqual([]);
    expect(store.selectedDocCommentId).toBeNull();
    expect(store.docCommentAudioDrafts).toEqual([]);
    expect(store.docCommentReplyAudioDrafts).toEqual([]);
    expect(store.stopDocCommentsLiveQuery).toHaveBeenCalled();
    expect(store.clearDocCommentConnector).toHaveBeenCalled();
    expect(store.loadDocComments).toHaveBeenCalledWith('doc-2', { allowBackfill: true, force: true });
  });

  it('retains a populated tree while the same document remounts and refreshes it', () => {
    const existing = [{
      record_id: 'reply-1',
      target_record_id: 'doc-1',
      parent_comment_id: 'root-1',
      record_state: 'active',
    }];
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: 'dir-1' }],
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      docComments: existing,
    });

    store.openDoc('doc-1');

    expect(store.docComments).toBe(existing);
    expect(store.stopDocCommentsLiveQuery).not.toHaveBeenCalled();
    expect(store.loadDocComments).toHaveBeenCalledWith('doc-1', { allowBackfill: true, force: true });
  });

  it('opens the doc comments drawer when routing directly to a comment', () => {
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: 'dir-1' }],
      docCommentsVisible: false,
    });

    store.openDoc('doc-1', { commentId: 'comment-1' });

    expect(store.docCommentsVisible).toBe(true);
    expect(store.docMobilePane).toBe('comments');
    expect(store.selectedDocCommentId).toBe('comment-1');
  });

  it('does not reopen comments when late hydration arrives after selecting Doc', () => {
    const store = createStore({
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      selectedDocCommentId: 'comment-1',
      docCommentsVisible: false,
      docMobilePane: 'document',
      loadDocEditorFromSelection: docsManagerMixin.loadDocEditorFromSelection,
      getEffectiveDocShares: vi.fn(() => []),
      destroyDocRichEditor: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
      scheduleStorageImageHydration: vi.fn(),
    });

    store.loadDocEditorFromSelection({
      record_id: 'doc-1',
      title: 'Hydrated',
      content: '# Stable body',
      content_blocks: [],
      record_state: 'active',
    });

    expect(store.docEditorContent).toBe('# Stable body');
    expect(store.docCommentsVisible).toBe(false);
    expect(store.docMobilePane).toBe('document');
  });

  it('always opens a document on the full-page docs section', () => {
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: 'dir-1' }],
      navSection: 'chat',
      docCommentsVisible: false,
    });

    store.openDoc('doc-1', {
      syncRoute: false,
      navigate: false,
      ensureSync: false,
      allowCommentBackfill: false,
      showComments: true,
    });

    expect(store.navSection).toBe('docs');
    expect(store.docCommentsVisible).toBe(true);
    expect(store.docMobilePane).toBe('comments');
    expect(store.syncRoute).not.toHaveBeenCalled();
    expect(store.ensureBackgroundSync).not.toHaveBeenCalled();
    expect(store.loadDocComments).toHaveBeenCalledWith('doc-1', { allowBackfill: false, force: true });
  });

  it('captures the caller route and returns through matching browser history', async () => {
    const back = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/flight-deck/chat', search: '?channelid=channel-1&threadid=thread-1' },
      history: { state: {}, length: 3, back },
    });
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: 'dir-1' }],
      navigateTo: vi.fn(),
    });

    store.openDoc('doc-1');
    window.history.state.docDetailOriginRoute = store.docDetailOriginRoute;
    await store.returnFromDoc();

    expect(store.docDetailOriginRoute).toBe('');
    expect(back).toHaveBeenCalledTimes(1);
    expect(store.navigateTo).not.toHaveBeenCalled();
  });

  it('checkpoints the effective thread route before opening a document', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/flight-deck/chat', search: '?channelid=channel-1' },
      history: { state: { section: 'chat' }, replaceState },
    });
    const store = createStore({
      navSection: 'chat',
      activeThreadId: 'thread-1',
      documents: [{ record_id: 'doc-1', parent_directory_id: null }],
      buildRouteUrl: vi.fn(() => '/flight-deck/chat?channelid=channel-1&threadid=thread-1'),
    });

    store.openDoc('doc-1');

    expect(store.docDetailOriginRoute).toContain('threadid=thread-1');
    expect(replaceState).toHaveBeenCalledWith(
      { section: 'chat' },
      '',
      '/flight-deck/chat?channelid=channel-1&threadid=thread-1',
    );
  });

  it('returns a direct document link to the docs fallback', async () => {
    vi.stubGlobal('window', {
      history: { state: { section: 'docs' }, length: 2, back: vi.fn() },
    });
    const store = createStore({
      documents: [{ record_id: 'doc-1', parent_directory_id: null }],
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      docDetailOriginRoute: '',
      navigateTo: vi.fn(),
    });

    await store.returnFromDoc();

    expect(window.history.back).not.toHaveBeenCalled();
    expect(store.navigateTo).toHaveBeenCalledWith('docs', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledWith(true);
  });

  it('opens an inline anchored composer instead of the legacy modal', () => {
    const store = createStore({
      selectedDocId: 'doc-1',
      docCommentsVisible: false,
      selectedDocCommentId: 'comment-1',
      showDocCommentModal: false,
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    store.openDocCommentModal({ id: 'block-1-3', start_line: 3 });

    expect(store.docCommentsVisible).toBe(true);
    expect(store.docCommentAnchorLine).toBe(3);
    expect(store.docCommentAnchorBlockId).toBe('block-1-3');
    expect(store.selectedDocCommentId).toBeNull();
    expect(store.showDocCommentModal).toBe(false);
  });

  it('uses the selected read-mode block when the drawer plus starts a comment', () => {
    const blocks = [
      { id: 'block-1-1', start_line: 1, raw: 'First' },
      { id: 'block-1-4', start_line: 4, raw: 'Second' },
    ];
    const store = createStore({
      selectedDocId: 'doc-1',
      docEditorMode: 'preview',
      docEditorBlocks: blocks,
      docSelectedBlockId: null,
      scheduleDocCommentConnectorUpdate: vi.fn(),
      syncRoute: vi.fn(),
      clearDocCommentConnector: vi.fn(),
    });

    store.selectDocBlockForComment(blocks[1], 1);
    store.startDocCommentPlacement();

    expect(store.docCommentsVisible).toBe(true);
    expect(store.docSelectedBlockId).toBe('block-1-4');
    expect(store.docCommentAnchorLine).toBe(4);
    expect(store.docCommentAnchorBlockId).toBe('block-1-4');
    expect(store.selectedDocCommentId).toBeNull();
  });

  it('uses the active edit-mode block when the drawer plus starts a comment', () => {
    const blocks = [
      { id: 'block-1-1', start_line: 1, raw: 'First' },
      { id: 'block-1-6', start_line: 6, raw: 'Editing' },
    ];
    const store = createStore({
      selectedDocId: 'doc-1',
      docEditorMode: 'block',
      docEditorBlocks: blocks,
      docEditingBlockIndex: 1,
      docSelectedBlockId: null,
      scheduleDocCommentConnectorUpdate: vi.fn(),
      syncRoute: vi.fn(),
      clearDocCommentConnector: vi.fn(),
    });

    store.startDocCommentPlacement();

    expect(store.docSelectedBlockId).toBe('block-1-6');
    expect(store.docCommentAnchorLine).toBe(6);
    expect(store.docCommentAnchorBlockId).toBe('block-1-6');
  });

  it('keeps rich edit state intact while comments open, select, and close', () => {
    const editorAdapter = { marker: 'mounted-rich-editor' };
    const editorState = { selection: { anchor: 17, head: 24 }, scrollTop: 318 };
    const leaseState = { lease: { lease_token: 'lease-1' }, acquireState: 'held' };
    const store = createStore({
      docEditorMode: 'rich',
      docEditorContent: 'Unsaved editor content',
      docEditorProseMirrorState: editorState,
      docRichEditorAdapter: editorAdapter,
      selectedDocCheckoutSessionState: leaseState,
      docCommentsVisible: false,
      docMobilePane: 'document',
      docComments: [{
        record_id: 'root-1',
        parent_comment_id: null,
        record_state: 'active',
      }],
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    store.toggleDocCommentsVisible();
    store.selectDocCommentThread('root-1');
    store.closeDocCommentThread();
    store.toggleDocCommentsVisible();

    expect(store.docCommentsVisible).toBe(false);
    expect(store.docMobilePane).toBe('document');
    expect(store.docEditorMode).toBe('rich');
    expect(store.docEditorContent).toBe('Unsaved editor content');
    expect(store.docEditorProseMirrorState).toBe(editorState);
    expect(store.docRichEditorAdapter).toBe(editorAdapter);
    expect(store.selectedDocCheckoutSessionState).toBe(leaseState);
  });

  it('opens a general comment composer in rich edit mode without reusing a stale block anchor', () => {
    const editorState = { selection: { anchor: 9, head: 9 } };
    const store = createStore({
      selectedDocId: 'doc-1',
      docEditorMode: 'rich',
      docEditorContent: 'Unsaved rich content',
      docEditorProseMirrorState: editorState,
      docEditorBlocks: [{ id: 'block-1-4', start_line: 4, raw: 'Earlier block' }],
      docSelectedBlockId: 'block-1-4',
      docCommentsVisible: false,
      showDocCommentModal: false,
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    store.startDocCommentPlacement();

    expect(store.docCommentsVisible).toBe(true);
    expect(store.docMobilePane).toBe('comments');
    expect(store.showDocCommentModal).toBe(true);
    expect(store.docCommentAnchorBlockId).toBeNull();
    expect(store.docCommentAnchorLine).toBeNull();
    expect(store.docEditorMode).toBe('rich');
    expect(store.docEditorContent).toBe('Unsaved rich content');
    expect(store.docEditorProseMirrorState).toBe(editorState);
    expect(store.getPendingDocCommentAnchorLabel()).toBe('New general comment');
  });

  it('captures a rich-editor selection without changing mode, editor identity, content, or selection', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
    });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, schema.text('Select this text')),
    ]);
    const selection = { from: 1, to: 7 };
    const editor = { state: { doc, selection } };
    const adapter = { editor, marker: 'same-editor' };
    const store = createStore({
      selectedDocId: 'doc-1',
      docEditorMode: 'rich',
      docEditorContent: 'Unsaved rich content',
      docEditorProseMirrorState: { marker: 'unsaved-state' },
      docRichEditorAdapter: adapter,
      docCommentsVisible: false,
      showDocCommentModal: false,
      scheduleDocCommentConnectorUpdate: vi.fn(),
      clearDocCommentConnector: vi.fn(),
    });

    store.startDocCommentPlacement();

    expect(store.docCommentsVisible).toBe(true);
    expect(store.showDocCommentModal).toBe(false);
    expect(store.docCommentAnchorQuote).toBe('Select');
    expect(store.docCommentAnchorLine).toBe(1);
    expect(store.docCommentAnchorStartOffset).toBe(1);
    expect(store.docCommentAnchorEndOffset).toBe(7);
    expect(store.docRichEditorAdapter).toBe(adapter);
    expect(store.docRichEditorAdapter.editor.state.selection).toBe(selection);
    expect(store.docEditorMode).toBe('rich');
    expect(store.docEditorContent).toBe('Unsaved rich content');
  });

  it('labels unanchored document threads as general comments', () => {
    const store = createStore();

    expect(store.getDocCommentAnchorLabel({ anchor_block_id: null, anchor_line_number: null })).toBe('General');
    expect(store.getDocCommentAnchorLabel({ anchor_line_number: 8 })).toBe('Line 8');
    expect(store.getDocCommentAnchorLabel({ anchor_line_number: 8, anchor_end_line_number: 10 })).toBe('Lines 8–10');
  });

  it('lists root comments and replies separately for the drawer', () => {
    const store = createStore({
      docComments: [
        { record_id: 'reply-1', parent_comment_id: 'root-1', record_state: 'active', updated_at: '2026-01-01T00:02:00Z' },
        { record_id: 'root-2', parent_comment_id: null, record_state: 'deleted', updated_at: '2026-01-01T00:03:00Z' },
        { record_id: 'root-1', parent_comment_id: null, record_state: 'active', updated_at: '2026-01-01T00:01:00Z' },
      ],
    });

    expect(store.getRootDocComments().map((comment) => comment.record_id)).toEqual(['root-1']);
    expect(store.getDocCommentReplies('root-1').map((comment) => comment.record_id)).toEqual(['reply-1']);
  });

  it('renders the authoritative root, sibling replies, and nested agent reply as one inline conversation', () => {
    const rootId = '5f147de0-482b-4088-96d8-1ac0b1d5cb2a';
    const firstReplyId = '90d5da56-5e79-4ef2-9117-59026d4be5e0';
    const followUpId = '47c0b44a-2ad9-4cad-8947-a53cfcca63d7';
    const nestedReplyId = 'cc9854b8-ccbf-4347-96b8-2e477d38be9a';
    const store = createStore({
      docComments: [
        { record_id: nestedReplyId, parent_comment_id: followUpId, record_state: 'active', updated_at: '2026-08-05T00:04:00Z' },
        { record_id: rootId, parent_comment_id: null, record_state: 'active', updated_at: '2026-08-05T00:01:00Z' },
        { record_id: followUpId, parent_comment_id: rootId, record_state: 'active', updated_at: '2026-08-05T00:03:00Z' },
        { record_id: firstReplyId, parent_comment_id: rootId, record_state: 'active', updated_at: '2026-08-05T00:02:00Z' },
      ],
    });

    expect(store.getDocCommentReplies(rootId).map((comment) => comment.record_id)).toEqual([
      firstReplyId,
      followUpId,
      nestedReplyId,
    ]);
    expect(store.getDocCommentReplyDepth(firstReplyId, rootId)).toBe(1);
    expect(store.getDocCommentReplyDepth(followUpId, rootId)).toBe(1);
    expect(store.getDocCommentReplyDepth(nestedReplyId, rootId)).toBe(2);
  });

  it('counts block comments from root threads without double-counting replies', () => {
    const store = createStore({
      docEditorBlocks: [{ id: 'block-1', start_line: 1 }],
      docComments: [
        {
          record_id: 'root-1',
          parent_comment_id: null,
          anchor_block_id: 'block-1',
          anchor_line_number: 1,
          record_state: 'active',
          comment_status: 'open',
          updated_at: '2026-01-01T00:01:00Z',
        },
        {
          record_id: 'reply-1',
          parent_comment_id: 'root-1',
          anchor_block_id: 'block-1',
          anchor_line_number: 1,
          record_state: 'active',
          comment_status: 'open',
          updated_at: '2026-01-01T00:02:00Z',
        },
      ],
    });

    expect(store.getDocCommentsForBlock(store.docEditorBlocks[0]).map((comment) => comment.record_id)).toEqual(['root-1']);
    expect(store.getDocBlockCommentCount(store.docEditorBlocks[0])).toBe(2);
  });

  it('orders root comment threads by document block position before timestamp', () => {
    const store = createStore({
      docEditorBlocks: [
        { id: 'block-1', start_line: 1 },
        { id: 'block-2', start_line: 8 },
        { id: 'block-3', start_line: 14 },
      ],
      docComments: [
        {
          record_id: 'late-block-1',
          parent_comment_id: null,
          anchor_block_id: 'block-1',
          anchor_line_number: 1,
          record_state: 'active',
          created_at: '2026-01-01T00:04:00Z',
          updated_at: '2026-01-01T00:04:00Z',
        },
        {
          record_id: 'early-block-3',
          parent_comment_id: null,
          anchor_block_id: 'block-3',
          anchor_line_number: 14,
          record_state: 'active',
          created_at: '2026-01-01T00:01:00Z',
          updated_at: '2026-01-01T00:01:00Z',
        },
        {
          record_id: 'line-fallback-block-2',
          parent_comment_id: null,
          anchor_block_id: null,
          anchor_line_number: 8,
          record_state: 'active',
          created_at: '2026-01-01T00:03:00Z',
          updated_at: '2026-01-01T00:03:00Z',
        },
      ],
    });

    expect(store.getRootDocComments().map((comment) => comment.record_id)).toEqual([
      'late-block-1',
      'line-fallback-block-2',
      'early-block-3',
    ]);
  });
});

describe('docsManagerMixin checkout orchestration', () => {
  const documentFamilyHash = recordFamilyHash('document');

  beforeEach(() => {
    acquireRecordCheckoutMock.mockReset();
    releaseRecordCheckoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the previous document checkout when switching records', () => {
    const previousRecord = { record_id: 'doc-a', parent_directory_id: 'dir-a', sync_status: 'synced' };
    const nextRecord = { record_id: 'doc-b', parent_directory_id: 'dir-b', sync_status: 'synced' };
    const store = createStore({
      documents: [previousRecord, nextRecord],
      selectedDocType: 'document',
      selectedDocId: 'doc-a',
      releaseLockManagedCheckout: vi.fn(async () => true),
    });

    store.openDoc('doc-b');

    expect(store.releaseLockManagedCheckout).toHaveBeenCalledWith(
      previousRecord,
      documentFamilyHash,
      { reportError: false },
    );
    expect(store.selectedDocId).toBe('doc-b');
    expect(store.currentFolderId).toBe('dir-b');
  });

  it('releases the previous PG document lease when switching records', () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    releaseTowerPgEditLeaseMock.mockResolvedValueOnce({ released: true });
    const previousRecord = { record_id: 'doc-a', parent_directory_id: 'dir-a', pg_backend: true, sync_status: 'synced' };
    const nextRecord = { record_id: 'doc-b', parent_directory_id: 'dir-b', pg_backend: true, sync_status: 'synced' };
    const store = createStore({
      documents: [previousRecord, nextRecord],
      selectedDocType: 'document',
      selectedDocId: 'doc-a',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      },
      pgEditLeaseSessions: {
        'document:doc-a': { lease: { id: 'lease-doc-a', lease_token: 'token-doc-a' } },
      },
      releaseLockManagedCheckout: vi.fn(async () => true),
    });

    store.openDoc('doc-b');

    expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledWith('workspace-1', 'lease-doc-a', {
      lease_token: 'token-doc-a',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.releaseLockManagedCheckout).not.toHaveBeenCalled();
    expect(store.selectedDocId).toBe('doc-b');
    expect(store.currentFolderId).toBe('dir-b');
  });

  it('persists a recovery draft and waits for an in-flight PG save before releasing on close', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    releaseTowerPgEditLeaseMock.mockResolvedValueOnce({ released: true });
    let finishSave;
    const pendingSave = new Promise((resolve) => { finishSave = resolve; });
    const record = { record_id: 'doc-leaving', pg_backend: true, sync_status: 'synced' };
    const persistSelectedDocDraft = vi.fn(async () => ({ document_id: record.record_id }));
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditDraftDirty: true,
      persistSelectedDocDraft,
      pgDocSavePromises: { [record.record_id]: pendingSave },
      currentWorkspace: {
        workspaceId: 'workspace-1',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      pgEditLeaseSessions: {
        [`document:${record.record_id}`]: { lease: { id: 'lease-leaving', lease_token: 'token-leaving' } },
      },
    });

    store.closeDocEditor({ syncRoute: false });
    await vi.waitFor(() => expect(persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true }));
    expect(store.selectedDocId).toBeNull();
    expect(releaseTowerPgEditLeaseMock).not.toHaveBeenCalled();

    delete store.pgDocSavePromises[record.record_id];
    finishSave(record);
    await vi.waitFor(() => expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledTimes(1));
  });

  it('releases on hidden lifecycle after checkpointing the draft and stops editing', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    releaseTowerPgEditLeaseMock.mockResolvedValueOnce({ released: true });
    const record = { record_id: 'doc-hidden', pg_backend: true, sync_status: 'synced' };
    const adapter = { setEditable: vi.fn() };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditDraftDirty: true,
      docRichEditorAdapter: adapter,
      persistSelectedDocDraft: vi.fn(async () => ({ document_id: record.record_id })),
      currentWorkspace: {
        workspaceId: 'workspace-1',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      pgEditLeaseSessions: {
        [`document:${record.record_id}`]: { lease: { id: 'lease-hidden', lease_token: 'token-hidden' } },
      },
      pgEditLeaseRenewalTimers: { [`document:${record.record_id}`]: 99 },
    });

    expect(store.handleDocEditLeaseLifecycleExit()).toBe(true);

    await vi.waitFor(() => expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledTimes(1));
    expect(store.persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true });
    expect(store.pgEditLeaseRenewalTimers[`document:${record.record_id}`]).toBeUndefined();
    expect(store.docEditAccessState).toBe('ready');
    expect(adapter.setEditable).toHaveBeenCalledWith(false);
  });

  it('does not release a held checkout while a local write is still pending', async () => {
    const store = createStore();
    store.setLockManagedCheckoutSession('doc-a', documentFamilyHash, {
      acquireState: 'held',
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const released = await store.releaseLockManagedCheckout(
      { record_id: 'doc-a', sync_status: 'pending' },
      documentFamilyHash,
    );

    expect(released).toBe(false);
    expect(releaseRecordCheckoutMock).not.toHaveBeenCalled();
    expect(store.getLockManagedCheckoutSession('doc-a', documentFamilyHash)?.checkout?.checkout_id).toBe('checkout-1');
  });

  it('reuses the same idempotency key across acquire retries for the same edit intent', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('edit-session-1');
    const conflict = new Error('conflict');
    conflict.classification = 'checkout_conflict';
    acquireRecordCheckoutMock
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        checkout: {
          state: 'checked_out',
          checkout_id: 'checkout-2',
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      });

    const store = createStore();
    const record = { record_id: 'doc-a', sync_status: 'synced', version: 1 };

    await expect(
      store.ensureLockManagedCheckout(record, documentFamilyHash, { intent: 'edit', reportError: false }),
    ).rejects.toMatchObject({ classification: 'checkout_conflict' });

    const checkout = await store.ensureLockManagedCheckout(record, documentFamilyHash, {
      intent: 'edit',
      reportError: false,
    });

    expect(checkout?.checkout_id).toBe('checkout-2');
    expect(acquireRecordCheckoutMock).toHaveBeenCalledTimes(2);
    expect(acquireRecordCheckoutMock.mock.calls[0][0].idempotencyKey).toBe('edit-session-1');
    expect(acquireRecordCheckoutMock.mock.calls[1][0].idempotencyKey).toBe('edit-session-1');
  });

  it('acquires checkout before entering document edit mode', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-doc-edit-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const record = { record_id: 'doc-a', sync_status: 'synced', version: 1 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-a',
      setDocEditorMode: vi.fn(),
    });

    const entered = await store.enterSelectedDocEditMode('block');

    expect(entered).toBe(true);
    expect(acquireRecordCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'doc-a',
      recordFamilyHash: documentFamilyHash,
    }));
    expect(store.setDocEditorMode).toHaveBeenCalledWith('block');
  });

  it('uses the rich Tiptap editor as the default document edit mode', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-doc-rich-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const record = { record_id: 'doc-rich', sync_status: 'synced', version: 1 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-rich',
      setDocEditorMode: vi.fn(),
    });

    const entered = await store.enterSelectedDocEditMode();

    expect(entered).toBe(true);
    expect(store.setDocEditorMode).toHaveBeenCalledWith('rich');
  });

  it('acquires a PG edit lease before entering synced PG document edit mode', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue('doc-renew-timer');
    acquireTowerPgEditLeaseMock.mockResolvedValueOnce({
      lease: { id: 'lease-doc-1', lease_token: 'doc-token-1' },
    });

    const record = { record_id: 'doc-pg', pg_backend: true, sync_status: 'synced', version: 1 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-pg',
      pgEditLeaseSessions: {},
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      },
      setDocEditorMode: vi.fn(),
    });

    const entered = await store.enterSelectedDocEditMode('block');

    expect(entered).toBe(true);
    expect(acquireTowerPgEditLeaseMock).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      entity_type: 'document',
      entity_id: 'doc-pg',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(acquireRecordCheckoutMock).not.toHaveBeenCalled();
    expect(store.pgEditLeaseSessions['document:doc-pg'].lease.lease_token).toBe('doc-token-1');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(store.setDocEditorMode).toHaveBeenCalledWith('block');
  });

  it('opens a synced PG document on the rich TipTap surface while lease inspection stays non-blocking', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    let resolveInspection;
    getTowerPgEditLeaseMock.mockReturnValueOnce(new Promise((resolve) => { resolveInspection = resolve; }));
    const record = {
      record_id: 'doc-ready',
      pg_backend: true,
      sync_status: 'synced',
      version: 4,
      content: 'Authoritative body',
      content_blocks: [],
    };
    const store = createStore({
      documents: [record],
      docEditorRichFeatureEnabled: true,
      loadDocEditorFromSelection: docsManagerMixin.loadDocEditorFromSelection,
      prefetchFlightDeckDoc: vi.fn(() => new Promise(() => {})),
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
    });

    store.openDoc(record.record_id);

    expect(store.docEditorMode).toBe('rich');
    expect(store.docEditorContent).toBe('Authoritative body');
    expect(acquireTowerPgEditLeaseMock).not.toHaveBeenCalled();
    expect(store.docEditLeaseInfo).toBeNull();

    resolveInspection({ lease: { id: 'lease-other', holder_actor_npub: 'npub1other' } });
    await vi.waitFor(() => expect(store.docEditLeaseInfo?.id).toBe('lease-other'));
    expect(acquireTowerPgEditLeaseMock).not.toHaveBeenCalled();
  });

  it('keeps acquisition typing ephemeral, deduplicates intent races, and continues without remounting after success', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue('renew-doc-delayed');
    let resolveAcquire;
    acquireTowerPgEditLeaseMock.mockReturnValueOnce(new Promise((resolve) => { resolveAcquire = resolve; }));
    const record = {
      record_id: 'doc-delayed',
      pg_backend: true,
      sync_status: 'synced',
      version: 7,
      content: 'Base',
    };
    const adapter = {
      setEditable: vi.fn(),
      getContentModel: vi.fn(() => ({ content: 'BaseABC' })),
    };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditorMode: 'rich',
      docEditAccessGeneration: 3,
      docEditBaseRecordId: record.record_id,
      docEditBaseRowVersion: 7,
      docRichEditorAdapter: adapter,
      scheduleDocAutosave: vi.fn(),
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
    });

    const first = store.beginSelectedDocLeaseAcquisition();
    const second = store.beginSelectedDocLeaseAcquisition();
    store.docEditorContent = 'BaseABC';
    store.handleDocRichEditorUpdate();
    await Promise.resolve();

    expect(store.docEditAccessState).toBe('acquiring');
    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docEditorContent).toBe('BaseABC');
    expect(acquireTowerPgEditLeaseMock).toHaveBeenCalledTimes(1);
    expect(store.scheduleDocAutosave).not.toHaveBeenCalled();

    resolveAcquire({ lease: { id: 'lease-delayed', lease_token: 'token-delayed' } });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(store.docEditAccessState).toBe('editing');
    expect(store.docEditorContent).toBe('BaseABC');
    expect(store.docRichEditorAdapter).toBe(adapter);
    expect(adapter.setEditable).toHaveBeenLastCalledWith(true);
    expect(store.scheduleDocAutosave).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it('preserves and locks an acquisition draft when Tower denies the lease', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const denial = Object.assign(new Error('edit lease is held'), {
      status: 409,
      holder_actor_npub: 'npub1holder',
      expires_at: '2026-08-25T13:00:00.000Z',
    });
    acquireTowerPgEditLeaseMock.mockRejectedValueOnce(denial);
    const record = { record_id: 'doc-denied', pg_backend: true, sync_status: 'synced', version: 2, content: 'Base' };
    const adapter = { setEditable: vi.fn(), getContentModel: () => ({ content: 'Base draft' }) };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditorMode: 'rich',
      docEditorContent: 'Base draft',
      docEditDraftDirty: true,
      docEditBaseRecordId: record.record_id,
      docEditBaseRowVersion: 2,
      docRichEditorAdapter: adapter,
      scheduleDocAutosave: vi.fn(),
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
    });

    await expect(store.beginSelectedDocLeaseAcquisition()).resolves.toBe(false);

    expect(store.docEditAccessState).toBe('blocked');
    expect(store.docEditorContent).toBe('Base draft');
    expect(store.docEditLeaseInfo).toMatchObject({ holder_actor_npub: 'npub1holder' });
    expect(adapter.setEditable).toHaveBeenLastCalledWith(false);
    expect(store.scheduleDocAutosave).not.toHaveBeenCalled();
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });

  it('releases a delayed lease that resolves after document navigation without touching the next document', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    releaseTowerPgEditLeaseMock.mockResolvedValueOnce({ released: true });
    let resolveAcquire;
    acquireTowerPgEditLeaseMock.mockReturnValueOnce(new Promise((resolve) => { resolveAcquire = resolve; }));
    const firstRecord = { record_id: 'doc-first', pg_backend: true, sync_status: 'synced', version: 1 };
    const secondRecord = { record_id: 'doc-second', pg_backend: true, sync_status: 'synced', version: 9 };
    const store = createStore({
      documents: [firstRecord, secondRecord],
      selectedDocType: 'document',
      selectedDocId: firstRecord.record_id,
      docEditorMode: 'rich',
      docEditAccessGeneration: 1,
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
    });

    const acquiring = store.beginSelectedDocLeaseAcquisition();
    store.selectedDocId = secondRecord.record_id;
    store.docEditAccessGeneration += 1;
    store.docEditAccessState = 'ready';
    resolveAcquire({ lease: { id: 'lease-first', lease_token: 'token-first' } });

    await expect(acquiring).resolves.toBe(false);
    expect(store.selectedDocId).toBe(secondRecord.record_id);
    expect(store.docEditAccessState).toBe('ready');
    expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledWith('workspace-1', 'lease-first', {
      lease_token: 'token-first',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.pgEditLeaseRenewalTimers?.['document:doc-first']).toBeUndefined();
  });

  it('allows delegated workspace-key checkout attempts when local creator differs', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-delegated-owner-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const store = createStore({
      session: { npub: 'npub1owneruser' },
      currentWorkspace: { creatorNpub: 'npub1workspaceservice' },
      buildLockManagedCheckoutIdentityContext: vi.fn(() => ({
        workspaceServiceNpub: 'npub1workspaceservice',
        userNpub: 'npub1owneruser',
        workspaceUserKeyNpub: 'npub1workspacekey',
        signerNpub: 'npub1workspacekey',
      })),
    });

    const checkout = await store.ensureLockManagedCheckout(
      { record_id: 'doc-a', sync_status: 'synced', version: 1 },
      documentFamilyHash,
      { reportError: false },
    );

    expect(checkout?.checkout_id).toBe('checkout-delegated-owner-1');
    expect(acquireRecordCheckoutMock).toHaveBeenCalledTimes(1);
    expect(acquireRecordCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
      identityContext: expect.objectContaining({
        userNpub: 'npub1owneruser',
        workspaceUserKeyNpub: 'npub1workspacekey',
      }),
    }));
  });

  it('maps Tower non-owner checkout_required rejections after acquire attempt', async () => {
    const forbidden = new Error('not owner');
    forbidden.classification = 'edit_policy_forbidden';
    acquireRecordCheckoutMock.mockRejectedValueOnce(forbidden);
    const store = createStore({
      session: { npub: 'npub1collaborator' },
      currentWorkspace: { creatorNpub: 'npub1workspaceservice' },
      buildLockManagedCheckoutIdentityContext: vi.fn(() => ({
        workspaceServiceNpub: 'npub1workspace',
        userNpub: 'npub1collaborator',
        workspaceUserKeyNpub: 'npub1workspacekey',
        signerNpub: 'npub1workspacekey',
      })),
    });

    await expect(store.ensureLockManagedCheckout(
      { record_id: 'doc-a', sync_status: 'synced', version: 1 },
      documentFamilyHash,
      { reportError: false },
    )).rejects.toMatchObject({ classification: 'edit_policy_forbidden' });

    expect(acquireRecordCheckoutMock).toHaveBeenCalledTimes(1);
    expect(store.getLockManagedCheckoutSession('doc-a', documentFamilyHash)).toMatchObject({
      acquireState: 'blocked',
      classification: 'edit_policy_forbidden',
    });
  });

  it('blocks missing checkout identity before acquire', async () => {
    const missingIdentity = new Error('missing workspace key');
    missingIdentity.classification = 'workspace_key_missing';
    const store = createStore({
      session: null,
      currentWorkspace: { creatorNpub: 'npub1owner' },
      buildLockManagedCheckoutIdentityContext: vi.fn(() => {
        throw missingIdentity;
      }),
    });

    await expect(store.ensureLockManagedCheckout(
      { record_id: 'doc-a', sync_status: 'synced', version: 1 },
      documentFamilyHash,
      { reportError: false },
    )).rejects.toMatchObject({ classification: 'workspace_key_missing' });

    expect(acquireRecordCheckoutMock).not.toHaveBeenCalled();
    expect(store.getLockManagedCheckoutSession('doc-a', documentFamilyHash)).toMatchObject({
      acquireState: 'blocked',
      classification: 'workspace_key_missing',
    });
  });

  it('maps blocked checkout errors to deterministic UI state', async () => {
    const conflict = new Error('record checked out');
    conflict.classification = 'record_checked_out';
    conflict.response = {
      checkout: {
        state: 'checked_out',
        checked_out_by_user_npub: 'npub1other',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    acquireRecordCheckoutMock.mockRejectedValueOnce(conflict);

    const store = createStore();

    await expect(store.ensureLockManagedCheckout(
      { record_id: 'doc-a', sync_status: 'synced', version: 1 },
      documentFamilyHash,
      { reportError: false },
    )).rejects.toMatchObject({ classification: 'record_checked_out' });

    expect(store.getLockManagedCheckoutSession('doc-a', documentFamilyHash)).toMatchObject({
      acquireState: 'blocked',
      classification: 'record_checked_out',
      message: expect.stringContaining('Checked out by npub1other'),
    });
  });

  it('routes directory mutations through checkout_required acquire', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-dir-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const store = createStore();
    const checkout = await store.ensureLockManagedCheckout(
      { record_id: 'dir-a', sync_status: 'synced', version: 1 },
      recordFamilyHash('directory'),
      { reportError: false },
    );

    expect(checkout?.checkout_id).toBe('checkout-dir-1');
    expect(acquireRecordCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'dir-a',
      recordFamilyHash: recordFamilyHash('directory'),
    }));
  });

  it('can opt task edits into checkout_required through policy config', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-task-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const store = createStore({
      recordCheckoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } },
    });
    const envelope = {
      record_id: 'task-a',
      record_family_hash: recordFamilyHash('task'),
      version: 2,
    };

    const managedEnvelope = await store.attachCheckoutRequiredCheckoutToEnvelope(
      { record_id: 'task-a', sync_status: 'synced', version: 1 },
      envelope,
      { reportError: false },
    );

    expect(managedEnvelope.checkout).toEqual({
      checkout_id: 'checkout-task-1',
      consume_on_success: true,
    });
    expect(acquireRecordCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'task-a',
      recordFamilyHash: recordFamilyHash('task'),
    }));
  });

  it('can opt one task edit envelope into checkout_required without changing store defaults', async () => {
    acquireRecordCheckoutMock.mockResolvedValueOnce({
      checkout: {
        state: 'checked_out',
        checkout_id: 'checkout-task-local-1',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const store = createStore();
    const envelope = {
      record_id: 'task-local',
      record_family_hash: recordFamilyHash('task'),
      version: 2,
    };

    expect(store.isCheckoutRequiredRecordFamily(recordFamilyHash('task'))).toBe(false);

    const managedEnvelope = await store.attachCheckoutRequiredCheckoutToEnvelope(
      { record_id: 'task-local', sync_status: 'synced', version: 1 },
      envelope,
      {
        reportError: false,
        checkoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } },
      },
    );

    expect(managedEnvelope.checkout).toEqual({
      checkout_id: 'checkout-task-local-1',
      consume_on_success: true,
    });
    expect(store.isCheckoutRequiredRecordFamily(recordFamilyHash('task'))).toBe(false);
  });

  it('saveAndExitSelectedDocEditMode saves, returns to the stable rich surface, and force-releases checkout', async () => {
    const record = { record_id: 'doc-a', sync_status: 'pending', version: 2 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-a',
      docEditorMode: 'block',
      docEditingBlockIndex: 1,
      commitDocBlockEdit: vi.fn(),
      saveSelectedDocItem: vi.fn(async () => record),
      persistSelectedDocDraft: vi.fn(async () => ({})),
      setDocEditorMode: vi.fn(),
      releaseLockManagedCheckout: vi.fn(async () => true),
    });

    const saved = await store.saveAndExitSelectedDocEditMode();

    expect(saved).toBe(true);
    expect(store.commitDocBlockEdit).toHaveBeenCalledTimes(1);
    expect(store.saveSelectedDocItem).toHaveBeenCalledWith({ autosave: false });
    expect(store.persistSelectedDocDraft).toHaveBeenCalledWith({ immediate: true });
    expect(store.setDocEditorMode).toHaveBeenCalledWith('rich');
    expect(store.releaseLockManagedCheckout).toHaveBeenCalledWith(
      record,
      documentFamilyHash,
      { reportError: false, force: true },
    );
  });

  it('keeps the document editor open while a pasted image is still uploading', async () => {
    const record = { record_id: 'doc-uploading', sync_status: 'synced', version: 1 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-uploading',
      docEditorMode: 'rich',
      docRichImageUploadCount: 1,
      saveSelectedDocItem: vi.fn(),
      persistSelectedDocDraft: vi.fn(async () => ({})),
      setDocEditorMode: vi.fn(),
      releaseLockManagedCheckout: vi.fn(),
    });

    const saved = await store.saveAndExitSelectedDocEditMode();

    expect(saved).toBe(false);
    expect(store.error).toBe('Wait for pasted images to finish uploading before saving this document.');
    expect(store.docAutosaveState).toBe('pending');
    expect(store.saveSelectedDocItem).not.toHaveBeenCalled();
    expect(store.setDocEditorMode).not.toHaveBeenCalled();
    expect(store.releaseLockManagedCheckout).not.toHaveBeenCalled();
  });

  it('keeps the document editor and checkout when the save is not confirmed', async () => {
    const record = { record_id: 'doc-unsaved', sync_status: 'synced', version: 1 };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-unsaved',
      docEditorMode: 'rich',
      saveSelectedDocItem: vi.fn(async () => null),
      persistSelectedDocDraft: vi.fn(async () => ({})),
      setDocEditorMode: vi.fn(),
      releaseLockManagedCheckout: vi.fn(),
    });

    const saved = await store.saveAndExitSelectedDocEditMode();

    expect(saved).toBe(false);
    expect(store.setDocEditorMode).not.toHaveBeenCalled();
    expect(store.releaseLockManagedCheckout).not.toHaveBeenCalled();
  });

  it('checkpoints the visible draft again when save throws before transport', async () => {
    const record = { record_id: 'doc-rejected', sync_status: 'synced', version: 1 };
    const failure = Object.assign(new Error('serialization rejected'), { code: 'serialization_failed' });
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: 'doc-rejected',
      docEditorMode: 'rich',
      saveSelectedDocItem: vi.fn(async () => { throw failure; }),
      persistSelectedDocDraft: vi.fn(async () => ({})),
      setDocEditorMode: vi.fn(),
      releaseLockManagedCheckout: vi.fn(),
    });

    await expect(store.saveAndExitSelectedDocEditMode()).resolves.toBe(false);

    expect(store.persistSelectedDocDraft).toHaveBeenNthCalledWith(1, { immediate: true });
    expect(store.persistSelectedDocDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({
      immediate: true,
      remoteOutcome: expect.objectContaining({ status: 'error', code: 'serialization_failed' }),
    }));
    expect(store.docAutosaveState).toBe('error');
    expect(store.error).toContain('serialization rejected');
    expect(store.setDocEditorMode).not.toHaveBeenCalled();
    expect(store.releaseLockManagedCheckout).not.toHaveBeenCalled();
  });
});

describe('docsManagerMixin document block editor sizing', () => {
  it('uses the rendered block height as the editor minimum when editing starts', () => {
    const store = createStore({
      docEditorMode: 'block',
      docEditorBlocks: [{ id: 'block-1', raw: '## Rendered heading\n\nRendered body', start_line: 1 }],
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });
    const previewEl = {
      getBoundingClientRect: () => ({ height: 214.2 }),
    };

    store.startDocBlockEdit(0, previewEl);

    expect(store.docEditingBlockIndex).toBe(0);
    expect(store.docBlockBuffer).toBe('## Rendered heading\n\nRendered body');
    expect(store.docBlockEditorMinHeightPx).toBe(215);
    expect(store.getDocBlockEditorStyle()).toEqual({ minHeight: '215px' });
  });

  it('keeps textarea height at least as tall as the rendered block while autosizing', () => {
    const store = createStore({ docBlockEditorMinHeightPx: 180 });
    const textarea = { style: {}, scrollHeight: 240 };

    store.resizeDocBlockEditor(textarea);

    expect(textarea.style.minHeight).toBe('180px');
    expect(textarea.style.height).toBe('240px');

    textarea.scrollHeight = 120;
    store.resizeDocBlockEditor(textarea);

    expect(textarea.style.height).toBe('180px');
  });
});

describe('docsManagerMixin rich editor mount safety', () => {
  it('reuses an in-flight mount for the same element instead of creating a second editor', async () => {
    const element = {};
    const inFlightMount = Promise.resolve('mounted');
    const store = createStore({
      docEditorMode: 'rich',
      docRichEditorMountEl: element,
      docRichEditorMountPromise: inFlightMount,
      destroyDocRichEditor: vi.fn(),
    });

    await expect(store.mountDocRichEditor(element)).resolves.toBe('mounted');
    expect(store.destroyDocRichEditor).not.toHaveBeenCalled();
  });

  it('detects visible rich-editor text even when the active adapter serializes empty', () => {
    const store = createStore({
      docRichEditorMountEl: {
        querySelectorAll: () => [
          { innerText: '' },
          { innerText: 'A 5,000 word visible draft' },
        ],
      },
    });

    expect(store.getVisibleDocRichEditorText()).toBe('A 5,000 word visible draft');
  });

  it('refuses a PG save when the referenced adapter is empty but the visible editor has text', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockClear();
    const record = {
      record_id: 'doc-visible-draft',
      owner_npub: 'npub1owner',
      title: 'Visible draft',
      content: '',
      content_blocks: [],
      scope_id: 'scope-1',
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'synced',
      version: 1,
    };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditorTitle: record.title,
      docEditorMode: 'rich',
      docRichEditorAdapter: {
        getContentModel: () => ({
          content: '',
          content_format: FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT,
          content_blocks: [],
          editor_state: { type: 'doc', content: [] },
        }),
      },
      docRichEditorMountEl: {
        querySelectorAll: () => [{ innerText: 'The complete visible draft' }],
      },
      pgEditLeaseSessions: {
        [`document:${record.record_id}`]: { lease: { lease_token: 'lease-token' } },
      },
      persistSelectedDocDraft: vi.fn(async () => ({})),
    });

    const saved = await store.saveSelectedPgDocItem(record, 'npub1owner', { autosave: false });

    expect(saved).toBeNull();
    expect(store.docAutosaveState).toBe('error');
    expect(store.error).toContain('complete text is still open');
    expect(store.docEditorContent).toContain('The complete visible draft');
    expect(store.persistSelectedDocDraft).toHaveBeenCalledWith({
      integrityError: 'visible_editor_content_exceeds_serialized_model',
    });
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });

  it('refuses a no-change PG save when the visible editor is longer than the stale adapter model', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockClear();
    const staleModel = richDocContentModel('First accepted sentence.');
    const record = {
      record_id: 'doc-partial-adapter',
      owner_npub: 'npub1owner',
      title: 'Visible draft',
      ...staleModel,
      scope_id: 'scope-1',
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'synced',
      version: 2,
    };
    const store = createStore({
      documents: [record],
      selectedDocType: 'document',
      selectedDocId: record.record_id,
      docEditorTitle: record.title,
      docEditorMode: 'rich',
      docEditDraftDirty: true,
      docRichEditorAdapter: { getContentModel: () => staleModel },
      docRichEditorMountEl: {
        querySelectorAll: () => [{ innerText: 'First accepted sentence. The rest of the complete visible draft.' }],
      },
      pgEditLeaseSessions: {
        [`document:${record.record_id}`]: { lease: { lease_token: 'lease-token' } },
      },
      persistSelectedDocDraft: vi.fn(async () => ({})),
    });

    const saved = await store.saveSelectedPgDocItem(record, 'npub1owner', { autosave: false });

    expect(saved).toBeNull();
    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docEditorContent).toContain('The rest of the complete visible draft');
    expect(store.error).toContain('did not match the save model');
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });
});

function richDocContentModel(text) {
  return prosemirrorToFlightDeckContentModel({
    type: 'doc',
    content: [{
      type: 'paragraph',
      attrs: { fdBlockId: 'block-1' },
      content: text ? [{ type: 'text', text }] : [],
    }],
  });
}

function createSyncedPgDocSaveStore({
  version = 43,
  content = 'Original body',
  currentModel,
  contentBlocks,
  contentFormat,
  editorState,
  draftDirty = true,
} = {}) {
  const record = {
    record_id: 'doc-save-race',
    owner_npub: 'npub1pgworkspace',
    title: 'Race document',
    content,
    content_blocks: contentBlocks ?? richDocContentModel(content).content_blocks,
    content_format: contentFormat ?? FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT,
    editor_state: editorState ?? null,
    scope_id: 'scope-1',
    scope_l1_id: 'scope-1',
    pg_backend: true,
    pg_record_type: 'doc',
    pg_channel_id: 'channel-1',
    sync_status: 'synced',
    record_state: 'active',
    version,
    content_storage_object_id: `storage-base-${version}`,
    content_storage_status: 'loaded',
    content_sha256_hex: 'b'.repeat(64),
    pg_canonical_version_id: `doc-save-race:${version}`,
    pg_canonical_storage_object_id: `storage-base-${version}`,
    pg_canonical_body_sha256_hex: 'b'.repeat(64),
  };
  const modelRef = { current: currentModel || richDocContentModel(content) };
  const adapter = {
    getContentModel: vi.fn(() => modelRef.current),
    setContent: vi.fn(),
    setEditable: vi.fn(),
  };
  const store = createStore({
    workspaceOwnerNpub: 'npub1signedinactor',
    backendUrl: 'https://tower.example',
    currentWorkspace: {
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1pgworkspace',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    },
    documents: [record],
    selectedDocType: 'document',
    selectedDocId: record.record_id,
    docEditorTitle: record.title,
    docEditorMode: 'rich',
    docRichEditorAdapter: adapter,
    docEditAccessState: 'editing',
    docEditDraftDirty: draftDirty,
    docEditBaseRecordId: record.record_id,
    docEditBaseRowVersion: version,
    docEditBaseVersionId: `doc-save-race:${version}`,
    docEditBaseBodySha256Hex: 'b'.repeat(64),
    docEditBaseStorageObjectId: `storage-base-${version}`,
    docEditBaseAvailable: true,
    pgEditLeaseSessions: {
      [`document:${record.record_id}`]: { lease: { id: 'lease-base', lease_token: 'lease-token' } },
    },
    prepareDocumentContentForEnvelope: vi.fn(async (_record, model) => ({
      content: model.content,
      content_storage_object_id: `storage-${model.content.length}`,
      content_storage_format: DOCUMENT_CONTENT_STORAGE_FORMAT,
      content_storage_content_type: DOCUMENT_CONTENT_STORAGE_MIME,
      content_size_bytes: model.content.length,
      content_sha256_hex: 'a'.repeat(64),
    })),
  });
  return { adapter, modelRef, record, store };
}

function acceptedPgDoc(version, body, title = 'Race document') {
  return {
    doc: {
      id: 'doc-save-race',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      storage_object_id: `storage-${body.length}`,
      title,
      summary: body,
      row_version: version,
      updated_at: `2026-08-25T12:45:${String(version).padStart(2, '0')}.000Z`,
    },
    canonical_version: {
      version_id: `doc-save-race:${version}`,
      row_version: version,
      storage_object_id: `storage-${body.length}`,
      body_sha256_hex: 'a'.repeat(64),
      size_bytes: body.length,
    },
  };
}

describe('docsManagerMixin durable recovery drafts', () => {
  beforeEach(async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
  });

  it('deletes a blocked local draft before refreshing the canonical document and current lease', async () => {
    const draftModel = richDocContentModel('Unsaved local words');
    const { adapter, record, store } = createSyncedPgDocSaveStore({ currentModel: draftModel });
    store.docEditAccessState = 'blocked';
    store.docEditAccessMessage = 'Draft preserved — the edit lease expired.';
    store.docEditConflict = { baseVersion: 42, currentVersion: 43 };
    store.docRecovery = { id: 'stale-local-recovery' };
    store.docLocalDraft = await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: record.record_id,
      content: draftModel.content,
      draft_status: 'dirty',
    });
    const authoritative = { ...record, content: 'Fresh Tower body', version: 44 };
    store.hydrateSelectedDocWithRetry = vi.fn(async () => authoritative);
    getTowerPgEditLeaseMock.mockResolvedValueOnce({
      lease: {
        id: 'lease-other',
        holder_actor_npub: 'npub1other',
        holder_display_name: 'Other editor',
        expires_at: '2026-09-24T02:00:00.000Z',
      },
    });

    await expect(store.discardSelectedDocDraft()).resolves.toBe(true);

    expect(await getDocumentDraft('workspace-1', record.record_id)).toBeUndefined();
    expect(store.hydrateSelectedDocWithRetry).toHaveBeenCalledWith(record.record_id, { delays: [0] });
    expect(adapter.setContent).toHaveBeenCalledWith(expect.objectContaining({ type: 'doc' }), {
      emitUpdate: false,
      preserveSelection: false,
    });
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docEditConflict).toBeNull();
    expect(store.docRecovery).toBeNull();
    expect(store.docLocalDraft).toBeNull();
    expect(store.docEditAccessState).toBe('blocked');
    expect(store.docEditAccessMessage).toBe('');
    expect(store.docEditLeaseInfo).toMatchObject({
      holder_actor_npub: 'npub1other',
      expires_at: '2026-09-24T02:00:00.000Z',
    });
    expect(acquireTowerPgEditLeaseMock).not.toHaveBeenCalled();
  });

  it('keeps the recovery warning and dirty state when local draft deletion cannot be confirmed', async () => {
    const { record, store } = createSyncedPgDocSaveStore();
    store.getSelectedDocWorkspaceId = vi.fn(() => '');
    store.docEditAccessState = 'blocked';
    store.docEditAccessMessage = 'Draft preserved — edit access unavailable';

    await expect(store.discardSelectedDocDraft()).resolves.toBe(false);

    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docEditAccessState).toBe('blocked');
    expect(store.docEditAccessMessage).toContain('Local draft could not be discarded');
    expect(record.content).toBe('Original body');
  });

  it('returns a discarded draft to explicit edit-ready state when the refreshed lease is free', async () => {
    const { record, store } = createSyncedPgDocSaveStore();
    store.docEditAccessState = 'blocked';
    store.docEditAccessMessage = 'Draft preserved — edit access unavailable';
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: record.record_id,
      content: 'Discard me',
      draft_status: 'dirty',
    });
    store.hydrateSelectedDocWithRetry = vi.fn(async () => record);
    getTowerPgEditLeaseMock.mockResolvedValueOnce({ lease: null });

    await expect(store.discardSelectedDocDraft()).resolves.toBe(true);

    expect(store.docEditAccessState).toBe('ready');
    expect(store.docEditAccessMessage).toBe('');
    expect(store.docEditLeaseInfo).toBeNull();
    expect(store.docRichEditorAdapter.setEditable).toHaveBeenLastCalledWith(true);
    expect(acquireTowerPgEditLeaseMock).not.toHaveBeenCalled();
  });

  it('persists a one-word edit locally first and remotely autosaves only after fifteen seconds', async () => {
    const edited = richDocContentModel('Original body changed');
    const { store } = createSyncedPgDocSaveStore({ currentModel: edited });
    store.docsEditorOpen = true;
    const remoteSave = vi.fn().mockResolvedValue(null);
    store.saveSelectedDocItem = remoteSave;
    const timers = new Map();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      timers.set(delay, callback);
      return `doc-timer-${delay}`;
    });

    store.scheduleDocAutosave();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DOCUMENT_LOCAL_DRAFT_DELAY_MS);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DOCUMENT_REMOTE_AUTOSAVE_DELAY_MS);
    expect(await getDocumentDraft('workspace-1', 'doc-save-race')).toBeUndefined();
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();

    await timers.get(DOCUMENT_LOCAL_DRAFT_DELAY_MS)();
    expect(await getDocumentDraft('workspace-1', 'doc-save-race')).toMatchObject({
      content: edited.content,
      draft_status: 'dirty',
      base_row_version: 43,
      base_version_id: 'doc-save-race:43',
    });
    expect(remoteSave).not.toHaveBeenCalled();

    await timers.get(DOCUMENT_REMOTE_AUTOSAVE_DELAY_MS)();
    expect(remoteSave).toHaveBeenCalledOnce();
    expect(remoteSave).toHaveBeenCalledWith({ autosave: true });
    setTimeoutSpy.mockRestore();
  });

  it('restores a draft only for the same workspace, document, and canonical base', async () => {
    const restoredModel = richDocContentModel('Restored after reload');
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: 'doc-save-race',
      title: 'Restored title',
      ...restoredModel,
      base_available: true,
      base_row_version: 43,
      base_version_id: 'doc-save-race:43',
      base_body_sha256_hex: 'b'.repeat(64),
      base_storage_object_id: 'storage-base-43',
      draft_status: 'dirty',
      dirty_at: '2026-08-27T01:00:00.000Z',
    });
    const { adapter, record, store } = createSyncedPgDocSaveStore({ draftDirty: false });
    store.docEditAccessGeneration = 5;
    store.beginSelectedDocLeaseAcquisition = vi.fn();

    await expect(store.restoreSelectedDocDraft(record, { generation: 5 })).resolves.toMatchObject({
      content: restoredModel.content,
    });
    expect(store.docEditorTitle).toBe('Restored title');
    expect(store.docEditorContent).toBe(restoredModel.content);
    expect(store.docEditDraftDirty).toBe(true);
    expect(adapter.setContent).toHaveBeenCalledWith(restoredModel.editor_state, expect.objectContaining({ emitUpdate: false }));

    store.currentWorkspace = { ...store.currentWorkspace, workspaceId: 'workspace-2' };
    store.docEditorContent = 'Workspace two canonical body';
    await expect(store.restoreSelectedDocDraft(record, { generation: 5 })).resolves.toBeNull();
    expect(store.docEditorContent).toBe('Workspace two canonical body');
  });

  it('restores a fresh single-client v5 draft when sparse hydration omits optional head identity', async () => {
    const restoredModel = richDocContentModel('Fresh single-client edit');
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: 'doc-save-race',
      title: 'Race document',
      ...restoredModel,
      base_available: true,
      base_row_version: 5,
      base_version_id: 'doc-save-race:5',
      base_body_sha256_hex: 'b'.repeat(64),
      base_storage_object_id: 'storage-base-5',
      draft_status: 'dirty',
    });
    const { adapter, record, store } = createSyncedPgDocSaveStore({ version: 5, draftDirty: false });
    const sparseHead = {
      ...record,
      version: 5,
      content_blocks: [],
      editor_state: null,
      content_storage_status: 'remote',
      content_sha256_hex: null,
      pg_canonical_version_id: null,
      pg_canonical_body_sha256_hex: null,
    };
    store.documents = [sparseHead];
    store.docEditAccessGeneration = 6;
    store.beginSelectedDocLeaseAcquisition = vi.fn();

    await store.restoreSelectedDocDraft(sparseHead, { generation: 6 });

    expect(store.docEditorContent).toBe(restoredModel.content);
    expect(store.docEditBaseRowVersion).toBe(5);
    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docEditConflict).toBeFalsy();
    expect(store.docEditAccessState).not.toBe('recovery');
    expect(adapter.setEditable).not.toHaveBeenCalledWith(true);
  });

  it('clears a restored local draft whose content already matches the canonical head', async () => {
    const canonical = richDocContentModel('Canonical body already saved');
    const { record, store } = createSyncedPgDocSaveStore({
      content: canonical.content,
      currentModel: canonical,
      editorState: canonical.editor_state,
      draftDirty: false,
    });
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: record.record_id,
      title: record.title,
      ...canonical,
      base_available: true,
      base_row_version: 43,
      base_version_id: 'doc-save-race:43',
      base_body_sha256_hex: 'b'.repeat(64),
      base_storage_object_id: 'storage-base-43',
      draft_status: 'dirty',
    });
    store.docEditAccessGeneration = 7;

    await expect(store.restoreSelectedDocDraft(record, { generation: 7 })).resolves.toBeNull();

    expect(await getDocumentDraft('workspace-1', record.record_id)).toBeUndefined();
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docAutosaveState).toBe('saved');
    expect(store.docEditConflict).toBeNull();
  });

  it('does not let a pending local draft read overwrite new typing or delete its checkpoint', async () => {
    const { record, store, adapter } = createSyncedPgDocSaveStore({ draftDirty: false });
    const oldModel = richDocContentModel('Older checkpoint');
    await upsertDocumentDraft({ workspace_id: 'workspace-1', document_id: record.record_id,
      ...oldModel, base_available: true, base_row_version: 43, draft_status: 'dirty' });
    store.docEditAccessGeneration = 8;
    const restoring = store.restoreSelectedDocDraft(record, { generation: 8 });
    store.docEditorContent = 'New typing while IndexedDB is reading';
    store.docEditDraftDirty = true;
    expect(await restoring).toBeNull();
    expect(store.docEditorContent).toBe('New typing while IndexedDB is reading');
    expect(adapter.setContent).not.toHaveBeenCalled();
    expect(await getDocumentDraft('workspace-1', record.record_id)).toMatchObject({ content: oldModel.content });
  });

  it('checkpoints source edits and intentional empty content instead of the retained rich model', async () => {
    const { record, store } = createSyncedPgDocSaveStore();
    store.docEditorContentModel = richDocContentModel('Stale rich content');
    store.docEditorMode = 'source';
    store.docEditorContent = '**New source** [Linked page](wiki:stable-page)';
    await store.persistSelectedDocDraft({ immediate: true });
    let draft = await getDocumentDraft('workspace-1', record.record_id);
    expect(draft.content).toContain('New source');
    expect(draft.content).toContain('(wiki:stable-page)');
    expect(draft.content).not.toContain('Stale rich');
    expect(validateDocumentContentModelRoundTrip(draft).ok).toBe(true);
    store.docEditorContent = '';
    await store.persistSelectedDocDraft({ immediate: true });
    draft = await getDocumentDraft('workspace-1', record.record_id);
    expect(draft.content).toBe('');
    expect(draft.editor_state.content).toEqual([expect.objectContaining({ type: 'paragraph' })]);
    expect(draft.editor_state.content[0].content).toBeUndefined();
  });

  it('retains rich draft structure when compatibility text matches the canonical head', async () => {
    const model = richDocContentModel('Same text');
    const { record, store } = createSyncedPgDocSaveStore({ content: model.content,
      currentModel: model, editorState: model.editor_state, draftDirty: false });
    const changed = structuredClone(model);
    changed.editor_state.content[0].attrs = { ...changed.editor_state.content[0].attrs, textAlign: 'center' };
    await upsertDocumentDraft({ workspace_id: 'workspace-1', document_id: record.record_id, title: record.title,
      ...changed, base_available: true, base_row_version: 43, draft_status: 'dirty' });
    store.docEditAccessGeneration = 9;
    store.scheduleDocAutosave = vi.fn();
    await store.restoreSelectedDocDraft(record, { generation: 9 });
    expect(await getDocumentDraft('workspace-1', record.record_id)).toMatchObject({ editor_state: changed.editor_state });
    expect(store.docEditDraftDirty).toBe(true);
  });

  it('snapshots the outgoing document draft before navigation changes selection', async () => {
    const outgoingModel = richDocContentModel('Last word before navigation');
    const { record, store } = createSyncedPgDocSaveStore({ currentModel: outgoingModel });
    const nextRecord = {
      ...record,
      record_id: 'doc-next',
      title: 'Next document',
      version: 1,
      pg_canonical_version_id: 'doc-next:1',
    };
    store.documents = [record, nextRecord];
    store.prefetchFlightDeckDoc = vi.fn().mockResolvedValue(nextRecord);
    store.inspectSelectedDocEditLease = vi.fn();
    store.loadDocEditorFromSelection = vi.fn();

    store.openDoc(nextRecord.record_id, { ensureSync: false, syncRoute: false });

    expect(store.selectedDocId).toBe(nextRecord.record_id);
    await vi.waitFor(async () => {
      expect(await getDocumentDraft('workspace-1', record.record_id)).toMatchObject({
        content: outgoingModel.content,
        document_id: record.record_id,
      });
    });
  });

  it('checkpoints a wiki draft durably while a pending save never gates selection or prematurely releases its lease', async () => {
    const outgoingModel = richDocContentModel('Durable outgoing typing');
    const { record, store } = createSyncedPgDocSaveStore({ currentModel: outgoingModel });
    const next = { ...record, record_id: 'doc-next', content: 'Local target' };
    store.documents = [record, next];
    store.selectedChannelId = record.pg_channel_id;
    store.navSection = 'docs'; store.docsHomeVisit = 0;
    let finish;
    store.pgDocSavePromises = { [record.record_id]: new Promise(resolve => { finish = resolve; }) };
    store.hydrateSelectedDocWithRetry = vi.fn(() => new Promise(() => {}));
    store.inspectSelectedDocEditLease = vi.fn();
    store.loadDocEditorFromSelection = vi.fn();
    const persist = vi.spyOn(store, 'persistSelectedDocDraft');
    releaseTowerPgEditLeaseMock.mockClear();
    expect(await store.followDocWikiLink(next.record_id)).toBe(true);
    expect(store.selectedDocId).toBe(next.record_id);
    expect(persist).toHaveBeenCalledOnce();
    expect(await getDocumentDraft('workspace-1', record.record_id)).toMatchObject({ content: outgoingModel.content });
    expect(releaseTowerPgEditLeaseMock).not.toHaveBeenCalled();
    delete store.pgDocSavePromises[record.record_id]; finish();
    await vi.waitFor(() => expect(releaseTowerPgEditLeaseMock).toHaveBeenCalledOnce());
  });

  it('restores a stale-base local draft as an editable recovery conflict', async () => {
    const restoredModel = richDocContentModel('Draft based on version 42');
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: 'doc-save-race',
      ...restoredModel,
      base_available: true,
      base_row_version: 42,
      base_version_id: 'doc-save-race:42',
      base_body_sha256_hex: 'c'.repeat(64),
      draft_status: 'dirty',
    });
    const { adapter, record, store } = createSyncedPgDocSaveStore({ draftDirty: false });
    store.docEditAccessGeneration = 2;

    await store.restoreSelectedDocDraft(record, { generation: 2 });

    expect(store.docEditAccessState).toBe('recovery');
    expect(store.docEditConflict).toMatchObject({ baseVersion: 42, currentVersion: 43 });
    expect(store.docEditorContent).toBe(restoredModel.content);
    expect(adapter.setEditable).toHaveBeenLastCalledWith(true);
  });

  it('does not create or retain a dirty draft for an unchanged canonical save', async () => {
    const unchanged = richDocContentModel('Original body');
    const { record, store } = createSyncedPgDocSaveStore({
      content: unchanged.content,
      currentModel: unchanged,
      draftDirty: false,
    });
    await upsertDocumentDraft({
      workspace_id: 'workspace-1',
      document_id: record.record_id,
      content: unchanged.content,
      base_available: true,
      base_row_version: 43,
      base_version_id: 'doc-save-race:43',
      base_body_sha256_hex: 'b'.repeat(64),
      draft_status: 'dirty',
    });

    await expect(store.saveSelectedPgDocItem(record, 'npub1owner', { autosave: true })).resolves.toBe(record);

    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
    expect(await getDocumentDraft('workspace-1', record.record_id)).toBeUndefined();
  });

  it('uses a no-complete-base save to create a non-head recovery without a lease', async () => {
    const recoveryModel = richDocContentModel('Locally recoverable body');
    const { modelRef, record, store } = createSyncedPgDocSaveStore({ currentModel: recoveryModel });
    store.documents = [{
      ...record,
      content: 'Inline preview only',
      content_blocks: [],
      editor_state: null,
      content_storage_status: 'error',
    }];
    store.docEditBaseRowVersion = 0;
    store.docEditBaseVersionId = null;
    store.docEditBaseBodySha256Hex = null;
    store.docEditBaseStorageObjectId = null;
    store.docEditBaseAvailable = false;
    store.docEditAccessState = 'recovery';
    store.pgEditLeaseSessions = {};
    const recoveryError = new Error('Tower preserved recovery');
    recoveryError.status = 409;
    recoveryError.code = 'document_recovery_created';
    recoveryError.payload = {
      code: 'document_recovery_created',
      current_head: { row_version: 43, version_id: 'doc-save-race:43', body_sha256_hex: 'b'.repeat(64) },
      recovery: {
        id: 'recovery-no-base',
        reason_code: 'base_unavailable',
        resolution_state: 'open',
        base: null,
        head_at_creation: { row_version: 43 },
        submitted_body: { storage_object_id: 'storage-recovery', body_sha256_hex: 'a'.repeat(64) },
      },
    };
    updateTowerPgDocMock.mockRejectedValueOnce(recoveryError);

    expect(store.isSelectedDocDraftReadyForPersistence()).toBe(true);
    await expect(store.saveSelectedDocItem({ autosave: false })).resolves.toBeNull();

    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
    expect(updateTowerPgDocMock.mock.calls[0][2]).toMatchObject({
      base_available: false,
      storage_object_id: expect.any(String),
    });
    expect(updateTowerPgDocMock.mock.calls[0][2]).not.toHaveProperty('lease_token');
    expect(store.docRecovery).toMatchObject({ id: 'recovery-no-base', reason_code: 'base_unavailable' });
    expect(store.docEditAccessState).toBe('recovery');
    expect(store.docEditDraftDirty).toBe(false);

    modelRef.current = richDocContentModel('A newer local recovery edit');
    store.docEditDraftDirty = true;
    await store.persistSelectedDocDraft();
    expect(await getDocumentDraft('workspace-1', 'doc-save-race')).toMatchObject({
      draft_status: 'dirty',
      recovery_id: 'recovery-no-base',
      content: modelRef.current.content,
    });
  });

  it('promotes and discards recoveries through optimistic Tower actions', async () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue('recovery-renew-timer');
    releaseTowerPgEditLeaseMock.mockResolvedValue({});
    acquireTowerPgEditLeaseMock.mockResolvedValue({
      lease: { id: 'lease-current', lease_token: 'lease-current-head' },
    });
    getTowerPgDocRecoveryMock.mockResolvedValue({
      recovery: { id: 'recovery-1', resolution_state: 'open' },
      current_head: {
        row_version: 43,
        version_id: 'doc-save-race:43',
        body_sha256_hex: 'b'.repeat(64),
      },
    });
    promoteTowerPgDocRecoveryMock.mockResolvedValue({
      ...acceptedPgDoc(44, 'Recovered body'),
      recovery: { id: 'recovery-1', resolution_state: 'promoted' },
    });
    const { record, store } = createSyncedPgDocSaveStore({ draftDirty: false });
    store.docRecovery = { id: 'recovery-1', resolution_state: 'open' };
    store.docLocalDraft = { content: 'Recovered body', title: 'Race document' };

    await expect(store.promoteSelectedDocRecovery()).resolves.toBe(true);
    expect(promoteTowerPgDocRecoveryMock).toHaveBeenCalledWith(
      'workspace-1',
      'doc-save-race',
      'recovery-1',
      {
        row_version: 43,
        base_version_id: 'doc-save-race:43',
        base_body_sha256_hex: 'b'.repeat(64),
        lease_token: 'lease-current-head',
      },
      { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' },
    );
    expect(store.docEditBaseRowVersion).toBe(44);

    store.docRecovery = { id: 'recovery-2', resolution_state: 'open' };
    discardTowerPgDocRecoveryMock.mockResolvedValue({
      recovery: { id: 'recovery-2', resolution_state: 'discarded' },
    });
    store.refreshDocuments = vi.fn();
    await expect(store.discardSelectedDocRecovery()).resolves.toBe(true);
    expect(discardTowerPgDocRecoveryMock).toHaveBeenCalledWith(
      'workspace-1',
      'doc-save-race',
      'recovery-2',
      { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' },
    );
    expect(store.docRecovery).toBeNull();
  });
});

describe('docsManagerMixin canonical row normalization', () => {
  beforeEach(async () => {
    await openWorkspaceDb('npub1signedinactor').open();
    updateTowerPgDocMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deduplicates an immediate unchanged autosave after Tower accepts N+1', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
    let resolvePatch;
    updateTowerPgDocMock.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const firstModel = richDocContentModel('One deliberate edit');
    const { store } = createSyncedPgDocSaveStore({ currentModel: firstModel });

    const firstSave = store.saveSelectedDocItem({ autosave: false });
    await vi.waitFor(() => expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1));
    const immediateAutosave = store.saveSelectedDocItem({ autosave: true });
    resolvePatch(acceptedPgDoc(44, firstModel.content));

    await expect(Promise.all([firstSave, immediateAutosave])).resolves.toEqual([
      expect.objectContaining({ version: 44 }),
      expect.objectContaining({ version: 44 }),
    ]);
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
    expect(store.prepareDocumentContentForEnvelope).toHaveBeenCalledTimes(1);
    expect(store.docEditBaseRowVersion).toBe(44);
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docEditAccessState).not.toBe('conflict');
  });

  it('advances the edit base before the production command reconciliation publishes N+1', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    const savedModel = richDocContentModel('Production command edit');
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, savedModel.content));
    const { record, store } = createSyncedPgDocSaveStore({ currentModel: savedModel });
    await upsertDocument(record);

    const service = new TowerSyncService({
      workspaceKey: 'workspace-1',
      ports: {
        prepareCommand(name, input) {
          const descriptor = prepareTowerWorkspaceCommand(store, name, input);
          const reconcile = descriptor.reconcile;
          return {
            ...descriptor,
            async reconcile(acknowledgement) {
              const result = await reconcile(acknowledgement);
              store.documents = [await getDocumentById(record.record_id)];
              store.observeSelectedDocAuthoritativeVersion();
              return result;
            },
          };
        },
      },
    });
    store.commandTowerWorkspace = (name, input, options) => service.command(name, input, options);

    await expect(store.saveSelectedDocItem({ autosave: false })).resolves.toMatchObject({ version: 44 });

    expect(store.docEditBaseRowVersion).toBe(44);
    expect(store.docEditAccessState).toBe('editing');
    expect(store.docEditConflict).toBeNull();
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted N+1 row and edit base when older hydration reaches Dexie later', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
    const savedModel = richDocContentModel('Accepted body');
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, savedModel.content));
    const { record, store } = createSyncedPgDocSaveStore({ currentModel: savedModel });

    await store.saveSelectedDocItem({ autosave: false });
    await upsertDocument({ ...record, title: 'Stale hydration', content: 'Old body', version: 43 });

    expect(await getDocumentById(record.record_id)).toMatchObject({
      title: 'Race document',
      content: savedModel.content,
      version: 44,
    });
    expect(store.selectedDocument).toMatchObject({ content: savedModel.content, version: 44 });
    expect(store.docEditBaseRowVersion).toBe(44);
    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(false);
  });

  it('keeps an accepted N+1 base and complete model when same-version hydration is sparse', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
    const savedModel = richDocContentModel('Accepted body before sparse hydration');
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, savedModel.content));
    const { record, store } = createSyncedPgDocSaveStore({ currentModel: savedModel });

    await store.saveSelectedDocItem({ autosave: false });
    const accepted = await getDocumentById(record.record_id);
    await upsertDocument({
      ...accepted,
      content_blocks: [],
      editor_state: null,
      content_storage_status: 'remote',
      content_sha256_hex: null,
      pg_canonical_body_sha256_hex: null,
    });
    const reconciled = await getDocumentById(record.record_id);
    store.documents = [reconciled];

    expect(reconciled).toMatchObject({
      version: 44,
      content: savedModel.content,
      content_blocks: savedModel.content_blocks,
      editor_state: savedModel.editor_state,
      content_sha256_hex: 'a'.repeat(64),
      pg_canonical_body_sha256_hex: 'a'.repeat(64),
    });
    expect(store.docEditBaseRowVersion).toBe(44);
    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(false);
    expect(store.docEditConflict).toBeNull();
  });

  it('serializes edits entered during a PATCH and saves the follow-up once against N+1', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
    let resolveFirstPatch;
    const firstModel = richDocContentModel('First edit');
    const secondModel = richDocContentModel('Second edit entered while saving');
    updateTowerPgDocMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstPatch = resolve; }))
      .mockResolvedValueOnce(acceptedPgDoc(45, secondModel.content));
    const { modelRef, store } = createSyncedPgDocSaveStore({ currentModel: firstModel });

    const firstSave = store.saveSelectedDocItem({ autosave: true });
    await vi.waitFor(() => expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1));
    modelRef.current = secondModel;
    store.docEditDraftDirty = true;
    const queuedSave = store.saveSelectedDocItem({ autosave: true });
    resolveFirstPatch(acceptedPgDoc(44, firstModel.content));

    await expect(Promise.all([firstSave, queuedSave])).resolves.toEqual([
      expect.objectContaining({ version: 44 }),
      expect.objectContaining({ version: 45 }),
    ]);
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(2);
    expect(updateTowerPgDocMock.mock.calls.map((call) => call[2].row_version)).toEqual([43, 44]);
    expect(updateTowerPgDocMock.mock.calls[1][2].summary).toBe(secondModel.content);
    expect(store.selectedDocument).toMatchObject({ content: secondModel.content, version: 45 });
    expect(store.docEditBaseRowVersion).toBe(45);
    expect(store.docEditDraftDirty).toBe(false);
  });

  it('reconciles a successful canonical response without emitting an editor update or duplicating content', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocMock.mockReset();
    const model = richDocContentModel('Stable accepted content');
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, model.content));
    const { adapter, store } = createSyncedPgDocSaveStore({ currentModel: model });

    await store.saveSelectedDocItem({ autosave: false });

    expect(adapter.setContent).not.toHaveBeenCalled();
    expect(adapter.getContentModel()).toEqual(model);
    expect(store.selectedDocument.content).toBe(model.content);
    expect(store.docEditorContent).toBe(model.content);
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docEditBaseVersionId).toBe('doc-save-race:44');
    expect(store.docEditBaseBodySha256Hex).toBe('a'.repeat(64));
    expect(await getDocumentDraft('workspace-1', 'doc-save-race')).toBeUndefined();
    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(false);
  });

  it('does not save an unchanged PG Markdown hydration with rich ordered-list items', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const source = [
      '1. **Uncertainty:** Sentence ending with punctuation.',
      '2. **Path:** Keep C:\\docs\\draft.md.',
    ].join('\n');
    const hydratedModel = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(source));
    const reopenedModel = createDocumentEditorState({
      content: hydratedModel.content,
      content_blocks: hydratedModel.content_blocks,
      editor_state: null,
      pg_backend: true,
      pg_record_type: 'doc',
    }).contentModel;
    const { store } = createSyncedPgDocSaveStore({
      content: hydratedModel.content,
      currentModel: reopenedModel,
    });

    await expect(store.saveSelectedDocItem({ autosave: true })).resolves.toMatchObject({
      content: hydratedModel.content,
      version: 43,
    });

    expect(reopenedModel.content).toBe(hydratedModel.content);
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
    expect(store.prepareDocumentContentForEnvelope).not.toHaveBeenCalled();
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docAutosaveState).toBe('saved');
  });

  it('keeps an unchanged raw 26,706-character body byte-identical through four open/save/reload cycles', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const source = buildSyntheticLongDocumentFixture();
    expect(source).not.toContain('\\');

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const reopened = createDocumentEditorState({
        content: source,
        content_blocks: [],
        content_format: null,
        editor_state: null,
      }).contentModel;
      const { store } = createSyncedPgDocSaveStore({
        content: source,
        currentModel: reopened,
        contentBlocks: [],
        contentFormat: null,
        draftDirty: false,
      });

      await expect(store.saveSelectedDocItem({ autosave: true })).resolves.toMatchObject({
        content: source,
        version: 43,
      });
      expect(store.selectedDocument.content).toBe(source);
      expect(store.selectedDocument.content).toContain('## 12-month implementation timeline');
      expect(store.selectedDocument.content).toContain('TAIL_SENTINEL: synthetic-long-document-complete');
      expect(store.selectedDocument.content).not.toContain('\\');
    }

    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });

  it('rebases a clean open editor when a newer authoritative long body arrives', () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const staleModel = richDocContentModel('Stale editor prefix without the timeline');
    const source = buildSyntheticLongDocumentFixture();
    const { adapter, record, store } = createSyncedPgDocSaveStore({
      content: staleModel.content,
      currentModel: staleModel,
      draftDirty: false,
    });
    store.documents = [{
      ...record,
      version: 44,
      content: source,
      content_format: null,
      content_blocks: [],
      editor_state: null,
    }];

    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(true);
    expect(adapter.setContent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'doc' }),
      { emitUpdate: false, preserveSelection: true },
    );
    expect(store.docEditorContent).toBe(source);
    expect(store.docEditorContent).toContain('TAIL_SENTINEL: synthetic-long-document-complete');
    expect(store.docEditBaseRowVersion).toBe(44);
    expect(store.docEditDraftDirty).toBe(false);
    expect(store.docEditConflict).toBeNull();
  });

  it('waits for the typed body hydration before rebasing a newer storage-backed row', () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const staleModel = richDocContentModel('Current hydrated body');
    const source = buildSyntheticLongDocumentFixture();
    const { adapter, record, store } = createSyncedPgDocSaveStore({
      content: staleModel.content,
      currentModel: staleModel,
      draftDirty: false,
    });
    const remote = {
      ...record,
      version: 44,
      content: 'x'.repeat(8_192),
      content_blocks: [],
      editor_state: null,
      content_storage_object_id: 'object-v44',
      content_storage_status: 'remote',
      content_size_bytes: 12_000,
    };
    store.documents = [remote];

    expect(isDocumentContentReadyForEditor(remote)).toBe(false);
    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(false);
    expect(adapter.setContent).not.toHaveBeenCalled();
    expect(store.docEditBaseRowVersion).toBe(43);

    const hydrated = {
      ...remote,
      content: source,
      content_storage_status: 'loaded',
    };
    store.documents = [hydrated];
    expect(isDocumentContentReadyForEditor(hydrated)).toBe(true);
    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(true);
    expect(store.docEditorContent).toBe(source);
    expect(store.docEditBaseRowVersion).toBe(44);
  });

  it('recognizes explicit local editor models on fresh storage-backed remote rows', () => {
    const contentModel = richDocContentModel('Authoritative local body');
    const base = {
      content: 'Authoritative local body',
      content_storage_object_id: 'object-local',
      content_storage_status: 'remote',
      content_size_bytes: 30_000,
    };

    expect(isDocumentContentReadyForEditor({
      ...base,
      content_blocks: [],
      editor_state: contentModel.editor_state,
    })).toBe(true);
    expect(isDocumentContentReadyForEditor({
      ...base,
      content_blocks: contentModel.content_blocks,
      editor_state: null,
    })).toBe(true);
  });

  it('submits a stale dirty buffer so Tower can preserve it as a typed recovery', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const source = buildSyntheticLongDocumentFixture();
    const staleModel = richDocContentModel('Stale editor prefix without the timeline');
    const { record, store } = createSyncedPgDocSaveStore({
      content: staleModel.content,
      currentModel: staleModel,
    });
    const authoritative = {
      ...record,
      version: 44,
      content: source,
      content_format: null,
      content_blocks: [],
    };
    store.documents = [authoritative];

    const recoveryError = new Error('Tower preserved recovery');
    recoveryError.status = 409;
    recoveryError.code = 'document_recovery_created';
    recoveryError.payload = {
      code: 'document_recovery_created',
      current_head: { row_version: 44, version_id: 'doc-save-race:44', body_sha256_hex: 'c'.repeat(64) },
      recovery: {
        id: 'recovery-1',
        reason_code: 'stale_base',
        resolution_state: 'open',
        base: { row_version: 43, version_id: 'doc-save-race:43', body_sha256_hex: 'b'.repeat(64) },
        head_at_creation: { row_version: 44 },
        submitted_body: { storage_object_id: 'storage-recovery', body_sha256_hex: 'a'.repeat(64) },
      },
    };
    updateTowerPgDocMock.mockRejectedValueOnce(recoveryError);

    await expect(store.saveSelectedPgDocItem(authoritative, 'npub1owner', { autosave: false })).resolves.toBeNull();
    expect(store.docEditConflict).toMatchObject({ baseVersion: 43, currentVersion: 44 });
    expect(store.docEditAccessState).toBe('recovery');
    expect(store.docRecovery).toMatchObject({ id: 'recovery-1', reason_code: 'stale_base' });
    expect(store.prepareDocumentContentForEnvelope).toHaveBeenCalledTimes(1);
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('refuses a changed model whose serialized Markdown drops semantic tail content (autosave=%s)', async (autosave) => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const source = buildSyntheticLongDocumentFixture();
    const full = createDocumentEditorState({ content: source, content_blocks: [] }).contentModel;
    const partialState = { ...full.editor_state, content: full.editor_state.content.slice(0, 10) };
    const partial = prosemirrorToFlightDeckContentModel(partialState);
    const lossy = { ...full, content: partial.content, content_blocks: partial.content_blocks };
    const { record, store } = createSyncedPgDocSaveStore({
      content: source,
      currentModel: lossy,
      contentBlocks: [],
      contentFormat: null,
    });

    await expect(store.saveSelectedPgDocItem(record, 'npub1owner', { autosave })).resolves.toBeNull();
    expect(store.docAutosaveState).toBe('error');
    expect(store.docEditAccessMessage).toContain('complete document');
    if (!autosave) expect(store.error).toContain('complete document');
    expect(store.docEditDraftDirty).toBe(true);
    expect(await getDocumentDraft('workspace-1', record.record_id)).toMatchObject({ content: lossy.content, editor_state: lossy.editor_state });
    expect(store.prepareDocumentContentForEnvelope).not.toHaveBeenCalled();
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });

  it.each([false, true].flatMap(autosave => [shortRichDocumentFixture, richBreakDocumentFixture].map(fixture => [autosave, fixture])))('saves complete rich content and reopens it repeatedly (autosave=%s, fixture=%s)', async (autosave, fixture) => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const original = fixture();
    let model = prosemirrorToFlightDeckContentModel(original);
    const markdown = model.content;
    for (let cycle = 0; cycle < 3; cycle++) {
      updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, model.content));
      const { store } = createSyncedPgDocSaveStore({ currentModel: model });
      const saved = await store.saveSelectedDocItem({ autosave });
      expect(saved).toMatchObject({ version: 44, content: markdown, editor_state: model.editor_state });
      expect(store.docAutosaveState).toBe('saved');
      expect(store.docEditDraftDirty).toBe(false);
      expect(store.prepareDocumentContentForEnvelope.mock.calls[0][1]).toMatchObject(model);
      expect(validateDocumentContentModelRoundTrip({ ...saved, editor_state: original })).toEqual({ ok: true });
      // Exercise both rich-state reopen and Markdown-only compatibility reopen.
      expect(createDocumentEditorState(saved).editorState).toEqual(model.editor_state);
      model = createDocumentEditorState({ ...saved, editor_state: null }).contentModel;
      expect(model.content).toBe(markdown);
    }
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(3);
  });

  it('saves a rich list with an insignificant trailing prose space', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const model = prosemirrorToFlightDeckContentModel({ type: 'doc', content: [
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Synthetic prose item. ' }] },
      ] }] },
    ] });
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, model.content));
    const { store } = createSyncedPgDocSaveStore({ currentModel: model });
    await expect(store.saveSelectedDocItem({ autosave: false })).resolves.toMatchObject({ version: 44 });
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
  });

  it('saves and persists marked boundary spaces without losing the draft content', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const model = prosemirrorToFlightDeckContentModel({ type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'Label: ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'Retained body.' },
      ] },
    ] });
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, model.content));
    const { store } = createSyncedPgDocSaveStore({ currentModel: model });
    const saved = await store.saveSelectedDocItem({ autosave: false });
    expect(saved).toMatchObject({ version: 44, content: model.content });
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
    expect(store.prepareDocumentContentForEnvelope).toHaveBeenCalledTimes(1);
    const reopened = createDocumentEditorState({ ...saved, editor_state: null }).contentModel;
    expect(reopened.editor_state.content[0].content[0]).toMatchObject({
      text: 'Label: ', marks: [{ type: 'bold' }],
    });
  });

  it('allows a valid intentional deletion because the smaller editor state round-trips completely', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const source = buildSyntheticLongDocumentFixture();
    const deletion = richDocContentModel('Deliberately retained summary');
    updateTowerPgDocMock.mockResolvedValueOnce(acceptedPgDoc(44, deletion.content));
    const { store } = createSyncedPgDocSaveStore({
      content: source,
      currentModel: deletion,
      contentBlocks: [],
      contentFormat: null,
    });

    await expect(store.saveSelectedDocItem({ autosave: false })).resolves.toMatchObject({
      version: 44,
      content: deletion.content,
    });
    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
    expect(store.prepareDocumentContentForEnvelope).toHaveBeenCalledTimes(1);
    expect(store.docEditConflict).toBeNull();
  });

  it('still enters safe conflict when a genuinely newer external row arrives over a dirty draft', () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const { adapter, record, store } = createSyncedPgDocSaveStore();
    store.documents = [{ ...record, version: 44, content: 'Other client body' }];

    expect(store.observeSelectedDocAuthoritativeVersion()).toBe(true);
    expect(store.docEditConflict).toMatchObject({ baseVersion: 43, currentVersion: 44 });
    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docEditAccessState).toBe('recovery');
    expect(adapter.setEditable).toHaveBeenLastCalledWith(true);
    expect(updateTowerPgDocMock).not.toHaveBeenCalled();
  });

  it('keeps a long rich document serializable and stable across storage and reopen', () => {
    const editorState = {
      type: 'doc',
      content: Array.from({ length: 500 }, (_, index) => ({
        type: index % 11 === 0 ? 'heading' : 'paragraph',
        attrs: index % 11 === 0
          ? { level: 2, fdBlockId: `long-block-${index}` }
          : { fdBlockId: `long-block-${index}` },
        content: [{ type: 'text', text: `Spiral interview note ${index}: durable rich content with punctuation — and context.` }],
      })),
    };
    const original = prosemirrorToFlightDeckContentModel(editorState);
    const stored = JSON.parse(JSON.stringify({
      record_id: 'doc-long-rich',
      title: 'Spiral AI Grant — Wingman Interview Notes and Proposal Draft',
      ...original,
    }));
    const reopened = createDocumentEditorState(stored).contentModel;

    expect(original.content.length).toBeGreaterThan(25_000);
    expect(reopened.content).toBe(original.content);
    expect(reopened.editor_state).toEqual(editorState);
    expect(reopened.content_blocks).toEqual(original.content_blocks);
  });

  it('uploads document content for envelope storage', async () => {
    prepareStorageObjectMock.mockResolvedValue({ object_id: 'storage-doc-1', upload_url: '' });
    uploadStorageObjectMock.mockResolvedValue({});
    completeStorageObjectMock.mockResolvedValue({});

    const store = createStore({
      workspaceOwnerNpub: 'npub1workspace',
      _resolveDocGroupRef: (value) => String(value || '').trim() || null,
    });
    const contentModel = {
      content: 'Transcript line\n'.repeat(6000),
      content_format: 'block_document_v1',
      content_blocks: [{ id: 'blk-1', type: 'markdown', text: 'Transcript line'.repeat(6000), attrs: {} }],
    };

    const payload = await store.prepareDocumentContentForEnvelope({
      record_id: 'doc-large',
      owner_npub: 'npub1workspace',
      title: 'Transcript',
      write_group_ref: 'group-1',
      shares: [],
    }, contentModel, ['group-1']);

    expect(prepareStorageObjectMock).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub1workspace',
      owner_group_id: 'group-1',
      access_group_ids: ['group-1'],
      content_type: DOCUMENT_CONTENT_STORAGE_MIME,
    }));
    expect(uploadStorageObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'storage-doc-1' }),
      expect.any(Uint8Array),
      DOCUMENT_CONTENT_STORAGE_MIME,
    );
    expect(completeStorageObjectMock).toHaveBeenCalledWith('storage-doc-1', expect.objectContaining({
      size_bytes: expect.any(Number),
      sha256_hex: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(payload.content_storage_object_id).toBe('storage-doc-1');
    expect(payload.content_storage_format).toBe(DOCUMENT_CONTENT_STORAGE_FORMAT);
    expect(payload.content).toHaveLength(8192);
    expect(payload.content_blocks).toEqual([]);
  });

  it('uploads small document content for envelope storage', async () => {
    prepareStorageObjectMock.mockResolvedValue({ object_id: 'storage-small-doc-1', upload_url: '' });
    uploadStorageObjectMock.mockResolvedValue({});
    completeStorageObjectMock.mockResolvedValue({});

    const store = createStore({
      workspaceOwnerNpub: 'npub1workspace',
      _resolveDocGroupRef: (value) => String(value || '').trim() || null,
    });
    const contentModel = {
      content: 'Short note',
      content_format: 'block_document_v1',
      content_blocks: [{ id: 'blk-1', type: 'markdown', text: 'Short note', attrs: {} }],
    };

    const payload = await store.prepareDocumentContentForEnvelope({
      record_id: 'doc-small',
      owner_npub: 'npub1workspace',
      title: 'Small note',
      write_group_ref: 'group-1',
      shares: [],
    }, contentModel, ['group-1']);

    expect(prepareStorageObjectMock).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub1workspace',
      content_type: DOCUMENT_CONTENT_STORAGE_MIME,
      file_name: 'Small_note-doc-small.document.json',
    }));
    expect(uploadStorageObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: 'storage-small-doc-1' }),
      expect.any(Uint8Array),
      DOCUMENT_CONTENT_STORAGE_MIME,
    );
    expect(payload.content_storage_object_id).toBe('storage-small-doc-1');
    expect(payload.content_storage_format).toBe(DOCUMENT_CONTENT_STORAGE_FORMAT);
    expect(payload.content).toBe('Short note');
    expect(payload.content_blocks).toEqual([]);
  });

  it('builds ProseMirror document content when saving legacy block edits', () => {
    const store = createStore({
      selectedDocType: 'document',
      selectedDocId: 'doc-prose',
      documents: [{
        record_id: 'doc-prose',
        title: 'Legacy block doc',
        content: 'Old body',
        content_blocks: [{ id: 'old-block', type: 'markdown', text: 'Old body', attrs: {} }],
      }],
      docEditorMode: 'block',
      docEditorContent: 'Updated body',
      docEditorBlocks: [{ id: 'block-1', type: 'markdown', text: 'Updated body', attrs: {} }],
    });

    const contentModel = store.buildSelectedDocContentModel();

    expect(contentModel.content_format).toBe(FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT);
    expect(contentModel.editor_state).toMatchObject({ type: 'doc' });
    expect(contentModel.content).toContain('Updated body');
  });

  it('creates PG documents through Tower without encrypted pending writes', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    prepareTowerPgStorageObjectMock.mockResolvedValue({ object_id: 'storage-pg-doc-1', upload_url: '' });
    uploadStorageObjectMock.mockResolvedValue({});
    completeStorageObjectMock.mockResolvedValue({});
    createTowerPgChannelDocMock.mockResolvedValue({
      doc: {
        id: 'pg-doc-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'storage-pg-doc-1',
        title: 'PG document',
        metadata: { thread_id: 'thread-1' },
        row_version: 1,
      },
    });

    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      selectedChannelId: 'channel-1',
      selectedBoardId: '',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      getInheritedDirectoryShares: vi.fn(() => []),
      buildDocAccessForScope: vi.fn(() => ({
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        shares: [],
        group_ids: [],
      })),
      refreshDocuments: vi.fn(async function refreshDocuments() {
        this.documents = [{
          record_id: 'pg-doc-1',
          title: 'PG document',
          pg_backend: true,
          pg_channel_id: 'channel-1',
          pg_thread_id: 'thread-1',
        }];
        return this.documents;
      }),
      openDoc: vi.fn(),
    });

    const row = await store.createDocument('PG document', {
      scopeId: 'scope-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });

    expect(prepareStorageObjectMock).not.toHaveBeenCalled();
    expect(prepareTowerPgStorageObjectMock).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
      owner_npub: 'npub1pgworkspace',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(createTowerPgChannelDocMock).toHaveBeenCalledWith('workspace-1', 'channel-1', expect.objectContaining({
      title: 'PG document',
      storage_object_id: 'storage-pg-doc-1',
      metadata: { thread_id: 'thread-1', mentions: [] },
      mentions: [],
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(row).toMatchObject({ record_id: 'pg-doc-1', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1' });
    expect(await getPendingWrites()).toEqual([]);
  });

  it('reconciles an accepted PG create when the POST response is lost', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    const accepted = {
      id: 'pg-doc-accepted-after-timeout',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      storage_object_id: 'storage-ambiguous-create',
      title: 'Recovered create',
      summary: 'Preserved body',
      metadata: {},
      row_version: 1,
    };
    getTowerPgChannelDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [accepted] });
    createTowerPgChannelDocMock.mockRejectedValueOnce(Object.assign(new Error('request timed out'), {
      name: 'TimeoutError',
    }));
    const store = createStore({
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
    });

    const result = await createTowerPgDocFromLocal(store, {
      record_id: 'local-create-id',
      title: 'Recovered create',
      content: 'Preserved body',
      content_storage_object_id: 'storage-ambiguous-create',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      pg_channel_id: 'channel-1',
    });

    expect(result).toMatchObject({
      record_id: 'pg-doc-accepted-after-timeout',
      content_storage_object_id: 'storage-ambiguous-create',
    });
    expect(createTowerPgChannelDocMock).toHaveBeenCalledTimes(1);
    expect(getTowerPgChannelDocsMock).toHaveBeenCalledTimes(2);
  });

  it('does not repeat a PG create already accepted for the same storage object', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    getTowerPgChannelDocsMock.mockResolvedValueOnce({ docs: [{
      id: 'pg-doc-existing',
      workspace_id: 'workspace-1',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
      storage_object_id: 'storage-create-retry',
      title: 'Existing document',
      summary: 'Existing body',
      metadata: {},
      row_version: 1,
    }] });
    const store = createStore({
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      selectedChannelId: 'channel-1',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
    });

    const result = await createTowerPgDocFromLocal(store, {
      record_id: 'local-retry-id',
      title: 'Existing document',
      content: 'Existing body',
      content_storage_object_id: 'storage-create-retry',
      scope_id: 'scope-1',
      scope_l1_id: 'scope-1',
      pg_channel_id: 'channel-1',
    });

    expect(result.record_id).toBe('pg-doc-existing');
    expect(createTowerPgChannelDocMock).not.toHaveBeenCalled();
  });

  it('keeps offline-created PG documents local and editable until Tower accepts them', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    });
    isTowerPgBackendModeMock.mockReturnValue(true);
    prepareTowerPgStorageObjectMock.mockResolvedValue({ object_id: 'storage-pg-doc-local', upload_url: '' });
    uploadStorageObjectMock.mockResolvedValue({});
    completeStorageObjectMock.mockResolvedValue({});
    createTowerPgChannelDocMock.mockRejectedValueOnce(new Error('offline'));

    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      selectedChannelId: 'channel-1',
      selectedBoardId: '',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      getInheritedDirectoryShares: vi.fn(() => []),
      buildDocAccessForScope: vi.fn(() => ({
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
        scope_policy_group_ids: null,
        shares: [],
        group_ids: [],
      })),
      refreshDocuments: vi.fn(async function refreshDocuments() {
        return this.documents;
      }),
      openDoc: vi.fn(function openDoc(recordId) {
        this.selectedDocType = 'document';
        this.selectedDocId = recordId;
      }),
    });

    const row = await store.createDocument('Offline PG document', {
      scopeId: 'scope-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });

    expect(row).toMatchObject({
      pg_backend: true,
      pg_record_type: 'doc',
      sync_status: 'failed',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    });
    expect(store.error).toBe('PG document saved locally. Reconnect to sync it.');
    expect(await getPendingWrites()).toEqual([]);

    store.docEditorTitle = 'Offline PG document edited';
    store.docEditorBlocks = [{ id: 'block-1', type: 'markdown', text: 'Edited while offline', attrs: {} }];
    const edited = await store.saveSelectedDocItem({ autosave: false });

    expect(edited).toMatchObject({
      record_id: row.record_id,
      title: 'Offline PG document edited',
      content: 'Edited while offline',
      sync_status: 'failed',
      pg_backend: true,
    });
    expect(createTowerPgChannelDocMock).toHaveBeenCalledTimes(1);
    expect(await getPendingWrites()).toEqual([]);

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    createTowerPgChannelDocMock.mockResolvedValueOnce({
      doc: {
        id: 'pg-doc-accepted',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'storage-pg-doc-local',
        title: 'Offline PG document synced',
        metadata: { thread_id: 'thread-1' },
        row_version: 1,
      },
    });

    store.docEditorTitle = 'Offline PG document synced';
    store.docEditorBlocks = [{ id: 'block-1', type: 'markdown', text: 'Synced after reconnect', attrs: {} }];
    const accepted = await store.saveSelectedDocItem({ autosave: false });

    expect(accepted).toMatchObject({
      record_id: 'pg-doc-accepted',
      title: 'Offline PG document synced',
      sync_status: 'synced',
      pg_backend: true,
    });
    expect(await getDocumentById(row.record_id)).toBeUndefined();
    expect(await getDocumentById('pg-doc-accepted')).toMatchObject({
      title: 'Offline PG document synced',
      content: 'Synced after reconnect',
    });
    expect(store.selectedDocId).toBe('pg-doc-accepted');
    expect(store.documents.map((document) => document.record_id)).toEqual(['pg-doc-accepted']);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
  });

  it('preserves the local draft and refuses to overwrite Tower after a stale row_version conflict', async () => {
    const wsDb = openWorkspaceDb('npub1signedinactor');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    prepareTowerPgStorageObjectMock
      .mockResolvedValueOnce({ object_id: 'storage-pg-doc-first', upload_url: '' });
    uploadStorageObjectMock.mockResolvedValue({});
    completeStorageObjectMock.mockResolvedValue({});
    const stale = new Error('Tower PG API 409 PATCH https://tower.example/docs/doc-1: {"code":"stale_row_version"}');
    stale.status = 409;
    stale.responseText = '{"code":"stale_row_version"}';
    updateTowerPgDocMock.mockRejectedValueOnce(stale);

    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      documents: [{
        record_id: 'doc-1',
        owner_npub: 'npub1pgworkspace',
        title: 'Original title',
        content: 'Original body',
        content_blocks: [{ id: 'block-1', type: 'markdown', text: 'Original body', attrs: {} }],
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        pg_backend: true,
        pg_record_type: 'doc',
        pg_channel_id: 'channel-1',
        sync_status: 'synced',
        record_state: 'active',
        version: 1,
      }],
      selectedDocType: 'document',
      selectedDocId: 'doc-1',
      pgEditLeaseSessions: {
        'document:doc-1': { lease: { lease_token: 'lease-token' } },
      },
      docEditAccessState: 'editing',
      docEditDraftDirty: true,
      docEditBaseRecordId: 'doc-1',
      docEditBaseRowVersion: 1,
      docRichEditorAdapter: { setEditable: vi.fn() },
      refreshDocuments: vi.fn(async function refreshDocuments() {
        this.patchDocumentLocal({
          ...this.documents.find((item) => item.record_id === 'doc-1'),
          title: 'Server title',
          content: 'Server body',
          sync_status: 'synced',
          version: 2,
        });
        return this.documents;
      }),
    });
    store.docEditorTitle = 'Edited title';
    store.docEditorBlocks = [{ id: 'block-1', type: 'markdown', text: 'Edited body', attrs: {} }];

    await expect(store.saveSelectedDocItem({ autosave: false })).rejects.toBe(stale);

    expect(updateTowerPgDocMock).toHaveBeenCalledTimes(1);
    expect(updateTowerPgDocMock.mock.calls[0][2]).toMatchObject({ row_version: 1 });
    expect(store.selectedDocument).toMatchObject({ title: 'Server title', content: 'Server body', version: 2 });
    expect(store.docEditorTitle).toBe('Edited title');
    expect(store.docEditorBlocks).toEqual([{ id: 'block-1', type: 'markdown', text: 'Edited body', attrs: {} }]);
    expect(store.docEditAccessState).toBe('recovery');
    expect(store.docEditDraftDirty).toBe(true);
    expect(store.docAutosaveState).toBe('error');
  });

  it('loads PG document versions from the typed Tower route', async () => {
    isTowerPgBackendModeMock.mockReturnValue(true);
    getTowerPgDocVersionsMock.mockResolvedValue({
      versions: [
        {
          version: 2,
          title: 'PG document v2',
          updated_at: '2026-06-15T01:00:00.000Z',
          content: {
            content: 'Updated body',
            content_format: 'block_document_v1',
            content_blocks: [{ id: 'block-1', type: 'markdown', text: 'Updated body', attrs: {} }],
          },
        },
        {
          version: 1,
          title: 'PG document v1',
          updated_at: '2026-06-15T00:00:00.000Z',
          content: {
            content: 'Initial body',
            content_format: 'block_document_v1',
            content_blocks: [{ id: 'block-0', type: 'markdown', text: 'Initial body', attrs: {} }],
          },
        },
      ],
    });
    const store = createStore({
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      selectedDocId: 'doc-1',
      selectedDocType: 'document',
      documents: [{ record_id: 'doc-1', title: 'PG document', pg_backend: true, record_state: 'active' }],
      syncRoute: vi.fn(),
    });

    await store.openDocVersioning();

    expect(getTowerPgDocVersionsMock).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      limit: 50,
    });
    expect(store.docVersionHistory.map((version) => version.version)).toEqual([2, 1]);
    expect(store.docVersionHistory[0]).toMatchObject({
      title: 'PG document v2',
      content: 'Updated body',
      content_format: 'block_document_v1',
    });
    expect(store.docVersioningPreviewHtml).toContain('Updated body');
  });

  it('preserves non-writable delivery groups in canonical document rows', () => {
    const store = createStore();

    const normalized = store.normalizeDocumentRowGroupRefs({
      group_ids: ['g-allowed', 'g-hidden'],
      scope_policy_group_ids: ['g-allowed', 'g-hidden'],
      write_group_id: 'g-hidden',
      shares: [
        { type: 'group', group_id: 'g-allowed', access: 'write' },
        { type: 'group', group_id: 'g-hidden', access: 'write' },
        { type: 'person', person_npub: 'npub1friend', via_group_id: 'g-hidden', access: 'read' },
      ],
    });

    expect(normalized.group_ids).toEqual(['g-allowed', 'g-hidden']);
    expect(normalized.scope_policy_group_ids).toEqual(['g-allowed', 'g-hidden']);
    expect(normalized.shares).toHaveLength(3);
  });

  it('preserves non-writable delivery groups in canonical directory rows', () => {
    const store = createStore();

    const normalized = store.normalizeDirectoryRowGroupRefs({
      group_ids: ['g-allowed', 'g-hidden'],
      scope_policy_group_ids: ['g-hidden'],
      shares: [
        { type: 'group', group_id: 'g-allowed', access: 'write' },
        { type: 'group', group_id: 'g-hidden', access: 'read' },
      ],
    });

    expect(normalized.group_ids).toEqual(['g-hidden', 'g-allowed']);
    expect(normalized.scope_policy_group_ids).toEqual(['g-hidden']);
    expect(normalized.shares).toHaveLength(2);
    });
  });

  it('creates PG document comments through Tower and replaces the optimistic row', async () => {
    const wsDb = openWorkspaceDb('pg-doc-comment-create');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    createTowerPgDocCommentMock.mockResolvedValue({
      comment: {
        id: 'pg-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        body: 'Doc comment',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 5,
          anchor_end_line_number: 6,
          anchor_quote: 'Selected\nquote',
          anchor_start_offset: 12,
          anchor_end_offset: 28,
          comment_status: 'open',
        },
        row_version: 1,
      },
    });

    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      documents: [{
        record_id: 'doc-1',
        owner_npub: 'npub1pgworkspace',
        title: 'Doc',
        content: 'Body',
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        pg_backend: true,
        pg_record_type: 'doc',
        pg_channel_id: 'channel-1',
        sync_status: 'synced',
        record_state: 'active',
      }],
      selectedDocId: 'doc-1',
      selectedDocType: 'document',
      docComments: [],
      docCommentAudioDrafts: [],
      docCommentAnchorBlockId: 'block-1',
      docCommentAnchorLine: 5,
      docCommentAnchorEndLine: 6,
      docCommentAnchorQuote: 'Selected\nquote',
      docCommentAnchorStartOffset: 12,
      docCommentAnchorEndOffset: 28,
      newDocCommentBody: 'Doc comment',
      scheduleStorageImageHydration: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    await store.addDocComment();

    expect(createTowerPgDocCommentMock).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      body: 'Doc comment',
      mentions: [],
      metadata: {
        anchor_block_id: 'block-1',
        anchor_line_number: 5,
        anchor_end_line_number: 6,
        anchor_quote: 'Selected\nquote',
        anchor_start_offset: 12,
        anchor_end_offset: 28,
        client_record_id: expect.any(String),
        comment_status: 'open',
        mentions: [],
      },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.docComments).toHaveLength(1);
    expect(store.docComments[0]).toMatchObject({
      record_id: 'pg-comment-1',
      target_record_id: 'doc-1',
      anchor_block_id: 'block-1',
      anchor_line_number: 5,
      anchor_end_line_number: 6,
      anchor_quote: 'Selected\nquote',
      pg_backend: true,
      pg_record_type: 'doc_comment',
    });
    expect(store.selectedDocCommentId).toBe('pg-comment-1');
  });

  it('creates PG document comment replies with parent_comment_id', async () => {
    const wsDb = openWorkspaceDb('pg-doc-comment-reply-create');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    createTowerPgDocCommentMock.mockResolvedValue({
      comment: {
        id: 'pg-reply-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: 'root-1',
        body: 'Reply',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 5,
          anchor_end_line_number: 6,
          anchor_quote: 'Selected\nquote',
          anchor_start_offset: 12,
          anchor_end_offset: 28,
          comment_status: 'open',
        },
        row_version: 1,
      },
    });
    const rootComment = {
      record_id: 'root-1',
      target_record_id: 'doc-1',
      target_record_family_hash: recordFamilyHash('document'),
      parent_comment_id: null,
      anchor_block_id: 'block-1',
      anchor_line_number: 5,
      anchor_end_line_number: 6,
      anchor_quote: 'Selected\nquote',
      anchor_start_offset: 12,
      anchor_end_offset: 28,
      pg_metadata: {
        anchor_block_id: 'block-1',
        anchor_line_number: 5,
        anchor_end_line_number: 6,
        anchor_quote: 'Selected\nquote',
        anchor_start_offset: 12,
        anchor_end_offset: 28,
        comment_status: 'open',
      },
      body: 'Root',
      comment_status: 'open',
      record_state: 'active',
      updated_at: '2026-06-01T00:00:00.000Z',
    };

    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      documents: [{
        record_id: 'doc-1',
        owner_npub: 'npub1pgworkspace',
        title: 'Doc',
        content: 'Body',
        scope_id: 'scope-1',
        scope_l1_id: 'scope-1',
        pg_backend: true,
        pg_record_type: 'doc',
        pg_channel_id: 'channel-1',
        sync_status: 'synced',
        record_state: 'active',
      }],
      selectedDocId: 'doc-1',
      selectedDocType: 'document',
      selectedDocCommentId: 'root-1',
      docComments: [rootComment],
      docCommentReplyAudioDrafts: [],
      newDocCommentReplyBody: 'Reply',
      scheduleStorageImageHydration: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    await store.addDocCommentReply();

    expect(createTowerPgDocCommentMock).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      body: 'Reply',
      parent_comment_id: 'root-1',
      mentions: [],
      metadata: {
        anchor_block_id: 'block-1',
        anchor_line_number: 5,
        anchor_end_line_number: 6,
        anchor_quote: 'Selected\nquote',
        anchor_start_offset: 12,
        anchor_end_offset: 28,
        client_record_id: expect.any(String),
        comment_status: 'open',
        mentions: [],
      },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.docComments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: 'pg-reply-1',
        parent_comment_id: 'root-1',
        body: 'Reply',
        pg_record_type: 'doc_comment',
      }),
    ]));
  });

  it('resolves PG document comments through Tower', async () => {
    const wsDb = openWorkspaceDb('pg-doc-comment-status');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    updateTowerPgDocCommentMock.mockResolvedValue({
      comment: {
        id: 'root-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: null,
        body: 'Root',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 5,
          anchor_quote: 'Selected quote',
          anchor_start_offset: 12,
          anchor_end_offset: 26,
          comment_status: 'resolved',
        },
        row_version: 2,
      },
    });
    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      documents: [{ record_id: 'doc-1', pg_backend: true, pg_channel_id: 'channel-1', record_state: 'active' }],
      selectedDocId: 'doc-1',
      selectedDocType: 'document',
      selectedDocCommentId: 'root-1',
      docComments: [{
        record_id: 'root-1',
        target_record_id: 'doc-1',
        parent_comment_id: null,
        body: 'Root',
        anchor_block_id: 'block-1',
        anchor_line_number: 5,
        anchor_quote: 'Selected quote',
        anchor_start_offset: 12,
        anchor_end_offset: 26,
        pg_metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 5,
          anchor_quote: 'Selected quote',
          anchor_start_offset: 12,
          anchor_end_offset: 26,
          comment_status: 'open',
        },
        comment_status: 'open',
        record_state: 'active',
        version: 1,
      }],
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    await store.setDocCommentStatus('root-1', 'resolved');

    expect(updateTowerPgDocCommentMock).toHaveBeenCalledWith('workspace-1', 'doc-1', 'root-1', {
      comment_status: 'resolved',
      row_version: 1,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(store.docComments[0]).toMatchObject({
      record_id: 'root-1',
      comment_status: 'resolved',
      anchor_quote: 'Selected quote',
      anchor_start_offset: 12,
      anchor_end_offset: 26,
      version: 2,
    });
  });

  it('removes PG document comment threads through Tower', async () => {
    const wsDb = openWorkspaceDb('pg-doc-comment-delete');
    await wsDb.open();
    await Promise.all(wsDb.tables.map((table) => table.clear()));
    isTowerPgBackendModeMock.mockReturnValue(true);
    deleteTowerPgDocCommentMock.mockResolvedValue({
      comment: {
        id: 'root-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: null,
        body: 'Root',
        metadata: { comment_status: 'open' },
        record_state: 'deleted',
        row_version: 2,
      },
    });
    const store = createStore({
      workspaceOwnerNpub: 'npub1signedinactor',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1pgworkspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      documents: [{ record_id: 'doc-1', pg_backend: true, pg_channel_id: 'channel-1', record_state: 'active' }],
      selectedDocId: 'doc-1',
      selectedDocType: 'document',
      selectedDocCommentId: 'root-1',
      docComments: [
        {
          record_id: 'root-1',
          target_record_id: 'doc-1',
          parent_comment_id: null,
          body: 'Root',
          comment_status: 'open',
          record_state: 'active',
          version: 1,
        },
        {
          record_id: 'reply-1',
          target_record_id: 'doc-1',
          parent_comment_id: 'root-1',
          body: 'Reply',
          comment_status: 'open',
          record_state: 'active',
          version: 1,
        },
      ],
      clearDocCommentConnector: vi.fn(),
      scheduleDocCommentConnectorUpdate: vi.fn(),
    });

    await store.removeDocComment('root-1');

    expect(deleteTowerPgDocCommentMock).toHaveBeenCalledWith('workspace-1', 'doc-1', 'root-1', {
      rowVersion: 1,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(store.docComments.every((comment) => comment.record_state === 'deleted')).toBe(true);
    expect(store.selectedDocCommentId).toBeNull();
  });

describe('lock-managed checkout state helpers', () => {
  it('treats an expired lease as not held', () => {
    expect(isCheckoutHeld({
      state: 'checked_out',
      checkout_id: 'checkout-1',
      lease_expires_at: '2026-04-24T00:00:00.000Z',
    }, Date.parse('2026-04-24T00:00:01.000Z'))).toBe(false);
  });
});
