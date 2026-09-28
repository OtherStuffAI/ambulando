import { afterEach, describe, expect, it } from 'vitest';
import './setup.js';

import { chatMessageManagerMixin } from '../src/chat-message-manager.js';
import {
  deleteWorkspaceDb,
  getAgentActivitiesForChannel,
  getAgentActivityCommentaryForChannel,
  openWorkspaceDb,
} from '../src/db.js';
import {
  hydrateTowerPgChannelAgentActivities,
  hydrateTowerPgEventUpdates,
} from '../src/pg-read-hydrator.js';

const DB_KEY = 'agent-activity-visible-thread-integration';
const CHANNEL_ID = 'channel-1';
const THREAD_ID = 'thread-1';
const TRIGGER_ID = 'message-1';

function rawActivity(overrides = {}) {
  return {
    id: 'row-1',
    activity_id: 'activity-1',
    turn_id: 'turn-1',
    workspace_id: 'workspace-1',
    scope_id: 'scope-1',
    channel_id: CHANNEL_ID,
    thread_id: THREAD_ID,
    trigger_message_id: TRIGGER_ID,
    session_id: 'session-1',
    agent_npub: 'npub1agent',
    state: 'accepted',
    label: 'Message received',
    summary: '',
    body: '',
    visibility: 'user_visible',
    sequence: 1,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(activity) {
  return {
    event_type: 'flightdeck_pg.agent_activity.snapshot',
    entity_type: 'agent_activity',
    entity_id: activity.id,
    channel_id: activity.channel_id,
    payload: {
      turn_id: activity.turn_id,
      thread_id: activity.thread_id,
      trigger_message_id: activity.trigger_message_id,
      agent_activity: activity,
    },
  };
}

function store() {
  return Object.assign(Object.create(chatMessageManagerMixin), {
    backendUrl: 'https://tower.example',
    workspaceOwnerNpub: 'npub1owner',
    currentWorkspace: {
      workspaceId: 'workspace-1',
      workspaceOwnerNpub: 'npub1owner',
      directHttpsUrl: 'https://tower.example',
      appNpub: 'flightdeck_pg',
      pgBackendMode: true,
    },
    activeThreadId: TRIGGER_ID,
    messages: [{ record_id: TRIGGER_ID, channel_id: CHANNEL_ID, pg_thread_id: THREAD_ID }],
    agentActivities: [],
    responseActivityTick: 0,
    sseStatus: 'connected',
    getThreadParentMessage() { return this.messages.find((message) => message.record_id === this.activeThreadId); },
    getSenderName() { return 'Agent'; },
  });
}

afterEach(async () => {
  await deleteWorkspaceDb(DB_KEY);
});

describe('agent activity hydration/SSE to visible thread', () => {
  it('renders ordered commentary through reconnect and keeps confirmed finished runs', async () => {
    const target = store();
    const db = openWorkspaceDb(DB_KEY);
    await db.open();

    await hydrateTowerPgChannelAgentActivities(target, CHANNEL_ID, {
      getTowerPgAgentActivities: async () => ({ agent_activities: [rawActivity()] }),
    });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toEqual([
      expect.objectContaining({ state: 'accepted', label: 'Message received', turn_id: 'turn-1' }),
    ]);

    const incrementalActivityListRequest = vi.fn(async () => ({ agent_activities: [] }));
    await hydrateTowerPgEventUpdates(target, [
      event(rawActivity({ state: 'working', label: 'Working', sequence: 2, summary: 'First commentary', body: 'First body' })),
      event(rawActivity({ state: 'working', label: 'Working', sequence: 3, summary: 'Second commentary', body: 'Second body' })),
    ], {
      getTowerPgAgentActivities: incrementalActivityListRequest,
    });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toEqual([
      expect.objectContaining({ state: 'working', sequence: 3, summary: 'Second commentary' }),
    ]);
    expect(target.activeThreadAgentActivities[0].commentary_history.map((row) => row.body)).toEqual(['First body', 'Second body']);
    expect(await getAgentActivityCommentaryForChannel(CHANNEL_ID)).toHaveLength(2);
    expect(incrementalActivityListRequest).not.toHaveBeenCalled();

    await hydrateTowerPgChannelAgentActivities(target, CHANNEL_ID, {
      getTowerPgAgentActivities: async () => ({ agent_activities: [rawActivity({
        state: 'working', sequence: 3, summary: 'Second commentary', body: 'Second body',
        commentary_history: [
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 2, state: 'working', visibility: 'user_visible', body: 'First body' },
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 3, state: 'working', visibility: 'user_visible', body: 'Second body' },
        ],
      })] }),
    });
    await hydrateTowerPgEventUpdates(target, [event(rawActivity({
      id: 'row-old', activity_id: 'activity-old', turn_id: 'turn-old',
      state: 'completed', sequence: 999, created_at: '2026-08-09T00:00:00.000Z',
    }))], { getTowerPgAgentActivities: async () => ({ agent_activities: [] }) });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({ activity_id: 'activity-1', turn_id: 'turn-1', state: 'working',
        earlier_activities: [expect.objectContaining({ activity_id: 'activity-old', state: 'completed' })] }),
    ]));

    // Late delivery cannot rewrite the immutable start or promote the old run.
    await hydrateTowerPgEventUpdates(target, [event(rawActivity({
      id: 'row-old', activity_id: 'activity-old', turn_id: 'turn-old',
      state: 'completed', sequence: 1000, created_at: '2999-01-01T00:00:00.000Z',
    }))], { getTowerPgAgentActivities: async () => ({ agent_activities: [] }) });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities[0].activity_id).toBe('activity-1');
    expect(target.activeThreadAgentActivities[0].earlier_activities[0].created_at).toBe('2026-08-09T00:00:00.000Z');

    target.messages.push({ record_id: 'message-final', parent_message_id: TRIGGER_ID, channel_id: CHANNEL_ID, body: 'Final reply' });
    await hydrateTowerPgEventUpdates(target, [event(rawActivity({ state: 'completed', sequence: 4 }))], {
      getTowerPgAgentActivities: async () => ({ agent_activities: [rawActivity({ state: 'completed', sequence: 4 })] }),
    });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toHaveLength(1);
    expect(target.activeThreadAgentActivities.every((row) => row.state === 'completed')).toBe(true);
    expect(await getAgentActivityCommentaryForChannel(CHANNEL_ID)).toHaveLength(2);
    expect(target.messages.at(-1)).toMatchObject({ record_id: 'message-final', body: 'Final reply' });
  });

  it('preserves uncertain state on authoritative absence without touching the final thread message', async () => {
    const target = store();
    const db = openWorkspaceDb(DB_KEY);
    await db.open();
    await hydrateTowerPgChannelAgentActivities(target, CHANNEL_ID, {
      getTowerPgAgentActivities: async () => ({ agent_activities: [rawActivity({
        state: 'working', sequence: 2, summary: 'Still working',
        commentary_history: [
          { activity_id: 'activity-1', turn_id: 'turn-1', sequence: 2, state: 'working', visibility: 'user_visible', body: 'Still working' },
        ],
      })] }),
    });
    target.messages.push({ record_id: 'message-final', parent_message_id: TRIGGER_ID, channel_id: CHANNEL_ID, body: 'Final reply' });

    await hydrateTowerPgChannelAgentActivities(target, CHANNEL_ID, {
      getTowerPgAgentActivities: async () => ({ agent_activities: [] }),
    });

    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toEqual([expect.objectContaining({ state: 'working' })]);
    expect(await getAgentActivityCommentaryForChannel(CHANNEL_ID)).toHaveLength(1);
    expect(target.messages.at(-1)).toMatchObject({ record_id: 'message-final', body: 'Final reply' });
  });

  it('retains failed attempts in Dexie and diagnostics after success and old SSE replay', async () => {
    const target = store();
    const db = openWorkspaceDb(DB_KEY);
    await db.open();
    const failed = [1, 2, 3].map(n => rawActivity({
      id: `failed-row-${n}`, activity_id: `failed-${n}`, turn_id: `failed-turn-${n}`,
      trigger_message_id: `failed-trigger-${n}`, state: 'failed', body: `Dispatch attempt ${n} failed`,
      created_at: `2026-08-09T0${n}:00:00.000Z`,
    }));
    await hydrateTowerPgChannelAgentActivities(target, CHANNEL_ID, {
      getTowerPgAgentActivities: async () => ({ agent_activities: failed }),
    });
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities.filter(row => target.isCurrentAgentActivityWorking(row)))
      .toEqual([expect.objectContaining({ activity_id: 'failed-3' })]);

    await hydrateTowerPgEventUpdates(target, [event(rawActivity({ state: 'completed' }))], {});
    // Duplicate and stale snapshots cannot create another card or promote failure.
    await hydrateTowerPgEventUpdates(target, [event(failed[0]), event(failed[0]),
      event({ ...failed[1], sequence: 999, updated_at: '2999-01-01T00:00:00Z' })], {});
    target.applyAgentActivities(await getAgentActivitiesForChannel(CHANNEL_ID));
    expect(target.activeThreadAgentActivities).toEqual([
      expect.objectContaining({ state: 'completed', earlier_activities: expect.arrayContaining([
        expect.objectContaining({ activity_id: 'failed-1', state: 'failed' }),
        expect.objectContaining({ activity_id: 'failed-2', state: 'failed' }),
        expect.objectContaining({ activity_id: 'failed-3', state: 'failed' }),
      ]) }),
    ]);
    expect(target.activeThreadAgentActivities.filter(row => target.isCurrentAgentActivityWorking(row))).toEqual([]);
    expect(await getAgentActivitiesForChannel(CHANNEL_ID)).toHaveLength(4);
    target.openAgentActivityDetails();
    expect(target.agentActivityDetailsRows).toHaveLength(4);
  });
});
