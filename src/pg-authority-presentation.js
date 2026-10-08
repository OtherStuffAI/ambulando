// Authority replacement invalidates rendered models, not recoverable local writes.
export function clearPgAuthorityPresentation(store, { preserveDrafts = true } = {}) {
  if (preserveDrafts) {
    if (store.editingTask) void Promise.resolve(store.persistTaskLocalDraft?.()).catch(() => {});
    if (store.docEditDraftDirty) void Promise.resolve(store.persistSelectedDocDraft?.({ immediate: true })).catch(() => {});
  }
  store.taskDetailOpenGeneration = Number(store.taskDetailOpenGeneration || 0) + 1;
  store.docOpenGeneration = Number(store.docOpenGeneration || 0) + 1;
  store.docEditAccessGeneration = Number(store.docEditAccessGeneration || 0) + 1;
  store.autopilotOverviewThreadOpenRequestId = Number(store.autopilotOverviewThreadOpenRequestId || 0) + 1;
  store.messageCollectionRevision = Number(store.messageCollectionRevision || 0) + 1;
  store.cancelDocAutosave?.();
  store.cancelDocLocalDraftPersistence?.();
  if (store.taskDraftAutosaveTimer) clearTimeout(store.taskDraftAutosaveTimer);
  store.taskDraftAutosaveTimer = null;
  store.destroyTaskRichDescriptionEditor?.();
  store.destroyDocRichEditor?.();
  store.loadDocEditorFromSelection?.(null);
  for (const key of ['tasks', 'documents', 'reports', 'taskComments', 'docComments', 'reactionRows',
    'agentActivities', 'agentSessionHealth', 'threadResponseActivities', 'channelResponseActivities',
    'docVersionHistory', 'recordVersionHistory', 'documentSessionRows']) store[key] = [];
  for (const key of ['activeTaskId', 'selectedDocId', 'selectedDocType', 'selectedReportId',
    'editingTask', 'taskEditOriginal', 'reportModalReport', 'reportDeleteConfirmReport', 'docRecovery', 'docEditConflict', 'scopeAccessScope', 'scopeAccessData']) store[key] = null;
  for (const key of ['showTaskDetail', 'chatTaskModalOpen', 'chatDocModalOpen', 'showDocShareModal',
    'showDocCommentModal', 'recordVersionModalOpen', 'recordStatusModalOpen', 'showDocumentSessionsModal', 'showDocScopeModal', 'showDocMoveModal', 'showScopeAccessModal']) store[key] = false;
  for (const key of ['docEditorTitle', 'docEditorContent', 'docBlockBuffer', 'newTaskCommentBody',
    'newDocCommentBody', 'newDocCommentReplyBody', 'chatTaskModalTitle', 'chatDocModalTitle',
    'recordVersionLabel', 'recordStatusTargetLabel', 'recordStatusTargetId', 'docShareTargetId', 'docShareTargetType']) store[key] = '';
  store.docEditorBlocks = [];
  store.docEditorProseMirrorState = null;
  store.docEditorContentModel = null;
  store.docLocalDraft = null;
}

export function rememberPgRecoveryDestination(store, kind, id) {
  if (!store.pgNavigationRecoveryPending) return false;
  const intent = { ...(store.pgNavigationRecoverySelection || {}), workspaceKey: store.currentWorkspaceKey,
    boardId: store.selectedBoardId, section: kind === 'channel' ? 'chat' : kind === 'task' ? 'tasks' : kind === 'doc' ? 'docs' : 'reports',
    channelId: null, threadId: null, taskId: null, docId: null, reportId: null };
  intent[{ channel: 'channelId', task: 'taskId', doc: 'docId', report: 'reportId' }[kind]] = id;
  store.pgNavigationRecoverySelection = intent;
  store.navSection = intent.section;
  return true;
}
