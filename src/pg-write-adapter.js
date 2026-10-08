import { requestTowerPgContext } from './api.js';
import {
  createTowerPgChannelAudioNote,
  createTowerPgChannelDoc,
  createTowerPgChannelFile,
  createTowerPgChannelFileFolder,
  createTowerPgChannelMessage,
  createTowerPgThreadBranch,
  createTowerPgChannelTask,
  archiveTowerPgThread,
  createTowerPgDocComment,
  createTowerPgTaskComment,
  deleteTowerPgDocComment,
  deleteTowerPgDoc,
  deleteTowerPgMessage,
  deleteTowerPgTask,
  deleteTowerPgThread,
  getTowerPgChannelDocs,
  getTowerPgThread,
  moveTowerPgDoc,
  moveTowerPgTask,
  updateTowerPgDoc,
  updateTowerPgDocComment,
  updateTowerPgFile,
  updateTowerPgMessage,
  updateTowerPgTask,
  updateTowerPgTaskState,
  updateTowerPgThread,
} from './api.js';
import {
  mapPgAudioNoteToLocal,
  mapPgDocToLocal,
  mapPgFileFolderToLocal,
  mapPgFileToLocalDocument,
  mapPgMessageToLocal,
  mapPgDocCommentToLocal,
  mapPgTaskToLocal,
  mapPgTaskCommentToLocal,
  mapPgThreadToLocal,
  resolveTowerPgWorkspaceContext,
} from './pg-read-hydrator.js';
import { recordFamilyHash } from './translators/chat.js';
import {
  getPgChannelScopeId,
  resolvePgRecordContext,
} from './pg-record-context.js';
import { addPgEditLeaseToSaveBody } from './pg-edit-session.js';
import { buildAgentInstructionSignature } from './message-instruction-signatures.js';
import { mergeChatStorageAttachments } from './chat-attachments.js';
import { canonicalTaskAgentMentions } from './task-agent-mentions.js';
import { canonicalDocumentAgentMentions } from './document-agent-mentions.js';
import { createDiagnosticOperation, finishDiagnosticOperation, emitDiagnostic } from './diagnostics-events.js';

function trimText(value) {
  return String(value ?? '').trim();
}

function isMissingPgMessageDeleteError(error) {
  if (!error || error.status !== 404) return false;
  const responseText = String(error.responseText || error.message || '');
  return error.code === 'message_not_found'
    || responseText.includes('"code":"message_not_found"')
    || responseText.includes('Flight Deck PG message not found');
}

function isStalePgRowVersionError(error) {
  if (error?.code === 'stale_row_version') return true;
  const responseText = String(error?.responseText || '').trim();
  if (!responseText) return false;
  try {
    return JSON.parse(responseText)?.code === 'stale_row_version';
  } catch {
    return false;
  }
}

export function resolveTowerPgTaskChannel(store, task = {}) {
  const explicitChannelId = trimText(task.pg_channel_id || task.channel_id);
  const channels = Array.isArray(store?.channels) ? store.channels : [];
  const scopeId = trimText(task.scope_id || task.scope_l1_id);
  const matchesScope = (channel) => {
    if (!channel?.record_id || channel.record_state === 'deleted') return false;
    const channelScopeId = getPgChannelScopeId(channel);
    return !scopeId || channelScopeId === scopeId;
  };
  if (explicitChannelId) {
    const channel = channels.find((entry) => entry?.record_id === explicitChannelId) || null;
    return matchesScope(channel) ? channel : null;
  }
  const selectedId = trimText(store?.selectedChannelId);
  const selected = channels.find((channel) => channel?.record_id === selectedId) || null;
  return matchesScope(selected) ? selected : null;
}

function pgRequestOptions(context) {
  return {
    baseUrl: context.baseUrl,
    appNpub: context.appNpub,
  };
}

function isAmbiguousCreateFailure(error) {
  const status = Number(error?.status || 0);
  if (status >= 500) return true;
  if (status > 0) return false;
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return name === 'aborterror'
    || name === 'timeouterror'
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('network')
    || message.includes('failed to fetch')
    || message.includes('load failed');
}

async function findAcceptedTowerPgDocByStorage(context, channelId, storageObjectId) {
  const targetStorageObjectId = trimText(storageObjectId);
  if (!targetStorageObjectId) return null;
  const result = await getTowerPgChannelDocs(context.workspaceId, channelId, {
    ...pgRequestOptions(context),
    limit: 500,
  });
  return (Array.isArray(result?.docs) ? result.docs : [])
    .find((doc) => trimText(doc?.storage_object_id) === targetStorageObjectId) || null;
}

