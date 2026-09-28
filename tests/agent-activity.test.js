import { describe, expect, it } from 'vitest';

import {
  isVisibleAgentActivity,
  getAgentActivityHealth,
  mapPgAgentActivity,
  mapPgAgentSessionHealth,
  reconcileAgentActivity,
  selectVisibleAgentActivities,
  selectCurrentAgentActivities,
} from '../src/agent-activity.js';

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
    expect(getAgentActivityHealth(row, status, startedAt + 59_999, { startedAt }).message).toBe('Reconnecting');
    expect(getAgentActivityHealth(row, status, startedAt + 60_000, { startedAt }).message).toBe('Connection lost—status unknown');
    expect(selectVisibleAgentActivities([row], status, startedAt + 60_000)).toEqual([row]);
    expect(row.state).toBe('working');
  });

  it('clears uncertainty only when recovery succeeds and leaves expired rows unknown', () => {
    expect(getAgentActivityHealth(activity(), 'connected', Date.now(), { startedAt: 0 }).state).toBe('live');
    const expired = activity({ expires_at: '2000-01-01T00:00:00.000Z' });
    expect(getAgentActivityHealth(expired, 'connected').message).toBe('Status unknown — reconnecting');
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
