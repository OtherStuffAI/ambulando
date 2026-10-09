import { describe, expect, it, vi } from 'vitest';
import {
  applySelectedDocumentUpdate,
  documentLinkViewState,
  preserveHydratedDocumentContent,
} from '../src/document-selection.js';

function createStore(overrides = {}) {
  const store = {
    selectedDocId: 'doc-1',
    documents: [{
      record_id: 'doc-1',
      record_state: 'active',
      title: 'Original title',
    }],
    applyDocuments: vi.fn((documents) => {
      store.documents = documents;
    }),
    loadDocEditorFromSelection: vi.fn(),
    ...overrides,
  };

  Object.defineProperty(store, 'selectedDocument', {
    configurable: true,
    get() {
      return this.documents.find((item) => item.record_id === this.selectedDocId) ?? null;
    },
  });

  return store;
}

describe('applySelectedDocumentUpdate', () => {
  it('keeps the editor state intact when the selected doc refreshes in place', () => {
    const store = createStore();

    applySelectedDocumentUpdate(store, {
      record_id: 'doc-1',
      record_state: 'active',
      title: 'Updated title',
    });

    expect(store.applyDocuments).toHaveBeenCalledTimes(1);
    expect(store.selectedDocument?.title).toBe('Updated title');
    expect(store.loadDocEditorFromSelection).not.toHaveBeenCalled();
  });

  it('resets the editor when the selected doc disappears', () => {
    const store = createStore();

    applySelectedDocumentUpdate(store, {
      record_id: 'doc-1',
      record_state: 'deleted',
      title: 'Deleted title',
    });

    expect(store.applyDocuments).toHaveBeenCalledTimes(1);
    expect(store.selectedDocument).toBeNull();
    expect(store.loadDocEditorFromSelection).toHaveBeenCalledTimes(1);
  });
});

describe('preserveHydratedDocumentContent', () => {
  it('keeps a loaded body when a same-version collection refresh is less hydrated', () => {
    const loaded = {
      record_id: 'doc-1',
      version: 4,
      title: 'Loaded document',
      content: '# Stable body',
      content_blocks: [{ id: 'block-1', raw: '# Stable body' }],
      content_storage_object_id: 'object-1',
      content_storage_status: 'loaded',
      content_storage_error: null,
    };
    const remote = {
      record_id: 'doc-1',
      version: 4,
      title: 'Loaded document',
      content: '',
      content_blocks: [],
      content_storage_object_id: 'object-1',
      content_storage_status: 'remote',
    };

    expect(preserveHydratedDocumentContent(loaded, remote)).toMatchObject({
      content: '# Stable body',
      content_blocks: [{ id: 'block-1', raw: '# Stable body' }],
      content_storage_status: 'loaded',
    });
  });

  it('accepts a less-hydrated row when its version advances', () => {
    const current = {
      record_id: 'doc-1',
      version: 4,
      content: '# Old body',
      content_storage_object_id: 'object-1',
      content_storage_status: 'loaded',
    };
    const next = {
      record_id: 'doc-1',
      version: 5,
      content: '',
      content_storage_object_id: 'object-2',
      content_storage_status: 'remote',
    };

    expect(preserveHydratedDocumentContent(current, next)).toBe(next);
  });

  it('keeps a newer locally accepted canonical row when an older hydration arrives', () => {
    const accepted = {
      record_id: 'doc-1',
      version: 44,
      title: 'Accepted title',
      content: '# Accepted body',
      content_storage_status: 'remote',
    };
    const staleHydration = {
      record_id: 'doc-1',
      version: 43,
      title: 'Older title',
      content: '# Older body',
      content_storage_status: 'loaded',
    };

    expect(preserveHydratedDocumentContent(accepted, staleHydration)).toBe(accepted);
  });

  it('keeps complete accepted content identity when same-version hydration is sparse', () => {
    const accepted = {
      record_id: 'doc-1',
      version: 5,
      title: 'Accepted title',
      content: '# Accepted body',
      content_blocks: [{ id: 'block-1', raw: '# Accepted body' }],
      editor_state: { type: 'doc', content: [] },
      content_storage_object_id: 'object-5',
      content_storage_status: 'remote',
      content_sha256_hex: 'a'.repeat(64),
      pg_canonical_version_id: 'doc-1:5',
      pg_canonical_storage_object_id: 'object-5',
      pg_canonical_body_sha256_hex: 'a'.repeat(64),
    };
    const sparseHydration = {
      record_id: 'doc-1',
      version: 5,
      title: 'Accepted title',
      content: '# Accepted body',
      content_blocks: [],
      editor_state: null,
      content_storage_object_id: 'object-5',
      content_storage_status: 'remote',
      content_sha256_hex: null,
      pg_canonical_version_id: 'doc-1:5',
      pg_canonical_storage_object_id: 'object-5',
      pg_canonical_body_sha256_hex: null,
    };

    expect(preserveHydratedDocumentContent(accepted, sparseHydration)).toMatchObject({
      content_blocks: accepted.content_blocks,
      editor_state: accepted.editor_state,
      content_sha256_hex: 'a'.repeat(64),
      pg_canonical_body_sha256_hex: 'a'.repeat(64),
    });
  });
});

describe('documentLinkViewState', () => {
  it('opens an ordinary document link on the document pane', () => {
    expect(documentLinkViewState()).toEqual({
      commentId: null,
      showComments: false,
    });
  });

  it('opens an explicit document-comment link on the comments pane', () => {
    expect(documentLinkViewState('comment-1')).toEqual({
      commentId: 'comment-1',
      showComments: true,
    });
  });
});

describe('verified body cache safety', () => {
  it('retains complete body and hash across a metadata-only version advance', () => {
    const saved = { record_id: 'doc-cache', version: 2, content: 'Complete saved body',
      content_storage_object_id: 'same-object', content_storage_status: 'loaded',
      content_sha256_hex: 'a'.repeat(64), pg_canonical_version_id: 'doc-cache:2' };
    const metadata = { ...saved, version: 3, title: 'Renamed', content: 'Preview',
      content_storage_status: 'remote', content_sha256_hex: null, pg_canonical_version_id: null };
    expect(preserveHydratedDocumentContent(saved, metadata)).toMatchObject({ version: 3,
      title: 'Renamed', content: 'Complete saved body', content_storage_status: 'loaded',
      content_sha256_hex: 'a'.repeat(64), pg_canonical_version_id: 'doc-cache:3' });
  });
  it('never replaces a loaded body with failed hydration carrying preview editor blocks', () => {
    const saved = { record_id: 'doc-cache', version: 2, content: 'Complete body',
      content_storage_object_id: 'object', content_storage_status: 'loaded' };
    expect(preserveHydratedDocumentContent(saved, { ...saved, content: '',
      content_storage_status: 'error', content_blocks: [{ text: 'preview' }] })).toMatchObject({
      content: 'Complete body', content_storage_status: 'loaded' });
  });
});
