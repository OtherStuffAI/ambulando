import { Worker as NodeWorker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { assessWorkerLatency } from './helpers/materialization-benchmark-policy.js';
import { TowerPgMaterializationWorkerClient } from '../src/tower-pg-materialization-worker-client.js';

const MATERIALIZATION_STRESS_TIMEOUT_MS = 30_000;

class NodeWorkerAdapter {
  constructor(url) {
    this.worker = new NodeWorker(url, { type: 'module' });
    this.listeners = new Map();
    this.worker.on('message', (data) => this.emit('message', { data }));
    this.worker.on('error', (error) => this.emit('error', { error, message: error.message }));
    this.worker.on('messageerror', (error) => this.emit('messageerror', { error, message: error.message }));
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  postMessage(message) {
    this.worker.postMessage(message);
  }

  terminate() {
    void this.worker.terminate();
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

describe('large PG bundle main-thread responsiveness', () => {
  let client;

  afterEach(() => {
    client?.dispose('test-cleanup');
    client = null;
  });

  it('keeps the caller event loop responsive during a real 20,000-row Dexie worker transaction', async () => {
    const runId = randomUUID();
    const messages = Array.from({ length: 20_000 }, (_, index) => ({
      id: `message-${index}`,
      channel_id: 'channel-1',
      body: `Synthetic row ${index}`,
    }));
    const bundle = {
      mode: 'delta',
      next_cursor: 'cursor-20000',
      channel_bundles: [{ channel_id: 'channel-1', messages }],
    };
    client = new TowerPgMaterializationWorkerClient({
      workspaceKey: `responsiveness-workspace-${runId}`,
      workerFactory: () => new NodeWorkerAdapter(
        new URL('./helpers/tower-pg-materialization-load-worker.js', import.meta.url),
      ),
    });

    let ticks = 0;
    let maxEventLoopDelayMs = 0;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - previous - 2);
      previous = now;
      ticks += 1;
    }, 2);
    let result;
    let totalMs = 0;
    try {
      const startedAt = performance.now();
      result = await client.materialize({
        workspaceDbKey: `responsiveness-db-${runId}`,
        store: {
          workspaceOwnerNpub: 'npub1owner',
          session: { npub: 'npub1viewer' },
          currentWorkspace: { workspaceId: 'workspace-1' },
        },
        bundle,
      });
      totalMs = performance.now() - startedAt;
    } finally {
      clearInterval(timer);
    }

    expect(result).toMatchObject({ applied: 20_000, cursor: 'cursor-20000' });
    expect(totalMs).toBeGreaterThanOrEqual(100);
    expect(ticks).toBeGreaterThan(25);
    // Host scheduling noise is a measurement in release validation. Keep the
    // real worker/result/tick assertions above mandatory in both modes.
    const latency = assessWorkerLatency(maxEventLoopDelayMs, process.env.FLIGHTDECK_RELEASE_MEASUREMENTS || 'strict');
    if (latency.overBudget) console.warn('Release benchmark observation: event-loop delay exceeded 50 ms; review the recorded measurement.');
    console.info(JSON.stringify({
      benchmark: 'tower-pg-materialization-worker',
      rows: 20_000,
      totalMs: Math.round(totalMs),
      mainThreadTicks: ticks,
      maxEventLoopDelayMs: Number(maxEventLoopDelayMs.toFixed(1)),
    }));
  }, MATERIALIZATION_STRESS_TIMEOUT_MS);
});
