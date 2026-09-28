import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { chatMessageManagerMixin } from '../src/chat-message-manager.js';

function store() {
  return Object.assign(Object.create(chatMessageManagerMixin), {
    currentWorkspace: { workspaceId: 'workspace-a' }, backendUrl: 'https://tower.example',
    activeThreadId: 'thread-a', activeChannelId: 'channel-a', sseStatus: 'connected',
    expandedAgentActivityIds: {}, agentActivities: [],
    getThreadParentMessage: () => null, getSenderName: () => 'Agent',
    revealPendingThreadAgentActivity() {}, updateResponseActivityTimer() {},
    requestTowerSyncFamily: vi.fn(async () => Object.assign([], { next_cursor: null })),
  });
}
function activity(overrides = {}) {
  return { record_id: 'row', activity_id: 'activity', turn_id: 'turn', channel_id: 'channel-a',
    state: 'working', sequence: 2, visibility: 'user_visible', expires_at: '2999-01-01T00:00:00Z',
    commentary_history: [{ history_key: 'one', turn_id: 'turn', activity_id: 'activity', sequence: 1, body: 'Visible update' }], ...overrides };
}

describe('activity presentation and user-requested bounded history loading', () => {
  it('shows recovery failures without exposing backend error details', () => {
    const target = store();
    target.agentActivityRecoveryError = 'secret transport diagnostics';
    target.agentActivityRecoveryAttempts = 1;
    expect(target.getAgentActivityRecoveryMessage(activity())).toBe('Activity updates could not be recovered. Retrying.');
    target.agentActivityRecoveryAttempts = 3;
    expect(target.getAgentActivityRecoveryMessage(activity())).toBe('Activity updates could not be recovered. Retrying with background sync.');
    expect(target.getAgentActivityRecoveryMessage(activity({ state: 'completed' }))).toBe('');
  });

  it.each(['completed', 'failed', 'cancelled'])('collapses confirmed %s, keeps history accessible after refresh', (state) => {
    const target = store();
    target.applyAgentActivities([activity()]);
    target.toggleAgentActivity('activity');
    expect(target.isAgentActivityExpanded('activity')).toBe(true);
    target.applyAgentActivities([activity({ state, sequence: 3 })]);
    expect(target.isAgentActivityExpanded('activity')).toBe(false);
    expect(target.formatAgentActivityTitle(target.agentActivities[0])).toBe(`Agent ${state}`);
    const reloaded = store();
    reloaded.applyAgentActivities(target.agentActivities);
    expect(reloaded.getVisibleAgentActivities()).toHaveLength(1);
    expect(reloaded.hasAgentActivityCommentaryHistory(reloaded.agentActivities[0])).toBe(true);
    reloaded.toggleAgentActivity('activity');
    reloaded.toggleAgentActivityHistory(reloaded.agentActivities[0]);
    expect(reloaded.isAgentActivityHistoryExpanded(reloaded.agentActivities[0])).toBe(true);
    expect(reloaded.getAgentActivityCommentaryHistory(reloaded.agentActivities[0])[0].body).toBe('Visible update');
  });

  it('loads one commentary page through the sync service and exposes retry after failure', async () => {
    const target = store();
    const row = activity({ commentary_next_before_sequence: 15 });
    target.requestTowerSyncFamily.mockRejectedValueOnce(new Error('offline'));
    await target.loadEarlierAgentActivityHistory(row);
    expect(target.getAgentActivityHistoryLoadState(row)).toBe('failed');
    await target.loadEarlierAgentActivityHistory(row);
    expect(target.getAgentActivityHistoryLoadState(row)).toBe('');
    expect(target.requestTowerSyncFamily).toHaveBeenLastCalledWith('agent-activity-history', 'channel-a:activity:15', {
      channelId: 'channel-a', activityId: 'activity', turnId: 'turn', beforeSequence: 15,
    });
    expect(target.agentActivities).toEqual([]);
  });

  it('coalesces clicks and prevents a late earlier-run page from affecting another workspace', async () => {
    const target = store();
    let resolve;
    target.requestTowerSyncFamily.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = target.loadEarlierAgentActivityRuns();
    await target.loadEarlierAgentActivityRuns();
    expect(target.requestTowerSyncFamily).toHaveBeenCalledTimes(1);
    target.currentWorkspace = { workspaceId: 'workspace-b' };
    resolve(Object.assign([], { next_cursor: 'older' }));
    await first;
    expect(target.getAgentActivityRunsLoadState()).toEqual({});
    expect(target.agentActivities).toEqual([]);
  });

  it('follows scoped run cursors and stops at a completed page', async () => {
    const target = store();
    target.requestTowerSyncFamily.mockResolvedValueOnce(Object.assign([], { next_cursor: 'older' }));
    await target.loadEarlierAgentActivityRuns();
    await target.loadEarlierAgentActivityRuns();
    await target.loadEarlierAgentActivityRuns();
    expect(target.requestTowerSyncFamily).toHaveBeenCalledTimes(2);
    expect(target.requestTowerSyncFamily).toHaveBeenLastCalledWith('channel-agent-activities', 'channel-a:thread-a:older', {
      channelId: 'channel-a', threadId: 'thread-a', cursor: 'older',
    });
    expect(target.getAgentActivityRunsLoadState().done).toBe(true);
  });
});

