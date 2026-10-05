import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveGroupId,
  getScopeAncestorPath,
  formatTaskBoardScopeDisplay,
  formatFocusedScopeMeta,
  getTaskBoardOptionLabel,
  getTaskBoardSearchText,
  normalizeTaskRowGroupRefs,
  normalizeTaskRowScopeRefs,
  normalizeScheduleRowGroupRefs,
  normalizeScopeRowGroupRefs,
  dedupeTasksByRecordId,
  computeParentDisplayState,
  computeBoardColumns,
  resolveTaskBoardColumnColor,
  sortTasksByBoardOrder,
  sortTasksForBoard,
  calculateTaskBoardOrderForInsertion,
  getTaskDropRecordId,
  buildTaskBoardReorderPatches,
  computeBoardScopedTasks,
  computeFilteredTasks,
  buildRecentFocusAreas,
  computeTaskTagStats,
  sortTagsByPopularity,
  selectPreferredWritableGroupRef,
  prioritizeUnreadChannels,
  taskBoardStateMixin,
  TASK_BOARD_SORT_MODES,
  UNSCOPED_TASK_BOARD_ID,
  ALL_TASK_BOARD_ID,
  RECENT_TASK_BOARD_ID,
  TASK_BOARD_STORAGE_KEY,
  TASK_BOARD_STORAGE_KEY_SUFFIX,
  WEEKDAY_OPTIONS,
} from '../src/task-board-state.js';
import {
  cacheGroupKey,
  clearGroupKeyCache,
  createGroupIdentity,
} from '../src/crypto/group-keys.js';
import {
  buildPgChannelTaskBoardId,
  buildPgThreadTaskBoardId,
} from '../src/pg-record-context.js';
import { DM_SCOPE_ID } from '../src/dm-scope.js';

afterEach(() => {
  clearGroupKeyCache();
});

// --- test fixtures ---
const groups = [
  { group_id: 'g1', group_npub: 'npub1grp1', name: 'Team A' },
  { group_id: 'g2', group_npub: 'npub1grp2', name: 'Team B' },
];

const product = {
  record_id: 'scope-product',
  title: 'Product X',
  level: 'product',
  parent_id: null,
  record_state: 'active',
};

const project = {
  record_id: 'scope-project',
  title: 'Project Y',
  level: 'project',
  parent_id: 'scope-product',
  l1_id: 'scope-product',
  record_state: 'active',
};

const deliverable = {
  record_id: 'scope-deliverable',
  title: 'Deliverable Z',
  level: 'deliverable',
  parent_id: 'scope-project',
  l1_id: 'scope-product',
  l2_id: 'scope-project',
  record_state: 'active',
};

function buildScopesMap(scopes = [product, project, deliverable]) {
  const m = new Map();
  for (const s of scopes) m.set(s.record_id, s);
  return m;
}

// --- constants ---
describe('task-board-state constants', () => {
  it('exports UNSCOPED_TASK_BOARD_ID', () => {
    expect(UNSCOPED_TASK_BOARD_ID).toBe('__unscoped__');
  });

  it('exports TASK_BOARD_STORAGE_KEY (legacy)', () => {
    expect(TASK_BOARD_STORAGE_KEY).toBe('coworker:last-task-board-id');
  });

  it('exports TASK_BOARD_STORAGE_KEY_SUFFIX for namespaced keys', () => {
    expect(TASK_BOARD_STORAGE_KEY_SUFFIX).toBe('last-task-board-id');
  });

  it('exports WEEKDAY_OPTIONS', () => {
    expect(WEEKDAY_OPTIONS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('exports supported task board sort modes', () => {
    expect(TASK_BOARD_SORT_MODES).toEqual([
      'manual',
      'created_asc',
      'created_desc',
      'modified_desc',
      'modified_asc',
      'alpha_asc',
      'alpha_desc',
    ]);
  });
});

// --- resolveGroupId ---
describe('resolveGroupId', () => {
  it('returns null for empty input', () => {
    expect(resolveGroupId(null, groups)).toBeNull();
    expect(resolveGroupId('', groups)).toBeNull();
    expect(resolveGroupId(undefined, groups)).toBeNull();
  });

  it('resolves by group_id', () => {
    expect(resolveGroupId('g1', groups)).toBe('g1');
  });

  it('resolves by group_npub', () => {
    expect(resolveGroupId('npub1grp1', groups)).toBe('g1');
  });

  it('returns the value as-is when no match found', () => {
    expect(resolveGroupId('unknown', groups)).toBe('unknown');
  });

  it('handles empty groups array', () => {
    expect(resolveGroupId('g1', [])).toBe('g1');
  });
});

describe('getPreferredChannelWriteGroup', () => {
  it('resolves historical channel group_npub refs to durable group_id refs', () => {
    const store = {
      groups,
      resolveGroupId(ref) {
        return resolveGroupId(ref, this.groups);
      },
    };

    expect(taskBoardStateMixin.getPreferredChannelWriteGroup.call(store, {
      group_ids: ['npub1grp1'],
    })).toBe('g1');
  });

  it('keeps unresolved historical channel refs as compatibility fallback', () => {
    const store = {
      groups: [],
      resolveGroupId(ref) {
        return resolveGroupId(ref, this.groups);
      },
    };

    expect(taskBoardStateMixin.getPreferredChannelWriteGroup.call(store, {
      group_ids: ['npub1legacy'],
    })).toBe('npub1legacy');
  });

  it('selects the loaded actor group instead of the first delivery group', () => {
    const identity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'g2',
      group_npub: 'npub1grp2',
      nsec: identity.nsec,
    });
    const store = {
      groups,
      resolveGroupId(ref) {
        return resolveGroupId(ref, this.groups);
      },
    };

    expect(taskBoardStateMixin.getPreferredChannelWriteGroup.call(store, {
      group_ids: ['g1', 'g2'],
    })).toBe('g2');
  });

  it('never selects hidden non-member groups as the write group', () => {
    const hiddenIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'g-hidden',
      group_npub: 'npub1hidden',
      nsec: hiddenIdentity.nsec,
    });
    const visibleIdentity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'g2',
      group_npub: 'npub1grp2',
      nsec: visibleIdentity.nsec,
    });
    const store = {
      session: { npub: 'npub1member' },
      workspaceOwnerNpub: 'npub1owner',
      groups,
      currentWorkspaceContentGroups: [
        { group_id: 'g1', group_npub: 'npub1grp1', member_npubs: ['npub1member'] },
        { group_id: 'g2', group_npub: 'npub1grp2', member_npubs: ['npub1member'] },
      ],
      resolveGroupId(ref) {
        return resolveGroupId(ref, this.groups);
      },
      getActorWritableGroupRefs: taskBoardStateMixin.getActorWritableGroupRefs,
    };

    expect(taskBoardStateMixin.getPreferredChannelWriteGroup.call(store, {
      group_ids: ['g-hidden', 'g1', 'g2'],
    })).toBe('g2');
  });
});