function resolveTowerPgChannelForRecord(store, record = {}) {
  const recordContext = resolvePgRecordContext(store, {
    scopeId: record.scope_id || record.scope_l1_id,
    channelId: record.pg_channel_id || record.channel_id,
    threadId: record.pg_thread_id || record.thread_id,
    includeActiveThread: false,
  });
  return {
    recordContext,
    channel: recordContext.channel,
  };
}

function pgMetadataWithThread(metadata = {}, threadId = null) {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  if (threadId) base.thread_id = threadId;
  else delete base.thread_id;
  return base;
}

function pgTaskMetadata(task = {}) {
  const base = task.pg_metadata && typeof task.pg_metadata === 'object' && !Array.isArray(task.pg_metadata)
    ? { ...task.pg_metadata }
    : task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
      ? { ...task.metadata }
      : {};
  base.board_order = task.board_order ?? null;
  base.parent_task_id = task.parent_task_id || null;
  base.tags = typeof task.tags === 'string' ? task.tags : '';
  base.scheduled_for = task.scheduled_for || null;
  const assignees = normalizeTaskAssigneeNpubs(task);
  if (assignees.length > 1) throw new Error('Tasks accept zero or one assignee');
  base.assigned_to_npub = assignees[0] || null;
  delete base.assigned_to_npubs;
  base.predecessor_task_ids = Array.isArray(task.predecessor_task_ids)
    ? task.predecessor_task_ids
    : null;
  base.flow_id = task.flow_id || null;
  base.flow_run_id = task.flow_run_id || null;
  base.flow_step = task.flow_step || null;
  base.source_links = Array.isArray(task.source_links) ? task.source_links : [];
  base.references = Array.isArray(task.references) ? task.references : [];
  base.deliverable_links = Array.isArray(task.deliverable_links) ? task.deliverable_links : [];
  base.mentions = canonicalTaskAgentMentions(task.description);
  return base;
}

