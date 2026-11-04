import { describe, expect, it } from 'vitest';

import {
  AGENT_ACTIVITY_LEASE_GRACE_MS,
  getAgentActivityLeaseState,
  isAgentActivityInStoppedWindow,
  mergeAgentActivityRecord,
  isVisibleAgentActivity,
  getAgentActivityHealth,
  mapPgAgentActivity,
  mapPgAgentSessionHealth,
  reconcileAgentActivity,
  selectVisibleAgentActivities,
  selectCurrentAgentActivities,
} from '../src/agent-activity.js';
import {
  agentActivityServerNow,
  recordAgentActivityServerTime,
  resetAgentActivityServerTime,
} from '../src/agent-activity-clock.js';

function activity(overrides = {}) {
  return mapPgAgentActivity({
    id: 'row-1',
    activity_id: 'activity-1',
    turn_id: 'turn-1',
    channel_id: 'channel-1',
    thread_id: 'thread-1',
    trigger_message_id: 'message-1',
    session_id: 'session-1',
    agent_npub: 'npub1agent',
    state: 'working',
    visibility: 'user_visible',
    sequence: 1,
    summary: 'Running validation',
    body: 'Only explicit commentary is included.',
    expires_at: '2999-01-01T00:00:00.000Z',
    created_at: '2026-08-10T01:00:00.000Z',
    ...overrides,
  });
}

describe('agent activity lifecycle', () => {
  it('replaces only with a newer sequence', () => {
    const current = activity({ sequence: 4, summary: 'Current' });
    expect(reconcileAgentActivity(current, activity({ sequence: 3, summary: 'Stale' }))).toBe(current);
    expect(reconcileAgentActivity(current, activity({ sequence: 5, summary: 'Newer' })).summary).toBe('Newer');
  });

  it.each(['completed', 'failed', 'cancelled'])('keeps terminal state %s as a lifecycle tombstone', (state) => {
    expect(reconcileAgentActivity(activity(), activity({ state, sequence: 2 }))).toEqual(expect.objectContaining({ state }));
  });

  it('rejects unsafe visibility while preserving expired and historical lifecycle rows', () => {
    expect(activity({ visibility: 'hidden_reasoning' })).toBeNull();
    const old = activity({ activity_id: 'old', turn_id: 'old', expires_at: '2000-01-01T00:00:00.000Z' });
    const terminal = activity({ state: 'completed' });
    expect(isVisibleAgentActivity(old)).toBe(true);
    expect(selectVisibleAgentActivities([old, terminal])).toEqual([old, terminal]);
  });

  it.each(['completed', 'failed', 'cancelled'])('retains confirmed %s with later runs and ignores out-of-order replay', (state) => {
    const terminal = activity({ state, sequence: 9 });
    const later = activity({ activity_id: 'later', turn_id: 'later', sequence: 1 });
    expect(selectVisibleAgentActivities([terminal, later, activity({ sequence: 2 })])).toEqual([terminal, later]);
    expect(getAgentActivityHealth(terminal, 'disconnected').state).toBe('finished');
  });

  it('does not deduplicate distinct workspace, backend or turn identities', () => {
    const rows = [activity(), activity({ workspace_id: 'another' }), activity({ turn_id: 'another' })];
    expect(selectVisibleAgentActivities(rows)).toHaveLength(3);
  });

  it('does not reconcile sequence across turn identities', () => {
    const current = activity({ turn_id: 'turn-b', sequence: 2 });
    expect(reconcileAgentActivity(current, activity({ turn_id: 'turn-a', sequence: 999, state: 'completed' }))).toBe(current);
  });

  it.each(['connecting', 'reconnecting', 'disconnected', 'fallback-polling', 'connected'])('keeps received content during %s recovery before and after 60 seconds', (status) => {
    const row = activity();
    const startedAt = 10_000;
    expect(getAgentActivityHealth(row, status, startedAt + 59_999, { startedAt }).message).toBe('reconnecting…');
    expect(getAgentActivityHealth(row, status, startedAt + 60_000, { startedAt }).message).toBe('connection lost · reconnecting…');
    expect(selectVisibleAgentActivities([row], status, startedAt + 60_000)).toEqual([row]);
    expect(row.state).toBe('working');
  });

  it('clears uncertainty only when recovery succeeds and reports expired rows as stopped', () => {
    expect(getAgentActivityHealth(activity(), 'connected', Date.now(), { startedAt: 0 }).state).toBe('live');
    const expired = activity({ expires_at: '2000-01-01T00:00:00.000Z' });
    expect(getAgentActivityHealth(expired, 'connected')).toEqual({ state: 'expired', message: 'Stopped responding' });
    // Producer death outranks transport loss: an expired turn never reads as reconnecting work.
    expect(getAgentActivityHealth(expired, 'reconnecting', Date.now(), { startedAt: 1 }).state).toBe('expired');
    expect(selectVisibleAgentActivities([expired])).toEqual([expired]);
  });

  it('maps lease, queue, heartbeat and separately ordered session health fields', () => {
    expect(activity({ state: 'queued', lease_expires_at: '2999-02-01T00:00:00Z', lease_health: 'live',
      last_heartbeat_at: '2026-09-22T00:00:00Z', blocked_by_turn_id: 'turn-before', queue_position: 2 })).toEqual(expect.objectContaining({
      state: 'queued', lease_expires_at: '2999-02-01T00:00:00Z', lease_health: 'live',
      blocked_by_turn_id: 'turn-before', queue_position: 2,
    }));
    expect(mapPgAgentSessionHealth({ id: 'health-1', session_id: 'session-1', channel_id: 'channel-1',
      status: 'busy', generation: 2, sequence: 1, row_version: 9, lease_health: 'live' })).toEqual(expect.objectContaining({
      record_id: 'health-1', status: 'busy', generation: 2, sequence: 1, row_version: 9,
    }));
  });
});

