/**
 * Audio recording and playback management methods extracted from app.js.
 *
 * The audioRecordingManagerMixin object contains methods that use `this` (the Alpine store)
 * and should be spread into the store definition.
 */

import {
  getAudioNotesByOwner,
  upsertAudioNote,
} from './db.js';
import {
  prepareStorageObject,
  prepareTowerPgStorageObject,
  uploadStorageObject,
  completeStorageObject,
  downloadStorageObject,
} from './api.js';
import { outboundAudioNote, recordFamilyHash } from './translators/audio-notes.js';
import {
  buildStoragePrepareBody,
  normalizeStorageGroupIds as normalizeStorageAccessGroupIds,
} from './storage-payloads.js';
import { decryptAudioBytes, encryptAudioBlob, measureAudioDuration } from './audio-notes.js';
import { sameListBySignature } from './utils/state-helpers.js';
import { isTowerPgBackendMode } from './backend-mode.js';
import { hydrateTowerPgAudioNotes, resolveTowerPgWorkspaceContext } from './pg-read-hydrator.js';
import { resolvePgRecordContext } from './pg-record-context.js';
import { createTowerPgAudioNoteFromLocal, queueTowerPendingWrite } from './tower-command-intents.js';
import {
  getEncryptableRecordGroupRefsForStore,
  getRecordGroupKeyState,
  getRecordWriteFieldsForStore,
} from './preferred-write-group.js';

let activeAudio = null;
let activeAudioModal = null;
let activeAudioObjectUrl = '';

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function getAudioSeekableEnd(audio) {
  const ranges = audio?.seekable;
  if (!ranges?.length) return 0;
  try {
    return ranges.end(ranges.length - 1);
  } catch {
    return 0;
  }
}

function removeAudioPlaybackModal() {
  activeAudioModal?.remove();
  activeAudioModal = null;
}

function revokeActiveAudioUrl() {
  if (!activeAudioObjectUrl) return;
  URL.revokeObjectURL(activeAudioObjectUrl);
  activeAudioObjectUrl = '';
}

function updateAudioPlaybackTimeline(audio = activeAudio) {
  if (!activeAudioModal || !audio) return;
  const scrubber = activeAudioModal.querySelector('[data-part="audio-scrubber"]');
  const elapsed = activeAudioModal.querySelector('[data-part="audio-elapsed"]');
  const duration = activeAudioModal.querySelector('[data-part="audio-duration"]');
  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const reportedDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const seekableEnd = getAudioSeekableEnd(audio);
  const totalTime = Math.max(reportedDuration, seekableEnd, currentTime);
  if (scrubber) {
    scrubber.max = totalTime > 0 ? String(Math.ceil(totalTime)) : '0';
    scrubber.value = String(Math.floor(currentTime));
    scrubber.disabled = totalTime <= 0;
  }
  if (elapsed) elapsed.textContent = formatPlaybackTime(currentTime);
  if (duration) duration.textContent = totalTime > 0 ? formatPlaybackTime(totalTime) : '--:--';
}

function stopAudioPlayback() {
  const stoppedAudio = activeAudio;
  if (stoppedAudio) {
    try {
      stoppedAudio.pause();
      stoppedAudio.currentTime = 0;
    } catch {
      // Ignore browser audio state errors.
    }
  }
  activeAudio = null;
  removeAudioPlaybackModal();
  revokeActiveAudioUrl();
}