function isMetadataTaskPatch(patch = {}) {
  return [
    'board_order',
    'tags',
    'scheduled_for',
    'predecessor_task_ids',
    'flow_id',
    'flow_run_id',
    'flow_step',
    'source_links',
    'references',
    'deliverable_links',
  ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

function normalizeTaskAssigneeNpubs(task = {}) {
  const raw = Array.isArray(task) ? task
    : Object.prototype.hasOwnProperty.call(task || {}, 'assigned_to_npub') ? [task.assigned_to_npub]
      : Array.isArray(task?.assigned_to_npubs) ? task.assigned_to_npubs
        : typeof task === 'string' ? [task] : [];
  return [...new Set(raw.map(npub => trimText(npub)).filter(Boolean))];
}

function withAssignedNpubs(task = {}, npubs = []) {
  const assigned_to_npubs = [...new Set((Array.isArray(npubs) ? npubs : [])
    .map((npub) => trimText(npub))
    .filter(Boolean))];
  return {
    ...task,
    assigned_to_npubs,
    assigned_to_npub: assigned_to_npubs[0] || null,
  };
}

function pgAudioTargetType(familyHash) {
  const family = trimText(familyHash);
  if (family === recordFamilyHash('chat_message')) return 'message';
  if (family === recordFamilyHash('task')) return 'task';
  if (family === recordFamilyHash('document')) return 'doc';
  return null;
}

export async function createTowerPgTaskFromLocal(store, task) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  const recordContext = resolvePgRecordContext(store, {
    scopeId: task.scope_id || task.scope_l1_id,
    channelId: task.pg_channel_id || task.channel_id,
    threadId: task.pg_thread_id || task.thread_id,
    includeActiveThread: false,
  });
  const channel = resolveTowerPgTaskChannel(store, {
    ...task,
    pg_channel_id: recordContext.channelId,
    scope_id: recordContext.scopeId,
  });
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the task scope');
  const mentions = canonicalTaskAgentMentions(task.description);
  const result = await createTowerPgChannelTask(context.workspaceId, channel.record_id, {
    title: task.title,
    description: task.description || null,
    state: task.state || 'new',
    priority: task.priority || 'sand',
    thread_id: recordContext.threadId || null,
    metadata: pgTaskMetadata(task),
    mentions,
  }, pgRequestOptions(context));
  const accepted = mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  return accepted;
}

export async function createTowerPgDocFromLocal(store, document) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  const { recordContext, channel } = resolveTowerPgChannelForRecord(store, document);
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the document scope');
  const body = {
    title: document.title || 'Untitled document',
    storage_object_id: document.content_storage_object_id || document.storage_object_id,
    summary: document.content || null,
    metadata: {
      ...pgMetadataWithThread(document.pg_metadata || document.metadata, recordContext.threadId),
      mentions: canonicalDocumentAgentMentions(document.content),
    },
    mentions: canonicalDocumentAgentMentions(document.content),
  };
  // A previous POST may have committed even when its response was lost. The
  // uploaded storage object is unique to this logical create, so reconcile it
  // before retrying and after ambiguous transport/server failures.
  const alreadyAccepted = await findAcceptedTowerPgDocByStorage(
    context,
    channel.record_id,
    body.storage_object_id,
  );
  let result;
  if (alreadyAccepted) {
    result = { doc: alreadyAccepted };
  } else {
    try {
      result = await createTowerPgChannelDoc(
        context.workspaceId,
        channel.record_id,
        body,
        pgRequestOptions(context),
      );
    } catch (error) {
      if (!isAmbiguousCreateFailure(error)) throw error;
      const reconciled = await findAcceptedTowerPgDocByStorage(
        context,
        channel.record_id,
        body.storage_object_id,
      ).catch(() => null);
      if (!reconciled) throw error;
      result = { doc: reconciled };
    }
  }
  return mapPgDocToLocal(result.doc, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function updateTowerPgDocFromLocal(store, document, previousDocument = null) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !document?.record_id) throw new Error('Tower PG doc is not ready');
  const bodySave = Boolean(document.content_storage_object_id || document.storage_object_id);
  const saveBody = {
    row_version: document.pg_save_base_row_version ?? previousDocument?.version ?? document.version ?? undefined,
    ...(bodySave ? { base_available: document.pg_save_base_available !== false } : {}),
    ...(bodySave && document.pg_save_base_version_id ? { base_version_id: document.pg_save_base_version_id } : {}),
    ...(bodySave && document.pg_save_base_body_sha256_hex ? { base_body_sha256_hex: document.pg_save_base_body_sha256_hex } : {}),
    title: document.title || 'Untitled document',
    ...(!bodySave ? { channel_id: document.pg_channel_id || document.channel_id || undefined } : {}),
    storage_object_id: document.content_storage_object_id || document.storage_object_id,
    summary: document.content || null,
    metadata: {
      ...pgMetadataWithThread(document.pg_metadata || document.metadata, document.pg_thread_id || document.thread_id),
      mentions: canonicalDocumentAgentMentions(document.content),
    },
    mentions: canonicalDocumentAgentMentions(document.content),
  };
  const body = document.pg_save_requires_lease === false
    ? saveBody
    : addPgEditLeaseToSaveBody(store, previousDocument || document, 'document', saveBody);
  const result = await updateTowerPgDoc(context.workspaceId, document.record_id, body, pgRequestOptions(context));
  const accepted = mapPgDocToLocal({
    ...result.doc,
    canonical_version: result.canonical_version || null,
  }, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  return store.acceptSelectedPgDocSaveCanonical?.(accepted, document) || accepted;
}

export async function deleteTowerPgDocFromLocal(store, document) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !document?.record_id) throw new Error('Tower PG doc is not ready');
  const result = await deleteTowerPgDoc(context.workspaceId, document.record_id, {
    rowVersion: document.version || undefined,
    ...pgRequestOptions(context),
  });
  return mapPgDocToLocal(result.doc, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function moveTowerPgDocFromLocal(store, document, destinationChannelId, destinationScopeId = null) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !document?.record_id) throw new Error('Tower PG doc is not ready');
  const result = await moveTowerPgDoc(context.workspaceId, document.record_id, {
    destination_channel_id: trimText(destinationChannelId),
    ...(trimText(destinationScopeId) ? { destination_scope_id: trimText(destinationScopeId) } : {}),
    ...(document.version ? { row_version: document.version } : {}),
  }, pgRequestOptions(context));
  const mapped = mapPgDocToLocal(result.doc, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  return {
    ...document,
    ...mapped,
    content: document.content ?? mapped.content,
  };
}

