// Text attachment modal: edit a draft before sending, or read/edit/save versions
// of a sent attachment. Content is paged (text-pages.js) so a multi-megabyte
// file never lands in one DOM node; sent originals are pinned and every later
// edit is a Files version tied to the message by a lineage record.
import {
  completeStorageObject,
  createTowerPgChannelFile,
  createTowerPgFileVersion,
  downloadStorageObjectBlob,
  getTowerPgChannelFiles,
  getStorageObject,
  getTowerPgFileVersionObjectBytes,
  getTowerPgFileVersions,
  uploadStorageObject,
  updateTowerPgFile,
} from './api.js';
import { getWorkspaceDb, getTextAttachmentCache, putTextAttachmentCache } from './db.js';
import { buildStoragePrepareBody } from './storage-payloads.js';
import { persistTextDraft } from './text-attachment-drafts.js';
import {
  TEXT_ATTACHMENT_CONTENT_TYPE,
  codePointLength,
  formatByteSize,
  lineCount,
  normalizeTextAttachmentName,
  textAttachmentMarker,
  textToAttachmentFile,
  firstLinePreview,
  isTextAttachment,
  utf8ByteLength,
} from './text-attachments.js';
import { applyPageEdit, normalizeForTextarea, paginateText, TEXT_PAGE_CHARS } from './text-pages.js';

export const TEXT_ATTACHMENT_MAX_EDIT_BYTES = 8 * 1024 * 1024;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeTextBytes(bytes) {
  try { return decoder.decode(bytes); } catch { return null; }
}

function closedModal() {
  return {
    open: false, mode: 'draft', status: 'idle', error: '', filename: '', originalFilename: '', pages: [], pageIndex: 0,
    pageValue: '', editing: false, dirty: false, saving: false, saveState: '', canEdit: false,
    versions: [], viewing: 'latest', conflict: null, readOnlyReason: '',
    totals: { bytes: 0, chars: 0, lines: 0 }, source: null, draftId: '', context: 'message', token: 0,
  };
}