function syncAudioPlaybackModal({ title = 'Audio playing' } = {}) {
  if (typeof document === 'undefined') return;
  if (activeAudioModal?.isConnected) {
    const titleNode = activeAudioModal.querySelector('[data-part="audio-title"]');
    if (titleNode) titleNode.textContent = title || 'Audio playing';
    updateAudioPlaybackTimeline(activeAudio);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fd-audio-playback-modal';
  overlay.dataset.testid = 'audio-playback-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'audio-playback-title');

  const panel = document.createElement('div');
  panel.className = 'fd-audio-playback-modal__panel';

  const status = document.createElement('div');
  status.className = 'fd-audio-playback-modal__status';
  status.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 4; index += 1) {
    status.append(document.createElement('span'));
  }

  const titleNode = document.createElement('p');
  titleNode.id = 'audio-playback-title';
  titleNode.className = 'fd-audio-playback-modal__title';
  titleNode.dataset.part = 'audio-title';
  titleNode.textContent = title || 'Audio playing';

  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'fd-audio-playback-modal__stop';
  stopButton.dataset.testid = 'audio-playback-stop';
  stopButton.setAttribute('aria-label', 'Stop audio playback');
  stopButton.textContent = 'Stop';
  stopButton.addEventListener('click', () => stopAudioPlayback());

  const timeline = document.createElement('div');
  timeline.className = 'fd-audio-playback-modal__timeline';

  const elapsed = document.createElement('span');
  elapsed.className = 'fd-audio-playback-modal__time';
  elapsed.dataset.part = 'audio-elapsed';
  elapsed.textContent = '0:00';

  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.min = '0';
  scrubber.max = '0';
  scrubber.value = '0';
  scrubber.step = '1';
  scrubber.className = 'fd-audio-playback-modal__scrubber';
  scrubber.dataset.part = 'audio-scrubber';
  scrubber.dataset.testid = 'audio-playback-scrubber';
  scrubber.setAttribute('aria-label', 'Audio playback timeline');
  scrubber.disabled = true;
  scrubber.addEventListener('input', () => {
    if (!activeAudio) return;
    const nextTime = Number(scrubber.value);
    if (Number.isFinite(nextTime)) {
      activeAudio.currentTime = nextTime;
      updateAudioPlaybackTimeline(activeAudio);
    }
  });

  const duration = document.createElement('span');
  duration.className = 'fd-audio-playback-modal__time';
  duration.dataset.part = 'audio-duration';
  duration.textContent = '--:--';

  timeline.append(elapsed, scrubber, duration);
  panel.append(status, titleNode, stopButton, timeline);
  overlay.append(panel);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopAudioPlayback();
    }
  });
  document.body.append(overlay);
  activeAudioModal = overlay;
  updateAudioPlaybackTimeline(activeAudio);
  stopButton.focus({ preventScroll: true });
}