export async function createTowerPgFileFromLocal(store, file) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  const { recordContext, channel } = resolveTowerPgChannelForRecord(store, file);
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the file scope');
  const result = await createTowerPgChannelFile(context.workspaceId, channel.record_id, {
    storage_object_id: file.storage_object_id || file.content_storage_object_id,
    folder_id: file.folder_id || file.pg_folder_id || null,
    display_name: file.display_name || file.title || null,
    description: file.description || file.content || null,
    metadata: pgMetadataWithThread(file.pg_metadata || file.metadata, recordContext.threadId),
  }, pgRequestOptions(context));
  return mapPgFileToLocalDocument(result.file, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function updateTowerPgFileFromLocal(store, file, previous = null) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl || !file?.record_id) throw new Error('Tower PG file is not ready');
  const { recordContext, channel } = resolveTowerPgChannelForRecord(store, file);
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the file scope');
  const result = await updateTowerPgFile(context.workspaceId, file.record_id, {
    row_version: previous?.version || file.version || undefined,
    channel_id: channel.record_id,
    folder_id: file.folder_id ?? file.pg_folder_id ?? null,
    display_name: file.display_name || file.title || null,
    description: file.description || file.content || null,
    metadata: pgMetadataWithThread(file.pg_metadata || file.metadata, recordContext.threadId),
  }, pgRequestOptions(context));
  return mapPgFileToLocalDocument(result.file, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function createTowerPgFileFolderFromLocal(store, folder) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  const { recordContext, channel } = resolveTowerPgChannelForRecord(store, {
    scope_id: folder.scope_id,
    pg_channel_id: folder.channel_id,
  });
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the folder scope');
  const result = await createTowerPgChannelFileFolder(context.workspaceId, channel.record_id, {
    title: folder.title,
    parent_folder_id: folder.parent_folder_id || null,
    metadata: pgMetadataWithThread(folder.metadata, recordContext.threadId),
  }, pgRequestOptions(context));
  return mapPgFileFolderToLocal(result.folder);
}

export async function createTowerPgAudioNoteFromLocal(store, audioNote) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !context.workspaceOwnerNpub || !context.baseUrl) throw new Error('Tower PG workspace is not ready');
  const { recordContext, channel } = resolveTowerPgChannelForRecord(store, audioNote);
  if (!channel?.record_id) throw new Error('Selected PG channel does not match the audio note scope');
  const targetType = pgAudioTargetType(audioNote.target_record_family_hash);
  const targetId = trimText(audioNote.target_record_id);
  const title = trimText(audioNote.title);
  const transcriptPreview = typeof audioNote.transcript_preview === 'string' ? audioNote.transcript_preview : '';
  const summary = typeof audioNote.summary === 'string' ? audioNote.summary : '';
  const durationSeconds = Number(audioNote.duration_seconds);
  const audioBody = {
    storage_object_id: audioNote.storage_object_id,
    mime_type: audioNote.mime_type || 'audio/webm;codecs=opus',
    ...(title ? { title } : {}),
    ...(recordContext.threadId ? { thread_id: recordContext.threadId } : {}),
    ...(targetType && targetId ? { target_type: targetType, target_id: targetId } : {}),
    ...(Number.isFinite(durationSeconds) ? { duration_seconds: durationSeconds } : {}),
    size_bytes: audioNote.size_bytes ?? 0,
    media_encryption: audioNote.media_encryption || {},
    waveform_preview: audioNote.waveform_preview || [],
    transcript_status: audioNote.transcript_status || 'not_requested',
    ...(transcriptPreview ? { transcript_preview: transcriptPreview } : {}),
    ...(summary ? { summary } : {}),
    record_state: audioNote.record_state || 'active',
    metadata: audioNote.pg_metadata || audioNote.metadata || {},
  };
  const result = await createTowerPgChannelAudioNote(context.workspaceId, channel.record_id, audioBody, pgRequestOptions(context));
  return mapPgAudioNoteToLocal(result.audio_note, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
  });
}

export async function updateTowerPgTaskFromLocal(store, task, previousTask = null, patch = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !task?.record_id) throw new Error('Tower PG task is not ready');
  const body = {
    row_version: previousTask?.version || task.version || undefined,
  };
  const patchKeys = Object.keys(patch || {});
  const assignmentPatch = Object.prototype.hasOwnProperty.call(patch, 'assigned_to_npubs')
    || Object.prototype.hasOwnProperty.call(patch, 'assigned_to_npub');
  const nonAssignmentPatchKeys = patchKeys.filter((key) => key !== 'assigned_to_npubs' && key !== 'assigned_to_npub');
  const onlyState = nonAssignmentPatchKeys.length === 1 && Object.prototype.hasOwnProperty.call(patch, 'state');
  let acceptedTask = null;
  if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
    const result = await updateTowerPgTaskState(context.workspaceId, task.record_id, {
      ...body,
      state: task.state,
    }, pgRequestOptions(context));
    acceptedTask = mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub });
    if (onlyState && !assignmentPatch) {
      return acceptedTask;
    }
  }
  const patchBody = {
    row_version: acceptedTask?.version || body.row_version,
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) patchBody.title = task.title;
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    patchBody.description = task.description || null;
    patchBody.mentions = canonicalTaskAgentMentions(task.description);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'priority')) patchBody.priority = task.priority || 'sand';
  if (assignmentPatch || isMetadataTaskPatch(patch)) patchBody.metadata = pgTaskMetadata(task);
  if (Object.keys(patchBody).length > 1) {
    const result = await updateTowerPgTask(
      context.workspaceId,
      task.record_id,
      patchBody,
      pgRequestOptions(context),
    );
    acceptedTask = mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub });
  } else if (!acceptedTask) {
    acceptedTask = previousTask || task;
  }

  return acceptedTask;
}

