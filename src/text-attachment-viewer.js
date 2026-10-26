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
  getTowerPgFileVersionObjectBytes,
  getTowerPgFileVersions,
  uploadStorageObject,
} from './api.js';
import { getTextAttachmentCache, putTextAttachmentCache } from './db.js';
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
import { applyPageEdit, normalizeForTextarea, paginateText } from './text-pages.js';

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
    const state = saving ? 'Saving…' : saveState || (dirty ? 'Unsaved changes' : (mode === 'draft' ? 'Saved locally' : ''));
    return [`${totals.lines.toLocaleString()} lines`, formatByteSize(totals.bytes), state].filter(Boolean).join(' · ');
  },

  closeTextAttachmentModal() {
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
      const file = textToAttachmentFile(text, filename);
      const marker = textAttachmentMarker({ source: draft.text_attachment?.source || 'paste', text });
      const patch = {
        file, filename, size_bytes: file.size, text_attachment: marker, preview_line: firstLinePreview(text), status: 'uploading', error: '',
        // New bytes need a new storage object; the old one is orphaned, never mutated.
        storage_upload: undefined, storage_object_id: undefined, sha256_hex: '', upload_inflight: false,
      };
      this._chatUploadControllers?.get(draftId)?.abort();
      this.setChatFileDrafts(context, this.getChatFileDrafts(context).map((item) => (item.draft_id === draftId ? { ...item, ...patch } : item)));
      await persistTextDraft(this, context, { ...draft, ...patch });
      void this.uploadChatFileDraft(draftId, context);
    }
    this.closeTextAttachmentModal();
  },

  // ---- sent attachments -----------------------------------------------------
  textAttachmentWorkspaceOptions() {
    const ctx = this.captureStorageUploadContext();
    return { ctx, workspaceId: ctx.workspaceId, options: ctx.options };
  },

  async textAttachmentCachedBytes(key, fetchBytes) {
    try {
      const hit = await getTextAttachmentCache(key);
      if (hit?.bytes) return new Uint8Array(hit.bytes);
    } catch { /* cache is optional */ }
    const bytes = new Uint8Array(await fetchBytes());
    try { await putTextAttachmentCache({ key, workspace_id: this.textAttachmentWorkspaceOptions().workspaceId, bytes }); } catch { /* optional */ }
    return bytes;
  },

  async findTextAttachmentLineage(message, attachment, { workspaceId, options }) {
    const payload = await getTowerPgChannelFiles(workspaceId, message.channel_id, options);
    return (payload?.files || []).find((file) => {
      const lineage = file?.metadata?.text_attachment_lineage;
      return lineage?.origin_message_id === message.record_id
        && lineage?.origin_storage_object_id === attachment.storage_object_id && !file.deleted_at;
    }) || null;
  },

  async openSentTextAttachment(message, attachment) {
    const token = this.textAttachmentModal.token + 1;
    const filename = attachment.filename || 'Text attachment';
    this.textAttachmentModal = {
      ...closedModal(), open: true, mode: 'sent', status: 'loading', filename, originalFilename: filename,
      source: { message, attachment, lineage: null }, token,
      canEdit: Boolean(this.canComposeInChatDestination),
    };
    const { workspaceId, options } = this.textAttachmentWorkspaceOptions();
    let lineage = null;
    let versions = [];
    let online = true;
    try {
      lineage = await this.findTextAttachmentLineage(message, attachment, { workspaceId, options });
      if (lineage) versions = (await getTowerPgFileVersions(workspaceId, lineage.id, options))?.versions || [];
    } catch { online = false; }
    if (this.textAttachmentModal.token !== token) return;
    const originalEntry = { id: 'original', label: 'Original (sent)', object_id: attachment.storage_object_id, size_bytes: attachment.size_bytes };
    const entries = [...[...versions].sort((a, b) => (b.version_number || 0) - (a.version_number || 0)).map((version) => ({
      id: version.id, label: `Version ${version.version_number}${version.id === lineage?.current_version_id ? ' (latest)' : ''}`,
      version_number: version.version_number, created_at: version.created_at, size_bytes: version.size_bytes,
    })), originalEntry];
    this.textAttachmentModal = { ...this.textAttachmentModal, versions: entries, source: { message, attachment, lineage } };
    const target = lineage?.current_version_id || 'original';
    await this.viewTextAttachmentVersion(target, { offline: !online });
  },

  async viewTextAttachmentVersion(versionId, { offline = false } = {}) {
    const token = this.textAttachmentModal.token;
    const { attachment, lineage } = this.textAttachmentModal.source || {};
    if (!attachment) return;
    this.textModalCommitPage();
    this.textAttachmentModal = { ...this.textAttachmentModal, status: 'loading', viewing: versionId, editing: false, error: '', conflict: null };
    const { workspaceId, options } = this.textAttachmentWorkspaceOptions();
    try {
      const bytes = versionId === 'original'
        ? await this.textAttachmentCachedBytes(`object:${attachment.storage_object_id}`, async () => (await downloadStorageObjectBlob(attachment.storage_object_id, options)).arrayBuffer())
        : await this.textAttachmentCachedBytes(`version:${versionId}`, async () => (await getTowerPgFileVersionObjectBytes(workspaceId, lineage.id, versionId, options)).bytes);
      if (this.textAttachmentModal.token !== token) return;
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
      if (this.textAttachmentModal.token !== token) return;
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
    void this.viewTextAttachmentVersion(modal.viewing);
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

  async uploadTextAttachmentBytes(bytes, filename, { ctx, options }) {
    const ownerNpub = String(this.workspaceOwnerNpub || this.session?.npub || '').trim();
    if (!ownerNpub) throw new Error('Missing storage owner for attachment.');
    const digest = await sha256Hex(bytes);
    const prepared = await this.prepareStorageObjectForCurrentWorkspace(buildStoragePrepareBody({
      ownerNpub, accessGroupIds: [], contentType: TEXT_ATTACHMENT_CONTENT_TYPE, sizeBytes: bytes.byteLength, fileName: filename,
    }), ctx);
    await uploadStorageObject(prepared, bytes, TEXT_ATTACHMENT_CONTENT_TYPE, options);
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
    this.textAttachmentModal = { ...this.textAttachmentModal, saving: true, saveState: '', error: '' };
    const workspace = this.textAttachmentWorkspaceOptions();
    const { workspaceId, options } = workspace;
    try {
      let upload = resolution?.upload;
      if (!upload) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > TEXT_ATTACHMENT_MAX_EDIT_BYTES) throw new Error('This text is too large to save as a version.');
        upload = await this.uploadTextAttachmentBytes(bytes, filename, workspace);
      }
      const mutationId = resolution?.mutationId || crypto.randomUUID();
      let lineage = resolution?.lineage || modal.source.lineage;
      let saved;
      if (!lineage) {
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
            base_version_id: resolution?.baseVersionId || lineage.current_version_id,
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
      if (this.textAttachmentModal.token !== token) return;
      const latestId = lineage.current_version_id || saved?.version?.id;
      await putTextAttachmentCache({ key: `version:${latestId}`, workspace_id: workspaceId, bytes: new TextEncoder().encode(text) }).catch(() => {});
      this.textAttachmentModal = { ...this.textAttachmentModal, saving: false, editing: false, dirty: false, conflict: null, source: { message, attachment, lineage: { ...lineage, current_version_id: latestId } } };
      await this.refreshTextAttachmentVersions(latestId);
      this.textAttachmentModal = { ...this.textAttachmentModal, saveState: 'Saved as new version' };
    } catch (error) {
      if (this.textAttachmentModal.token !== token) return;
      const denied = error?.status === 403 || error?.status === 404;
      this.textAttachmentModal = {
        ...this.textAttachmentModal, saving: false,
        error: denied ? 'You do not have permission to save a new version. Your text is still here — copy it before closing.' : (error?.message || 'Save failed. Your text is still here; retry when connected.'),
      };
    }
  },

  async refreshTextAttachmentVersions(latestId) {
    const { lineage, attachment } = this.textAttachmentModal.source || {};
    if (!lineage) return;
    const { workspaceId, options } = this.textAttachmentWorkspaceOptions();
    const versions = (await getTowerPgFileVersions(workspaceId, lineage.id, options))?.versions || [];
    const entries = [...versions].sort((a, b) => (b.version_number || 0) - (a.version_number || 0)).map((version) => ({
      id: version.id, label: `Version ${version.version_number}${version.id === latestId ? ' (latest)' : ''}`,
      version_number: version.version_number, created_at: version.created_at, size_bytes: version.size_bytes,
    }));
    this.textAttachmentModal = {
      ...this.textAttachmentModal, viewing: latestId,
      versions: [...entries, { id: 'original', label: 'Original (sent)', object_id: attachment.storage_object_id, size_bytes: attachment.size_bytes }],
    };
  },

  // Local edit and its uploaded object are kept; the user decides explicitly.
  async enterTextAttachmentConflict(file, currentVersion, mine) {
    const { workspaceId, options } = this.textAttachmentWorkspaceOptions();
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
