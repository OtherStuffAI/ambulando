import { fileBlossomMixin } from './file-blossom.js';
import {
  completeStorageObject,
  downloadStorageObject,
  downloadStorageObjectBlob,
  prepareStorageObject,
  uploadStorageObject,
} from './api.js';
import { upsertDocument, upsertFileFolder } from './db.js';
import {
  createTowerPgFileFolderFromLocal,
  createTowerPgFileFromLocal,
  updateTowerPgDocumentMetadata,
  updateTowerPgFileFromLocal,
  updateTowerPgFileMetadata,
} from './tower-command-intents.js';
import { buildStoragePrepareBody } from './storage-payloads.js';
import { recordFamilyHash } from './translators/chat.js';
import { mapPgDocToLocal, mapPgFileToLocalDocument, resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';

const UNSCOPED_TASK_BOARD_ID = '__unscoped__';
const STORAGE_REF_RE = /storage:\/\/([A-Za-z0-9-]+)/g;
const MARKDOWN_STORAGE_REF_RE = /(!?)\[([^\]]*)\]\(storage:\/\/([A-Za-z0-9-]+)(?:\s+["'][^"']*["'])?\)/g;
const fileBrowserRowsCache = new WeakMap();

function sameReferences(previous = [], next = []) {
  return previous.length === next.length
    && next.every((value, index) => Object.is(value, previous[index]));
}

function cachedFileBrowserRows(store) {
  const references = [
    store.documents,
    store.tasks,
    store.channels,
    store.fileMessages,
    store.fileComments,
    store.audioNotes,
  ];
  const cached = fileBrowserRowsCache.get(store);
  if (cached && sameReferences(cached.references, references)) return cached.rows;
  const rows = buildFileBrowserRows(store);
  fileBrowserRowsCache.set(store, { references, rows });
  return rows;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function uniqueStorageRefs(value = '') {
  const refs = [];
  const seen = new Set();
  const source = String(value || '');
  let match;
  while ((match = MARKDOWN_STORAGE_REF_RE.exec(source)) !== null) {
    const objectId = normalizeString(match[3]);
    if (!objectId || seen.has(objectId)) continue;
    const isImage = match[1] === '!';
    seen.add(objectId);
    refs.push({
      objectId,
      offset: match.index,
      kind: isImage ? 'image' : 'file',
      name: normalizeString(match[2] || '') || (isImage ? 'Image' : 'File'),
      contentType: isImage ? 'image' : '',
    });
  }

  while ((match = STORAGE_REF_RE.exec(source)) !== null) {
    const objectId = normalizeString(match[1]);
    if (!objectId || seen.has(objectId)) continue;
    seen.add(objectId);
    refs.push({
      objectId,
      offset: match.index,
      kind: 'file',
      name: extractStorageRefLabel(source, match.index) || 'File',
      contentType: '',
    });
  }
  return refs;
}

function extractStorageRefLabel(source, hrefIndex) {
  const prefix = source.slice(Math.max(0, hrefIndex - 160), hrefIndex);
  const match = prefix.match(/!?\[([^\]]*)\]\([^)]*$/);
  return normalizeString(match?.[1] || '');
}

function getRecordScopeId(row = {}) {
  return normalizeString(
    row.scope_id
    || row.scope_l5_id
    || row.scope_l4_id
    || row.scope_l3_id
    || row.scope_l2_id
    || row.scope_l1_id
    || ''
  ) || null;
}

function getScopeBoardOptions(store = {}) {
  const source = Array.isArray(store.taskBoards) && store.taskBoards.length > 0
    ? store.taskBoards
    : (store.flightDeckScopeOptions || []);
  return source.filter((option) =>
    option?.zoom === 'scope'
    && option.id
    && option.id !== 'all'
    && option.id !== '__all__'
    && option.id !== UNSCOPED_TASK_BOARD_ID
  );
}

function matchesScope(rowScopeId, selectedScopeId, scopesMap) {
  const selected = normalizeString(selectedScopeId);
  const rowScope = normalizeString(rowScopeId);
  if (!selected || selected === 'all' || selected === '__all__') return true;
  if (selected === UNSCOPED_TASK_BOARD_ID) return !rowScope;
  if (!rowScope) return false;
  if (rowScope === selected) return true;
  const scope = scopesMap?.get?.(rowScope);
  if (!scope) return false;
  return [
    scope.l1_id,
    scope.l2_id,
    scope.l3_id,
    scope.l4_id,
    scope.l5_id,
    scope.parent_id,
  ].some((value) => normalizeString(value) === selected);
}

function currentPgFilesScopeId(store = {}) {
  return normalizeString(store.pgContextScopeId || store.selectedBoardScope?.record_id || '');
}

function currentPgFilesChannelIds(store = {}) {
  const selectedChannelId = normalizeString(store.pgContextSelectedChannelId);
  if (selectedChannelId) return [selectedChannelId];
  const channels = Array.isArray(store.pgContextChannels) ? store.pgContextChannels : [];
  return [...new Set(channels
    .map((channel) => normalizeString(channel?.record_id))
    .filter(Boolean))];
}

function fileFolderMatchesCurrentContext(folder = {}, store = {}) {
  if (!folder?.record_id || folder.record_state === 'deleted') return false;
  const scopeId = currentPgFilesScopeId(store);
  if (scopeId && !matchesScope(folder.scope_id, scopeId, store.scopesMap)) return false;
  const channelIds = currentPgFilesChannelIds(store);
  if (channelIds.length > 0 && !channelIds.includes(normalizeString(folder.channel_id))) return false;
  return true;
}

