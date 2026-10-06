import * as referenceDb from './db.js';
import { resolveTowerPgWorkspaceContext } from './pg-workspace-context.js';
import { normalizeRecordLinkType } from './record-links.js';

const destinations = {
  doc: ['documents', (id) => referenceDb.getDocumentById(id), 'document', 'applyDocuments'],
  file: ['documents', (id) => referenceDb.getDocumentById(id), 'file', 'applyDocuments'],
  task: ['tasks', (id) => referenceDb.getTaskById(id), 'task', 'applyTasks'],
  scope: ['scopes', (id) => referenceDb.getScopeById(id), 'scopes', 'applyScopes'],
  channel: ['channels', (id) => referenceDb.getChannelById(id), 'channel', 'applyChannels'],
  directory: ['directories', (id) => referenceDb.getDirectoryById(id), null, 'applyDirectories'],
  report: ['reports', (id) => referenceDb.getReportById(id), null, null],
};

// Capture both authority and the source visit. An unrelated view change must
// cancel a pending click just as a newer link activation does.
export function beginInternalReferenceVisit(store) {
  const request = Number(store.internalLinkOpenRequestId || 0) + 1;
  store.internalLinkOpenRequestId = request;
  store.linkedThreadOpenRequestId = Number(store.linkedThreadOpenRequestId || 0) + 1;
  const authority = resolveTowerPgWorkspaceContext(store);
  const fields = ['navSection', 'selectedBoardId', 'selectedChannelId', 'activeThreadId', 'threadHistoryGeneration', 'selectedDocId', 'docOpenGeneration', 'activeTaskId', 'taskDetailOpenGeneration', 'showTaskDetail', 'currentFolderId', 'settingsTab'];
  const source = fields.map(field => store[field]);
  const workspaceCurrent = () => {
    const current = resolveTowerPgWorkspaceContext(store);
    return store.internalLinkOpenRequestId === request
      && ['workspaceId', 'baseUrl', 'appNpub', 'generation', 'sessionNpub'].every(key => current[key] === authority[key]);
  };
  return { request, workspaceCurrent, isCurrent: () => workspaceCurrent() && fields.every((field, index) => store[field] === source[index]) };
}

export async function resolveInternalReference(store, type, id, { isCurrent = () => true, readLocal, hydrate } = {}) {
  const kind = normalizeRecordLinkType(type);
  const config = destinations[kind];
  if (!config) throw new Error(`Flight Deck cannot open this ${kind || 'record'} link directly yet.`);
  const [collection, read, family, apply] = config;
  let row = (store[collection] || []).find(item => item.record_id === id);
  if (!row) row = await (readLocal || read)(id);
  if (!isCurrent()) return null;
  if (!row && family) {
    await (hydrate || ((targetFamily, targetId) => store.requestTowerSyncFamily?.(targetFamily, targetId, { force: true })))(family, ['scopes', 'channels'].includes(family) ? '' : id);
    if (!isCurrent()) return null;
    row = (store[collection] || []).find(item => item.record_id === id) || await (readLocal || read)(id);
  }
  if (!isCurrent()) return null;
  const workspaceId = resolveTowerPgWorkspaceContext(store).workspaceId;
  if (!row || ((row.workspace_id || row.pg_workspace_id) && (row.workspace_id || row.pg_workspace_id) !== workspaceId) || (row.record_state === 'deleted' || row.deleted_at) || row.can_read === false || row.readable === false) {
    throw new Error(`This ${kind === 'doc' ? 'document' : kind} is unavailable in the current workspace, deleted, or you do not have permission to read it.`);
  }
  if (!(store[collection] || []).some(item => item.record_id === id)) {
    const rows = [...(store[collection] || []), row];
    if (apply && store[apply]) await store[apply](rows, { isCurrent, preserveNavigation: true });
    else store[collection] = rows;
  }
  return isCurrent() ? row : null;
}

const composerFields = {
  doc: ['newDocCommentBody', 'newDocCommentReplyBody', 'docCommentAudioDrafts', 'docCommentReplyAudioDrafts'],
  task: ['newTaskCommentBody', 'taskCommentAudioDrafts'],
};
function composerDraftKey(store, type, id) {
  const context = resolveTowerPgWorkspaceContext(store);
  return JSON.stringify([context.baseUrl, context.appNpub, context.workspaceId, context.sessionNpub, type, id]);
}
export function rememberReferenceComposerDraft(store, type, id) {
  if (!id || !composerFields[type]) return;
  const drafts = store.internalReferenceComposerDrafts || {};
  store.internalReferenceComposerDrafts = { ...drafts, [composerDraftKey(store, type, id)]: Object.fromEntries(composerFields[type].map(field => [field, Array.isArray(store[field]) ? [...store[field]] : store[field]])) };
}
export function restoreReferenceComposerDraft(store, type, id) {
  const draft = store.internalReferenceComposerDrafts?.[composerDraftKey(store, type, id)];
  if (!draft) return;
  for (const field of composerFields[type] || []) store[field] = Array.isArray(draft[field]) ? [...draft[field]] : draft[field];
  const remaining = { ...store.internalReferenceComposerDrafts };
  delete remaining[composerDraftKey(store, type, id)];
  store.internalReferenceComposerDrafts = remaining;
}
