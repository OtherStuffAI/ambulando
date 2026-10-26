// Durable local storage for pasted/edited text attachment drafts. Rows keep the
// exact bytes and upload state so refresh, relaunch or a destination change
// cannot lose them; they are deleted only on explicit removal or acceptance of
// the local message that carries them.
import { firstLinePreview } from './text-attachments.js';
import { deleteTextAttachmentDrafts, listTextAttachmentDrafts, putTextAttachmentDraft } from './db.js';

function workspaceIdOf(store) {
  return String(store.currentWorkspace?.workspaceId || store.currentWorkspace?.workspace_id || store.currentWorkspaceKey || '').trim();
}

export function isPersistedTextDraft(draft) {
  return Boolean(draft?.text_attachment && draft?.file);
}

export async function persistTextDraft(store, context, draft) {
  if (!isPersistedTextDraft(draft) || !draft.composer_draft_key) return;
  try {
    // Plain bytes, not a Blob: portable across IndexedDB implementations.
    const bytes = new Uint8Array(await draft.file.arrayBuffer());
    await putTextAttachmentDraft({
      draft_id: draft.draft_id,
      composer_draft_key: draft.composer_draft_key,
      workspace_id: workspaceIdOf(store),
      context,
      filename: draft.filename,
      content_type: draft.content_type,
      size_bytes: draft.size_bytes,
      bytes,
      text_attachment: draft.text_attachment,
      sha256_hex: draft.sha256_hex || '',
      storage_upload: draft.storage_upload || null,
      storage_object_id: draft.storage_object_id || '',
      status: draft.status === 'ready' ? 'ready' : 'pending',
      created_at: draft.created_at || new Date().toISOString(),
    });
  } catch (error) {
    // Durability is best effort; the in-memory draft still works.
    console.warn('[text-attachments] could not persist draft', error?.message || error);
  }
}

export async function discardPersistedTextDrafts(drafts = []) {
  const ids = drafts.filter(isPersistedTextDraft).map((draft) => draft.draft_id);
  if (!ids.length) return;
  try { await deleteTextAttachmentDrafts(ids); } catch { /* nothing durable to remove */ }
}

// Rebuild drafts for the current composer destination that are not in memory.
export async function restorePersistedTextDrafts(store, context) {
  const key = store.getChatComposerDraftKey(context);
  if (!key) return [];
  let rows = [];
  try { rows = await listTextAttachmentDrafts(key); } catch { return []; }
  if (key !== store.getChatComposerDraftKey(context)) return [];
  const present = new Set(store.getChatFileDrafts(context).map((draft) => draft.draft_id));
  const restored = [];
  for (const row of rows) {
    if (present.has(row.draft_id) || !row.bytes) continue;
    const file = new File([row.bytes], row.filename, { type: row.content_type });
    const ready = row.status === 'ready' && row.storage_object_id;
    restored.push({
      draft_id: row.draft_id,
      file,
      kind: 'file',
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      preview_url: '',
      status: ready ? 'ready' : 'error',
      error: ready ? '' : 'Upload pending. Retry when connected.',
      inline_upload_token: '',
      composer_draft_key: row.composer_draft_key,
      text_attachment: row.text_attachment,
      preview_line: firstLinePreview(new TextDecoder().decode(row.bytes.slice(0, 2048)).replace(/\uFFFD+$/, '')),
      sha256_hex: row.sha256_hex || '',
      created_at: row.created_at,
      ...(row.storage_upload ? { storage_upload: row.storage_upload } : {}),
      ...(ready ? { storage_object_id: row.storage_object_id } : {}),
    });
  }
  if (!restored.length) return [];
  store.setChatFileDrafts(context, [...store.getChatFileDrafts(context), ...restored]);
  return restored;
}
