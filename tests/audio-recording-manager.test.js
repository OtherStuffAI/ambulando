import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const mocks = vi.hoisted(() => ({
  getAudioNotesByOwner: vi.fn(),
  upsertAudioNote: vi.fn(),
  addPendingWrite: vi.fn(),
  prepareStorageObject: vi.fn(),
  prepareTowerPgStorageObject: vi.fn(),
  uploadStorageObject: vi.fn(),
  completeStorageObject: vi.fn(),
  createTowerPgChannelAudioNote: vi.fn(),
  downloadStorageObject: vi.fn(),
  isTowerPgBackendMode: vi.fn(() => false),
  outboundAudioNote: vi.fn(),
  encryptAudioBlob: vi.fn(),
  decryptAudioBytes: vi.fn(),
  measureAudioDuration: vi.fn(),
  hasGroupKey: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getAudioNotesByOwner: mocks.getAudioNotesByOwner,
  upsertAudioNote: mocks.upsertAudioNote,
  addPendingWrite: mocks.addPendingWrite,
}));

vi.mock('../src/api.js', () => ({
  prepareStorageObject: mocks.prepareStorageObject,
  prepareTowerPgStorageObject: mocks.prepareTowerPgStorageObject,
  uploadStorageObject: mocks.uploadStorageObject,
  completeStorageObject: mocks.completeStorageObject,
  createTowerPgChannelAudioNote: mocks.createTowerPgChannelAudioNote,
  createTowerPgChannelDoc: vi.fn(),
  createTowerPgChannelFile: vi.fn(),
  createTowerPgChannelMessage: vi.fn(),
  createTowerPgChannelTask: vi.fn(),
  getTowerPgChannelAudioNotes: vi.fn(),
  getTowerPgChannelDocs: vi.fn(),
  getTowerPgChannelFiles: vi.fn(),
  getTowerPgChannelMessages: vi.fn(),
  getTowerPgChannelTasks: vi.fn(),
  getTowerPgChannelThreads: vi.fn(),
  getTowerPgScopeChannels: vi.fn(),
  getTowerPgScopeTasks: vi.fn(),
  getTowerPgWorkspaceScopes: vi.fn(),
  updateTowerPgTask: vi.fn(),
  updateTowerPgTaskState: vi.fn(),
  downloadStorageObject: mocks.downloadStorageObject,
}));

vi.mock('../src/backend-mode.js', () => ({
  isTowerPgBackendMode: mocks.isTowerPgBackendMode,
}));

vi.mock('../src/translators/audio-notes.js', () => ({
  outboundAudioNote: mocks.outboundAudioNote,
  recordFamilyHash: (family) => `npub1app:${family}`,
}));

vi.mock('../src/audio-notes.js', () => ({
  encryptAudioBlob: mocks.encryptAudioBlob,
  decryptAudioBytes: mocks.decryptAudioBytes,
  measureAudioDuration: mocks.measureAudioDuration,
}));

vi.mock('../src/crypto/group-keys.js', () => ({
  hasGroupKey: mocks.hasGroupKey,
}));

import { audioRecordingManagerMixin } from '../src/audio-recording-manager.js';
import { recordFamilyHash } from '../src/translators/chat.js';

function createStore(overrides = {}) {
  return Object.assign(Object.create(audioRecordingManagerMixin), {
    audioNotes: [],
    error: null,
    resolveGroupId: (value) => String(value || '').trim() || null,
    ...overrides,
  });
}

function createAudioStub(overrides = {}) {
  const listeners = new Map();
  const audio = {
    currentTime: 0,
    duration: 30,
    seekable: { length: 1, end: () => 30 },
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn((eventName, listener) => {
      listeners.set(eventName, listener);
    }),
    dispatchAudioEvent(eventName) {
      listeners.get(eventName)?.();
    },
    ...overrides,
  };
  return audio;
}

