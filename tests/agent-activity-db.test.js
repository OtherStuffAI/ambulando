import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAgentActivity,
  getAgentActivitiesForChannel,
  getAgentActivityCommentaryForChannel,
  mergeAgentActivityCommentary,
  pruneExpiredAgentActivities,
  openWorkspaceDb,
  replacePgAgentActivitiesForChannel,
  upsertAgentActivity,
  upsertAgentSessionHealth,
  getAgentSessionHealthForChannel,
} from '../src/db.js';

const TEST_WORKSPACE = 'agent-activity-db-workspace';

beforeEach(async () => {
  const db = openWorkspaceDb(TEST_WORKSPACE);
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

function row(overrides = {}) {
  return {
    record_id: 'row-1', activity_id: 'activity-1', channel_id: 'channel-1', thread_id: 'thread-1',
    turn_id: 'turn-1', created_at: '2026-08-10T00:00:00.000Z',
    trigger_message_id: 'message-1', session_id: 'session-1', agent_npub: 'npub1agent',
    state: 'working', visibility: 'user_visible', sequence: 1,
    expires_at: '2999-01-01T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent activity db', () => {
  it('keeps newer snapshots when stale SSE work arrives later', async () => {
    await upsertAgentActivity(row({ sequence: 3, summary: 'Newer' }));
    expect(await upsertAgentActivity(row({ sequence: 2, summary: 'Stale' }))).toBe(false);
    expect((await getAgentActivitiesForChannel('channel-1'))[0].summary).toBe('Newer');
  });

  it('accepts a lower-sequence terminal after a replayed heartbeat and never lets later work revive it', async () => {
    await upsertAgentActivity(row({ sequence: 9, body: 'Replayed heartbeat' }));
    expect(await upsertAgentActivity(row({ sequence: 5, state: 'completed', terminal_at: '2026-08-10T00:05:00Z' }))).toBe(true);
    expect(await upsertAgentActivity(row({ sequence: 12, state: 'working', body: 'Late replay' }))).toBe(false);
    await replacePgAgentActivitiesForChannel('channel-1', [row({ sequence: 13, state: 'working' })]);
    expect((await getAgentActivitiesForChannel('channel-1'))[0]).toMatchObject({ state: 'completed', sequence: 5 });
  });

  it('moves the lease by lease order without moving canonical state', async () => {
    await upsertAgentActivity(row({ sequence: 4, body: 'Reading', lease_epoch: 1, lease_sequence: 2,
      lease_expires_at: '2026-11-04T02:14:00.000Z' }));
    expect(await upsertAgentActivity(row({ sequence: 4, body: 'Reading', lease_epoch: 1, lease_sequence: 3,
      lease_expires_at: '2026-11-04T02:15:00.000Z' }))).toBe(true);
    expect(await upsertAgentActivity(row({ sequence: 4, lease_epoch: 1, lease_sequence: 1,
      lease_expires_at: '2026-11-04T02:13:00.000Z' }))).toBe(false);
    expect((await getAgentActivitiesForChannel('channel-1'))[0]).toMatchObject({
      body: 'Reading', lease_sequence: 3, lease_expires_at: '2026-11-04T02:15:00.000Z',
    });
  });

  it('replaces reconnect hydration and supports terminal cleanup', async () => {
    await replacePgAgentActivitiesForChannel('channel-1', [row()]);
    expect(await getAgentActivitiesForChannel('channel-1')).toHaveLength(1);
    await clearAgentActivity('row-1');
    expect(await getAgentActivitiesForChannel('channel-1')).toEqual([]);
  });

  it('keeps turn B working when a turn A terminal is replayed later', async () => {
    await upsertAgentActivity(row({ record_id: 'row-new', activity_id: 'activity-new', turn_id: 'turn-b', created_at: '2026-08-10T01:00:00.000Z', sequence: 1 }));
    await upsertAgentActivity(row({ record_id: 'row-old', activity_id: 'activity-old', turn_id: 'turn-a', state: 'completed', sequence: 999 }));
    expect(await getAgentActivitiesForChannel('channel-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: 'row-new', state: 'working', turn_id: 'turn-b' }),
      expect.objectContaining({ record_id: 'row-old', state: 'completed', turn_id: 'turn-a' }),
    ]));
  });

  it('deduplicates repeated commentary only inside one lifecycle', async () => {
    await upsertAgentActivity(row({ sequence: 2, summary: 'Latest commentary' }));
    expect(await upsertAgentActivity(row({ sequence: 2, summary: 'Repeated commentary' }))).toBe(false);
    expect((await getAgentActivitiesForChannel('channel-1'))[0].summary).toBe('Latest commentary');
  });

  it('stores ordered commentary exactly once by workspace, backend, turn, and sequence', async () => {
    const commentary = (sequence, body, turnId = 'turn-1') => ({
      history_key: `workspace-1\u0000https://tower.example\u0000${turnId}\u0000${sequence}`,
      workspace_id: 'workspace-1', backend_url: 'https://tower.example', turn_id: turnId,
      activity_id: 'activity-1', channel_id: 'channel-1', sequence, body,
    });
    expect(await mergeAgentActivityCommentary([
      commentary(2, 'Second'), commentary(1, 'First'), commentary(2, 'Replay'),
    ])).toBe(2);
    expect((await getAgentActivityCommentaryForChannel('channel-1')).map((item) => item.body)).toEqual(['First', 'Second']);

    await upsertAgentActivity(row({ sequence: 2 }));
    expect((await getAgentActivitiesForChannel('channel-1'))[0].commentary_history.map((item) => item.body)).toEqual(['First', 'Second']);
  });

  it('retains commentary and its owning lifecycle after freshness expiry', async () => {
    await upsertAgentActivity(row({ expires_at: '2026-08-10T00:00:00.000Z' }));
    await mergeAgentActivityCommentary([{
      history_key: 'workspace-1\u0000https://tower.example\u0000turn-1\u00001',
      workspace_id: 'workspace-1', backend_url: 'https://tower.example', turn_id: 'turn-1',
      activity_id: 'activity-1', channel_id: 'channel-1', sequence: 1, body: 'Working',
    }]);
    await pruneExpiredAgentActivities(new Date('2026-08-10T00:00:01.000Z'));
    expect(await getAgentActivitiesForChannel('channel-1')).toHaveLength(1);
    expect(await getAgentActivityCommentaryForChannel('channel-1')).toHaveLength(1);
  });

  it('claims a legacy null turn once and preserves immutable created_at', async () => {
    await upsertAgentActivity(row({ turn_id: null, created_at: '2026-08-10T00:00:00.000Z', sequence: 1 }));
    await upsertAgentActivity(row({ turn_id: 'turn-claimed', created_at: '2026-08-10T09:00:00.000Z', sequence: 2 }));
    expect((await getAgentActivitiesForChannel('channel-1'))[0]).toEqual(expect.objectContaining({
      turn_id: 'turn-claimed',
      created_at: '2026-08-10T00:00:00.000Z',
    }));
  });

  it('merges reconnect hydration containing terminal A plus active B', async () => {
    await replacePgAgentActivitiesForChannel('channel-1', [
      row({ record_id: 'row-a', activity_id: 'activity-a', turn_id: 'turn-a', state: 'completed', sequence: 50 }),
      row({ record_id: 'row-b', activity_id: 'activity-b', turn_id: 'turn-b', created_at: '2026-08-10T02:00:00.000Z', sequence: 1 }),
    ]);
    expect(await getAgentActivitiesForChannel('channel-1')).toHaveLength(2);
  });

  it('retains authoritative absences and their owning commentary', async () => {
    const existing = row({ pg_backend: true });
    await upsertAgentActivity(existing);
    await mergeAgentActivityCommentary([{
      history_key: 'workspace-1\u0000https://tower.example\u0000turn-1\u00001',
      workspace_id: 'workspace-1', backend_url: 'https://tower.example', turn_id: 'turn-1',
      activity_id: 'activity-1', channel_id: 'channel-1', sequence: 1, body: 'Thinking',
    }]);

    await replacePgAgentActivitiesForChannel('channel-1', [], {
      authoritative: true,
      requestSnapshot: [existing],
    });

    expect(await getAgentActivitiesForChannel('channel-1')).toHaveLength(1);
    expect(await getAgentActivityCommentaryForChannel('channel-1')).toHaveLength(1);
  });

  it('keeps session health separate and orders generation resets by monotonic row version', async () => {
    const base = { record_id: 'health-1', session_id: 'session-1', channel_id: 'channel-1', agent_npub: 'npub1agent',
      status: 'busy', generation: 10, sequence: 5, row_version: 5 };
    expect(await upsertAgentSessionHealth(base)).toBe(true);
    expect(await upsertAgentSessionHealth({ ...base, generation: 11, sequence: 1, row_version: 6, status: 'online' })).toBe(true);
    expect(await upsertAgentSessionHealth({ ...base, generation: 10, sequence: 99, row_version: 5, status: 'errored' })).toBe(false);
    expect(await getAgentSessionHealthForChannel('channel-1')).toEqual([
      expect.objectContaining({ generation: 11, sequence: 1, row_version: 6, status: 'online' }),
    ]);
  });

  it('does not let a request-start absence snapshot delete a newer concurrent SSE turn', async () => {
    const started = row({ pg_backend: true, sequence: 1 });
    await upsertAgentActivity(started);
    await upsertAgentActivity(row({ pg_backend: true, sequence: 2, summary: 'Newer SSE state' }));

    await replacePgAgentActivitiesForChannel('channel-1', [], {
      authoritative: true,
      requestSnapshot: [started],
    });

    expect(await getAgentActivitiesForChannel('channel-1')).toEqual([
      expect.objectContaining({ sequence: 2, summary: 'Newer SSE state' }),
    ]);
  });

  it('does not remove a newer activity lifecycle that reused the local record id', async () => {
    const started = row({ pg_backend: true, sequence: 3 });
    await upsertAgentActivity(started);
    await clearAgentActivity(started.record_id);
    await upsertAgentActivity(row({ pg_backend: true, activity_id: 'activity-2', turn_id: 'turn-2', sequence: 1 }));

    await replacePgAgentActivitiesForChannel('channel-1', [], {
      authoritative: true,
      requestSnapshot: [started],
    });

    expect(await getAgentActivitiesForChannel('channel-1')).toEqual([
      expect.objectContaining({ activity_id: 'activity-2', turn_id: 'turn-2' }),
    ]);
  });
});
