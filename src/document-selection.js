const DOCUMENT_CONTENT_FIELDS = [
  'content',
  'content_format',
  'content_blocks',
  'editor_state',
  'editor_state_format',
  'editor_state_version',
  'content_storage_object_id',
  'content_storage_format',
  'content_storage_content_type',
  'content_size_bytes',
  'content_sha256_hex',
  'content_storage_status',
  'content_storage_error',
  'pg_canonical_version_id',
  'pg_canonical_storage_object_id',
  'pg_canonical_body_sha256_hex',
  'pg_canonical_size_bytes',
];

function hasCompleteDocumentContent(document = {}) {
  if (document.content_storage_status === 'loaded') return true;
  if (document.content_storage_object_id && ['remote', 'error', 'loading'].includes(document.content_storage_status)
    && !document.content_sha256_hex) return false;
  if (Array.isArray(document.content_blocks) && document.content_blocks.length > 0) return true;
  return document.editor_state?.type === 'doc';
}

function documentVersion(document = {}) {
  const version = Number(document?.version ?? document?.row_version ?? 0);
  return Number.isFinite(version) ? version : 0;
}

export function preferNewerDocumentRow(current = null, incoming = null) {
  if (!current || !incoming) return incoming;
  if (String(current.record_id || '') !== String(incoming.record_id || '')) return incoming;
  if (documentVersion(current) > documentVersion(incoming)) return current;
  return incoming;
}

export function documentLinkViewState(commentId = null) {
  const selectedCommentId = String(commentId || '').trim() || null;
  return {
    commentId: selectedCommentId,
    showComments: Boolean(selectedCommentId),
  };
}

export function preserveHydratedDocumentContent(current = null, incoming = null) {
  const newest = preferNewerDocumentRow(current, incoming);
  if (newest !== incoming) return newest;
  if (!current || !incoming) return incoming;
  if (String(current.record_id || '') !== String(incoming.record_id || '')) return incoming;
  const sameStorage = current.content_storage_object_id
    && current.content_storage_object_id === incoming.content_storage_object_id
    && (!incoming.content_sha256_hex || !current.content_sha256_hex || current.content_sha256_hex === incoming.content_sha256_hex);
  if (documentVersion(current) !== documentVersion(incoming) && !sameStorage) return incoming;
  if (!hasCompleteDocumentContent(current)) return incoming;
  if (hasCompleteDocumentContent(incoming) && incoming.content_storage_status !== 'error') return incoming;
  if (
    current.content_storage_object_id
    && incoming.content_storage_object_id
    && current.content_storage_object_id !== incoming.content_storage_object_id
  ) return incoming;

  return DOCUMENT_CONTENT_FIELDS.reduce((merged, field) => {
    merged[field] = field === 'pg_canonical_version_id' ? (incoming[field] || `${incoming.record_id}:${documentVersion(incoming)}`) : current[field];
    return merged;
  }, { ...incoming });
}

export function applySelectedDocumentUpdate(store, document = null) {
  const recordId = String(store.selectedDocId || '').trim();
  if (!recordId) return;
  const nextDocuments = store.documents.filter((item) => item?.record_id !== recordId);
  if (document && document.record_state !== 'deleted') {
    nextDocuments.push(document);
  }
  store.applyDocuments(nextDocuments);
  if (!store.selectedDocument) {
    store.loadDocEditorFromSelection();
  }
}