function sortRows(rows = []) {
  return [...rows].sort((a, b) => {
    const ts = String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    if (ts !== 0) return ts;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function kindFromContentType(contentType = '') {
  const normalized = normalizeString(contentType).toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.includes('pdf') || normalized.includes('document') || normalized.includes('text/')) return 'document';
  return 'file';
}

function fileExtension(value = '') {
  const clean = normalizeString(value).split(/[?#]/)[0].toLowerCase();
  const segment = clean.split('/').pop() || clean;
  const index = segment.lastIndexOf('.');
  return index >= 0 ? segment.slice(index) : '';
}

export function isConvertibleTextFile(row = {}, document = null) {
  const extension = fileExtension(row.name || document?.title || document?.display_name);
  if (extension === '.txt' || extension === '.md' || extension === '.markdown') return true;
  const contentType = normalizeString(row.content_type || document?.content_storage_content_type).toLowerCase();
  return contentType === 'text/plain' || contentType === 'text/markdown' || contentType === 'text/x-markdown';
}

function fileUploadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `file-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultFileUploadName(file = {}) {
  return normalizeString(file.name) || 'Untitled file';
}

const FILE_CONTENT_TYPES_BY_EXTENSION = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

export function resolveFileUploadContentType(file = {}) {
  const reported = normalizeString(file.type).toLowerCase();
  if (reported && reported !== 'application/octet-stream') return reported;
  return FILE_CONTENT_TYPES_BY_EXTENSION[fileExtension(file.name)] || reported || 'application/octet-stream';
}

async function sha256HexForBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildFileUploadQueueItem(file, { scopeId = null, channelId = null, folderId = null } = {}) {
  return {
    id: fileUploadId(),
    file,
    original_name: defaultFileUploadName(file),
    name: defaultFileUploadName(file),
    scope_id: normalizeString(scopeId),
    channel_id: normalizeString(channelId),
    folder_id: normalizeString(folderId),
    status: 'queued',
    progress: 0,
    error: '',
    object_id: '',
    size_bytes: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
    content_type: resolveFileUploadContentType(file),
  };
}

function baseRow({
  object_id,
  kind,
  name,
  source_type,
  source_label,
  source_record_id,
  source_target_type = null,
  source_target_record_id = null,
  scope_id = null,
  channel_id = null,
  thread_id = null,
  folder_id = null,
  content_type = '',
  size_bytes = null,
  updated_at = '',
  preview = '',
  archived = false,
  workspace_id = '',
  backend_url = '',
  pg_record_type = '',
}) {
  const objectId = normalizeString(object_id);
  return {
    id: `${source_type}:${source_record_id || 'record'}:${objectId}`,
    object_id: objectId,
    workspace_id,
    backend_url,
    pg_record_type,
    kind,
    name: normalizeString(name) || objectId || 'File',
    source_type,
    source_label: normalizeString(source_label) || 'Flight Deck',
    source_record_id: source_record_id || null,
    source_target_type: normalizeString(source_target_type) || null,
    source_target_record_id: source_target_record_id || null,
    scope_id: scope_id || null,
    channel_id: channel_id || null,
    thread_id: thread_id || null,
    folder_id: folder_id || null,
    content_type: normalizeString(content_type),
    size_bytes: Number.isFinite(Number(size_bytes)) ? Number(size_bytes) : null,
    updated_at: updated_at || '',
    preview: normalizeString(preview),
    archived: Boolean(archived),
  };
}

function commentTargetContext(comment, context) {
  const targetId = normalizeString(comment?.target_record_id);
  const family = normalizeString(comment?.target_record_family_hash);
  if (!targetId) return {};

  if (family === recordFamilyHash('document')) {
    const document = context.documentById.get(targetId);
    return {
      scope_id: getRecordScopeId(document) || comment.pg_scope_id || null,
      channel_id: document?.pg_channel_id || comment.pg_channel_id || null,
      thread_id: document?.pg_thread_id || null,
      source_label: `Comment on ${document?.title || 'document'}`,
      source_target_type: 'document',
      source_target_record_id: targetId,
    };
  }

  if (family === recordFamilyHash('task')) {
    const task = context.taskById.get(targetId);
    return {
      scope_id: getRecordScopeId(task) || comment.pg_scope_id || null,
      channel_id: task?.pg_channel_id || comment.pg_channel_id || null,
      thread_id: task?.pg_thread_id || null,
      source_label: `Comment on ${task?.title || 'task'}`,
      source_target_type: 'task',
      source_target_record_id: targetId,
    };
  }

  if (family === recordFamilyHash('chat_message')) {
    const message = context.messageById.get(targetId);
    const channel = context.channelById.get(message?.channel_id);
    return {
      channel_id: message?.channel_id || null,
      thread_id: message?.pg_thread_id || message?.parent_message_id || null,
      source_label: `Comment in ${channel?.title || 'chat'}`,
      source_target_type: 'chat',
      source_target_record_id: targetId,
    };
  }

  return {};
}

function audioTargetContext(note, context) {
  const targetId = normalizeString(note?.target_record_id);
  const family = normalizeString(note?.target_record_family_hash);
  if (!targetId) return {};

  if (family === recordFamilyHash('chat_message')) {
    const message = context.messageById.get(targetId);
    const channel = context.channelById.get(message?.channel_id);
    return {
      channel_id: message?.channel_id || null,
      thread_id: message?.pg_thread_id || message?.parent_message_id || null,
      source_label: channel?.title ? `Audio in ${channel.title}` : 'Chat audio',
      source_target_type: 'chat',
      source_target_record_id: targetId,
    };
  }

  if (family === recordFamilyHash('document')) {
    const document = context.documentById.get(targetId);
    return {
      scope_id: getRecordScopeId(document),
      channel_id: document?.pg_channel_id || null,
      thread_id: document?.pg_thread_id || null,
      source_label: document?.title ? `Audio on ${document.title}` : 'Document audio',
      source_target_type: 'document',
      source_target_record_id: targetId,
    };
  }

  if (family === recordFamilyHash('task')) {
    const task = context.taskById.get(targetId);
    return {
      scope_id: getRecordScopeId(task),
      channel_id: task?.pg_channel_id || null,
      thread_id: task?.pg_thread_id || null,
      source_label: task?.title ? `Audio on ${task.title}` : 'Task audio',
      source_target_type: 'task',
      source_target_record_id: targetId,
    };
  }

  return {};
}

export function buildFileBrowserRows(store = {}) {
  const documents = Array.isArray(store.documents) ? store.documents : [];
  const tasks = Array.isArray(store.tasks) ? store.tasks : [];
  const channels = Array.isArray(store.channels) ? store.channels : [];
  const messages = Array.isArray(store.fileMessages) ? store.fileMessages : [];
  const comments = Array.isArray(store.fileComments) ? store.fileComments : [];
  const audioNotes = Array.isArray(store.audioNotes) ? store.audioNotes : [];

  const context = {
    documentById: new Map(documents.map((document) => [document.record_id, document])),
    taskById: new Map(tasks.map((task) => [task.record_id, task])),
    channelById: new Map(channels.map((channel) => [channel.record_id, channel])),
    messageById: new Map(messages.map((message) => [message.record_id, message])),
  };

  const rows = [];

  for (const document of documents) {
    const scopeId = getRecordScopeId(document);
    if (document.pg_record_type === 'file' || document.pg_storage_object_id) {
      const objectId = document.pg_storage_object_id || uniqueStorageRefs(document.content)[0]?.objectId;
      if (objectId) rows.push(baseRow({
        object_id: objectId,
        kind: kindFromContentType(document.content_storage_content_type),
        name: document.title,
        source_type: 'document',
        pg_record_type: 'file',
        source_label: document.title,
        source_record_id: document.record_id,
        scope_id: scopeId,
        channel_id: document.pg_channel_id,
        thread_id: document.pg_thread_id,
        source_target_type: document.pg_task_id ? 'task' : null,
        source_target_record_id: document.pg_task_id || null,
        folder_id: document.pg_folder_id,
        workspace_id: document.pg_workspace_id,
        backend_url: document.pg_backend_url,
        content_type: document.content_storage_content_type,
        size_bytes: document.content_size_bytes,
        updated_at: document.updated_at,
        archived: document.record_state === 'archived',
      }));
      continue;
    }
    if (document.content_storage_object_id) {
      rows.push(baseRow({
        object_id: document.content_storage_object_id,
        kind: 'document',
        name: document.title || 'Document content',
        source_type: 'document',
        source_label: document.title || 'Untitled document',
        source_record_id: document.record_id,
        scope_id: scopeId,
        channel_id: document.pg_channel_id || null,
        thread_id: document.pg_thread_id || null,
        folder_id: document.pg_folder_id || null,
        content_type: document.content_storage_content_type,
        size_bytes: document.content_size_bytes,
        updated_at: document.updated_at,
        archived: document.record_state === 'archived',
      }));
    }
    for (const ref of uniqueStorageRefs(document.content)) {
      rows.push(baseRow({
        object_id: ref.objectId,
        kind: ref.kind,
        name: ref.name,
        source_type: 'document',
        source_label: document.title || 'Untitled document',
        source_record_id: document.record_id,
        scope_id: scopeId,
        channel_id: document.pg_channel_id || null,
        thread_id: document.pg_thread_id || null,
        folder_id: document.pg_folder_id || null,
        content_type: ref.contentType,
        updated_at: document.updated_at,
        archived: document.record_state === 'archived',
      }));
    }
  }

  for (const task of tasks) {
    const scopeId = getRecordScopeId(task);
    for (const ref of uniqueStorageRefs(task.description)) {
      rows.push(baseRow({
        object_id: ref.objectId,
        kind: ref.kind,
        name: ref.name,
        source_type: 'task',
        source_label: task.title || 'Untitled task',
        source_record_id: task.record_id,
        scope_id: scopeId,
        channel_id: task.pg_channel_id || null,
        thread_id: task.pg_thread_id || null,
        content_type: ref.contentType,
        updated_at: task.updated_at,
      }));
    }
  }

  for (const message of messages) {
    const channel = context.channelById.get(message.channel_id);
    for (const ref of uniqueStorageRefs(message.body)) {
      rows.push(baseRow({
        object_id: ref.objectId,
        kind: ref.kind,
        name: ref.name,
        source_type: 'chat',
        source_label: channel?.title || 'Chat',
        source_record_id: message.record_id,
        scope_id: getRecordScopeId(channel),
        channel_id: message.channel_id || null,
        thread_id: message.pg_thread_id || message.parent_message_id || null,
        content_type: ref.contentType,
        updated_at: message.updated_at,
        preview: message.body,
      }));
    }
  }

  for (const comment of comments) {
    const target = commentTargetContext(comment, context);
    for (const ref of uniqueStorageRefs(comment.body)) {
      rows.push(baseRow({
        object_id: ref.objectId,
        kind: ref.kind,
        name: ref.name,
        source_type: 'comment',
        source_label: target.source_label || 'Comment',
        source_record_id: comment.record_id,
        source_target_type: target.source_target_type || null,
        source_target_record_id: target.source_target_record_id || null,
        scope_id: target.scope_id || null,
        channel_id: target.channel_id || null,
        thread_id: target.thread_id || null,
        content_type: ref.contentType,
        updated_at: comment.updated_at,
        preview: comment.body,
      }));
    }
  }

  for (const note of audioNotes) {
    if (!note.storage_object_id) continue;
    const target = audioTargetContext(note, context);
    rows.push(baseRow({
      object_id: note.storage_object_id,
      kind: 'audio',
      name: note.title || 'Voice note',
      source_type: 'audio',
      source_label: target.source_label || 'Audio note',
      source_record_id: note.record_id,
      source_target_type: target.source_target_type || null,
      source_target_record_id: target.source_target_record_id || null,
      scope_id: target.scope_id || null,
      channel_id: target.channel_id || null,
      thread_id: target.thread_id || note.pg_thread_id || null,
      content_type: note.mime_type || 'audio/webm',
      size_bytes: note.size_bytes,
      updated_at: note.updated_at || note.created_at,
      preview: note.transcript_preview || note.summary || '',
    }));
  }

  const deduped = new Map();
  for (const row of rows) {
    if (!row.object_id) continue;
    const key = `${row.object_id}:${row.source_type}:${row.source_record_id || ''}`;
    deduped.set(key, row);
  }
  return sortRows([...deduped.values()]);
}

export function filterFileBrowserRows(rows = [], {
  query = '',
  type = 'all',
  source = 'all',
  scopeId = 'all',
  channelId = 'all',
  threadId = 'all',
  folderId = 'all',
  contextChannelId = null,
  contextThreadId = null,
  scopesMap = null,
} = {}) {
  const normalizedQuery = normalizeString(query).toLowerCase();
  const normalizedType = normalizeString(type) || 'all';
  const normalizedSource = normalizeString(source) || 'all';
  const normalizedChannel = normalizeString(channelId) || 'all';
  const normalizedThread = normalizeString(threadId) || 'all';
  const normalizedFolder = folderId === null ? '' : normalizeString(folderId);
  const normalizedContextChannel = normalizeString(contextChannelId);
  const normalizedContextThread = normalizeString(contextThreadId);

  return rows.filter((row) => {
    if (normalizedType !== 'all' && row.kind !== normalizedType) return false;
    if (normalizedSource !== 'all' && row.source_type !== normalizedSource) return false;
    if (normalizedChannel !== 'all' && row.channel_id !== normalizedChannel) return false;
    if (normalizedThread !== 'all' && row.thread_id !== normalizedThread) return false;
    if (normalizedFolder !== 'all' && normalizeString(row.folder_id) !== normalizedFolder) return false;
    if (normalizedContextChannel && row.channel_id !== normalizedContextChannel) return false;
    if (normalizedContextThread && row.thread_id !== normalizedContextThread) return false;
    if (!matchesScope(row.scope_id, scopeId, scopesMap)) return false;
    if (!normalizedQuery) return true;
    return [
      row.name,
      row.source_label,
      row.object_id,
      row.content_type,
      row.preview,
    ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
  });
}

export const filesManagerMixin = {
  openFileUploadPanel() {
    if (!this.isTowerPgMode) {
      this.error = 'Files page uploads are available for Tower PG workspaces.';
      return;
    }
    this.fileUploadOpen = true;
    this.fileUploadError = '';
  },

  closeFileUploadPanel() {
    this.fileUploadOpen = false;
    this.fileUploadError = '';
    if ((this.fileUploadItems || []).some((item) => this.isFileUploadBusy(item))) {
      this.showFileUploadNotice('Uploads are continuing in the background.');
    }
  },

  get defaultFileUploadScopeId() {
    const selectedChannel = (this.channels || []).find((channel) => channel?.record_id === this.pgContextSelectedChannelId);
    const channelScopeId = getRecordScopeId(selectedChannel);
    if (channelScopeId) return channelScopeId;
    if (this.selectedBoardScope?.record_id) return this.selectedBoardScope.record_id;
    if (this.selectedBoardId && this.scopesMap?.has?.(this.selectedBoardId)) return this.selectedBoardId;
    const firstChannel = (this.channels || []).find((channel) => channel?.record_state !== 'deleted' && getRecordScopeId(channel));
    return getRecordScopeId(firstChannel) || '';
  },

  get fileUploadScopeOptions() {
    const seen = new Set();
    const options = [];
    for (const option of getScopeBoardOptions(this)) {
      const id = normalizeString(option?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      options.push({ id, label: option.label || id });
    }
    for (const channel of this.channels || []) {
      const scopeId = getRecordScopeId(channel);
      if (!scopeId || seen.has(scopeId)) continue;
      seen.add(scopeId);
      options.push({
        id: scopeId,
        label: this.getScopeBreadcrumb?.(scopeId) || this.getTaskBoardLabel?.(scopeId) || scopeId,
      });
    }
    return options;
  },

  fileUploadChannelOptions(scopeId = '') {
    const requestedScopeId = normalizeString(scopeId);
    return (this.channels || [])
      .filter((channel) => channel?.record_id && channel.record_state !== 'deleted')
      .filter((channel) => !requestedScopeId || getRecordScopeId(channel) === requestedScopeId)
      .map((channel) => ({
        id: channel.record_id,
        label: this.getChannelLabel?.(channel) || channel.title || channel.name || channel.record_id,
      }))
      .sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
  },

  isFileUploadBusy(item = {}) {
    return ['queued', 'reading', 'preparing', 'uploading', 'completing', 'saving'].includes(item.status);
  },

  get activeFileUploadItems() {
    return (this.fileUploadItems || []).filter((item) => this.isFileUploadBusy(item));
  },

  get activeFileUploadCount() {
    return this.activeFileUploadItems.length;
  },

  get hasActiveFileUploads() {
    return this.activeFileUploadCount > 0;
  },

  get fileUploadOverallProgress() {
    const activeItems = this.activeFileUploadItems;
    if (activeItems.length === 0) return 0;
    const total = activeItems.reduce((sum, item) => sum + Math.max(0, Math.min(100, Number(item.progress) || 0)), 0);
    return Math.round(total / activeItems.length);
  },

  get fileUploadToolbarLabel() {
    const count = this.activeFileUploadCount;
    if (count === 0) return 'Uploads';
    const percent = this.fileUploadOverallProgress;
    return count === 1 ? `1 upload ${percent}%` : `${count} uploads ${percent}%`;
  },

  canEditFileUploadItem(item = {}) {
    return ['queued', 'reading', 'preparing', 'uploading', 'completing'].includes(item.status);
  },

  fileUploadStatusLabel(item = {}) {
    switch (item.status) {
      case 'queued': return 'Queued';
      case 'reading': return 'Reading';
      case 'preparing': return 'Preparing';
      case 'uploading': return 'Uploading';
      case 'completing': return 'Finalizing';
      case 'saving': return 'Saving file';
      case 'done': return 'Uploaded';
      case 'failed': return item.error || 'Failed';
      default: return 'Waiting';
    }
  },

  patchFileUploadItem(itemId, patch = {}) {
    const id = normalizeString(itemId);
    if (!id) return;
    this.fileUploadItems = (this.fileUploadItems || []).map((item) => (
      item.id === id ? { ...item, ...patch } : item
    ));
  },

  removeFileUploadItem(itemId) {
    const id = normalizeString(itemId);
    const item = (this.fileUploadItems || []).find((entry) => entry.id === id);
    if (item && this.isFileUploadBusy(item)) return;
    this.fileUploadItems = (this.fileUploadItems || []).filter((entry) => entry.id !== id);
  },

  clearCompletedFileUploads() {
    this.fileUploadItems = (this.fileUploadItems || []).filter((item) => this.isFileUploadBusy(item));
  },

  clearFileUploadNotice() {
    this.fileUploadNotice = '';
    if (this._fileUploadNoticeTimer) {
      clearTimeout(this._fileUploadNoticeTimer);
      this._fileUploadNoticeTimer = null;
    }
  },

  showFileUploadNotice(message = '') {
    const text = normalizeString(message);
    if (!text) return;
    this.fileUploadNotice = text;
    if (this._fileUploadNoticeTimer) clearTimeout(this._fileUploadNoticeTimer);
    this._fileUploadNoticeTimer = setTimeout(() => {
      this.fileUploadNotice = '';
      this._fileUploadNoticeTimer = null;
    }, 6500);
  },

  notifyFileUploadsSettled() {
    const items = this.fileUploadItems || [];
    if (items.length === 0 || items.some((item) => this.isFileUploadBusy(item))) return;
    const uploadedCount = items.filter((item) => item.status === 'done').length;
    const failedCount = items.filter((item) => item.status === 'failed').length;
    if (failedCount > 0) {
      this.showFileUploadNotice(`${uploadedCount} uploaded, ${failedCount} failed.`);
      return;
    }
    if (uploadedCount > 0) {
      this.showFileUploadNotice(uploadedCount === 1 ? 'Upload complete.' : `${uploadedCount} uploads complete.`);
    }
  },

  resolveFileUploadChannel(scopeId, channelId = null) {
    const requestedScopeId = normalizeString(scopeId) || this.defaultFileUploadScopeId;
    const channels = (this.channels || []).filter((channel) => channel?.record_state !== 'deleted');
    const requestedChannelId = normalizeString(channelId);
    if (requestedChannelId) {
      const requested = channels.find((channel) => channel.record_id === requestedChannelId);
      return requested?.record_id && (!requestedScopeId || getRecordScopeId(requested) === requestedScopeId) ? requested : null;
    }
    const selected = channels.find((channel) => channel.record_id === this.pgContextSelectedChannelId);
    if (selected?.record_id && (!requestedScopeId || getRecordScopeId(selected) === requestedScopeId)) return selected;
    return channels.find((channel) => getRecordScopeId(channel) === requestedScopeId) || null;
  },

  resolveFileUploadThreadId(channelId) {
    const normalizedChannelId = normalizeString(channelId);
    if (normalizedChannelId && normalizedChannelId === normalizeString(this.pgContextSelectedChannelId)) {
      return normalizeString(this.pgContextSelectedThreadId);
    }
    return null;
  },

  async handleFileUploadInput(event) {
    const files = [...(event?.target?.files || [])].filter(Boolean);
    if (event?.target) event.target.value = '';
    await this.enqueueFileUploads(files);
  },

  async handleFilesPageDrop(event) {
    const files = [...(event?.dataTransfer?.files || [])].filter(Boolean);
    if (files.length === 0) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.openFileUploadPanel();
    await this.enqueueFileUploads(files);
    return true;
  },

  async enqueueFileUploads(files = [], options = {}) {
    const nextFiles = [...files].filter(Boolean);
    if (nextFiles.length === 0) return [];
    if (!this.isTowerPgMode) {
      this.error = 'Files page uploads are available for Tower PG workspaces.';
      return [];
    }
    if (!this.session?.npub || !this.workspaceOwnerNpub) {
      this.fileUploadError = 'Sign in and select a workspace before uploading files.';
      return [];
    }
    const selectedContext = this.resolvePgWriteContext?.({
      scopeId: options.scopeId,
      channelId: options.channelId,
      boardId: options.boardId || this.selectedBoardId,
    }) || null;
    if (!selectedContext) {
      // Destination routing is a separate dialog step. Keeping the uploader
      // open here creates two aria-modal surfaces and hides the chooser below
      // the later uploader in DOM order.
      this.fileUploadOpen = false;
      return this.openWriteContextModal?.('files', { files: nextFiles, options }) || [];
    }
    this.fileUploadOpen = true;
    this.fileUploadError = '';
    const defaultScopeId = selectedContext.scopeId;
    const defaultChannelId = selectedContext.channelId;
    const defaultFolderId = defaultChannelId === this.currentFileChannelId ? this.currentFileFolderId : '';
    const items = nextFiles.map((file) => buildFileUploadQueueItem(file, { scopeId: defaultScopeId, channelId: defaultChannelId, folderId: defaultFolderId }));
    this.fileUploadItems = [...items, ...(this.fileUploadItems || [])];
    for (const item of items) {
      void this.startFileUploadItem(item.id);
    }
    return items;
  },

  async startFileUploadItem(itemId) {
    const id = normalizeString(itemId);
    const initial = (this.fileUploadItems || []).find((item) => item.id === id);
    if (!initial?.file) return null;
    let stage = 'reading the selected file';
    try {
      this.patchFileUploadItem(id, { status: 'reading', progress: 8, error: '' });
      const bytes = new Uint8Array(await initial.file.arrayBuffer());
      const contentType = resolveFileUploadContentType(initial.file);
      stage = 'preparing secure storage';
      this.patchFileUploadItem(id, { status: 'preparing', progress: 18, size_bytes: bytes.byteLength, content_type: contentType });
      const prepareStorage = typeof this.prepareStorageObjectForCurrentWorkspace === 'function'
        ? this.prepareStorageObjectForCurrentWorkspace.bind(this)
        : prepareStorageObject;
      const prepared = await prepareStorage(buildStoragePrepareBody({
        ownerNpub: this.workspaceOwnerNpub,
        contentType,
        sizeBytes: initial.file.size || bytes.byteLength,
        fileName: initial.name,
      }));
      stage = 'uploading to storage';
      this.patchFileUploadItem(id, { status: 'uploading', progress: 38, object_id: prepared.object_id || '' });
      await uploadStorageObject(prepared, bytes, contentType);
      stage = 'completing secure storage';
      this.patchFileUploadItem(id, { status: 'completing', progress: 76 });
      await completeStorageObject(prepared.object_id, {
        size_bytes: bytes.byteLength,
        sha256_hex: await sha256HexForBytes(bytes),
      });

      const latest = (this.fileUploadItems || []).find((item) => item.id === id) || initial;
      const scopeId = normalizeString(latest.scope_id) || this.defaultFileUploadScopeId;
      const channel = this.resolveFileUploadChannel(scopeId, latest.channel_id);
      if (!channel?.record_id) throw new Error('Select a scope with a channel before uploading this file.');
      const displayName = normalizeString(latest.name) || defaultFileUploadName(initial.file);
      const threadId = this.resolveFileUploadThreadId(channel.record_id);
      const folderId = this.fileFolderOptions(scopeId, channel.record_id).some((folder) => folder.id === normalizeString(latest.folder_id))
        ? normalizeString(latest.folder_id)
        : '';
      this.patchFileUploadItem(id, { status: 'saving', progress: 88, scope_id: scopeId });
      stage = 'creating the Flight Deck file record';
      const acceptedFile = await createTowerPgFileFromLocal(this, {
        record_id: id,
        owner_npub: this.workspaceOwnerNpub,
        title: displayName,
        display_name: displayName,
        storage_object_id: prepared.object_id,
        content_storage_object_id: prepared.object_id,
        content: `[${displayName}](storage://${prepared.object_id})`,
        scope_id: scopeId,
        pg_channel_id: channel.record_id,
        pg_thread_id: threadId || null,
        folder_id: folderId || null,
      });
      await upsertDocument(acceptedFile);
      if (typeof this.patchDocumentLocal === 'function') this.patchDocumentLocal(acceptedFile);
      this.patchFileUploadItem(id, {
        status: 'done',
        progress: 100,
        name: displayName,
        scope_id: scopeId,
        folder_id: folderId,
        object_id: prepared.object_id,
      });
      this.notifyFileUploadsSettled();
      this.scheduleStorageImageHydration?.();
      return acceptedFile;
    } catch (error) {
      const detail = error?.message || 'Unknown error.';
      const message = `File upload failed while ${stage}: ${detail}`;
      this.patchFileUploadItem(id, { status: 'failed', progress: 100, error: message });
      this.fileUploadError = message;
      this.error = message;
      this.notifyFileUploadsSettled();
      return null;
    }
  },

  applyFileMessages(messages = []) {
    this.fileMessages = Array.isArray(messages) ? messages : [];
    void this.reconcileDeckThreadMessages?.(this.fileMessages);
  },

  applyFileComments(comments = []) {
    this.fileComments = Array.isArray(comments) ? comments : [];
    this.scheduleTowerPgUnreadProjectionRefresh?.();
  },

  applyFileFolders(folders = []) {
    this.fileFolders = Array.isArray(folders) ? folders : [];
  },

  setFileSelectionMode(enabled) {
    this.fileSelectionMode = Boolean(enabled);
    if (!this.fileSelectionMode) this.clearFileSelection();
  },

  toggleFileSelectionMode() {
    this.setFileSelectionMode(!this.fileSelectionMode);
  },

  clearFileSelection() {
    this.fileSelectedRowIds = [];
  },

  get selectedFileRowIdsSet() {
    return new Set(Array.isArray(this.fileSelectedRowIds) ? this.fileSelectedRowIds : []);
  },

  get selectedFileRows() {
    const selectedIds = this.selectedFileRowIdsSet;
    if (selectedIds.size === 0) return [];
    return this.filteredFileBrowserRows.filter((row) => selectedIds.has(row.id) && this.canMoveFileBrowserRow(row));
  },

  get selectedFileCount() {
    return this.selectedFileRows.length;
  },

  isFileRowSelected(row = {}) {
    return this.selectedFileRowIdsSet.has(row.id);
  },

  toggleFileRowSelection(row = {}, checked = null) {
    if (!this.canMoveFileBrowserRow(row)) return;
    const selectedIds = this.selectedFileRowIdsSet;
    const shouldSelect = checked === null ? !selectedIds.has(row.id) : Boolean(checked);
    if (shouldSelect) selectedIds.add(row.id);
    else selectedIds.delete(row.id);
    this.fileSelectedRowIds = [...selectedIds];
  },

  visibleFileRowsById(rowIds = []) {
    const requested = new Set((Array.isArray(rowIds) ? rowIds : []).map(normalizeString).filter(Boolean));
    if (requested.size === 0) return [];
    return this.filteredFileBrowserRows.filter((row) => requested.has(row.id) && this.canMoveFileBrowserRow(row));
  },

  handleFileRowDragStart(row = {}, event = null) {
    if (!this.canMoveFileBrowserRow(row)) {
      event?.preventDefault?.();
      return;
    }
    if (this.fileSelectionMode && !this.isFileRowSelected(row)) this.toggleFileRowSelection(row, true);
    const rowIds = this.fileSelectionMode && this.isFileRowSelected(row)
      ? this.selectedFileRows.map((selectedRow) => selectedRow.id)
      : [row.id];
    this.fileDraggingRowIds = rowIds;
    const payload = JSON.stringify({ type: 'flightdeck/files', rowIds });
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/json', payload);
      event.dataTransfer.setData('text/plain', payload);
    }
  },

  handleFileRowDragEnd() {
    this.fileDraggingRowIds = [];
    this.fileFolderDragOverId = '';
  },

  fileDragRowIdsFromEvent(event = null) {
    const transfer = event?.dataTransfer;
    const raw = transfer?.getData?.('application/json') || transfer?.getData?.('text/plain') || '';
    try {
      const payload = JSON.parse(raw);
      if (payload?.type === 'flightdeck/files' && Array.isArray(payload.rowIds)) {
        return payload.rowIds.map(normalizeString).filter(Boolean);
      }
    } catch {
      // Ignore external drags and malformed payloads.
    }
    if (Array.isArray(this.fileDraggingRowIds) && this.fileDraggingRowIds.length > 0) return this.fileDraggingRowIds;
    return this.selectedFileRows.map((row) => row.id);
  },

  handleFileFolderDragOver(folder = {}, event = null) {
    const folderId = normalizeString(folder?.record_id);
    if (!folderId) return;
    const rowIds = this.fileDragRowIdsFromEvent(event);
    if (this.visibleFileRowsById(rowIds).length === 0) return;
    event?.preventDefault?.();
    if (event?.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.fileFolderDragOverId = folderId;
  },

  handleFileFolderDragLeave(folder = {}) {
    if (this.fileFolderDragOverId === normalizeString(folder?.record_id)) this.fileFolderDragOverId = '';
  },

  async handleFileFolderDrop(folder = {}, event = null) {
    const folderId = normalizeString(folder?.record_id);
    if (!folderId) return;
    event?.preventDefault?.();
    this.fileFolderDragOverId = '';
    const rows = this.visibleFileRowsById(this.fileDragRowIdsFromEvent(event));
    this.fileDraggingRowIds = [];
    if (rows.length === 0) return;
    await this.moveFileRowsToFolder(rows, folderId);
  },

  async moveFileRowsToFolder(rows = [], folderId = '') {
    const targetFolder = (this.fileFolders || []).find((folder) => folder?.record_id === normalizeString(folderId));
    if (!targetFolder?.record_id) return [];
    const movableRows = rows.filter((row) =>
      this.canMoveFileBrowserRow(row)
      && normalizeString(row.channel_id) === normalizeString(targetFolder.channel_id)
      && normalizeString(row.folder_id) !== normalizeString(targetFolder.record_id)
    );
    if (movableRows.length === 0) return [];
    const results = await Promise.all(movableRows.map((row) => this.moveFileBrowserRowToContext(row, {
      scopeId: targetFolder.scope_id,
      channelId: targetFolder.channel_id,
      folderId: targetFolder.record_id,
      background: true,
    })));
    this.clearFileSelection();
    return results.filter(Boolean);
  },

  get currentFileChannelId() {
    const selectedFolderId = normalizeString(this.fileCurrentFolderId);
    if (selectedFolderId) {
      const folder = (this.fileFolders || []).find((entry) =>
        entry?.record_id === selectedFolderId
        && fileFolderMatchesCurrentContext(entry, this)
      );
      if (folder?.channel_id) return normalizeString(folder.channel_id);
    }
    return normalizeString(this.pgContextSelectedChannelId);
  },

  get currentFileFolderId() {
    const selected = normalizeString(this.fileCurrentFolderId);
    if (selected === '__archived__') return selected;
    if (!selected) return '';
    const folder = (this.fileFolders || []).find((entry) =>
      entry?.record_id === selected
      && fileFolderMatchesCurrentContext(entry, this)
    );
    return folder ? selected : '';
  },

  get currentFileFolder() {
    const selected = this.currentFileFolderId;
    if (!selected) return null;
    return (this.fileFolders || []).find((entry) => entry?.record_id === selected) || null;
  },

  get currentFileFolderBreadcrumbs() {
    const crumbs = [];
    const byId = new Map((this.fileFolders || [])
      .filter((folder) => fileFolderMatchesCurrentContext(folder, this))
      .map((folder) => [folder.record_id, folder]));
    const seen = new Set();
    let cursor = this.currentFileFolderId;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = byId.get(cursor);
      crumbs.unshift(folder);
      cursor = normalizeString(folder.parent_folder_id);
    }
    return crumbs;
  },

  get currentFileChildFolders() {
    const parentId = this.currentFileFolderId;
    if (parentId === '__archived__') return [];
    return (this.fileFolders || [])
      .filter((folder) =>
        fileFolderMatchesCurrentContext(folder, this)
        && normalizeString(folder.parent_folder_id) === parentId
      )
      .sort((left, right) => String(left.title || '').localeCompare(String(right.title || '')));
  },

  fileFolderOptions(scopeId = '', channelId = '') {
    const requestedScopeId = normalizeString(scopeId);
    const requestedChannelId = normalizeString(channelId);
    const options = [{ id: '', label: 'Root' }];
    for (const folder of (this.fileFolders || [])) {
      if (!folder?.record_id || folder.record_state === 'deleted') continue;
      if (requestedScopeId && folder.scope_id !== requestedScopeId) continue;
      if (requestedChannelId && folder.channel_id !== requestedChannelId) continue;
      options.push({
        id: folder.record_id,
        label: this.getFileFolderPathLabel(folder.record_id),
      });
    }
    return options;
  },

  getFileFolderPathLabel(folderId = '') {
    const id = normalizeString(folderId);
    if (!id) return 'Root';
    const byId = new Map((this.fileFolders || []).map((folder) => [folder.record_id, folder]));
    const names = [];
    const seen = new Set();
    let cursor = id;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = byId.get(cursor);
      names.unshift(folder.title || 'Untitled folder');
      cursor = normalizeString(folder.parent_folder_id);
    }
    return names.join(' / ') || 'Folder';
  },

  selectFileFolder(folderId = '') {
    this.fileCurrentFolderId = normalizeString(folderId);
    this.clearFileSelection();
  },

  async createFileFolderFromPrompt() {
    if (!this.isTowerPgMode) return null;
    const channelId = this.currentFileChannelId;
    const channel = (this.channels || []).find((entry) => entry?.record_id === channelId);
    const scopeId = getRecordScopeId(channel);
    if (!scopeId || !channelId) {
      this.error = 'Select a scope and channel before creating a folder.';
      return null;
    }
    const title = typeof window !== 'undefined'
      ? normalizeString(window.prompt('Folder name') || '')
      : '';
    if (!title) return null;
    try {
      const folder = await createTowerPgFileFolderFromLocal(this, {
        title,
        scope_id: scopeId,
        channel_id: channelId,
        parent_folder_id: this.currentFileFolderId || null,
      });
      await upsertFileFolder(folder);
      this.applyFileFolders([
        ...(this.fileFolders || []).filter((entry) => entry?.record_id !== folder.record_id),
        folder,
      ]);
      this.selectFileFolder(folder.record_id);
      return folder;
    } catch (error) {
      this.error = error?.message || 'Failed to create folder.';
      return null;
    }
  },

  get fileBrowserRows() {
    return cachedFileBrowserRows(this);
  },

  get filteredFileBrowserRows() {
    const archivedView = this.currentFileFolderId === '__archived__';
    return filterFileBrowserRows(this.fileBrowserRows.filter((row) => Boolean(row.archived) === archivedView), {
      query: this.fileSearch,
      type: this.fileTypeFilter,
      source: this.fileSourceFilter,
      scopeId: this.isTowerPgMode ? (currentPgFilesScopeId(this) || 'all') : this.fileScopeFilter,
      channelId: this.fileChannelFilter,
      threadId: this.fileThreadFilter,
      folderId: this.isTowerPgMode ? (archivedView ? 'all' : this.currentFileFolderId) : 'all',
      contextChannelId: this.isTowerPgMode ? this.pgContextSelectedChannelId : null,
      contextThreadId: this.isTowerPgMode ? this.pgContextSelectedThreadId : null,
      scopesMap: this.scopesMap,
    });
  },

  get fileScopeOptions() {
    const options = [
      { id: 'all', label: 'All scopes' },
      { id: UNSCOPED_TASK_BOARD_ID, label: 'Unscoped' },
    ];
    for (const option of getScopeBoardOptions(this)) {
      options.push({ id: option.id, label: option.label || option.id });
    }
    return options;
  },

  get fileChannelOptions() {
    return [
      { id: 'all', label: 'All chats' },
      ...(this.channels || [])
        .filter((channel) => channel?.record_state !== 'deleted')
        .map((channel) => ({
          id: channel.record_id,
          label: this.getChannelLabel ? this.getChannelLabel(channel) : (channel.title || 'Chat'),
        })),
    ];
  },

  get fileThreadOptions() {
    return [
      { id: 'all', label: 'All threads' },
      ...(this.pgContextThreads || []).map((thread) => ({
        id: thread.id,
        label: thread.label || `Thread ${String(thread.id || '').slice(0, 8)}`,
      })),
    ];
  },

  getFileKindLabel(row = {}) {
    if (row.kind === 'image') return 'Image';
    if (row.kind === 'audio') return 'Audio';
    if (row.kind === 'document') return 'Document';
    return 'File';
  },

  formatFileSize(sizeBytes) {
    const size = Number(sizeBytes);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  },

  fileUpdatedLabel(row = {}) {
    if (!row.updated_at) return '';
    const date = new Date(row.updated_at);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  },

  async downloadStorageObjectAsFile(objectId, fileName = '', fallbackKind = '', options = {}) {
    const normalizedObjectId = normalizeString(objectId);
    if (!normalizedObjectId || typeof document === 'undefined') return;
    try {
      const blob = options.blob || await downloadStorageObjectBlob(normalizedObjectId, { backendUrl: options.backendUrl });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = this.fileDownloadName({
        object_id: normalizedObjectId,
        name: normalizeString(fileName) || normalizedObjectId,
        kind: normalizeString(fallbackKind) || kindFromContentType(blob.type),
      });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      this.error = error?.message || 'Could not download file.';
    }
  },

  async downloadFileBrowserRow(row = {}) {
    const objectId = normalizeString(row.object_id);
    if (!objectId) return;
    try {
      await this.downloadStorageObjectAsFile(objectId, row.name || objectId, row.kind || 'file', { backendUrl: this.getFilePreviewBackendUrl(row) });
    } catch (error) {
      this.error = error?.message || 'Could not download file.';
    }
  },

  fileDownloadName(row = {}) {
    const rawName = normalizeString(row.name) || normalizeString(row.object_id) || 'file';
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
    if (safeName.includes('.')) return safeName;
    if (row.kind === 'image') return `${safeName}.png`;
    if (row.kind === 'audio') return `${safeName}.webm`;
    if (row.kind === 'document') return `${safeName}.json`;
    return safeName;
  },

  canMoveFileBrowserRow(row = {}) {
    return this.canEditFileBrowserRow(row);
  },

  canEditFileBrowserRow(row = {}) {
    if (!this.isTowerPgMode) return false;
    if (row.source_type !== 'document' || !row.source_record_id) return false;
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    return Boolean(document?.pg_backend && (document.pg_record_type === 'file' || document.pg_storage_object_id));
  },

  async setFileBrowserRowArchived(row = {}, archived = true) {
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    if (!document?.pg_backend) return null;
    try {
      const context = resolveTowerPgWorkspaceContext(this);
      const workspaceId = document.pg_workspace_id || context.workspaceId;
      const baseUrl = context.baseUrl || this.activeWorkspace?.backendUrl;
      const options = { baseUrl, appNpub: context.appNpub };
      const body = { row_version: document.version, archived: Boolean(archived) };
      const result = document.pg_record_type === 'file'
        ? await updateTowerPgFileMetadata(this, workspaceId, document.record_id, body, options)
        : await updateTowerPgDocumentMetadata(this, workspaceId, document.record_id, body, options);
      const source = result.file || result.doc;
      const next = document.pg_record_type === 'file'
        ? mapPgFileToLocalDocument(source, { workspaceOwnerNpub: document.owner_npub })
        : mapPgDocToLocal(source, { workspaceOwnerNpub: document.owner_npub });
      await upsertDocument(next);
      this.applyDocuments([...(this.documents || []).filter((item) => item.record_id !== next.record_id), next]);
      return next;
    } catch (error) {
      this.error = error?.message || `Failed to ${archived ? 'archive' : 'restore'} item.`;
      return null;
    }
  },

  async setDocumentArchived(document = {}, archived = true) {
    return this.setFileBrowserRowArchived({ source_record_id: document.record_id }, archived);
  },

  async archiveDocumentsByIds(recordIds = [], archived = true) {
    const ids = [...new Set((Array.isArray(recordIds) ? recordIds : []).filter(Boolean))];
    const documents = ids
      .map((recordId) => (this.documents || []).find((item) => item?.record_id === recordId))
      .filter((item) => item?.pg_backend && item.pg_record_type !== 'file');
    if (documents.length === 0) return false;
    for (const document of documents) {
      const updated = await this.setDocumentArchived(document, archived);
      if (!updated) return false;
    }
    return true;
  },

  async archiveOpenDocument(document = this.selectedDocument) {
    if (!document?.record_id || this.docArchiveBusy) return false;
    this.docArchiveBusy = true;
    try {
      const archived = await this.archiveDocumentsByIds([document.record_id], true);
      if (!archived) return false;
      if (this.chatDocModalOpen) this.closeChatDocModal();
      else this.closeDocEditor();
      return true;
    } catch (error) {
      this.error = error?.message || 'Failed to archive document.';
      return false;
    } finally {
      this.docArchiveBusy = false;
    }
  },

  canConvertFileBrowserRowToDoc(row = {}) {
    if (!this.canEditFileBrowserRow(row)) return false;
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    return isConvertibleTextFile(row, document);
  },

  openFileMoveModal(row = {}) {
    return this.openFileEditModal(row);
  },

  openFileEditModal(row = {}) {
    if (!this.canEditFileBrowserRow(row)) return null;
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    const scopeId = getRecordScopeId(document) || normalizeString(row.scope_id);
    const channelId = normalizeString(document?.pg_channel_id || row.channel_id);
    const folderId = normalizeString(document?.pg_folder_id || row.folder_id);
    this.fileEditRow = row;
    this.fileEditName = normalizeString(document?.title || document?.display_name || row.name) || 'Untitled file';
    this.fileEditScopeId = scopeId;
    this.fileEditChannelId = channelId;
    this.fileEditFolderId = this.fileFolderOptions(scopeId, channelId).some((folder) => folder.id === folderId) ? folderId : '';
    this.fileEditError = '';
    this.fileEditSubmitting = false;
    this.fileEditAction = '';
    this.fileEditProgressText = '';
    this.showFileEditModal = true;
    return row;
  },

  closeFileEditModal() {
    if (this.fileEditSubmitting) return;
    this.showFileEditModal = false;
    this.fileEditRow = null;
    this.fileEditName = '';
    this.fileEditScopeId = '';
    this.fileEditChannelId = '';
    this.fileEditFolderId = '';
    this.fileEditError = '';
    this.fileEditAction = '';
    this.fileEditProgressText = '';
  },

  selectFileEditScope(scopeId) {
    const nextScopeId = normalizeString(scopeId);
    this.fileEditScopeId = nextScopeId;
    const selectedStillValid = this.fileEditChannelId
      && this.fileUploadChannelOptions(nextScopeId).some((channel) => channel.id === this.fileEditChannelId);
    if (!selectedStillValid) this.fileEditChannelId = this.fileUploadChannelOptions(nextScopeId)[0]?.id || '';
    this.fileEditFolderId = '';
  },

  selectFileEditChannel(channelId) {
    this.fileEditChannelId = normalizeString(channelId);
    this.fileEditFolderId = '';
  },

  get fileEditContextChanged() {
    if (!this.fileEditRow) return false;
    const row = this.fileEditRow;
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    const currentScopeId = getRecordScopeId(document) || normalizeString(row.scope_id);
    const currentChannelId = normalizeString(document?.pg_channel_id || row.channel_id);
    const currentFolderId = normalizeString(document?.pg_folder_id || row.folder_id);
    return Boolean(
      normalizeString(this.fileEditScopeId) !== currentScopeId
      || normalizeString(this.fileEditChannelId) !== currentChannelId
      || normalizeString(this.fileEditFolderId) !== currentFolderId
    );
  },

  async saveFileEditModal() {
    if (this.fileEditSubmitting) return null;
    const row = this.fileEditRow || {};
    const name = normalizeString(this.fileEditName);
    const scopeId = normalizeString(this.fileEditScopeId);
    const channelId = normalizeString(this.fileEditChannelId);
    const folderId = normalizeString(this.fileEditFolderId);
    if (!name) {
      this.fileEditError = 'Enter a file name.';
      return null;
    }
    if (!scopeId || !channelId) {
      this.fileEditError = 'Select a scope and channel.';
      return null;
    }
    this.fileEditSubmitting = true;
    this.fileEditAction = 'save';
    this.fileEditProgressText = 'Saving file details...';
    this.fileEditError = '';
    try {
      const accepted = await this.updateFileBrowserRow(row, {
        name,
        scopeId,
        channelId,
        folderId,
        background: true,
      });
      this.showFileEditModal = false;
      this.fileEditRow = null;
      this.fileEditName = '';
      this.fileEditScopeId = '';
      this.fileEditChannelId = '';
      this.fileEditFolderId = '';
      this.fileEditAction = '';
      this.fileEditProgressText = '';
      return accepted;
    } catch (error) {
      this.fileEditError = error?.message || 'Failed to save file.';
      return null;
    } finally {
      this.fileEditSubmitting = false;
      if (this.fileEditAction === 'save') {
        this.fileEditAction = '';
        this.fileEditProgressText = '';
      }
    }
  },

  async convertFileEditRowToDocument() {
    if (this.fileEditSubmitting) return null;
    const row = this.fileEditRow || {};
    if (!this.canConvertFileBrowserRowToDoc(row)) {
      this.fileEditError = 'Only .txt and .md files can be converted to Wingman Docs.';
      return null;
    }
    const sourceDocument = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    const objectId = normalizeString(row.object_id || sourceDocument?.pg_storage_object_id);
    if (!objectId) {
      this.fileEditError = 'This file is missing a storage object.';
      return null;
    }
    const title = normalizeString(this.fileEditName || sourceDocument?.title || row.name)
      .replace(/\.(txt|md|markdown)$/i, '')
      || 'Converted document';
    const scopeId = normalizeString(this.fileEditScopeId || getRecordScopeId(sourceDocument) || row.scope_id);
    const channelId = normalizeString(this.fileEditChannelId || sourceDocument?.pg_channel_id || row.channel_id);
    if (!scopeId || !channelId) {
      this.fileEditError = 'Select a scope and channel before converting this file.';
      return null;
    }

    this.fileEditSubmitting = true;
    this.fileEditAction = 'convert';
    this.fileEditProgressText = 'Downloading text file...';
    this.fileEditError = '';
    try {
      const bytes = await downloadStorageObject(objectId);
      this.fileEditProgressText = 'Preparing document body...';
      const initialContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      this.fileEditProgressText = 'Creating Wingman Doc...';
      const created = await this.createDocument?.(title, {
        scopeId,
        channelId,
        threadId: normalizeString(sourceDocument?.pg_thread_id || row.thread_id) || null,
        initialContent,
      });
      if (!created?.record_id) throw new Error('Document conversion did not create a document.');
      this.showFileEditModal = false;
      this.fileEditRow = null;
      this.fileEditName = '';
      this.fileEditScopeId = '';
      this.fileEditChannelId = '';
      this.fileEditFolderId = '';
      this.fileEditProgressText = 'Opening document editor...';
      this.navigateTo?.('docs');
      this.openDoc?.(created.record_id);
      await this.enterSelectedDocEditMode?.('rich');
      return created;
    } catch (error) {
      this.fileEditError = error?.message || 'Failed to convert file to document.';
      this.error = this.fileEditError;
      return null;
    } finally {
      this.fileEditSubmitting = false;
      if (this.fileEditAction === 'convert') {
        this.fileEditAction = '';
        this.fileEditProgressText = '';
      }
    }
  },

  async moveFileBrowserRowToContext(row = {}, options = {}) {
    return this.updateFileBrowserRow(row, {
      name: row.name,
      scopeId: options.scopeId,
      channelId: options.channelId,
      folderId: options.folderId,
      background: options.background,
    });
  },

  async updateFileBrowserRow(row = {}, options = {}) {
    if (!this.canEditFileBrowserRow(row)) return null;
    const document = (this.documents || []).find((item) => item?.record_id === row.source_record_id) || null;
    const channel = this.resolveFileUploadChannel(options.scopeId, options.channelId);
    if (!document || !channel?.record_id) {
      this.error = 'Select a scope with a channel before saving this file.';
      return null;
    }
    const scopeId = getRecordScopeId(channel);
    const displayName = normalizeString(options.name) || document.title || row.name || 'Untitled file';
    const folderId = this.fileFolderOptions(scopeId, channel.record_id).some((folder) => folder.id === normalizeString(options.folderId))
      ? normalizeString(options.folderId)
      : '';
    const currentChannelId = normalizeString(document.pg_channel_id || row.channel_id);
    const nextThreadId = currentChannelId && currentChannelId === channel.record_id
      ? normalizeString(document.pg_thread_id || row.thread_id)
      : null;
    const storageObjectId = normalizeString(document.pg_storage_object_id || document.content_storage_object_id || row.object_id);
    const previous = { ...document };
    const updated = {
      ...document,
      ...this.buildScopeAssignment(scopeId),
      title: displayName,
      display_name: displayName,
      content: storageObjectId ? `[${displayName}](storage://${storageObjectId})` : document.content,
      pg_channel_id: channel.record_id,
      pg_thread_id: nextThreadId || null,
      pg_folder_id: folderId || null,
      folder_id: folderId || null,
      thread_id: nextThreadId || null,
      sync_status: 'pending',
      updated_at: new Date().toISOString(),
    };
    await upsertDocument(updated);
    this.patchDocumentLocal?.(updated);
    if (options.background) {
      void this.confirmFileBrowserRowUpdate(updated, previous);
      return updated;
    }
    return this.confirmFileBrowserRowUpdate(updated, previous);
  },

  async confirmFileBrowserRowUpdate(updated, previous) {
    try {
      const accepted = await updateTowerPgFileFromLocal(this, updated, previous);
      await upsertDocument(accepted);
      return accepted;
    } catch (error) {
      const failed = { ...updated, sync_status: 'failed', updated_at: new Date().toISOString() };
      await upsertDocument(failed);
      this.patchDocumentLocal?.(failed);
      this.error = error?.message || 'Failed to save file.';
      throw error;
    }
  },

  trapFilePreviewFocus(event) {
    const controls = [...event.currentTarget.querySelectorAll('button:not([disabled])')].filter((button) => button.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  },

  getFilePreviewBackendUrl(row = {}) {
    const source = (this.documents || []).find((doc) => doc.record_id === row.source_record_id);
    const explicit = normalizeString(row.backend_url || row.pg_backend_url || source?.pg_backend_url);
    if (explicit) return explicit;
    const workspaceId = normalizeString(row.workspace_id || row.pg_workspace_id || source?.pg_workspace_id);
    const current = this.currentWorkspace;
    const matches = (this.knownWorkspaces || []).filter((entry) => entry.workspaceId === workspaceId);
    if (workspaceId && current?.workspaceId !== workspaceId && matches.length > 1) {
      throw new Error('File workspace backend is ambiguous. Select its workspace and try again.');
    }
    const workspace = !workspaceId || current?.workspaceId === workspaceId ? current : matches[0];
    if (workspaceId && !workspace) throw new Error('File workspace is unavailable. Select its workspace and try again.');
    const backendUrl = this.getWorkspaceStorageBackendUrl?.(workspace)
      || workspace?.directHttpsUrl || workspace?.backendUrl
      || ((!workspaceId || workspace === current) ? this.currentWorkspaceBackendUrl || this.backendUrl : '');
    if (!backendUrl) throw new Error('File storage backend is unavailable.');
    return backendUrl;
  },

  async openFilePreview(row = {}, trigger = null) {
    const objectId = normalizeString(row.object_id || row.pg_storage_object_id);
    this.closeChatImagePreview({ restoreFocus: false });
    const requestId = Number(this.filePreviewRequestId || 0) + 1;
    this.filePreviewRequestId = requestId;
    const filename = row.name || row.title || objectId || 'File';
    this.chatImagePreviewReturnFocus = trigger || (typeof document !== 'undefined' ? document.activeElement : null);
    this.chatImagePreviewModal = { open: true, src: '', alt: filename, filename, objectId, loading: true, error: '', kind: row.kind || kindFromContentType(row.content_type || row.content_storage_content_type), backendUrl: '', downloading: false };
    this.focusChatImagePreviewClose?.();
    try {
      if (!objectId) throw new Error('This file has no storage object.');
      const backendUrl = this.getFilePreviewBackendUrl(row);
      this.chatImagePreviewModal.backendUrl = backendUrl;
      const blob = await downloadStorageObjectBlob(objectId, { backendUrl });
      if (this.filePreviewRequestId !== requestId || !this.chatImagePreviewModal.open) return;
      if (!(blob instanceof Blob) || !blob.size) throw new Error('No file data returned.');
      const kind = blob.type.startsWith('image/') ? 'image' : this.chatImagePreviewModal.kind;
      const src = kind === 'image' ? URL.createObjectURL(blob) : '';
      this.filePreviewBlob = blob;
      this.chatImagePreviewModal = { ...this.chatImagePreviewModal, src, kind, ownedUrl: Boolean(src), loading: false };
    } catch (error) {
      if (this.filePreviewRequestId === requestId && this.chatImagePreviewModal.open) {
        this.chatImagePreviewModal = { ...this.chatImagePreviewModal, loading: false, error: error?.message || 'Could not load file.' };
      }
    }
  },

  async saveFilePreviewLocally() {
    const preview = this.chatImagePreviewModal;
    if (!preview?.objectId || preview.loading || preview.downloading) return;
    const requestId = this.filePreviewRequestId;
    preview.downloading = true;
    try {
      await this.downloadStorageObjectAsFile(preview.objectId, preview.filename, preview.kind, {
        backendUrl: preview.backendUrl, blob: this.filePreviewBlob, throwOnError: true,
      });
    } catch (error) {
      if (this.filePreviewRequestId === requestId) preview.error = error?.message || 'Could not save file locally.';
    } finally {
      if (this.filePreviewRequestId === requestId) preview.downloading = false;
    }
  },

  async openFileBrowserSource(row = {}) {
    const sourceType = normalizeString(row.source_target_type || row.source_type);
    const sourceRecordId = row.source_target_record_id || row.source_record_id;
    const source = (this.documents || []).find((doc) => doc.record_id === sourceRecordId);
    if (source?.pg_record_type === 'file' || source?.pg_storage_object_id) {
      return this.openFilePreview({ ...source, ...row, object_id: row.object_id || source.pg_storage_object_id });
    }
    if (sourceType === 'document' && sourceRecordId) {
      this.navigateTo('docs');
      this.openDoc(sourceRecordId);
      return;
    }
    if (sourceType === 'task' && sourceRecordId) {
      this.navigateTo('tasks');
      this.openTaskDetail(sourceRecordId);
      return;
    }
    if (sourceType === 'chat') {
      this.navigateTo('chat');
      if (row.channel_id) {
        await this.selectChannel?.(row.channel_id, { syncRoute: false, scrollToLatest: false });
      }
      const threadId = row.thread_id || sourceRecordId;
      if (threadId) this.openThread?.(threadId, { scrollToLatest: false, syncRoute: false });
      this.syncRoute?.();
      return;
    }
    if (row.source_type === 'comment') {
      this.navigateTo('docs');
      return;
    }
    if (row.source_type === 'audio') {
      if (row.channel_id) {
        this.navigateTo('chat');
        if (this.isTowerPgMode) this.selectPgChannelContext?.(row.channel_id);
        else this.selectChannel(row.channel_id);
      }
      return;
    }
    this.navigateTo('files');
  },
};

Object.defineProperties(filesManagerMixin, Object.getOwnPropertyDescriptors(fileBlossomMixin));