describe('Deck context entry', () => {
  it('uses one work-context controller that opens Deck before follow-up work', async () => {
    const inputEvent = { timeStamp: 42 };
    const selectBoard = vi.fn();
    const store = {
      navSection: 'status',
      pgContextScopeId: 'scope-project',
      selectBoard,
      selectWorkContextScope: taskBoardStateMixin.selectWorkContextScope,
      selectWorkContextBoard: taskBoardStateMixin.selectWorkContextBoard,
    };

    taskBoardStateMixin.selectWorkContextChannel.call(store, 'channel-1', inputEvent);
    expect(selectBoard).toHaveBeenLastCalledWith(buildPgChannelTaskBoardId('channel-1'));
    expect(store.navSection).toBe('status');

    taskBoardStateMixin.selectWorkContextScope.call(store, 'scope-ops', inputEvent);
    expect(selectBoard).toHaveBeenLastCalledWith('scope-ops');
    expect(store.navSection).toBe('status');

    taskBoardStateMixin.openWorkContextHome.call(store, inputEvent);
    expect(selectBoard).toHaveBeenLastCalledWith('scope-project');
    expect(store.navSection).toBe('status');

    store.navSection = 'chat';
    await taskBoardStateMixin.selectWorkContextChannel.call(store, 'channel-2', inputEvent);
    expect(selectBoard).toHaveBeenLastCalledWith(buildPgChannelTaskBoardId('channel-2'));
    expect(store.navSection).toBe('status');
  });

  it('switches from Chat to Deck before selecting a different scope', () => {
    const calls = [];
    const store = {
      navSection: 'chat',
      navigateTo(section, options) {
        calls.push(['navigateTo', section, options]);
        this.navSection = section;
      },
      selectBoard(boardId) {
        calls.push(['selectBoard', boardId, this.navSection]);
      },
    };

    taskBoardStateMixin.selectDeckScope.call(store, 'scope-ops');

    expect(calls).toEqual([
      ['navigateTo', 'status', { syncRoute: false }],
      ['selectBoard', 'scope-ops', 'status'],
    ]);
  });

  it('switches from Chat to Deck before selecting the channel tab context', async () => {
    const calls = [];
    const store = {
      navSection: 'chat',
      selectedBoardId: 'scope-project',
      selectedChannelId: 'channel-old',
      activeThreadId: 'thread-old',
      closeThread(options) {
        calls.push(['closeThread', options]);
        this.activeThreadId = null;
      },
      navigateTo(section, options) {
        calls.push(['navigateTo', section, options]);
        this.navSection = section;
      },
      selectBoard(boardId) {
        calls.push(['selectBoard', boardId, this.navSection]);
        this.selectedBoardId = boardId;
      },
      selectPgChannelContext: taskBoardStateMixin.selectPgChannelContext,
    };

    await taskBoardStateMixin.selectDeckChannel.call(store, 'channel-1');

    expect(calls).toEqual([
      ['closeThread', { syncRoute: false }],
      ['navigateTo', 'status', { syncRoute: false }],
      ['selectBoard', buildPgChannelTaskBoardId('channel-1'), 'status'],
    ]);
    expect(store.navSection).toBe('status');
    expect(store.activeThreadId).toBeNull();
    expect(store.selectedChannelId).toBe('channel-1');
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('channel-1'));
  });

  it('keeps repeated thread to channel Deck cycles free of stale thread state', async () => {
    const store = {
      navSection: 'chat',
      selectedBoardId: 'scope-project',
      selectedChannelId: 'channel-old',
      activeThreadId: 'thread-1',
      closeThread: vi.fn(function closeThread() { this.activeThreadId = null; }),
      navigateTo: vi.fn(function navigateTo(section) { this.navSection = section; }),
      selectBoard: vi.fn(function selectBoard(boardId) { this.selectedBoardId = boardId; }),
      selectPgChannelContext: taskBoardStateMixin.selectPgChannelContext,
    };

    for (const [threadId, channelId] of [['thread-1', 'channel-1'], ['thread-2', 'channel-2']]) {
      store.navSection = 'chat';
      store.activeThreadId = threadId;
      await taskBoardStateMixin.selectDeckChannel.call(store, channelId);
      expect(store.navSection).toBe('status');
      expect(store.activeThreadId).toBeNull();
      expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId(channelId));
    }

    expect(store.closeThread).toHaveBeenCalledTimes(2);
    expect(store.closeThread).toHaveBeenNthCalledWith(1, { syncRoute: false });
    expect(store.closeThread).toHaveBeenNthCalledWith(2, { syncRoute: false });
  });

  it.each([
    ['desktop', false],
    ['mobile', true],
  ])('fully closes a task modal before its channel link returns to the %s Deck', async (_viewport, mobile) => {
    const calls = [];
    const store = {
      navSection: 'chat',
      selectedBoardId: 'pg:thread:channel-1:thread-1',
      selectedChannelId: 'channel-1',
      activeThreadId: 'thread-1',
      deckThreadChannelId: 'channel-1',
      chatTaskModalOpen: true,
      showTaskDetail: true,
      activeTaskId: 'task-1',
      editingTask: { record_id: 'task-1', pg_channel_id: 'channel-1' },
      deckMobileColumn: 'hello-links',
      deckMobileCards: [
        { id: 'hello-links', label: 'Hello and Links' },
        { id: 'inbox', label: 'Inbox' },
        { id: 'wapp-updates', label: 'WApps' },
        { id: 'recent', label: 'Recent' },
      ],
      closeChatTaskModal: vi.fn(async function closeChatTaskModal() {
        calls.push('close-task-modal');
        this.chatTaskModalOpen = false;
        this.showTaskDetail = false;
        this.activeTaskId = null;
        this.editingTask = null;
      }),
      closeDeckThread: vi.fn(function closeDeckThread(options) {
        calls.push(['close-deck-thread', options]);
        this.activeThreadId = null;
        this.deckThreadChannelId = '';
      }),
      navigateTo: vi.fn(function navigateTo(section, options) {
        calls.push(['navigate', section, options]);
        this.navSection = section;
        if (mobile && section === 'status') this.deckMobileColumn = 'inbox';
      }),
      selectBoard: vi.fn(function selectBoard(boardId) {
        calls.push(['select-board', boardId]);
        this.selectedBoardId = boardId;
      }),
      selectPgChannelContext: taskBoardStateMixin.selectPgChannelContext,
      selectDeckMobileCard: vi.fn(function selectDeckMobileCard(cardId) {
        if (!this.deckMobileCards.some((card) => card.id === cardId)) return false;
        this.deckMobileColumn = cardId;
        return true;
      }),
    };

    for (let cycle = 0; cycle < 2; cycle += 1) {
      store.navSection = 'chat';
      store.activeThreadId = `thread-${cycle + 1}`;
      store.deckThreadChannelId = 'channel-1';
      store.chatTaskModalOpen = true;
      store.showTaskDetail = true;
      store.activeTaskId = `task-${cycle + 1}`;
      store.editingTask = { record_id: store.activeTaskId, pg_channel_id: 'channel-1' };

      await taskBoardStateMixin.selectDeckChannel.call(store, 'channel-1');

      expect(store.navSection).toBe('status');
      expect(store.chatTaskModalOpen).toBe(false);
      expect(store.showTaskDetail).toBe(false);
      expect(store.activeTaskId).toBeNull();
      expect(store.editingTask).toBeNull();
      expect(store.activeThreadId).toBeNull();
      expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('channel-1'));
      expect(store.deckMobileCards.map((card) => card.id)).toContain('hello-links');
      expect(store.selectDeckMobileCard('hello-links')).toBe(true);
      expect(store.deckMobileColumn).toBe('hello-links');
    }

    expect(store.closeChatTaskModal).toHaveBeenCalledTimes(2);
    expect(store.closeDeckThread).toHaveBeenCalledTimes(2);
    expect(calls.slice(0, 4)).toEqual([
      'close-task-modal',
      ['close-deck-thread', { syncRoute: false, fromRoute: true }],
      ['navigate', 'status', { syncRoute: false }],
      ['select-board', buildPgChannelTaskBoardId('channel-1')],
    ]);
  });

  it('closes full-page task detail before selecting its channel Deck', async () => {
    const store = {
      navSection: 'tasks',
      selectedBoardId: 'scope-project',
      selectedChannelId: 'channel-old',
      activeThreadId: null,
      chatTaskModalOpen: false,
      showTaskDetail: true,
      activeTaskId: 'task-1',
      editingTask: { record_id: 'task-1', pg_channel_id: 'channel-1' },
      closeTaskDetail: vi.fn(async function closeTaskDetail() {
        this.showTaskDetail = false;
        this.activeTaskId = null;
        this.editingTask = null;
      }),
      navigateTo: vi.fn(function navigateTo(section) { this.navSection = section; }),
      selectBoard: vi.fn(function selectBoard(boardId) { this.selectedBoardId = boardId; }),
      selectPgChannelContext: taskBoardStateMixin.selectPgChannelContext,
    };

    await taskBoardStateMixin.selectDeckChannel.call(store, 'channel-1');

    expect(store.closeTaskDetail).toHaveBeenCalledWith({ syncRoute: false });
    expect(store.navSection).toBe('status');
    expect(store.showTaskDetail).toBe(false);
    expect(store.activeTaskId).toBeNull();
    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('channel-1'));
  });

  it('keeps the explicit primitive context helpers route-neutral', () => {
    const store = {
      selectedBoardId: 'scope-project',
      selectedChannelId: null,
      activeThreadId: null,
      focusMessageId: null,
      currentWorkspace: { pgBackendMode: true },
      pgContextScopeId: 'scope-project',
      navigateTo: vi.fn(),
      selectBoard: vi.fn(),
    };

    taskBoardStateMixin.selectPgChannelContext.call(store, 'channel-1');
    taskBoardStateMixin.openPgScopeHome.call(store);

    expect(store.navigateTo).not.toHaveBeenCalled();
    expect(store.selectBoard).toHaveBeenNthCalledWith(1, buildPgChannelTaskBoardId('channel-1'));
    expect(store.selectBoard).toHaveBeenNthCalledWith(2, 'scope-project');
  });
});

describe('getActorWritableGroupRefs', () => {
  it('prioritizes shared groups before viewer-private group for delegated users', () => {
    const store = {
      session: { npub: 'npub1viewer' },
      workspaceOwnerNpub: 'npub1workspace_service',
      groups: [],
      currentWorkspaceContentGroups: [
        {
          group_id: 'group-private-viewer',
          private_member_npub: 'npub1viewer',
          member_npubs: ['npub1viewer'],
        },
        {
          group_id: 'group-shared-a',
          member_npubs: ['npub1viewer', 'npub1other'],
        },
        {
          group_id: 'group-shared-b',
          member_npubs: ['npub1viewer'],
        },
      ],
      resolveGroupId(ref) {
        return String(ref || '').trim() || null;
      },
    };

    expect(taskBoardStateMixin.getActorWritableGroupRefs.call(store)).toEqual([
      'group-shared-a',
      'group-shared-b',
      'group-private-viewer',
    ]);
  });
});

describe('selectPreferredWritableGroupRef', () => {
  it('keeps full delivery separate from loaded write authority selection', () => {
    const identity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'g3',
      group_npub: 'npub1grp3',
      nsec: identity.nsec,
    });

    expect(selectPreferredWritableGroupRef({
      boardGroupId: 'g1',
      groupIds: ['g1', 'g2', 'g3'],
      scopePolicyGroupIds: ['g1', 'g2', 'g3'],
      shares: [
        { type: 'group', group_id: 'g1', access: 'write' },
        { type: 'group', group_id: 'g2', access: 'write' },
        { type: 'group', group_id: 'g3', access: 'write' },
      ],
    })).toBe('g3');
  });

  it('returns null when allowed writable groups do not overlap delivery groups', () => {
    expect(selectPreferredWritableGroupRef({
      groupIds: ['g-hidden'],
      allowedGroupIds: ['g1', 'g2'],
    })).toBeNull();
  });

  it('does not select explicit writeGroupId when it is non-writable and writable candidates exist', () => {
    const result = selectPreferredWritableGroupRef({
      writeGroupId: 'g-private',
      groupIds: ['g-private', 'g-shared'],
      scopePolicyGroupIds: ['g-private', 'g-shared'],
      shares: [
        { type: 'group', group_id: 'g-private', access: 'read' },
        { type: 'group', group_id: 'g-shared', access: 'write' },
      ],
      hasKey: () => true,
    });

    expect(result).toBe('g-shared');
  });

  it('does not select boardGroupId when it is non-writable and writable candidates exist', () => {
    const result = selectPreferredWritableGroupRef({
      boardGroupId: 'g-private',
      groupIds: ['g-private', 'g-shared'],
      scopePolicyGroupIds: ['g-private', 'g-shared'],
      shares: [
        { type: 'group', group_id: 'g-private', access: 'read' },
        { type: 'group', group_id: 'g-shared', access: 'write' },
      ],
      hasKey: () => true,
    });

    expect(result).toBe('g-shared');
  });
});