describe('current conversation failures', () => {
  const run = (n, state, overrides = {}) => activity({
    id: `row-${n}`, activity_id: `activity-${n}`, turn_id: `turn-${n}`,
    trigger_message_id: `message-${n}`, state,
    created_at: `2026-08-10T0${n}:00:00.000Z`, ...overrides,
  });

  it.each(['accepted', 'working', 'completed'])('retains a failure in history after a newer %s lifecycle', (state) => {
    const failed = run(1, 'failed');
    const current = run(2, state);
    expect(selectCurrentAgentActivities([failed, current])).toEqual([
      { ...current, earlier_activities: [failed] },
    ]);
  });

  it('keeps only the latest of several failed attempts live, including retries of one trigger', () => {
    const rows = [1, 2, 3].map(n => run(n, 'failed', { trigger_message_id: 'same-message' }));
    expect(selectCurrentAgentActivities(rows)).toEqual([
      { ...rows[2], earlier_activities: [rows[1], rows[0]] },
    ]);
  });

  it('preserves an unsuperseded failure despite expiry and a newer queued request', () => {
    const failed = run(1, 'failed', { expires_at: '2000-01-01' });
    const queued = run(2, 'queued', { blocked_by_turn_id: failed.turn_id });
    const rows = selectCurrentAgentActivities([failed, queued]);
    expect(rows.map(row => row.state)).toEqual(['queued', 'failed']);
    expect(rows.flatMap(row => row.earlier_activities)).toEqual([]);
  });

  it('retains earlier failures once while preserving current and queued turns', () => {
    const failed = run(1, 'failed');
    const current = run(2, 'working');
    const queued = run(3, 'queued');
    const expired = run(4, 'queued', { expires_at: '2000-01-01' });
    const rows = selectCurrentAgentActivities([failed, queued, current, expired]);
    expect(rows.map(row => row.activity_id)).toEqual([queued.activity_id, current.activity_id]);
    expect(rows.flatMap(row => row.earlier_activities)).toEqual([expired, failed]);
  });

  it('does not promote old failed replay or duplicate delivery over success', () => {
    const failed = run(1, 'failed', { sequence: 99, updated_at: '2999-01-01' });
    const current = run(2, 'completed');
    for (const rows of [[failed, current, failed], [current, failed, run(1, 'working')]]) {
      expect(selectCurrentAgentActivities(rows)).toEqual([{ ...current, earlier_activities: [failed] }]);
    }
  });

  it('does not suppress another agent or unthreaded request failure', () => {
    const failed = run(1, 'failed');
    const other = run(2, 'completed', { agent_npub: 'npub1other' });
    expect(selectCurrentAgentActivities([failed, other])).toHaveLength(2);
    expect(selectCurrentAgentActivities([run(1, 'failed', { thread_id: '' }), run(2, 'completed', { thread_id: '' })])).toHaveLength(2);
  });
});

