import { describe, expect, it } from 'vitest';
import {
  filterWorkroomEvents,
  isWorkroomApprovalApprover,
  workroomAnnouncementChannelId,
  workroomAnnouncementMessageId,
  workroomAnnouncementThreadId,
  workroomApprovalDetails,
  workroomAppTargetDetails,
  workroomDetailMixin,
  workroomParticipantMetadata,
  workroomParticipantMetadataStatus,
} from '../src/workroom-detail-manager.js';
import { hydrateTowerPgThreadMessages } from '../src/pg-read-hydrator.js';

function attachThreadHistoryService(store) {
  store.requestTowerSyncFamily = async (family, _coverageKey, options) => {
    expect(family).toBe('thread-history');
    return hydrateTowerPgThreadMessages(store, options.channelId, options.threadId, {
      ...options,
      getSyncState: async () => null,
      runWorkspaceSyncTransaction: async callback => callback(),
      getTowerPgChannelThreads: store.getTowerPgChannelThreads,
      getTowerPgChannelMessages: store.getTowerPgChannelMessages,
      upsertMessage: store.upsertMessage,
    });
  };
}

describe('workroom typed readiness metadata', () => {
  it('classifies participant metadata as missing, invalid, or valid', () => {
    expect(workroomParticipantMetadataStatus({ role: 'integration', metadata: {} })).toBe('missing');
    expect(workroomParticipantMetadataStatus({
      role: 'integration',
      metadata: { capabilities: ['tests'], localWorkspace: { repoPath: '/repo' } },
    })).toBe('invalid');
    const participant = {
      metadata: {
        capabilities: ['github_pr', 'tests'],
        localWorkspace: { repoPath: '/repo', defaultBranch: 'main', canRunTests: true },
        constraints: { canMergeIntegration: false, canMergeProduction: false, canRestartManagedApps: false },
      },
    };
    expect(workroomParticipantMetadataStatus(participant)).toBe('valid');
    expect(workroomParticipantMetadata(participant).localWorkspace.repoPath).toBe('/repo');
  });

  it('normalizes app targets and reports incomplete runbooks', () => {
    expect(workroomAppTargetDetails({ preview_url: 'https://preview.example' })[0]).toMatchObject({
      kind: 'preview',
      url: 'https://preview.example',
      runbookStatus: 'missing',
    });
    expect(workroomAppTargetDetails([{
      id: 'local', kind: 'local', label: 'Local',
      runbook: { repoPath: '/repo', install: 'bun install', test: 'bun test', build: 'bun run build', start: 'managed', deploy: 'manual' },
    }])[0].runbookStatus).toBe('valid');
  });
});

const events = [
  { record_id: 'goal', event_type: 'goal_created', title: 'Initial goal', actor_npub: 'npub-human', created_at: '2026-07-10T01:00:00Z' },
  { record_id: 'pr', event_type: 'pull_request_opened', target_type: 'pull_request', target_ref: 'PR-42', title: 'Integration PR', created_at: '2026-07-11T01:00:00Z' },
  { record_id: 'deploy', event_type: 'preview_deployed', title: 'Preview deployed', body: 'Preview URL ready', created_at: '2026-07-12T01:00:00Z' },
  { record_id: 'blocker', event_type: 'blocker_reported', title: 'Access blocker', body: 'Participant access failed', created_at: '2026-07-13T01:00:00Z' },
];

describe('workroom detail event filters', () => {
  it('filters history by event family, actor, reference, and date', () => {
    expect(filterWorkroomEvents(events, { type: 'pr' }).map((event) => event.record_id)).toEqual(['pr']);
    expect(filterWorkroomEvents(events, { actor: 'npub-human' }).map((event) => event.record_id)).toEqual(['goal']);
    expect(filterWorkroomEvents(events, { artifact: 'PR-42' }).map((event) => event.record_id)).toEqual(['pr']);
    expect(filterWorkroomEvents(events, { from: '2026-07-12', to: '2026-07-12' }).map((event) => event.record_id)).toEqual(['deploy']);
  });

  it('recognizes blocker and deploy history using event metadata', () => {
    expect(filterWorkroomEvents(events, { type: 'blocker' }).map((event) => event.record_id)).toEqual(['blocker']);
    expect(filterWorkroomEvents(events, { type: 'deploy' }).map((event) => event.record_id)).toEqual(['deploy']);
  });
});

