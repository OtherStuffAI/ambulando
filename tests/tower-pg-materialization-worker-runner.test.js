import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceDb } from '../src/db.js';
import { hydrateTowerPgSyncBundle } from '../src/pg-read-hydrator.js';

vi.mock('../src/db.js', () => ({ openWorkspaceDb: vi.fn() }));
vi.mock('../src/pg-read-hydrator.js', () => ({ hydrateTowerPgSyncBundle: vi.fn() }));

describe('Tower PG materialisation worker runner', () => {
  let originalSelf;
  let dispatch;
  let posted;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    posted = [];
    originalSelf = globalThis.self;
    globalThis.self = {
      addEventListener(type, listener) {
        if (type === 'message') dispatch = (data) => listener({ data });
      },
      postMessage(message) {
        posted.push(message);
      },
    };
    await import('../src/worker/tower-pg-materialization-worker.js');
  });

  afterEach(() => {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function waitForPosted(count) {
    await vi.waitFor(() => expect(posted).toHaveLength(count));
  }

  it('opens the requested workspace DB and resolves only after bundle hydration commits', async () => {
    hydrateTowerPgSyncBundle.mockResolvedValueOnce({ applied: 2, cursor: 'cursor-2' });
    const store = { currentWorkspace: { workspaceId: 'workspace-1' } };
    const bundle = { mode: 'delta', next_cursor: 'cursor-2' };
    dispatch({
      type: 'tower-pg-materializer:request',
      id: 7,
      workspaceKey: 'workspace-context-1',
      workspaceDbKey: 'workspace-db-1',
      store,
      bundle,
    });
    await waitForPosted(1);

    expect(openWorkspaceDb).toHaveBeenCalledWith('workspace-db-1');
    expect(hydrateTowerPgSyncBundle).toHaveBeenCalledWith(store, bundle);
    expect(posted).toContainEqual({
      type: 'tower-pg-materializer:response',
      id: 7,
      workspaceKey: 'workspace-context-1',
      ok: true,
      value: { applied: 2, cursor: 'cursor-2' },
      durationMs: expect.any(Number),
    });
  });

  it('reports transaction errors and refuses ownership changes inside one worker', async () => {
    hydrateTowerPgSyncBundle.mockRejectedValueOnce(new Error('atomic transaction aborted'));
    dispatch({
      type: 'tower-pg-materializer:request', id: 1, workspaceKey: 'workspace-a',
      workspaceDbKey: 'db-a', store: {}, bundle: {},
    });
    await waitForPosted(1);
    expect(posted.at(-1)).toMatchObject({
      id: 1,
      workspaceKey: 'workspace-a',
      ok: false,
      error: { message: 'atomic transaction aborted' },
    });

    dispatch({
      type: 'tower-pg-materializer:request', id: 2, workspaceKey: 'workspace-b',
      workspaceDbKey: 'db-b', store: {}, bundle: {},
    });
    await waitForPosted(2);
    expect(openWorkspaceDb).not.toHaveBeenCalledWith('db-b');
    expect(posted.at(-1)).toMatchObject({
      id: 2,
      workspaceKey: 'workspace-b',
      ok: false,
      error: { message: expect.stringContaining('cannot switch workspace ownership') },
    });
  });

  it('allows guarded transcript work between snapshot transaction turns without reordering sync pages', async () => {
    let release;
    hydrateTowerPgSyncBundle.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ cursor: 'next' });
    dispatch({ type: 'tower-pg-materializer:request', id: 1, workspaceKey: 'workspace-a', workspaceDbKey: 'db-a', store: {}, bundle: { mode: 'snapshot' } });
    await flush();
    dispatch({ type: 'tower-pg-materializer:request', id: 2, workspaceKey: 'workspace-a', workspaceDbKey: 'db-a', store: {}, bundle: { thread_history_page: {} } });
    dispatch({ type: 'tower-pg-materializer:request', id: 3, workspaceKey: 'workspace-a', workspaceDbKey: 'db-a', store: {}, bundle: { mode: 'delta' } });
    await waitForPosted(1);
    expect(posted[0].id).toBe(2); expect(hydrateTowerPgSyncBundle).toHaveBeenCalledTimes(2);
    release({ cursor: 'snapshot-end' });
    await waitForPosted(3); expect(posted.map(row => row.id)).toEqual([2, 1, 3]);
  });

  it('serializes bundle transactions so concurrent requests cannot reorder cursor commits', async () => {
    let releaseFirst;
    hydrateTowerPgSyncBundle
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ applied: 1, cursor: 'cursor-2' });

    dispatch({
      type: 'tower-pg-materializer:request', id: 1, workspaceKey: 'workspace-a',
      workspaceDbKey: 'db-a', store: {}, bundle: { next_cursor: 'cursor-1' },
    });
    dispatch({
      type: 'tower-pg-materializer:request', id: 2, workspaceKey: 'workspace-a',
      workspaceDbKey: 'db-a', store: {}, bundle: { next_cursor: 'cursor-2' },
    });
    await flush();

    expect(hydrateTowerPgSyncBundle).toHaveBeenCalledTimes(1);
    releaseFirst({ applied: 1, cursor: 'cursor-1' });
    await vi.waitFor(() => expect(hydrateTowerPgSyncBundle).toHaveBeenCalledTimes(2));
    await waitForPosted(2);

    expect(hydrateTowerPgSyncBundle).toHaveBeenCalledTimes(2);
    expect(posted.map((message) => message.id)).toEqual([1, 2]);
  });
});