describe('retained run grouping', () => {
  function run(id, overrides = {}) {
    return activity({ record_id: id, activity_id: id, turn_id: id, agent_npub: 'agent-a',
      workspace_id: 'workspace-a', backend_url: 'https://tower.example', thread_id: 'thread-a',
      trigger_message_id: id, created_at: `2026-09-08T0${id}:00:00Z`, ...overrides });
  }
  it('keeps only the current turn attached to its trigger while retaining expired runs in history', () => {
    const target = store();
    target.applyAgentActivities([run('1', { expires_at: '2000-01-01' }), run('2', { expires_at: '2000-01-01' }), run('3')]);
    expect(target.activeThreadAgentActivities).toHaveLength(1);
    expect(target.getAgentActivitiesForMessage('1')).toEqual([]);
    target.openAgentActivityDetails();
    expect(target.agentActivityDetailsRows.map(row => row.activity_id)).toEqual(['3', '2', '1']);
    expect(target.getAgentActivitiesForMessage('3')).toEqual([expect.objectContaining({ activity_id: '3' })]);
    expect(target.agentActivities).toHaveLength(3);
  });
  it('keeps a late old replay out of the current slot and retains terminal history', () => {
    const target = store();
    target.applyAgentActivities([run('1', { sequence: 999, updated_at: '2999-01-01', state: 'completed' }), run('2')]);
    expect(target.activeThreadAgentActivities.map(row => row.activity_id)).toEqual(['2']);
  });
  it('keeps distinct agents, workspaces, backends and conversations separate', () => {
    const target = store();
    target.applyAgentActivities([run('1'), run('2', { agent_npub: 'agent-b' }),
      run('3', { workspace_id: 'workspace-b' }), run('4', { backend_url: 'https://other.example' }),
      run('5', { thread_id: 'other' }), run('6', { channel_id: 'other' })]);
    expect(target.getVisibleAgentActivities()).toHaveLength(4);
    expect(target.activeThreadAgentActivities.map(row => row.activity_id)).toEqual(['1', '2']);
  });
  it('shows quiet expiry neutrally and warns only the current panel after reconnect grace', () => {
    const target = store();
    target.applyAgentActivities([run('1'), run('2', { expires_at: '2000-01-01' })]);
    const current = target.activeThreadAgentActivities.find(row => row.activity_id === '2');
    expect(target.getAgentActivityHealth(current)).toEqual({ state: 'stale', message: 'Status unknown — reconnecting' });
    target.sseStatus = 'reconnecting';
    target.agentActivityRecoveryStartedAt = Date.now() - 59_000;
    expect(target.getAgentActivityHealth(current).message).toBe('Reconnecting');
    target.agentActivityRecoveryStartedAt -= 2_000;
    expect(target.getAgentActivityHealth(current).message).toBe('Connection lost—status unknown');
    expect(target.activeThreadAgentActivities).toHaveLength(1);
  });

  it('shows a queued message beneath the prior working message and promotes it in place', () => {
    const target = store();
    const prior = run('1', { state: 'working', body: 'Still handling the first request' });
    const queued = run('2', { state: 'queued', queue_position: 1, blocked_by_turn_id: '1' });
    target.applyAgentActivities([prior, queued]);
    expect(target.getAgentActivitiesForMessage('1')[0]).toEqual(expect.objectContaining({ state: 'working' }));
    expect(target.getAgentActivitiesForMessage('2')[0]).toEqual(expect.objectContaining({ state: 'queued' }));
    expect(target.getAgentActivityStatusLabel(queued)).toContain('Queued behind');
    target.applyAgentActivities([prior, { ...queued, state: 'working', sequence: 2, queue_position: null }]);
    expect(target.getAgentActivitiesForMessage('2')[0]).toEqual(expect.objectContaining({ state: 'working' }));
  });

  it('reduces the screenshot stack to one current status and genuine queued work without losing commentary', () => {
    const target = store();
    const rows = [
      run('1', { session_id: 'pending:1', expires_at: '2000-01-01', commentary_history: [] }),
      run('2', { session_id: 'pending:2', commentary_history: [], body: '' }),
      run('3', { session_id: 'pending:3', state: 'accepted', expires_at: '2000-01-01', commentary_history: [] }),
      run('4', { session_id: 'pending:4', state: 'queued', blocked_by_turn_id: '3', queue_position: 2 }),
    ];
    target.applyAgentActivities(rows);
    const cards = () => target.activeThreadAgentActivities.filter(row => target.isCurrentAgentActivityWorking(row));
    expect(cards().map(row => row.activity_id)).toEqual(['3', '4']);
    // Commentary arriving late must remain available without promoting the old turn.
    target.applyAgentActivities([{ ...rows[0], sequence: 999, updated_at: '2999-01-01',
      commentary_history: [{ activity_id: '1', turn_id: '1', sequence: 998, body: 'Earlier useful commentary' }] }, ...rows.slice(1)]);
    expect(cards().map(row => row.activity_id)).toEqual(['3', '4']);
    target.openAgentActivityDetails();
    expect(target.agentActivityDetailsRows).toHaveLength(4);
    const earlier = target.agentActivityDetailsRows.find(row => row.activity_id === '1');
    expect(target.getAgentActivityCommentaryHistory(earlier)[0].body).toBe('Earlier useful commentary');
    // Promotion replaces the old current card even without session health.
    target.applyAgentActivities([...rows.slice(0, 3), { ...rows[3], state: 'working', sequence: 3 }]);
    expect(cards().map(row => row.activity_id)).toEqual(['4']);
    target.applyAgentActivities([...rows.slice(0, 3), { ...rows[3], state: 'completed', sequence: 4 }]);
    expect(cards()).toEqual([]);
  });

  it('keeps failure details visible beside newer work and never revives an expired queue on disconnect', () => {
    const target = store();
    target.applyAgentActivities([run('1', { state: 'failed', body: 'Validation failed' }), run('2'),
      run('3', { state: 'queued', expires_at: '2000-01-01' })]);
    target.sseStatus = 'disconnected';
    const cards = target.activeThreadAgentActivities.filter(row => target.isCurrentAgentActivityWorking(row));
    expect(cards.map(row => row.activity_id)).toEqual(['1', '2']);
    expect(target.getAgentActivityStatusLabel(cards[0])).toBe('Validation failed');
    target.openAgentActivityDetails();
    expect(target.agentActivityDetailsRows).toHaveLength(3);
  });

  it('distinguishes a stale turn lease from a live session and exposes session errors', () => {
    const target = store();
    const stale = run('1', { lease_health: 'stale', lease_expires_at: '2000-01-01' });
    target.applyAgentSessionHealth([{ record_id: 'health-1', session_id: stale.session_id, channel_id: stale.channel_id,
      agent_npub: stale.agent_npub, status: 'online', row_version: 1 }]);
    expect(target.getAgentActivityStatusLabel(stale)).toBe('Status unknown — reconnecting');
    expect(target.getAgentSessionStatusLabel(stale)).toBe('Session online');
    target.applyAgentSessionHealth([{ record_id: 'health-1', session_id: stale.session_id, channel_id: stale.channel_id,
      agent_npub: stale.agent_npub, status: 'errored', error_summary: 'Runtime exited', row_version: 2 }]);
    expect(target.getAgentSessionStatusLabel(stale)).toBe('Session errored — Runtime exited');
  });

  it('keeps the working control live when mobile fallback sync is usable during SSE probes', () => {
    const target = store();
    const current = run('1');
    target.sseStatus = 'reconnecting';
    target.agentActivityRecoveryStartedAt = Date.now();
    target.towerReachabilityState = 'online';
    target.towerFallbackReachable = true;

    expect(target.getAgentActivityStatusLabel(current)).toBe('Working');

    target.towerFallbackReachable = false;
    target.towerReachabilityState = 'reconnecting';
    expect(target.getAgentActivityStatusLabel(current)).toBe('Reconnecting');
  });

  it.each(['completed', 'failed', 'cancelled'])('preserves failures and hides other terminal %s activity from the live card slot', (state) => {
    const target = store();
    const row = run('1', { state });
    target.applyAgentActivities([row]);
    expect(target.isCurrentAgentActivityWorking(row)).toBe(state === 'failed');
    expect(target.agentActivities).toEqual([expect.objectContaining({ state })]);
  });

  it('supersedes an older working card when session health names the current turn', () => {
    const target = store();
    const prior = run('1', { session_id: 'session-1', state: 'working' });
    const current = run('2', { session_id: 'session-1', state: 'working' });
    target.applyAgentActivities([prior, current]);
    target.applyAgentSessionHealth([{ record_id: 'health-1', session_id: 'session-1', channel_id: 'channel-a',
      agent_npub: 'agent-a', status: 'busy', active_turn_id: '2', row_version: 2 }]);
    expect(target.isCurrentAgentActivityWorking(prior)).toBe(false);
    expect(target.isCurrentAgentActivityWorking(current)).toBe(true);
  });

  it('removes a working card on terminal session health while retaining newer and queued work', () => {
    const target = store();
    const finished = run('1', { session_id: 'session-1', updated_at: '2026-09-08T01:00:00Z' });
    const newer = run('2', { session_id: 'session-2', updated_at: '2026-09-08T03:00:00Z' });
    const queued = run('3', { session_id: 'session-1', state: 'queued', updated_at: '2026-09-08T01:00:00Z' });
    target.applyAgentSessionHealth([
      { record_id: 'health-1', session_id: 'session-1', channel_id: 'channel-a', agent_npub: 'agent-a',
        status: 'idle', active_turn_id: null, row_version: 2, updated_at: '2026-09-08T02:00:00Z' },
      { record_id: 'health-2', session_id: 'session-2', channel_id: 'channel-a', agent_npub: 'agent-a',
        status: 'idle', active_turn_id: null, row_version: 1, updated_at: '2026-09-08T02:00:00Z' },
    ]);
    expect(target.isCurrentAgentActivityWorking(finished)).toBe(false);
    expect(target.isCurrentAgentActivityWorking(newer)).toBe(true);
    expect(target.isCurrentAgentActivityWorking(queued)).toBe(true);
  });
});