describe('workroom production merge approvals', () => {
  const room = {
    repo: { name: 'org/flight-deck' },
    branches: { integration: 'feature/fd-04', production: 'main' },
    integration_autopilot_npub: 'npub1autopilot',
    approval_policy: { human_approver_npubs: ['npub1approver'] },
  };
  const approval = {
    metadata: {
      repo: 'org/flight-deck',
      from_branch: 'feature/fd-04',
      to_branch: 'main',
      commit: 'abc123',
      preview_url: 'https://preview.example.test',
      validation_evidence: ['bun test', 'bun run build'],
    },
  };

  it('normalizes the exact merge context and validation evidence for review', () => {
    expect(workroomApprovalDetails(approval, room)).toEqual({
      repo: 'org/flight-deck',
      fromBranch: 'feature/fd-04',
      productionBranch: 'main',
      commit: 'abc123',
      previewUrl: 'https://preview.example.test',
      integrationAutopilot: 'npub1autopilot',
      validationEvidence: ['bun test', 'bun run build'],
    });
  });

  it('allows only policy or active human approvers to decide', () => {
    expect(isWorkroomApprovalApprover(room, [], 'npub1approver')).toBe(true);
    expect(isWorkroomApprovalApprover(room, [], 'npub1contributor')).toBe(false);
    expect(isWorkroomApprovalApprover({ approval_policy: {} }, [{ actor_npub: 'npub1approver', role: 'human_approver', access_status: 'granted', status: 'active' }], 'npub1approver')).toBe(true);
    expect(isWorkroomApprovalApprover({ approval_policy: {} }, [{ actor_npub: 'npub1approver', role: 'human_approver', access_status: 'failed', status: 'active' }], 'npub1approver')).toBe(false);
  });
});

