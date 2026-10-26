// Durable local storage for pasted/edited text attachment drafts. Rows keep the
// exact bytes and upload state so refresh, relaunch or a destination change
// cannot lose them; they are deleted only on explicit removal or acceptance of
// the local message that carries them.
import { firstLinePreview } from './text-attachments.js';
import { getWorkspaceDb, deleteTextAttachmentDrafts, listTextAttachmentDrafts, putTextAttachmentDraft } from './db.js';

function workspaceIdOf(store) {
  return String(store.currentWorkspace?.workspaceId || store.currentWorkspace?.workspace_id || store.currentWorkspaceKey || '').trim();
}

export function isPersistedTextDraft(draft) {
  return Boolean(draft?.text_attachment && draft?.file);
}

// Serialize by captured database and draft identity. A deletion is a tombstone
// immediately, including while an older Blob read or IndexedDB write is pending.
const databaseStates = new WeakMap();
const draftDatabases = new Map();
function currentDb() { try { return getWorkspaceDb(); } catch { return null; } }
function stateFor(db, id) {
  let states = databaseStates.get(db);
  if (!states) { states = new Map(); databaseStates.set(db, states); }
  if (!states.has(id)) states.set(id, { generation: 0, removed: false, tail: Promise.resolve() });
  return states.get(id);
}
export async function persistTextDraft(store, context, draft) {
  if (!isPersistedTextDraft(draft) || !draft.composer_draft_key) return false;
  const db = draftDatabases.get(draft.draft_id)?.db || currentDb();
  if (!db) {
    draft.local_persistence_error = 'Local attachment storage is not ready. Keep this window open and retry.';
    store.error = draft.local_persistence_error;
    return false;
  }
  if (!draftDatabases.has(draft.draft_id)) draftDatabases.set(draft.draft_id, { db, workspaceId: workspaceIdOf(store) });
  const state = stateFor(db, draft.draft_id);
  if (state.removed) return false;
  const generation = ++state.generation;
  const publish = (patch) => {
    Object.assign(draft, patch);
    if (store.getChatFileDrafts && store.setChatFileDrafts) {
      const drafts = store.getChatFileDrafts(context);
      if (drafts.some(item => item.draft_id === draft.draft_id)) store.setChatFileDrafts(context, drafts.map(item => item.draft_id === draft.draft_id ? { ...item, ...patch } : item));
    }
  };
  publish({ local_persistence_state: 'saving' });
  const snapshot = { ...draft, workspace_id: draftDatabases.get(draft.draft_id).workspaceId };
  const operation = state.tail.catch(() => {}).then(async () => {
    const bytes = new Uint8Array(await snapshot.file.arrayBuffer());
    if (state.removed || generation !== state.generation) return false;
    await putTextAttachmentDraft({
      draft_id: snapshot.draft_id, composer_draft_key: snapshot.composer_draft_key,
      workspace_id: snapshot.workspace_id, context, filename: snapshot.filename,
      content_type: snapshot.content_type, size_bytes: snapshot.size_bytes, bytes,
      text_attachment: snapshot.text_attachment, sha256_hex: snapshot.sha256_hex || '',
      storage_upload: snapshot.storage_upload || null, storage_object_id: snapshot.storage_object_id || '',
      status: snapshot.status === 'ready' ? 'ready' : 'pending',
      created_at: snapshot.created_at || new Date().toISOString(),
    }, db);
    return !state.removed && generation === state.generation;
  });
  state.tail = operation;
  try {
    const saved = await operation;
    if (saved) publish({ local_persistence_error: '', local_persistence_state: 'saved' });
    return saved;
  } catch (error) {
    const message = 'Could not save this attachment locally. Keep this window open and retry: ' + (error?.message || 'Local storage unavailable');
    publish({ local_persistence_error: message, local_persistence_state: 'error' });
    store.error = message;
    return false;
  }
}
export async function discardPersistedTextDrafts(drafts = []) {
  await Promise.all(drafts.filter(isPersistedTextDraft).map(async (draft) => {
    const db = draftDatabases.get(draft.draft_id)?.db || currentDb();
    if (!db) return;
    const state = stateFor(db, draft.draft_id);
    state.removed = true;
    state.generation += 1;
    const operation = state.tail.catch(() => {}).then(() => deleteTextAttachmentDrafts([draft.draft_id], db));
    state.tail = operation;
    await operation;
  }));
}

// Rebuild drafts for the current composer destination that are not in memory.
export async function restorePersistedTextDrafts(store, context) {
  const db = currentDb();
  const key = store.getChatComposerDraftKey(context);
  if (!key || !db) return [];
  let rows = [];
  try { rows = await listTextAttachmentDrafts(key, db); } catch { return []; }
  if (db !== currentDb() || key !== store.getChatComposerDraftKey(context)) return [];
  const present = new Set(store.getChatFileDrafts(context).map((draft) => draft.draft_id));
  const restored = [];
  for (const row of rows) {
    if (present.has(row.draft_id) || !row.bytes) continue;
    const file = new File([row.bytes], row.filename, { type: row.content_type });
    const ready = row.status === 'ready' && row.storage_object_id;
    draftDatabases.set(row.draft_id, { db, workspaceId: row.workspace_id });
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
