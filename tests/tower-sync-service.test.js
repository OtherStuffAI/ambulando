import { describe, expect, it, vi } from 'vitest';
import { replaceTowerSyncService, TowerSyncService } from '../src/tower-sync-service.js';

describe('TowerSyncService ownership', () => {
  it('does not retain freshness entries for one-shot authority snapshots', async () => {
    const load = vi.fn(async () => ({ complete: true }));
    const service = new TowerSyncService({ workspaceKey: 'workspace-a', families: {
      'message-activity': { trackFreshness: false, load },
    } });
    for (let index = 0; index < 50; index++) {
      await service.ensureLoaded('message-activity', `7d:request-${index}`);
    }
    expect(load).toHaveBeenCalledTimes(50);
    expect(service.familyFreshAt.size).toBe(0);
    expect(service.inFlight.size).toBe(0);
  });
  it('keeps one SSE owner and one fallback timer per workspace', () => {
    vi.useFakeTimers();
    const connectSSE = vi.fn();
    const poll = vi.fn();
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: { connectSSE, getFallbackCadence: () => 1000, runFallbackPoll: poll },
    });

    service.start();
    service.start();

    expect(service.snapshot()).toMatchObject({ sseOwners: 1, fallbackTimers: 1 });
    expect(connectSSE).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('disposes all ownership before replacement', () => {
    vi.useFakeTimers();
    const disconnectSSE = vi.fn();
    const stopFlushTimer = vi.fn();
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: {
        connectSSE: vi.fn(),
        disconnectSSE,
        startFlushTimer: vi.fn(),
        stopFlushTimer,
        getFallbackCadence: () => 1000,
      },
    });
    service.start();
    service.dispose('workspace-switch');

    expect(service.snapshot()).toMatchObject({ sseOwners: 0, fallbackTimers: 0, disposed: true });
    expect(disconnectSSE).toHaveBeenCalledWith({ reason: 'workspace-switch' });
    expect(stopFlushTimer).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('workspace replacement disposes the previous owner and retains same-workspace ownership', () => {
    const disconnectA = vi.fn();
    const first = replaceTowerSyncService(null, {
      workspaceKey: 'workspace-a',
      ports: { disconnectSSE: disconnectA },
    });
    expect(replaceTowerSyncService(first, { workspaceKey: 'workspace-a' })).toBe(first);

    const second = replaceTowerSyncService(first, { workspaceKey: 'workspace-b' });
    expect(first.snapshot()).toMatchObject({ disposed: true, disposeReason: 'workspace-owner-replaced' });
    expect(disconnectA).toHaveBeenCalledOnce();
    expect(second.workspaceKey).toBe('workspace-b');
  });

  it('coalesces duplicate targeted loads and releases the key afterward', async () => {
    let resolveLoad;
    const ensureLoaded = vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const service = new TowerSyncService({ workspaceKey: 'workspace-a', ports: { ensureLoaded } });

    const first = service.ensureLoaded('task-comments', 'task-1');
    const second = service.ensureLoaded('task-comments', 'task-1');
    await Promise.resolve();
    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(service.snapshot().coalescedRequests).toBe(1);
    resolveLoad(['comment']);
    await expect(Promise.all([first, second])).resolves.toEqual([['comment'], ['comment']]);
  });

  it('owns registered family freshness and materialisation', async () => {
    const load = vi.fn(async () => ({ rows: ['item-1'] }));
    const materialize = vi.fn(async (payload) => payload.rows);
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      families: { activity: { load, materialize, freshMs: 30_000 } },
    });

    await expect(service.ensureLoaded('activity')).resolves.toEqual(['item-1']);
    await expect(service.ensureLoaded('activity')).resolves.toMatchObject({ fresh: true });
    expect(load).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledOnce();
  });

  it('owns worker materialisation completion and rejects late completion after disposal', async () => {
    let release;
    const disposeMaterializer = vi.fn();
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: {
        materialize: () => new Promise((resolve) => { release = resolve; }),
        disposeMaterializer,
      },
    });
    const pending = service.materialize('workspace-bundle', { rows: ['message-1'] });
    await Promise.resolve();
    expect(service.snapshot()).toMatchObject({
      materialisationsStarted: 1,
      materialisationsCommitted: 0,
      materialisationsFailed: 0,
    });

    service.dispose('workspace-switch');
    release({ applied: 1, cursor: 'cursor-2' });

    await expect(pending).rejects.toThrow('disposed');
    expect(disposeMaterializer).toHaveBeenCalledWith({ reason: 'workspace-switch' });
    expect(service.snapshot()).toMatchObject({
      materialisationsCommitted: 0,
      materialisationsFailed: 1,
      disposed: true,
    });
  });

  it('keys collection coverage by family and target while coalescing identical loads', async () => {
    let release;
    const load = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      families: { 'channel-tasks': { load, materialize: (payload) => payload, freshMs: 30_000 } },
    });

    const first = service.ensureLoaded('channel-tasks', 'channel-1');
    const duplicate = service.ensureLoaded('channel-tasks', 'channel-1');
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    release(['task-1']);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([['task-1'], ['task-1']]);

    await expect(service.ensureLoaded('channel-tasks', 'channel-1')).resolves.toMatchObject({ fresh: true });
    expect(load).toHaveBeenCalledOnce();
    const channelTwo = service.ensureLoaded('channel-tasks', 'channel-2');
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith('channel-2', {});
    release(['task-2']);
    await expect(channelTwo).resolves.toEqual(['task-2']);
  });

  it('rejects late family completion after disposal without materialising it', async () => {
    let release;
    const materialize = vi.fn();
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      families: {
        activity: {
          load: () => new Promise((resolve) => { release = resolve; }),
          materialize,
        },
      },
    });
    const pending = service.ensureLoaded('activity');
    await Promise.resolve();
    service.dispose('workspace-switch');
    release({ rows: ['stale'] });

    await expect(pending).rejects.toThrow('disposed');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('applies an optimistic command before Tower completes and reconciles one acknowledgement', async () => {
    const events = [];
    let acknowledge;
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: {
        prepareCommand: () => ({
          entityKey: 'task:local-1',
          optimistic: async () => events.push('optimistic'),
          execute: () => new Promise((resolve) => { acknowledge = resolve; }),
          reconcile: async (row) => { events.push(`ack:${row.record_id}`); return row; },
        }),
      },
    });

    const pending = service.command('task.create', { clientMutationId: 'mutation-1' });
    await vi.waitFor(() => expect(events).toEqual(['optimistic']));
    acknowledge({ record_id: 'task-1' });
    await expect(pending).resolves.toEqual({ record_id: 'task-1' });
    expect(events).toEqual(['optimistic', 'ack:task-1']);
    expect(service.snapshot()).toMatchObject({ commandsStarted: 1, commandsAcknowledged: 1 });
  });

  it('coalesces repeated UI intent and reuses a completed mutation acknowledgement', async () => {
    let release;
    const execute = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: { prepareCommand: () => ({ execute }) },
    });
    const input = { clientMutationId: 'same-mutation' };
    const first = service.command('task.update', input);
    const duplicate = service.command('task.update', input);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    release({ record_id: 'task-1', title: 'normalized' });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { record_id: 'task-1', title: 'normalized' },
      { record_id: 'task-1', title: 'normalized' },
    ]);
    await expect(service.command('task.update', input)).resolves.toEqual({ record_id: 'task-1', title: 'normalized' });
    expect(execute).toHaveBeenCalledOnce();
    expect(service.snapshot().commandsCoalesced).toBe(1);
  });

  it('does not reconcile an older acknowledgement over a newer entity mutation', async () => {
    const releases = [];
    const reconciled = [];
    const service = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: {
        prepareCommand: (_name, input) => ({
          entityKey: 'task:task-1',
          execute: () => new Promise((resolve) => releases.push(resolve)),
          reconcile: (row) => { reconciled.push(row.title); return row; },
        }),
      },
    });
    const older = service.command('task.update', { clientMutationId: 'older' });
    const newer = service.command('task.update', { clientMutationId: 'newer' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]({ title: 'newer' });
    await expect(newer).resolves.toEqual({ title: 'newer' });
    releases[0]({ title: 'older' });
    await expect(older).resolves.toMatchObject({ stale: true });
    expect(reconciled).toEqual(['newer']);
    expect(service.snapshot().staleAcknowledgements).toBe(1);
  });

  it('persists command failure state but rejects late completion after disposal', async () => {
    const fail = vi.fn();
    const failedService = new TowerSyncService({
      workspaceKey: 'workspace-a',
      ports: { prepareCommand: () => ({ execute: async () => { throw new Error('forbidden'); }, fail }) },
    });
    await expect(failedService.command('task.update', { clientMutationId: 'failed' })).rejects.toThrow('forbidden');
    expect(fail).toHaveBeenCalledOnce();
    expect(failedService.snapshot().commandsFailed).toBe(1);

    let release;
    const reconcile = vi.fn();
    const disposedService = new TowerSyncService({
      workspaceKey: 'workspace-b',
      ports: { prepareCommand: () => ({ execute: () => new Promise((resolve) => { release = resolve; }), reconcile }) },
    });
    const pending = disposedService.command('task.update', { clientMutationId: 'late' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    disposedService.dispose('workspace-switch');
    release({ record_id: 'task-1' });
    await expect(pending).rejects.toThrow('disposed');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