describe('computeParentDisplayState', () => {
  it('preserves the explicit state for active flow parent tasks', () => {
    const parent = {
      record_id: 'task-parent',
      state: 'in_progress',
      flow_run_id: 'run-1',
      parent_task_id: null,
      tags: 'flow_parent',
      record_state: 'active',
    };
    const subtasks = [
      { record_id: 'task-child-1', parent_task_id: 'task-parent', state: 'new', flow_run_id: 'run-1', record_state: 'active' },
      { record_id: 'task-child-2', parent_task_id: 'task-parent', state: 'new', flow_run_id: 'run-1', record_state: 'active' },
    ];

    expect(computeParentDisplayState(parent, subtasks)).toBe('in_progress');
  });

  it('derives state from subtasks for non-flow parents', () => {
    const parent = {
      record_id: 'task-parent',
      state: 'in_progress',
      flow_run_id: null,
      parent_task_id: null,
      tags: '',
      record_state: 'active',
    };
    const subtasks = [
      { record_id: 'task-child-1', parent_task_id: 'task-parent', state: 'done', flow_run_id: null, record_state: 'active' },
      { record_id: 'task-child-2', parent_task_id: 'task-parent', state: 'new', flow_run_id: null, record_state: 'active' },
    ];

    expect(computeParentDisplayState(parent, subtasks)).toBe('new');
  });
});

// --- getScopeAncestorPath ---
describe('getScopeAncestorPath', () => {
  const scopesMap = buildScopesMap();

  it('returns empty string for a root scope', () => {
    expect(getScopeAncestorPath('scope-product', scopesMap)).toBe('');
  });

  it('returns parent title for one level deep', () => {
    expect(getScopeAncestorPath('scope-project', scopesMap)).toBe('Product X >');
  });

  it('returns full ancestor chain for deeply nested scope', () => {
    expect(getScopeAncestorPath('scope-deliverable', scopesMap)).toBe('Product X > Project Y >');
  });

  it('returns empty string for unknown scope', () => {
    expect(getScopeAncestorPath('nonexistent', scopesMap)).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(getScopeAncestorPath(null, scopesMap)).toBe('');
    expect(getScopeAncestorPath(undefined, scopesMap)).toBe('');
  });
});

// --- formatTaskBoardScopeDisplay ---
describe('formatTaskBoardScopeDisplay', () => {
  const scopesMap = buildScopesMap();

  it('returns empty string for null scope', () => {
    expect(formatTaskBoardScopeDisplay(null, scopesMap)).toBe('');
  });

  it('returns empty string for scope without record_id', () => {
    expect(formatTaskBoardScopeDisplay({}, scopesMap)).toBe('');
  });

  it('formats root-level product', () => {
    expect(formatTaskBoardScopeDisplay(product, scopesMap)).toBe('Product X');
  });

  it('formats nested project with ancestor path', () => {
    expect(formatTaskBoardScopeDisplay(project, scopesMap)).toBe('Project Y (L2): Product X >');
  });

  it('formats deeply nested deliverable with ancestor path', () => {
    expect(formatTaskBoardScopeDisplay(deliverable, scopesMap)).toBe(
      'Deliverable Z (L3): Product X > Project Y >'
    );
  });

  it('handles scope with empty title', () => {
    const scope = { ...product, title: '' };
    expect(formatTaskBoardScopeDisplay(scope, scopesMap)).toBe('Untitled scope');
  });
});

describe('formatFocusedScopeMeta', () => {
  const scopesMap = buildScopesMap();

  it('returns empty string for null scope', () => {
    expect(formatFocusedScopeMeta(null, scopesMap)).toBe('');
  });

  it('returns level only for a root scope', () => {
    expect(formatFocusedScopeMeta(product, scopesMap)).toBe('L1');
  });

  it('returns level and trimmed ancestor path for nested scope', () => {
    expect(formatFocusedScopeMeta(deliverable, scopesMap)).toBe('L3 · Product X > Project Y');
  });
});

// --- getTaskBoardOptionLabel ---
describe('getTaskBoardOptionLabel', () => {
  const scopesMap = buildScopesMap();

  it('returns Unscoped for UNSCOPED_TASK_BOARD_ID', () => {
    expect(getTaskBoardOptionLabel(UNSCOPED_TASK_BOARD_ID, scopesMap)).toBe('Unscoped');
  });

  it('returns Scope board for unknown scope', () => {
    expect(getTaskBoardOptionLabel('nonexistent', scopesMap)).toBe('Scope board');
  });

  it('returns formatted display for known scope', () => {
    expect(getTaskBoardOptionLabel('scope-product', scopesMap)).toBe('Product X');
  });
});

// --- getTaskBoardSearchText ---
describe('getTaskBoardSearchText', () => {
  const scopesMap = buildScopesMap();

  it('returns unscoped search text for UNSCOPED_TASK_BOARD_ID', () => {
    const result = getTaskBoardSearchText(UNSCOPED_TASK_BOARD_ID, scopesMap);
    expect(result).toContain('unscoped');
  });

  it('returns empty string for unknown scope', () => {
    expect(getTaskBoardSearchText('nonexistent', scopesMap)).toBe('');
  });

  it('includes scope title and level for known scope', () => {
    const result = getTaskBoardSearchText('scope-product', scopesMap);
    expect(result).toContain('product x');
    expect(result).toContain('product');
  });
});

// --- normalizeTaskRowGroupRefs ---
describe('normalizeTaskRowGroupRefs', () => {
  const resolver = (ref) => resolveGroupId(ref, groups);

  it('returns falsy input as-is', () => {
    expect(normalizeTaskRowGroupRefs(null, resolver)).toBeNull();
    expect(normalizeTaskRowGroupRefs(undefined, resolver)).toBeUndefined();
  });

  it('returns non-object input as-is', () => {
    expect(normalizeTaskRowGroupRefs('string', resolver)).toBe('string');
  });

  it('returns task unchanged when no group refs to resolve', () => {
    const task = { board_group_id: 'g1', group_ids: ['g1'], shares: [] };
    expect(normalizeTaskRowGroupRefs(task, resolver)).toBe(task);
  });

  it('resolves group_npub to group_id in board_group_id', () => {
    const task = { board_group_id: 'npub1grp1', group_ids: [], shares: [] };
    const result = normalizeTaskRowGroupRefs(task, resolver);
    expect(result.board_group_id).toBe('g1');
  });

  it('resolves group_npub in group_ids', () => {
    const task = { board_group_id: null, group_ids: ['npub1grp2'], shares: [] };
    const result = normalizeTaskRowGroupRefs(task, resolver);
    expect(result.group_ids).toEqual(['g2']);
  });

  it('deduplicates group_ids', () => {
    const task = { board_group_id: null, group_ids: ['g1', 'npub1grp1'], shares: [] };
    const result = normalizeTaskRowGroupRefs(task, resolver);
    expect(result.group_ids).toEqual(['g1']);
  });

  it('resolves group_npub and via_group_npub in shares', () => {
    const task = {
      board_group_id: null,
      group_ids: [],
      shares: [{ group_npub: 'npub1grp1', via_group_npub: 'npub1grp2' }],
    };
    const result = normalizeTaskRowGroupRefs(task, resolver);
    expect(result.shares[0].group_npub).toBe('g1');
    expect(result.shares[0].via_group_npub).toBe('g2');
  });
});

// --- normalizeTaskRowScopeRefs ---
describe('normalizeTaskRowScopeRefs', () => {
  const scopesMap = buildScopesMap();

  it('returns falsy input as-is', () => {
    expect(normalizeTaskRowScopeRefs(null, scopesMap)).toBeNull();
  });

  it('returns task unchanged when scope_id missing', () => {
    const task = { title: 'Test' };
    expect(normalizeTaskRowScopeRefs(task, scopesMap)).toBe(task);
  });

  it('returns task unchanged when scope_id not in map', () => {
    const task = { scope_id: 'unknown' };
    expect(normalizeTaskRowScopeRefs(task, scopesMap)).toBe(task);
  });

  it('fills in scope hierarchy fields for known scope', () => {
    const task = { scope_id: 'scope-deliverable', scope_l1_id: null, scope_l2_id: null, scope_l3_id: null };
    const result = normalizeTaskRowScopeRefs(task, scopesMap);
    expect(result.scope_l3_id).toBe('scope-deliverable');
    expect(result.scope_l2_id).toBe('scope-project');
    expect(result.scope_l1_id).toBe('scope-product');
  });
});

// --- normalizeScheduleRowGroupRefs ---
describe('normalizeScheduleRowGroupRefs', () => {
  const resolver = (ref) => resolveGroupId(ref, groups);

  it('returns falsy input as-is', () => {
    expect(normalizeScheduleRowGroupRefs(null, resolver)).toBeNull();
  });

  it('returns schedule unchanged when no refs to resolve', () => {
    const schedule = { assigned_group_id: 'g1', group_ids: ['g1'], shares: [] };
    expect(normalizeScheduleRowGroupRefs(schedule, resolver)).toBe(schedule);
  });

  it('resolves assigned_group_id', () => {
    const schedule = { assigned_group_id: 'npub1grp1', group_ids: [], shares: [] };
    const result = normalizeScheduleRowGroupRefs(schedule, resolver);
    expect(result.assigned_group_id).toBe('g1');
  });
});