function totalsOf(pages) {
  const text = pages.join('');
  return { bytes: utf8ByteLength(text), chars: codePointLength(text), lines: lineCount(text) };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const textAttachmentViewerMixin = {
  textAttachmentModal: closedModal(),

  // ---- shared page handling -------------------------------------------------
  textModalCommitPage() {
    const modal = this.textAttachmentModal;
    if (!modal.editing || modal.status !== 'ready') return;
    const original = modal.pages[modal.pageIndex] ?? '';
    const next = applyPageEdit(original, modal.pageValue);
    if (next === original) return;
    const pages = [...modal.pages];
    pages[modal.pageIndex] = next;
    this.textAttachmentModal = { ...modal, pages, dirty: true, totals: totalsOf(pages), saveState: '' };
  },

  // Keystrokes only flag the edit; the page is folded in (and totals recounted)
  // on page change, save, copy or download so typing stays O(page), not O(file).
  textModalMarkDirty() {
    const modal = this.textAttachmentModal;
    if (!modal.dirty || modal.saveState) this.textAttachmentModal = { ...modal, dirty: true, saveState: '' };
    if (modal.mode === 'sent') {
      clearTimeout(this._textEditTimer);
      this._textEditTimer = setTimeout(() => { void this.persistSentTextEdit().catch(() => {}); }, 400);
    }
  },

  persistSentTextEdit({ discard = false } = {}) {
    clearTimeout(this._textEditTimer);
    const modal = this.textAttachmentModal;
    if (modal.mode !== 'sent' || !modal.editing || modal.saving || !modal.workspace) return Promise.resolve();
    const { message, attachment, lineage } = modal.source;
    const workspace = modal.workspace;
    const key = `${workspace.namespace}|edit:${message.record_id}:${attachment.storage_object_id}`;
    const pages = [...modal.pages];
    pages[modal.pageIndex] = applyPageEdit(pages[modal.pageIndex], modal.pageValue);
    const text = pages.join('');
    const filename = normalizeTextAttachmentName(modal.filename);
    const existing = modal.command;
    const command = !discard && existing && existing.filename === filename && decodeTextBytes(existing.bytes) === text ? existing : { bytes: new TextEncoder().encode(text), filename: normalizeTextAttachmentName(modal.filename), message, attachment, workspace_id: workspace.workspaceId, backend: workspace.options.baseUrl, lineage, baseVersionId: lineage?.current_version_id, mutationId: crypto.randomUUID(), done: discard };
    // Serialize autosaves and close/cancel writes in invocation order.
    const write = (this._textEditWrite || Promise.resolve()).catch(() => {}).then(() => putTextAttachmentCache({ key, workspace_id: workspace.workspaceId, command }, workspace.database()));
    this._textEditWrite = write;
    const token = modal.token;
    return write.then(() => {
      if (this.textAttachmentModal.token === token && !this.textAttachmentModal.saving) this.textAttachmentModal = { ...this.textAttachmentModal, command, saveState: discard ? '' : 'Saved locally' };
    }).catch((error) => {
      this.error = 'Could not save your text locally. Keep the editor open and retry Save: ' + (error?.message || 'Local storage unavailable');
      if (this.textAttachmentModal.token === token) this.textAttachmentModal = { ...this.textAttachmentModal, error: this.error, saveState: 'Local save failed' };
      throw error;
    });
  },

  textModalPaste(event) {
    const modal = this.textAttachmentModal;
    if (!modal.editing) return;
    const pasted = event.clipboardData?.getData('text/plain');
    if (pasted == null) return;
    const el = event.currentTarget;
    if (el.value.length + pasted.length <= TEXT_PAGE_CHARS) return;
    event.preventDefault();
    const next = el.value.slice(0, el.selectionStart) + normalizeForTextarea(pasted) + el.value.slice(el.selectionEnd);
    const replacement = paginateText(applyPageEdit(modal.pages[modal.pageIndex], next));
    const pages = [...modal.pages.slice(0, modal.pageIndex), ...replacement, ...modal.pages.slice(modal.pageIndex + 1)];
    this.textAttachmentModal = { ...modal, pages, pageValue: normalizeForTextarea(pages[modal.pageIndex]), dirty: true, totals: totalsOf(pages), saveState: '' };
    this.textModalMarkDirty();
  },

  textModalLoadPage(index) {
    const modal = this.textAttachmentModal;
    const clamped = Math.max(0, Math.min(modal.pages.length - 1, index));
    this.textAttachmentModal = { ...modal, pageIndex: clamped, pageValue: normalizeForTextarea(modal.pages[clamped] ?? '') };
  },

  textModalGoToPage(index) {
    this.textModalCommitPage();
    this.textModalLoadPage(index);
  },

  textModalFullText() {
    this.textModalCommitPage();
    return this.textAttachmentModal.pages.join('');
  },

  textModalSetContent(text, extra = {}) {
    const pages = paginateText(text);
    this.textAttachmentModal = {
      ...this.textAttachmentModal,
      pages, pageIndex: 0, pageValue: normalizeForTextarea(pages[0] ?? ''), status: 'ready', error: '',
      dirty: false, totals: totalsOf(pages), ...extra,
    };
  },

  textModalFooter() {
    const { totals, mode, saving, saveState, dirty } = this.textAttachmentModal;
    const draft = mode === 'draft' ? this.getChatFileDrafts(this.textAttachmentModal.context).find(item => item.draft_id === this.textAttachmentModal.draftId) : null;
    const state = draft?.local_persistence_error ? 'Local save failed — retry Save' : draft?.local_persistence_state === 'saving' ? 'Saving locally…' : saving ? 'Saving…' : saveState || (dirty ? 'Unsaved changes' : (mode === 'draft' ? 'Saved locally' : ''));
    return [`${totals.lines.toLocaleString()} lines`, formatByteSize(totals.bytes), state].filter(Boolean).join(' · ');
  },

  async closeTextAttachmentModal() {
    const token = this.textAttachmentModal.token;
    if (this.textAttachmentModal.localSavePending) return;
    if (this.textAttachmentModal.mode === 'sent' && this.textAttachmentModal.dirty && !this.textAttachmentModal.saving) {
      try { await this.persistSentTextEdit(); } catch { return; }
    }
    if (this.textAttachmentModal.token !== token) return;
    this.textAttachmentModal = { ...closedModal(), token: this.textAttachmentModal.token + 1 };
  },

  // ---- draft attachments ----------------------------------------------------
  async openTextAttachmentDraft(draftId, context = 'message') {
    const draft = this.getChatFileDrafts(context).find((item) => item.draft_id === draftId);
    if (!draft?.file) return;
    const token = this.textAttachmentModal.token + 1;
    this.textAttachmentModal = {
      ...closedModal(), open: true, mode: 'draft', status: 'loading', editing: true, canEdit: true,
      filename: draft.filename, originalFilename: draft.filename, draftId, context, token,
    };
    const text = decodeTextBytes(new Uint8Array(await draft.file.arrayBuffer()));
    if (this.textAttachmentModal.token !== token) return;
    if (text === null) {
      this.textAttachmentModal = { ...this.textAttachmentModal, status: 'error', error: 'This file is not valid UTF-8 text and cannot be edited here.' };
      return;
    }
    this.textModalSetContent(text, { saveState: draft.status === 'ready' ? 'Uploaded' : (draft.status === 'uploading' ? 'Uploading…' : 'Saved locally') });
  },

  async saveTextAttachmentDraft() {
    const modal = this.textAttachmentModal;
    if (modal.mode !== 'draft' || modal.status !== 'ready') return;
    const text = this.textModalFullText();
    const filename = normalizeTextAttachmentName(modal.filename);
    const { draftId, context } = modal;
    const draft = this.getChatFileDrafts(context).find((item) => item.draft_id === draftId);
    if (!draft) { this.closeTextAttachmentModal(); return; }
    const unchanged = !this.textAttachmentModal.dirty && filename === draft.filename;
    if (!unchanged) {
      if (this.textPasteUndo?.[context]) this.textPasteUndo = { ...this.textPasteUndo, [context]: this.textPasteUndo[context].filter(entry => entry.draft_id !== draftId) };
      const file = textToAttachmentFile(text, filename);
      const marker = textAttachmentMarker({ source: draft.text_attachment?.source || 'paste', text });
      const patch = {
        file, filename, size_bytes: file.size, text_attachment: marker, preview_line: firstLinePreview(text), status: 'uploading', error: '',
        // New bytes need a new storage object; the old one is orphaned, never mutated.
        storage_upload: undefined, storage_object_id: undefined, sha256_hex: '', upload_inflight: false,
      };
      this._chatUploadControllers?.get(draftId)?.abort();
      this.setChatFileDrafts(context, this.getChatFileDrafts(context).map((item) => (item.draft_id === draftId ? { ...item, ...patch } : item)));
      this.textAttachmentModal = { ...this.textAttachmentModal, localSavePending: true };
      const durable = await persistTextDraft(this, context, { ...draft, ...patch });
      this.textAttachmentModal = { ...this.textAttachmentModal, localSavePending: false };
      if (!durable) { this.textAttachmentModal = { ...this.textAttachmentModal, error: this.error || 'Local save failed. Retry Save.', dirty: true }; return; }
      void this.uploadChatFileDraft(draftId, context);
    }
    this.closeTextAttachmentModal();
  },

  // ---- sent attachments -----------------------------------------------------
  textAttachmentWorkspaceOptions() {
    const ctx = this.captureStorageUploadContext();
    const db = getWorkspaceDb();
    return { database: () => db, ctx, workspaceId: ctx.workspaceId, options: ctx.options, namespace: `${ctx.options?.baseUrl || ''}|${ctx.workspaceId}` };
  },

  async textAttachmentCachedBytes(key, fetchBytes) {
    const workspace = this.textAttachmentModal.workspace || this.textAttachmentWorkspaceOptions();
    key = `${workspace.namespace}|${key}`;
    try {
      const hit = await getTextAttachmentCache(key, workspace.database());
      if (hit?.bytes) return new Uint8Array(hit.bytes);
    } catch { /* cache is optional */ }
    const bytes = new Uint8Array(await fetchBytes());
    try { await putTextAttachmentCache({ key, workspace_id: workspace.workspaceId, bytes }, workspace.database()); } catch { /* optional */ }
    return bytes;
  },

  async findTextAttachmentLineage(message, attachment, { workspaceId, options }) {
    const query = { ...options, origin_message_id: message.record_id, origin_storage_object_id: attachment.storage_object_id };
    const matches = (file) => {
      const lineage = file?.metadata?.text_attachment_lineage;
      return lineage?.origin_message_id === message.record_id && lineage?.origin_storage_object_id === attachment.storage_object_id && !file.deleted_at;
    };
    const payload = await getTowerPgChannelFiles(workspaceId, message.channel_id, query);
    const active = (payload?.files || []).find(matches);
    if (active) return active;
    const archived = await getTowerPgChannelFiles(workspaceId, message.channel_id, { ...query, archived: true });
    return (archived?.files || []).find(matches) || null;
  },

  async openSentTextAttachment(message, attachment) {
    const workspace = this.textAttachmentWorkspaceOptions();
    const token = this.textAttachmentModal.token + 1;
    const filename = attachment.filename || 'Text attachment';
    this.textAttachmentModal = {
      ...closedModal(), open: true, mode: 'sent', status: 'loading', filename, originalFilename: filename,
      source: { message, attachment, lineage: null }, token, workspace,
      canEdit: Boolean(this.canComposeInChatDestination),
    };
    const { workspaceId, options } = workspace;
    // Render cached original without waiting for remote lineage/history.
    const cached = await getTextAttachmentCache(`${workspace.namespace}|object:${attachment.storage_object_id}`, workspace.database()).catch(() => null);
    if (this.textAttachmentModal.token !== token) return;
    if (cached?.bytes) {
      const text = decodeTextBytes(cached.bytes);
      if (text !== null) this.textModalSetContent(text, { viewing: 'original', saveState: 'Offline copy' });
    }
    if (!cached?.bytes) void this.viewTextAttachmentVersion('original');
    const commandKey = `${workspace.namespace}|edit:${message.record_id}:${attachment.storage_object_id}`;
    const pending = await getTextAttachmentCache(commandKey, workspace.database()).catch(() => null);
    if (this.textAttachmentModal.token !== token) return;
    if (pending?.command && !pending.command.done) {
      const command = pending.command;
      this._textVersionRequest = (this._textVersionRequest || 0) + 1;
      this.textModalSetContent(decodeTextBytes(command.bytes) || '', { editing: true, dirty: true, filename: command.filename, command, saveState: 'Saved locally — retry Save', source: { message, attachment, lineage: command.lineage } });
      return;
    }
    const manifestKey = `${workspace.namespace}|history:${message.record_id}:${attachment.storage_object_id}`;
    const manifest = await getTextAttachmentCache(manifestKey, workspace.database()).catch(() => null);
    if (this.textAttachmentModal.token !== token) return;
    if (manifest?.lineage) {
      this.textAttachmentModal = { ...this.textAttachmentModal, source: { message, attachment, lineage: manifest.lineage }, versions: manifest.entries, filename: manifest.lineage.display_name || filename };
      // This cache lookup never waits for the network.
      const latest = await getTextAttachmentCache(`${workspace.namespace}|version:${manifest.lineage.current_version_id}`, workspace.database()).catch(() => null);
      if (this.textAttachmentModal.token !== token) return;
      if (latest?.bytes) this.textModalSetContent(decodeTextBytes(latest.bytes) || '', { viewing: manifest.lineage.current_version_id, saveState: 'Offline copy' });
    }
    let lineage = manifest?.lineage || null;
    let versions = manifest?.versions || [];
    let online = true;
    try {
      lineage = await this.findTextAttachmentLineage(message, attachment, { workspaceId, options });
      if (lineage) versions = (await getTowerPgFileVersions(workspaceId, lineage.id, options))?.versions || [];
    } catch { online = false; }
    if (this.textAttachmentModal.token !== token || this.textAttachmentModal.editing) return;
    const originalEntry = { id: 'original', label: 'Original (sent)', object_id: attachment.storage_object_id, size_bytes: attachment.size_bytes };
    const entries = [...[...versions].sort((a, b) => (b.version_number || 0) - (a.version_number || 0)).map((version) => ({
      id: version.id, label: `Version ${version.version_number}${version.id === lineage?.current_version_id ? ' (latest)' : ''}`,
      version_number: version.version_number, created_at: version.created_at, size_bytes: version.size_bytes,
    })), originalEntry];
    await putTextAttachmentCache({ key: manifestKey, workspace_id: workspaceId, lineage, versions, entries }, workspace.database()).catch(() => {});
    if (this.textAttachmentModal.token !== token) return;
    this.textAttachmentModal = { ...this.textAttachmentModal, versions: entries, filename: lineage?.display_name || filename, source: { message, attachment, lineage } };
    const target = lineage?.current_version_id || 'original';
    await this.viewTextAttachmentVersion(target, { offline: !online });
  },

  async viewTextAttachmentVersion(versionId, { offline = false } = {}) {
    const token = this.textAttachmentModal.token;
    const request = (this._textVersionRequest || 0) + 1;
    this._textVersionRequest = request;
    const { attachment, lineage } = this.textAttachmentModal.source || {};
    if (!attachment) return;
    this.textModalCommitPage();
    this.textAttachmentModal = { ...this.textAttachmentModal, status: 'loading', viewing: versionId, editing: false, error: '', conflict: null };
    const { workspaceId, options } = this.textAttachmentModal.workspace || this.textAttachmentWorkspaceOptions();
    try {
      const bytes = versionId === 'original'
        ? await this.textAttachmentCachedBytes(`object:${attachment.storage_object_id}`, async () => (await downloadStorageObjectBlob(attachment.storage_object_id, options)).arrayBuffer())
        : await this.textAttachmentCachedBytes(`version:${versionId}`, async () => (await getTowerPgFileVersionObjectBytes(workspaceId, lineage.id, versionId, options)).bytes);
      if (this.textAttachmentModal.token !== token || this._textVersionRequest !== request) return;
      const text = decodeTextBytes(bytes);
      if (text === null) {
        this.textAttachmentModal = { ...this.textAttachmentModal, status: 'error', error: 'This file is not valid UTF-8 text. Download it instead.', readOnlyReason: 'binary' };
        return;
      }
      this.textModalSetContent(text, {
        viewing: versionId,
        saveState: offline ? 'Offline copy' : '',
        readOnlyReason: bytes.byteLength > TEXT_ATTACHMENT_MAX_EDIT_BYTES ? 'too-large' : '',
      });
    } catch (error) {
      if (this.textAttachmentModal.token !== token || this._textVersionRequest !== request) return;
      this.textAttachmentModal = { ...this.textAttachmentModal, status: 'error', error: error?.message || 'Could not load this text file.' };
    }
  },

  textAttachmentIsLatest() {
    const { viewing, source } = this.textAttachmentModal;
    const lineage = source?.lineage;
    return lineage ? viewing === lineage.current_version_id : viewing === 'original';
  },

  startTextAttachmentEdit() {
    const modal = this.textAttachmentModal;
    if (!modal.canEdit || modal.readOnlyReason || modal.status !== 'ready' || !this.textAttachmentIsLatest()) return;
    this.textAttachmentModal = { ...modal, editing: true, saveState: '' };
  },

  cancelTextAttachmentEdit() {
    const modal = this.textAttachmentModal;
    if (modal.mode === 'draft') { this.closeTextAttachmentModal(); return; }
    void this.persistSentTextEdit({ discard: true }).then(() => this.viewTextAttachmentVersion(modal.viewing)).catch(() => {});
  },

  async copyTextAttachmentModal() {
    const text = this.textModalFullText();
    try { await navigator.clipboard.writeText(text); this.textAttachmentModal = { ...this.textAttachmentModal, saveState: 'Copied' }; }
    catch { this.textAttachmentModal = { ...this.textAttachmentModal, saveState: 'Copy failed' }; }
  },

  downloadTextAttachmentModal() {
    const text = this.textModalFullText();
    const blob = new Blob([text], { type: TEXT_ATTACHMENT_CONTENT_TYPE });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = normalizeTextAttachmentName(this.textAttachmentModal.filename);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  async uploadTextAttachmentBytes(bytes, filename, { ctx, options }, command, persist) {
    const ownerNpub = String(this.workspaceOwnerNpub || this.session?.npub || '').trim();
    if (!ownerNpub) throw new Error('Missing storage owner for attachment.');
    const digest = await sha256Hex(bytes);
    const prepared = command?.prepared || await this.prepareStorageObjectForCurrentWorkspace(buildStoragePrepareBody({
      ownerNpub, accessGroupIds: [], contentType: TEXT_ATTACHMENT_CONTENT_TYPE, sizeBytes: bytes.byteLength, fileName: filename,
    }), ctx);
    if (command && !command.prepared) { command.prepared = prepared; await persist(); }
    if (command?.completionAttempted) {
      const accepted = await getStorageObject(prepared.object_id, options);
      if (accepted.completed_at) {
        if (accepted.object_id !== prepared.object_id || Number(accepted.size_bytes) !== bytes.byteLength || accepted.sha256_hex !== digest) throw new Error('Stored text does not match the local edit.');
        return { objectId: prepared.object_id, sha256: digest };
      }
    }
    if (!command?.transferred) {
      await uploadStorageObject(prepared, bytes, TEXT_ATTACHMENT_CONTENT_TYPE, options);
      if (command) { command.transferred = true; await persist(); }
    }
    if (command) { command.completionAttempted = true; await persist(); }
    await completeStorageObject(prepared.object_id, { size_bytes: bytes.byteLength, sha256_hex: digest }, options);
    return { objectId: prepared.object_id, sha256: digest };
  },

  // Saves the edited text as a new immutable version. The first save creates
  // the lineage file; Tower serializes creators, so a loser gets a conflict.
  async saveSentTextAttachment({ resolution = null } = {}) {
    const modal = this.textAttachmentModal;
    if (modal.mode !== 'sent' || modal.status !== 'ready' || modal.saving) return;
    const text = resolution?.text ?? this.textModalFullText();
    const { message, attachment } = modal.source;
    const filename = normalizeTextAttachmentName(modal.filename, attachment.filename);
    const token = modal.token;
    this.textAttachmentModal = { ...this.textAttachmentModal, saving: true, localSavePending: true, saveState: '', error: '' };
    const workspace = modal.workspace || this.textAttachmentWorkspaceOptions();
    const { workspaceId, options } = workspace;
    const commandKey = `${workspace.namespace}|edit:${message.record_id}:${attachment.storage_object_id}`;
    let command = modal.command;
    const bytes = new TextEncoder().encode(text);
    if (!command || resolution || command.filename !== filename || decodeTextBytes(command.bytes) !== text) {
      command = { bytes, filename, message, attachment, workspace_id: workspaceId, backend: options.baseUrl, lineage: resolution?.lineage || modal.source.lineage, baseVersionId: resolution?.baseVersionId || modal.source.lineage?.current_version_id, mutationId: crypto.randomUUID(), upload: resolution?.upload || null };
    }
    const persist = () => putTextAttachmentCache({ key: commandKey, workspace_id: workspaceId, command }, workspace.database());
    try {
      clearTimeout(this._textEditTimer);
      await this._textEditWrite;
      await persist(); // Exact bytes and stable retry identities must be durable before network.
      if (this.textAttachmentModal.token === token) this.textAttachmentModal = { ...this.textAttachmentModal, command, localSavePending: false };
      let upload = command.upload;
      if (!upload) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > TEXT_ATTACHMENT_MAX_EDIT_BYTES) throw new Error('This text is too large to save as a version.');
        upload = await this.uploadTextAttachmentBytes(bytes, filename, workspace, command, persist);
        command.upload = upload;
        await persist();
      }
      const mutationId = command.mutationId;
      let lineage = command.lineage;
      let saved = command.accepted;
      if (saved) { lineage = saved.file; }
      else if (!lineage) {
        try {
          saved = await createTowerPgChannelFile(workspaceId, message.channel_id, {
            storage_object_id: upload.objectId, display_name: filename,
            metadata: { text_attachment_lineage: { v: 1, origin_message_id: message.record_id, origin_storage_object_id: attachment.storage_object_id, origin_filename: attachment.filename || filename } },
          }, options);
        } catch (error) {
          if (error?.code === 'lineage_file_exists' && error.payload?.file) {
            await this.enterTextAttachmentConflict(error.payload.file, error.payload.current_version, { text, upload, token });
            return;
          }
          throw error;
        }
        lineage = saved.file;
      } else {
        try {
          saved = await createTowerPgFileVersion(workspaceId, lineage.id, {
            base_version_id: command.baseVersionId || lineage.current_version_id,
            storage_object_id: upload.objectId, client_mutation_id: mutationId,
          }, options);
        } catch (error) {
          if (error?.code === 'stale_base_version' && error.payload?.current_version) {
            await this.enterTextAttachmentConflict(error.payload.file || lineage, error.payload.current_version, { text, upload, token });
            return;
          }
          throw error;
        }
        lineage = { ...lineage, ...(saved.file || {}), current_version_id: saved.version?.id || saved.file?.current_version_id };
      }
      command.accepted = { ...saved, file: lineage };
      command.renamePending = lineage.display_name !== filename;
      await persist();
      if (lineage.display_name !== filename) {
        const renamed = await updateTowerPgFile(workspaceId, lineage.id, { display_name: filename, ...(lineage.row_version ? { row_version: lineage.row_version } : {}) }, options);
        if (renamed?.file?.display_name !== filename) throw new Error('Version saved, but filename was not confirmed. Retry Save to finish renaming.');
        lineage = { ...lineage, ...renamed.file };
      }
      command.renamePending = false;
      command.done = true;
      await persist();
      if (this.textAttachmentModal.token !== token) return;
      const latestId = lineage.current_version_id || saved?.version?.id;
      await putTextAttachmentCache({ key: `${workspace.namespace}|version:${latestId}`, workspace_id: workspaceId, bytes: new TextEncoder().encode(text) }, workspace.database()).catch(() => {});
      this.textAttachmentModal = { ...this.textAttachmentModal, saving: false, editing: false, dirty: false, conflict: null, command: null, source: { message, attachment, lineage: { ...lineage, current_version_id: latestId } } };
      await this.refreshTextAttachmentVersions(latestId);
      this.textAttachmentModal = { ...this.textAttachmentModal, saveState: 'Saved as new version' };
    } catch (error) {
      if (this.textAttachmentModal.token !== token) return;
      const denied = error?.status === 403 || error?.status === 404;
      this.textAttachmentModal = {
        ...this.textAttachmentModal, saving: false, localSavePending: false,
        error: command.accepted ? `Text version saved; filename update is pending. ${error?.message || 'Retry Save when connected.'} Your desired name is kept locally.` : denied ? 'You do not have permission to save a new version. Your edit is saved locally and can be retried after reopening.' : (error?.message || 'Save failed. Your edit is saved locally; retry when connected.'),
      };
    }
  },

  async refreshTextAttachmentVersions(latestId) {
    const token = this.textAttachmentModal.token;
    const { lineage, attachment, message } = this.textAttachmentModal.source || {};
    if (!lineage) return;
    const { workspaceId, options } = this.textAttachmentModal.workspace || this.textAttachmentWorkspaceOptions();
    const versions = (await getTowerPgFileVersions(workspaceId, lineage.id, options))?.versions || [];
    const entries = [...versions].sort((a, b) => (b.version_number || 0) - (a.version_number || 0)).map((version) => ({
      id: version.id, label: `Version ${version.version_number}${version.id === latestId ? ' (latest)' : ''}`,
      version_number: version.version_number, created_at: version.created_at, size_bytes: version.size_bytes,
    }));
    if (this.textAttachmentModal.token !== token) return;
    const workspace = this.textAttachmentModal.workspace;
    await putTextAttachmentCache({ key: `${workspace.namespace}|history:${message.record_id}:${attachment.storage_object_id}`, workspace_id: workspace.workspaceId, lineage, versions, entries: [...entries, { id: 'original', label: 'Original (sent)' }] }, workspace.database()).catch(() => {});
    if (this.textAttachmentModal.token !== token) return;
    this.textAttachmentModal = {
      ...this.textAttachmentModal, viewing: latestId,
      versions: [...entries, { id: 'original', label: 'Original (sent)', object_id: attachment.storage_object_id, size_bytes: attachment.size_bytes }],
    };
  },

  // Local edit and its uploaded object are kept; the user decides explicitly.
  async enterTextAttachmentConflict(file, currentVersion, mine) {
    const { workspaceId, options } = this.textAttachmentModal.workspace || this.textAttachmentWorkspaceOptions();
    let theirs = '';
    try {
      const bytes = await this.textAttachmentCachedBytes(`version:${currentVersion.id}`, async () => (await getTowerPgFileVersionObjectBytes(workspaceId, file.id, currentVersion.id, options)).bytes);
      theirs = decodeTextBytes(bytes) ?? '';
    } catch { /* comparison unavailable; still offer the choice */ }
    if (this.textAttachmentModal.token !== mine.token) return;
    this.textAttachmentModal = {
      ...this.textAttachmentModal, saving: false,
      conflict: { file, currentVersion, mine: mine.text, upload: mine.upload, theirs, theirsStats: totalsOf([theirs]), mineStats: totalsOf([mine.text]) },
      error: 'Someone saved a newer version first. Your edit is kept below.',
    };
  },

  async resolveTextAttachmentConflict(choice) {
    const conflict = this.textAttachmentModal.conflict;
    if (!conflict) return;
    if (choice === 'keep-mine') {
      const lineage = { ...conflict.file, current_version_id: conflict.currentVersion.id };
      this.textAttachmentModal = { ...this.textAttachmentModal, source: { ...this.textAttachmentModal.source, lineage }, conflict: null, error: '' };
      await this.saveSentTextAttachment({ resolution: { text: conflict.mine, upload: conflict.upload, lineage, baseVersionId: conflict.currentVersion.id } });
    } else if (choice === 'use-theirs') {
      const lineage = { ...conflict.file, current_version_id: conflict.currentVersion.id };
      this.textAttachmentModal = { ...this.textAttachmentModal, source: { ...this.textAttachmentModal.source, lineage }, conflict: null, error: '' };
      await this.refreshTextAttachmentVersions(conflict.currentVersion.id);
      await this.viewTextAttachmentVersion(conflict.currentVersion.id);
    } else if (choice === 'copy-mine') {
      try { await navigator.clipboard.writeText(conflict.mine); this.textAttachmentModal = { ...this.textAttachmentModal, saveState: 'Your text was copied' }; } catch { /* clipboard unavailable */ }
    }
  },

  // ---- card helpers ---------------------------------------------------------
  isTextAttachment(attachment) {
    return isTextAttachment(attachment);
  },

  textAttachmentMeta(attachment = {}) {
    const marker = attachment.text_attachment;
    const parts = [formatByteSize(attachment.size_bytes)];
    if (marker?.lines) parts.push(`${marker.lines.toLocaleString()} line${marker.lines === 1 ? '' : 's'}`);
    return parts.join(' · ');
  },

  async textAttachmentPreviewFor(key, loader) {
    this._textPreviewCache ||= new Map();
    if (this._textPreviewCache.has(key)) return this._textPreviewCache.get(key);
    const pending = loader().catch(() => '');
    this._textPreviewCache.set(key, pending);
    return pending;
  },
};
