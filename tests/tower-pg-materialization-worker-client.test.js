import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TowerPgMaterializationWorkerClient,
  TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL,
} from '../src/tower-pg-materialization-worker-client.js';

class MockWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, value) {
    for (const handler of this.listeners.get(type) || []) handler(value);
  }
}

describe('Tower PG materialisation worker client', () => {
  const clients = [];

  afterEach(() => {
    for (const client of clients) client.dispose('test-cleanup');
    clients.length = 0;
  });

  function create() {
    const worker = new MockWorker();
    const client = new TowerPgMaterializationWorkerClient({
      workspaceKey: 'tower|workspace-db|workspace-1',
      workerFactory: () => worker,
    });
    clients.push(client);
    return { client, worker };
  }

  it('sends only the workspace context and bundle through the narrow protocol', async () => {
    const { client, worker } = create();
    const store = {
      workspaceOwnerNpub: 'npub1owner',
      session: { npub: 'npub1viewer' },
      currentWorkspace: { workspaceId: 'workspace-1' },
    };
    const bundle = { mode: 'delta', next_cursor: 'cursor-2', channel_bundles: [] };
    const pending = client.materialize({ workspaceDbKey: 'workspace-db', store, bundle });
    const request = worker.messages[0];

    expect(request).toEqual({
      type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.request,
      id: 1,
      workspaceKey: 'tower|workspace-db|workspace-1',
      workspaceDbKey: 'workspace-db',
      store,
      bundle,
    });

    worker.emit('message', { data: {
      type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response,
      id: 1,
      workspaceKey: request.workspaceKey,
      ok: true,
      value: { applied: 4, cursor: 'cursor-2' },
    } });
    await expect(pending).resolves.toEqual({ applied: 4, cursor: 'cursor-2' });
  });

  it('surfaces worker transaction failures without acknowledging completion', async () => {
    const { client, worker } = create();
    const pending = client.materialize({ workspaceDbKey: 'workspace-db', store: {}, bundle: {} });
    worker.emit('message', { data: {
      type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response,
      id: 1,
      workspaceKey: client.workspaceKey,
      ok: false,
      error: { name: 'ConstraintError', message: 'transaction aborted' },
    } });

    await expect(pending).rejects.toMatchObject({ name: 'ConstraintError', message: 'transaction aborted' });
  });

  it('terminates and rejects pending work on workspace disposal, ignoring late results', async () => {
    const { client, worker } = create();
    const pending = client.materialize({ workspaceDbKey: 'workspace-db', store: {}, bundle: {} });
    client.dispose('workspace-switch');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(client.pending.size).toBe(0);
    expect(() => worker.emit('message', { data: {
      type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response,
      id: 1,
      workspaceKey: client.workspaceKey,
      ok: true,
      value: { applied: 1 },
    } })).not.toThrow();
    await expect(client.materialize({ workspaceDbKey: 'workspace-db' })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects all in-flight work if the worker crashes and can recreate it for a later request', async () => {
    const workers = [new MockWorker(), new MockWorker()];
    const factory = vi.fn(() => workers.shift());
    const client = new TowerPgMaterializationWorkerClient({ workspaceKey: 'workspace-a', workerFactory: factory });
    clients.push(client);
    const firstWorker = workers[0];
    const failed = client.materialize({ workspaceDbKey: 'workspace-db', store: {}, bundle: {} });
    firstWorker.emit('error', { error: new Error('worker crashed') });
    await expect(failed).rejects.toThrow('worker crashed');

    const recovered = client.materialize({ workspaceDbKey: 'workspace-db', store: {}, bundle: {} });
    const secondWorker = client.worker;
    secondWorker.emit('message', { data: {
      type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response,
      id: 2,
      workspaceKey: client.workspaceKey,
      ok: true,
      value: { applied: 0 },
    } });
    await expect(recovered).resolves.toEqual({ applied: 0 });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

it('retains the original transaction name, stack and safe worker context', async () => {
  const worker = new MockWorker();
  const client = new TowerPgMaterializationWorkerClient({ workspaceKey: 'context', workerFactory: () => worker });
  const pending = client.materialize({ workspaceDbKey: 'db', store: {}, bundle: {} });
  const context = { operation: 'bundle-apply', protocolVersion: 1, mode: 'delta', changeCount: 0, hasMore: false };
  worker.emit('message', { data: { type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response,
    id: worker.messages[0].id, workspaceKey: 'context', ok: false,
    error: { name: 'TransactionInactiveError', message: 'Transaction has already completed or failed', stack: 'original worker stack', materializationContext: context } } });
  try {
    await expect(pending).rejects.toMatchObject({ name: 'TransactionInactiveError', stack: 'original worker stack', materializationContext: context });
  } finally { client.dispose(); }
});


it('reports a slow operation without acknowledging, retrying or terminating an active transaction', async () => {
  vi.useFakeTimers();
  const worker = new MockWorker(), onDiagnostic = vi.fn();
  const client = new TowerPgMaterializationWorkerClient({ workspaceKey: 'diagnostic', workerFactory: () => worker, onDiagnostic });
  try {
    const pending = client.materialize({ workspaceDbKey: 'db', bundle: { mode: 'snapshot', changes: [{}] } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDiagnostic).toHaveBeenCalledWith({ operation: 'snapshot', changeCount: 1, pendingCount: 1, elapsedMs: 10000 });
    expect(client.pending.size).toBe(1); expect(worker.messages).toHaveLength(1); expect(worker.terminated).toBe(false);
    worker.emit('message', { data: { type: TOWER_PG_MATERIALIZATION_WORKER_PROTOCOL.response, workspaceKey: 'diagnostic', id: 1, ok: true, value: { applied: 1 } } });
    await expect(pending).resolves.toEqual({ applied: 1 });
    await vi.advanceTimersByTimeAsync(10000); expect(onDiagnostic).toHaveBeenCalledTimes(1);
  } finally { client.dispose(); vi.useRealTimers(); }
});