// --- normalizeScopeRowGroupRefs ---
describe('normalizeScopeRowGroupRefs', () => {
  const resolver = (ref) => resolveGroupId(ref, groups);

  it('returns falsy input as-is', () => {
    expect(normalizeScopeRowGroupRefs(null, resolver)).toBeNull();
  });

  it('returns scope unchanged when group_ids already resolved', () => {
    const scope = { group_ids: ['g1'] };
    expect(normalizeScopeRowGroupRefs(scope, resolver)).toBe(scope);
  });

  it('resolves group_npub in group_ids', () => {
    const scope = { group_ids: ['npub1grp2'] };
    const result = normalizeScopeRowGroupRefs(scope, resolver);
    expect(result.group_ids).toEqual(['g2']);
  });
});

// --- computeBoardScopedTasks ---
describe('computeBoardScopedTasks', () => {
  const scopesMap = buildScopesMap();
  const tasks = [
    { record_id: 't1', record_state: 'active', scope_id: 'scope-product' },
    { record_id: 't2', record_state: 'active', scope_id: null },
    { record_id: 't3', record_state: 'deleted', scope_id: null },
    { record_id: 't4', record_state: 'active', scope_id: 'scope-project', scope_l1_id: 'scope-product' },
  ];

  it('filters deleted tasks', () => {
    const result = computeBoardScopedTasks(tasks, null, null, scopesMap, false);
    expect(result.every((t) => t.record_state !== 'deleted')).toBe(true);
  });

  it('returns all active tasks when no board selected', () => {
    const result = computeBoardScopedTasks(tasks, null, null, scopesMap, false);
    expect(result.length).toBe(3);
  });

  it('returns only unscoped tasks for UNSCOPED_TASK_BOARD_ID', () => {
    const result = computeBoardScopedTasks(tasks, UNSCOPED_TASK_BOARD_ID, null, scopesMap, false);
    expect(result.every((t) => !t.scope_id || !scopesMap.has(t.scope_id))).toBe(true);
  });

  it('filters PG channel and thread boards by channel/thread ids', () => {
    const pgTasks = [
      { record_id: 't-channel', record_state: 'active', scope_id: 'scope-product', pg_channel_id: 'channel-1', pg_thread_id: null },
      { record_id: 't-thread', record_state: 'active', scope_id: 'scope-product', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1' },
      { record_id: 't-other-channel', record_state: 'active', scope_id: 'scope-product', pg_channel_id: 'channel-2', pg_thread_id: 'thread-1' },
      { record_id: 't-other-thread', record_state: 'active', scope_id: 'scope-product', pg_channel_id: 'channel-1', pg_thread_id: 'thread-2' },
    ];

    expect(computeBoardScopedTasks(
      pgTasks,
      buildPgChannelTaskBoardId('channel-1'),
      null,
      scopesMap,
      false,
    ).map((task) => task.record_id)).toEqual(['t-channel', 't-thread', 't-other-thread']);

    expect(computeBoardScopedTasks(
      pgTasks,
      buildPgThreadTaskBoardId('channel-1', 'thread-1'),
      null,
      scopesMap,
      false,
    ).map((task) => task.record_id)).toEqual(['t-thread']);
  });

  it('keeps Flight Deck scope options as scopes while deriving PG channel thread context', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: scopesMap,
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      selectedBoardId: buildPgThreadTaskBoardId('channel-1', 'thread-1'),
      selectedChannelId: null,
      scopes: [product],
      channels: [
        { record_id: 'channel-1', title: 'Launch', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [
        { record_id: 'task-1', record_state: 'active', pg_channel_id: 'channel-1', pg_thread_id: 'thread-1' },
      ],
      documents: [],
      messages: [
        { record_id: 'message-1', channel_id: 'channel-1', parent_message_id: null, pg_thread_id: 'thread-1', body: 'Thread root', updated_at: '2026-06-01T10:00:00.000Z' },
        { record_id: 'message-2', channel_id: 'channel-1', parent_message_id: 'message-1', pg_thread_id: 'thread-1', body: 'Latest reply', updated_at: '2026-06-01T11:00:00.000Z' },
      ],
      getChannelLabel(channel) {
        return channel.title;
      },
    });

    expect(store.flightDeckScopeOptions.map((board) => board.label)).toContain('Product X');
    expect(store.flightDeckScopeOptions.map((board) => board.label)).not.toContain('Launch');
    expect(store.focusScopeTitle).toBe('Product X');
    expect(store.pgContextThreads).toMatchObject([
      {
        id: 'thread-1',
        channelId: 'channel-1',
        rootMessageId: 'message-1',
        label: 'Thread root',
        replyCount: 1,
      },
    ]);
  });

  it('keeps scope home when selecting a PG scope board outside chat', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([
        ['scope-marketing', { record_id: 'scope-marketing', title: 'Marketing', level: 'product' }],
        ['scope-ops', { record_id: 'scope-ops', title: 'Ops', level: 'product' }],
      ]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'tasks',
      selectedBoardId: 'scope-marketing',
      selectedChannelId: 'channel-website',
      channels: [
        { record_id: 'channel-website', title: 'Website', scope_id: 'scope-marketing', record_state: 'active' },
        { record_id: 'channel-standup', title: 'Stand up', scope_id: 'scope-ops', record_state: 'active' },
      ],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      syncRoute() {},
    });

    store.collapsedSections = { new: false, done: true };
    store.selectBoard('scope-ops');

    expect(store.collapsedSections).toEqual({ new: true, done: true });
    expect(store.selectedBoardId).toBe('scope-ops');
    expect(store.selectedChannelId).toBeNull();
    expect(store.focusScopeTitle).toBe('Ops');
  });

  it('resets an open document to the docs list when selecting a docs scope board', async () => {
    const openDoc = { record_id: 'doc-1', scope_id: 'scope-marketing' };
    const resetOpenDocumentForContextChange = vi.fn();
    const store = Object.create(taskBoardStateMixin);
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: false },
      navSection: 'docs',
      docsEditorOpen: true,
      selectedDocument: openDoc,
      selectedBoardId: 'scope-marketing',
      selectedChannelId: null,
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      resetOpenDocumentForContextChange,
    });

    await store.selectBoard('scope-ops');

    expect(store.selectedBoardId).toBe('scope-ops');
    expect(resetOpenDocumentForContextChange).toHaveBeenCalledWith(openDoc, { syncRoute: false });
  });

  it('selects a channel context by jumping from All to the channel board', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([
        ['scope-product', product],
      ]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'status',
      selectedBoardId: ALL_TASK_BOARD_ID,
      selectedChannelId: null,
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
    });

    store.selectPgChannelContext('channel-home');

    expect(store.selectedBoardId).toBe(buildPgChannelTaskBoardId('channel-home'));
    expect(store.selectedChannelId).toBe('channel-home');
    expect(store.focusScopeTitle).toBe('Product X');
  });

  it('treats All scopes as the selected PG context instead of highlighting the chat channel', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([
        ['scope-product', product],
      ]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      selectedBoardId: ALL_TASK_BOARD_ID,
      selectedChannelId: 'channel-home',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      getChannelLabel(channel) {
        return channel.title;
      },
    });

    expect(store.pgContextAllScopesSelected).toBe(true);
    expect(store.pgContextSelectedChannelId).toBeNull();
  });

  it('orders PG context channels by scope number/name and channel number/name', () => {
    const scopeAlpha = { record_id: 'scope-alpha', title: 'Alpha', sort_order: 2, record_state: 'active' };
    const scopeBeta = { record_id: 'scope-beta', title: 'Beta', sort_order: 1, record_state: 'active' };
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([
        ['scope-alpha', scopeAlpha],
        ['scope-beta', scopeBeta],
      ]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      selectedBoardId: ALL_TASK_BOARD_ID,
      selectedChannelId: null,
      channels: [
        { record_id: 'alpha-zulu', title: 'Zulu', scope_id: 'scope-alpha', sort_order: 2, record_state: 'active' },
        { record_id: 'beta-later', title: 'Later', scope_id: 'scope-beta', sort_order: 2, record_state: 'active' },
        { record_id: 'alpha-alpha', title: 'Alpha', scope_id: 'scope-alpha', sort_order: 1, record_state: 'active' },
        { record_id: 'beta-first', title: 'First', scope_id: 'scope-beta', sort_order: 1, record_state: 'active' },
      ],
      getChannelLabel(channel) {
        return channel.title;
      },
    });

    expect(store.pgContextChannels.map((channel) => channel.record_id)).toEqual([
      'beta-first',
      'beta-later',
      'alpha-alpha',
      'alpha-zulu',
    ]);
  });

  it('stably prioritizes unread channels only when enabled', () => {
    const channels = [
      { record_id: 'read-first' },
      { record_id: 'unread-first' },
      { record_id: 'read-second' },
      { record_id: 'unread-second' },
    ];
    const unreadIds = new Set(['unread-first', 'unread-second']);

    expect(prioritizeUnreadChannels(channels, (id) => unreadIds.has(id), true).map((channel) => channel.record_id)).toEqual([
      'unread-first',
      'unread-second',
      'read-first',
      'read-second',
    ]);
    expect(prioritizeUnreadChannels(channels, (id) => unreadIds.has(id), false)).toBe(channels);
  });

  it('reacts to unread changes in All while preserving scoped channel order', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([['scope-product', { record_id: 'scope-product', title: 'Product', sort_order: 1 }]]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      selectedBoardId: ALL_TASK_BOARD_ID,
      channels: [
        { record_id: 'channel-a', title: 'Alpha', scope_id: 'scope-product', sort_order: 1, record_state: 'active' },
        { record_id: 'channel-b', title: 'Beta', scope_id: 'scope-product', sort_order: 2, record_state: 'active' },
        { record_id: 'channel-c', title: 'Gamma', scope_id: 'scope-product', sort_order: 3, record_state: 'active' },
      ],
      _unreadChannels: { 'channel-c': true },
      isChannelUnread(channelId) {
        return this._unreadChannels[channelId] === true;
      },
      getChannelLabel(channel) {
        return channel.title;
      },
    });

    expect(store.pgContextChannels.map((channel) => channel.record_id)).toEqual(['channel-c', 'channel-a', 'channel-b']);

    store._unreadChannels = { 'channel-b': true };
    expect(store.pgContextChannels.map((channel) => channel.record_id)).toEqual(['channel-b', 'channel-a', 'channel-c']);

    store.selectedBoardId = 'scope-product';
    expect(store.pgContextChannels.map((channel) => channel.record_id)).toEqual(['channel-a', 'channel-b', 'channel-c']);
  });

  it('opens the current scope home from the PG context home tab', () => {
    const navigateTo = vi.fn();
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([['scope-product', product]]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'docs',
      selectedBoardId: buildPgChannelTaskBoardId('channel-home'),
      selectedChannelId: 'channel-home',
      activeThreadId: 'thread-home',
      focusMessageId: 'message-home',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      navigateTo,
    });

    store.openPgScopeHome();

    expect(store.selectedBoardId).toBe('scope-product');
    expect(store.selectedChannelId).toBeNull();
    expect(store.activeThreadId).toBeNull();
    expect(store.focusMessageId).toBeNull();
    expect(store.focusScopeTitle).toBe('Product X');
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('opens all scopes from the workspace avatar reset action', async () => {
    const navigateTo = vi.fn();
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([['scope-product', product]]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'docs',
      selectedBoardId: buildPgChannelTaskBoardId('channel-home'),
      selectedChannelId: 'channel-home',
      activeThreadId: 'thread-home',
      focusMessageId: 'message-home',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      navigateTo,
    });

    await store.openAllScopesOverview();

    expect(store.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
    expect(store.selectedChannelId).toBeNull();
    expect(store.activeThreadId).toBeNull();
    expect(store.focusMessageId).toBeNull();
    expect(store.navSection).toBe('status');
  });

  it('clears stale PG channel context when selecting All manually', () => {
    const store = Object.create(taskBoardStateMixin);
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'status',
      selectedBoardId: buildPgChannelTaskBoardId('channel-home'),
      selectedChannelId: 'channel-home',
      activeThreadId: 'thread-home',
      focusMessageId: 'message-home',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
    });

    store.selectBoard(ALL_TASK_BOARD_ID);

    expect(store.selectedBoardId).toBe(ALL_TASK_BOARD_ID);
    expect(store.pgContextAllScopesSelected).toBe(true);
    expect(store.pgContextSelectedChannelId).toBeNull();
    expect(store.selectedChannelId).toBeNull();
    expect(store.activeThreadId).toBeNull();
    expect(store.focusMessageId).toBeNull();
  });

  it('keeps PG scope selection at scope home instead of promoting to first channel', async () => {
    const store = Object.create(taskBoardStateMixin);
    Object.defineProperty(store, 'scopesMap', {
      configurable: true,
      value: new Map([['scope-product', product]]),
    });
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'chat',
      selectedBoardId: ALL_TASK_BOARD_ID,
      selectedChannelId: 'channel-other',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
        { record_id: 'channel-other', title: 'Other', scope_id: 'scope-other', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId: vi.fn(),
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      ensureSelectedChatChannelInScope: vi.fn(),
      selectChannel: vi.fn(),
      stopSelectedChannelLiveQuery: vi.fn(),
      applyMessages: vi.fn(),
      applyChatPresentation: vi.fn(function applyChatPresentation(channelId, presentation) {
        this.selectedChannelId = channelId;
        this.messages = presentation?.messages || [];
      }),
      startWorkspaceLiveQueries: vi.fn(),
      refreshMessages: vi.fn(),
    });

    await store.selectBoard('scope-product');

    expect(store.selectedBoardId).toBe('scope-product');
    expect(store.pgContextHomeSelected).toBe(true);
    expect(store.pgContextSelectedChannelId).toBeNull();
    expect(store.selectedChannelId).toBeNull();
    expect(store.ensureSelectedChatChannelInScope).not.toHaveBeenCalled();
    expect(store.selectChannel).not.toHaveBeenCalled();
    expect(store.applyChatPresentation).toHaveBeenCalledWith(null, null, { pending: true, scrollToLatest: false });
    expect(store.stopSelectedChannelLiveQuery).not.toHaveBeenCalled();
    expect(store.refreshMessages).toHaveBeenCalledWith(expect.objectContaining({
      scrollToLatest: false,
      deferEnrichment: true,
    }));
  });

  it('acknowledges a cached PG scope synchronously without clearing or manually rereading the feed', async () => {
    const cached = { messages: [{ record_id: 'scope-message' }], mainFeedVisibleCount: 80 };
    const store = Object.create(taskBoardStateMixin);
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'chat',
      selectedBoardId: 'scope-other',
      selectedChannelId: 'channel-other',
      channelSelectionGeneration: 4,
      channels: [],
      tasks: [],
      showTaskDetail: false,
      messages: [{ record_id: 'old-message' }],
      persistSelectedBoardId: vi.fn(),
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      syncSelectedChannelForPgBoard() { this.selectedChannelId = null; },
      saveCurrentChatPresentation: vi.fn(),
      getChatPresentationKey: vi.fn(() => 'channel:channel-other'),
      chatPresentationCache: { get: vi.fn(() => cached) },
      applyChatPresentation: vi.fn(function applyChatPresentation(channelId, presentation) {
        this.selectedChannelId = channelId;
        this.messages = presentation.messages;
      }),
      restoreChatComposerDraft: vi.fn(),
      startWorkspaceLiveQueries: vi.fn(),
      refreshMessages: vi.fn(),
    });

    const selection = store.selectBoard('scope-product');

    expect(store.selectedChannelId).toBeNull();
    expect(store.messages).toBe(cached.messages);
    expect(store.channelSelectionGeneration).toBe(5);
    expect(store.refreshMessages).not.toHaveBeenCalled();
    expect(store.startWorkspaceLiveQueries).not.toHaveBeenCalled();
    await selection;
    expect(store.startWorkspaceLiveQueries).toHaveBeenCalledTimes(1);
  });

  it('does not promote the chat Home selection back to the first channel', () => {
    const navigateTo = vi.fn(function navigate(section) {
      store.navSection = section;
    });
    const selectChannel = vi.fn();
    const store = Object.create(taskBoardStateMixin);
    Object.assign(store, {
      currentWorkspace: { pgBackendMode: true },
      navSection: 'chat',
      selectedBoardId: buildPgChannelTaskBoardId('channel-home'),
      selectedChannelId: 'channel-home',
      channels: [
        { record_id: 'channel-home', title: 'Home', scope_id: 'scope-product', record_state: 'active' },
      ],
      tasks: [],
      showTaskDetail: false,
      persistSelectedBoardId() {},
      clearSelectedTasks() {},
      normalizeTaskFilterTags() {},
      closeBoardPicker() {},
      syncRoute() {},
      ensureSelectedChatChannelInScope() {
        this.selectedChannelId = 'channel-home';
        return 'channel-home';
      },
      selectChannel,
      navigateTo,
    });

    store.openPgScopeHome();

    expect(store.selectedBoardId).toBe('scope-product');
    expect(store.selectedChannelId).toBeNull();
    expect(selectChannel).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

// --- computeFilteredTasks ---
describe('computeFilteredTasks', () => {
  const tasks = [
    { record_id: 't1', title: 'Fix login bug', description: '', tags: 'bug,urgent' },
    { record_id: 't2', title: 'Add dashboard', description: 'new feature', tags: 'feature' },
    { record_id: 't3', title: 'Refactor auth', description: '', tags: 'refactor' },
  ];

  it('returns all tasks when no query or filter tags', () => {
    expect(computeFilteredTasks(tasks, '', [])).toEqual(tasks);
  });

  it('filters by text query matching title', () => {
    const result = computeFilteredTasks(tasks, 'login', []);
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t1');
  });

  it('filters by text query matching description', () => {
    const result = computeFilteredTasks(tasks, 'feature', []);
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t2');
  });

  it('filters by tag', () => {
    const result = computeFilteredTasks(tasks, '', ['bug']);
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t1');
  });

  it('combines text and tag filters', () => {
    const result = computeFilteredTasks(tasks, 'Fix', ['bug']);
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t1');
  });

  it('filters first-class blocked tasks by status', () => {
    const result = computeFilteredTasks([
      { ...tasks[0], state: 'blocked' },
      { ...tasks[1], state: 'review' },
    ], '', [], null, 'blocked');

    expect(result.map((task) => task.record_id)).toEqual(['t1']);
  });

  it('returns empty when query matches nothing', () => {
    expect(computeFilteredTasks(tasks, 'nonexistent', [])).toHaveLength(0);
  });

  // --- assignee filtering (filter-to-me) ---
  const tasksWithAssignee = [
    { record_id: 't1', title: 'Fix login bug', description: '', tags: 'bug', assigned_to_npubs: ['npub1me'] },
    { record_id: 't2', title: 'Add dashboard', description: '', tags: 'feature', assigned_to_npubs: ['npub1other'] },
    { record_id: 't3', title: 'Refactor auth', description: '', tags: 'refactor', assigned_to_npubs: [] },
    { record_id: 't4', title: 'Write docs', description: '', tags: 'docs', assigned_to_npub: 'npub1me', assigned_to_npubs: ['npub1other', 'npub1me'] },
  ];

  it('filters by assignee npub when provided', () => {
    const result = computeFilteredTasks(tasksWithAssignee, '', [], 'npub1me');
    expect(result).toHaveLength(2);
    expect(result.map(t => t.record_id)).toEqual(['t1', 't4']);
  });

  it('filters legacy scalar assigned_to_npub rows by assignee npub', () => {
    const result = computeFilteredTasks([
      { record_id: 'legacy-1', title: 'Legacy assigned', description: '', tags: '', assigned_to_npub: 'npub1me' },
      { record_id: 'legacy-2', title: 'Legacy other', description: '', tags: '', assigned_to_npub: 'npub1other' },
    ], '', [], 'npub1me');

    expect(result.map(t => t.record_id)).toEqual(['legacy-1']);
  });

  it('returns all tasks when assigneeNpub is null', () => {
    const result = computeFilteredTasks(tasksWithAssignee, '', [], null);
    expect(result).toHaveLength(4);
  });

  it('returns all tasks when assigneeNpub is empty string', () => {
    const result = computeFilteredTasks(tasksWithAssignee, '', [], '');
    expect(result).toHaveLength(4);
  });

  it('combines assignee filter with text query', () => {
    const result = computeFilteredTasks(tasksWithAssignee, 'Fix', [], 'npub1me');
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t1');
  });

  it('combines assignee filter with tag filter', () => {
    const result = computeFilteredTasks(tasksWithAssignee, '', ['docs'], 'npub1me');
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t4');
  });

  it('combines all three filters together', () => {
    const result = computeFilteredTasks(tasksWithAssignee, 'Write', ['docs'], 'npub1me');
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t4');
  });

  it('returns empty when assignee matches but text does not', () => {
    const result = computeFilteredTasks(tasksWithAssignee, 'nonexistent', [], 'npub1me');
    expect(result).toHaveLength(0);
  });

  it('returns empty when no tasks match assignee', () => {
    const result = computeFilteredTasks(tasksWithAssignee, '', [], 'npub1nobody');
    expect(result).toHaveLength(0);
  });

  it('existing callers without assignee param still work (backwards compatible)', () => {
    // Calling with only 3 args should behave identically to before
    const result = computeFilteredTasks(tasksWithAssignee, 'Fix', []);
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('t1');
  });
});

describe('buildRecentFocusAreas', () => {
  it('returns the five most recently active scoped task areas', () => {
    const extraScopes = [
      product,
      project,
      deliverable,
      { record_id: 'scope-4', title: 'Fourth', level: 'l1', record_state: 'active', updated_at: '2026-01-01T00:00:00Z' },
      { record_id: 'scope-5', title: 'Fifth', level: 'l1', record_state: 'active', updated_at: '2026-01-01T00:00:00Z' },
      { record_id: 'scope-6', title: 'Sixth', level: 'l1', record_state: 'active', updated_at: '2026-01-01T00:00:00Z' },
    ];
    const scopesMap = buildScopesMap(extraScopes);
    const tasks = [
      { record_id: 't1', record_state: 'active', scope_id: 'scope-product', updated_at: '2026-05-01T00:00:00Z' },
      { record_id: 't2', record_state: 'active', scope_id: 'scope-project', updated_at: '2026-05-06T00:00:00Z' },
      { record_id: 't3', record_state: 'active', scope_id: 'scope-deliverable', updated_at: '2026-05-04T00:00:00Z' },
      { record_id: 't4', record_state: 'active', scope_id: 'scope-4', updated_at: '2026-05-03T00:00:00Z' },
      { record_id: 't5', record_state: 'active', scope_id: 'scope-5', updated_at: '2026-05-02T00:00:00Z' },
      { record_id: 't6', record_state: 'active', scope_id: 'scope-6', updated_at: '2026-04-30T00:00:00Z' },
    ];

    const areas = buildRecentFocusAreas(tasks, extraScopes, scopesMap);

    expect(areas.map((area) => area.id)).toEqual([
      'scope-project',
      'scope-deliverable',
      'scope-4',
      'scope-5',
      'scope-product',
    ]);
  });

  it('dedupes scopes and counts task activity', () => {
    const scopesMap = buildScopesMap([product, project]);
    const tasks = [
      { record_id: 't1', record_state: 'active', scope_id: 'scope-product', updated_at: '2026-05-01T00:00:00Z' },
      { record_id: 't2', record_state: 'active', scope_id: 'scope-product', updated_at: '2026-05-02T00:00:00Z' },
      { record_id: 't3', record_state: 'deleted', scope_id: 'scope-project', updated_at: '2026-05-03T00:00:00Z' },
    ];

    const areas = buildRecentFocusAreas(tasks, [product, project], scopesMap, { limit: 2 });

    expect(areas[0]).toMatchObject({
      id: 'scope-product',
      label: 'Product X',
      taskCount: 2,
    });
    expect(areas.some((area) => area.id === 'scope-project')).toBe(true);
  });

  it('prefers scoped recent changes when ordering focus areas', () => {
    const scopesMap = buildScopesMap([product, project, deliverable]);
    const tasks = [
      { record_id: 't1', record_state: 'active', scope_id: 'scope-product', updated_at: '2026-05-05T00:00:00Z' },
      { record_id: 't2', record_state: 'active', scope_id: 'scope-project', updated_at: '2026-05-04T00:00:00Z' },
    ];
    const recentChanges = [
      { id: 'comment:1', recordTypeKey: 'comment', boardScopeId: 'scope-deliverable', updatedAt: '2026-05-06T00:00:00Z' },
      { id: 'report:1', recordTypeKey: 'report', boardScopeId: 'scope-project', updatedAt: '2026-05-07T00:00:00Z' },
      { id: 'task:1', recordTypeKey: 'task', boardScopeId: 'scope-product', updatedAt: '2026-05-03T00:00:00Z' },
    ];

    const areas = buildRecentFocusAreas(tasks, [product, project, deliverable], scopesMap, { recentChanges });

    expect(areas.map((area) => area.id).slice(0, 3)).toEqual([
      'scope-project',
      'scope-deliverable',
      'scope-product',
    ]);
  });

  it('uses recent scope updates when there is no task activity', () => {
    const scopes = [
      { ...product, updated_at: '2026-05-01T00:00:00Z' },
      { ...project, updated_at: '2026-05-03T00:00:00Z' },
      { ...deliverable, updated_at: '2026-05-02T00:00:00Z' },
    ];
    const scopesMap = buildScopesMap(scopes);

    const areas = buildRecentFocusAreas([], scopes, scopesMap, { limit: 2 });

    expect(areas.map((area) => area.id)).toEqual(['scope-project', 'scope-deliverable']);
  });
});

describe('task tag popularity helpers', () => {
  const tasks = [
    { record_id: 't1', tags: 'marketing,flightdeck,ai' },
    { record_id: 't2', tags: 'marketing,docs' },
    { record_id: 't3', tags: 'flightdeck,marketing' },
    { record_id: 't4', tags: 'docs' },
  ];

  it('orders board tags by popularity, then alphabetically', () => {
    expect(computeTaskTagStats(tasks)).toEqual([
      { tag: 'marketing', count: 3 },
      { tag: 'docs', count: 2 },
      { tag: 'flightdeck', count: 2 },
      { tag: 'ai', count: 1 },
    ]);
  });

  it('orders a task tag row using board popularity', () => {
    expect(sortTagsByPopularity(
      ['ai', 'flightdeck', 'marketing'],
      { marketing: 3, docs: 2, flightdeck: 2, ai: 1 },
    )).toEqual(['marketing', 'flightdeck', 'ai']);
  });
});

// --- computeBoardColumns ---
describe('computeBoardColumns', () => {
  it('produces standard columns', () => {
    const cols = computeBoardColumns([], [], []);
    const stateNames = cols.map((c) => c.state);
    expect(stateNames).toEqual(['new', 'ready', 'in_progress', 'blocked', 'review', 'done']);
    expect(cols.map((c) => c.label)).toEqual(['Backlog', 'Ready', 'In Progress', 'Blocked', 'Review', 'Done']);
    expect(stateNames).not.toContain('definition');
    expect(cols.map(({ state, color }) => [state, color])).toEqual([
      ['new', '#9ca3af'],
      ['ready', '#f87171'],
      ['in_progress', '#fb923c'],
      ['blocked', '#c026d3'],
      ['review', '#34d399'],
      ['done', '#60a5fa'],
    ]);
  });

  it('resolves a task colour from its actual current column across moves and custom ordering', () => {
    const task = { recordId: 'task-review', taskState: 'review' };
    const inReviewColumns = [
      { state: 'done', color: '#64748b', tasks: [] },
      { state: 'review', label: 'In Review', color: '#16a34a', tasks: [{ record_id: 'task-review' }] },
      { state: 'new', color: '#94a3b8', tasks: [] },
    ];
    const customMovedColumns = [
      { state: 'quality_gate', label: 'Quality Gate', color: '#7c3aed', tasks: [{ record_id: 'task-review' }] },
      { state: 'review', label: 'In Review', color: '#16a34a', tasks: [] },
    ];

    expect(resolveTaskBoardColumnColor(task, inReviewColumns)).toBe('#16a34a');
    expect(resolveTaskBoardColumnColor(task, customMovedColumns)).toBe('#7c3aed');
  });

  it('prepends summary column when summaryTasks present', () => {
    const summary = [{ record_id: 's1', state: 'new' }];
    const cols = computeBoardColumns([], [], summary);
    expect(cols[0].state).toBe('summary');
    expect(cols[0].tasks).toBe(summary);
  });

  it('distributes active tasks to correct columns', () => {
    const active = [
      { record_id: 'a1', state: 'new' },
      { record_id: 'a2', state: 'in_progress' },
      { record_id: 'a3', state: 'blocked' },
    ];
    const cols = computeBoardColumns(active, [], []);
    expect(cols.find((c) => c.state === 'new').tasks).toHaveLength(1);
    expect(cols.find((c) => c.state === 'in_progress').tasks).toHaveLength(1);
    expect(cols.find((c) => c.state === 'blocked').tasks).toHaveLength(1);
    expect(cols.find((c) => c.state === 'ready').tasks).toHaveLength(0);
  });

  it('keeps unknown historical states visible in the New fallback column', () => {
    const historical = { record_id: 'legacy', state: 'waiting_external' };
    const cols = computeBoardColumns([historical], [], []);

    expect(cols.find((column) => column.state === 'new').tasks).toEqual([historical]);
  });

  it('places done tasks in done column', () => {
    const done = [{ record_id: 'd1', state: 'done' }];
    const cols = computeBoardColumns([], done, []);
    expect(cols.find((c) => c.state === 'done').tasks).toBe(done);
  });

  it('deduplicates duplicate task ids before rendering columns', () => {
    const active = [
      { record_id: 'a1', state: 'new', version: 1, updated_at: '2026-04-01T00:00:00.000Z' },
      { record_id: 'a1', state: 'new', version: 2, updated_at: '2026-04-01T00:01:00.000Z' },
    ];
    const cols = computeBoardColumns(active, [], []);
    expect(cols.find((c) => c.state === 'new').tasks).toHaveLength(1);
    expect(cols.find((c) => c.state === 'new').tasks[0].version).toBe(2);
  });

  it('orders cards by hidden board_order while preserving input order for unranked cards', () => {
    const active = [
      { record_id: 'a1', state: 'ready' },
      { record_id: 'a2', state: 'ready', board_order: 3000 },
      { record_id: 'a3', state: 'ready', board_order: 1000 },
      { record_id: 'a4', state: 'ready' },
    ];

    const cols = computeBoardColumns(active, [], []);

    expect(cols.find((c) => c.state === 'ready').tasks.map((task) => task.record_id)).toEqual([
      'a3',
      'a2',
      'a1',
      'a4',
    ]);
  });

  it('can order each column by created time oldest first', () => {
    const active = [
      { record_id: 'late', state: 'ready', title: 'Late', created_at: '2026-04-03T00:00:00Z' },
      { record_id: 'early', state: 'ready', title: 'Early', created_at: '2026-04-01T00:00:00Z' },
      { record_id: 'middle', state: 'ready', title: 'Middle', created_at: '2026-04-02T00:00:00Z' },
    ];

    const cols = computeBoardColumns(active, [], [], { sortMode: 'created_asc' });

    expect(cols.find((c) => c.state === 'ready').tasks.map((task) => task.record_id)).toEqual([
      'early',
      'middle',
      'late',
    ]);
  });

  it('can order each column by modified time newest first', () => {
    const active = [
      { record_id: 'old', state: 'review', title: 'Old', updated_at: '2026-04-01T00:00:00Z' },
      { record_id: 'new', state: 'review', title: 'New', updated_at: '2026-04-03T00:00:00Z' },
      { record_id: 'middle', state: 'review', title: 'Middle', updated_at: '2026-04-02T00:00:00Z' },
    ];

    const cols = computeBoardColumns(active, [], [], { sortMode: 'modified_desc' });

    expect(cols.find((c) => c.state === 'review').tasks.map((task) => task.record_id)).toEqual([
      'new',
      'middle',
      'old',
    ]);
  });

  it('can order each column by natural A-Z title order', () => {
    const active = [
      { record_id: 't10', state: 'new', title: '10 Check launch' },
      { record_id: 't2', state: 'new', title: '2 Fix signup' },
      { record_id: 't1', state: 'new', title: '1 Start here' },
      { record_id: 'alpha', state: 'new', title: 'Alpha task' },
    ];

    const cols = computeBoardColumns(active, [], [], { sortMode: 'alpha_asc' });

    expect(cols.find((c) => c.state === 'new').tasks.map((task) => task.record_id)).toEqual([
      't1',
      't2',
      't10',
      'alpha',
    ]);
  });

  it('can reverse created, modified, and title order', () => {
    const active = [
      { record_id: 'a', state: 'ready', title: '1 Alpha', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
      { record_id: 'b', state: 'ready', title: '2 Beta', created_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T00:00:00Z' },
      { record_id: 'c', state: 'ready', title: '10 Gamma', created_at: '2026-04-03T00:00:00Z', updated_at: '2026-04-03T00:00:00Z' },
    ];

    expect(computeBoardColumns(active, [], [], { sortMode: 'created_desc' }).find((c) => c.state === 'ready').tasks.map((task) => task.record_id))
      .toEqual(['c', 'b', 'a']);
    expect(computeBoardColumns(active, [], [], { sortMode: 'modified_asc' }).find((c) => c.state === 'ready').tasks.map((task) => task.record_id))
      .toEqual(['a', 'b', 'c']);
    expect(computeBoardColumns(active, [], [], { sortMode: 'alpha_desc' }).find((c) => c.state === 'ready').tasks.map((task) => task.record_id))
      .toEqual(['c', 'b', 'a']);
  });
});

describe('sortTasksByBoardOrder', () => {
  it('keeps unranked tasks stable after ranked tasks', () => {
    expect(sortTasksByBoardOrder([
      { record_id: 'first' },
      { record_id: 'ranked-low', board_order: 200 },
      { record_id: 'ranked-high', board_order: 100 },
      { record_id: 'last' },
    ]).map((task) => task.record_id)).toEqual([
      'ranked-high',
      'ranked-low',
      'first',
      'last',
    ]);
  });
});

describe('sortTasksForBoard', () => {
  it('falls back to manual board order for unknown modes', () => {
    expect(sortTasksForBoard([
      { record_id: 'manual-late', board_order: 2000 },
      { record_id: 'manual-first', board_order: 1000 },
    ], 'unknown').map((task) => task.record_id)).toEqual(['manual-first', 'manual-late']);
  });
});

describe('calculateTaskBoardOrderForInsertion', () => {
  it('uses a midpoint between neighbouring cards', () => {
    expect(calculateTaskBoardOrderForInsertion([
      { record_id: 'a', board_order: 1000 },
      { record_id: 'b', board_order: 3000 },
    ], {
      taskId: 'dragged',
      targetTaskId: 'b',
      position: 'before',
    })).toBe(2000);
  });

  it('creates stable virtual gaps for unranked cards', () => {
    expect(calculateTaskBoardOrderForInsertion([
      { record_id: 'a' },
      { record_id: 'b' },
    ], {
      taskId: 'dragged',
      targetTaskId: 'a',
      position: 'before',
    })).toBe(500);
  });

  it('moves the dragged task to the end after removing it from the sibling list', () => {
    expect(calculateTaskBoardOrderForInsertion([
      { record_id: 'a', board_order: 1000 },
      { record_id: 'dragged', board_order: 2000 },
      { record_id: 'c', board_order: 3000 },
    ], {
      taskId: 'dragged',
      position: 'end',
    })).toBe(4000);
  });
});

describe('buildTaskBoardReorderPatches', () => {
  it('moves a card into and out of the Blocked column', () => {
    expect(buildTaskBoardReorderPatches([], {
      taskId: 'dragged',
      draggedTask: { record_id: 'dragged', state: 'in_progress', board_order: 1000 },
      position: 'end',
      targetState: 'blocked',
    })).toEqual([
      { record_id: 'dragged', patch: { state: 'blocked' } },
    ]);

    expect(buildTaskBoardReorderPatches([], {
      taskId: 'dragged',
      draggedTask: { record_id: 'dragged', state: 'blocked', board_order: 1000 },
      position: 'end',
      targetState: 'review',
    })).toEqual([
      { record_id: 'dragged', patch: { state: 'review' } },
    ]);
  });

  it('normalizes an unranked target column so the dropped card stays at the requested position', () => {
    expect(buildTaskBoardReorderPatches([
      { record_id: 'a', state: 'ready' },
      { record_id: 'b', state: 'ready' },
    ], {
      taskId: 'dragged',
      draggedTask: { record_id: 'dragged', state: 'new' },
      targetTaskId: 'a',
      position: 'before',
      targetState: 'ready',
    })).toEqual([
      { record_id: 'dragged', patch: { board_order: 1000, state: 'ready' } },
      { record_id: 'a', patch: { board_order: 2000 } },
      { record_id: 'b', patch: { board_order: 3000 } },
    ]);
  });

  it('patches only the moved task when the target column already has stable ranks', () => {
    expect(buildTaskBoardReorderPatches([
      { record_id: 'a', state: 'ready', board_order: 1000 },
      { record_id: 'dragged', state: 'ready', board_order: 4500 },
      { record_id: 'b', state: 'ready', board_order: 5000 },
    ], {
      taskId: 'dragged',
      targetTaskId: 'a',
      position: 'after',
      targetState: 'ready',
    })).toEqual([
      { record_id: 'dragged', patch: { board_order: 3000 } },
    ]);
  });
});

describe('getTaskDropRecordId', () => {
  it('uses the dataTransfer task id when the browser provides one', () => {
    expect(getTaskDropRecordId({
      dataTransfer: {
        getData: (type) => type === 'text/plain' ? 'task-from-transfer' : '',
      },
    }, 'task-from-state')).toBe('task-from-transfer');
  });

  it('falls back to the drag-start task id when dataTransfer is empty', () => {
    expect(getTaskDropRecordId({
      dataTransfer: {
        getData: () => '',
      },
    }, 'task-from-state')).toBe('task-from-state');
  });
});

describe('dedupeTasksByRecordId', () => {
  it('keeps the newest version for duplicate record ids', () => {
    const deduped = dedupeTasksByRecordId([
      { record_id: 'task-1', version: 1, updated_at: '2026-04-01T00:00:00.000Z' },
      { record_id: 'task-1', version: 3, updated_at: '2026-04-01T00:00:05.000Z' },
      { record_id: 'task-2', version: 1, updated_at: '2026-04-01T00:00:00.000Z' },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.find((task) => task.record_id === 'task-1')?.version).toBe(3);
  });
});

describe('task board write groups', () => {
  it('uses the loaded scope group as the board write group for multi-group scopes', () => {
    const identity = createGroupIdentity();
    cacheGroupKey({
      group_id: 'g-external',
      group_npub: identity.npub,
      key_version: 1,
      nsec: identity.nsec,
    });

    const scope = {
      record_id: 'scope-1',
      level: 'l1',
      group_ids: ['g-private', 'g-shared', 'g-external'],
    };
    const store = {
      scopesMap: new Map([[scope.record_id, scope]]),
      groups: [],
      getScopeShareGroupIds(item) { return item.group_ids || []; },
      resolveGroupId(value) { return value; },
    };

    const assignment = taskBoardStateMixin.buildTaskBoardAssignment.call(store, scope.record_id);
    expect(assignment.board_group_id).toBe('g-external');
    expect(assignment.group_ids).toEqual(['g-private', 'g-shared', 'g-external']);
  });
});

// --- flightDeckScopeOptions (mixin) ---
describe('flightDeckScopeOptions includes scope picker boards', () => {
  function buildMockStore(scopes = [product, project, deliverable], tasks = []) {
    const scopesMap = buildScopesMap(scopes);
    const store = {
      scopes,
      tasks,
      scopesMap,
      boardPickerQuery: '',
      getScopeAncestorPath(id) { return getScopeAncestorPath(id, scopesMap); },
      formatTaskBoardScopeDisplay(scope) { return formatTaskBoardScopeDisplay(scope, scopesMap); },
      getTaskBoardSearchText(id) { return getTaskBoardSearchText(id, scopesMap); },
    };
    // Bind mixin getters as regular properties via Object.defineProperties
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(taskBoardStateMixin))) {
      if (descriptor.get) {
        Object.defineProperty(store, key, { get: descriptor.get.bind(store), configurable: true });
      }
    }
    return store;
  }

  it('includes All but not Recent in flightDeckScopeOptions', () => {
    const store = buildMockStore();
    const options = store.flightDeckScopeOptions;
    const ids = options.map((o) => o.id);
    expect(ids).toContain(ALL_TASK_BOARD_ID);
    expect(ids).not.toContain(RECENT_TASK_BOARD_ID);
  });

  it('excludes Unscoped from flightDeckScopeOptions', () => {
    const unscopedTask = { record_id: 't1', record_state: 'active', scope_id: null };
    const store = buildMockStore([product], [unscopedTask]);
    const options = store.flightDeckScopeOptions;
    const ids = options.map((o) => o.id);
    expect(ids).not.toContain(UNSCOPED_TASK_BOARD_ID);
  });

  it('places All before scope boards', () => {
    const store = buildMockStore();
    const options = store.flightDeckScopeOptions;
    const allIdx = options.findIndex((o) => o.id === ALL_TASK_BOARD_ID);
    const firstScopeIdx = options.findIndex((o) => o.id !== ALL_TASK_BOARD_ID);
    expect(allIdx).toBeLessThan(firstScopeIdx);
  });

  it('places DMs second after All', () => {
    const store = buildMockStore();
    const ids = store.flightDeckScopeOptions.map((o) => o.id);
    expect(ids[0]).toBe(ALL_TASK_BOARD_ID);
    expect(ids[1]).toBe(DM_SCOPE_ID);
  });

  it('sorts remaining scopes alphabetically after All and DMs', () => {
    const alpha = {
      record_id: 'scope-alpha',
      title: 'Alpha',
      level: 'product',
      parent_id: null,
      record_state: 'active',
    };
    const beta = {
      record_id: 'scope-beta',
      title: 'Beta',
      level: 'deliverable',
      parent_id: null,
      record_state: 'active',
    };
    const store = buildMockStore([beta, alpha, product]);
    expect(store.flightDeckScopeOptions.map((o) => o.id)).toEqual([
      ALL_TASK_BOARD_ID,
      DM_SCOPE_ID,
      alpha.record_id,
      beta.record_id,
      product.record_id,
    ]);
  });

  it('includes All but not Recent in filteredFlightDeckScopeOptions with no query', () => {
    const store = buildMockStore();
    const options = store.filteredFlightDeckScopeOptions;
    const ids = options.map((o) => o.id);
    expect(ids).toContain(ALL_TASK_BOARD_ID);
    expect(ids).not.toContain(RECENT_TASK_BOARD_ID);
  });

  it('does not return Recent for scope picker search query', () => {
    const store = buildMockStore();
    store.boardPickerQuery = 'recent';
    const options = store.filteredFlightDeckScopeOptions;
    const ids = options.map((o) => o.id);
    expect(ids).not.toContain(RECENT_TASK_BOARD_ID);
    expect(ids).not.toContain(ALL_TASK_BOARD_ID);
  });

  it('filterFlightDeckScopeOptions method includes virtual boards', () => {
    const store = buildMockStore();
    const options = store.flightDeckScopeOptions;
    // Use the method form via the mixin
    const filtered = taskBoardStateMixin.filterFlightDeckScopeOptions.call(
      { ...store, flightDeckScopeOptions: options, getTaskBoardSearchText: store.getTaskBoardSearchText },
      ''
    );
    const ids = filtered.map((o) => o.id);
    expect(ids).toContain(ALL_TASK_BOARD_ID);
    expect(ids).not.toContain(RECENT_TASK_BOARD_ID);
  });

  it('filterFlightDeckScopeOptions method filters by query', () => {
    const store = buildMockStore();
    const options = store.flightDeckScopeOptions;
    const filtered = taskBoardStateMixin.filterFlightDeckScopeOptions.call(
      { ...store, flightDeckScopeOptions: options, getTaskBoardSearchText: store.getTaskBoardSearchText },
      'all'
    );
    const ids = filtered.map((o) => o.id);
    expect(ids).toContain(ALL_TASK_BOARD_ID);
  });
});

// --- sidebar scope picker as single source of scope selection ---
describe('sidebar scope picker covers all active scopes', () => {
  function buildMockStore(scopes = [product, project, deliverable], tasks = []) {
    const scopesMap = buildScopesMap(scopes);
    const store = {
      scopes,
      tasks,
      scopesMap,
      boardPickerQuery: '',
      getScopeAncestorPath(id) { return getScopeAncestorPath(id, scopesMap); },
      formatTaskBoardScopeDisplay(scope) { return formatTaskBoardScopeDisplay(scope, scopesMap); },
      getTaskBoardSearchText(id) { return getTaskBoardSearchText(id, scopesMap); },
    };
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(taskBoardStateMixin))) {
      if (descriptor.get) {
        Object.defineProperty(store, key, { get: descriptor.get.bind(store), configurable: true });
      }
    }
    return store;
  }

  it('includes every real active scope from taskBoards plus All', () => {
    const unscopedTask = { record_id: 't1', record_state: 'active', scope_id: null };
    const store = buildMockStore([product, project, deliverable], [unscopedTask]);
    const sidebarIds = store.flightDeckScopeOptions.map((o) => o.id);
    const inlineIds = store.taskBoards.map((o) => o.id);

    for (const id of inlineIds) {
      if (id === UNSCOPED_TASK_BOARD_ID || id === RECENT_TASK_BOARD_ID) continue;
      expect(sidebarIds).toContain(id);
    }
  });

  it('sidebar options include all scope levels (product, project, deliverable)', () => {
    const store = buildMockStore();
    const ids = store.flightDeckScopeOptions.map((o) => o.id);
    expect(ids).toContain(product.record_id);
    expect(ids).toContain(project.record_id);
    expect(ids).toContain(deliverable.record_id);
  });

  it('sidebar filterFlightDeckScopeOptions can find scopes by title', () => {
    const store = buildMockStore();
    const filtered = taskBoardStateMixin.filterFlightDeckScopeOptions.call(
      { ...store, flightDeckScopeOptions: store.flightDeckScopeOptions, getTaskBoardSearchText: store.getTaskBoardSearchText },
      'Product X'
    );
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.some((o) => o.id === product.record_id)).toBe(true);
  });

  it('sidebar filterFlightDeckScopeOptions returns all options with empty query', () => {
    const store = buildMockStore();
    const all = store.flightDeckScopeOptions;
    const filtered = taskBoardStateMixin.filterFlightDeckScopeOptions.call(
      { ...store, flightDeckScopeOptions: all, getTaskBoardSearchText: store.getTaskBoardSearchText },
      ''
    );
    expect(filtered).toEqual(all);
  });
});


