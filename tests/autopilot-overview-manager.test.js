import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  autopilotOverviewManagerMixin,
  buildAutopilotOverviewInbox,
  buildAutopilotOverviewDocuments,
  buildAutopilotOverviewFiles,
  buildAutopilotOverviewTasks,
  buildAutopilotOverviewThreads,
  buildInboxWorkingResourceKeys,
  buildRecentChannels,
  countUnresolvedDocumentComments,
  deriveDeckThreadCreateTitle,
  filterAutopilotOverviewInbox,
  getOverviewFileSourceContract,
  nextDeckInboxVisibleCount,
  sliceAutopilotOverviewInbox,
} from '../src/autopilot-overview-manager.js';
import { buildPgChannelTaskBoardId } from '../src/pg-record-context.js';
import { computeBoardColumns } from '../src/task-board-state.js';
import { recordFamilyHash } from '../src/translators/chat.js';
import { channelsManagerMixin } from '../src/channels-manager.js';

describe('autopilot overview manager', () => {
  it('presents blocked task state with the canonical Inbox label', () => {
    const [row] = buildAutopilotOverviewTasks({
      tasks: [{
        record_id: 'task-blocked',
        title: 'Waiting on access',
        state: 'blocked',
        updated_at: '2026-08-31T01:00:00.000Z',
      }],
    });

    expect(row).toMatchObject({ taskState: 'blocked', subtitle: 'Blocked' });
  });

  it('excludes completed task cards from the Deck while preserving active task ordering', () => {
    const tasks = [
      { record_id: 'task-done', title: 'Done', state: 'done', updated_at: '2026-09-22T04:00:00.000Z' },
      { record_id: 'task-review', title: 'Review', state: 'review', updated_at: '2026-09-22T03:00:00.000Z' },
      { record_id: 'task-completed', title: 'Completed', state: 'completed', updated_at: '2026-09-22T02:00:00.000Z' },
      { record_id: 'task-active', title: 'Active', state: 'in_progress', updated_at: '2026-09-22T01:00:00.000Z' },
      { record_id: 'task-complete', title: 'Complete', state: 'complete', updated_at: '2026-09-22T00:00:00.000Z' },
    ];

    const rows = buildAutopilotOverviewTasks({ tasks });

    expect(rows.map((row) => row.recordId)).toEqual(['task-review', 'task-active']);
    expect(buildAutopilotOverviewInbox({ tasks: rows }).map((row) => row.recordId))
      .toEqual(['task-review', 'task-active']);
    expect(tasks.map((task) => task.state)).toEqual(['done', 'review', 'completed', 'in_progress', 'complete']);
  });

  const channels = [
    { record_id: 'chan-a', title: 'Implementation', scope_id: 'scope-a' },
    { record_id: 'chan-b', title: 'Design', scope_id: 'scope-b' },
  ];

  const messages = [
    {
      record_id: 'thread-a',
      channel_id: 'chan-a',
      body: 'Initial request',
      updated_at: '2026-06-15T10:00:00.000Z',
    },
    {
      record_id: 'reply-a-old',
      channel_id: 'chan-a',
      parent_message_id: 'thread-a',
      body: 'Older reply',
      updated_at: '2026-06-15T10:05:00.000Z',
    },
    {
      record_id: 'reply-a-new',
      channel_id: 'chan-a',
      parent_message_id: 'thread-a',
      body: 'Newest reply',
      updated_at: '2026-06-15T10:20:00.000Z',
    },
    {
      record_id: 'thread-b',
      channel_id: 'chan-b',
      body: 'Design thread',
      updated_at: '2026-06-15T10:10:00.000Z',
    },
  ];

  it('orders threads by latest message, not thread root timestamp', () => {
    const rows = buildAutopilotOverviewThreads({
      channels,
      messages,
      unreadChannelMap: { 'chan-a': true },
    });

    expect(rows.map((row) => row.id)).toEqual(['thread-a', 'thread-b']);
    expect(rows[0]).toMatchObject({
      latestMessage: 'Newest reply',
      latestMessageUpdatedAt: '2026-06-15T10:20:00.000Z',
      messageCount: 3,
      isUnread: true,
    });
  });

  it('reuses workspace-sized thread projections across unrelated composer updates', () => {
    const store = {
      channels,
      messages,
      fileMessages: [],
      autopilotOverviewContext: { scopeId: 'all', channelId: 'all' },
      scopesMap: new Map(),
      groups: [],
      chatProfiles: {},
      session: {},
      _unreadChannels: {},
      _unreadThreadItems: {},
      isTowerPgMode: true,
    };
    const getThreads = Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, 'autopilotOverviewThreads').get;

    const first = getThreads.call(store);
    store.threadInput = 'ordinary typing';
    expect(getThreads.call(store)).toBe(first);

    store.fileMessages = [...messages, {
      record_id: 'thread-c', channel_id: 'chan-a', body: 'New', updated_at: '2026-06-15T10:30:00.000Z',
    }];
    expect(getThreads.call(store)).not.toBe(first);
  });

  it('deduplicates recent channels by their latest active thread and caps them newest first', () => {
    const rows = buildRecentChannels([
      { id: 'a-old', channelId: 'chan-a', latestMessageUpdatedAt: '2026-07-30T09:00:00.000Z' },
      { id: 'b-latest', channelId: 'chan-b', latestMessageUpdatedAt: '2026-07-30T11:00:00.000Z' },
      { id: 'a-latest', channelId: 'chan-a', latestMessageUpdatedAt: '2026-07-30T10:00:00.000Z' },
      { id: 'c-oldest', channelId: 'chan-c', latestMessageUpdatedAt: '2026-07-30T08:00:00.000Z' },
    ], { limit: 2 });

    expect(rows.map((row) => row.id)).toEqual(['b-latest', 'a-latest']);
    expect(rows.map((row) => row.channelId)).toEqual(['chan-b', 'chan-a']);
    const twelveChannels = Array.from({ length: 12 }, (_, index) => ({
      id: `thread-${index}`,
      channelId: `channel-${index}`,
      latestMessageUpdatedAt: new Date(Date.UTC(2026, 6, 30, 0, index)).toISOString(),
    }));
    expect(buildRecentChannels(twelveChannels)).toHaveLength(10);
  });

  it('builds recent channels for the Deck scope without narrowing to the selected channel', () => {
    const store = {
      channels: [
        { record_id: 'chan-a', title: 'A', scope_id: 'scope-a' },
        { record_id: 'chan-a-2', title: 'A2', scope_id: 'scope-a' },
        { record_id: 'chan-b', title: 'B', scope_id: 'scope-b' },
      ],
      messages: [
        { record_id: 'thread-a', channel_id: 'chan-a', updated_at: '2026-07-30T10:00:00.000Z' },
        { record_id: 'thread-a-2', channel_id: 'chan-a-2', updated_at: '2026-07-30T11:00:00.000Z' },
        { record_id: 'thread-b', channel_id: 'chan-b', updated_at: '2026-07-30T12:00:00.000Z' },
      ],
      fileMessages: [],
      autopilotOverviewContext: { scopeId: 'scope-a', channelId: 'chan-a' },
      scopesMap: new Map(),
      session: {},
      _unreadChannels: {},
      _unreadThreadItems: {},
      isTowerPgMode: true,
    };

    const rows = Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, 'deckRecentChannels').get.call(store);
    expect(rows.map((row) => row.channelId)).toEqual(['chan-a-2', 'chan-a']);
  });

  it('uses the persisted Tower thread title in the Deck inbox', () => {
    const rows = buildAutopilotOverviewThreads({
      channels,
      messages: [{
        record_id: 'source-message',
        channel_id: 'chan-a',
        pg_thread_id: 'thread-1',
        pg_thread_version: 2,
        title: 'Persisted thread title',
        body: 'First message body that should not become the card title',
        updated_at: '2026-07-26T09:00:00.000Z',
      }],
    });
    const inbox = buildAutopilotOverviewInbox({ threads: rows });
    expect(inbox[0]).toMatchObject({ inboxKind: 'chat', title: 'Persisted thread title' });
  });

  it('keeps the source-message identity when a Deck snapshot contains only thread replies', () => {
    const rows = buildAutopilotOverviewThreads({
      channels,
      messages: [{
        record_id: 'reply-1',
        channel_id: 'chan-a',
        pg_thread_id: 'tower-thread-1',
        parent_message_id: 'source-message-1',
        body: 'Reply loaded without the older source message',
        updated_at: '2026-07-31T02:45:00.000Z',
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tower-thread-1',
      rootRecordId: 'source-message-1',
      channelId: 'chan-a',
    });
  });

  it('combines entity activity newest first while retaining one row per thread', () => {
    const threads = buildAutopilotOverviewThreads({ channels, messages });
    const rows = buildAutopilotOverviewInbox({
      threads,
      files: [{ object_id: 'file-1', name: 'Plan.pdf', activityAt: '2026-06-15T10:15:00.000Z' }],
      documents: [{ id: 'document:doc-1', recordId: 'doc-1', activityAt: '2026-06-15T10:25:00.000Z' }],
      tasks: [{ id: 'task:task-1', recordId: 'task-1', activityAt: '2026-06-15T10:12:00.000Z' }],
    });

    expect(rows.map((row) => `${row.inboxKind}:${row.id || row.object_id}`)).toEqual([
      'document:document:doc-1',
      'chat:thread-a',
      'file:file-1',
      'task:task:task-1',
      'chat:thread-b',
    ]);
    expect(rows.filter((row) => row.inboxKind === 'chat' && row.id === 'thread-a')).toHaveLength(1);
    expect(rows.find((row) => row.id === 'thread-a')?.latestMessage).toBe('Newest reply');
  });

  it('hides task attachments from Inbox while preserving their parent action contract', () => {
    const [row] = buildAutopilotOverviewInbox({
      files: [{
        object_id: 'file-task-1',
        name: 'Mockup.png',
        source_type: 'task',
        source_record_id: 'task-1',
        source_label: 'Use consistent thin borders',
      }],
    });

    expect(row).toBeUndefined();
    expect(getOverviewFileSourceContract({ source_type: 'task' })).toMatchObject({
      sourceDestinationType: 'task',
      sourceTypeLabel: 'Task attachment',
      sourceActionLabel: 'Open task',
      sourceAriaLabel: 'Open source task',
    });
  });

  it('describes comment and audio attachments using their resolved source destination', () => {
    expect(getOverviewFileSourceContract({
      source_type: 'comment',
      source_target_type: 'document',
    })).toMatchObject({ sourceDestinationType: 'document', sourceActionLabel: 'Open doc' });
    expect(getOverviewFileSourceContract({
      source_type: 'audio',
      source_target_type: 'chat',
      channel_id: 'chan-a',
    })).toMatchObject({ sourceDestinationType: 'chat', sourceActionLabel: 'Open chat' });
  });

  it('binds Inbox attachment copy and accessibility labels to the resolved destination contract', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const inboxFileCard = html.slice(
      html.indexOf("item.inboxKind === 'file'"),
      html.indexOf('class="settings-field-help inbox-no-results"'),
    );

    expect(inboxFileCard).toContain(':aria-label="\'Preview \' + item.name"');
    expect(inboxFileCard).toContain('item.sourceTypeLabel');
    expect(inboxFileCard).toContain('openFilePreview(item, $event.currentTarget)');
    expect(inboxFileCard).not.toContain('Open file');
  });

  it('removes an accepted done task without resurfacing older task activity as unread', () => {
    const task = {
      record_id: 'task-review',
      title: 'Review the Inbox action',
      state: 'review',
      activity_version: 7,
      updated_at: '2026-08-26T00:00:00.000Z',
    };

    const reviewRows = buildAutopilotOverviewTasks({
      tasks: [task],
      unreadTaskMap: { 'task-review': true },
    });
    expect(buildAutopilotOverviewInbox({ tasks: reviewRows })).toEqual([
      expect.objectContaining({
        recordId: 'task-review',
        taskState: 'review',
        inboxKind: 'task',
        isUnread: true,
      }),
    ]);

    const acceptedDoneTask = {
      ...task,
      state: 'done',
      activity_version: 8,
      updated_at: '2026-08-26T00:10:00.000Z',
    };
    const doneRows = buildAutopilotOverviewTasks({
      tasks: [acceptedDoneTask],
      comments: [{
        record_id: 'older-comment',
        target_record_id: 'task-review',
        target_record_family_hash: recordFamilyHash('task'),
        body: 'Older review feedback',
        updated_at: '2026-08-26T00:05:00.000Z',
      }],
      unreadTaskMap: {},
    });
    const inbox = buildAutopilotOverviewInbox({
      threads: [{ id: 'older-thread', latestMessageUpdatedAt: '2026-08-26T00:06:00.000Z' }],
      files: [{
        object_id: 'older-attachment',
        name: 'Review evidence.png',
        source_type: 'task',
        source_record_id: 'task-review',
        activityAt: '2026-08-26T00:04:00.000Z',
      }],
      tasks: doneRows,
    });

    expect(doneRows).toHaveLength(0);
    expect(inbox.filter((row) => row.inboxKind === 'task' && row.recordId === 'task-review')).toHaveLength(0);
    expect(inbox.find((row) => row.object_id === 'older-attachment')).toBeUndefined();
    expect(inbox.filter((row) => row.isUnread)).toEqual([]);

    const activeStates = ['new', 'ready', 'in_progress', 'review', 'blocked'];
    const activeRows = activeStates.map((state, index) => ({
      id: `task:active-${state}`,
      recordId: `active-${state}`,
      taskState: state,
      activityAt: `2026-08-26T00:0${index}:00.000Z`,
    }));
    expect(buildAutopilotOverviewInbox({ tasks: activeRows }).map((row) => row.taskState).sort())
      .toEqual([...activeStates].sort());

    const terminalStates = ['done', 'archive', 'archived', 'complete', 'completed', 'cancelled', 'canceled'];
    const terminalRows = terminalStates.map((state) => ({
      id: `task:terminal-${state}`,
      recordId: `terminal-${state}`,
      taskState: state,
      isUnread: true,
      activityAt: '2026-08-26T00:20:00.000Z',
    }));
    expect(buildAutopilotOverviewInbox({ tasks: terminalRows })).toEqual([]);

    const doneColumn = computeBoardColumns([], [acceptedDoneTask], [])
      .find((column) => column.state === 'done');
    expect(doneColumn?.tasks).toEqual([acceptedDoneTask]);
  });

  it('uses projected attention consistently even when the latest displayed activity is self-authored', () => {
    const task = {
      record_id: 'task-review', title: 'Review actor attention', state: 'review',
      updated_at: '2026-08-26T00:10:00.000Z', pg_updated_by_actor_id: 'actor-viewer',
    };
    const selfComment = {
      record_id: 'comment-self', target_record_id: 'task-review',
      target_record_family_hash: recordFamilyHash('task'),
      body: 'Status changed to done', updated_at: '2026-08-26T00:11:00.000Z',
      pg_created_by_actor_id: 'actor-viewer',
    };
    const options = {
      tasks: [task], comments: [selfComment], unreadTaskMap: { 'task-review': true },
      viewerNpub: 'npub1human',
      workspaceMembers: [{ actor_id: 'actor-viewer', npub: 'npub1human' }],
    };

    const [selfRow] = buildAutopilotOverviewTasks(options);
    expect(selfRow).toMatchObject({
      recordId: 'task-review', taskState: 'review', reason: 'Task updated', count: 0,
      activityAt: '2026-08-26T00:10:00.000Z', isUnread: true,
    });
    expect(selfRow.hrefTarget.focusId).toBeNull();
    expect(buildAutopilotOverviewInbox({ tasks: [selfRow] })).toEqual([
      expect.objectContaining({ inboxKind: 'task', recordId: 'task-review', isUnread: true }),
    ]);

    const [otherRow] = buildAutopilotOverviewTasks({
      ...options,
      comments: [{ ...selfComment, record_id: 'comment-other', pg_created_by_actor_id: 'actor-other' }],
    });
    expect(otherRow).toMatchObject({
      reason: '1 recent comment', count: 1,
      activityAt: '2026-08-26T00:11:00.000Z', isUnread: true,
    });
    expect(otherRow.hrefTarget.focusId).toBe('comment-other');
  });

  it('matches partial local Inbox text across every card family and historical thread bodies', () => {
    const threads = buildAutopilotOverviewThreads({
      channels,
      messages: [
        { record_id: 'thread-title', channel_id: 'chan-a', title: 'Flight planning', body: 'Newest note', updated_at: '2026-08-04T04:00:00.000Z' },
        { record_id: 'thread-history', channel_id: 'chan-a', body: 'General chat', updated_at: '2026-08-04T03:00:00.000Z' },
        { record_id: 'history-reply', channel_id: 'chan-a', parent_message_id: 'thread-history', body: 'Older Flight detail', updated_at: '2026-08-04T02:00:00.000Z' },
      ],
    });
    const rows = buildAutopilotOverviewInbox({
      threads,
      tasks: [{ id: 'task:1', recordId: '1', title: 'Flight task', subtitle: 'In progress', reason: 'Task updated', activityAt: '2026-08-04T01:00:00.000Z' }],
      documents: [{ id: 'document:1', recordId: '1', title: 'Notes', subtitle: 'Flight summary', reason: 'Document updated', activityAt: '2026-08-04T00:00:00.000Z' }],
      files: [{ object_id: 'file-1', name: 'Flight-plan.pdf', source_label: 'Uploads', activityAt: '2026-08-03T23:00:00.000Z' }],
    });

    const matches = filterAutopilotOverviewInbox(rows, '  fLiG  ');
    expect(matches.map((row) => `${row.inboxKind}:${row.id || row.object_id}`)).toEqual([
      'chat:thread-title',
      'chat:thread-history',
      'task:task:1',
      'document:document:1',
      'file:file-1',
    ]);
    expect(matches.filter((row) => row.id === 'thread-history')).toHaveLength(1);
  });

  it('filters the complete Inbox before revealing stable 50-card windows', () => {
    const rows = Array.from({ length: 180 }, (_, index) => ({
      id: `task:${index}`,
      inboxKind: 'task',
      title: index % 2 === 0 ? `Flight ${index}` : `Other ${index}`,
    }));
    const matches = filterAutopilotOverviewInbox(rows, 'Flig');

    expect(matches).toHaveLength(90);
    expect(sliceAutopilotOverviewInbox(matches)).toEqual(matches.slice(0, 50));
    expect(nextDeckInboxVisibleCount(50, matches.length)).toBe(90);
    expect(nextDeckInboxVisibleCount(50, 180)).toBe(100);
    expect(nextDeckInboxVisibleCount(100, 180)).toBe(150);
    expect(new Set(sliceAutopilotOverviewInbox(rows, 150).map((row) => row.id)).size).toBe(150);
  });

  it('keeps non-empty Inbox search as a draft until submit and clears immediately when erased', () => {
    const towerRequest = vi.fn();
    const store = {
      deckInboxSearchDraft: '',
      deckInboxSearchQuery: '',
      deckInboxVisibleCount: 150,
      deckInboxContextKey: 'all:all:all',
      deckInboxScopeId: 'all',
      filteredAutopilotOverviewInbox: Array.from({ length: 200 }),
      get visibleAutopilotOverviewInbox() { return this.filteredAutopilotOverviewInbox.slice(0, this.deckInboxVisibleCount); },
      hasMoreAutopilotOverviewInbox: true,
      towerRequest,
      revealMoreDeckInbox() {
        return autopilotOverviewManagerMixin.revealMoreDeckInbox.call(this);
      },
    };

    autopilotOverviewManagerMixin.setDeckInboxSearchDraft.call(store, 'Flig');
    expect(store.deckInboxSearchDraft).toBe('Flig');
    expect(store.deckInboxSearchQuery).toBe('');
    expect(store.deckInboxVisibleCount).toBe(150);

    autopilotOverviewManagerMixin.applyDeckInboxSearch.call(store);
    expect(store.deckInboxSearchQuery).toBe('Flig');
    expect(store.deckInboxVisibleCount).toBe(50);
    store.deckInboxVisibleCount = 100;
    autopilotOverviewManagerMixin.setDeckInboxSearchDraft.call(store, '  flig  ');
    autopilotOverviewManagerMixin.applyDeckInboxSearch.call(store);
    expect(store.deckInboxVisibleCount).toBe(100);

    autopilotOverviewManagerMixin.setDeckInboxSearchDraft.call(store, '');
    expect(store.deckInboxSearchQuery).toBe('');
    expect(store.deckInboxVisibleCount).toBe(50);

    store.deckInboxSearchDraft = 'Flight';
    store.deckInboxSearchQuery = 'Flight';
    store.deckInboxVisibleCount = 100;
    autopilotOverviewManagerMixin.setDeckInboxSearchDraft.call(store, 'Fligh');
    expect(store.deckInboxSearchQuery).toBe('Flight');
    expect(store.deckInboxVisibleCount).toBe(100);
    autopilotOverviewManagerMixin.setDeckInboxSearchDraft.call(store, '');
    expect(store.deckInboxSearchDraft).toBe('');
    expect(store.deckInboxSearchQuery).toBe('');
    expect(store.deckInboxVisibleCount).toBe(50);
    expect(towerRequest).not.toHaveBeenCalled();
  });

  it('clears draft and applied Inbox search on channel and scope changes while resetting the window', () => {
    const towerRequest = vi.fn();
    const store = {
      deckInboxSearchDraft: 'Flight',
      deckInboxSearchQuery: 'Flight',
      deckInboxVisibleCount: 150,
      deckInboxContextKey: 'scope:scope-a:chan-a',
      deckInboxScopeId: 'scope-a',
      filteredAutopilotOverviewInbox: Array.from({ length: 200 }),
      get visibleAutopilotOverviewInbox() { return this.filteredAutopilotOverviewInbox.slice(0, this.deckInboxVisibleCount); },
      hasMoreAutopilotOverviewInbox: true,
      towerRequest,
      revealMoreDeckInbox() {
        return autopilotOverviewManagerMixin.revealMoreDeckInbox.call(this);
      },
    };

    autopilotOverviewManagerMixin.syncDeckInboxContext.call(store, 'scope:scope-a:chan-b', 'scope-a');
    expect(store.deckInboxSearchDraft).toBe('');
    expect(store.deckInboxSearchQuery).toBe('');
    expect(store.deckInboxVisibleCount).toBe(50);

    store.deckInboxSearchDraft = 'Flight';
    store.deckInboxSearchQuery = 'Flight';
    store.deckInboxVisibleCount = 100;
    autopilotOverviewManagerMixin.syncDeckInboxContext.call(store, 'scope:scope-b:all', 'scope-b');
    expect(store.deckInboxSearchDraft).toBe('');
    expect(store.deckInboxSearchQuery).toBe('');
    expect(store.deckInboxVisibleCount).toBe(50);

    store.deckInboxVisibleCount = 50;
    autopilotOverviewManagerMixin.revealMoreDeckInbox.call(store);
    expect(store.deckInboxVisibleCount).toBe(100);
    autopilotOverviewManagerMixin.revealMoreDeckInbox.call(store);
    expect(store.deckInboxVisibleCount).toBe(150);
    expect(towerRequest).not.toHaveBeenCalled();
  });

  it('includes newly created tasks and documents without updated timestamps', () => {
    const taskRows = buildAutopilotOverviewTasks({
      tasks: [{ record_id: 'task-created', title: 'New task', state: 'review', created_at: '2026-06-15T11:00:00.000Z' }],
    });
    const documentRows = buildAutopilotOverviewDocuments({
      documents: [{ record_id: 'doc-created', title: 'New doc', created_at: '2026-06-15T11:05:00.000Z' }],
    });

    expect(taskRows[0]).toMatchObject({ activityAt: '2026-06-15T11:00:00.000Z', reason: 'Task created', taskState: 'review' });
    expect(documentRows[0]).toMatchObject({ activityAt: '2026-06-15T11:05:00.000Z', reason: 'Document created' });
  });

  it('derives Inbox unread state from actual resource maps and clears reactively', () => {
    const store = {
      channels: [{ record_id: 'chan-1', title: 'Inbox', scope_id: 'scope-1' }],
      messages: [{
        record_id: 'message-1', pg_thread_id: 'thread-1', channel_id: 'chan-1',
        body: 'Thread activity', updated_at: '2026-07-26T10:00:00.000Z',
      }],
      fileMessages: [], fileBrowserRows: [], taskComments: [], docComments: [], fileComments: [],
      tasks: [{ record_id: 'task-1', title: 'Task', scope_id: 'scope-1', pg_channel_id: 'chan-1', updated_at: '2026-07-26T10:01:00.000Z' }],
      documents: [{ record_id: 'doc-1', title: 'Doc', scope_id: 'scope-1', pg_channel_id: 'chan-1', updated_at: '2026-07-26T10:02:00.000Z' }],
      autopilotOverviewContext: { scopeId: 'all', channelId: 'all' },
      scopesMap: null, session: {}, signingNpub: '', isTowerPgMode: true,
      _unreadChannels: {}, _unreadThreadItems: { 'thread-1': true },
      _unreadTaskItems: { 'task-1': true }, _unreadDocItems: { 'doc-1': true },
    };
    const getter = (name) => Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, name).get.call(store);
    Object.defineProperties(store, {
      autopilotOverviewComments: { get: () => getter('autopilotOverviewComments') },
      autopilotOverviewThreads: { get: () => getter('autopilotOverviewThreads') },
      autopilotOverviewFiles: { get: () => getter('autopilotOverviewFiles') },
      autopilotOverviewTasks: { get: () => getter('autopilotOverviewTasks') },
      autopilotOverviewDocuments: { get: () => getter('autopilotOverviewDocuments') },
    });

    expect(getter('autopilotOverviewInbox').filter((item) => item.isUnread).map((item) => item.inboxKind).sort())
      .toEqual(['chat', 'document', 'task']);

    store._unreadThreadItems = {};
    store._unreadTaskItems = {};
    store._unreadDocItems = {};
    expect(getter('autopilotOverviewInbox').filter((item) => item.isUnread)).toEqual([]);
  });

  it('keeps fresh external thread cards unread when page attention is stale until an explicit read clears them', () => {
    const store = {
      channels: [{ record_id: 'lvlup', title: 'LvlUp', scope_id: 'scope-1' }],
      messages: [
        { record_id: 'message-review', pg_thread_id: 'thread-review', channel_id: 'lvlup',
          body: 'We should be reviewing all screens', updated_at: '2026-09-23T01:13:52.434Z' },
        { record_id: 'message-group', pg_thread_id: 'thread-group', channel_id: 'lvlup',
          body: 'Coordinating a Group', updated_at: '2026-09-23T01:11:50.701Z' },
        { record_id: 'message-own', pg_thread_id: 'thread-own', channel_id: 'lvlup',
          body: 'Viewer-authored activity', updated_at: '2026-09-23T01:10:00.000Z' },
      ],
      fileMessages: [], scopesMap: null, session: {}, signingNpub: '', isTowerPgMode: true,
      autopilotOverviewContext: { scopeId: 'all', channelId: 'all' },
      _unreadChannels: {},
      _unreadThreadItems: { 'thread-review': true, 'thread-group': true },
      // The Inbox page query can observe an older pg_resource_attention row.
      // A false page value must not erase the authoritative unread watermark.
      inboxUnreadThreads: { 'thread-review': false, 'thread-group': false, 'thread-own': false },
    };
    const getter = () => Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, 'autopilotOverviewThreads').get.call(store);

    expect(getter().filter((thread) => thread.isUnread).map((thread) => thread.id).sort())
      .toEqual(['thread-group', 'thread-review']);

    store._unreadThreadItems = {};
    expect(getter().filter((thread) => thread.isUnread)).toEqual([]);
  });

  it('does not colour Inbox cards from aggregate-only unread state', () => {
    const store = {
      channels: [{ record_id: 'chan-1', title: 'Inbox', scope_id: 'scope-1' }],
      messages: [{ record_id: 'message-1', pg_thread_id: 'thread-1', channel_id: 'chan-1', body: 'Thread', updated_at: '2026-07-26T10:00:00.000Z' }],
      fileMessages: [], fileBrowserRows: [], taskComments: [], docComments: [], fileComments: [],
      tasks: [{ record_id: 'task-1', title: 'Task', scope_id: 'scope-1', pg_channel_id: 'chan-1', updated_at: '2026-07-26T10:01:00.000Z' }],
      documents: [{ record_id: 'doc-1', title: 'Doc', scope_id: 'scope-1', pg_channel_id: 'chan-1', updated_at: '2026-07-26T10:02:00.000Z' }],
      autopilotOverviewContext: { scopeId: 'all', channelId: 'all' }, scopesMap: null,
      session: {}, signingNpub: '', isTowerPgMode: true,
      _unreadChat: true, _unreadTasks: true, _unreadDocs: true, _unreadDeck: true,
      _unreadChannels: { 'chan-1': true }, _unreadThreadItems: {}, _unreadTaskItems: {}, _unreadDocItems: {},
    };
    const getter = (name) => Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, name).get.call(store);
    Object.defineProperties(store, {
      autopilotOverviewComments: { get: () => getter('autopilotOverviewComments') },
      autopilotOverviewThreads: { get: () => getter('autopilotOverviewThreads') },
      autopilotOverviewFiles: { get: () => getter('autopilotOverviewFiles') },
      autopilotOverviewTasks: { get: () => getter('autopilotOverviewTasks') },
      autopilotOverviewDocuments: { get: () => getter('autopilotOverviewDocuments') },
    });

    expect(getter('autopilotOverviewInbox').filter((item) => item.isUnread)).toEqual([]);
  });

  it('marks Inbox rows working from fresh nonterminal cached activity keys', () => {
    const workingResourceKeys = buildInboxWorkingResourceKeys([
      {
        record_id: 'activity-chat',
        activity_id: 'activity-chat',
        turn_id: 'turn-chat',
        visibility: 'user_visible',
        state: 'working',
        channel_id: 'chan-1',
        thread_id: 'thread-1',
        trigger_message_id: 'message-1',
        agent_npub: 'agent-a',
        expires_at: '2026-09-15T06:10:00.000Z',
        created_at: '2026-09-15T06:00:00.000Z',
      },
      {
        record_id: 'activity-task',
        activity_id: 'activity-task',
        turn_id: 'turn-task',
        visibility: 'user_visible',
        state: 'working',
        task_id: 'task-1',
        agent_npub: 'agent-a',
        expires_at: '2026-09-15T06:10:00.000Z',
        created_at: '2026-09-15T06:01:00.000Z',
      },
      {
        record_id: 'activity-doc',
        activity_id: 'activity-doc',
        turn_id: 'turn-doc',
        visibility: 'user_visible',
        state: 'working',
        target_record_id: 'doc-1',
        target_record_family_hash: recordFamilyHash('document'),
        agent_npub: 'agent-a',
        expires_at: '2026-09-15T06:10:00.000Z',
        created_at: '2026-09-15T06:02:00.000Z',
      },
    ], { nowMs: Date.parse('2026-09-15T06:05:00.000Z') });

    const inbox = buildAutopilotOverviewInbox({
      threads: [{
        id: 'thread-1',
        rootRecordId: 'message-1',
        channelId: 'chan-1',
        title: 'Thread',
        latestMessageUpdatedAt: '2026-09-15T06:03:00.000Z',
      }],
      tasks: [{
        id: 'task:task-1',
        recordId: 'task-1',
        title: 'Task',
        activityAt: '2026-09-15T06:02:00.000Z',
      }],
      documents: [{
        id: 'document:doc-1',
        recordId: 'doc-1',
        title: 'Doc',
        activityAt: '2026-09-15T06:01:00.000Z',
      }],
      files: [{
        object_id: 'file-1',
        name: 'Evidence.pdf',
        activityAt: '2026-09-15T06:04:00.000Z',
      }],
      workingResourceKeys,
    });

    expect(inbox.find((row) => row.inboxKind === 'chat')?.isWorking).toBe(true);
    expect(inbox.find((row) => row.inboxKind === 'task')?.isWorking).toBe(true);
    expect(inbox.find((row) => row.inboxKind === 'document')?.isWorking).toBe(true);
    expect(inbox.find((row) => row.inboxKind === 'file')?.isWorking).toBe(false);
  });

  it('does not mark Inbox rows working for terminal or stale activity', () => {
    const workingResourceKeys = buildInboxWorkingResourceKeys([
      {
        record_id: 'terminal',
        activity_id: 'terminal',
        turn_id: 'terminal',
        visibility: 'user_visible',
        state: 'completed',
        channel_id: 'chan-1',
        thread_id: 'thread-1',
        agent_npub: 'agent-a',
        expires_at: '2026-09-15T06:10:00.000Z',
        created_at: '2026-09-15T06:00:00.000Z',
      },
      {
        record_id: 'stale',
        activity_id: 'stale',
        turn_id: 'stale',
        visibility: 'user_visible',
        state: 'working',
        channel_id: 'chan-2',
        thread_id: 'thread-2',
        agent_npub: 'agent-a',
        expires_at: '2026-09-15T05:59:00.000Z',
        created_at: '2026-09-15T06:01:00.000Z',
      },
    ], { nowMs: Date.parse('2026-09-15T06:05:00.000Z') });

    const inbox = buildAutopilotOverviewInbox({
      threads: [
        { id: 'thread-1', channelId: 'chan-1', latestMessageUpdatedAt: '2026-09-15T06:03:00.000Z' },
        { id: 'thread-2', channelId: 'chan-2', latestMessageUpdatedAt: '2026-09-15T06:02:00.000Z' },
      ],
      workingResourceKeys,
    });

    expect(inbox.map((row) => row.isWorking)).toEqual([false, false]);
  });

  it('keeps the Inbox working projection cached across unrelated composer updates', () => {
    const store = {
      channels: [{ record_id: 'chan-1', title: 'Inbox' }],
      messages: [{
        record_id: 'message-1',
        pg_thread_id: 'thread-1',
        channel_id: 'chan-1',
        body: 'Thread activity',
        updated_at: '2026-09-15T06:03:00.000Z',
      }],
      fileMessages: [],
      fileBrowserRows: [],
      taskComments: [],
      docComments: [],
      fileComments: [],
      tasks: [],
      documents: [],
      autopilotOverviewContext: { scopeId: 'all', channelId: 'all' },
      scopesMap: null,
      session: {},
      signingNpub: '',
      isTowerPgMode: true,
      _unreadChannels: {},
      _unreadThreadItems: {},
      _unreadTaskItems: {},
      _unreadDocItems: {},
      agentActivities: [{
        record_id: 'activity',
        activity_id: 'activity',
        turn_id: 'turn',
        visibility: 'user_visible',
        state: 'working',
        channel_id: 'chan-1',
        thread_id: 'thread-1',
        agent_npub: 'agent-a',
        expires_at: '2999-01-01T00:00:00.000Z',
        created_at: '2026-09-15T06:00:00.000Z',
      }],
      deckInboxWorkingProjectionRevision: 1,
    };
    const getter = (name) => Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin, name).get.call(store);
    Object.defineProperties(store, {
      autopilotOverviewComments: { get: () => getter('autopilotOverviewComments') },
      autopilotOverviewThreads: { get: () => getter('autopilotOverviewThreads') },
      autopilotOverviewFiles: { get: () => getter('autopilotOverviewFiles') },
      autopilotOverviewTasks: { get: () => getter('autopilotOverviewTasks') },
      autopilotOverviewDocuments: { get: () => getter('autopilotOverviewDocuments') },
      deckInboxWorkingResourceKeys: { get: () => getter('deckInboxWorkingResourceKeys') },
    });

    const keys = getter('deckInboxWorkingResourceKeys');
    const inbox = getter('autopilotOverviewInbox');
    expect(inbox[0]).toMatchObject({ inboxKind: 'chat', isWorking: true });

    store.threadInput = 'ordinary composer typing';
    expect(getter('deckInboxWorkingResourceKeys')).toBe(keys);
    expect(getter('autopilotOverviewInbox')).toBe(inbox);

    store.deckInboxWorkingProjectionRevision += 1;
    expect(getter('deckInboxWorkingResourceKeys')).not.toBe(keys);
  });

  it('filters overview threads by scope and channel together', () => {
    expect(buildAutopilotOverviewThreads({
      channels,
      messages,
      selectedScopeId: 'scope-b',
      selectedChannelId: 'chan-b',
    }).map((row) => row.id)).toEqual(['thread-b']);

    expect(buildAutopilotOverviewThreads({
      channels,
      messages,
      selectedScopeId: 'scope-a',
      selectedChannelId: 'chan-b',
    })).toEqual([]);
  });

  it('uses resolved DM channel names in thread cards instead of raw npubs', () => {
    const rows = buildAutopilotOverviewThreads({
      channels: [{
        record_id: 'dm-1',
        title: 'DM: npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266',
        channel_type: 'dm',
        participant_npubs: ['npub1operator-a', 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266'],
      }],
      messages: [{
        record_id: 'thread-dm',
        channel_id: 'dm-1',
        body: 'Hello',
        updated_at: '2026-06-15T10:00:00.000Z',
      }],
      sessionNpub: 'npub1operator-a',
      getSenderName: (npub) => (npub === 'npub1lycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmus6gq266' ? 'Agent B' : npub),
    });

    expect(rows[0].channelLabel).toBe('Agent B');
  });

  it('opens an overview thread directly after selecting its channel', async () => {
    const calls = [];
    const store = {
      ...autopilotOverviewManagerMixin,
      focusMessageId: null,
      navigateTo(section, options) {
        calls.push(['navigateTo', section, options]);
      },
      async selectChannel(recordId, options) {
        calls.push(['selectChannel', recordId, options]);
        this.selectedChannelId = recordId;
      },
      openThread(recordId, options) {
        calls.push(['openThread', recordId, options]);
      },
      syncRoute() {
        calls.push(['syncRoute']);
      },
    };

    await store.openAutopilotOverviewThread({
      id: 'thread-id',
      rootRecordId: 'root-message-id',
      channelId: 'chan-a',
    });

    expect(store.focusMessageId).toBe('root-message-id');
    expect(calls).toEqual([
      ['navigateTo', 'chat', { syncRoute: false, skipChatChannelSelection: true }],
      ['selectChannel', 'chan-a', {
        syncRoute: false,
        backgroundRemoteRefresh: true,
      }],
      ['openThread', 'root-message-id', { syncRoute: false }],
      ['syncRoute'],
    ]);
  });

  it('opens Deck cards in the existing thread modal without selecting their channel', async () => {
    const calls = [];
    const store = {
      navSection: 'status',
      selectedBoardId: 'scope-a',
      selectedChannelId: 'deck-channel',
      fileMessages: [{
        record_id: 'root-a',
        channel_id: 'chan-a',
        pg_thread_id: 'tower-thread-a',
      }],
      messages: [],
      summaryCollapsedPanels: { chats: false },
      summaryPanelPages: { chats: 2 },
      dailyScopeSelectedDate: '2026-07-30',
      autopilotOverviewThreadOpenRequestId: 0,
      captureDeckReturnContext: autopilotOverviewManagerMixin.captureDeckReturnContext,
      openDeckThread: autopilotOverviewManagerMixin.openDeckThread,
      openAutopilotOverviewThread: autopilotOverviewManagerMixin.openAutopilotOverviewThread,
      persistSelectedBoardId: vi.fn(),
      navigateTo: vi.fn(),
      selectChannel: vi.fn(() => {
        throw new Error('Deck thread opening must not select a channel');
      }),
      async applyMessages(messages, options) {
        calls.push(['applyMessages', messages.map((message) => message.record_id), options]);
        this.messages = messages;
      },
      openThread(threadId, options) {
        calls.push(['openThread', threadId, options]);
        this.activeThreadId = threadId;
      },
      requestTowerSyncFamily: vi.fn(() => new Promise(() => {})),
      syncRoute() {
        calls.push(['syncRoute']);
      },
    };

    await store.openAutopilotOverviewThread({ rootRecordId: 'root-a', channelId: 'chan-a' });

    expect(store.navSection).toBe('status');
    expect(store.navigateTo).not.toHaveBeenCalled();
    expect(store.selectedBoardId).toBe('scope-a');
    expect(store.selectedChannelId).toBe('deck-channel');
    expect(store.selectChannel).not.toHaveBeenCalled();
    expect(store.deckThreadChannelId).toBe('chan-a');
    expect(store.deckThreadTowerId).toBe('tower-thread-a');
    expect(store.activeThreadId).toBe('root-a');
    expect(calls).toEqual([
      ['openThread', 'root-a', {
        syncRoute: false,
        preserveChannelContext: true,
        saveDraft: false,
        scrollToLatest: undefined,
      }],
      ['syncRoute'],
    ]);
    expect(store.requestTowerSyncFamily).not.toHaveBeenCalled();
  });

  it('keeps the first Deck thread open through delayed cold channel hydration until explicit close', async () => {
    const closeThread = vi.fn(function closeThread() {
      this.activeThreadId = null;
      return true;
    });
    const store = {
      ...autopilotOverviewManagerMixin,
      navSection: 'status',
      currentWorkspace: { pgBackendMode: true },
      selectedBoardId: null,
      selectedChannelId: null,
      channels: [],
      channelOrder: [],
      fileMessages: [{
        record_id: 'root-a',
        channel_id: 'chan-a',
        pg_thread_id: 'tower-thread-a',
      }],
      messages: [],
      summaryCollapsedPanels: {},
      summaryPanelPages: {},
      dailyScopeSelectedDate: '',
      MAIN_FEED_PAGE_SIZE: 20,
      closeThread,
      getChannelParticipants: vi.fn(() => []),
      rememberPeople: vi.fn(async () => undefined),
      startSelectedChannelLiveQuery: vi.fn(),
      updatePageTitle: vi.fn(),
      syncRoute: vi.fn(),
      applyMessages: vi.fn(async function applyMessages(nextMessages) {
        this.messages = nextMessages;
      }),
      openThread: vi.fn(function openThread(threadId) {
        this.activeThreadId = threadId;
      }),
    };

    await store.openAutopilotOverviewThread({
      rootRecordId: 'root-a',
      id: 'tower-thread-a',
      channelId: 'chan-a',
    });
    expect(store.activeThreadId).toBe('root-a');

    await Promise.resolve().then(() => channelsManagerMixin.applyChannels.call(store, [{
      record_id: 'chan-a',
      title: 'Implementation',
      scope_id: 'scope-a',
      record_state: 'active',
    }], { syncRoute: false }));

    expect(store.selectedChannelId).toBe('chan-a');
    expect(store.activeThreadId).toBe('root-a');
    expect(store.openThread).toHaveBeenCalledTimes(1);
    expect(closeThread).not.toHaveBeenCalled();

    store.closeDeckThread({ syncRoute: false });
    expect(closeThread).toHaveBeenCalledTimes(1);
    expect(store.activeThreadId).toBeNull();
  });

  it('hydrates a missing Deck thread channel and reaches reply-ready state', async () => {
    const channel = { record_id: 'chan-a', title: 'Implementation', record_state: 'active' };
    const store = {
      ...autopilotOverviewManagerMixin,
      activeThreadId: 'root-a',
      deckThreadChannelId: 'chan-a',
      channels: [],
      requestTowerSyncFamily: vi.fn(async () => {
        store.channels = [channel];
      }),
    };

    await store.resolveDeckThreadChannel('chan-a');

    expect(store.requestTowerSyncFamily).toHaveBeenCalledWith('channels', '', { force: true });
    expect(store.deckThreadChannelState).toBe('ready');
    expect(store.deckThreadChannelRecord).toBe(channel);
    expect(store.deckThreadChannelError).toBe('');
  });

  it('keeps a failed Deck channel refresh visible and retryable', async () => {
    const store = {
      ...autopilotOverviewManagerMixin,
      activeThreadId: 'root-a',
      deckThreadChannelId: 'chan-a',
      channels: [],
      requestTowerSyncFamily: vi.fn()
        .mockRejectedValueOnce(new Error('Tower is offline'))
        .mockImplementationOnce(async () => {
          store.channels = [{ record_id: 'chan-a', record_state: 'active' }];
        }),
    };

    expect(await store.resolveDeckThreadChannel('chan-a')).toBe(false);
    expect(store.deckThreadChannelState).toBe('error');
    expect(store.deckThreadChannelError).toBe('Tower is offline');

    expect(await store.retryDeckThreadChannel()).toBe(true);
    expect(store.deckThreadChannelState).toBe('ready');
    expect(store.deckThreadChannelError).toBe('');
  });

  it('opens a reply-only Inbox row over Deck and closes back to its exact context', async () => {
    const originalDocument = globalThis.document;
    const originalAnimationFrame = globalThis.requestAnimationFrame;
    const scrollArea = { scrollTop: 420 };
    const columnsTrack = { scrollLeft: 360 };
    const inboxColumn = { scrollTop: 210 };
    const recentColumn = { scrollTop: 95 };
    globalThis.document = { querySelector: vi.fn((selector) => ({
      '.content-scroll-area': scrollArea,
      '[data-deck-columns-track]': columnsTrack,
      '[data-deck-column="inbox"]': inboxColumn,
      '[data-deck-column="recent"]': recentColumn,
    })[selector] || null) };
    globalThis.requestAnimationFrame = (callback) => callback();
    try {
      const messages = [{
        record_id: 'reply-1',
        channel_id: 'chan-a',
        pg_thread_id: 'tower-thread-1',
        parent_message_id: 'source-message-1',
        body: 'Reply loaded without the older source message',
        updated_at: '2026-07-31T02:45:00.000Z',
      }];
      const inboxRow = buildAutopilotOverviewInbox({
        threads: buildAutopilotOverviewThreads({ channels, messages }),
      })[0];
      const store = {
        ...autopilotOverviewManagerMixin,
        navSection: 'status',
        channels,
        fileMessages: messages,
        messages,
        selectedBoardId: 'scope-a',
        selectedChannelId: 'deck-channel',
        summaryCollapsedPanels: { chats: true },
        summaryPanelPages: { chats: 3 },
        dailyScopeSelectedDate: '2026-07-31',
        deckMobileColumn: 'recent',
        persistSelectedBoardId: vi.fn(),
        restoreChatComposerDraft: vi.fn(),
        selectChannel: vi.fn(() => {
          throw new Error('Deck thread opening must not select a channel');
        }),
        selectPgChannelContext: vi.fn(() => {
          throw new Error('Deck thread opening must not promote PG channel context');
        }),
        async applyMessages(nextMessages) {
          this.messages = nextMessages;
        },
        openThread(threadId, options) {
          expect(options.preserveChannelContext).toBe(true);
          this.activeThreadId = threadId;
        },
        closeThread() { this.activeThreadId = null; },
        syncRoute: vi.fn(),
      };

      await store.openAutopilotOverviewThread(inboxRow);

      expect(store.activeThreadId).toBe('source-message-1');
      expect(store.deckThreadChannelId).toBe('chan-a');
      expect(store.deckThreadTowerId).toBe('tower-thread-1');
      expect(store.selectedBoardId).toBe('scope-a');
      expect(store.selectedChannelId).toBe('deck-channel');
      expect(store.selectChannel).not.toHaveBeenCalled();
      expect(store.selectPgChannelContext).not.toHaveBeenCalled();
      expect(messages.some((message) => (
        message.record_id === store.activeThreadId || message.parent_message_id === store.activeThreadId
      ))).toBe(true);

      await expect(store.reconcileDeckThreadMessages([])).resolves.toBe(true);
      expect(store.activeThreadId).toBe('source-message-1');
      await expect(store.reconcileDeckThreadMessages([
        ...messages,
        { ...messages[0], record_id: 'reply-2', body: 'Reconciled reply' },
      ])).resolves.toBe(true);
      expect(store.activeThreadId).toBe('source-message-1');

      store.summaryCollapsedPanels = { chats: false };
      store.summaryPanelPages = { chats: 0 };
      store.dailyScopeSelectedDate = '2026-07-30';
      store.deckMobileColumn = 'inbox';
      scrollArea.scrollTop = 0;
      columnsTrack.scrollLeft = 0;
      inboxColumn.scrollTop = 0;
      recentColumn.scrollTop = 0;

      store.closeDeckThread({ syncRoute: false });

      expect(store.activeThreadId).toBeNull();
      expect(store.selectedBoardId).toBe('scope-a');
      expect(store.selectedChannelId).toBe('deck-channel');
      expect(store.summaryCollapsedPanels).toEqual({ chats: true });
      expect(store.summaryPanelPages).toEqual({ chats: 3 });
      expect(store.dailyScopeSelectedDate).toBe('2026-07-31');
      expect(store.deckMobileColumn).toBe('recent');
      expect(scrollArea.scrollTop).toBe(420);
      expect(columnsTrack.scrollLeft).toBe(360);
      expect(inboxColumn.scrollTop).toBe(210);
      expect(recentColumn.scrollTop).toBe(95);
    } finally {
      globalThis.document = originalDocument;
      globalThis.requestAnimationFrame = originalAnimationFrame;
    }
  });

  it('opens a Recent channels row in Chat instead of the over-Deck modal', async () => {
    const store = {
      ...autopilotOverviewManagerMixin,
      selectedChannelId: null,
      navigateTo: vi.fn(),
      selectChannel: vi.fn(async function selectChannel(channelId) { this.selectedChannelId = channelId; }),
      openThread: vi.fn(),
      openDeckThread: vi.fn(),
      syncRoute: vi.fn(),
    };

    await expect(store.openDeckRecentChannel({
      id: 'thread-a',
      rootRecordId: 'root-a',
      channelId: 'chan-a',
    })).resolves.toBe(true);

    expect(store.navigateTo).toHaveBeenCalledWith('chat', { syncRoute: false, skipChatChannelSelection: true });
    expect(store.openThread).toHaveBeenCalledWith('root-a', { syncRoute: false });
    expect(store.openDeckThread).not.toHaveBeenCalled();
  });

  it('tracks the selected mobile Deck column from the snapping track', () => {
    const store = { deckMobileColumn: 'inbox', handleDeckColumnsScroll: autopilotOverviewManagerMixin.handleDeckColumnsScroll };
    Object.setPrototypeOf(store, autopilotOverviewManagerMixin);
    store.handleDeckColumnsScroll({ currentTarget: { clientWidth: 360, scrollLeft: 20 } });
    expect(store.deckMobileColumn).toBe('hello-links');
    store.handleDeckColumnsScroll({ currentTarget: { clientWidth: 360, scrollLeft: 400 } });
    expect(store.deckMobileColumn).toBe('inbox');
    store.handleDeckColumnsScroll({ currentTarget: { clientWidth: 360, scrollLeft: 750 } });
    expect(store.deckMobileColumn).toBe('wapp-updates');
    store.handleDeckColumnsScroll({ currentTarget: { clientWidth: 360, scrollLeft: 1100 } });
    expect(store.deckMobileColumn).toBe('recent');
  });

  it('holds Inbox through stale scroll events while a fresh mobile Deck entry settles', () => {
    const originalAnimationFrame = globalThis.requestAnimationFrame;
    const callbacks = [];
    globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
    try {
      const inbox = { offsetLeft: 360, querySelector: vi.fn(() => null) };
      const track = {
        offsetLeft: 0,
        scrollLeft: 0,
        clientWidth: 360,
        querySelector: vi.fn((selector) => selector === '[data-deck-column="inbox"]' ? inbox : null),
      };
      const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
        deckMobileTrack: track,
        deckMobileColumn: 'recent',
      });

      expect(store.resetDeckMobileEntry()).toBe(true);
      expect(store.deckMobileColumn).toBe('inbox');
      expect(track.scrollLeft).toBe(360);

      track.scrollLeft = 0;
      store.handleDeckColumnsScroll({ currentTarget: track });
      expect(store.deckMobileColumn).toBe('inbox');

      callbacks.shift()();
      expect(track.scrollLeft).toBe(360);
      callbacks.shift()();
      expect(store.deckMobileEntryResetPending).toBe(false);

      track.scrollLeft = 720;
      store.handleDeckColumnsScroll({ currentTarget: track });
      expect(store.deckMobileColumn).toBe('wapp-updates');
    } finally {
      globalThis.requestAnimationFrame = originalAnimationFrame;
    }
  });

  it('positions Inbox before revealing the initial mobile Deck and preserves selection on resize', () => {
    const inbox = { offsetLeft: 360, querySelector: vi.fn(() => null) };
    const feed = { offsetLeft: 720, querySelector: vi.fn(() => null) };
    const track = {
      offsetLeft: 0,
      scrollLeft: 0,
      dataset: {},
      querySelector: vi.fn((selector) => ({
        '[data-deck-column="inbox"]': inbox,
        '[data-deck-column="wapp-updates"]': feed,
      })[selector] || null),
    };
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), { deckMobileTrack: track });

    expect(store.positionDeckMobileCard('inbox')).toBe(true);
    expect(track.scrollLeft).toBe(360);
    store.deckMobileColumn = 'wapp-updates';
    expect(store.positionDeckMobileCard(store.deckMobileColumn)).toBe(true);
    expect(track.scrollLeft).toBe(720);
    expect(store.selectDeckMobileCard('missing')).toBe(false);
  });

  function createDeckComposerStore(overrides = {}) {
    return Object.assign(Object.create(autopilotOverviewManagerMixin), {
      navSection: 'status',
      selectedBoardId: '__all__',
      selectedChannelId: null,
      pgContextSelectedChannelId: null,
      channels,
      messages: [],
      summaryCollapsedPanels: {},
      summaryPanelPages: {},
      dailyScopeSelectedDate: '',
      threadInput: '',
      threadTitleDraft: '',
      threadAudioDrafts: [],
      threadFileDrafts: [],
      selectedAgentMentionsByComposer: { message: [], thread: [] },
      error: null,
      persistSelectedBoardId: vi.fn(),
      selectChannel: vi.fn(async function selectChannel(channelId) {
        this.selectedChannelId = channelId;
        this.pgContextSelectedChannelId = channelId;
      }),
      clearChatFileDrafts: vi.fn(function clearChatFileDrafts() { this.threadFileDrafts = []; }),
      scheduleComposerAutosize: vi.fn(),
      ...overrides,
    });
  }

  it('opens the shared create-mode thread surface directly for concrete channel context', async () => {
    const store = createDeckComposerStore({
      selectedBoardId: buildPgChannelTaskBoardId('chan-a'),
      selectedChannelId: 'chan-a',
      pgContextSelectedChannelId: 'chan-a',
      resolvePgWriteContext: vi.fn(() => ({ scopeId: 'scope-a', channelId: 'chan-a' })),
    });

    await expect(store.openDeckThreadComposer()).resolves.toBe(true);

    expect(store.deckThreadComposerOpen).toBe(true);
    expect(store.deckThreadComposerChannelId).toBe('chan-a');
    expect(store.showWriteContextModal).not.toBe(true);
    expect(store.threadInput).toBe('');
    expect(store.threadTitleDraft).toBe('');
  });

  it.each([
    ['whole workspace', '__all__', ''],
    ['scope home', 'scope-a', 'scope-a'],
  ])('routes %s context through explicit scope and channel selection', async (_label, boardId, expectedScopeId) => {
    const store = createDeckComposerStore({
      selectedBoardId: boardId,
      resolvePgWriteContext: vi.fn(() => null),
    });

    await store.openDeckThreadComposer();

    expect(store.showWriteContextModal).toBe(true);
    expect(store.writeContextPendingAction?.type).toBe('deck-thread-create');
    expect(store.writeContextScopeId).toBe(expectedScopeId);
    expect(store.writeContextChannelId).toBe('');
    expect(store.deckThreadComposerOpen).toBe(false);
  });

  it('rejects invalid or non-writable create destinations', async () => {
    const store = createDeckComposerStore({
      channels: [{ record_id: 'read-only', scope_id: 'scope-a', can_write: false }],
    });

    await expect(store.beginDeckThreadCreate('missing')).resolves.toBe(false);
    await expect(store.beginDeckThreadCreate('read-only')).resolves.toBe(false);
    expect(store.deckThreadComposerOpen).toBe(false);
    expect(store.error).toContain('writable channel');
  });

  it('derives ten visible words live, preserves manual edits, and resets fresh attempts', () => {
    expect(deriveDeckThreadCreateTitle('  One,\n two!\tthree?  ')).toBe('One, two! three?');
    expect(deriveDeckThreadCreateTitle('one two three four five six seven eight nine ten eleven')).toBe('one two three four five six seven eight nine ten');
    expect(deriveDeckThreadCreateTitle('@[Test Agent](mention:agent:npub1testagent) @[Task](mention:task:id)')).toBe('Untitled thread');

    const store = createDeckComposerStore();
    store.deckThreadComposerOpen = true;
    store.threadInput = 'one two three';
    expect(store.updateDeckThreadCreateBody()).toBe('one two three');
    store.editDeckThreadCreateTitle('My explicit title');
    store.threadInput = 'body changed completely';
    expect(store.updateDeckThreadCreateBody()).toBe('My explicit title');

    store.resetDeckThreadCreateState();
    expect(store.deckThreadTitleManuallyEdited).toBe(false);
    expect(store.threadTitleDraft).toBe('');
    expect(store.threadInput).toBe('');
  });

  it('reuses one idempotency key across an ambiguous retry and opens the single accepted thread', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ record_id: 'root-1', pg_thread_id: 'thread-1' });
    const openDeckThread = vi.fn().mockResolvedValue(true);
    const store = createDeckComposerStore({
      selectedChannelId: 'chan-a',
      pgContextSelectedChannelId: 'chan-a',
      deckThreadComposerOpen: true,
      deckThreadComposerChannelId: 'chan-a',
      deckThreadCreateRequestId: 'attempt-1',
      deckThreadReturnContext: { selectedBoardId: 'scope-a' },
      threadInput: 'one two three',
      threadTitleDraft: 'one two three',
      sendMessage,
      openDeckThread,
      restoreDeckReturnContext: vi.fn(),
    });

    await expect(store.sendDeckThread()).resolves.toBe(false);
    expect(store.deckThreadCreateRequestId).toBe('attempt-1');
    await expect(store.sendDeckThread()).resolves.toBe(true);

    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientRequestId: 'attempt-1' }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientRequestId: 'attempt-1' }));
    expect(openDeckThread).toHaveBeenCalledWith('chan-a', 'root-1', expect.objectContaining({
      towerThreadId: 'thread-1',
      captureReturnContext: false,
    }));
  });

  it('ignores repeated thread-create submissions while the first attempt is pending', async () => {
    let resolveSend;
    const sendMessage = vi.fn(() => new Promise((resolve) => {
      resolveSend = () => resolve({ record_id: 'root-1', pg_thread_id: 'thread-1' });
    }));
    const store = createDeckComposerStore({
      selectedChannelId: 'chan-a',
      pgContextSelectedChannelId: 'chan-a',
      deckThreadComposerOpen: true,
      deckThreadComposerChannelId: 'chan-a',
      deckThreadCreateRequestId: 'attempt-1',
      deckThreadReturnContext: { selectedBoardId: 'scope-a' },
      threadInput: 'one two three',
      threadTitleDraft: 'one two three',
      sendMessage,
      openDeckThread: vi.fn().mockResolvedValue(true),
      restoreDeckReturnContext: vi.fn(),
    });

    const first = store.sendDeckThread();
    expect(store.deckThreadComposerBusy).toBe(true);
    await expect(store.sendDeckThread()).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    resolveSend();
    await expect(first).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('clears create state on cancel and can return a routed create attempt to routing', () => {
    const restoreDeckReturnContext = vi.fn();
    const store = createDeckComposerStore({
      selectedBoardId: 'scope-a',
      deckThreadReturnContext: { selectedBoardId: 'scope-a' },
      restoreDeckReturnContext,
    });
    store.deckThreadComposerOpen = true;
    store.deckThreadComposerRouted = true;
    store.deckThreadComposerChannelId = 'chan-a';
    store.threadInput = 'draft';
    store.threadTitleDraft = 'draft';

    expect(store.backDeckThreadComposerToRouting()).toBe(true);
    expect(store.showWriteContextModal).toBe(true);
    expect(store.writeContextScopeId).toBe('scope-a');
    expect(store.writeContextChannelId).toBe('chan-a');
    expect(store.threadInput).toBe('');

    store.cancelDeckThreadRouting();
    expect(restoreDeckReturnContext).toHaveBeenCalledWith({ selectedBoardId: 'scope-a' });
    expect(store.deckThreadReturnContext).toBeNull();
    expect(store.showWriteContextModal).toBe(false);
  });

  it('restores Deck context, panel state, and content scroll when its thread closes', () => {
    const originalDocument = globalThis.document;
    const originalAnimationFrame = globalThis.requestAnimationFrame;
    const scrollArea = { scrollTop: 420 };
    const columnsTrack = { scrollLeft: 360 };
    const inboxColumn = { scrollTop: 210 };
    const recentColumn = { scrollTop: 95 };
    globalThis.document = { querySelector: vi.fn((selector) => ({
      '.content-scroll-area': scrollArea,
      '[data-deck-columns-track]': columnsTrack,
      '[data-deck-column="inbox"]': inboxColumn,
      '[data-deck-column="recent"]': recentColumn,
    })[selector] || null) };
    globalThis.requestAnimationFrame = (callback) => callback();
    try {
      const store = {
        navSection: 'status',
        selectedBoardId: 'scope-a',
        selectedChannelId: null,
        summaryCollapsedPanels: { chats: true },
        summaryPanelPages: { chats: 3 },
        dailyScopeSelectedDate: '2026-07-30',
        deckMobileColumn: 'recent',
        persistSelectedBoardId: vi.fn(),
        restoreChatComposerDraft: vi.fn(),
        closeThread: vi.fn(function closeThread() { this.activeThreadId = null; }),
        syncRoute: vi.fn(),
        captureDeckReturnContext: autopilotOverviewManagerMixin.captureDeckReturnContext,
        restoreDeckReturnContext: autopilotOverviewManagerMixin.restoreDeckReturnContext,
        closeDeckThread: autopilotOverviewManagerMixin.closeDeckThread,
      };
      store.deckThreadReturnContext = store.captureDeckReturnContext();
      store.selectedBoardId = buildPgChannelTaskBoardId('chan-a');
      store.selectedChannelId = 'chan-a';
      store.summaryCollapsedPanels = { chats: false };
      store.summaryPanelPages = { chats: 0 };
      store.dailyScopeSelectedDate = '2026-07-29';
      store.deckMobileColumn = 'inbox';
      scrollArea.scrollTop = 0;
      columnsTrack.scrollLeft = 0;
      inboxColumn.scrollTop = 0;
      recentColumn.scrollTop = 0;

      store.closeDeckThread({ syncRoute: false });

      expect(store.selectedBoardId).toBe('scope-a');
      expect(store.selectedChannelId).toBeNull();
      expect(store.summaryCollapsedPanels).toEqual({ chats: true });
      expect(store.summaryPanelPages).toEqual({ chats: 3 });
      expect(store.dailyScopeSelectedDate).toBe('2026-07-30');
      expect(store.deckMobileColumn).toBe('recent');
      expect(scrollArea.scrollTop).toBe(420);
      expect(columnsTrack.scrollLeft).toBe(360);
      expect(inboxColumn.scrollTop).toBe(210);
      expect(recentColumn.scrollTop).toBe(95);
      expect(store.closeThread).toHaveBeenCalledWith({ syncRoute: false });
    } finally {
      globalThis.document = originalDocument;
      globalThis.requestAnimationFrame = originalAnimationFrame;
    }
  });

  it('rebinds responsive Deck layout to the current hello card after route hydration', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalResizeObserver = globalThis.ResizeObserver;
    const staleParent = { contains: vi.fn(() => false) };
    const staleMarker = { isConnected: true, parentNode: staleParent };
    const currentParent = {
      contains: vi.fn(() => true),
      insertBefore: vi.fn(),
    };
    const helloCard = { parentNode: currentParent };
    const track = { dataset: {} };
    const nextMarker = { isConnected: true, parentNode: currentParent };
    const removeEventListener = vi.fn();
    const disconnect = vi.fn();
    globalThis.document = {
      querySelector: vi.fn(() => helloCard),
      createComment: vi.fn(() => nextMarker),
    };
    globalThis.window = {
      matchMedia: vi.fn(() => ({ matches: false, addEventListener: vi.fn() })),
    };
    globalThis.ResizeObserver = undefined;
    try {
      const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
        deckMobileHelloMarker: staleMarker,
        deckMobileMediaQuery: { removeEventListener },
        deckMobileMediaQueryHandler: vi.fn(),
        deckMobileResizeObserver: { disconnect },
      });

      store.initMobileDeck(track);

      expect(removeEventListener).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(currentParent.insertBefore).toHaveBeenCalledWith(nextMarker, helloCard);
      expect(store.deckMobileHelloMarker).toBe(nextMarker);
      expect(helloCard.parentNode).toBe(currentParent);
    } finally {
      globalThis.document = originalDocument;
      globalThis.window = originalWindow;
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('uses browser back to close a Deck thread opened as a modal history entry', () => {
    const originalWindow = globalThis.window;
    const back = vi.fn();
    globalThis.window = { history: { state: { deckThreadModal: true }, back } };
    try {
      const store = {
        deckThreadReturnContext: { selectedBoardId: 'scope-a' },
        closeThread: vi.fn(),
        closeDeckThread: autopilotOverviewManagerMixin.closeDeckThread,
      };

      expect(store.closeDeckThread()).toBe(true);
      expect(back).toHaveBeenCalledTimes(1);
      expect(store.closeThread).not.toHaveBeenCalled();
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('lets only the latest Deck thread tap finish navigation', async () => {
    const selections = new Map();
    const store = {
      ...autopilotOverviewManagerMixin,
      selectedChannelId: null,
      focusMessageId: null,
      navigateTo: vi.fn(),
      selectChannel: vi.fn((recordId) => new Promise((resolve) => {
        selections.set(recordId, () => {
          store.selectedChannelId = recordId;
          resolve();
        });
      })),
      openThread: vi.fn(),
      syncRoute: vi.fn(),
    };

    const first = store.openAutopilotOverviewThread({
      rootRecordId: 'root-a',
      channelId: 'chan-a',
    });
    const second = store.openAutopilotOverviewThread({
      rootRecordId: 'root-b',
      channelId: 'chan-b',
    });

    selections.get('chan-b')();
    await second;
    selections.get('chan-a')();
    await first;

    expect(store.focusMessageId).toBe('root-b');
    expect(store.openThread).toHaveBeenCalledTimes(1);
    expect(store.openThread).toHaveBeenCalledWith('root-b', { syncRoute: false });
    expect(store.syncRoute).toHaveBeenCalledTimes(1);
  });

  it('keeps canonical PDFs in overview files and routes stale file document cards to preview', () => {
    const rows = buildAutopilotOverviewFiles([{ object_id: 'pdf', kind: 'document', pg_record_type: 'file', source_type: 'document' }]);
    expect(rows).toHaveLength(1);
    const store = { ...autopilotOverviewManagerMixin, documents: [{ record_id: 'file', pg_record_type: 'file', pg_storage_object_id: 'image-object' }], openFilePreview: vi.fn(), openDoc: vi.fn() };
    store.openAutopilotOverviewDocument({ recordId: 'file' });
    expect(store.openFilePreview).toHaveBeenCalledWith(expect.objectContaining({ object_id: 'image-object' }));
    expect(store.openDoc).not.toHaveBeenCalled();
  });

  it('opens overview tasks and documents in their specific detail views', () => {
    const store = {
      ...autopilotOverviewManagerMixin,
      navigateTo: vi.fn(),
      openTaskDetail: vi.fn(),
      openDoc: vi.fn(),
    };

    store.openAutopilotOverviewTask({ recordId: 'task-1' });
    store.openAutopilotOverviewDocument({ recordId: 'doc-1', count: 2, hrefTarget: { focusId: 'comment-1' } });

    expect(store.navigateTo).toHaveBeenCalledWith('tasks', { syncRoute: false });
    expect(store.openTaskDetail).toHaveBeenCalledWith('task-1');
    expect(store.openDoc).toHaveBeenCalledWith('doc-1', { commentId: 'comment-1', showComments: true });
  });

  it('derives overview context from the existing selected channel and scope state', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      channels,
      selectedBoardId: buildPgChannelTaskBoardId('chan-a'),
      pgContextSelectedChannelId: 'chan-a',
      selectedChannelId: 'chan-b',
      scopesMap: new Map([
        ['scope-a', { record_id: 'scope-a', title: 'Implementation' }],
        ['scope-b', { record_id: 'scope-b', title: 'Design' }],
      ]),
    });

    expect(store.autopilotOverviewContext).toEqual({
      mode: 'context',
      scopeId: 'scope-a',
      channelId: 'chan-a',
    });
  });

  it('treats explicit All scope as unfiltered even when a previous channel is remembered', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      channels,
      messages,
      selectedBoardId: '__all__',
      pgContextSelectedChannelId: null,
      selectedChannelId: 'chan-a',
      scopesMap: new Map([
        ['scope-a', { record_id: 'scope-a', title: 'Implementation' }],
        ['scope-b', { record_id: 'scope-b', title: 'Design' }],
      ]),
    });

    expect(store.autopilotOverviewContext).toEqual({
      mode: 'all',
      scopeId: 'all',
      channelId: 'all',
    });
    expect(store.autopilotOverviewContextLabel).toBe('All workspace activity');
    expect(store.autopilotOverviewThreads.map((thread) => thread.channelId).sort()).toEqual(['chan-a', 'chan-b']);
  });

  it('shows today daily scope note even when it still has scope metadata', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      selectedBoardId: '__all__',
      pgContextSelectedChannelId: null,
      selectedChannelId: 'chan-a',
      getTodayDateKey: () => '2026-06-17',
      getSenderName: (npub) => (npub === 'npub1operator-a' ? 'Test Operator' : npub),
      dailyNotes: [
        {
          record_id: 'daily-older',
          note_date: '2026-06-17',
          title: 'Older Daily Scope',
          focus: 'Old focus',
          pg_scope_id: 'scope-a',
          pg_channel_id: 'chan-a',
          updated_at: '2026-06-17T08:00:00.000Z',
        },
        {
          record_id: 'daily-newer',
          note_date: '2026-06-17',
          title: 'Daily note',
          body: 'Narrative should not render in the preview card',
          focus: 'Deploy Kindling Pipelines, Kick Off Plantrite, Scout Cash',
          updated_by_actor_npub: 'npub1operator-a',
          items: [
            { id: 'one', text: 'Deploy Kindling Pipelines', completed: true },
            { id: 'two', text: 'Kick Off Plantrite', completed: false },
            { id: 'three', text: 'Scout Cash', completed: false },
            { id: 'four', text: 'Review Daily Scope', completed: false },
          ],
          metadata: { scope_id: 'scope-b', channel_id: 'chan-b', source: 'manual' },
          updated_at: '2026-06-17T09:00:00.000Z',
        },
      ],
    });

    expect(store.autopilotOverviewDailyNote).toEqual(expect.objectContaining({
      note: expect.objectContaining({ record_id: 'daily-newer' }),
      duplicateCount: 1,
      dateKey: '2026-06-17',
      title: 'My Focus 17th June 2026',
      progress: '1/4 done',
      body: 'Narrative should not render in the preview card',
      hasMoreBody: false,
      updatedByLabel: 'Test Operator',
      metaLabel: 'Updated Test Operator',
      items: [
        { id: 'one', text: 'Deploy Kindling Pipelines', completed: true },
        { id: 'two', text: 'Kick Off Plantrite', completed: false },
        { id: 'three', text: 'Scout Cash', completed: false },
        { id: 'four', text: 'Review Daily Scope', completed: false },
      ],
    }));
  });

  it('does not expose raw pubkeys in the Daily Scope updated-by label', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      getTodayDateKey: () => '2026-06-17',
      getSenderName: (npub) => npub,
      dailyNotes: [{
        record_id: 'daily-key',
        note_date: '2026-06-17',
        title: 'Daily note',
        body: 'Narrative',
        updated_by_actor_npub: 'npub1abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
        metadata: { source: 'manual' },
        updated_at: '2026-06-17T09:00:00.000Z',
      }],
    });

    expect(store.autopilotOverviewDailyNote).toEqual(expect.objectContaining({
      updatedBy: 'npub1abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
      updatedByLabel: '',
      source: 'manual',
    }));
  });

  it('pages Daily Scope dates and shows an empty create state for missing days', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      getTodayDateKey: () => '2026-06-17',
      dailyScopeSelectedDate: '',
      dailyNotes: [],
    });

    expect(store.autopilotOverviewDailyNote).toEqual(expect.objectContaining({
      dateKey: '2026-06-17',
      title: 'My Focus 17th June 2026',
      body: 'Create Daily Note for 17th June 2026.',
      metaLabel: 'Not created yet',
    }));
    expect(store.autopilotOverviewDailyScopeCanGoNext).toBe(true);

    store.showPreviousDailyScopeNote();

    expect(store.dailyScopeSelectedDate).toBe('2026-06-16');
    expect(store.autopilotOverviewDailyScopeCanGoNext).toBe(true);
    expect(store.autopilotOverviewDailyNote).toEqual(expect.objectContaining({
      dateKey: '2026-06-16',
      title: 'My Focus 16th June 2026',
      body: 'Create Daily Note for 16th June 2026.',
    }));

    store.showNextDailyScopeNote();
    expect(store.dailyScopeSelectedDate).toBe('2026-06-17');

    store.showNextDailyScopeNote();
    expect(store.dailyScopeSelectedDate).toBe('2026-06-18');
    expect(store.autopilotOverviewDailyNote).toEqual(expect.objectContaining({
      dateKey: '2026-06-18',
      title: 'My Focus 18th June 2026',
      body: 'Create Daily Note for 18th June 2026.',
    }));
  });

  it('opens a Daily Scope date picker and jumps to selected dates or today', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      getTodayDateKey: () => '2026-06-17',
      dailyScopeSelectedDate: '2026-06-18',
      dailyScopeDatePickerOpen: false,
      dailyScopeDatePickerValue: '',
      dailyNotes: [],
    });

    store.openDailyScopeDatePicker();
    expect(store.dailyScopeDatePickerOpen).toBe(true);
    expect(store.dailyScopeDatePickerValue).toBe('2026-06-18');

    store.selectDailyScopeDate('2026-06-20');
    expect(store.dailyScopeSelectedDate).toBe('2026-06-20');
    expect(store.dailyScopeDatePickerOpen).toBe(false);

    store.showTodayDailyScopeNote();
    expect(store.dailyScopeSelectedDate).toBe('2026-06-17');
  });

  it('toggles overview summary panels by id', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      summaryCollapsedPanels: {},
    });

    expect(store.isSummaryPanelCollapsed('chats')).toBe(false);
    store.toggleSummaryPanel('chats');
    expect(store.isSummaryPanelCollapsed('chats')).toBe(true);
    store.toggleSummaryPanel('chats');
    expect(store.isSummaryPanelCollapsed('chats')).toBe(false);
  });

  it('pages overview summary panels by five rows', () => {
    const store = Object.assign(Object.create(autopilotOverviewManagerMixin), {
      summaryPanelPages: {},
    });
    Object.defineProperty(store, 'autopilotOverviewThreads', {
      get() {
        return Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index + 1}` }));
      },
      configurable: true,
    });

    expect(store.pagedAutopilotOverviewThreads.map((row) => row.id)).toEqual([
      'thread-1',
      'thread-2',
      'thread-3',
      'thread-4',
      'thread-5',
    ]);
    expect(store.canShowPreviousSummaryPanelPage('chats')).toBe(false);
    expect(store.canShowNextSummaryPanelPage('chats')).toBe(true);

    store.showNextSummaryPanelPage('chats');
    expect(store.pagedAutopilotOverviewThreads.map((row) => row.id)).toEqual([
      'thread-6',
      'thread-7',
      'thread-8',
      'thread-9',
      'thread-10',
    ]);
    expect(store.canShowPreviousSummaryPanelPage('chats')).toBe(true);

    store.showNextSummaryPanelPage('chats');
    expect(store.pagedAutopilotOverviewThreads.map((row) => row.id)).toEqual(['thread-11', 'thread-12']);
    expect(store.canShowNextSummaryPanelPage('chats')).toBe(false);

    store.showPreviousSummaryPanelPage('chats');
    expect(store.pagedAutopilotOverviewThreads.map((row) => row.id)[0]).toBe('thread-6');
  });

  it('counts only unresolved document comments', () => {
    const documents = [
      { record_id: 'doc-open', title: 'Open', record_state: 'active' },
      { record_id: 'doc-deleted', title: 'Deleted', record_state: 'deleted' },
    ];
    const comments = [
      {
        record_id: 'comment-open',
        target_record_id: 'doc-open',
        target_record_family_hash: recordFamilyHash('document'),
        comment_status: 'open',
      },
      {
        record_id: 'comment-reply',
        target_record_id: 'doc-open',
        target_record_family_hash: recordFamilyHash('document'),
        parent_comment_id: 'comment-open',
        comment_status: 'open',
      },
      {
        record_id: 'comment-resolved',
        target_record_id: 'doc-open',
        target_record_family_hash: recordFamilyHash('document'),
        comment_status: 'resolved',
      },
      {
        record_id: 'comment-deleted-doc',
        target_record_id: 'doc-deleted',
        target_record_family_hash: recordFamilyHash('document'),
        comment_status: 'open',
      },
    ];

    expect(countUnresolvedDocumentComments({ documents, comments })).toBe(2);
  });

  it('orders tasks by newest task comment and aggregates comment rows', () => {
    const rows = buildAutopilotOverviewTasks({
      tasks: [
        { record_id: 'task-a', title: 'Older task', updated_at: '2026-06-15T10:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
        { record_id: 'task-b', title: 'Commented task', updated_at: '2026-06-15T09:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
      ],
      comments: [
        {
          record_id: 'comment-b-1',
          target_record_id: 'task-b',
          target_record_family_hash: recordFamilyHash('task'),
          updated_at: '2026-06-15T11:00:00.000Z',
        },
        {
          record_id: 'comment-b-2',
          target_record_id: 'task-b',
          target_record_family_hash: recordFamilyHash('task'),
          updated_at: '2026-06-15T10:30:00.000Z',
        },
      ],
      unreadTaskMap: { 'task-b': true },
    });

    expect(rows.map((row) => row.recordId)).toEqual(['task-b', 'task-a']);
    expect(rows[0]).toMatchObject({
      reason: '2 recent comments',
      count: 2,
      activityAt: '2026-06-15T11:00:00.000Z',
      isUnread: true,
    });
  });

  it('aggregates unresolved document comments and ignores resolved comments for ordering', () => {
    const rows = buildAutopilotOverviewDocuments({
      documents: [
        { record_id: 'doc-a', title: 'Doc A', updated_at: '2026-06-15T10:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
        { record_id: 'doc-b', title: 'Doc B', updated_at: '2026-06-15T09:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
      ],
      comments: [
        {
          record_id: 'comment-open',
          target_record_id: 'doc-b',
          target_record_family_hash: recordFamilyHash('document'),
          comment_status: 'open',
          updated_at: '2026-06-15T11:00:00.000Z',
        },
        {
          record_id: 'comment-resolved',
          target_record_id: 'doc-a',
          target_record_family_hash: recordFamilyHash('document'),
          comment_status: 'resolved',
          updated_at: '2026-06-15T12:00:00.000Z',
        },
      ],
      unreadDocumentMap: { 'doc-b': true },
    });

    expect(rows.map((row) => row.recordId)).toEqual(['doc-b', 'doc-a']);
    expect(rows[0]).toMatchObject({
      reason: '1 unresolved comment',
      count: 1,
      activityAt: '2026-06-15T11:00:00.000Z',
      isUnread: true,
    });
  });

  it('keeps file-backed document records out of the overview document rows', () => {
    const rows = buildAutopilotOverviewDocuments({
      documents: [
        { record_id: 'doc-a', title: 'Real doc', updated_at: '2026-06-15T10:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
        {
          record_id: 'file-a',
          title: 'Uploaded file.pdf',
          updated_at: '2026-06-15T11:00:00.000Z',
          scope_id: 'scope-a',
          pg_channel_id: 'chan-a',
          pg_record_type: 'file',
          pg_storage_object_id: 'storage-file-a',
        },
      ],
    });

    expect(rows.map((row) => row.recordId)).toEqual(['doc-a']);
  });

  it('excludes ambiguous records from scope and channel filtered task rows', () => {
    const rows = buildAutopilotOverviewTasks({
      tasks: [
        { record_id: 'task-a', title: 'Scoped', updated_at: '2026-06-15T10:00:00.000Z', scope_id: 'scope-a', pg_channel_id: 'chan-a' },
        { record_id: 'task-missing-channel', title: 'Ambiguous', updated_at: '2026-06-15T11:00:00.000Z', scope_id: 'scope-a' },
      ],
      selectedScopeId: 'scope-a',
      selectedChannelId: 'chan-a',
    });

    expect(rows.map((row) => row.recordId)).toEqual(['task-a']);
    expect(rows.diagnostics).toEqual(['1 task record is hidden because scope/channel is missing.']);
  });

  it('orders files by newest update then name and filters scope plus channel', () => {
    const rows = buildAutopilotOverviewFiles([
      { object_id: 'b', name: 'Beta', updated_at: '2026-06-15T10:00:00.000Z' },
      { object_id: 'a', name: 'Alpha', updated_at: '2026-06-15T10:00:00.000Z' },
      { object_id: 'c', name: 'Gamma', updated_at: '2026-06-15T11:00:00.000Z' },
    ]);

    expect(rows.map((row) => row.object_id)).toEqual(['c', 'a', 'b']);

    const scopedRows = buildAutopilotOverviewFiles([
      { object_id: 'kept', name: 'Kept', updated_at: '2026-06-15T10:00:00.000Z', scope_id: 'scope-a', channel_id: 'chan-a' },
      { object_id: 'hidden', name: 'Hidden', updated_at: '2026-06-15T11:00:00.000Z', scope_id: 'scope-a' },
    ], {
      selectedScopeId: 'scope-a',
      selectedChannelId: 'chan-a',
    });

    expect(scopedRows.map((row) => row.object_id)).toEqual(['kept']);
    expect(scopedRows.diagnostics).toEqual(['1 file record is hidden because scope/channel is missing.']);
  });

  it('orders files by created or uploaded fallback timestamps when updated time is absent', () => {
    const rows = buildAutopilotOverviewFiles([
      { object_id: 'older-upload', name: 'Older upload', uploaded_at: '2026-06-15T08:00:00.000Z' },
      { object_id: 'newer-created', name: 'Newer created', created_at: '2026-06-15T11:00:00.000Z' },
      { object_id: 'middle-upload', name: 'Middle upload', uploaded_at: '2026-06-15T10:00:00.000Z' },
    ]);

    expect(rows.map((row) => row.object_id)).toEqual(['newer-created', 'middle-upload', 'older-upload']);
    expect(rows.map((row) => row.activityAt)).toEqual([
      '2026-06-15T11:00:00.000Z',
      '2026-06-15T10:00:00.000Z',
      '2026-06-15T08:00:00.000Z',
    ]);
  });

  it('keeps document body storage rows out of overview files', () => {
    const rows = buildAutopilotOverviewFiles([
      { object_id: 'doc-body', name: 'Scratch pad', source_type: 'document', kind: 'document', updated_at: '2026-06-15T10:00:00.000Z' },
      { object_id: 'attachment', name: 'Upload.pdf', source_type: 'document', kind: 'file', updated_at: '2026-06-15T11:00:00.000Z' },
    ]);

    expect(rows.map((row) => row.object_id)).toEqual(['attachment']);
  });

  it('does not expose the removed standalone Autopilot page', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    [
      'data-testid="flightdeck-summary-overview"',
      'data-testid="flightdeck-summary-daily-scope"',
      'data-testid="flightdeck-summary-threads"',
      'data-testid="flightdeck-summary-tasks"',
      'data-testid="flightdeck-summary-documents"',
      'data-testid="flightdeck-summary-files"',
      'aria-label="Open selected chat"',
    ].forEach((expected) => {
      expect(html).toContain(expected);
    });

    [
      'data-testid="autopilot-overview-page"',
      'data-testid="autopilot-overview-daily-scope"',
      'data-testid="autopilot-overview-recent-threads"',
      'data-testid="autopilot-overview-recent-tasks"',
      'data-testid="autopilot-overview-documents"',
      'data-testid="autopilot-overview-files"',
      'data-testid="autopilot-overview-threads-list"',
      'data-testid="autopilot-overview-tasks-list"',
      'data-testid="autopilot-overview-documents-list"',
      'data-testid="autopilot-overview-files-list"',
      "navSection === 'autopilot'",
      "navigateTo('autopilot')",
      '<span class="sidebar-label">Autopilot</span>',
      'data-testid="autopilot-overview-scope-select"',
      'data-testid="autopilot-overview-channel-select"',
      'aria-label="Filter Autopilot Overview by scope"',
      'aria-label="Filter Autopilot Overview by chat channel"',
    ].forEach((removed) => {
      expect(html).not.toContain(removed);
    });
  });
});


describe('independent Inbox types', () => {
  const types = ['chat', 'task', 'document', 'file'];
  const rows = types.map(inboxKind => ({ inboxKind, title: 'needle', name: 'needle', isUnread: true }));
  it('filters all 16 combinations and intersects search without mutating cards', () => {
    for (let mask = 0; mask < 16; mask++) {
      const shown = types.filter((_, i) => mask & (1 << i));
      expect(filterAutopilotOverviewInbox(rows, '', shown).map(row => row.inboxKind)).toEqual(shown);
      expect(filterAutopilotOverviewInbox(rows, 'NEEDLE', shown).map(row => row.inboxKind)).toEqual(shown);
      expect(filterAutopilotOverviewInbox(rows, 'missing', shown)).toEqual([]);
    }
    expect(rows.every(row => row.isUnread)).toBe(true);
  });
  it('defaults to all and toggles independently through all off, preserving active search', () => {
    const store = { ...autopilotOverviewManagerMixin, deckInboxSearchQuery: 'needle', startWorkspaceLiveQueries: vi.fn() };
    expect(types.every(type => store.isDeckInboxTypeVisible(type))).toBe(true);
    for (const type of types) store.toggleDeckInboxType(type);
    expect(store.deckInboxType).toEqual([]);
    expect(store.deckInboxSearchQuery).toBe('needle');
    expect(store.deckInboxVisibleCount).toBe(50);
    store.toggleDeckInboxType('file');
    expect(store.deckInboxType).toEqual(['file']);
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalledTimes(5);
  });
  it('preserves a legacy in-memory single selection on the first toggle', () => {
    const store = { ...autopilotOverviewManagerMixin, deckInboxType: 'task' };
    store.toggleDeckInboxType('file');
    expect(store.deckInboxType).toEqual(['task', 'file']);
    store.toggleDeckInboxType('task');
    expect(store.deckInboxType).toEqual(['file']);
  });
});