describe('menu-only activity details', () => {
  it('keeps expiry and completion out of the timeline without deleting history', () => {
    const target = store();
    const row = activity({ thread_id: 'thread-a', expires_at: '2000-01-01' });
    target.agentActivities = [row];
    target.sseStatus = 'reconnecting';
    expect(target.isCurrentAgentActivityWorking(row)).toBe(true);
    target.openAgentActivityDetails();
    expect(target.agentActivityDetailsRows).toHaveLength(1);
    row.expires_at = '2999-01-01';
    expect(target.isCurrentAgentActivityWorking(row)).toBe(true);
    row.state = 'completed';
    expect(target.isCurrentAgentActivityWorking(row)).toBe(false);
    expect(target.agentActivityDetailsRows).toHaveLength(1);
  });

  it('closes and clears displayed details on workspace, backend or thread switches', () => {
    for (const change of [s => s.currentWorkspace = {workspaceId:'other'}, s => s.backendUrl = 'https://other.example', s => s.activeThreadId = 'other']) {
      const target = store();
      target.agentActivities = [activity({thread_id:'thread-a'})];
      target.openAgentActivityDetails();
      expect(target.isAgentActivityDetailsOpen()).toBe(true);
      change(target);
      expect(target.isAgentActivityDetailsOpen()).toBe(false);
      expect(target.agentActivityDetailsRows).toEqual([]);
    }
  });

  it('uses the Inbox parent channel and pages channel history independently', async () => {
    const target = store();
    target.getThreadParentMessage = () => ({channel_id:'inbox-channel',pg_thread_id:'inbox-thread'});
    target.agentActivities = [activity({channel_id:'inbox-channel',thread_id:'inbox-thread'}), activity({record_id:'other',activity_id:'other',thread_id:'thread-a'})];
    target.openAgentActivityDetails('thread');
    expect(target.agentActivityDetailsRows.map(row => row.record_id)).toEqual(['row']);
    await target.loadEarlierAgentActivityRuns();
    expect(target.requestTowerSyncFamily).toHaveBeenLastCalledWith('channel-agent-activities', 'inbox-channel:inbox-thread:first', {channelId:'inbox-channel',threadId:'inbox-thread',cursor:undefined});
    target.openAgentActivityDetails('channel');
    expect(target.agentActivityDetailsRows.map(row => row.record_id)).toEqual(['other']);
    await target.loadEarlierAgentActivityRuns('channel');
    expect(target.requestTowerSyncFamily).toHaveBeenLastCalledWith('channel-agent-activities', 'channel-a:null:first', {channelId:'channel-a',threadId:null,cursor:undefined});
  });
});