describe('Backlog collapse preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([null, '{}', '{"new":false,"done":true,"ready":false}', 'invalid'])('defaults Backlog closed with stored preferences %s', (raw) => {
    vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => raw) } });
    const store = { currentWorkspaceSlug: 'workspace-a' };
    const collapsed = taskBoardStateMixin.readStoredCollapsedSections.call(store);
    expect(collapsed.new).toBe(true);
    if (raw?.includes('done')) expect(collapsed).toEqual({ new: true, done: true, ready: false });
    expect(window.localStorage.getItem).toHaveBeenCalledWith('coworker:workspace-a:collapsed-sections');
  });

  it('allows explicit expansion, preserves other preferences, and closes again after reload', () => {
    const storage = new Map([['coworker:collapsed-sections', '{"done":true}']]);
    vi.stubGlobal('window', { localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    } });
    const store = {};
    Object.defineProperties(store, Object.getOwnPropertyDescriptors(taskBoardStateMixin));
    store.collapsedSections = store.readStoredCollapsedSections();
    store.toggleSectionCollapse('new');
    expect(store.isSectionCollapsed('new')).toBe(false);
    expect(store.isSectionCollapsed('done')).toBe(true);
    expect(JSON.parse(storage.get('coworker:collapsed-sections'))).toEqual({ done: true });
    expect(store.readStoredCollapsedSections()).toEqual({ done: true, new: true });
  });
});


describe('Backlog on a fresh task surface', () => {
  it('collapses when switching list and kanban while preserving other columns', () => {
    const store = { taskViewMode: 'kanban', collapsedSections: { new: false, done: true }, syncRoute: vi.fn() };
    taskBoardStateMixin.toggleTaskViewMode.call(store);
    expect(store.taskViewMode).toBe('list');
    expect(store.collapsedSections).toEqual({ new: true, done: true });
    store.collapsedSections.new = false;
    taskBoardStateMixin.toggleTaskViewMode.call(store);
    expect(store.taskViewMode).toBe('kanban');
    expect(store.collapsedSections).toEqual({ new: true, done: true });
  });
});