describe('audioRecordingManagerMixin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTowerPgBackendMode.mockReturnValue(false);
    mocks.hasGroupKey.mockImplementation((groupId) => String(groupId || '').startsWith('shared'));
    mocks.encryptAudioBlob.mockResolvedValue({
      encryptedBytes: new Uint8Array([1, 2, 3]),
      mediaEncryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
    });
    mocks.prepareStorageObject.mockResolvedValue({ object_id: 'storage-1' });
    mocks.prepareTowerPgStorageObject.mockResolvedValue({ object_id: 'storage-pg-1' });
    mocks.outboundAudioNote.mockImplementation(async (payload) => ({
      record_id: payload.record_id,
      owner_npub: payload.owner_npub,
      record_family_hash: 'app:audio_note',
      write_group_id: payload.write_group_ref,
      group_payloads: payload.target_group_ids.map((group_id) => ({ group_id })),
      payload,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the document comment encryptable group subset for storage upload access', () => {
    const store = createStore({
      selectedDocument: {
        record_id: 'doc-1',
        group_ids: ['group-readable', 'group-inaccessible'],
      },
      getEncryptableDocCommentGroupIds: () => ['group-readable'],
    });

    expect(store.getAudioRecorderStorageGroupIds('doc-comment')).toEqual(['group-readable']);
    expect(store.getAudioRecorderStorageGroupIds('doc-reply')).toEqual(['group-readable']);
  });

  it('blocks doc comment audio storage upload when comment group keys are incomplete', () => {
    const store = createStore({
      selectedDocument: {
        record_id: 'doc-1',
        group_ids: ['group-readable', 'group-inaccessible'],
      },
      getEncryptableDocCommentGroupIds: () => null,
    });

    expect(store.getAudioRecorderStorageGroupIds('doc-comment')).toBeNull();
  });

  it('falls back to selected document groups when the doc comment filter is unavailable', () => {
    const store = createStore({
      selectedDocument: {
        record_id: 'doc-1',
        group_ids: ['group-a', 'group-b'],
      },
    });

    expect(store.getAudioRecorderStorageGroupIds('doc-comment')).toEqual(['group-a', 'group-b']);
  });

  it('uses the active task when recording a task comment in read mode', () => {
    const store = createStore({
      activeTaskId: 'task-1',
      editingTask: null,
      tasks: [{
        record_id: 'task-1',
        group_ids: ['shared-task', 'private-task'],
      }],
    });

    expect(store.getAudioRecorderStorageGroupIds('task-comment')).toEqual(['shared-task']);
  });

  it('uploads chat voice-note storage to the same encryptable group subset used by group members', async () => {
    const store = createStore({
      workspaceOwnerNpub: 'npub-workspace',
      audioRecorderContext: 'chat',
      audioRecorderTitle: 'Team voice note',
      audioRecorderDurationSeconds: 12,
      messageAudioDrafts: [],
      selectedChannel: {
        record_id: 'channel-1',
        group_ids: ['shared-channel', 'private-channel'],
      },
      _audioRecorderBlob: new Blob(['voice'], { type: 'audio/webm;codecs=opus' }),
    });

    await store.attachRecordedAudioDraft();

    expect(mocks.prepareStorageObject).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub-workspace',
      owner_group_id: 'shared-channel',
      access_group_ids: ['shared-channel'],
      content_type: 'audio/webm;codecs=opus',
      size_bytes: 3,
    }));
    expect(mocks.uploadStorageObject).toHaveBeenCalledWith(
      { object_id: 'storage-1' },
      new Uint8Array([1, 2, 3]),
      'audio/webm;codecs=opus',
    );
    expect(mocks.completeStorageObject).toHaveBeenCalledWith('storage-1', { size_bytes: 3 });
    expect(store.messageAudioDrafts).toHaveLength(1);
    expect(store.messageAudioDrafts[0]).toMatchObject({
      kind: 'audio',
      title: 'Team voice note',
      storage_object_id: 'storage-1',
      media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
    });
  });

  it('uploads PG voice-note drafts without local media encryption', async () => {
    mocks.isTowerPgBackendMode.mockReturnValue(true);
    const store = createStore({
      workspaceOwnerNpub: 'npub-workspace',
      backendUrl: 'https://tower.example',
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub-workspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      audioRecorderContext: 'thread',
      audioRecorderTitle: 'Thread voice note',
      audioRecorderDurationSeconds: 8,
      messageAudioDrafts: [],
      threadAudioDrafts: [],
      setAudioDraftsForContext(context, drafts) {
        this[context === 'thread' ? 'threadAudioDrafts' : 'messageAudioDrafts'] = drafts;
      },
      getAudioDraftsForContext(context) {
        return this[context === 'thread' ? 'threadAudioDrafts' : 'messageAudioDrafts'] || [];
      },
      closeAudioRecorder: vi.fn(),
      _audioRecorderBlob: new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/webm;codecs=opus' }),
    });

    await store.attachRecordedAudioDraft();

    expect(mocks.encryptAudioBlob).not.toHaveBeenCalled();
    expect(mocks.prepareStorageObject).not.toHaveBeenCalled();
    expect(mocks.prepareTowerPgStorageObject).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Object),
      { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' },
    );
    const prepareBody = mocks.prepareTowerPgStorageObject.mock.calls[0][1];
    expect(prepareBody).toMatchObject({
      owner_npub: 'npub-workspace',
      content_type: 'audio/webm;codecs=opus',
      size_bytes: 3,
    });
    expect(prepareBody).not.toHaveProperty('access_group_ids');
    expect(mocks.uploadStorageObject).toHaveBeenCalledWith(
      { object_id: 'storage-pg-1' },
      new Uint8Array([4, 5, 6]),
      'audio/webm;codecs=opus',
    );
    expect(store.threadAudioDrafts[0]).toMatchObject({
      title: 'Thread voice note',
      storage_object_id: 'storage-pg-1',
      media_encryption: null,
    });
  });

  it('materializes audio notes with matching group payload and storage access assumptions', async () => {
    const store = createStore({
      workspaceOwnerNpub: 'npub-workspace',
      signingNpub: 'npub-signer',
      session: { npub: 'npub-user' },
      audioNotes: [],
      currentWorkspaceContentGroups: [
        { group_id: 'shared-channel', member_npubs: ['npub-user'] },
        { group_id: 'private-channel', private_member_npub: 'npub-other' },
      ],
    });

    const result = await store.materializeAudioDrafts({
      drafts: [{
        title: 'Team voice note',
        storage_object_id: 'storage-1',
        mime_type: 'audio/webm;codecs=opus',
        duration_seconds: 12,
        size_bytes: 3,
        media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
      }],
      target_record_id: 'message-1',
      target_record_family_hash: recordFamilyHash('chat_message'),
      target_group_ids: ['shared-channel', 'private-channel'],
      write_group_ref: 'shared-channel',
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      kind: 'audio',
      title: 'Team voice note',
      duration_seconds: 12,
    });
    expect(mocks.upsertAudioNote).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub-workspace',
      target_record_id: 'message-1',
      target_record_family_hash: recordFamilyHash('chat_message'),
      group_ids: ['shared-channel'],
      sender_npub: 'npub-user',
      storage_object_id: 'storage-1',
    }));
    expect(mocks.outboundAudioNote).toHaveBeenCalledWith(expect.objectContaining({
      owner_npub: 'npub-workspace',
      target_record_id: 'message-1',
      target_record_family_hash: recordFamilyHash('chat_message'),
      target_group_ids: ['shared-channel'],
      signature_npub: 'npub-signer',
      write_group_ref: 'shared-channel',
    }));
    expect(mocks.addPendingWrite).toHaveBeenCalledWith(expect.objectContaining({
      record_family_hash: 'app:audio_note',
      envelope: expect.objectContaining({
        group_payloads: [{ group_id: 'shared-channel' }],
      }),
    }));
  });

  it('materializes PG audio notes through Tower without encrypted pending writes', async () => {
    mocks.isTowerPgBackendMode.mockReturnValue(true);
    mocks.createTowerPgChannelAudioNote.mockResolvedValue({
      audio_note: {
        id: 'audio-pg-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        storage_object_id: 'storage-1',
        title: 'Thread voice note',
        mime_type: 'audio/webm;codecs=opus',
        duration_seconds: 12,
        size_bytes: 3,
        media_encryption: {},
        waveform_preview: [],
        transcript_status: 'pending',
        record_state: 'active',
        row_version: 1,
      },
    });
    const store = createStore({
      backendUrl: 'https://tower.example',
      workspaceOwnerNpub: 'npub-workspace',
      session: { npub: 'npub-user' },
      selectedChannelId: 'channel-1',
      selectedBoardId: '',
      channels: [{ record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' }],
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub-workspace',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
    });

    const result = await store.materializeAudioDrafts({
      drafts: [{
        title: 'Thread voice note',
        storage_object_id: 'storage-1',
        mime_type: 'audio/webm;codecs=opus',
        duration_seconds: 12,
        size_bytes: 3,
        media_encryption: null,
      }],
      target_record_id: 'message-1',
      target_record_family_hash: recordFamilyHash('chat_message'),
      scopeId: 'scope-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
    });

    expect(mocks.createTowerPgChannelAudioNote).toHaveBeenCalledWith('workspace-1', 'channel-1', expect.objectContaining({
      storage_object_id: 'storage-1',
      thread_id: 'thread-1',
      target_type: 'message',
      target_id: 'message-1',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(mocks.outboundAudioNote).not.toHaveBeenCalled();
    expect(mocks.addPendingWrite).not.toHaveBeenCalled();
    expect(mocks.upsertAudioNote).toHaveBeenCalledWith(expect.objectContaining({
      record_id: 'audio-pg-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    }));
    expect(result.attachments[0]).toMatchObject({
      audio_note_record_id: 'audio-pg-1',
      title: 'Thread voice note',
    });
  });

  it('plays a group-visible voice note by downloading and decrypting the stored object', async () => {
    const audio = createAudioStub();
    const createObjectURL = vi.fn(() => 'blob:voice-note');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', vi.fn(() => audio));
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL,
      revokeObjectURL,
    });
    const encryptedBytes = new Uint8Array([9, 8, 7]);
    const decryptedBlob = new Blob(['voice'], { type: 'audio/webm;codecs=opus' });
    mocks.downloadStorageObject.mockResolvedValue(encryptedBytes);
    mocks.decryptAudioBytes.mockResolvedValue(decryptedBlob);

    const store = createStore({
      audioNotes: [{
        record_id: 'audio-1',
        storage_object_id: 'storage-1',
        media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
        mime_type: 'audio/webm;codecs=opus',
      }],
    });

    await store.playAudioAttachment({ kind: 'audio', audio_note_record_id: 'audio-1' });

    expect(mocks.downloadStorageObject).toHaveBeenCalledWith('storage-1');
    expect(mocks.decryptAudioBytes).toHaveBeenCalledWith(
      encryptedBytes,
      { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
      'audio/webm;codecs=opus',
    );
    expect(createObjectURL).toHaveBeenCalledWith(decryptedBlob);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('merges target-linked audio notes into comment audio attachments', () => {
    const store = createStore({
      audioNotes: [
        {
          record_id: 'audio-targeted',
          target_record_id: 'comment-1',
          target_record_family_hash: 'npub1app:comment',
          title: 'Spoken comment',
          duration_seconds: 14,
          record_state: 'active',
        },
        {
          record_id: 'audio-deleted',
          target_record_id: 'comment-1',
          target_record_family_hash: 'npub1app:comment',
          title: 'Deleted comment audio',
          record_state: 'deleted',
        },
      ],
    });

    const attachments = store.getAudioAttachmentsForRecord({
      record_id: 'comment-1',
      attachments: [{ kind: 'audio', audio_note_record_id: 'audio-existing', title: 'Existing audio' }],
    });

    expect(attachments).toEqual([
      { kind: 'audio', audio_note_record_id: 'audio-existing', title: 'Existing audio' },
      {
        kind: 'audio',
        audio_note_record_id: 'audio-targeted',
        title: 'Spoken comment',
        duration_seconds: 14,
      },
    ]);
  });

  it('shows a playback overlay with a scrubber and stop control', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    vi.stubGlobal('document', dom.window.document);
    const audio = createAudioStub();
    const createObjectURL = vi.fn(() => 'blob:voice-note');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', vi.fn(() => audio));
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL,
      revokeObjectURL,
    });
    mocks.downloadStorageObject.mockResolvedValue(new Uint8Array([9, 8, 7]));
    mocks.decryptAudioBytes.mockResolvedValue(new Blob(['voice'], { type: 'audio/webm;codecs=opus' }));

    const store = createStore({
      audioNotes: [{
        record_id: 'audio-1',
        storage_object_id: 'storage-1',
        media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
        mime_type: 'audio/webm;codecs=opus',
        title: 'TTS reply',
      }],
    });

    await store.playAudioAttachment({ kind: 'audio', audio_note_record_id: 'audio-1' });

    const modal = dom.window.document.querySelector('[data-testid="audio-playback-modal"]');
    const scrubber = dom.window.document.querySelector('[data-testid="audio-playback-scrubber"]');
    const stopButton = dom.window.document.querySelector('[data-testid="audio-playback-stop"]');
    expect(modal).not.toBeNull();
    expect(scrubber).not.toBeNull();
    expect(stopButton).not.toBeNull();

    scrubber.value = '12';
    scrubber.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(audio.currentTime).toBe(12);

    stopButton.click();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-note');
    expect(dom.window.document.querySelector('[data-testid="audio-playback-modal"]')).toBeNull();
  });

  it('refreshes audio notes before playback when the synced comment attachment arrives first', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Audio', vi.fn(() => ({ play })));
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL: vi.fn(() => 'blob:voice-note'),
      revokeObjectURL: vi.fn(),
    });
    mocks.downloadStorageObject.mockResolvedValue(new Uint8Array([9, 8, 7]));
    mocks.decryptAudioBytes.mockResolvedValue(new Blob(['voice'], { type: 'audio/webm;codecs=opus' }));
    const store = createStore({
      audioNotes: [],
      refreshAudioNotes: vi.fn(async function refreshAudioNotes() {
        this.audioNotes = [{
          record_id: 'audio-after-refresh',
          storage_object_id: 'storage-after-refresh',
          media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
          mime_type: 'audio/webm;codecs=opus',
        }];
      }),
    });

    await store.playAudioAttachment({ kind: 'audio', audio_note_record_id: 'audio-after-refresh' });

    expect(store.refreshAudioNotes).toHaveBeenCalledTimes(1);
    expect(mocks.downloadStorageObject).toHaveBeenCalledWith('storage-after-refresh');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('force-pulls audio notes before playback when the note is still missing after refresh', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Audio', vi.fn(() => ({ play })));
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL: vi.fn(() => 'blob:voice-note'),
      revokeObjectURL: vi.fn(),
    });
    mocks.downloadStorageObject.mockResolvedValue(new Uint8Array([9, 8, 7]));
    mocks.decryptAudioBytes.mockResolvedValue(new Blob(['voice'], { type: 'audio/webm;codecs=opus' }));
    const store = createStore({
      audioNotes: [],
      refreshAudioNotes: vi.fn(async function refreshAudioNotes() {
        if (this._audioNotePulled) {
          this.audioNotes = [{
            record_id: 'audio-after-pull',
            storage_object_id: 'storage-after-pull',
            media_encryption: { scheme: 'aes-gcm', key_b64: 'key', iv_b64: 'iv' },
            mime_type: 'audio/webm;codecs=opus',
          }];
        }
      }),
      pullFamiliesFromBackend: vi.fn(async function pullFamiliesFromBackend() {
        this._audioNotePulled = true;
      }),
    });

    await store.playAudioAttachment({ kind: 'audio', audio_note_record_id: 'audio-after-pull' });

    expect(store.refreshAudioNotes).toHaveBeenCalledTimes(2);
    expect(store.pullFamiliesFromBackend).toHaveBeenCalledWith(['audio_note'], { forceFull: true });
    expect(mocks.downloadStorageObject).toHaveBeenCalledWith('storage-after-pull');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable audio when the attachment note is not present locally or remotely', async () => {
    const store = createStore({
      audioNotes: [],
      refreshAudioNotes: vi.fn().mockResolvedValue(undefined),
      pullFamiliesFromBackend: vi.fn().mockResolvedValue(undefined),
    });

    await store.playAudioAttachment({ kind: 'audio', audio_note_record_id: 'missing-audio' });

    expect(store.refreshAudioNotes).toHaveBeenCalledTimes(2);
    expect(store.pullFamiliesFromBackend).toHaveBeenCalledWith(['audio_note'], { forceFull: true });
    expect(mocks.downloadStorageObject).not.toHaveBeenCalled();
    expect(store.error).toBe('Voice note is not available yet. Sync audio notes and try again.');
  });
});