describe('current answer working history', () => {
  it('rotates with the existing timer and holds still for reduced motion', () => {
    vi.useFakeTimers();
    const target = store();
    target.agentActivities = [activity()];
    target.updateResponseActivityTimer = chatMessageManagerMixin.updateResponseActivityTimer;
    vi.stubGlobal('window', {setInterval, clearInterval, matchMedia: vi.fn(() => ({matches: false}))});
    try {
      const first = target.getCurrentWorkingSymbol();
      target.updateResponseActivityTimer();
      vi.advanceTimersByTime(900);
      expect(target.getCurrentWorkingSymbol()).not.toBe(first);
      window.matchMedia = vi.fn(() => ({matches: true}));
      const reduced = target.getCurrentWorkingSymbol();
      vi.advanceTimersByTime(900);
      expect(target.getCurrentWorkingSymbol()).toBe(reduced);
      target.agentActivities = [];
      target.updateResponseActivityTimer();
      expect(target.responseActivityTimer).toBeNull();
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it('orders and deduplicates four full updates, includes a live fifth and excludes other turns', () => {
    const target = store();
    const entries = [4, 2, 1, 3, 2].map(sequence => ({activity_id:'activity',turn_id:'turn',sequence,body:`Full update ${sequence}`}));
    const row = activity({sequence:4,body:'Full update 4',commentary_history:[...entries,
      {...entries[0],turn_id:'old',body:'Old history'}, {...entries[0],workspace_id:'other',body:'Other workspace'}],commentary_next_before_sequence:null});
    expect(target.getCurrentWorkingHistory(row).map(item => item.body)).toEqual([1,2,3,4].map(n => `Full update ${n}`));
    expect(target.getCurrentWorkingCount(row)).toBe('4 working updates');
    row.sequence = 5; row.body = 'Full fifth update';
    expect(target.getCurrentWorkingHistory(row).at(-1).body).toBe('Full fifth update');
    expect(target.getCurrentWorkingCount(row)).toBe('5 working updates');
    row.commentary_next_before_sequence = 1;
    expect(target.getCurrentWorkingCount(row)).toBe('5 working updates loaded · more available');
    delete row.commentary_next_before_sequence;
    expect(target.getCurrentWorkingCount(row)).toBe('5 working updates loaded');
  });

  it('scopes expansion and history loading to workspace, backend, thread and turn', () => {
    const target = store(); const row = activity();
    const key = target.getCurrentWorkingKey(row);
    expect(target.getCurrentWorkingKey({...row,turn_id:'next'})).not.toBe(key);
    target.activeThreadId = 'next-thread';
    expect(target.getCurrentWorkingKey(row)).not.toBe(key);
    target.agentActivityHistoryLoads = {[target.getAgentActivityHistoryLoadKey(row)]:'loading'};
    target.currentWorkspace = {workspaceId:'other'};
    expect(target.getAgentActivityHistoryLoadState(row)).toBe('');
  });
});