export async function syncTowerPgTaskAssignments(store, taskId, previousNpubs = [], nextNpubs = [], contextOverride = null) {
  const context = contextOverride || resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !taskId) throw new Error('Tower PG task assignments are not ready');
  const next = normalizeTaskAssigneeNpubs(nextNpubs);
  if (next.length > 1) throw new Error('Tasks accept zero or one assignee');
  const result = await updateTowerPgTask(context.workspaceId, taskId,
    { assigned_to_npub: next[0] || null }, pgRequestOptions(context));
  return mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function deleteTowerPgTaskFromLocal(store, task) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !task?.record_id) throw new Error('Tower PG task is not ready');
  const result = await deleteTowerPgTask(context.workspaceId, task.record_id, {
    rowVersion: task.version || undefined,
    ...pgRequestOptions(context),
  });
  return mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub });
}

export async function moveTowerPgTaskFromLocal(store, task, destinationChannelId, destinationScopeId = null) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !task?.record_id) throw new Error('Tower PG task is not ready');
  const result = await moveTowerPgTask(context.workspaceId, task.record_id, {
    destination_channel_id: trimText(destinationChannelId),
    ...(trimText(destinationScopeId) ? { destination_scope_id: trimText(destinationScopeId) } : {}),
    ...(task.version ? { row_version: task.version } : {}),
  }, pgRequestOptions(context));
  return withAssignedNpubs(
    mapPgTaskToLocal(result.task, { workspaceOwnerNpub: context.workspaceOwnerNpub }),
    normalizeTaskAssigneeNpubs(result.task),
  );
}

export async function createTowerPgTaskCommentFromLocal(store, comment, contextOverride = null) {
  const context = contextOverride || resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !comment?.target_record_id) throw new Error('Tower PG task comments are not ready');
  const metadata = comment.pg_metadata && typeof comment.pg_metadata === 'object' && !Array.isArray(comment.pg_metadata)
    ? { ...comment.pg_metadata }
    : {};
  const clientRecordId = trimText(comment.pg_client_record_id || comment.record_id);
  if (clientRecordId) metadata.client_record_id = clientRecordId;
  metadata.mentions = canonicalTaskAgentMentions(comment.body);
  const result = await createTowerPgTaskComment(context.workspaceId, comment.target_record_id, {
    body: comment.body,
    ...(comment.pg_thread_id ? { thread_id: comment.pg_thread_id } : {}),
    mentions: canonicalTaskAgentMentions(comment.body),
    metadata,
  }, pgRequestOptions(context));
  return mapPgTaskCommentToLocal(result.comment, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: context.sessionNpub || store?.session?.npub,
  });
}

export async function createTowerPgDocCommentFromLocal(store, comment) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !comment?.target_record_id) throw new Error('Tower PG document comments are not ready');
  const metadata = comment.pg_metadata && typeof comment.pg_metadata === 'object' && !Array.isArray(comment.pg_metadata)
    ? { ...comment.pg_metadata }
    : {};
  if (comment.anchor_block_id) metadata.anchor_block_id = comment.anchor_block_id;
  if (comment.anchor_line_number != null && Number.isFinite(Number(comment.anchor_line_number))) metadata.anchor_line_number = Number(comment.anchor_line_number);
  if (comment.anchor_end_line_number != null && Number.isFinite(Number(comment.anchor_end_line_number))) metadata.anchor_end_line_number = Number(comment.anchor_end_line_number);
  if (typeof comment.anchor_quote === 'string' && comment.anchor_quote) metadata.anchor_quote = comment.anchor_quote;
  if (comment.anchor_start_offset != null && Number.isFinite(Number(comment.anchor_start_offset))) metadata.anchor_start_offset = Number(comment.anchor_start_offset);
  if (comment.anchor_end_offset != null && Number.isFinite(Number(comment.anchor_end_offset))) metadata.anchor_end_offset = Number(comment.anchor_end_offset);
  metadata.comment_status = comment.comment_status || metadata.comment_status || 'open';
  metadata.mentions = canonicalDocumentAgentMentions(comment.body);
  const body = {
    body: comment.body,
    ...(comment.parent_comment_id ? { parent_comment_id: comment.parent_comment_id } : {}),
    mentions: canonicalDocumentAgentMentions(comment.body),
    metadata,
  };
  const result = await createTowerPgDocComment(context.workspaceId, comment.target_record_id, body, pgRequestOptions(context));
  return mapPgDocCommentToLocal(result.comment, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
  });
}

