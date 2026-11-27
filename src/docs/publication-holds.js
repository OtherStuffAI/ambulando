// Device-local recovery authority. Never serialized into shared Doc/thread metadata.
const publicationHoldKey = (workspaceId, documentId) => `doc-publication-hold:v1:${workspaceId}:${documentId}`;
const draftKey = (workspaceId, documentId) => `${workspaceId}:${documentId}`;

export async function readPublicationHold(db, workspaceId, documentId) {
  if (!db || !workspaceId || !documentId) return null;
  return (await db.sync_state.get(publicationHoldKey(workspaceId, documentId)))?.value || null;
}

function members(metadata) {
  const value = metadata?.ambulando_thread_artefacts;
  if (value?.version !== 1 || !Array.isArray(value.items) || value.items.length > 32
    || value.items.some(item => !['doc', 'file'].includes(item?.kind) || typeof item.id !== 'string' || !item.id)) return null;
  return value.items;
}

// Call inside the same transaction that accepts a fresh canonical thread row.
// Unknown/malformed membership is not evidence of removal. Empty v1 is.
export async function consumeThreadDocDetaches(db, previous, next) {
  if (!previous || !next || previous.id !== next.id || previous.workspace_id !== next.workspace_id
    || Number(next.row_version) <= Number(previous.row_version)) return;
  const before = members(previous.metadata), after = members(next.metadata);
  if (!before || !after) return;
  const observationKey = `doc-detach-observed:v1:${next.workspace_id}:${next.id}`;
  const observed = (await db.sync_state.get(observationKey))?.value || 0;
  if (Number(observed) >= Number(next.row_version)) return;
  await db.sync_state.put({ key: observationKey, value: next.row_version });
  for (const item of before) {
    if (item.kind !== 'doc' || after.some(member => member.kind === 'doc' && member.id === item.id)) continue;
    await db.sync_state.put({ key: publicationHoldKey(next.workspace_id, item.id), value: {
      generation: crypto.randomUUID(), threadId: next.id, threadVersion: next.row_version,
    } });
  }
}

// Both fences are checked in one IndexedDB transaction, across tabs/workers.
export async function releasePublicationHold(db, workspaceId, documentId, generation, draftRevision) {
  if (!db || !generation) return false;
  return db.transaction('rw', db.sync_state, db.document_drafts, async () => {
    const hold = await readPublicationHold(db, workspaceId, documentId);
    const key = draftKey(workspaceId, documentId);
    const draft = await db.document_drafts.get(key);
    if (hold?.generation !== generation || (draft?.draft_status !== 'archive' && draft?.draft_revision !== draftRevision)) return false;
    if (draft && draft.draft_status !== 'archive') {
      if (draft.preserved_copies?.length) await db.document_drafts.put({ draft_key: key, workspace_id: workspaceId,
        document_id: documentId, draft_status: 'archive', preserved_copies: draft.preserved_copies });
      else await db.document_drafts.delete(key);
    }
    await db.sync_state.delete(publicationHoldKey(workspaceId, documentId));
    return true;
  });
}
