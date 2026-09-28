import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('../src/autopilot-connection-refresh.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshInstalledAutopilotConnection: refresh,
}));

import { threadLiveActivityManagerMixin } from '../src/thread-live-activity-manager.js';

function store(capabilities = []) {
  const value = {
    activeThreadId: 'thread-1',
    activeChannelId: 'channel-1',
    isTowerPgMode: true,
    currentWorkspace: { workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1owner', towerServiceNpub: 'npub1tower', appNpub: 'npub1app' },
    messages: [{ thread_id: 'thread-1', mentions: [{ type: 'agent', npub: 'npub1rick' }] }],
    workspaceAgents: [{ id: 'agent-1', connection_id: 'connection-1', agent_npub: 'npub1rick' }],
    agentConnections: [{ id: 'connection-1', row_version: 1, capabilities }],
    agentActivities: [],
    getThreadParentMessage: () => ({ record_id: 'thread-1', channel_id: 'channel-1', mentions: [{ type: 'agent', npub: 'npub1rick' }] }),
  };
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(threadLiveActivityManagerMixin));
  Object.assign(value, {
    activeThreadId: 'thread-1', activeChannelId: 'channel-1', isTowerPgMode: true,
    currentWorkspace: { workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1owner', towerServiceNpub: 'npub1tower', appNpub: 'npub1app' },
    messages: [{ thread_id: 'thread-1', mentions: [{ type: 'agent', npub: 'npub1rick' }] }],
    workspaceAgents: [{ id: 'agent-1', connection_id: 'connection-1', agent_npub: 'npub1rick' }],
    agentConnections: [{ id: 'connection-1', row_version: 1, capabilities }], agentActivities: [],
    getThreadParentMessage: value.getThreadParentMessage,
  });
  return value;
}

describe('thread live activity package reconciliation', () => {
  beforeEach(() => refresh.mockReset());

  it('refreshes a stale package and opens live activity when the materialized connection changes', async () => {
    refresh.mockResolvedValue({ verified: { capabilities: ['flightdeck.live-thread-activity.v1'] } });
    const subject = store();
    const open = vi.fn();
    subject._threadLiveActivityController = { open, clear: vi.fn() };

    subject.startThreadLiveActivity();
    await subject._liveThreadActivityRefreshes.values().next().value;
    expect(refresh).toHaveBeenCalledOnce();
    expect(subject.liveThreadActivityAvailability).toBe('refreshing');

    subject.agentConnections = [{ ...subject.agentConnections[0], row_version: 2, capabilities: ['flightdeck.live-thread-activity.v1'] }];
    subject.startThreadLiveActivity();
    expect(open).toHaveBeenCalledOnce();
    expect(subject.liveThreadActivityAvailability).toBe('available');
  });

  it('replaces only the matching durable turn while preserving queued work and failures', () => {
    const subject = store();
    const base = { agent_npub: 'npub1rick', thread_id: 'thread-1', created_at: '2026-09-28T00:00:00Z' };
    subject.getLiveThreadActivityRow = () => ({ ...base, turn_id: 'current', live_overlay: true });
    const queue = { ...base, turn_id: 'next', state: 'queued' };
    const failure = { ...base, turn_id: 'earlier', state: 'failed', body: 'Runtime failed' };
    const rows = subject.mergeThreadLiveActivity([{ ...base, turn_id: 'current' }, queue, failure]);
    expect(rows).toHaveLength(3);
    expect(rows).toContain(queue);
    expect(rows).toContain(failure);
    expect(rows.filter(row => row.turn_id === 'current')).toEqual([expect.objectContaining({ live_overlay: true })]);
  });

  it('keeps Tower fallback and shows actionable status for a verified unsupported Autopilot', async () => {
    refresh.mockResolvedValue({ verified: { capabilities: ['health'] } });
    const subject = store();
    await subject._refreshThreadLiveActivityConnection(subject.agentConnections[0]);
    expect(subject.liveThreadActivityAvailability).toBe('unsupported');
    expect(subject.liveThreadActivityAvailabilityMessage).toContain('Tower updates remain available');
    expect(subject.liveThreadActivityOverlay).toBeNull();
  });
});