it('stops voice-note batches after a workspace switch without writing or displaying the acceptance in the destination', async () => {
  mocks.isTowerPgBackendMode.mockReturnValue(true);
  const store = createStore({ backendUrl: 'https://tower.example', workspaceOwnerNpub: 'owner', session: { npub: 'viewer' },
    selectedChannelId: 'channel', channels: [{ record_id: 'channel', scope_id: 'scope' }],
    currentWorkspace: { workspaceId: 'source', directHttpsUrl: 'https://tower.example', appNpub: 'flightdeck_pg' } });
  mocks.createTowerPgChannelAudioNote.mockImplementationOnce(async () => {
    store.currentWorkspace = { workspaceId: 'destination', directHttpsUrl: 'https://other.test', appNpub: 'flightdeck_pg' };
    return { audio_note: { id: 'accepted-source', workspace_id: 'source', channel_id: 'channel', storage_object_id: 'voice-one' } };
  });
  await expect(store.materializeAudioDrafts({ drafts: [{ storage_object_id: 'voice-one' }, { storage_object_id: 'voice-two' }],
    target_record_id: 'message', target_record_family_hash: recordFamilyHash('chat_message'), scopeId: 'scope', channelId: 'channel' })).rejects.toThrow('original workspace');
  expect(mocks.createTowerPgChannelAudioNote).toHaveBeenCalledTimes(1);
  expect(mocks.upsertAudioNote).not.toHaveBeenCalled();
  expect(store.audioNotes).toEqual([]);
});