export async function updateTowerPgDocCommentFromLocal(store, comment) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !comment?.target_record_id || !comment?.record_id) throw new Error('Tower PG document comments are not ready');
  const metadata = comment.pg_metadata && typeof comment.pg_metadata === 'object' && !Array.isArray(comment.pg_metadata)
    ? { ...comment.pg_metadata }
    : {};
  if (comment.anchor_block_id) metadata.anchor_block_id = comment.anchor_block_id;
  if (comment.anchor_line_number != null && Number.isFinite(Number(comment.anchor_line_number))) metadata.anchor_line_number = Number(comment.anchor_line_number);
  if (comment.anchor_end_line_number != null && Number.isFinite(Number(comment.anchor_end_line_number))) metadata.anchor_end_line_number = Number(comment.anchor_end_line_number);
  if (typeof comment.anchor_quote === 'string' && comment.anchor_quote) metadata.anchor_quote = comment.anchor_quote;
  if (comment.anchor_start_offset != null && Number.isFinite(Number(comment.anchor_start_offset))) metadata.anchor_start_offset = Number(comment.anchor_start_offset);
  if (comment.anchor_end_offset != null && Number.isFinite(Number(comment.anchor_end_offset))) metadata.anchor_end_offset = Number(comment.anchor_end_offset);
  metadata.comment_status = comment.comment_status || metadata.comment_status || 'open';
  const result = await updateTowerPgDocComment(context.workspaceId, comment.target_record_id, comment.record_id, {
    comment_status: metadata.comment_status,
    row_version: comment.previous_version || comment.version || undefined,
  }, pgRequestOptions(context));
  return mapPgDocCommentToLocal(result.comment, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
  });
}

export async function deleteTowerPgDocCommentFromLocal(store, comment) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !comment?.target_record_id || !comment?.record_id) throw new Error('Tower PG document comments are not ready');
  const result = await deleteTowerPgDocComment(context.workspaceId, comment.target_record_id, comment.record_id, {
    rowVersion: comment.version || undefined,
    ...pgRequestOptions(context),
  });
  return {
    ...mapPgDocCommentToLocal(result.comment, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: store?.session?.npub,
    }),
    record_state: 'deleted',
  };
}

export async function createTowerPgMessageFromLocal(store, message, options = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !message?.channel_id) throw new Error('Tower PG chat is not ready');
  const parentMessage = options.parentMessage || null;
  const threadId = trimText(options.threadId || parentMessage?.pg_thread_id || message?.pg_thread_id || message?.thread_id);
  if (trimText(message?.parent_message_id) && !threadId) {
    throw new Error('Tower PG reply thread id is missing');
  }
  const metadata = message?.pg_metadata && typeof message.pg_metadata === 'object' && !Array.isArray(message.pg_metadata)
    ? { ...message.pg_metadata }
    : {};
  const attachments = mergeChatStorageAttachments(message?.body, message?.attachments);
  if (attachments.length > 0) {
    metadata.attachments = attachments;
  }
  const clientRecordId = trimText(message?.pg_client_record_id || message?.record_id);
  if (clientRecordId) metadata.client_record_id = clientRecordId;
  const clientRequestId = trimText(message?.pg_client_request_id);
  const threadTitle = trimText(message?.pg_thread_title);
  const messageSignature = await buildAgentInstructionSignature({
    body: message.body,
    workspaceId: context.workspaceId,
    channelId: message.channel_id,
    threadId,
  });
  // Signing may wait for native/user approval. Diagnostics consent can be
  // revoked while that prompt is open, so recheck immediately before delivery.
  await options.assertCanSend?.();
  const result = await createTowerPgChannelMessage(context.workspaceId, message.channel_id, {
    body: message.body,
    message_signature: messageSignature,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    ...(threadId ? { thread_id: threadId } : {
      create_thread: true,
      ...(threadTitle ? { thread_title: threadTitle } : {}),
    }),
  }, pgRequestOptions(context));
  const threadById = new Map();
  const returnedThreadId = trimText(result.thread?.id || result.message?.thread_id);
  if (returnedThreadId) {
    threadById.set(returnedThreadId, {
      ...result.thread,
      source_message_id: trimText(result.thread?.source_message_id)
        || trimText(parentMessage?.record_id)
        || (!threadId ? trimText(result.message?.id) : ''),
    });
  }
  if (threadId && parentMessage?.record_id && !threadById.has(threadId)) {
    threadById.set(threadId, {
      id: threadId,
      source_message_id: parentMessage.record_id,
    });
  }
  const messageForMapping = threadId && !trimText(result.message?.thread_id)
    ? { ...result.message, thread_id: threadId }
    : result.message;
  return mapPgMessageToLocal(messageForMapping, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
    threadById,
  });
}