describe('lease expiry and order-independent merge', () => {
  const deadline = Date.parse('2026-11-04T02:14:00.000Z');
  const leased = (overrides = {}) => activity({ lease_expires_at: '2026-11-04T02:14:00.000Z',
    expires_at: '2026-11-04T02:14:00.000Z', lease_health: 'live', ...overrides });

  it('stays live through the client grace and expires exactly at deadline plus grace', () => {
    expect(getAgentActivityLeaseState(leased(), deadline + AGENT_ACTIVITY_LEASE_GRACE_MS - 1)).toBe('live');
    expect(getAgentActivityLeaseState(leased(), deadline + AGENT_ACTIVITY_LEASE_GRACE_MS)).toBe('expired');
    expect(getAgentActivityLeaseState(leased({ lease_expires_at: '', expires_at: '' }), deadline)).toBe('expired');
    expect(getAgentActivityLeaseState(leased({ expired_at: '2026-11-04T02:14:01.000Z' }), deadline - 60_000)).toBe('expired');
    expect(getAgentActivityLeaseState(leased({ state: 'completed' }), deadline + 3_600_000)).toBe('terminal');
  });

  it('keeps an expired turn in the stopped window for ten minutes after it clears', () => {
    const clearAt = deadline + AGENT_ACTIVITY_LEASE_GRACE_MS;
    expect(isAgentActivityInStoppedWindow(leased(), clearAt)).toBe(true);
    expect(isAgentActivityInStoppedWindow(leased(), clearAt + 10 * 60_000 - 1)).toBe(true);
    expect(isAgentActivityInStoppedWindow(leased(), clearAt + 10 * 60_000)).toBe(false);
    const [current] = selectCurrentAgentActivities([leased()], clearAt + 10 * 60_000);
    expect(current.history_only).toBe(true);
  });

  it('converges to one result for every delivery order of state, lease, expiry and terminal events', () => {
    const events = [
      leased({ sequence: 2, body: 'Reading the repository', lease_epoch: 1, lease_sequence: 1 }),
      leased({ sequence: 2, body: 'Reading the repository', lease_epoch: 1, lease_sequence: 4,
        lease_expires_at: '2026-11-04T02:17:00.000Z', expires_at: '2026-11-04T02:17:00.000Z' }),
      leased({ sequence: 3, body: 'Running tests', lease_epoch: 1, lease_sequence: 2,
        lease_expires_at: '2026-11-04T02:15:00.000Z', expires_at: '2026-11-04T02:15:00.000Z' }),
      // An expiry from an earlier epoch is cleared by the resumed epoch.
      leased({ sequence: 2, lease_epoch: 0, lease_sequence: 9, expired_at: '2026-11-04T02:10:05.000Z' }),
    ];
    const permutations = (items) => items.length <= 1 ? [items]
      : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));
    const results = permutations(events).map((order) => order.reduce((current, next) => mergeAgentActivityRecord(current, next), null));
    for (const result of results) {
      expect(result).toMatchObject({ sequence: 3, body: 'Running tests', lease_sequence: 4,
        lease_expires_at: '2026-11-04T02:17:00.000Z', expired_at: '' });
    }
    const withTerminal = permutations([...events.slice(0, 3), leased({ sequence: 1, state: 'completed' })])
      .map((order) => order.reduce((current, next) => mergeAgentActivityRecord(current, next), null));
    for (const result of withTerminal) expect(result.state).toBe('completed');
  });

  it('keeps an epoch expiry against later same-epoch events and requires a new epoch to resume', () => {
    const renewed = leased({ lease_epoch: 1, lease_sequence: 4 });
    const expired = mergeAgentActivityRecord(renewed, leased({ lease_epoch: 1, lease_sequence: 4,
      expired_at: '2026-11-04T02:14:10.000Z' }));
    expect(getAgentActivityLeaseState(expired, deadline - 1)).toBe('expired');
    expect(mergeAgentActivityRecord(expired, leased({ lease_epoch: 1, lease_sequence: 3 }))).toBe(expired);
    expect(mergeAgentActivityRecord(expired, leased({ lease_epoch: 1, lease_sequence: 5, sequence: 7 })).expired_at)
      .toBe('2026-11-04T02:14:10.000Z');
    const resumed = mergeAgentActivityRecord(expired, leased({ lease_epoch: 2, lease_sequence: 0,
      lease_expires_at: '2026-11-04T02:20:00.000Z', expires_at: '2026-11-04T02:20:00.000Z' }));
    expect(resumed).toMatchObject({ expired_at: '', lease_epoch: 2 });
    expect(getAgentActivityLeaseState(resumed, deadline + 60_000)).toBe('live');
  });

  it('calibrates from a fresh server_time; a clock set back cannot extend a lease, sleep cannot freeze one', () => {
    resetAgentActivityServerTime();
    const tower = 'https://tower.example/';
    expect(agentActivityServerNow(tower, 123)).toBe(123);
    const localNow = Date.now();
    recordAgentActivityServerTime(tower, new Date(localNow + 5 * 60_000).toISOString(), { receivedAtEpochMs: localNow });
    const skewed = agentActivityServerNow('https://tower.example');
    expect(Math.abs(skewed - (localNow + 5 * 60_000))).toBeLessThan(1_000);
    const realNow = Date.now;
    try {
      // Wall clock set back an hour: monotonic elapsed still applies.
      Date.now = () => realNow() - 3_600_000;
      expect(Math.abs(agentActivityServerNow(tower) - skewed)).toBeLessThan(1_000);
      // Ten minutes of OS sleep with a frozen monotonic clock: wall elapsed applies.
      Date.now = () => realNow() + 10 * 60_000;
      expect(agentActivityServerNow(tower) - skewed).toBeGreaterThan(10 * 60_000 - 1_000);
    } finally {
      Date.now = realNow;
      resetAgentActivityServerTime();
    }
    expect(recordAgentActivityServerTime(tower, 'not a time')).toBe(false);
  });

  it('treats lease_health as a hint: a stale hint with a valid future deadline stays live', () => {
    expect(getAgentActivityLeaseState(leased({ lease_health: 'stale' }), deadline - 1)).toBe('live');
    expect(getAgentActivityLeaseState(leased({ lease_health: 'live' }), deadline + AGENT_ACTIVITY_LEASE_GRACE_MS)).toBe('expired');
  });
});
