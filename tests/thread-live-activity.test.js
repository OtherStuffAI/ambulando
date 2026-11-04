import { describe, expect, it, vi } from 'vitest';
import {
  boundLiveOverlayByTower,
  LIVE_THREAD_ACTIVITY_CAPABILITY,
  liveOverlayAsAgentActivity,
  reconcileLiveThreadActivity,
  ThreadLiveActivityController,
  terminalLiveActivityHasDurableFinal,
} from '../src/thread-live-activity.js';
import { getAgentActivityLeaseState } from '../src/agent-activity.js';

const event = (patch = {}) => ({
  routing_key: 'route-1',
  session_generation: 1,
  turn_id: 'turn-1',
  sequence: 1,
  cursor: '1',
  lifecycle: 'working',
  commentary: 'Inspecting.',
  activity_status: 'Working',
  timestamp: '2026-09-24T00:00:00Z',
  ...patch,
});

describe('thread live activity reconciliation', () => {
  it('accepts newer generations and higher sequence without duplicates or regression', () => {
    const first = reconcileLiveThreadActivity(null, event());
    expect(reconcileLiveThreadActivity(first, event())).toBe(first);
    expect(reconcileLiveThreadActivity(first, event({ sequence: 0, cursor: '0' }))).toBe(first);
    expect(reconcileLiveThreadActivity(first, event({ sequence: 2, cursor: '2' })).sequence).toBe(
      2,
    );
    expect(
      reconcileLiveThreadActivity(
        first,
        event({ session_generation: 2, turn_id: 'turn-2', sequence: 1 }),
      ).turn_id,
    ).toBe('turn-2');
    expect(reconcileLiveThreadActivity(first, event({ turn_id: 'other', sequence: 99 }))).toBe(
      first,
    );
  });

  it('maps the overlay into the existing activity card shape and yields terminal state to a durable final', () => {
    const row = liveOverlayAsAgentActivity(event(), {
      workspaceId: 'w',
      channelId: 'c',
      threadId: 't',
      agentNpub: 'a',
    });
    expect(row).toMatchObject({
      live_overlay: true,
      state: 'working',
      body: 'Inspecting.',
      visibility: 'user_visible',
    });
    expect(
      terminalLiveActivityHasDurableFinal(event({ lifecycle: 'completed' }), [
        { metadata: { source: 'autopilot_session', turn_id: 'turn-1' } },
      ]),
    ).toBe(true);
  });

  it('silently preserves fallback when the capability is unavailable and clears on close', async () => {
    const createClient = vi.fn();
    const onChange = vi.fn();
    const controller = new ThreadLiveActivityController({ createClient, onChange });
    await controller.open({ connection: { capabilities: [] }, context: {} });
    expect(createClient).not.toHaveBeenCalled();
    expect(controller.overlay).toBeNull();
    controller.setOverlay(event());
    controller.clear();
    expect(controller.overlay).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(LIVE_THREAD_ACTIVITY_CAPABILITY).toBe('flightdeck.live-thread-activity.v1');
  });

  it('keeps the turn start immutable and never asserts work without a Tower row', () => {
    const first = reconcileLiveThreadActivity(null, event());
    const later = reconcileLiveThreadActivity(first, event({ sequence: 2, cursor: '2', timestamp: '2026-09-24T00:05:00Z' }));
    expect(later.started_at).toBe('2026-09-24T00:00:00Z');
    const row = liveOverlayAsAgentActivity(later, { workspaceId: 'w', channelId: 'c', threadId: 't', agentNpub: 'a' });
    expect(row.created_at).toBe('2026-09-24T00:00:00Z');
    expect(row.lease_expires_at).toBeUndefined();
    expect(boundLiveOverlayByTower(row, null)).toBeNull();
    expect(liveOverlayAsAgentActivity({ ...later, lifecycle: 'stopped' }, {}).state).toBe('cancelled');
  });

  it('lets the Tower row of the same turn own identity, lease and history', () => {
    const overlay = liveOverlayAsAgentActivity(event({ commentary: 'Running tests', timestamp: '2026-09-24T00:02:00Z' }),
      { workspaceId: 'w', channelId: 'c', threadId: 't', agentNpub: 'a' });
    const tower = { record_id: 'row-1', activity_id: 'activity-1', turn_id: 'turn-1', state: 'working', sequence: 4,
      body: 'Reading', created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:01:00Z',
      lease_expires_at: '2026-09-24T00:01:30Z', commentary_history: [{ activity_id: 'activity-1', turn_id: 'turn-1', sequence: 4, body: 'Reading' }] };
    const bounded = boundLiveOverlayByTower(overlay, tower);
    expect(bounded).toMatchObject({ record_id: 'row-1', created_at: '2026-09-24T00:00:00Z',
      lease_expires_at: '2026-09-24T00:01:30Z', body: 'Running tests', live_overlay: true });
    expect(bounded.commentary_history.map((item) => item.body)).toEqual(['Reading', 'Running tests']);
    expect(boundLiveOverlayByTower(overlay, { ...tower, state: 'completed' })).toEqual({ ...tower, state: 'completed' });
    expect(boundLiveOverlayByTower(overlay, { ...tower, updated_at: '2026-09-24T00:03:00Z' }).body).toBe('Reading');
    // Fresh overlay commentary cannot shadow an expired Tower lease.
    const expired = boundLiveOverlayByTower(overlay, { ...tower, lease_expires_at: '2000-01-01T00:00:00Z' });
    expect(expired.lease_expires_at).toBe('2000-01-01T00:00:00Z');
    expect(getAgentActivityLeaseState(expired, Date.now())).toBe('expired');
  });
});