export async function branchTowerPgThreadFromMessage(store, message, { clientRequestId, recipientNpub = '', parentThreadId: parentThreadIdOverride = '' } = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const channelId = trimText(message?.channel_id);
  const parentThreadId = trimText(parentThreadIdOverride || message?.pg_effective_thread_id || message?.pg_thread_id);
  const branchPointMessageId = trimText(message?.record_id);
  if (!context.workspaceId || !channelId || !parentThreadId || !branchPointMessageId) {
    throw new Error('Tower PG branch source is not ready');
  }
  const result = await createTowerPgThreadBranch(context.workspaceId, channelId, parentThreadId, {
    branch_point_message_id: branchPointMessageId,
    client_request_id: trimText(clientRequestId),
    metadata: {
      source: 'flightdeck_branch',
      ...(trimText(recipientNpub) ? { inherited_agent_recipient_npub: trimText(recipientNpub) } : {}),
    },
  }, pgRequestOptions(context));
  return mapPgThreadToLocal(result.thread, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
  });
}

export async function updateTowerPgThreadTitleFromLocal(store, threadRow, title) {
  const context = resolveTowerPgWorkspaceContext(store);
  const threadId = trimText(threadRow?.pg_thread_id || threadRow?.record_id);
  if (!threadId) throw new Error('Thread id is required');
  const intendedTitle = trimText(title);
  const diagnosticOperation = createDiagnosticOperation('thread-rename');
  const requestOptions = { ...pgRequestOptions(context), diagnosticOperation };
  const updateTitle = (rowVersion) => updateTowerPgThread(context.workspaceId, threadId, {
    title: intendedTitle,
    ...(Number(rowVersion) > 0 ? { row_version: Number(rowVersion) } : {}),
  }, requestOptions);
  let result;
  let recovered = false;
  try {
    try {
      result = await updateTitle(threadRow?.pg_thread_version || threadRow?.version);
    } catch (error) {
      if (!isStalePgRowVersionError(error)) throw error;
      emitDiagnostic({ ...diagnosticOperation, source: 'browser', code: 'recovery', level: 'info', stage: 'refresh',
        outcome: 'attempt', errorCode: 'stale_row_version', status: error.status });
      const refreshed = await getTowerPgThread(context.workspaceId, threadId, requestOptions);
      const refreshedVersion = Number(refreshed?.thread?.row_version || refreshed?.thread?.version);
      if (!Number.isInteger(refreshedVersion) || refreshedVersion < 1) {
        throw new Error('Tower PG thread refresh did not return a row version.');
      }
      result = await updateTitle(refreshedVersion);
      recovered = true;
    }
    finishDiagnosticOperation(diagnosticOperation, recovered ? 'recovered' : 'succeeded');
  } catch (error) {
    finishDiagnosticOperation(diagnosticOperation, 'failed', error);
    throw error;
  }
  const acceptedVersion = Number(result.thread?.row_version || threadRow?.pg_thread_version || threadRow?.version || 1);
  return {
    ...threadRow,
    title: trimText(result.thread?.title) || intendedTitle,
    ...(threadRow?.pg_record_type === 'thread' ? { version: acceptedVersion } : {}),
    pg_thread_version: acceptedVersion,
    updated_at: result.thread?.updated_at || threadRow?.updated_at,
  };
}