describe('workroom announcement thread helpers', () => {
  it('hydrates participants when opening a cached workroom detail', async () => {
    const hydratedIds = [];
    const opened = [];
    const store = {
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub-owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      activeWorkroomId: '',
      selectedChannelId: 'channel-1',
      workroomDetailOpen: false,
      workroomDetailLoading: false,
      workroomError: '',
      workroomDetailNotice: '',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_message_id: 'message-1',
          announcement_thread_id: 'thread-1',
        },
      }],
      workroomParticipants: [],
      workroomEvents: [],
      workroomLinks: [],
      workroomApprovals: [],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null }],
      getTowerPgWorkroom: async (_workspaceId, workroomId) => {
        hydratedIds.push(workroomId);
        return {
          workroom: {
            id: 'room-1',
            channel_id: 'channel-1',
            title: 'Cached room',
            metadata: {
              announcement_message_id: 'message-1',
              announcement_thread_id: 'thread-1',
            },
          },
          participants: [{ id: 'participant-1', workroom_id: 'room-1', actor_npub: 'npub-testagent', kind: 'autopilot', role: 'integration', access_status: 'granted' }],
          events: [],
          links: [],
        };
      },
      upsertWorkroom: async () => {},
      replaceWorkroomParticipantsForRoom: async () => {},
      replaceWorkroomEventsForRoom: async () => {},
      replaceWorkroomLinksForRoom: async () => {},
      replaceWorkroomApprovalsForRoom: async () => {},
      getTowerPgApprovals: async () => ({ approvals: [] }),
      requestTowerSyncFamily: async (family, workroomId, options) => {
        if (family === 'thread-history') {
          const result = await store.getTowerPgChannelMessages();
          const rows = result.messages.map((message) => ({ ...message, record_id: message.id }));
          rows.forEach((message) => store.messages.push(message));
          return rows;
        }
        expect(family).toBe('workroom');
        const result = await store.getTowerPgWorkroom('workspace-1', workroomId);
        store.applyWorkroomParticipants(result.participants.map((participant) => ({
          ...participant,
          record_id: participant.id,
        })));
        return { ...result.workroom, record_id: result.workroom.id };
      },
      getTowerPgChannelMessages: async () => ({
        messages: [{
          id: 'message-1',
          channel_id: 'channel-1',
          thread_id: 'thread-1',
          parent_message_id: null,
          body: 'Workroom started',
          created_at: '2026-07-20T00:00:00.000Z',
        }],
      }),
      upsertMessage: async () => {},
      readMaterializedMessageById: async () => ({
        record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null,
      }),
      refreshMessages: async () => {},
      openThread(recordId, options) { opened.push({ recordId, options }); },
      syncRoute() {},
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openWorkroomDetail('room-1', { syncRoute: false });

    expect(hydratedIds).toEqual(['room-1']);
    expect(store.selectedWorkroomParticipants).toEqual([
      expect.objectContaining({ record_id: 'participant-1', actor_npub: 'npub-testagent', kind: 'autopilot', role: 'integration' }),
    ]);
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('separates linked docs and tasks for the derived room rail', () => {
    const store = {
      activeWorkroomId: 'room-1',
      workroomLinks: [
        { record_id: 'doc-1', workroom_id: 'room-1', target_type: 'document', label: 'Brief' },
        { record_id: 'task-1', workroom_id: 'room-1', target_type: 'task', label: 'Implement' },
      ],
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));
    expect(store.selectedWorkroomDocLinks.map((link) => link.record_id)).toEqual(['doc-1']);
    expect(store.selectedWorkroomTaskLinks.map((link) => link.record_id)).toEqual(['task-1']);
  });

  it('resolves durable announcement ids from workroom metadata', () => {
    const room = {
      channel_id: 'channel-1',
      metadata: {
        announcement_message_id: 'message-1',
        announcement_thread_id: 'thread-1',
      },
    };
    expect(workroomAnnouncementMessageId(room)).toBe('message-1');
    expect(workroomAnnouncementThreadId(room)).toBe('thread-1');
    expect(workroomAnnouncementChannelId(room)).toBe('channel-1');
  });

  it('activates the announcement message as the selected workroom thread', async () => {
    const opened = [];
    const store = {
      activeWorkroomId: 'room-1',
      selectedChannelId: 'old-channel',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_message_id: 'message-1',
          announcement_thread_id: 'thread-1',
        },
      }],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } }],
      selectPgChannelContext(channelId) { this.selectedChannelId = channelId; },
      refreshMessages: async () => {},
      openThread(recordId, options) { opened.push({ recordId, options }); },
    };
    attachThreadHistoryService(store);
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openSelectedWorkroomThread({ syncRoute: false });

    expect(store.selectedChannelId).toBe('channel-1');
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('opens the announcement root when only the thread id is persisted on the workroom', async () => {
    const opened = [];
    const store = {
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      workroomDetailNotice: '',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: { announcement_thread_id: 'thread-1' },
      }],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null, pg_metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } }],
      refreshMessages: async () => {},
      openThread(recordId, options) { opened.push({ recordId, options }); },
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openSelectedWorkroomThread({ syncRoute: false });

    expect(store.selectedWorkroomAnnouncementMessageId).toBe('message-1');
    expect(store.workroomDetailNotice).toBe('');
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('ignores stale unthreaded announcement duplicates when a durable thread id exists', async () => {
    const opened = [];
    const store = {
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      workroomDetailNotice: '',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_thread_id: 'thread-1',
        },
      }],
      messages: [
        { record_id: 'stale-message', channel_id: 'channel-1', pg_thread_id: null, parent_message_id: null, pg_metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } },
        { record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null, pg_metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } },
      ],
      refreshMessages: async () => {},
      openThread(recordId, options) { opened.push({ recordId, options }); },
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openSelectedWorkroomThread({ syncRoute: false });

    expect(store.selectedWorkroomAnnouncementMessageId).toBe('message-1');
    expect(store.workroomDetailNotice).toBe('');
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('uses a metadata-tagged announcement message even before durable ids are hydrated', async () => {
    const opened = [];
    const store = {
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      workroomDetailNotice: '',
      workrooms: [{ record_id: 'room-1', channel_id: 'channel-1', metadata: {} }],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null, pg_metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } }],
      refreshMessages: async () => {},
      openThread(recordId, options) { opened.push({ recordId, options }); },
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openSelectedWorkroomThread({ syncRoute: false });

    expect(store.selectedWorkroomAnnouncementMessageId).toBe('message-1');
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('hydrates the announcement thread from Tower when the local message cache is empty', async () => {
    const opened = [];
    const persisted = [];
    const patched = [];
    const store = {
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub-owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      workroomDetailNotice: '',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_message_id: 'message-1',
          announcement_thread_id: 'thread-1',
        },
      }],
      messages: [],
      getTowerPgChannelThreads: async () => ({
        threads: [{ id: 'thread-1', source_message_id: 'message-1', channel_id: 'channel-1' }],
      }),
      getTowerPgChannelMessages: async (_workspaceId, _channelId, options) => {
        expect(options.threadId).toBe('thread-1');
        return {
          messages: [
            { id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Room started', sender_npub: 'npub-operator-a', metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } },
            { id: 'reply-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Reply', sender_npub: 'npub-testagent' },
          ],
        };
      },
      upsertMessage: async (row) => { persisted.push(row); },
      readMaterializedMessageById: async (recordId) => persisted.find((row) => row.record_id === recordId) || null,
      patchMessageLocal(row) {
        patched.push(row);
        this.messages = [...this.messages.filter((message) => message.record_id !== row.record_id), row];
      },
      getThreadReplies(recordId) {
        return this.messages.filter((message) => message.parent_message_id === recordId);
      },
      openThread(recordId, options) { opened.push({ recordId, options }); },
    };
    attachThreadHistoryService(store);
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.openSelectedWorkroomThread({ syncRoute: false, refreshMessages: false });

    expect(persisted.map((row) => row.record_id)).toEqual(['message-1', 'reply-1', 'thread-1']);
    expect(persisted.at(-1)).toMatchObject({ record_id: 'thread-1', pg_effective_message_ids: ['message-1', 'reply-1'] });
    expect(patched).toEqual([]);
    expect(store.selectedWorkroomAnnouncementMessageId).toBe('message-1');
    expect(store.selectedWorkroomThreadReplies).toEqual([]);
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: false } }]);
  });

  it('rehydrates a cached announcement message that is missing its PG thread id before sending', async () => {
    const sent = [];
    const opened = [];
    const store = {
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub-owner',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      threadInput: 'Reply after stale parent',
      workroomDetailNotice: '',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_message_id: 'message-1',
          announcement_thread_id: 'thread-1',
        },
      }],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: null, parent_message_id: null }],
      getTowerPgChannelThreads: async () => ({
        threads: [{ id: 'thread-1', source_message_id: 'message-1', channel_id: 'channel-1' }],
      }),
      getTowerPgChannelMessages: async (_workspaceId, _channelId, options) => {
        expect(options.threadId).toBe('thread-1');
        return {
          messages: [
            { id: 'message-1', channel_id: 'channel-1', thread_id: 'thread-1', body: 'Room started', sender_npub: 'npub-operator-a', metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } },
          ],
        };
      },
      upsertMessage: async () => {},
      readMaterializedMessageById: async () => ({
        record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null,
      }),
      patchMessageLocal(row) {
        this.messages = [...this.messages.filter((message) => message.record_id !== row.record_id), row];
      },
      openThread(recordId, options) {
        opened.push({ recordId, options });
        this.activeThreadId = recordId;
      },
      sendThreadReply() { sent.push({ activeThreadId: this.activeThreadId, body: this.threadInput }); },
    };
    attachThreadHistoryService(store);
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.sendSelectedWorkroomThreadReply();

    expect(store.workroomDetailNotice).toBe('');
    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: true } }]);
    expect(sent).toEqual([{ activeThreadId: 'message-1', body: 'Reply after stale parent' }]);
  });

  it('preserves the typed room reply while activating the announcement thread for send', async () => {
    const sent = [];
    const opened = [];
    const store = {
      activeWorkroomId: 'room-1',
      selectedChannelId: 'channel-1',
      threadInput: 'Reply from the workroom',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        metadata: {
          announcement_message_id: 'message-1',
          announcement_thread_id: 'thread-1',
        },
      }],
      messages: [{ record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null, pg_metadata: { kind: 'workroom_announcement', workroom_id: 'room-1' } }],
      refreshMessages: async () => {},
      openThread(recordId, options) {
        opened.push({ recordId, options });
        if (options?.preserveComposer !== true) this.threadInput = '';
        this.activeThreadId = recordId;
      },
      sendThreadReply() { sent.push({ activeThreadId: this.activeThreadId, body: this.threadInput }); },
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.sendSelectedWorkroomThreadReply();

    expect(opened).toEqual([{ recordId: 'message-1', options: { scrollToLatest: true, syncRoute: false, preserveComposer: true } }]);
    expect(sent).toEqual([{ activeThreadId: 'message-1', body: 'Reply from the workroom' }]);
  });

  it('exposes the canonical root and replies through the shared thread message model', () => {
    const store = {
      activeWorkroomId: 'room-1',
      workrooms: [{
        record_id: 'room-1',
        channel_id: 'channel-1',
        announcement_message_id: 'message-1',
        announcement_thread_id: 'thread-1',
      }],
      messages: [
        { record_id: 'message-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: null },
        { record_id: 'reply-1', channel_id: 'channel-1', pg_thread_id: 'thread-1', parent_message_id: 'message-1' },
      ],
      activeThreadId: 'message-1',
      visibleThreadMessages: [{ record_id: 'reply-1', parent_message_id: 'message-1' }],
      getThreadReplies: () => [{ record_id: 'reply-1', parent_message_id: 'message-1' }],
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    expect(store.selectedWorkroomThreadMessages.map((message) => message.record_id)).toEqual(['message-1', 'reply-1']);
  });
});

