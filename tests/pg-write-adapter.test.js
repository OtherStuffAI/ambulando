import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTowerPgAudioNoteFromLocal,
  createTowerPgDocCommentFromLocal,
  createTowerPgFileFolderFromLocal,
  createTowerPgDocFromLocal,
  createTowerPgFileFromLocal,
  createTowerPgMessageFromLocal,
  updateTowerPgMessageFromLocal,
  createTowerPgTaskCommentFromLocal,
  createTowerPgTaskFromLocal,
  archiveTowerPgThreadFromLocal,
  branchTowerPgThreadFromMessage,
  deleteTowerPgDocCommentFromLocal,
  deleteTowerPgMessageFromLocal,
  deleteTowerPgTaskFromLocal,
  deleteTowerPgThreadFromLocal,
  moveTowerPgDocFromLocal,
  moveTowerPgTaskFromLocal,
  resolveTowerPgTaskChannel,
  syncTowerPgTaskAssignments,
  updateTowerPgDocCommentFromLocal,
  updateTowerPgDocFromLocal,
  updateTowerPgFileFromLocal,
  updateTowerPgTaskFromLocal,
  updateTowerPgThreadTitleFromLocal,
} from '../src/pg-write-adapter.js';
import { recordFamilyHash } from '../src/translators/chat.js';

vi.mock('../src/api.js', () => ({
  acquireTowerPgEditLease: vi.fn(),
  archiveTowerPgThread: vi.fn(),
  assignTowerPgTask: vi.fn(),
  createTowerPgChannelAudioNote: vi.fn(),
  createTowerPgChannelDoc: vi.fn(),
  createTowerPgChannelFile: vi.fn(),
  createTowerPgChannelFileFolder: vi.fn(),
  createTowerPgChannelMessage: vi.fn(),
  createTowerPgThreadBranch: vi.fn(),
  createTowerPgChannelTask: vi.fn(),
  createTowerPgDocComment: vi.fn(),
  createTowerPgTaskComment: vi.fn(),
  deleteTowerPgDocComment: vi.fn(),
  deleteTowerPgTask: vi.fn(),
  deleteTowerPgMessage: vi.fn(),
  deleteTowerPgThread: vi.fn(),
  getTowerPgChannelAudioNotes: vi.fn(),
  getTowerPgChannelDocs: vi.fn(),
  getTowerPgChannelFiles: vi.fn(),
  getTowerPgChannelMessages: vi.fn(),
  getTowerPgChannelTasks: vi.fn(),
  getTowerPgTaskComments: vi.fn(),
  getTowerPgChannelThreads: vi.fn(),
  getTowerPgThread: vi.fn(),
  getTowerPgScopeChannels: vi.fn(),
  getTowerPgScopeTasks: vi.fn(),
  getTowerPgWorkspaceScopes: vi.fn(),
  moveTowerPgDoc: vi.fn(),
  moveTowerPgTask: vi.fn(),
  releaseTowerPgEditLease: vi.fn(),
  renewTowerPgEditLease: vi.fn(),
  updateTowerPgDoc: vi.fn(),
  updateTowerPgDocComment: vi.fn(),
  updateTowerPgFile: vi.fn(),
  updateTowerPgMessage: vi.fn(),
  updateTowerPgTask: vi.fn(),
  updateTowerPgTaskState: vi.fn(),
  updateTowerPgThread: vi.fn(),
  unassignTowerPgTask: vi.fn(),
}));

vi.mock('../src/message-instruction-signatures.js', () => ({
  buildAgentInstructionSignature: vi.fn(() => Promise.resolve({ signed_event_id: 'signature-1' })),
}));

function store(seed = {}) {
  return {
    backendUrl: 'https://tower.example',
    workspaceOwnerNpub: 'npub1owner',
    session: { npub: 'npub1operator-a' },
    selectedChannelId: 'channel-1',
    channels: [
      { record_id: 'channel-1', scope_id: 'scope-1', scope_l1_id: 'scope-1', record_state: 'active' },
      { record_id: 'channel-2', scope_id: 'scope-2', scope_l1_id: 'scope-2', record_state: 'active' },
    ],
    pgWorkspaceMembers: [
      { actor_id: 'actor-agent', npub: 'npub1agent' },
      { actor_id: 'actor-other', npub: 'npub1other' },
    ],
    getPgWorkspaceMemberActorId(npub) {
      return this.pgWorkspaceMembers.find((member) => member.npub === npub)?.actor_id || '';
    },
    currentWorkspace: {
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      pgBackendMode: true,
    },
    ...seed,
  };
}