export async function updateTowerPgMessageFromLocal(store, message, { body, mentions = [] } = {}) {
  const context = resolveTowerPgWorkspaceContext(store);
  const messageId = trimText(message?.record_id);
  const channelId = trimText(message?.channel_id);
  const threadId = trimText(message?.pg_thread_id || message?.thread_id);
  const rowVersion = Number(message?.version);
  const revisedBody = trimText(body);
  if (!context.workspaceId || !messageId || !channelId) throw new Error('Tower PG message is not ready');
  if (!Number.isInteger(rowVersion) || rowVersion < 1) throw new Error('Tower PG message revision is missing');
  const messageSignature = await buildAgentInstructionSignature({
    body: revisedBody,
    workspaceId: context.workspaceId,
    channelId,
    threadId,
    messageId,
    revision: rowVersion + 1,
  });
  const result = await updateTowerPgMessage(context.workspaceId, messageId, {
    body: revisedBody,
    row_version: rowVersion,
    mentions: Array.isArray(mentions) ? mentions : [],
    message_signature: messageSignature,
  }, pgRequestOptions(context));
  const threadById = new Map();
  if (threadId) {
    threadById.set(threadId, {
      id: threadId,
      source_message_id: trimText(message?.parent_message_id) || messageId,
    });
  }
  return mapPgMessageToLocal(result.message, {
    workspaceOwnerNpub: context.workspaceOwnerNpub,
    senderNpub: store?.session?.npub,
    threadById,
  });
}

export async function deleteTowerPgMessageFromLocal(store, message) {
  const context = resolveTowerPgWorkspaceContext(store);
  if (!context.workspaceId || !message?.record_id) throw new Error('Tower PG message is not ready');
  const deleteMessage = async (targetMessage) => deleteTowerPgMessage(context.workspaceId, targetMessage.record_id, {
    rowVersion: targetMessage.version || undefined,
    ...pgRequestOptions(context),
  });
  let result;
  try {
    result = await deleteMessage(message);
  } catch (error) {
    if (isMissingPgMessageDeleteError(error)) {
      const acceptedMessage = Array.isArray(store?.messages)
        ? store.messages.find((candidate) => (
          candidate?.pg_backend === true
          && candidate.record_state !== 'deleted'
          && candidate.record_id !== message.record_id
          && trimText(candidate.pg_client_record_id) === message.record_id
        ))
        : null;
      if (acceptedMessage?.record_id) {
        const retryResult = await deleteMessage(acceptedMessage);
        return {
          ...mapPgMessageToLocal(retryResult.message, {
            workspaceOwnerNpub: context.workspaceOwnerNpub,
            senderNpub: store?.session?.npub,
          }),
          record_state: 'deleted',
        };
      }
      const now = new Date().toISOString();
      return {
        ...message,
        owner_npub: message.owner_npub || context.workspaceOwnerNpub,
        record_state: 'deleted',
        sync_status: 'synced',
        version: (Number(message.version) || 1) + 1,
        updated_at: now,
        pg_backend: true,
        pg_record_type: message.pg_record_type || 'message',
        pg_workspace_id: message.pg_workspace_id || context.workspaceId,
      };
    }
    throw error;
  }
  return {
    ...mapPgMessageToLocal(result.message, {
      workspaceOwnerNpub: context.workspaceOwnerNpub,
      senderNpub: store?.session?.npub,
    }),
    record_state: 'deleted',
  };
}

export async function deleteTowerPgThreadFromLocal(store, parentMessage) {
  const context = resolveTowerPgWorkspaceContext(store);
  const threadId = trimText(parentMessage?.pg_thread_id);
  if (!context.workspaceId || !threadId) throw new Error('Tower PG thread is not ready');
  const result = await deleteTowerPgThread(context.workspaceId, threadId, {
    ...pgRequestOptions(context),
  });
  return result.thread;
}

export async function archiveTowerPgThreadFromLocal(store, parentMessage, archived = true) {
  const context = resolveTowerPgWorkspaceContext(store);
  const threadId = trimText(parentMessage?.pg_thread_id || parentMessage?.record_id);
  if (!context.workspaceId || !threadId) throw new Error('Tower PG thread is not ready');
  const result = await archiveTowerPgThread(context.workspaceId, threadId, {
    archived,
    ...pgRequestOptions(context),
  });
  return result.thread;
}

export async function writeTowerPgContext(store, operation, input) {
  const context = resolveTowerPgWorkspaceContext(store);
  const id = encodeURIComponent(input.componentId || '');
  const routes = {
    create: ['POST', ''], update: ['PATCH', `/${id}`],
    attach: ['POST', `/${id}/references`],
    unlink: ['DELETE', `/${id}/references/${encodeURIComponent(input.referenceId || '')}`],
    delete: ['POST', `/${id}/delete`],
  };
  const route = routes[operation];
  if (!route || !input.scopeId || operation !== 'create' && !input.componentId
    || operation === 'unlink' && !input.referenceId) throw new Error('Invalid context command');
  // No optimistic hierarchy, offline queue or inferred delete confirmation.
  return requestTowerPgContext(context.workspaceId, input.scopeId, route[1], {
    ...pgRequestOptions(context), method: route[0], body: input.body,
  });
}