function startAudioPlayback(audio, objectUrl, { title = 'Audio playing' } = {}) {
  stopAudioPlayback();
  activeAudio = audio;
  activeAudioObjectUrl = objectUrl;
  syncAudioPlaybackModal({ title });
  audio.addEventListener?.('loadedmetadata', () => updateAudioPlaybackTimeline(audio));
  audio.addEventListener?.('durationchange', () => updateAudioPlaybackTimeline(audio));
  audio.addEventListener?.('timeupdate', () => updateAudioPlaybackTimeline(audio));
  audio.addEventListener?.('ended', () => {
    if (activeAudio === audio) stopAudioPlayback();
  }, { once: true });
  audio.addEventListener?.('error', () => {
    if (activeAudio === audio) stopAudioPlayback();
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Mixin — methods that use `this` (the Alpine store)
// ---------------------------------------------------------------------------

export const audioRecordingManagerMixin = {

  get audioNotesById() {
    return new Map(this.audioNotes.map((note) => [note.record_id, note]));
  },

  getAudioNote(recordId) {
    return this.audioNotesById.get(recordId) || null;
  },

  getAudioAttachmentNote(attachment) {
    const recordId = String(attachment?.audio_note_record_id || '').trim();
    if (!recordId) return null;
    return this.getAudioNote(recordId);
  },

  getAudioAttachmentsForRecord(record, targetFamilyHash = recordFamilyHash('comment')) {
    const recordId = String(record?.record_id || '').trim();
    const existingAttachments = Array.isArray(record?.attachments) ? record.attachments : [];
    const audioAttachments = existingAttachments.filter((attachment) => attachment?.kind === 'audio');
    if (!recordId) return audioAttachments;

    const seen = new Set(
      audioAttachments
        .map((attachment) => String(attachment?.audio_note_record_id || '').trim())
        .filter(Boolean),
    );
    const targetHash = String(targetFamilyHash || '').trim();
    const targetLinkedAttachments = (Array.isArray(this.audioNotes) ? this.audioNotes : [])
      .filter((note) =>
        String(note?.record_state || 'active') !== 'deleted'
        && String(note?.target_record_id || '').trim() === recordId
        && (!targetHash || String(note?.target_record_family_hash || '').trim() === targetHash)
      )
      .map((note) => ({
        kind: 'audio',
        audio_note_record_id: note.record_id,
        title: note.title || 'Voice note',
        duration_seconds: Number.isFinite(Number(note.duration_seconds)) ? Number(note.duration_seconds) : null,
      }))
      .filter((attachment) => {
        const id = String(attachment.audio_note_record_id || '').trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return [...audioAttachments, ...targetLinkedAttachments];
  },

  getAudioAttachmentPreview(attachment) {
    const note = this.getAudioAttachmentNote(attachment);
    if (note?.transcript_preview) return note.transcript_preview;
    if (note?.summary) return note.summary;
    if (note?.title) return note.title;
    return attachment?.title || 'Voice note';
  },

  formatAudioDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  },

  getAudioRecorderKindLabel(context = this.audioRecorderContext) {
    return context === 'chat' || context === 'thread' ? 'Chat' : 'Comment';
  },

  getAudioRecorderDefaultTitle(context = this.audioRecorderContext) {
    const label = this.getAudioRecorderKindLabel(context);
    const now = new Date();
    const date = now.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const time = now.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${label} Voice: ${date} - ${time}`;
  },

  getAudioDraftsForContext(context) {
    if (context === 'chat') return this.messageAudioDrafts;
    if (context === 'thread') return this.threadAudioDrafts;
    if (context === 'task-comment') return this.taskCommentAudioDrafts;
    if (context === 'doc-comment') return this.docCommentAudioDrafts;
    if (context === 'doc-reply') return this.docCommentReplyAudioDrafts;
    return [];
  },

  setAudioDraftsForContext(context, drafts) {
    if (context === 'chat') this.messageAudioDrafts = drafts;
    else if (context === 'thread') this.threadAudioDrafts = drafts;
    else if (context === 'task-comment') this.taskCommentAudioDrafts = drafts;
    else if (context === 'doc-comment') this.docCommentAudioDrafts = drafts;
    else if (context === 'doc-reply') this.docCommentReplyAudioDrafts = drafts;
  },

  async openAudioRecorder(context) {
    this.audioRecorderContext = context;
    this.audioRecorderState = 'idle';
    this.audioRecorderError = null;
    this.audioRecorderDurationSeconds = 0;
    this.audioRecorderStatusLabel = '';
    this.audioRecorderTitle = this.getAudioRecorderDefaultTitle(context);
    this.clearAudioRecorderPreview();
    this.showAudioRecorderModal = true;
    await Promise.resolve();
    await this.startAudioRecording();
  },

  async startAudioRecording() {
    this.audioRecorderError = null;
    this.audioRecorderStatusLabel = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      this._audioRecorderChunks = [];
      this._audioRecorderStream = stream;
      this._audioRecorder = new MediaRecorder(stream, { mimeType });
      this._audioRecorderStartedAt = Date.now();
      this._audioRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this._audioRecorderChunks.push(event.data);
      };
      this._audioRecorder.onerror = () => {
        this.audioRecorderError = 'Recording failed.';
        this.audioRecorderState = 'idle';
      };
      this._audioRecorder.start();
      this.audioRecorderState = 'recording';
      this.audioRecorderStatusLabel = 'Recording…';
    } catch (error) {
      this.audioRecorderError = error?.message || 'Could not access microphone.';
    }
  },

  async stopAudioRecording() {
    if (!this._audioRecorder || this.audioRecorderState !== 'recording') return;

    const recorder = this._audioRecorder;
    const stream = this._audioRecorderStream;

    this.audioRecorderState = 'processing';
    this.audioRecorderStatusLabel = 'Preparing recording…';

    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    stream?.getTracks?.().forEach((track) => track.stop());

    const mimeType = recorder.mimeType || 'audio/webm;codecs=opus';
    const blob = new Blob(this._audioRecorderChunks || [], { type: mimeType });
    this._audioRecorder = null;
    this._audioRecorderStream = null;
    this._audioRecorderChunks = [];

    const durationFromClock = Math.max(1, Math.round((Date.now() - (this._audioRecorderStartedAt || Date.now())) / 1000));
    const measured = await measureAudioDuration(blob);
    this.clearAudioRecorderPreview();
    this._audioRecorderBlob = blob;
    this.audioRecorderDurationSeconds = measured || durationFromClock;
    this.audioRecorderPreviewUrl = URL.createObjectURL(blob);
    await this.attachRecordedAudioDraft();
  },

  clearAudioRecorderPreview() {
    if (this.audioRecorderPreviewUrl) {
      URL.revokeObjectURL(this.audioRecorderPreviewUrl);
    }
    this.audioRecorderPreviewUrl = '';
    this._audioRecorderBlob = null;
  },

  closeAudioRecorder() {
    if (this._audioRecorder && this.audioRecorderState === 'recording') {
      try {
        this._audioRecorder.stop();
      } catch {}
    }
    this._audioRecorderStream?.getTracks?.().forEach((track) => track.stop());
    this._audioRecorder = null;
    this._audioRecorderStream = null;
    this._audioRecorderChunks = [];
    this.audioRecorderContext = null;
    this.audioRecorderState = 'idle';
    this.audioRecorderStatusLabel = '';
    this.audioRecorderError = null;
    this.audioRecorderDurationSeconds = 0;
    this.audioRecorderTitle = '';
    this.clearAudioRecorderPreview();
    this.showAudioRecorderModal = false;
  },

  async attachRecordedAudioDraft() {
    if (!this._audioRecorderBlob || !this.audioRecorderContext || !this.workspaceOwnerNpub) return;
    this.audioRecorderError = null;
    this.audioRecorderState = 'uploading';
    this.audioRecorderStatusLabel = isTowerPgBackendMode() ? 'Uploading…' : 'Encrypting and uploading…';

    try {
      const pgMode = isTowerPgBackendMode();
      const encrypted = pgMode ? null : await encryptAudioBlob(this._audioRecorderBlob);
      const accessGroupIds = pgMode ? [] : this.getAudioRecorderStorageGroupIds(this.audioRecorderContext);
      if (!pgMode && accessGroupIds == null) {
        throw new Error(this.error || 'Voice note upload is missing document comment group keys.');
      }
      const uploadBytes = pgMode
        ? new Uint8Array(await this._audioRecorderBlob.arrayBuffer())
        : encrypted.encryptedBytes;
      const pgWorkspaceContext = pgMode ? resolveTowerPgWorkspaceContext(this) : null;
      const prepareBody = buildStoragePrepareBody({
        ownerNpub: pgMode ? pgWorkspaceContext.workspaceOwnerNpub : this.workspaceOwnerNpub,
        accessGroupIds: pgMode ? [] : accessGroupIds,
        contentType: this._audioRecorderBlob.type || 'audio/webm;codecs=opus',
        sizeBytes: uploadBytes.byteLength,
        fileName: `${(this.audioRecorderTitle || this.getAudioRecorderDefaultTitle()).replace(/[^a-zA-Z0-9._-]/g, '_')}.webm`,
      });
      const prepared = pgMode
        ? await prepareTowerPgStorageObject(pgWorkspaceContext.workspaceId, prepareBody, {
          baseUrl: pgWorkspaceContext.baseUrl,
          appNpub: pgWorkspaceContext.appNpub,
        })
        : await prepareStorageObject(prepareBody);
      await uploadStorageObject(
        prepared,
        uploadBytes,
        this._audioRecorderBlob.type || 'audio/webm;codecs=opus',
      );
      await completeStorageObject(prepared.object_id, {
        size_bytes: uploadBytes.byteLength,
      });

      const draft = {
        draft_id: crypto.randomUUID(),
        kind: 'audio',
        title: this.audioRecorderTitle || 'Voice note',
        storage_object_id: prepared.object_id,
        mime_type: this._audioRecorderBlob.type || 'audio/webm;codecs=opus',
        duration_seconds: this.audioRecorderDurationSeconds || null,
        size_bytes: uploadBytes.byteLength,
        media_encryption: pgMode ? null : encrypted.mediaEncryption,
        transcript_status: 'pending',
        transcript_preview: null,
      };
      const nextDrafts = [...this.getAudioDraftsForContext(this.audioRecorderContext), draft];
      this.setAudioDraftsForContext(this.audioRecorderContext, nextDrafts);
      this.closeAudioRecorder();
    } catch (error) {
      this.audioRecorderError = error?.message || 'Failed to upload voice note.';
      this.audioRecorderState = 'ready';
      this.audioRecorderStatusLabel = 'Upload failed. Retry upload when ready.';
    }
  },

  removeAudioDraft(context, draftId) {
    this.setAudioDraftsForContext(
      context,
      this.getAudioDraftsForContext(context).filter((draft) => draft.draft_id !== draftId),
    );
  },

  async materializeAudioDrafts({
    drafts = [],
    target_record_id = null,
    target_record_family_hash = null,
    target_group_ids = [],
    write_group_ref = null,
    write_group_npub = null,
    scopeId = null,
    channelId = null,
    threadId = null,
  }) {
    const audioNotes = [];
    const attachments = [];
    let pgContext = null;
    if (isTowerPgBackendMode() && drafts.length > 0) {
      pgContext = resolvePgRecordContext(this, {
        scopeId,
        channelId,
        threadId,
        boardId: this.selectedBoardId,
      });
    }
    const sendContext = pgContext ? resolveTowerPgWorkspaceContext(this) : null;
    const assertAudioSource = () => {
      if (!sendContext) return;
      const current = resolveTowerPgWorkspaceContext(this);
      if (['workspaceId', 'baseUrl', 'appNpub', 'sessionNpub', 'generation'].some(key => current[key] !== sendContext[key])) {
        throw new Error('Workspace changed while attaching voice note. Review the retained voice draft in its original workspace.');
      }
    };
    const audioWriteFields = pgContext ? null : await getRecordWriteFieldsForStore(this, {
      group_ids: target_group_ids,
    }, {
      label: 'Audio note write',
      writeGroupRef: write_group_ref || write_group_npub,
    });
    const encryptableGroupIds = audioWriteFields?.group_ids || [];
    const resolvedWriteGroupRef = audioWriteFields?.write_group_ref || null;

    for (const draft of drafts) {
      assertAudioSource();
      const recordId = crypto.randomUUID();
      const now = new Date().toISOString();
      const localRow = {
        record_id: recordId,
        owner_npub: this.workspaceOwnerNpub,
        target_record_id,
        target_record_family_hash,
        title: draft.title || 'Voice note',
        storage_object_id: draft.storage_object_id,
        mime_type: draft.mime_type || 'audio/webm;codecs=opus',
        duration_seconds: draft.duration_seconds ?? null,
        size_bytes: draft.size_bytes ?? 0,
        media_encryption: draft.media_encryption,
        waveform_preview: draft.waveform_preview || [],
        transcript_status: draft.transcript_status || 'pending',
        transcript_preview: draft.transcript_preview || null,
        transcript: null,
        summary: null,
        sender_npub: this.session?.npub,
        group_ids: [...encryptableGroupIds],
        ...(pgContext ? {
          pg_channel_id: pgContext.channelId,
          pg_thread_id: pgContext.threadId || null,
        } : {}),
        sync_status: 'pending',
        record_state: 'active',
        version: 1,
        created_at: now,
        updated_at: now,
      };
      if (pgContext) {
        const accepted = await createTowerPgAudioNoteFromLocal(this, localRow);
        assertAudioSource();
        await upsertAudioNote(accepted);
        audioNotes.push(accepted);
        attachments.push({
          kind: 'audio',
          audio_note_record_id: accepted.record_id,
          title: accepted.title,
          duration_seconds: accepted.duration_seconds,
        });
        continue;
      }

      await upsertAudioNote(localRow);
      audioNotes.push(localRow);
      attachments.push({
        kind: 'audio',
        audio_note_record_id: recordId,
        title: localRow.title,
        duration_seconds: localRow.duration_seconds,
      });

      const envelope = await outboundAudioNote({
        ...localRow,
        target_group_ids: encryptableGroupIds,
        signature_npub: this.signingNpub,
        write_group_ref: resolvedWriteGroupRef,
      });
      await queueTowerPendingWrite(this, {
        record_id: recordId,
        record_family_hash: envelope.record_family_hash,
        envelope,
      });
    }

    assertAudioSource();
    if (audioNotes.length > 0) {
      this.audioNotes = [...this.audioNotes, ...audioNotes]
        .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
    }

    return { audioNotes, attachments };
  },

  async playAudioAttachment(attachment) {
    const recordId = String(attachment?.audio_note_record_id || '').trim();
    if (!recordId) return;

    let note = this.getAudioNote(recordId);
    if (!note && typeof this.refreshAudioNotes === 'function') {
      await this.refreshAudioNotes();
      note = this.getAudioNote(recordId);
    }
    if (!note && typeof this.pullFamiliesFromBackend === 'function') {
      try {
        await this.pullFamiliesFromBackend(['audio_note'], { forceFull: true });
        if (typeof this.refreshAudioNotes === 'function') await this.refreshAudioNotes();
        note = this.getAudioNote(recordId);
      } catch (error) {
        this.error = error?.message || 'Could not fetch voice note.';
        return;
      }
    }
    if (!note?.storage_object_id || (!note?.media_encryption && !note?.pg_backend)) {
      this.error = 'Voice note is not available yet. Sync audio notes and try again.';
      return;
    }
    try {
      const encryptedBytes = await downloadStorageObject(note.storage_object_id);
      const blob = note.pg_backend && !note.media_encryption?.key_b64
        ? new Blob([encryptedBytes], { type: note.mime_type || 'audio/webm;codecs=opus' })
        : await decryptAudioBytes(encryptedBytes, note.media_encryption, note.mime_type);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      startAudioPlayback(audio, url, { title: this.getAudioAttachmentPreview(attachment) });
      await audio.play();
    } catch (error) {
      stopAudioPlayback();
      this.error = error?.message || 'Could not play voice note.';
    }
  },

  stopAudioPlayback() {
    stopAudioPlayback();
  },

  async applyAudioNotes(audioNotes = []) {
    const nextAudioNotes = Array.isArray(audioNotes) ? audioNotes : [];
    if (!sameListBySignature(this.audioNotes, nextAudioNotes, (note) => [
      String(note?.record_id || ''),
      String(note?.updated_at || ''),
      String(note?.version ?? ''),
      String(note?.record_state || ''),
      String(note?.transcript_status || ''),
    ].join('|'))) {
      this.audioNotes = nextAudioNotes;
    }

    for (const note of nextAudioNotes) {
      await this.rememberPeople([note.sender_npub], 'audio-note');
    }
  },

  async refreshAudioNotes() {
    if (isTowerPgBackendMode()) {
      return hydrateTowerPgAudioNotes(this);
    }
    const ownerNpub = this.workspaceOwnerNpub;
    if (!ownerNpub) return;
    const audioNotes = await getAudioNotesByOwner(ownerNpub);
    await this.applyAudioNotes(audioNotes);
    return audioNotes;
  },

  getAudioRecorderStorageGroupIds(context = this.audioRecorderContext) {
    const encryptableGroupIds = (record) => getRecordGroupKeyState(record, {
      resolveGroupId: (value) => (
        typeof this.resolveGroupId === 'function'
          ? this.resolveGroupId(value)
          : String(value || '').trim() || null
      ),
    }).encryptableGroupIds;
    if (context === 'chat' || context === 'thread') {
      return normalizeStorageAccessGroupIds(encryptableGroupIds(this.selectedChannel));
    }
    if (context === 'task-comment') {
      const activeTaskId = String(this.activeTaskId || '').trim();
      const activeTask = activeTaskId
        ? (this.tasks || []).find((task) => String(task?.record_id || '') === activeTaskId)
        : null;
      const editingTaskMatchesActive = !activeTaskId
        || String(this.editingTask?.record_id || '') === activeTaskId;
      const task = editingTaskMatchesActive
        ? (this.editingTask || this.activeTaskDetail || activeTask)
        : (this.activeTaskDetail || activeTask || this.editingTask);
      return normalizeStorageAccessGroupIds(encryptableGroupIds(task));
    }
    if (context === 'doc-comment' || context === 'doc-reply') {
      if (typeof this.getEncryptableDocCommentGroupIds === 'function') {
        const groupIds = this.getEncryptableDocCommentGroupIds(this.selectedDocument);
        return groupIds == null ? null : normalizeStorageAccessGroupIds(groupIds);
      }
      return normalizeStorageAccessGroupIds(this.selectedDocument?.group_ids ?? []);
    }
    return [];
  },
};