describe('PG write adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the selected channel when it matches the task scope', () => {
    expect(resolveTowerPgTaskChannel(store(), { scope_id: 'scope-1' })).toMatchObject({
      record_id: 'channel-1',
    });
  });

  it('does not fall back to a different channel under the requested task scope', () => {
    expect(resolveTowerPgTaskChannel(store({ selectedChannelId: 'channel-1' }), { scope_id: 'scope-2' })).toBeNull();
  });

  it('creates a Tower PG task and maps the accepted response', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'new',
        priority: 'sand',
        row_version: 1,
      },
    });

    const task = await createTowerPgTaskFromLocal(store(), {
      title: 'Task',
      description: '',
      state: 'new',
      priority: 'sand',
      scope_id: 'scope-1',
    });

    expect(api.createTowerPgChannelTask).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      title: 'Task',
      description: null,
      mentions: [],
      state: 'new',
      priority: 'sand',
      thread_id: null,
      metadata: expect.objectContaining({ board_order: null, tags: '' }),
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(task).toMatchObject({ record_id: 'task-1', pg_channel_id: 'channel-1' });
  });

  it('stores classic quick task fields and assignee npub in PG task metadata on create', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelTask.mockResolvedValue({
      task: {
        id: 'task-quick',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'new',
        priority: 'sand',
        metadata: {
          scheduled_for: '2026-06-22',
          assigned_to_npub: 'npub1agent',
          tags: 'ops,urgent',
          predecessor_task_ids: ['task-prev'],
        },
        row_version: 1,
      },
    });

    await createTowerPgTaskFromLocal(store(), {
      title: 'Task',
      scope_id: 'scope-1',
      parent_task_id: 'task-parent',
      scheduled_for: '2026-06-22',
      assigned_to_npubs: ['npub1agent'],
      tags: 'ops,urgent',
      predecessor_task_ids: ['task-prev'],
    });

    expect(api.createTowerPgChannelTask).toHaveBeenCalledWith('workspace-1', 'channel-1', expect.objectContaining({
      metadata: expect.objectContaining({
        parent_task_id: 'task-parent',
        scheduled_for: '2026-06-22',
        assigned_to_npub: 'npub1agent',
        tags: 'ops,urgent',
        predecessor_task_ids: ['task-prev'],
      }),
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.assignTowerPgTask).not.toHaveBeenCalled();
  });

  it('passes PG thread context when creating a Tower PG task', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelTask.mockResolvedValue({
      task: {
        id: 'task-thread',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        title: 'Task',
        state: 'new',
        priority: 'sand',
        row_version: 1,
      },
    });

    await createTowerPgTaskFromLocal(store(), {
      title: 'Task',
      scope_id: 'scope-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    });

    expect(api.createTowerPgChannelTask).toHaveBeenCalledWith('workspace-1', 'channel-1', expect.objectContaining({
      thread_id: 'thread-1',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
  });

  it('rejects PG task creation when an explicit channel mismatches the task scope', async () => {
    await expect(createTowerPgTaskFromLocal(store({ selectedChannelId: 'channel-1' }), {
      title: 'Task',
      scope_id: 'scope-2',
      pg_channel_id: 'channel-1',
    })).rejects.toThrow('Selected PG channel does not belong to the requested scope');
  });

  it('creates Tower PG docs with selected channel and metadata thread context', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelDoc.mockResolvedValue({
      doc: {
        id: 'doc-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'storage-doc',
        title: 'Doc',
        metadata: { thread_id: 'thread-1' },
        row_version: 1,
      },
    });

    const doc = await createTowerPgDocFromLocal(store(), {
      title: 'Doc',
      content_storage_object_id: 'storage-doc',
      scope_id: 'scope-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
    });

    expect(api.createTowerPgChannelDoc).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      title: 'Doc',
      storage_object_id: 'storage-doc',
      summary: null,
      mentions: [],
      metadata: { thread_id: 'thread-1', mentions: [] },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(doc).toMatchObject({ record_id: 'doc-1', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1' });
  });

  it('creates Tower PG files with selected channel and metadata thread context', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelFile.mockResolvedValue({
      file: {
        id: 'file-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        folder_id: 'folder-1',
        storage_object_id: 'storage-file',
        display_name: 'File.pdf',
        metadata: { thread_id: 'thread-1' },
        row_version: 1,
      },
    });

    const file = await createTowerPgFileFromLocal(store(), {
      display_name: 'File.pdf',
      storage_object_id: 'storage-file',
      scope_id: 'scope-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      folder_id: 'folder-1',
    });

    expect(api.createTowerPgChannelFile).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      storage_object_id: 'storage-file',
      folder_id: 'folder-1',
      display_name: 'File.pdf',
      description: null,
      metadata: { thread_id: 'thread-1' },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(file).toMatchObject({ record_id: 'file-1', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1', pg_folder_id: 'folder-1' });
  });

  it('creates Tower PG file folders inside the selected channel', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelFileFolder.mockResolvedValue({
      folder: {
        id: 'folder-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        parent_folder_id: null,
        title: 'Assets',
        metadata: {},
        row_version: 1,
      },
    });

    const folder = await createTowerPgFileFolderFromLocal(store(), {
      title: 'Assets',
      scope_id: 'scope-1',
      channel_id: 'channel-1',
    });

    expect(api.createTowerPgChannelFileFolder).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      title: 'Assets',
      parent_folder_id: null,
      metadata: {},
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(folder).toMatchObject({ record_id: 'folder-1', scope_id: 'scope-1', channel_id: 'channel-1' });
  });

  it('rejects PG file creation when the selected channel mismatches the requested scope', async () => {
    await expect(createTowerPgFileFromLocal(store({ selectedChannelId: 'channel-1' }), {
      display_name: 'File.pdf',
      storage_object_id: 'storage-file',
      scope_id: 'scope-2',
      pg_channel_id: 'channel-1',
    })).rejects.toThrow('Selected PG channel does not belong to the requested scope');
  });

  it('updates Tower PG files with a new channel and row version', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgFile.mockResolvedValue({
      file: {
        id: 'file-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-2',
        channel_id: 'channel-2',
        folder_id: null,
        storage_object_id: 'storage-file',
        display_name: 'File.pdf',
        metadata: {},
        row_version: 6,
      },
    });

    const file = await updateTowerPgFileFromLocal(store(), {
      record_id: 'file-1',
      title: 'File.pdf',
      pg_record_type: 'file',
      pg_storage_object_id: 'storage-file',
      scope_id: 'scope-2',
      pg_channel_id: 'channel-2',
      pg_folder_id: null,
      version: 5,
    }, {
      version: 4,
    });

    expect(api.updateTowerPgFile).toHaveBeenCalledWith('workspace-1', 'file-1', {
      row_version: 4,
      channel_id: 'channel-2',
      folder_id: null,
      display_name: 'File.pdf',
      description: null,
      metadata: {},
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(file).toMatchObject({ record_id: 'file-1', pg_channel_id: 'channel-2', version: 6 });
  });

  it('creates Tower PG audio notes with selected channel and first-class thread context', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelAudioNote.mockResolvedValue({
      audio_note: {
        id: 'audio-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        storage_object_id: 'storage-audio',
        title: 'Voice note',
        mime_type: 'audio/webm',
        size_bytes: 3,
        row_version: 1,
      },
    });

    const audio = await createTowerPgAudioNoteFromLocal(store(), {
      title: 'Voice note',
      storage_object_id: 'storage-audio',
      mime_type: 'audio/webm',
      size_bytes: 3,
      scope_id: 'scope-1',
      pg_channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      target_record_family_hash: recordFamilyHash('chat_message'),
      target_record_id: 'message-1',
    });

    const body = api.createTowerPgChannelAudioNote.mock.calls[0][2];
    expect(api.createTowerPgChannelAudioNote).toHaveBeenCalledWith('workspace-1', 'channel-1', expect.objectContaining({
      storage_object_id: 'storage-audio',
      thread_id: 'thread-1',
      target_type: 'message',
      target_id: 'message-1',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(body).not.toHaveProperty('transcript_preview');
    expect(body).not.toHaveProperty('summary');
    expect(audio).toMatchObject({ record_id: 'audio-1', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1' });
  });

  it('uses the state endpoint for state-only task patches', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTaskState.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'done',
        priority: 'sand',
        row_version: 2,
      },
    });

    const task = await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      state: 'done',
      priority: 'sand',
      version: 2,
    }, { record_id: 'task-1', version: 1, pg_backend: true, sync_status: 'synced' }, { state: 'done' });

    expect(api.updateTowerPgTaskState).toHaveBeenCalledWith('workspace-1', 'task-1', {
      row_version: 1,
      state: 'done',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(task).toMatchObject({ record_id: 'task-1', state: 'done', version: 2 });
  });

  it('round-trips blocked through the Tower PG state endpoint', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTaskState.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'blocked',
        priority: 'sand',
        row_version: 2,
      },
    });

    const task = await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      state: 'blocked',
      priority: 'sand',
      version: 2,
    }, { record_id: 'task-1', state: 'in_progress', version: 1, pg_backend: true, sync_status: 'synced' }, { state: 'blocked' });

    expect(api.updateTowerPgTaskState).toHaveBeenCalledWith('workspace-1', 'task-1', {
      row_version: 1,
      state: 'blocked',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(task).toMatchObject({ record_id: 'task-1', state: 'blocked', version: 2 });
  });

  it('splits PG task state changes from classic metadata quick patches', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTaskState.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'archive',
        priority: 'sand',
        row_version: 2,
      },
    });
    api.updateTowerPgTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'archive',
        priority: 'sand',
        metadata: { scheduled_for: '2026-06-22', tags: '' },
        row_version: 3,
      },
    });

    const task = await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      state: 'archive',
      priority: 'sand',
      assigned_to_npubs: [],
      scheduled_for: '2026-06-22',
      version: 2,
    }, { record_id: 'task-1', version: 1, pg_backend: true, sync_status: 'synced', assigned_to_npubs: ['npub1agent'] }, {
      state: 'archive',
      assigned_to_npubs: [],
      scheduled_for: '2026-06-22',
    });

    expect(api.updateTowerPgTaskState).toHaveBeenCalledWith('workspace-1', 'task-1', {
      row_version: 1,
      state: 'archive',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.updateTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', expect.objectContaining({
      row_version: 2,
      metadata: expect.objectContaining({
        scheduled_for: '2026-06-22',
      }),
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.updateTowerPgTask.mock.calls[0][2].metadata.assigned_to_npub).toBeNull();
    expect(api.unassignTowerPgTask).not.toHaveBeenCalled();
    expect(task).toMatchObject({ record_id: 'task-1', state: 'archive', version: 3, scheduled_for: '2026-06-22' });
  });

  it('patches a PG task assignee as a metadata npub string', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'new',
        priority: 'sand',
        metadata: { assigned_to_npub: 'npub1agent' },
        row_version: 2,
      },
    });

    const task = await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      state: 'new',
      priority: 'sand',
      assigned_to_npub: 'npub1agent',
      version: 2,
    }, {
      record_id: 'task-1',
      version: 1,
      pg_backend: true,
      sync_status: 'synced',
    }, { assigned_to_npub: 'npub1agent' });

    expect(api.updateTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', expect.objectContaining({
      row_version: 1,
      metadata: expect.objectContaining({ assigned_to_npub: 'npub1agent' }),
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.assignTowerPgTask).not.toHaveBeenCalled();
    expect(task).toMatchObject({
      assigned_to_npub: 'npub1agent',
      assigned_to_npubs: ['npub1agent'],
    });
  });

  it('does not synthesize task or assignment updates for an unchanged re-save', async () => {
    const api = await import('../src/api.js');
    const unchanged = {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      description: '@[Agent](mention:agent:npub1agent)',
      assigned_to_npubs: ['npub1agent'],
      version: 4,
    };

    const accepted = await updateTowerPgTaskFromLocal(store(), unchanged, unchanged, {});

    expect(api.updateTowerPgTask).not.toHaveBeenCalled();
    expect(api.assignTowerPgTask).not.toHaveBeenCalled();
    expect(api.unassignTowerPgTask).not.toHaveBeenCalled();
    expect(accepted.assigned_to_npubs).toEqual(['npub1agent']);
  });

  it('saves description mentions and assignment together in one task write', async () => {
    const api = await import('../src/api.js');
    const order = [];
    api.updateTowerPgTask.mockImplementation(async (_workspaceId, _taskId, body) => {
      order.push('task');
      return { task: { id: 'task-1', title: 'Task', description: body.description, metadata: body.metadata, row_version: 2 } };
    });
    api.assignTowerPgTask.mockImplementation(async () => { order.push('assignment'); return { changed: true }; });

    await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1', title: 'Task', description: '@[Agent](mention:agent:npub1agent)',
      assigned_to_npubs: ['npub1agent'], version: 2,
    }, { record_id: 'task-1', title: 'Task', description: '', assigned_to_npubs: [], version: 1 }, {
      description: '@[Agent](mention:agent:npub1agent)', assigned_to_npubs: ['npub1agent'],
    });

    expect(api.updateTowerPgTask.mock.calls[0][2].mentions).toEqual([
      { type: 'agent', npub: 'npub1agent', label: 'Agent' },
    ]);
    expect(order).toEqual(['task']);
    expect(api.updateTowerPgTask.mock.calls[0][2].metadata.assigned_to_npub).toBe('npub1agent');
  });

  it('clears a PG task assignment without needing the former actor in the local cache', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Task',
        state: 'new',
        priority: 'sand',
        metadata: { assigned_to_npub: null },
        row_version: 2,
      },
    });

    const testStore = store({ pgWorkspaceMembers: [] });
    await expect(updateTowerPgTaskFromLocal(testStore, {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Task',
      state: 'new',
      priority: 'sand',
      assigned_to_npubs: [],
      version: 2,
    }, {
      record_id: 'task-1',
      version: 1,
      pg_backend: true,
      sync_status: 'synced',
      assigned_to_npubs: ['npub1agent'],
    }, { assigned_to_npubs: [] })).resolves.toMatchObject({ assigned_to_npub: null, assigned_to_npubs: [] });

    expect(api.updateTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', expect.objectContaining({
      metadata: expect.objectContaining({ assigned_to_npub: null }),
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.assignTowerPgTask).not.toHaveBeenCalled();
    expect(api.unassignTowerPgTask).not.toHaveBeenCalled();
  });

  it('adds row version to synced task save payloads without requiring a task edit lease', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Edited',
        state: 'new',
        priority: 'sand',
        row_version: 3,
      },
    });

    await updateTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Edited',
      description: 'Body',
      state: 'new',
      priority: 'sand',
      version: 3,
    }, { version: 2, pg_backend: true, sync_status: 'synced' }, { title: 'Edited' });

    expect(api.updateTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', expect.objectContaining({
      row_version: 2,
      title: 'Edited',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
  });

  it('uses one canonical replacement command and rejects multiple assignees before transport', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgTask.mockResolvedValue({task:{id:'task-1',assigned_to_npub:'npub1new',metadata:{assigned_to_npub:'npub1new'}}});
    const row = await syncTowerPgTaskAssignments(store(), 'task-1', ['npub1old'], ['npub1new']);
    expect(api.updateTowerPgTask).toHaveBeenCalledTimes(1);
    expect(api.updateTowerPgTask.mock.calls[0][2]).toEqual({assigned_to_npub:'npub1new'});
    expect(row.assigned_to_npubs).toEqual(['npub1new']);
    expect(api.assignTowerPgTask).not.toHaveBeenCalled();expect(api.unassignTowerPgTask).not.toHaveBeenCalled();
    await expect(syncTowerPgTaskAssignments(store(),'task-1',[],['npub1a','npub1b'])).rejects.toThrow('zero or one');
    expect(api.updateTowerPgTask).toHaveBeenCalledTimes(1);
  });
  it('deletes Tower PG tasks through the typed delete endpoint', async () => {
    const api = await import('../src/api.js');
    api.deleteTowerPgTask.mockResolvedValue({
      task: {
        id: 'task-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        title: 'Deleted',
        state: 'new',
        priority: 'sand',
        row_version: 4,
      },
    });

    const task = await deleteTowerPgTaskFromLocal(store(), {
      record_id: 'task-1',
      pg_backend: true,
      sync_status: 'synced',
      version: 3,
    });

    expect(api.deleteTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', {
      rowVersion: 3,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(task).toMatchObject({ record_id: 'task-1', version: 4, pg_channel_id: 'channel-1' });
  });

  it('sends exact document base identity and lease without combining a body save with channel movement', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgDoc.mockResolvedValue({
      doc: {
        id: 'doc-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        storage_object_id: 'storage-doc',
        title: 'Doc edited',
        row_version: 5,
      },
    });

    await updateTowerPgDocFromLocal(store({
      pgEditLeaseSessions: {
        'document:doc-1': { lease: { lease_token: 'doc-lease-token' } },
      },
    }), {
      record_id: 'doc-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Doc edited',
      content: 'Body',
      pg_channel_id: 'channel-1',
      content_storage_object_id: 'storage-doc',
      pg_save_base_row_version: 4,
      pg_save_base_version_id: 'doc-1:4',
      pg_save_base_body_sha256_hex: 'a'.repeat(64),
      pg_save_base_available: true,
      version: 5,
    }, {
      record_id: 'doc-1',
      pg_backend: true,
      sync_status: 'synced',
      version: 4,
    });

    expect(api.updateTowerPgDoc).toHaveBeenCalledWith('workspace-1', 'doc-1', expect.objectContaining({
      row_version: 4,
      base_available: true,
      base_version_id: 'doc-1:4',
      base_body_sha256_hex: 'a'.repeat(64),
      lease_token: 'doc-lease-token',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.updateTowerPgDoc.mock.calls[0][2]).not.toHaveProperty('channel_id');
  });

  it('submits no-base document recovery saves without an edit lease', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgDoc.mockResolvedValue({ doc: { id: 'doc-1', row_version: 4 } });

    await updateTowerPgDocFromLocal(store({ pgEditLeaseSessions: {} }), {
      record_id: 'doc-1',
      pg_backend: true,
      sync_status: 'synced',
      title: 'Recovered body',
      content: 'Recovered body',
      content_storage_object_id: 'storage-recovery',
      pg_save_base_available: false,
      pg_save_requires_lease: false,
      version: 4,
    }, {
      record_id: 'doc-1',
      pg_backend: true,
      sync_status: 'synced',
      version: 4,
    });

    expect(api.updateTowerPgDoc).toHaveBeenCalledWith('workspace-1', 'doc-1', expect.objectContaining({
      row_version: 4,
      base_available: false,
      storage_object_id: 'storage-recovery',
    }), { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.updateTowerPgDoc.mock.calls[0][2]).not.toHaveProperty('lease_token');
  });

  it('creates Tower PG thread messages and maps the returned message', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        body: 'Hello',
        row_version: 1,
      },
      thread: {
        id: 'thread-1',
        source_message_id: 'message-1',
      },
    });

    const message = await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-1',
      channel_id: 'channel-1',
      body: 'Hello',
      pg_thread_title: 'Explicit first ten words',
      pg_client_request_id: 'create-thread-attempt-1',
    });

    expect(api.createTowerPgChannelMessage).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      body: 'Hello',
      message_signature: { signed_event_id: 'signature-1' },
      metadata: { client_record_id: 'local-message-1' },
      client_request_id: 'create-thread-attempt-1',
      create_thread: true,
      thread_title: 'Explicit first ten words',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(message).toMatchObject({ record_id: 'message-1', parent_message_id: null, pg_thread_id: 'thread-1' });
  });

  it('rechecks diagnostic consent after instruction signing and never posts a revoked report', async () => {
    const api = await import('../src/api.js');
    const signatures = await import('../src/message-instruction-signatures.js');
    const guard = vi.fn(async () => { throw new Error('Diagnostic consent revoked during signing'); });
    await expect(createTowerPgMessageFromLocal(store(), { record_id: 'diagnostic-1', channel_id: 'channel-1', body: 'Evaluate untrusted evidence' },
      { assertCanSend: guard })).rejects.toThrow('revoked during signing');
    expect(signatures.buildAgentInstructionSignature).toHaveBeenCalled();
    expect(guard).toHaveBeenCalledOnce();
    expect(api.createTowerPgChannelMessage).not.toHaveBeenCalled();
  });

  it('creates an empty child thread without posting a message', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgThreadBranch.mockResolvedValue({ thread: {
      id: 'child-thread', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
      source_message_id: null, parent_thread_id: 'parent-thread', branch_point_message_id: 'message-2',
      client_request_id: 'branch:attempt-1', metadata: { inherited_agent_recipient_npub: 'npub1agent' }, row_version: 1,
    } });
    const child = await branchTowerPgThreadFromMessage(store(), {
      record_id: 'message-2', channel_id: 'channel-1', pg_thread_id: 'parent-thread',
    }, { clientRequestId: 'branch:attempt-1', recipientNpub: 'npub1agent' });

    expect(api.createTowerPgThreadBranch).toHaveBeenCalledWith('workspace-1', 'channel-1', 'parent-thread', {
      branch_point_message_id: 'message-2', client_request_id: 'branch:attempt-1',
      metadata: { source: 'flightdeck_branch', inherited_agent_recipient_npub: 'npub1agent' },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(api.createTowerPgChannelMessage).not.toHaveBeenCalled();
    expect(child).toMatchObject({ record_id: 'child-thread', pg_parent_thread_id: 'parent-thread', pg_branch_point_message_id: 'message-2' });
  });

  it('passes a stable client request id when creating a reply in an existing thread', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'reply-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        thread_id: 'thread-1', body: 'Reply', row_version: 1,
      },
    });

    await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-reply-1',
      channel_id: 'channel-1',
      parent_message_id: 'root-1',
      pg_thread_id: 'thread-1',
      pg_client_request_id: 'reply-attempt-1',
      body: 'Reply',
    }, {
      parentMessage: { record_id: 'root-1', pg_thread_id: 'thread-1' },
    });

    expect(api.createTowerPgChannelMessage).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      body: 'Reply',
      message_signature: { signed_event_id: 'signature-1' },
      metadata: { client_record_id: 'local-reply-1' },
      client_request_id: 'reply-attempt-1',
      thread_id: 'thread-1',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
  });

  it('preserves an internal Agent Direct recipient without creating mention metadata', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'reply-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        thread_id: 'child-thread', body: 'Try a different approach', row_version: 1,
      },
    });

    await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-reply-1',
      channel_id: 'channel-1',
      parent_message_id: 'child-thread',
      pg_thread_id: 'child-thread',
      pg_client_request_id: 'reply-attempt-1',
      body: 'Try a different approach',
      pg_metadata: { agent_direct_recipient_npub: 'npub1agent' },
    }, {
      parentMessage: { record_id: 'child-thread', pg_thread_id: 'child-thread' },
    });

    const payload = api.createTowerPgChannelMessage.mock.calls[0][2];
    expect(payload.metadata).toEqual({
      agent_direct_recipient_npub: 'npub1agent',
      client_record_id: 'local-reply-1',
    });
    expect(payload.metadata).not.toHaveProperty('mentions');
  });

  it('renames Tower PG threads with the thread row version and preserves the local source message', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgThread.mockResolvedValue({ thread: { id: 'thread-1', title: 'Renamed thread', row_version: 4, updated_at: '2026-07-26T10:00:00.000Z' } });
    const updated = await updateTowerPgThreadTitleFromLocal(store(), {
      record_id: 'message-1',
      pg_thread_id: 'thread-1',
      pg_thread_version: 3,
      pg_backend: true,
      body: 'Original message body',
    }, '  Renamed thread  ');
    expect(api.updateTowerPgThread).toHaveBeenCalledWith('workspace-1', 'thread-1', {
      title: 'Renamed thread',
      row_version: 3,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(updated).toMatchObject({ record_id: 'message-1', body: 'Original message body', title: 'Renamed thread', pg_thread_version: 4 });
  });

  it('refreshes a stale thread row version and retries the intended title exactly once', async () => {
    const api = await import('../src/api.js');
    const stale = Object.assign(new Error('Thread row_version is stale'), {
      status: 409,
      code: 'stale_row_version',
    });
    api.updateTowerPgThread
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({
        thread: { id: 'thread-1', title: 'Intended title', row_version: 6, updated_at: '2026-07-27T01:00:00.000Z' },
      });
    api.getTowerPgThread.mockResolvedValue({
      thread: { id: 'thread-1', title: 'Server title', row_version: 5 },
    });

    const updated = await updateTowerPgThreadTitleFromLocal(store(), {
      record_id: 'thread-1',
      pg_thread_id: 'thread-1',
      pg_thread_version: 3,
      version: 3,
      pg_backend: true,
      pg_record_type: 'thread',
      title: 'Old local title',
    }, 'Intended title');

    expect(api.getTowerPgThread).toHaveBeenCalledOnce();
    expect(api.updateTowerPgThread).toHaveBeenCalledTimes(2);
    expect(api.updateTowerPgThread.mock.calls.map((call) => call[2])).toEqual([
      { title: 'Intended title', row_version: 3 },
      { title: 'Intended title', row_version: 5 },
    ]);
    expect(updated).toMatchObject({ title: 'Intended title', version: 6, pg_thread_version: 6 });
  });

  it('keeps a second stale thread-title conflict visible without another refresh or retry', async () => {
    const api = await import('../src/api.js');
    const firstStale = Object.assign(new Error('First conflict'), { code: 'stale_row_version' });
    const secondStale = Object.assign(new Error('Second conflict'), { code: 'stale_row_version' });
    api.updateTowerPgThread.mockRejectedValueOnce(firstStale).mockRejectedValueOnce(secondStale);
    api.getTowerPgThread.mockResolvedValue({ thread: { id: 'thread-1', row_version: 4 } });

    await expect(updateTowerPgThreadTitleFromLocal(store(), {
      record_id: 'message-1', pg_thread_id: 'thread-1', pg_thread_version: 2,
    }, 'Intended title')).rejects.toBe(secondStale);
    expect(api.getTowerPgThread).toHaveBeenCalledOnce();
    expect(api.updateTowerPgThread).toHaveBeenCalledTimes(2);
  });

  it('keeps unrelated thread-title failures visible without refreshing or retrying', async () => {
    const api = await import('../src/api.js');
    const failure = Object.assign(new Error('Permission denied'), { status: 403, code: 'forbidden' });
    api.updateTowerPgThread.mockRejectedValueOnce(failure);

    await expect(updateTowerPgThreadTitleFromLocal(store(), {
      record_id: 'message-1', pg_thread_id: 'thread-1', pg_thread_version: 2,
    }, 'Intended title')).rejects.toBe(failure);
    expect(api.getTowerPgThread).not.toHaveBeenCalled();
    expect(api.updateTowerPgThread).toHaveBeenCalledOnce();
  });

  it('creates Tower PG messages with the local client record id in metadata', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        body: 'Hello',
        row_version: 1,
        metadata: {
          client_record_id: 'local-message-1',
        },
      },
      thread: {
        id: 'thread-1',
        source_message_id: 'message-1',
      },
    });

    const message = await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-1',
      channel_id: 'channel-1',
      body: 'Hello',
    });

    expect(api.createTowerPgChannelMessage.mock.calls[0][2]).toMatchObject({
      metadata: { client_record_id: 'local-message-1' },
    });
    expect(message).toMatchObject({
      record_id: 'message-1',
      pg_client_record_id: 'local-message-1',
    });
  });

  it('preserves canonical mentions alongside existing PG message metadata', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-mention', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        thread_id: 'thread-mention', body: 'Mention Test Agent', row_version: 1,
        metadata: { mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Test Agent' }] },
      },
      thread: { id: 'thread-mention', source_message_id: 'message-mention' },
    });

    await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-mention',
      channel_id: 'channel-1',
      body: 'Mention Test Agent',
      pg_metadata: { mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Test Agent' }] },
    });

    expect(api.createTowerPgChannelMessage.mock.calls[0][2].metadata).toEqual({
      mentions: [{ type: 'agent', npub: 'npub1agent', label: 'Test Agent' }],
      client_record_id: 'local-message-mention',
    });
  });

  it('serializes storage-backed file attachments into durable PG message metadata', async () => {
    const api = await import('../src/api.js');
    const attachment = {
      kind: 'file',
      storage_object_id: 'storage-file-1',
      filename: 'brief.pdf',
      content_type: 'application/pdf',
      size_bytes: 4096,
    };
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-file', channel_id: 'channel-1', thread_id: 'thread-file', body: '', row_version: 1,
        metadata: { attachments: [attachment] },
      },
      thread: { id: 'thread-file', source_message_id: 'message-file' },
    });

    const message = await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-file',
      channel_id: 'channel-1',
      body: '',
      attachments: [attachment],
    });

    expect(api.createTowerPgChannelMessage.mock.calls[0][2].metadata).toEqual({
      attachments: [attachment],
      client_record_id: 'local-message-file',
    });
    expect(message.attachments).toEqual([attachment]);
  });

  it('does not submit storage Markdown with empty PG attachment metadata', async () => {
    const api = await import('../src/api.js');
    const body = '[Good_Stuff_65-final.txt](storage://6502a11c-575d-4dc7-9581-29a5011661c3)';
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-storage-link', channel_id: 'channel-1', thread_id: 'thread-storage-link', body, row_version: 1,
        metadata: {
          attachments: [{
            kind: 'file',
            storage_object_id: '6502a11c-575d-4dc7-9581-29a5011661c3',
            filename: 'Good_Stuff_65-final.txt',
          }],
        },
      },
      thread: { id: 'thread-storage-link', source_message_id: 'message-storage-link' },
    });

    await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-storage-link',
      channel_id: 'channel-1',
      body,
      attachments: [],
    });

    expect(api.createTowerPgChannelMessage.mock.calls[0][2].metadata.attachments).toEqual([{
      kind: 'file',
      storage_object_id: '6502a11c-575d-4dc7-9581-29a5011661c3',
      filename: 'Good_Stuff_65-final.txt',
    }]);
  });

  it('uses canonical message metadata as the only PG image association contract', async () => {
    const api = await import('../src/api.js');
    const attachment = {
      kind: 'image',
      storage_object_id: 'storage-image-1',
      filename: 'screenshot.png',
      content_type: 'image/png',
      size_bytes: 2048,
    };
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'message-image', channel_id: 'channel-1', thread_id: 'thread-image', body: '', row_version: 1,
        metadata: { attachments: [attachment] },
      },
      thread: { id: 'thread-image', source_message_id: 'message-image' },
      attachment_links: [{ storage_object_id: attachment.storage_object_id }],
    });

    await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-message-image', channel_id: 'channel-1', body: '', attachments: [attachment],
    });

    const payload = api.createTowerPgChannelMessage.mock.calls[0][2];
    expect(payload.metadata.attachments).toEqual([attachment]);
    expect(payload.metadata).not.toHaveProperty('access_group_ids');
    expect(payload.metadata).not.toHaveProperty('owner_group_id');
    expect(payload.metadata).not.toHaveProperty('is_public');
  });

  it('revises a Tower PG message with the complete mention set and next-revision signature context', async () => {
    const api = await import('../src/api.js');
    const signatures = await import('../src/message-instruction-signatures.js');
    api.updateTowerPgMessage.mockResolvedValue({
      message: {
        id: 'message-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        thread_id: 'thread-1', body: 'Revised', row_version: 4,
        created_by_actor_npub: 'npub1operator-a',
        metadata: { mentions: [{ type: 'agent', actor_id: 'actor-testagent', npub: 'npub1testagent', label: 'Test Agent' }] },
        created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:05:00.000Z',
      },
    });

    const revised = await updateTowerPgMessageFromLocal(store(), {
      record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', version: 3,
    }, {
      body: 'Revised',
      mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
    });

    expect(signatures.buildAgentInstructionSignature).toHaveBeenCalledWith({
      body: 'Revised',
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
      revision: 4,
    });
    expect(api.updateTowerPgMessage).toHaveBeenCalledWith('workspace-1', 'message-1', {
      body: 'Revised',
      row_version: 3,
      mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
      message_signature: { signed_event_id: 'signature-1' },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(revised).toMatchObject({
      record_id: 'message-1', body: 'Revised', version: 4, sender_npub: 'npub1operator-a', parent_message_id: null,
      pg_metadata: { mentions: [{ type: 'agent', actor_id: 'actor-testagent', npub: 'npub1testagent', label: 'Test Agent' }] },
    });
  });

  it('preserves the local thread parent when revising a reply', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgMessage.mockResolvedValue({
      message: {
        id: 'reply-1', workspace_id: 'workspace-1', scope_id: 'scope-1', channel_id: 'channel-1',
        thread_id: 'thread-1', body: 'Revised reply', row_version: 2,
      },
    });

    const revised = await updateTowerPgMessageFromLocal(store(), {
      record_id: 'reply-1', channel_id: 'channel-1', parent_message_id: 'root-1',
      pg_thread_id: 'thread-1', version: 1,
    }, { body: 'Revised reply', mentions: [] });

    expect(revised.parent_message_id).toBe('root-1');
  });

  it('maps Tower PG replies to the local thread parent when the response omits thread metadata', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgChannelMessage.mockResolvedValue({
      message: {
        id: 'reply-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        body: 'Reply',
        row_version: 1,
      },
    });

    const message = await createTowerPgMessageFromLocal(store(), {
      record_id: 'local-reply-1',
      channel_id: 'channel-1',
      body: 'Reply',
    }, {
      parentMessage: {
        record_id: 'root-message-1',
        pg_thread_id: 'thread-1',
      },
    });

    expect(api.createTowerPgChannelMessage).toHaveBeenCalledWith('workspace-1', 'channel-1', {
      body: 'Reply',
      message_signature: { signed_event_id: 'signature-1' },
      metadata: { client_record_id: 'local-reply-1' },
      thread_id: 'thread-1',
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(message).toMatchObject({
      record_id: 'reply-1',
      parent_message_id: 'root-message-1',
      pg_thread_id: 'thread-1',
    });
  });

  it('rejects PG replies before writing when no thread id can be resolved', async () => {
    const api = await import('../src/api.js');

    await expect(createTowerPgMessageFromLocal(store(), {
      record_id: 'local-reply-1',
      channel_id: 'channel-1',
      parent_message_id: 'root-message-1',
      body: 'Reply',
    }, {
      parentMessage: {
        record_id: 'root-message-1',
      },
    })).rejects.toThrow('Tower PG reply thread id is missing');

    expect(api.createTowerPgChannelMessage).not.toHaveBeenCalled();
  });

  it('retries message delete against the accepted PG row when a stale client id is missing', async () => {
    const api = await import('../src/api.js');
    const missing = new Error('Flight Deck PG message not found');
    missing.status = 404;
    missing.code = 'message_not_found';
    api.deleteTowerPgMessage
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({
        message: {
          id: 'server-message-1',
          workspace_id: 'workspace-1',
          channel_id: 'channel-1',
          body: 'Delete me',
          record_state: 'deleted',
          row_version: 3,
          metadata: {
            client_record_id: 'local-message-1',
          },
        },
      });

    const message = await deleteTowerPgMessageFromLocal(store({
      messages: [
        {
          record_id: 'server-message-1',
          channel_id: 'channel-1',
          body: 'Delete me',
          version: 2,
          record_state: 'active',
          pg_backend: true,
          pg_client_record_id: 'local-message-1',
        },
      ],
    }), {
      record_id: 'local-message-1',
      channel_id: 'channel-1',
      body: 'Delete me',
      version: 1,
      pg_backend: true,
    });

    expect(api.deleteTowerPgMessage.mock.calls.map((call) => call[1])).toEqual([
      'local-message-1',
      'server-message-1',
    ]);
    expect(message).toMatchObject({
      record_id: 'server-message-1',
      record_state: 'deleted',
      pg_client_record_id: 'local-message-1',
    });
  });

  it('creates Tower PG task comments and maps the accepted comment', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgTaskComment.mockResolvedValue({
      comment: {
        id: 'comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        task_id: 'task-1',
        thread_id: 'thread-1',
        body: 'Task comment',
        metadata: { client_record_id: 'local-comment-1' },
        row_version: 1,
      },
    });

    const comment = await createTowerPgTaskCommentFromLocal(store(), {
      record_id: 'local-comment-1',
      target_record_id: 'task-1',
      body: 'Task comment',
      pg_thread_id: 'thread-1',
    });

    expect(api.createTowerPgTaskComment).toHaveBeenCalledWith('workspace-1', 'task-1', {
      body: 'Task comment',
      thread_id: 'thread-1',
      mentions: [],
      metadata: { client_record_id: 'local-comment-1', mentions: [] },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(comment).toMatchObject({
      record_id: 'comment-1',
      target_record_id: 'task-1',
      body: 'Task comment',
      sync_status: 'synced',
      pg_backend: true,
      pg_record_type: 'task_comment',
      pg_client_record_id: 'local-comment-1',
    });
  });

  it('creates Tower PG task comments with a frozen workspace context', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgTaskComment.mockResolvedValue({
      comment: {
        id: 'comment-1',
        workspace_id: 'workspace-frozen',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        task_id: 'task-1',
        body: 'Task comment',
        row_version: 1,
      },
    });

    await createTowerPgTaskCommentFromLocal(store({
      currentWorkspace: {
        workspaceId: 'workspace-current',
        workspaceOwnerNpub: 'npub1current',
        directHttpsUrl: 'https://current.example',
        appNpub: 'flightdeck_pg',
        pgBackendMode: true,
      },
    }), {
      target_record_id: 'task-1',
      body: 'Task comment',
    }, {
      workspaceId: 'workspace-frozen',
      workspaceOwnerNpub: 'npub1frozen',
      baseUrl: 'https://frozen.example',
      appNpub: 'flightdeck_pg',
      sessionNpub: 'npub1sender',
    });

    expect(api.createTowerPgTaskComment).toHaveBeenCalledWith('workspace-frozen', 'task-1', {
      body: 'Task comment',
      mentions: [],
      metadata: { mentions: [] },
    }, { baseUrl: 'https://frozen.example', appNpub: 'flightdeck_pg' });
  });

  it('creates Tower PG document comments with anchor metadata', async () => {
    const api = await import('../src/api.js');
    api.createTowerPgDocComment.mockResolvedValue({
      comment: {
        id: 'doc-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: null,
        body: 'Doc comment',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 12,
          anchor_end_line_number: 13,
          anchor_quote: 'Selected\ntext',
          anchor_start_offset: 21,
          anchor_end_offset: 36,
          comment_status: 'open',
        },
        row_version: 1,
      },
    });

    const comment = await createTowerPgDocCommentFromLocal(store(), {
      target_record_id: 'doc-1',
      body: 'Doc comment',
      anchor_block_id: 'block-1',
      anchor_line_number: 12,
      anchor_end_line_number: 13,
      anchor_quote: 'Selected\ntext',
      anchor_start_offset: 21,
      anchor_end_offset: 36,
      comment_status: 'open',
      pg_metadata: {
        client_record_id: 'local-comment-1',
      },
    });

    expect(api.createTowerPgDocComment).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      body: 'Doc comment',
      mentions: [],
      metadata: {
        anchor_block_id: 'block-1',
        anchor_line_number: 12,
        anchor_end_line_number: 13,
        anchor_quote: 'Selected\ntext',
        anchor_start_offset: 21,
        anchor_end_offset: 36,
        comment_status: 'open',
        client_record_id: 'local-comment-1',
        mentions: [],
      },
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(comment).toMatchObject({
      record_id: 'doc-comment-1',
      target_record_id: 'doc-1',
      target_record_family_hash: recordFamilyHash('document'),
      anchor_block_id: 'block-1',
      anchor_line_number: 12,
      anchor_end_line_number: 13,
      anchor_quote: 'Selected\ntext',
      anchor_start_offset: 21,
      anchor_end_offset: 36,
      pg_record_type: 'doc_comment',
    });
  });

  it('updates Tower PG document comment status', async () => {
    const api = await import('../src/api.js');
    api.updateTowerPgDocComment.mockResolvedValue({
      comment: {
        id: 'doc-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: null,
        body: 'Doc comment',
        metadata: {
          anchor_block_id: 'block-1',
          anchor_line_number: 12,
          comment_status: 'resolved',
        },
        row_version: 2,
      },
    });

    const comment = await updateTowerPgDocCommentFromLocal(store(), {
      record_id: 'doc-comment-1',
      target_record_id: 'doc-1',
      body: 'Doc comment',
      anchor_block_id: 'block-1',
      anchor_line_number: 12,
      comment_status: 'resolved',
      previous_version: 1,
      version: 2,
    });

    expect(api.updateTowerPgDocComment).toHaveBeenCalledWith('workspace-1', 'doc-1', 'doc-comment-1', {
      comment_status: 'resolved',
      row_version: 1,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(comment).toMatchObject({
      record_id: 'doc-comment-1',
      comment_status: 'resolved',
      version: 2,
      pg_record_type: 'doc_comment',
    });
  });

  it('deletes Tower PG document comments and maps the local row as deleted', async () => {
    const api = await import('../src/api.js');
    api.deleteTowerPgDocComment.mockResolvedValue({
      comment: {
        id: 'doc-comment-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        doc_id: 'doc-1',
        parent_comment_id: null,
        body: 'Doc comment',
        metadata: {
          comment_status: 'open',
        },
        row_version: 2,
      },
    });

    const comment = await deleteTowerPgDocCommentFromLocal(store(), {
      record_id: 'doc-comment-1',
      target_record_id: 'doc-1',
      version: 1,
    });

    expect(api.deleteTowerPgDocComment).toHaveBeenCalledWith('workspace-1', 'doc-1', 'doc-comment-1', {
      rowVersion: 1,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(comment).toMatchObject({
      record_id: 'doc-comment-1',
      record_state: 'deleted',
      pg_record_type: 'doc_comment',
    });
  });

  it('deletes Tower PG messages and maps the local row as deleted', async () => {
    const api = await import('../src/api.js');
    api.deleteTowerPgMessage.mockResolvedValue({
      message: {
        id: 'message-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        body: 'Deleted',
        row_version: 2,
      },
    });

    const message = await deleteTowerPgMessageFromLocal(store(), {
      record_id: 'message-1',
      channel_id: 'channel-1',
      body: 'Deleted',
      version: 1,
    });

    expect(api.deleteTowerPgMessage).toHaveBeenCalledWith('workspace-1', 'message-1', {
      rowVersion: 1,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(message).toMatchObject({
      record_id: 'message-1',
      record_state: 'deleted',
      pg_backend: true,
    });
  });

  it('treats missing Tower PG messages as already deleted locally', async () => {
    const api = await import('../src/api.js');
    const error = new Error('Tower PG API 404 DELETE https://tower.example/messages/message-missing: {"code":"message_not_found"}');
    error.status = 404;
    error.code = 'message_not_found';
    error.responseText = '{"error":"Flight Deck PG message not found","code":"message_not_found","status":404}';
    api.deleteTowerPgMessage.mockRejectedValue(error);

    const message = await deleteTowerPgMessageFromLocal(store(), {
      record_id: 'message-missing',
      channel_id: 'channel-1',
      body: 'Already gone',
      version: 2,
      pg_backend: true,
      record_state: 'active',
    });

    expect(api.deleteTowerPgMessage).toHaveBeenCalledWith('workspace-1', 'message-missing', {
      rowVersion: 2,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(message).toMatchObject({
      record_id: 'message-missing',
      record_state: 'deleted',
      sync_status: 'synced',
      version: 3,
      pg_backend: true,
      pg_workspace_id: 'workspace-1',
    });
  });

  it('deletes Tower PG threads by PG thread id', async () => {
    const api = await import('../src/api.js');
    api.deleteTowerPgThread.mockResolvedValue({
      thread: { id: 'thread-1' },
    });

    const thread = await deleteTowerPgThreadFromLocal(store(), {
      record_id: 'message-1',
      pg_thread_id: 'thread-1',
    });

    expect(api.deleteTowerPgThread).toHaveBeenCalledWith('workspace-1', 'thread-1', {
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(thread).toEqual({ id: 'thread-1' });
  });

  it('archives Tower PG threads without a stale row version gate', async () => {
    const api = await import('../src/api.js');
    api.archiveTowerPgThread.mockResolvedValue({
      thread: { id: 'thread-1', record_state: 'archived', row_version: 7 },
    });

    const thread = await archiveTowerPgThreadFromLocal(store(), {
      record_id: 'message-1',
      pg_thread_id: 'thread-1',
      version: 1,
    }, true);

    expect(api.archiveTowerPgThread).toHaveBeenCalledWith('workspace-1', 'thread-1', {
      archived: true,
      baseUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
    });
    expect(thread).toEqual({ id: 'thread-1', record_state: 'archived', row_version: 7 });
  });

  it('moves a task through the explicit Tower PG move contract', async () => {
    const api = await import('../src/api.js');
    api.moveTowerPgTask.mockResolvedValue({
      task: { id: 'task-1', workspace_id: 'workspace-1', scope_id: 'scope-2', channel_id: 'channel-2', title: 'Moved task', state: 'new', priority: 'sand', metadata: {}, assignments: [], row_version: 3 },
    });
    const moved = await moveTowerPgTaskFromLocal(store(), { record_id: 'task-1', title: 'Moved task', version: 2 }, 'channel-2', 'scope-2');
    expect(api.moveTowerPgTask).toHaveBeenCalledWith('workspace-1', 'task-1', {
      destination_channel_id: 'channel-2', destination_scope_id: 'scope-2', row_version: 2,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(moved).toMatchObject({ record_id: 'task-1', scope_id: 'scope-2', pg_channel_id: 'channel-2', version: 3 });
  });

  it('moves a document while preserving already materialized body content', async () => {
    const api = await import('../src/api.js');
    api.moveTowerPgDoc.mockResolvedValue({
      doc: { id: 'doc-1', workspace_id: 'workspace-1', scope_id: 'scope-2', channel_id: 'channel-2', title: 'Moved doc', summary: 'Summary', metadata: {}, storage_object_id: 'object-1', row_version: 5 },
    });
    const moved = await moveTowerPgDocFromLocal(store(), { record_id: 'doc-1', title: 'Moved doc', content: 'Full local body', version: 4 }, 'channel-2', 'scope-2');
    expect(api.moveTowerPgDoc).toHaveBeenCalledWith('workspace-1', 'doc-1', {
      destination_channel_id: 'channel-2', destination_scope_id: 'scope-2', row_version: 4,
    }, { baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg' });
    expect(moved).toMatchObject({ record_id: 'doc-1', scope_id: 'scope-2', pg_channel_id: 'channel-2', content: 'Full local body', version: 5 });
  });
});