describe('workroom archive actions', () => {
  it('archives a room from the browser and moves the list to archive view', async () => {
    const archiveCalls = [];
    const persisted = [];
    const store = {
      currentWorkspace: {
        workspaceId: 'workspace-1',
        directHttpsUrl: 'https://tower.example',
        appNpub: 'flightdeck_pg',
      },
      workrooms: [{ record_id: 'room-1', title: 'Old room', status: 'active', row_version: 7 }],
      activeWorkroomId: '',
      workroomArchiveView: false,
      workroomArchivingId: '',
      workroomDetailLoading: false,
      workroomDetailNotice: '',
      workroomError: '',
      archiveTowerPgWorkroom: async (...args) => {
        archiveCalls.push(args);
        return { workroom: { id: 'room-1', title: 'Old room', status: 'archived', row_version: 8, archived_at: '2026-07-17T01:00:00Z' } };
      },
      upsertWorkroom: async (row) => { persisted.push(row); },
    };
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(workroomDetailMixin));

    await store.archiveWorkroom(store.workrooms[0]);

    expect(archiveCalls).toEqual([
      ['workspace-1', 'room-1', { row_version: 7 }, expect.objectContaining({ workspaceId: 'workspace-1', baseUrl: 'https://tower.example' })],
    ]);
    expect(persisted).toEqual([expect.objectContaining({ record_id: 'room-1', status: 'archived' })]);
    expect(store.workrooms).toEqual([expect.objectContaining({ record_id: 'room-1', status: 'archived' })]);
    expect(store.workroomArchiveView).toBe(true);
    expect(store.workroomArchivingId).toBe('');
    expect(store.canArchiveWorkroom(store.workrooms[0])).toBe(false);
  });
});
